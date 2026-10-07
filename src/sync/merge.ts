import type {
  BatchOp,
  ClaimDeniedInfo,
  DiffFile,
  FileClaim,
  MergeConflict,
  ReviewBatch,
  ReviewComment,
  SharedReviewDoc,
} from "../types/review";
import { reanchorComment } from "./anchors";
import { changedFileIds } from "./hash";
import { forceApplyOp, opFileId } from "./ops";

export const CLAIM_TTL_MS = 45_000;

export function isClaimActive(claim: FileClaim | undefined, now: number): claim is FileClaim {
  return !!claim && !claim.releasedAt && Date.parse(claim.expiresAt) > now;
}

export function isClaimFree(claim: FileClaim | undefined, now: number): boolean {
  return !claim || !!claim.releasedAt || Date.parse(claim.expiresAt) <= now;
}

export function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => deepEqual(item, right[index]));
  }
  if (typeof left === "object") {
    const leftKeys = Object.keys(left as object);
    const rightKeys = Object.keys(right as object);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) =>
      deepEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
    );
  }
  return false;
}

export interface CommitContext {
  sessionId: string;
  author: string;
  now: number;
}

export interface CommitOutcome {
  doc: SharedReviewDoc;
  appliedOps: BatchOp[];
  /** 因认领被占用而暂缓的操作（保留在现场，稍后重试） */
  deferredOps: BatchOp[];
  deniedFiles: ClaimDeniedInfo[];
  newConflicts: MergeConflict[];
  /** 远端已包含本批次（重试场景），无需再写 */
  alreadyApplied: boolean;
}

function conflictId(entity: MergeConflict["entity"], entityId: string, field: string): string {
  return `conflict:${entity}:${entityId}:${field}`;
}

function commentMeta(comment: ReviewComment | undefined | null): MergeConflict["current"] {
  if (!comment) return null;
  return { value: comment, author: comment.author, batchId: comment.batchId, at: comment.updatedAt };
}

function makeConflict(
  fileId: string,
  entity: MergeConflict["entity"],
  entityId: string,
  field: string,
  baseValue: unknown,
  op: BatchOp,
  batch: ReviewBatch,
  current: MergeConflict["current"],
  now: number,
): MergeConflict {
  return {
    id: conflictId(entity, entityId, field),
    fileId,
    entity,
    entityId,
    field,
    baseValue: baseValue ?? null,
    incoming: {
      value: op.kind === "signoff" ? op.record : op.kind === "resolve-comment" ? op.resolved : op.kind === "delete-comment" ? null : op,
      op,
      batchId: batch.id,
      author: batch.author,
      sessionId: batch.sessionId,
      at: new Date(now).toISOString(),
    },
    current,
    detectedAt: new Date(now).toISOString(),
    status: "open",
  };
}

/** 变更集更新：改动文件的签收失效、评论锚点重算，其他文件照旧。按 rev 幂等。 */
export function applyChangesetToDoc(doc: SharedReviewDoc, files: DiffFile[], changeset: SharedReviewDoc["changeset"]): SharedReviewDoc {
  if (doc.changeset.rev === changeset.rev) return doc;
  const changed = new Set(changedFileIds(doc.changeset, changeset));
  const signoffs = { ...doc.signoffs };
  for (const fileId of changed) delete signoffs[fileId];
  const comments = doc.comments.map((comment) => {
    if (!changed.has(comment.fileId)) return comment;
    const file = files.find((item) => item.id === comment.fileId);
    return file ? reanchorComment(comment, file, changeset.rev) : { ...comment, orphaned: true };
  });
  // 变更集更新后，这些文件上的未决冲突失去意义（签收已失效、定位已重算）
  const conflicts = doc.conflicts.filter((conflict) => conflict.status !== "open" || !changed.has(conflict.fileId));
  return { ...doc, files, changeset, signoffs, comments, conflicts };
}

/**
 * 提交合并：以远端共享文档为基础，应用本地待提交操作。
 * 三方基线由操作自身携带（prevRecord / prevResolved / baseComment）：
 * - 实体只有一边动过 → 直接采用；
 * - 两边都改过 → 记录冲突、各留一份，实体保持远端已生效的值；
 * - 同一文件按认领租约串行，先到者领走，被占用则暂缓（保留现场）。
 */
