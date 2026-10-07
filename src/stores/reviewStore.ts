import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { useMemo } from "react";
import type {
  BatchOp,
  ClaimDeniedInfo,
  CommentDraft,
  CommentSide,
  DiffViewMode,
  FileSignoff,
  MergeConflict,
  MergeFailure,
  ReviewBatch,
  ReviewComment,
  SharedReviewDoc,
  SyncStatus,
} from "../types/review";
import { buildAnchor } from "../sync/anchors";
import { computeChangeset } from "../sync/hash";
import { announceReviewerPresence, getReviewerName, getSessionId } from "../sync/identity";
import { CLAIM_TTL_MS, commitOps, isClaimActive, isClaimFree } from "../sync/merge";
import { applyOpsToView, summarizeOps } from "../sync/ops";
import {
  loadOrCreateSharedDoc,
  loadSharedDoc,
  loadSharedDocRaw,
  saveSharedDoc,
  SHARED_DOC_KEY,
  subscribeSharedDoc,
} from "../sync/sharedDoc";

interface ReviewState {
  sessionId: string;
  reviewer: string;
  ready: boolean;
  syncStatus: SyncStatus;
  mergeFailure: MergeFailure | null;
  claimDenied: ClaimDeniedInfo[];
  notice: string | null;
  lastSyncedAt: string | null;
  nowTick: number;

  /** 共享文档的本地镜像（最近一次成功同步的内容） */
  sharedDoc: SharedReviewDoc;
  /** 本地已生效、尚未提交进共享文档的操作 */
  pendingOps: BatchOp[];
  currentBatchId: string;
  opCounter: number;
  batchCounter: number;

  selectedFileId: string;
  viewMode: DiffViewMode;
  hideUnchanged: boolean;
  draft: CommentDraft | null;

  bootstrap: () => void;
  pullRemote: () => void;
  commitNow: (options?: { recover?: boolean }) => void;
  retrySync: () => void;

  setSelectedFile: (fileId: string) => void;
  setViewMode: (mode: DiffViewMode) => void;
  setHideUnchanged: (value: boolean) => void;
  setDraft: (draft: CommentDraft | null) => void;
  setNotice: (notice: string | null) => void;

  toggleReviewed: (fileId?: string) => void;
  addComment: (draft: CommentDraft, body: string) => void;
  addReply: (commentId: string, body: string) => void;
  resolveComment: (commentId: string, resolved?: boolean) => void;
  deleteComment: (commentId: string) => void;

  claimFile: (fileId: string) => void;
  releaseClaim: (fileId: string) => void;
  takeoverClaim: (fileId: string) => void;

  adjudicate: (conflictId: string, choice: "incoming" | "current") => void;
  simulateChangesetUpdate: () => void;
  simulateMergeFailure: () => void;
  submitReview: () => void;
  reopenReview: () => void;
}

const emptyDoc = (): SharedReviewDoc => ({
  schemaVersion: 1,
  changeset: { rev: "", fileHashes: {}, computedAt: "" },
  files: [],
  comments: [],
  signoffs: {},
  claims: {},
  conflicts: [],
  batches: [],
  appliedBatchIds: [],
  submission: null,
  lamport: 0,
  updatedAt: "",
  updatedBy: "",
});

let commitTimer: ReturnType<typeof setTimeout> | null = null;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let presenceTimer: ReturnType<typeof setInterval> | null = null;
let unsubscribeStorage: (() => void) | null = null;

