import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { mockChangeLines, mockDiffFiles } from "../data/mockDiff";
import type {
  CommentDraft,
  CommentSide,
  DiffViewMode,
  FileConflict,
  FileProgress,
  MergeStatus,
  ReviewBatch,
  ReviewComment,
  ReviewSnapshot,
} from "../types/review";
import {
  BATCH_TTL_MS,
  buildThreadsFromComments,
  claimFile,
  createBatch,
  emptyProgress,
  expireClaim,
  handbackFile,
  isBatchExpired,
  isClaimable,
  isClaimExpired,
  isConflicted,
  isSigned,
  signFile,
  takeoverFile,
  CLAIM_TTL_MS,
} from "../utils/batch";
import { handleChangesetChange } from "../utils/changeset";
import { adjudicateConflict, mergeSnapshots, progressEquals } from "../utils/merge";
import { loadSnapshot, saveSnapshot } from "../utils/migration";
import { SyncChannel, simulateRemoteSnapshot } from "../utils/sync";

const CURRENT_HOLDER = "林澈";

// 旧版本初始评论（迁移用）
const legacyComments: ReviewComment[] = [
  {
    id: "comment-payment-cache-version",
    threadId: "thread-payment-cache-version",
    fileId: "payment-service",
    line: mockChangeLines["payment-service"][0],
    side: "modified",
    author: "林澈",
    body: "缓存版本参与 key 后，旧版本数据不会命中；这里还需要确认发版期间双写时间足够长。",
    createdAt: new Date(Date.now() - 42 * 60_000).toISOString(),
    resolved: false,
    replies: [
      {
        id: "reply-cache-1",
        author: "陈乔木",
        body: "已确认灰度期间会保留 30 分钟双写，并监控 cache.miss 指标。",
        createdAt: new Date(Date.now() - 31 * 60_000).toISOString(),
      },
    ],
  },
  {
    id: "comment-payment-retry",
    threadId: "thread-payment-retry",
    fileId: "payment-service",
    line: mockChangeLines["payment-service"][4],
    side: "modified",
    author: "赵明",
    body: "重试只覆盖网络错误和网关超时就可以，业务拒绝不能重试，当前分类是正确的。",
    createdAt: new Date(Date.now() - 26 * 60_000).toISOString(),
    resolved: true,
    replies: [],
  },
  {
    id: "comment-order-table-selection",
    threadId: "thread-order-table-selection",
    fileId: "order-table",
    line: mockChangeLines["order-table"][1],
    side: "modified",
    author: "周岚",
    body: "批量选择在翻页后会不会丢数据？建议状态层使用 Set，并补一个跨页选择测试。",
    createdAt: new Date(Date.now() - 18 * 60_000).toISOString(),
    resolved: false,
    replies: [],
  },
  {
    id: "comment-validator-phone",
    threadId: "thread-validator-phone",
    fileId: "validators",
    line: mockChangeLines["validators"][0],
    side: "modified",
    author: "林澈",
    body: "手机号校验从宽松改为大陆号段，需要确认海外手机号是否走单独入口。",
    createdAt: new Date(Date.now() - 9 * 60_000).toISOString(),
    resolved: false,
    replies: [],
  },
];

function buildInitialSnapshot(): ReviewSnapshot {
  const now = new Date().toISOString();
  const progress: Record<string, FileProgress> = {};
  for (const file of mockDiffFiles) {
    const fileComments = legacyComments.filter((c) => c.fileId === file.id);
    const reviewed = file.id === "router";
    progress[file.id] = {
      ...emptyProgress(file.id),
      reviewed,
      signoffStatus: reviewed ? "signed" : "pending",
      holder: reviewed ? CURRENT_HOLDER : null,
      signedAt: reviewed ? now : null,
      comments: fileComments,
    };
  }
  const batch = createBatch(CURRENT_HOLDER);
  return {
    version: 1,
    changesetVersion: 1,
    batches: [batch],
    threads: buildThreadsFromComments(legacyComments),
    progress,
    updatedAt: now,
    updatedBy: CURRENT_HOLDER,
  };
}

interface ReviewState {
  files: typeof mockDiffFiles;
  selectedFileId: string;
  viewMode: DiffViewMode;
  hideUnchanged: boolean;
  draft: CommentDraft | null;

