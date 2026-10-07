export type DiffViewMode = "side-by-side" | "inline";
export type DiffFileStatus = "modified" | "added" | "deleted" | "renamed";
export type CommentSide = "original" | "modified";

export type BatchStatus = "active" | "handed_back" | "expired" | "submitted";
export type SignoffStatus = "pending" | "claimed" | "signed" | "conflict";
export type MergeStatus = "idle" | "merging" | "failed" | "succeeded";
export type AdjudicationChoice = "local" | "remote" | "base";

export interface DiffFile {
  id: string;
  path: string;
  oldPath?: string;
  language: string;
  status: DiffFileStatus;
  oldContent: string;
  newContent: string;
  additions: number;
  deletions: number;
  description: string;
}

export interface CommentReply {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface ReviewSummary {
  pullRequest: string;
  title: string;
  author: string;
  branch: string;
  baseBranch: string;
  reviewers: string[];
  updatedAt: string;
}

export interface ReviewComment {
  id: string;
  threadId: string;
  fileId: string;
  line: number;
  side: CommentSide;
  author: string;
  body: string;
  createdAt: string;
  resolved: boolean;
  replies: CommentReply[];
}

export interface CommentDraft {
  fileId: string;
  line: number;
  side: CommentSide;
}

// === 审阅批次 (review batch) ===
// 一个批次代表一位审查员的一段审阅工作，关联持有人与超时。
export interface ReviewBatch {
  id: string;
  holder: string;
  startedAt: string;
  expiresAt: string;
  status: BatchStatus;
}

// === 评论线程 (comment thread) ===
// 同一位置（fileId + line + side）的评论归为一个线程，拥有稳定 id 供合并匹配。
export interface CommentThread {
  id: string;
  fileId: string;
  line: number;
  side: CommentSide;
  resolved: boolean;
  createdAt: string;
  updatedAt: string;
}

// === 文件进度 (file progress) ===
// 合并的最小单元：单个文件的签收状态 + 评论。
export interface FileProgress {
  fileId: string;
  reviewed: boolean;
  signoffStatus: SignoffStatus;
  holder: string | null;
  batchId: string | null;
  claimedAt: string | null;
  signedAt: string | null;
  comments: ReviewComment[];
}

// === 文件冲突 (file conflict) ===
// 两边都改过同一文件时，各留一份，挡住文件完成，等裁决。
export interface FileConflict {
  fileId: string;
  local: FileProgress;
  remote: FileProgress;
  base: FileProgress;
  detectedAt: string;
}

// === 审阅快照 (review snapshot) ===
// 跨标签页同步与合并的完整状态。
export interface ReviewSnapshot {
  version: number;
  changesetVersion: number;
  batches: ReviewBatch[];
  threads: CommentThread[];
  progress: Record<string, FileProgress>;
  updatedAt: string;
  updatedBy: string;
}