export const useReviewStore = create<ReviewState>()(
  persist(
    (set, get) => {
      const nextOpId = () => {
        const counter = get().opCounter + 1;
        set({ opCounter: counter });
        return `op-${get().sessionId}-${counter}`;
      };

      const rotateBatchId = () => {
        const counter = get().batchCounter + 1;
        set({ batchCounter: counter });
        return `batch-${get().sessionId}-${counter}`;
      };

      /** 本地操作入队：立即反映到视图，并调度一次提交 */
      const enqueue = (op: BatchOp) => {
        set((state) => ({
          pendingOps: [...state.pendingOps, op],
          syncStatus: "pending",
        }));
        scheduleCommit();
      };

      const scheduleCommit = () => {
        if (commitTimer) clearTimeout(commitTimer);
        commitTimer = setTimeout(() => get().commitNow(), 280);
      };

      /** 提交成功后推进本地状态；部分被占用时保留现场等待重试 */
      const applyCommitOutcome = (outcome: ReturnType<typeof commitOps>, finalDoc: SharedReviewDoc) => {
        const remaining = get().pendingOps.filter((op) => !outcome.appliedOps.includes(op));
        const deniedKey = outcome.deniedFiles.map((item) => `${item.fileId}:${item.holderName}`).join("|");
        const previousKey = get().claimDenied.map((item) => `${item.fileId}:${item.holderName}`).join("|");
        set({
          sharedDoc: finalDoc,
          pendingOps: remaining,
          currentBatchId: rotateBatchId(),
          syncStatus: remaining.length ? "claim-waiting" : "synced",
          claimDenied: outcome.deniedFiles,
          mergeFailure: null,
          lastSyncedAt: new Date().toISOString(),
          // 同一批被占用的文件只提示一次，避免自动重试时反复打扰
          notice:
            outcome.deniedFiles.length && deniedKey !== previousKey
              ? `${outcome.deniedFiles.map((item) => item.holderName).join("、")} 正在提交相同文件，已保留现场，租约超时或对方交回后自动接手`
              : outcome.deniedFiles.length
                ? get().notice
                : null,
        });
      };

      return {
        sessionId: getSessionId(),
        reviewer: getReviewerName(),
        ready: false,
        syncStatus: "synced",
        mergeFailure: null,
        claimDenied: [],
        notice: null,
        lastSyncedAt: null,
        nowTick: Date.now(),

        sharedDoc: emptyDoc(),
        pendingOps: [],
        currentBatchId: `batch-${getSessionId()}-0`,
        opCounter: 0,
        batchCounter: 0,

        selectedFileId: "payment-service",
        viewMode: "side-by-side",
        hideUnchanged: true,
        draft: null,

        bootstrap: () => {
          if (get().ready) return;
          const doc = loadOrCreateSharedDoc();
          // 保留本标签页记住的选中文件，失效时才回退到第一个文件
          const remembered = get().selectedFileId;
          const selectedFileId = doc.files.some((file) => file.id === remembered) ? remembered : (doc.files[0]?.id ?? "payment-service");
          set({ sharedDoc: doc, ready: true, selectedFileId });
          if (!unsubscribeStorage) unsubscribeStorage = subscribeSharedDoc(() => get().pullRemote());
          if (!tickTimer) {
            tickTimer = setInterval(() => {
              set({ nowTick: Date.now() });
              const state = get();
              // 租约被占用而暂缓的操作：对方超时或交回后自动接手重试
              if (state.pendingOps.length && state.syncStatus === "claim-waiting") state.commitNow();
            }, 1_000);
          }
          if (!presenceTimer) {
            presenceTimer = setInterval(() => announceReviewerPresence(get().reviewer), 10_000);
            announceReviewerPresence(get().reviewer);
          }
          // 上次会话遗留的待提交操作（例如刷新页面）继续提交；批次号不变，幂等
          if (get().pendingOps.length) scheduleCommit();
        },

        pullRemote: () => {
          try {
            const remote = loadSharedDoc();
            if (!remote) return;
            set((state) => ({
              sharedDoc: remote,
              mergeFailure: null,
              syncStatus: state.pendingOps.length ? "pending" : "synced",
              lastSyncedAt: new Date().toISOString(),
            }));
            if (get().pendingOps.length) scheduleCommit();
          } catch (error) {
            // 远端损坏：保留本地现场，等待用户重试
            set({
              syncStatus: "error",
              mergeFailure: {
                at: new Date().toISOString(),
                reason: error instanceof Error ? error.message : String(error),
                batchId: get().currentBatchId,
                remoteRaw: loadSharedDocRaw(),
              },
            });
          }
        },

        commitNow: (options) => {
          const state = get();
          if (!state.ready || state.syncStatus === "syncing") return;
          if (!state.pendingOps.length) return;
          set({ syncStatus: "syncing" });

          const batch: ReviewBatch = {
            id: state.currentBatchId,
            sessionId: state.sessionId,
            author: state.reviewer,
            createdAt: new Date().toISOString(),
            changesetRev: state.sharedDoc.changeset.rev,
            summary: summarizeOps(state.pendingOps),
            ops: state.pendingOps,
          };

          try {
            let remote: SharedReviewDoc;
            try {
              remote = loadSharedDoc() ?? state.sharedDoc;
            } catch (parseError) {
              if (!options?.recover) throw parseError;
              // 重试时远端仍不可读：以本地镜像（最后一致版本）为基线重建，批次号不变保证幂等
              remote = state.sharedDoc;
            }
            const outcome = commitOps(remote, state.pendingOps, batch, {
              sessionId: state.sessionId,
              author: state.reviewer,
              now: Date.now(),
            });
            const changed = outcome.appliedOps.length > 0 || outcome.newConflicts.length > 0;
            const finalDoc: SharedReviewDoc = {
              ...outcome.doc,
              lamport: outcome.doc.lamport + (changed ? 1 : 0),
              updatedAt: new Date().toISOString(),
              updatedBy: state.sessionId,
            };
            if (changed && !outcome.alreadyApplied) saveSharedDoc(finalDoc);
            applyCommitOutcome(outcome, finalDoc);
          } catch (error) {
            // 合并失败：保留现场（待提交操作、批次号、远端原文），重试不会重复追加
            set({
              syncStatus: "error",
              mergeFailure: {
                at: new Date().toISOString(),
                reason: error instanceof Error ? error.message : String(error),
                batchId: state.currentBatchId,
                remoteRaw: loadSharedDocRaw(),
              },
            });
          }
        },

        retrySync: () => {
          const state = get();
          if (state.pendingOps.length) {
            // 批次号与操作 id 不变，重试不会重复追加线程
            state.commitNow({ recover: true });
            return;
          }
          // 没有待提交操作：远端可读则直接采用，否则用本地镜像重建共享文档
          try {
            const remote = loadSharedDoc();
            set({ sharedDoc: remote ?? state.sharedDoc, mergeFailure: null, syncStatus: "synced" });
          } catch {
            saveSharedDoc(state.sharedDoc);
            set({ mergeFailure: null, syncStatus: "synced", notice: "已用本地镜像重建共享文档" });
          }
        },

        setSelectedFile: (selectedFileId) => set({ selectedFileId, draft: null }),
        setViewMode: (viewMode) => set({ viewMode }),
        setHideUnchanged: (hideUnchanged) => set({ hideUnchanged }),
        setDraft: (draft) => set({ draft }),
        setNotice: (notice) => set({ notice }),

        toggleReviewed: (fileId) => {
          const state = get();
          const target = fileId ?? state.selectedFileId;
          const view = applyOpsToView(state.sharedDoc, state.pendingOps);
          // 两边都改过且未裁决：挡住文件完成
          if (view.conflicts.some((conflict) => conflict.fileId === target && conflict.status === "open")) {
            set({ notice: "该文件存在未裁决的合并冲突，裁决后才能完成签收" });
            return;
          }
          const existing = view.signoffs[target] ?? null;
          const record: FileSignoff | null = existing
            ? null
            : {
                fileId: target,
                signedBy: state.reviewer,
                sessionId: state.sessionId,
                batchId: state.currentBatchId,
                changesetRev: view.changeset.rev,
                signedAt: new Date().toISOString(),
              };
          enqueue({ opId: nextOpId(), kind: "signoff", fileId: target, record, prevRecord: existing });
        },

        addComment: (draft, body) => {
          const trimmed = body.trim();
          if (!trimmed) return;
          const state = get();
          const view = applyOpsToView(state.sharedDoc, state.pendingOps);
          const file = view.files.find((item) => item.id === draft.fileId);
          if (!file) return;
          const now = new Date().toISOString();
          const comment: ReviewComment = {
            id: `comment-${state.sessionId}-${state.opCounter + 1}`,
            fileId: draft.fileId,
            line: draft.line,
            side: draft.side,
            author: state.reviewer,
            body: trimmed,
            createdAt: now,
            resolved: false,
            replies: [],
            batchId: state.currentBatchId,
            anchor: buildAnchor(file, draft.side, draft.line, view.changeset.rev),
            orphaned: false,
            updatedAt: now,
          };
          enqueue({ opId: nextOpId(), kind: "add-comment", comment });
          set({ draft: null });
        },

        addReply: (commentId, body) => {
          const trimmed = body.trim();
          if (!trimmed) return;
          const state = get();
          const view = applyOpsToView(state.sharedDoc, state.pendingOps);
          const target = view.comments.find((comment) => comment.id === commentId);
          if (!target) return;
          enqueue({
            opId: nextOpId(),
            kind: "add-reply",
            commentId,
            fileId: target.fileId,
            reply: {
              id: `reply-${state.sessionId}-${state.opCounter + 1}`,
              author: state.reviewer,
              body: trimmed,
              createdAt: new Date().toISOString(),
            },
          });
        },

        resolveComment: (commentId, resolved) => {
          const state = get();
          const view = applyOpsToView(state.sharedDoc, state.pendingOps);
          const target = view.comments.find((comment) => comment.id === commentId);
          if (!target) return;
          const next = resolved ?? !target.resolved;
          if (next === target.resolved) return;
          enqueue({
            opId: nextOpId(),
            kind: "resolve-comment",
            commentId,
            fileId: target.fileId,
            resolved: next,
            prevResolved: target.resolved,
          });
        },

        deleteComment: (commentId) => {
          const state = get();
          const view = applyOpsToView(state.sharedDoc, state.pendingOps);
          const target = view.comments.find((comment) => comment.id === commentId);
          if (!target) return;
          enqueue({
            opId: nextOpId(),
            kind: "delete-comment",
            commentId,
            fileId: target.fileId,
            baseComment: JSON.parse(JSON.stringify(target)) as ReviewComment,
          });
        },

        claimFile: (fileId) => {
          const state = get();
          try {
            const remote = loadSharedDoc() ?? state.sharedDoc;
            const claim = remote.claims[fileId];
            const now = Date.now();
            if (isClaimActive(claim, now) && claim.holderId !== state.sessionId) {
              set({ notice: `「${fileId}」正由 ${claim.holderName} 持有，超时或对方交回后才能接手` });
              return;
            }
            const next: SharedReviewDoc = {
              ...remote,
              claims: {
                ...remote.claims,
                [fileId]: {
                  fileId,
                  holderId: state.sessionId,
                  holderName: state.reviewer,
                  batchId: null,
                  acquiredAt: new Date(now).toISOString(),
                  expiresAt: new Date(now + CLAIM_TTL_MS).toISOString(),
                  releasedAt: null,
                },
              },
              lamport: remote.lamport + 1,
              updatedAt: new Date(now).toISOString(),
              updatedBy: state.sessionId,
            };
            saveSharedDoc(next);
            set({ sharedDoc: next, notice: `已认领「${fileId}」，${Math.round(CLAIM_TTL_MS / 1000)} 秒内其他标签页的提交会等待` });
          } catch (error) {
            set({ notice: `认领失败：${error instanceof Error ? error.message : String(error)}` });
          }
        },

        releaseClaim: (fileId) => {
          const state = get();
          try {
            const remote = loadSharedDoc() ?? state.sharedDoc;
            const claim = remote.claims[fileId];
            if (!claim || claim.holderId !== state.sessionId || !isClaimActive(claim, Date.now())) return;
            const next: SharedReviewDoc = {
              ...remote,
              claims: { ...remote.claims, [fileId]: { ...claim, releasedAt: new Date().toISOString() } },
              lamport: remote.lamport + 1,
              updatedAt: new Date().toISOString(),
              updatedBy: state.sessionId,
            };
            saveSharedDoc(next);
            set({ sharedDoc: next, notice: `已交回「${fileId}」，其他标签页可以接手` });
            if (get().pendingOps.length) scheduleCommit();
          } catch (error) {
            set({ notice: `交回失败：${error instanceof Error ? error.message : String(error)}` });
          }
        },

        takeoverClaim: (fileId) => {
          const state = get();
          try {
            const remote = loadSharedDoc() ?? state.sharedDoc;
            const claim = remote.claims[fileId];
            const now = Date.now();
            if (!isClaimFree(claim, now)) {
              set({ notice: `「${fileId}」仍由 ${claim?.holderName} 持有，暂不能接手` });
              return;
            }
            const next: SharedReviewDoc = {
              ...remote,
              claims: {
                ...remote.claims,
                [fileId]: {
                  fileId,
                  holderId: state.sessionId,
                  holderName: state.reviewer,
                  batchId: null,
                  acquiredAt: new Date(now).toISOString(),
                  expiresAt: new Date(now + CLAIM_TTL_MS).toISOString(),
                  releasedAt: null,
                },
              },
              lamport: remote.lamport + 1,
              updatedAt: new Date(now).toISOString(),
              updatedBy: state.sessionId,
            };
            saveSharedDoc(next);
            set({ sharedDoc: next, notice: `已接手「${fileId}」` });
            if (get().pendingOps.length) scheduleCommit();
          } catch (error) {
            set({ notice: `接手失败：${error instanceof Error ? error.message : String(error)}` });
          }
        },

        adjudicate: (conflictId, choice) => {
          const conflict = applyOpsToView(get().sharedDoc, get().pendingOps).conflicts.find((item) => item.id === conflictId);
          if (!conflict) return;
          enqueue({ opId: nextOpId(), kind: "adjudicate", conflictId, fileId: conflict.fileId, choice });
        },

        simulateChangesetUpdate: () => {
          const state = get();
          const view = applyOpsToView(state.sharedDoc, state.pendingOps);
          const target = view.files.find((file) => file.id === "payment-service") ?? view.files[0];
          if (!target) return;
          const stamp = new Date().toISOString().slice(11, 19);
          const inserted = [
            `// 变更集更新 ${stamp}：灰度开关前移`,
            `const GRAY_ROLLOUT_ENABLED = featureFlags.checkoutV3(${Math.floor(Math.random() * 90) + 10});`,
            `metrics.observe("checkout.gray.rollout", GRAY_ROLLOUT_ENABLED ? 1 : 0);`,
          ];
          const newLines = target.newContent.split("\n");
          const at = Math.min(41, newLines.length - 1);
          newLines.splice(at, 0, ...inserted);
          const mutated = { ...target, newContent: newLines.join("\n"), additions: target.additions + inserted.length };
          const files = view.files.map((file) => (file.id === target.id ? mutated : file));
          const changeset = computeChangeset(files);
          enqueue({ opId: nextOpId(), kind: "changeset", files, changeset });
          set({ notice: `变更集已更新（${target.path}），相关签收失效、评论定位重算` });
        },

        simulateMergeFailure: () => {
          localStorage.setItem(SHARED_DOC_KEY, "{ 这不是合法的共享文档 JSON");
          const state = get();
          if (state.pendingOps.length) {
            set({ notice: "已模拟共享文档损坏，本次提交将失败并保留现场" });
            state.commitNow();
          } else {
            set({ notice: "已模拟共享文档损坏，本次同步将失败并保留现场" });
            state.pullRemote();
          }
        },

        submitReview: () => {
          const state = get();
          if (state.pendingOps.length) state.commitNow();
          const after = get();
          if (after.pendingOps.length) {
            set({ notice: "仍有修改等待同步（可能被其他标签页持有租约），稍后再提交" });
            return;
          }
          const view = after.sharedDoc;
          const openConflicts = view.conflicts.filter((conflict) => conflict.status === "open");
          if (openConflicts.length) {
            set({ notice: `还有 ${openConflicts.length} 个未裁决冲突，裁决后才能提交审阅` });
            return;
          }
          const unsigned = view.files.filter((file) => !view.signoffs[file.id]);
          if (unsigned.length) {
            set({ notice: `还有 ${unsigned.length} 个文件未签收，不能提交审阅` });
            return;
          }
          try {
            const remote = loadSharedDoc() ?? after.sharedDoc;
            const next: SharedReviewDoc = {
              ...remote,
              submission: { submittedBy: after.reviewer, submittedAt: new Date().toISOString() },
              lamport: remote.lamport + 1,
              updatedAt: new Date().toISOString(),
              updatedBy: after.sessionId,
            };
            saveSharedDoc(next);
            set({ sharedDoc: next, notice: `审阅已提交（${view.files.length} 个文件全部签收）` });
          } catch (error) {
            set({ notice: `提交失败：${error instanceof Error ? error.message : String(error)}` });
          }
        },

        reopenReview: () => {
          const state = get();
          try {
            const remote = loadSharedDoc() ?? state.sharedDoc;
            const next: SharedReviewDoc = {
              ...remote,
              submission: null,
              lamport: remote.lamport + 1,
              updatedAt: new Date().toISOString(),
              updatedBy: state.sessionId,
            };
            saveSharedDoc(next);
            set({ sharedDoc: next, notice: "已重新打开审阅" });
          } catch (error) {
            set({ notice: `重开失败：${error instanceof Error ? error.message : String(error)}` });
          }
        },
      };
    },
    {
      name: "diff-scope-session-v1",
      storage: createJSONStorage(() => sessionStorage),
      partialize: (state) => ({
        pendingOps: state.pendingOps,
        currentBatchId: state.currentBatchId,
        opCounter: state.opCounter,
        batchCounter: state.batchCounter,
        selectedFileId: state.selectedFileId,
        viewMode: state.viewMode,
        hideUnchanged: state.hideUnchanged,
      }),
    },
  ),
);

/* ---------------- 派生视图与选择器 ---------------- */

/** 本地视图 = 共享镜像 + 待提交操作（乐观展示） */
export function useViewDoc(): SharedReviewDoc {
  const sharedDoc = useReviewStore((state) => state.sharedDoc);
  const pendingOps = useReviewStore((state) => state.pendingOps);
  return useMemo(() => applyOpsToView(sharedDoc, pendingOps), [sharedDoc, pendingOps]);
}

export function openConflictsOf(doc: SharedReviewDoc, fileId?: string): MergeConflict[] {
  return doc.conflicts.filter((conflict) => conflict.status === "open" && (!fileId || conflict.fileId === fileId));
}

export function commentsForFile(comments: ReviewComment[], fileId: string): ReviewComment[] {
  return comments
    .filter((comment) => comment.fileId === fileId)
    .sort((left, right) => Number(left.resolved) - Number(right.resolved) || left.line - right.line);
}

export function commentSideLabel(side: CommentSide): string {
  return side === "original" ? "旧行" : "新行";
}