  // 审阅快照（工作副本）
  snapshot: ReviewSnapshot;
  // 合并基准（上次同步的状态）：三路合并的 base
  baseSnapshot: ReviewSnapshot;
  // 上次远端快照（重试合并用）
  lastRemoteSnapshot: ReviewSnapshot | null;
  // 当前批次
  currentBatchId: string | null;
  // 冲突
  conflicts: Record<string, FileConflict>;
  mergeStatus: MergeStatus;
  mergeError: string | null;
  lastMergedAt: string | null;
  migrated: boolean;

  // 派生便捷字段（从 snapshot 计算）
  reviewedFiles: string[];
  comments: ReviewComment[];
  signoffs: Record<string, FileProgress>;

  // 视图操作
  setSelectedFile: (fileId: string) => void;
  setViewMode: (mode: DiffViewMode) => void;
  setHideUnchanged: (value: boolean) => void;
  setDraft: (draft: CommentDraft | null) => void;

  // 批次操作
  startBatch: (holder?: string) => void;
  handbackBatch: () => void;
  takeoverBatch: (batchId: string) => void;
  expireBatches: () => void;

  // 签收操作
  claimFile: (fileId: string) => void;
  signFile: (fileId?: string) => void;
  handbackFile: (fileId: string) => void;
  takeoverFile: (fileId: string) => void;
  toggleReviewed: (fileId?: string) => void;

  // 评论操作
  addComment: (draft: CommentDraft, body: string) => void;
  addReply: (commentId: string, body: string) => void;
  resolveComment: (commentId: string, resolved?: boolean) => void;
  deleteComment: (commentId: string) => void;

  // 合并操作
  mergeRemoteSnapshot: (remote: ReviewSnapshot) => void;
  adjudicateConflict: (fileId: string, choice: "local" | "remote" | "base") => void;
  retryMerge: () => void;
  simulateRemoteChange: () => void;

  // 变更集操作
  bumpChangeset: () => void;
}

function deriveReviewedFiles(progress: Record<string, FileProgress>): string[] {
  return Object.values(progress)
    .filter((p) => p.reviewed)
    .map((p) => p.fileId);
}

function deriveComments(progress: Record<string, FileProgress>): ReviewComment[] {
  return Object.values(progress).flatMap((p) => p.comments);
}

function deriveSignoffs(progress: Record<string, FileProgress>): Record<string, FileProgress> {
  return progress;
}

let syncChannel: SyncChannel | null = null;
function getSyncChannel(): SyncChannel {
  if (!syncChannel) syncChannel = new SyncChannel();
  return syncChannel;
}

// 应用快照并广播
function applySnapshot(
  set: (partial: Partial<ReviewState>) => void,
  get: () => ReviewState,
  snapshot: ReviewSnapshot,
  extra: Partial<ReviewState> = {},
) {
  saveSnapshot(snapshot);
  set({
    snapshot,
    reviewedFiles: deriveReviewedFiles(snapshot.progress),
    comments: deriveComments(snapshot.progress),
    signoffs: deriveSignoffs(snapshot.progress),
    ...extra,
  });
  getSyncChannel().broadcast(snapshot);
}