export function commitOps(remote: SharedReviewDoc, ops: BatchOp[], batch: ReviewBatch, ctx: CommitContext): CommitOutcome {
  // 崩溃恢复：批次已落库过，直接视为成功，重试不会重复追加
  if (remote.appliedBatchIds.includes(batch.id)) {
    return { doc: remote, appliedOps: ops, deferredOps: [], deniedFiles: [], newConflicts: [], alreadyApplied: true };
  }

  let doc: SharedReviewDoc = { ...remote, claims: { ...remote.claims } };
  const appliedOps: BatchOp[] = [];
  const deferredOps: BatchOp[] = [];
  const deniedFiles: ClaimDeniedInfo[] = [];
  const newConflicts: MergeConflict[] = [];

  // 认领门控：普通操作按文件检查租约，变更集更新是系统级操作不抢锁
  const deniedFileIds = new Set<string>();
  const touchedFileIds = [...new Set(ops.map(opFileId).filter((id) => id !== "*"))];
  for (const fileId of touchedFileIds) {
    const claim = doc.claims[fileId];
    if (isClaimActive(claim, ctx.now) && claim.holderId !== ctx.sessionId) {
      deniedFileIds.add(fileId);
      deniedFiles.push({ fileId, holderName: claim.holderName, expiresAt: claim.expiresAt });
    }
  }
  for (const fileId of touchedFileIds) {
    if (deniedFileIds.has(fileId)) continue;
    doc.claims[fileId] = {
      fileId,
      holderId: ctx.sessionId,
      holderName: ctx.author,
      batchId: batch.id,
      acquiredAt: new Date(ctx.now).toISOString(),
      expiresAt: new Date(ctx.now + CLAIM_TTL_MS).toISOString(),
      releasedAt: null,
    };
  }

  const openConflictIds = new Set(doc.conflicts.filter((item) => item.status === "open").map((item) => item.id));
  const addConflict = (conflict: MergeConflict) => {
    if (openConflictIds.has(conflict.id)) return; // 同一冲突已挂着，重试不会重复追加
    openConflictIds.add(conflict.id);
    newConflicts.push(conflict);
    doc.conflicts = [...doc.conflicts, conflict];
  };

  for (const op of ops) {
    const fileId = opFileId(op);
    if (fileId !== "*" && deniedFileIds.has(fileId)) {
      deferredOps.push(op);
      continue;
    }

    switch (op.kind) {
      case "add-comment": {
        if (!doc.comments.some((comment) => comment.id === op.comment.id)) {
          doc = { ...doc, comments: [...doc.comments, op.comment] };
        }
        appliedOps.push(op);
        break;
      }
      case "delete-comment": {
        const target = doc.comments.find((comment) => comment.id === op.commentId);
        if (!target) {
          appliedOps.push(op); // 已不存在，幂等跳过
          break;
        }
        if (op.baseComment && !deepEqual(target, op.baseComment)) {
          addConflict(makeConflict(fileId, "comment", op.commentId, "_deleted", op.baseComment, op, batch, commentMeta(target), ctx.now));
          appliedOps.push(op); // 意图已转入冲突单，不再滞留
          break;
        }
        doc = { ...doc, comments: doc.comments.filter((comment) => comment.id !== op.commentId) };
        appliedOps.push(op);
        break;
      }
      case "add-reply": {
        const target = doc.comments.find((comment) => comment.id === op.commentId);
        if (!target) {
          addConflict(makeConflict(fileId, "comment", op.commentId, "_parent-deleted", null, op, batch, null, ctx.now));
          appliedOps.push(op);
          break;
        }
        if (!target.replies.some((reply) => reply.id === op.reply.id)) {
          doc = {
            ...doc,
            comments: doc.comments.map((comment) =>
              comment.id === op.commentId
                ? { ...comment, replies: [...comment.replies, op.reply], updatedAt: op.reply.createdAt }
                : comment,
            ),
          };
        }
        appliedOps.push(op);
        break;
      }
      case "resolve-comment": {
        const target = doc.comments.find((comment) => comment.id === op.commentId);
        if (!target) {
          addConflict(makeConflict(fileId, "comment", op.commentId, "resolved", op.prevResolved, op, batch, null, ctx.now));
          appliedOps.push(op);
          break;
        }
        if (target.resolved === op.resolved) {
          appliedOps.push(op); // 幂等：目标状态已生效
          break;
        }
        if (target.resolved !== op.prevResolved) {
          addConflict(makeConflict(fileId, "comment", op.commentId, "resolved", op.prevResolved, op, batch, commentMeta(target), ctx.now));
          appliedOps.push(op);
          break;
        }
        doc = {
          ...doc,
          comments: doc.comments.map((comment) =>
            comment.id === op.commentId ? { ...comment, resolved: op.resolved, updatedAt: new Date(ctx.now).toISOString() } : comment,
          ),
        };
        appliedOps.push(op);
        break;
      }
      case "signoff": {
        const current = doc.signoffs[op.fileId] ?? null;
        if (deepEqual(current, op.record)) {
          appliedOps.push(op); // 幂等：目标状态已生效
          break;
        }
        if (!deepEqual(current, op.prevRecord)) {
          const currentMeta: MergeConflict["current"] = current
            ? { value: current, author: current.signedBy, batchId: current.batchId, at: current.signedAt }
            : null;
          addConflict(makeConflict(fileId, "signoff", op.fileId, "_signoff", op.prevRecord, op, batch, currentMeta, ctx.now));
          appliedOps.push(op);
          break;
        }
        const signoffs = { ...doc.signoffs };
        if (op.record) signoffs[op.fileId] = op.record;
        else delete signoffs[op.fileId];
        doc = { ...doc, signoffs };
        appliedOps.push(op);
        break;
      }
      case "adjudicate": {
        const conflict = doc.conflicts.find((item) => item.id === op.conflictId && item.status === "open");
        if (!conflict) {
          appliedOps.push(op); // 已被其他标签页裁决，幂等跳过
          break;
        }
        doc = { ...doc, conflicts: doc.conflicts.filter((item) => item.id !== op.conflictId) };
        if (op.choice === "incoming") doc = forceApplyOp(doc, conflict.incoming.op);
        appliedOps.push(op);
        break;
      }
      case "changeset": {
        doc = applyChangesetToDoc(doc, op.files, op.changeset);
        appliedOps.push(op);
        break;
      }
    }
  }

  // 有实际进展才记录批次（audit + 幂等键）
  const madeProgress = appliedOps.length > 0 || newConflicts.length > 0;
  if (madeProgress && !doc.appliedBatchIds.includes(batch.id)) {
    const recorded: ReviewBatch = { ...batch, ops: appliedOps, summary: batch.summary };
    doc = {
      ...doc,
      batches: [...doc.batches, recorded],
      appliedBatchIds: [...doc.appliedBatchIds, batch.id],
    };
  }

  return { doc, appliedOps, deferredOps, deniedFiles, newConflicts, alreadyApplied: false };
}
