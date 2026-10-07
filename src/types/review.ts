export type DiffViewMode = "side-by-side" | "inline";
export type DiffFileStatus = "modified" | "added" | "deleted" | "renamed";
export type CommentSide = "original" | "modified";

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

/**
 * 评论定位锚点：记录锚定时的行内容与上下文，
 * 变更集改动后按内容重新计算行号，找不到则标记 orphaned。
 */
export interface CommentAnchor {
  side: CommentSide;
  line: number;
  lineText: string;
  contextBefore: string[];
  contextAfter: string[];
  changesetRev: string;
}

export interface ReviewComment {
  id: string;
  fileId: string;
  line: number;
  side: CommentSide;
  author: string;
  body: string;
  createdAt: string;
  resolved: boolean;
  replies: CommentReply[];
  /** 引入该评论的审阅批次 */
  batchId: string;
  /** 定位锚点，变更集改动后据此重算 */
  anchor: CommentAnchor;
  /** 重算后仍找不到位置时为 true（定位失效） */
  orphaned: boolean;
  updatedAt: string;
}

export interface CommentDraft {
  fileId: string;
  line: number;
  side: CommentSide;
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

/* ---------------- 审阅批次 / 签收 / 认领 / 冲突 ---------------- */

/** 文件签收记录：某个批次在某变更集版本上签收了一个文件 */
export interface FileSignoff {
  fileId: string;
  signedBy: string;
  sessionId: string;
  batchId: string;
  changesetRev: string;
  signedAt: string;
}

/** 文件认领租约：先到者领走，超时或交回后别人才能接手 */
export interface FileClaim {
  fileId: string;
  holderId: string;
  holderName: string;
  batchId: string | null;
  acquiredAt: string;
  expiresAt: string;
  releasedAt: string | null;
}

/** 变更集版本：整体 rev + 每个文件的内容哈希 */
export interface ChangesetRevision {
  rev: string;
  fileHashes: Record<string, string>;
  computedAt: string;
}

export type BatchOp =
  | { opId: string; kind: "add-comment"; comment: ReviewComment }
  | { opId: string; kind: "delete-comment"; commentId: string; fileId: string; baseComment: ReviewComment | null }
  | { opId: string; kind: "add-reply"; commentId: string; fileId: string; reply: CommentReply }
  | { opId: string; kind: "resolve-comment"; commentId: string; fileId: string; resolved: boolean; prevResolved: boolean }
  | { opId: string; kind: "signoff"; fileId: string; record: FileSignoff | null; prevRecord: FileSignoff | null }
  | { opId: string; kind: "adjudicate"; conflictId: string; fileId: string; choice: "incoming" | "current" }
  | { opId: string; kind: "changeset"; files: DiffFile[]; changeset: ChangesetRevision };

export type BatchOpKind = BatchOp["kind"];

/** 审阅批次：一次提交里落库的操作集合，串起评论线程与文件签收 */
export interface ReviewBatch {
  id: string;
  sessionId: string;
  author: string;
  createdAt: string;
  changesetRev: string;
  summary: string;
  ops: BatchOp[];
}

/** 合并冲突：两边都改过同一实体时各留一份，裁决前挡住文件完成 */
export interface MergeConflict {
  id: string;
  fileId: string;
  entity: "comment" | "signoff";
  entityId: string;
  field: string;
  /** 共同祖先处的值 */
  baseValue: unknown;
  /** 本地（提交方）想写入的值与原始操作 */
  incoming: {
    value: unknown;
    op: BatchOp;
    batchId: string;
    author: string;
    sessionId: string;
    at: string;
  };
  /** 共享文档里已生效的值 */
  current: {
    value: unknown;
    author: string;
    batchId: string;
    at: string;
  } | null;
  detectedAt: string;
  status: "open" | "resolved";
  resolution?: "incoming" | "current";
  resolvedAt?: string;
  resolvedBy?: string;
}

/** 跨标签页共享的审阅文档（localStorage 中的唯一事实源） */
export interface SharedReviewDoc {
  schemaVersion: number;
  changeset: ChangesetRevision;
  files: DiffFile[];
  comments: ReviewComment[];
  signoffs: Record<string, FileSignoff>;
  claims: Record<string, FileClaim>;
  conflicts: MergeConflict[];
  batches: ReviewBatch[];
  appliedBatchIds: string[];
  submission: { submittedBy: string; submittedAt: string } | null;
  lamport: number;
  updatedAt: string;
  updatedBy: string;
}

export type SyncStatus = "synced" | "pending" | "syncing" | "claim-waiting" | "error";

export interface MergeFailure {
  at: string;
  reason: string;
  batchId: string;
  /** 失败时读到的远端原文，保留现场便于排查 */
  remoteRaw: string | null;
}

export interface ClaimDeniedInfo {
  fileId: string;
  holderName: string;
  expiresAt: string;
}