export const useReviewStore = create<ReviewState>()(
  persist(
    (set, get) => {
      // 初始化：加载快照或迁移旧数据
      const { snapshot: initialSnapshot, migrated } = loadSnapshot();
      const initialBatch = initialSnapshot.batches.find((b) => b.status === "active") ?? null;

      // 订阅跨标签页同步
      const channel = getSyncChannel();
      channel.subscribe((message) => {
        if (message.type !== "snapshot-update") return;
        if (message.tabId === channel.tabId) return;
        get().mergeRemoteSnapshot(message.snapshot);
      });

      return {
        files: mockDiffFiles,
        selectedFileId: mockDiffFiles[0].id,
        viewMode: "side-by-side",
        hideUnchanged: true,
        draft: null,

        snapshot: initialSnapshot,
        baseSnapshot: initialSnapshot,
        lastRemoteSnapshot: null,
        currentBatchId: initialBatch?.id ?? null,
        conflicts: {},
        mergeStatus: "idle",
        mergeError: null,
        lastMergedAt: null,
        migrated,

        reviewedFiles: deriveReviewedFiles(initialSnapshot.progress),
        comments: deriveComments(initialSnapshot.progress),
        signoffs: deriveSignoffs(initialSnapshot.progress),

        setSelectedFile: (selectedFileId) => set({ selectedFileId, draft: null }),
        setViewMode: (viewMode) => set({ viewMode }),
        setHideUnchanged: (hideUnchanged) => set({ hideUnchanged }),
        setDraft: (draft) => set({ draft }),

        // === 批次操作 ===
        startBatch: (holder = CURRENT_HOLDER) => {
          const state = get();
          const batch = createBatch(holder);
          const snapshot: ReviewSnapshot = {
            ...state.snapshot,
            batches: [...state.snapshot.batches, batch],
            updatedAt: new Date().toISOString(),
            updatedBy: holder,
          };
          applySnapshot(set, get, snapshot, { currentBatchId: batch.id });
        },

        handbackBatch: () => {
          const state = get();
          if (!state.currentBatchId) return;
          const batches = state.snapshot.batches.map((b) =>
            b.id === state.currentBatchId ? { ...b, status: "handed_back" as const } : b,
          );
          const snapshot: ReviewSnapshot = {
            ...state.snapshot,
            batches,
            updatedAt: new Date().toISOString(),
            updatedBy: CURRENT_HOLDER,
          };
          applySnapshot(set, get, snapshot, { currentBatchId: null });
        },

        takeoverBatch: (batchId) => {
          const state = get();
          const target = state.snapshot.batches.find((b) => b.id === batchId);
          if (!target || target.status === "active") return;
          const batch = createBatch(CURRENT_HOLDER);
          const batches = state.snapshot.batches.map((b) =>
            b.id === batchId ? { ...b, status: "submitted" as const } : b,
          );
          const snapshot: ReviewSnapshot = {
            ...state.snapshot,
            batches: [...batches, batch],
            updatedAt: new Date().toISOString(),
            updatedBy: CURRENT_HOLDER,
          };
          applySnapshot(set, get, snapshot, { currentBatchId: batch.id });
        },

        expireBatches: () => {
          const state = get();
          const now = Date.now();
          let changed = false;
          const batches = state.snapshot.batches.map((b) => {
            if (b.status === "active" && isBatchExpired(b, now)) {
              changed = true;
              return { ...b, status: "expired" as const };
            }
            return b;
          });
          if (!changed) return;
          const snapshot: ReviewSnapshot = {
            ...state.snapshot,
            batches,
            updatedAt: new Date().toISOString(),
            updatedBy: CURRENT_HOLDER,
          };
          applySnapshot(set, get, snapshot, {
            currentBatchId: state.currentBatchId && isBatchExpired(state.snapshot.batches.find((b) => b.id === state.currentBatchId)!, now)
              ? null
              : state.currentBatchId,
          });
        },

        // === 签收操作 ===
        claimFile: (fileId) => {
          const state = get();
          const batchId = state.currentBatchId;
          if (!batchId) return;
          const current = state.snapshot.progress[fileId] ?? emptyProgress(fileId);
          if (!isClaimable(current)) return;
          const updated = claimFile(current, CURRENT_HOLDER, batchId);
          const snapshot = updateProgress(state.snapshot, fileId, updated);
          applySnapshot(set, get, snapshot);
        },

        signFile: (fileId) => {
          const state = get();
          const target = fileId ?? state.selectedFileId;
          const current = state.snapshot.progress[target];
          if (!current || isConflicted(current)) return;
          if (current.signoffStatus !== "claimed") return;
          const updated = signFile(current);
          const snapshot = updateProgress(state.snapshot, target, updated);
          applySnapshot(set, get, snapshot);
        },

        handbackFile: (fileId) => {
          const state = get();
          const current = state.snapshot.progress[fileId];
          if (!current || current.holder !== CURRENT_HOLDER) return;
          const updated = handbackFile(current);
          const snapshot = updateProgress(state.snapshot, fileId, updated);
          applySnapshot(set, get, snapshot);
        },

        takeoverFile: (fileId) => {
          const state = get();
          const batchId = state.currentBatchId;
          if (!batchId) return;
          const current = state.snapshot.progress[fileId] ?? emptyProgress(fileId);
          if (!isClaimable(current)) return;
          const updated = takeoverFile(current, CURRENT_HOLDER, batchId);
          const snapshot = updateProgress(state.snapshot, fileId, updated);
          applySnapshot(set, get, snapshot);
        },

        toggleReviewed: (fileId) => {
          const state = get();
          const target = fileId ?? state.selectedFileId;
          const current = state.snapshot.progress[target];
          if (!current || isConflicted(current)) return;
          if (isSigned(current)) {
            const updated = handbackFile(current);
            const snapshot = updateProgress(state.snapshot, target, updated);
            applySnapshot(set, get, snapshot);
          } else if (current.signoffStatus === "claimed") {
            const updated = signFile(current);
            const snapshot = updateProgress(state.snapshot, target, updated);
            applySnapshot(set, get, snapshot);
          } else {
            // 未认领状态下直接标记已查看（兼容旧交互）
            const updated: FileProgress = {
              ...current,
              reviewed: true,
              signoffStatus: "signed",
              signedAt: new Date().toISOString(),
            };
            const snapshot = updateProgress(state.snapshot, target, updated);
            applySnapshot(set, get, snapshot);
          }
        },

        // === 评论操作 ===
        addComment: (draft, body) => {
          const state = get();
          const trimmed = body.trim();
          if (!trimmed) return;
          const threadId = `thread-${draft.fileId}-${draft.side}-${draft.line}-${Date.now()}`;
          const comment: ReviewComment = {
            id: `comment-${Date.now()}`,
            threadId,
            fileId: draft.fileId,
            line: draft.line,
            side: draft.side,
            author: CURRENT_HOLDER,
            body: trimmed,
            createdAt: new Date().toISOString(),
            resolved: false,
            replies: [],
          };
          const current = state.snapshot.progress[draft.fileId] ?? emptyProgress(draft.fileId);
          if (isConflicted(current)) return;
          const updated: FileProgress = {
            ...current,
            comments: [...current.comments, comment],
          };
          const snapshot = updateProgress(state.snapshot, draft.fileId, updated);
          const threads = upsertThread(snapshot.threads, {
            id: threadId,
            fileId: draft.fileId,
            line: draft.line,
            side: draft.side,
            resolved: false,
            createdAt: comment.createdAt,
            updatedAt: comment.createdAt,
          });
          applySnapshot(set, get, { ...snapshot, threads }, { draft: null });
        },

        addReply: (commentId, body) => {
          const state = get();
          const trimmed = body.trim();
          if (!trimmed) return;
          const now = new Date().toISOString();
          const progress = { ...state.snapshot.progress };
          for (const fileId of Object.keys(progress)) {
            const fileProgress = progress[fileId];
            if (isConflicted(fileProgress)) continue;
            fileProgress.comments = fileProgress.comments.map((comment) =>
              comment.id === commentId
                ? {
                    ...comment,
                    replies: [
                      ...comment.replies,
                      {
                        id: `reply-${Date.now()}-${comment.replies.length}`,
                        author: CURRENT_HOLDER,
                        body: trimmed,
                        createdAt: now,
                      },
                    ],
                  }
                : comment,
            );
          }
          const snapshot: ReviewSnapshot = {
            ...state.snapshot,
            progress,
            updatedAt: now,
            updatedBy: CURRENT_HOLDER,
          };
          applySnapshot(set, get, snapshot);
        },

        resolveComment: (commentId, resolved = true) => {
          const state = get();
          const now = new Date().toISOString();
          const progress = { ...state.snapshot.progress };
          for (const fileId of Object.keys(progress)) {
            const fileProgress = progress[fileId];
            if (isConflicted(fileProgress)) continue;
            fileProgress.comments = fileProgress.comments.map((comment) =>
              comment.id === commentId ? { ...comment, resolved } : comment,
            );
          }
          const threads = state.snapshot.threads.map((thread) => {
            const hasComment = Object.values(progress).some((p) =>
              p.comments.some((c) => c.threadId === thread.id && c.resolved === resolved),
            );
            return hasComment ? { ...thread, resolved, updatedAt: now } : thread;
          });
          const snapshot: ReviewSnapshot = {
            ...state.snapshot,
            progress,
            threads,
            updatedAt: now,
            updatedBy: CURRENT_HOLDER,
          };
          applySnapshot(set, get, snapshot);
        },

        deleteComment: (commentId) => {
          const state = get();
          const now = new Date().toISOString();
          const progress = { ...state.snapshot.progress };
          for (const fileId of Object.keys(progress)) {
            const fileProgress = progress[fileId];
            if (isConflicted(fileProgress)) continue;
            fileProgress.comments = fileProgress.comments.filter((comment) => comment.id !== commentId);
          }
          const threads = state.snapshot.threads.filter((thread) => {
            const stillExists = Object.values(progress).some((p) =>
              p.comments.some((c) => c.threadId === thread.id),
            );
            return stillExists;
          });
          const snapshot: ReviewSnapshot = {
            ...state.snapshot,
            progress,
            threads,
            updatedAt: now,
            updatedBy: CURRENT_HOLDER,
          };
          applySnapshot(set, get, snapshot);
        },

        // === 合并操作 ===
        mergeRemoteSnapshot: (remote) => {
          const state = get();
          set({ mergeStatus: "merging", mergeError: null, lastRemoteSnapshot: remote });
          try {
            // 三路合并：base = 上次同步状态，local = 当前工作副本，remote = 远端快照
            const base = state.baseSnapshot;
            const local = state.snapshot;
            const { merged, conflicts } = mergeSnapshots(base, local, remote);
            const conflictCount = Object.keys(conflicts).length;
            set({
              snapshot: merged,
              conflicts,
              mergeStatus: conflictCount > 0 ? "failed" : "succeeded",
              mergeError: conflictCount > 0 ? `${conflictCount} 个文件存在冲突，需裁决后才能提交` : null,
              lastMergedAt: new Date().toISOString(),
              reviewedFiles: deriveReviewedFiles(merged.progress),
              comments: deriveComments(merged.progress),
              signoffs: deriveSignoffs(merged.progress),
            });
            saveSnapshot(merged);
            // 合并成功后更新基准（冲突未裁决前不更新，保留 base 直到裁决）
            if (conflictCount === 0) {
              set({ baseSnapshot: merged });
            }
          } catch (error) {
            // 合并失败保留现场：不修改 snapshot，记录错误，等待重试
            set({
              mergeStatus: "failed",
              mergeError: error instanceof Error ? error.message : "合并失败",
            });
          }
        },

        adjudicateConflict: (fileId, choice) => {
          const state = get();
          const conflict = state.conflicts[fileId];
          if (!conflict) return;
          const resolved = adjudicateConflict(conflict, choice);
          const progress = { ...state.snapshot.progress, [fileId]: resolved };
          const conflicts = { ...state.conflicts };
          delete conflicts[fileId];
          const remainingConflicts = Object.keys(conflicts).length;
          const snapshot: ReviewSnapshot = {
            ...state.snapshot,
            progress,
            updatedAt: new Date().toISOString(),
            updatedBy: CURRENT_HOLDER,
          };
          set({
            snapshot,
            conflicts,
            mergeStatus: remainingConflicts > 0 ? "failed" : "succeeded",
            mergeError: remainingConflicts > 0 ? `${remainingConflicts} 个文件存在冲突，需裁决后才能提交` : null,
            reviewedFiles: deriveReviewedFiles(snapshot.progress),
            comments: deriveComments(snapshot.progress),
            signoffs: deriveSignoffs(snapshot.progress),
          });
          saveSnapshot(snapshot);
          // 裁决后更新基准，防止同一冲突被重复检测
          set({ baseSnapshot: snapshot });
          getSyncChannel().broadcast(snapshot);
        },

        retryMerge: () => {
          const state = get();
          if (state.mergeStatus !== "failed") return;
          // 重试不重复追加线程：mergeSnapshots 按 id 匹配线程，幂等
          set({ mergeStatus: "merging", mergeError: null });
          try {
            if (state.lastRemoteSnapshot) {
              // 重新基于 base 合并远端快照
              const base = state.baseSnapshot;
              const local = state.snapshot;
              const { merged, conflicts } = mergeSnapshots(base, local, state.lastRemoteSnapshot);
              const conflictCount = Object.keys(conflicts).length;
              set({
                snapshot: merged,
                conflicts,
                mergeStatus: conflictCount > 0 ? "failed" : "succeeded",
                mergeError: conflictCount > 0 ? `${conflictCount} 个文件存在冲突，需裁决后才能提交` : null,
                lastMergedAt: new Date().toISOString(),
                reviewedFiles: deriveReviewedFiles(merged.progress),
                comments: deriveComments(merged.progress),
                signoffs: deriveSignoffs(merged.progress),
              });
              saveSnapshot(merged);
              if (conflictCount === 0) {
                set({ baseSnapshot: merged });
                getSyncChannel().broadcast(merged);
              }
            } else {
              // 无远端快照，仅检查当前冲突状态
              set({
                mergeStatus: Object.keys(state.conflicts).length > 0 ? "failed" : "succeeded",
                mergeError: Object.keys(state.conflicts).length > 0 ? state.mergeError : null,
                lastMergedAt: new Date().toISOString(),
              });
            }
          } catch (error) {
            // 合并失败保留现场：不修改 snapshot，等待下次重试
            set({
              mergeStatus: "failed",
              mergeError: error instanceof Error ? error.message : "合并失败",
            });
          }
        },

        simulateRemoteChange: () => {
          const state = get();
          const remote = simulateRemoteSnapshot(state.snapshot);
          get().mergeRemoteSnapshot(remote);
        },

        // === 变更集操作 ===
        bumpChangeset: () => {
          const state = get();
          // 模拟变更集内容变化：在第一个有评论的文件的 newContent 开头插入一行，
          // 使后续评论行号整体下移，演示签收失效与评论定位重算。
          const targetFile = state.files.find(
            (file) => (state.snapshot.progress[file.id]?.comments.length ?? 0) > 0,
          );
          if (!targetFile) return;
          const oldFiles = state.files;
          const newFiles = state.files.map((file) =>
            file.id === targetFile.id
              ? { ...file, newContent: `// 变更集更新 ${new Date().toISOString()}\n${file.newContent}` }
              : file,
          );
          const { progress } = handleChangesetChange(oldFiles, newFiles, state.snapshot.progress);
          const snapshot: ReviewSnapshot = {
            ...state.snapshot,
            changesetVersion: state.snapshot.changesetVersion + 1,
            progress,
            updatedAt: new Date().toISOString(),
            updatedBy: CURRENT_HOLDER,
          };
          applySnapshot(set, get, snapshot, { files: newFiles });
        },
      };
    },
    {
      name: "diff-scope-review-v1",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        selectedFileId: state.selectedFileId,
        viewMode: state.viewMode,
        hideUnchanged: state.hideUnchanged,
      }),
    },
  ),
);

