import type { FileProgress, ReviewBatch, SignoffStatus } from "../types/review";

// 批次有效期：5 分钟
export const BATCH_TTL_MS = 5 * 60 * 1000;
// 签收认领有效期：2 分钟
export const CLAIM_TTL_MS = 2 * 60 * 1000;

export function createBatch(holder: string, now: number = Date.now()): ReviewBatch {
  return {
    id: `batch-${now}-${Math.random().toString(36).slice(2, 8)}`,
    holder,
    startedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + BATCH_TTL_MS).toISOString(),
    status: "active",
  };
}

export function isBatchExpired(batch: ReviewBatch, now: number = Date.now()): boolean {
  return new Date(batch.expiresAt).getTime() <= now;
}

export function isClaimExpired(progress: FileProgress, now: number = Date.now()): boolean {
  if (!progress.claimedAt) return false;
  return new Date(progress.claimedAt).getTime() + CLAIM_TTL_MS <= now;
}

// 先到者领走：认领文件。若文件已被他人认领且未过期，则抢占失败。
export function claimFile(
  progress: FileProgress,
  holder: string,
  batchId: string,
  now: number = Date.now(),
): FileProgress {
  return {
    ...progress,
    signoffStatus: "claimed",
    holder,
    batchId,
    claimedAt: new Date(now).toISOString(),
  };
}

// 签收：认领人完成审阅。冲突状态下不能签收。
export function signFile(progress: FileProgress, now: number = Date.now()): FileProgress {
  if (progress.signoffStatus === "conflict") return progress;
  return {
    ...progress,
    signoffStatus: "signed",
    reviewed: true,
    signedAt: new Date(now).toISOString(),
  };
}

// 交回：认领人放弃，文件回到待认领状态，他人可接手。
export function handbackFile(progress: FileProgress): FileProgress {
  return {
    ...progress,
    signoffStatus: "pending",
    holder: null,
    batchId: null,
    claimedAt: null,
  };
}

// 超时：认领过期，文件回到待认领状态。
export function expireClaim(progress: FileProgress): FileProgress {
  return handbackFile(progress);
}

// 接管：认领超时或被交回的文件。
export function takeoverFile(
  progress: FileProgress,
  holder: string,
  batchId: string,
  now: number = Date.now(),
): FileProgress {
  return claimFile(progress, holder, batchId, now);
}

// 判断文件是否可被认领（pending 或认领已过期）。
export function isClaimable(progress: FileProgress, now: number = Date.now()): boolean {
  if (progress.signoffStatus === "pending") return true;
  if (progress.signoffStatus === "claimed" && isClaimExpired(progress, now)) return true;
  return false;
}

// 判断文件是否已完成签收。
export function isSigned(progress: FileProgress): boolean {
  return progress.signoffStatus === "signed";
}

// 判断文件是否处于冲突状态（挡住文件完成）。
export function isConflicted(progress: FileProgress): boolean {
  return progress.signoffStatus === "conflict";
}

// 创建一份空的文件进度。
export function emptyProgress(fileId: string): FileProgress {
  return {
    fileId,
    reviewed: false,
    signoffStatus: "pending",
    holder: null,
    batchId: null,
    claimedAt: null,
    signedAt: null,
    comments: [],
  };
}

// 从评论列表构建线程元数据。
export function buildThreadsFromComments(
  comments: { threadId: string; fileId: string; line: number; side: "original" | "modified"; resolved: boolean; createdAt: string }[],
): import("../types/review").CommentThread[] {
  const threadMap = new Map<string, import("../types/review").CommentThread>();
  for (const comment of comments) {
    if (!threadMap.has(comment.threadId)) {
      threadMap.set(comment.threadId, {
        id: comment.threadId,
        fileId: comment.fileId,
        line: comment.line,
        side: comment.side,
        resolved: comment.resolved,
        createdAt: comment.createdAt,
        updatedAt: comment.createdAt,
      });
    }
  }
  return Array.from(threadMap.values());
}
