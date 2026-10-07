import type { BatchOp, ReviewBatch, SharedReviewDoc } from "../types/review";

/** 无条件应用单个操作（裁决后补应用 / 视图推导用），不做冲突检查 */
export function forceApplyOp(doc: SharedReviewDoc, op: BatchOp): SharedReviewDoc {
  switch (op.kind) {
    case "add-comment": {
      if (doc.comments.some((comment) => comment.id === op.comment.id)) return doc;
      return { ...doc, comments: [...doc.comments, op.comment] };
    }
    case "delete-comment":
      return { ...doc, comments: doc.comments.filter((comment) => comment.id !== op.commentId) };
    case "add-reply": {
      const target = doc.comments.find((comment) => comment.id === op.commentId);
      if (!target || target.replies.some((reply) => reply.id === op.reply.id)) return doc;
      return {
        ...doc,
        comments: doc.comments.map((comment) =>
          comment.id === op.commentId
            ? { ...comment, replies: [...comment.replies, op.reply], updatedAt: op.reply.createdAt }
            : comment,
        ),
      };
    }
    case "resolve-comment": {
      const target = doc.comments.find((comment) => comment.id === op.commentId);
      if (!target || target.resolved === op.resolved) return doc;
      return {
        ...doc,
        comments: doc.comments.map((comment) =>
          comment.id === op.commentId ? { ...comment, resolved: op.resolved, updatedAt: new Date().toISOString() } : comment,
        ),
      };
    }
    case "signoff": {
      const signoffs = { ...doc.signoffs };
      if (op.record) signoffs[op.fileId] = op.record;
      else delete signoffs[op.fileId];
      return { ...doc, signoffs };
    }
    default:
      return doc;
  }
}

/**
 * 把一组操作无条件应用到文档上（本地乐观视图用）。
 * 提交时的冲突检测在 merge.ts 中做，这里只做幂等的直应用。
 */
export function applyOpsToView(doc: SharedReviewDoc, ops: BatchOp[]): SharedReviewDoc {
  let view = doc;
  for (const op of ops) {
    if (op.kind === "adjudicate") {
      const conflict = view.conflicts.find((item) => item.id === op.conflictId && item.status === "open");
      if (!conflict) continue;
      view = { ...view, conflicts: view.conflicts.filter((item) => item.id !== op.conflictId) };
      if (op.choice === "incoming") view = forceApplyOp(view, conflict.incoming.op);
      continue;
    }
    if (op.kind === "changeset") {
      if (view.changeset.rev === op.changeset.rev) continue;
      view = { ...view, files: op.files, changeset: op.changeset };
      continue;
    }
    view = forceApplyOp(view, op);
  }
  return view;
}

const OP_LABEL: Record<BatchOp["kind"], string> = {
  "add-comment": "条评论",
  "delete-comment": "条删除",
  "add-reply": "条回复",
  "resolve-comment": "次状态切换",
  signoff: "次签收",
  adjudicate: "次裁决",
  changeset: "次变更集更新",
};

export function summarizeOps(ops: BatchOp[]): string {
  if (!ops.length) return "空批次";
  const counts = new Map<BatchOp["kind"], number>();
  for (const op of ops) counts.set(op.kind, (counts.get(op.kind) ?? 0) + 1);
  return [...counts.entries()].map(([kind, count]) => `${count} ${OP_LABEL[kind]}`).join(" · ");
}

/** 操作涉及的文件 id，用于按文件认领 */
export function opFileId(op: BatchOp): string {
  switch (op.kind) {
    case "add-comment":
      return op.comment.fileId;
    case "delete-comment":
    case "add-reply":
    case "resolve-comment":
    case "signoff":
    case "adjudicate":
      return op.fileId;
    case "changeset":
      return "*";
  }
}

export function batchTouchesFile(batch: ReviewBatch, fileId: string): boolean {
  return batch.ops.some((op) => opFileId(op) === fileId);
}