// === 辅助函数 ===

function updateProgress(
  snapshot: ReviewSnapshot,
  fileId: string,
  progress: FileProgress,
): ReviewSnapshot {
  return {
    ...snapshot,
    progress: { ...snapshot.progress, [fileId]: progress },
    updatedAt: new Date().toISOString(),
  };
}

function upsertThread(threads: ReviewSnapshot["threads"], thread: ReviewSnapshot["threads"][number]): ReviewSnapshot["threads"] {
  const existing = threads.find((t) => t.id === thread.id);
  if (existing) {
    return threads.map((t) => (t.id === thread.id ? { ...t, updatedAt: thread.updatedAt } : t));
  }
  return [...threads, thread];
}

// === 派生选择器 ===

export function commentsForFile(comments: ReviewComment[], fileId: string): ReviewComment[] {
  return comments
    .filter((comment) => comment.fileId === fileId)
    .sort((left, right) => Number(left.resolved) - Number(right.resolved) || left.line - right.line);
}

export function commentSideLabel(side: CommentSide): string {
  return side === "original" ? "旧行" : "新行";
}

export function fileSignoff(state: ReviewState, fileId: string): FileProgress | undefined {
  return state.signoffs[fileId];
}

export function activeBatch(state: ReviewState): ReviewBatch | undefined {
  return state.snapshot.batches.find((b) => b.id === state.currentBatchId);
}

export function batchHolderLabel(batch: ReviewBatch | undefined): string {
  if (!batch) return "无批次";
  if (batch.status === "active") return `${batch.holder} · 进行中`;
  if (batch.status === "handed_back") return `${batch.holder} · 已交回`;
  if (batch.status === "expired") return `${batch.holder} · 已超时`;
  return `${batch.holder} · 已提交`;
}

// 重新导出工具函数供 UI 使用
export { isClaimable, isClaimExpired, isConflicted, isSigned, BATCH_TTL_MS, CLAIM_TTL_MS };
