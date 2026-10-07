import type {
  CommentReply,
  CommentThread,
  FileConflict,
  FileProgress,
  ReviewComment,
  ReviewSnapshot,
} from "../types/review";

// 深比较回复（仅比较稳定字段，避免时间戳等噪声）
function repliesEqual(a: CommentReply[], b: CommentReply[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((reply, index) => reply.id === b[index].id && reply.body === b[index].body);
}

// 深比较评论（用于判断某一边是否改动过）
function commentEquals(a: ReviewComment, b: ReviewComment): boolean {
  return (
    a.id === b.id &&
    a.threadId === b.threadId &&
    a.fileId === b.fileId &&
    a.line === b.line &&
    a.side === b.side &&
    a.resolved === b.resolved &&
    a.body === b.body &&
    repliesEqual(a.replies, b.replies)
  );
}

export function commentsEqual(a: ReviewComment[], b: ReviewComment[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((comment, index) => commentEquals(comment, b[index]));
}

// 比较两份文件进度是否一致（合并时判断"是否只有一边动过"）
export function progressEquals(a: FileProgress | undefined, b: FileProgress | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.fileId === b.fileId &&
    a.reviewed === b.reviewed &&
    a.signoffStatus === b.signoffStatus &&
    a.holder === b.holder &&
    a.batchId === b.batchId &&
    a.claimedAt === b.claimedAt &&
    a.signedAt === b.signedAt &&
    commentsEqual(a.comments, b.comments)
  );
}

// 三路合并单个文件进度。
// - 只有一边动过：直接采用那一边
// - 两边都改过：各留一份（冲突），挡住文件完成
// - 都没动：保留 base
export function mergeProgress(
  base: FileProgress | undefined,
  local: FileProgress | undefined,
  remote: FileProgress | undefined,
): { value: FileProgress | undefined; conflict: boolean } {
  const localChanged = !progressEquals(local, base);
  const remoteChanged = !progressEquals(remote, base);

  if (localChanged && remoteChanged) {
    return { value: base, conflict: true };
  }
  if (localChanged) return { value: local, conflict: false };
  if (remoteChanged) return { value: remote, conflict: false };
  return { value: base, conflict: false };
}

// 合并评论线程：按稳定 id 取并集，避免重试时重复追加线程。
function mergeThreads(
  base: CommentThread[],
  local: CommentThread[],
  remote: CommentThread[],
): CommentThread[] {
  const threadMap = new Map<string, CommentThread>();
  for (const thread of base) threadMap.set(thread.id, thread);
  for (const thread of local) threadMap.set(thread.id, thread);
  for (const thread of remote) threadMap.set(thread.id, thread);
  return Array.from(threadMap.values());
}

export interface MergeResult {
  merged: ReviewSnapshot;
  conflicts: Record<string, FileConflict>;
}

// 把远端快照合并进本地快照。
// 合并是幂等的：相同输入多次合并得到相同结果，不会重复追加线程。
export function mergeSnapshots(
  base: ReviewSnapshot,
  local: ReviewSnapshot,
  remote: ReviewSnapshot,
): MergeResult {
  const merged: ReviewSnapshot = {
    ...local,
    progress: { ...local.progress },
    threads: mergeThreads(base.threads, local.threads, remote.threads),
  };
  const conflicts: Record<string, FileConflict> = {};

  const fileIds = new Set([
    ...Object.keys(base.progress),
    ...Object.keys(local.progress),
    ...Object.keys(remote.progress),
  ]);

  for (const fileId of fileIds) {
    const b = base.progress[fileId];
    const l = local.progress[fileId];
    const r = remote.progress[fileId];
    const { value, conflict } = mergeProgress(b, l, r);
    if (conflict) {
      conflicts[fileId] = {
        fileId,
        local: l!,
        remote: r!,
        base: b!,
        detectedAt: new Date().toISOString(),
      };
      // 冲突未裁决前保留 base，挡住文件完成
      if (b) merged.progress[fileId] = b;
    } else if (value) {
      merged.progress[fileId] = value;
    }
  }

  merged.updatedAt = new Date().toISOString();
  merged.updatedBy = remote.updatedBy;
  return { merged, conflicts };
}

// 裁决冲突：选择本地、远端或 base 版本作为最终结果。
export function adjudicateConflict(
  conflict: FileConflict,
  choice: "local" | "remote" | "base",
): FileProgress {
  if (choice === "local") return conflict.local;
  if (choice === "remote") return conflict.remote;
  return conflict.base;
}
