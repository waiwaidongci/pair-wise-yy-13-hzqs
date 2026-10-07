import { mockChangeLines, mockDiffFiles } from "../data/mockDiff";
import type {
  DiffFile,
  FileSignoff,
  MergeConflict,
  ReviewBatch,
  ReviewComment,
  SharedReviewDoc,
} from "../types/review";
import { buildAnchor } from "./anchors";
import { computeChangeset } from "./hash";

export const SHARED_DOC_KEY = "diff-scope-shared-v2";
export const LEGACY_KEY = "diff-scope-review-v1";
const LEGACY_BACKUP_KEY = "diff-scope-review-v1.migrated";
export const LEGACY_BATCH_ID = "batch-legacy-0001";
export const SEED_BATCH_ID = "batch-seed-0001";
export const SCHEMA_VERSION = 1;

function nowIso(): string {
  return new Date().toISOString();
}

/** 为首版/迁移数据中的评论补齐批次与锚点 */
export function normalizeComment(comment: Partial<ReviewComment> & { id: string; fileId: string }, files: DiffFile[], changesetRev: string, batchId: string): ReviewComment {
  const file = files.find((item) => item.id === comment.fileId);
  const side = comment.side ?? "modified";
  const line = comment.line ?? 1;
  const anchor =
    comment.anchor && comment.anchor.changesetRev
      ? comment.anchor
      : file
        ? buildAnchor(file, side, line, changesetRev)
        : { side, line, lineText: "", contextBefore: [], contextAfter: [], changesetRev };
  return {
    id: comment.id,
    fileId: comment.fileId,
    line: anchor.line,
    side,
    author: comment.author ?? "历史数据",
    body: comment.body ?? "",
    createdAt: comment.createdAt ?? nowIso(),
    resolved: comment.resolved ?? false,
    replies: comment.replies ?? [],
    batchId: comment.batchId ?? batchId,
    anchor,
    orphaned: comment.orphaned ?? false,
    updatedAt: comment.updatedAt ?? comment.createdAt ?? nowIso(),
  };
}

/** 防御性归一化：老数据缺批次、缺持有人时补成首版结构 */
export function normalizeDoc(raw: Partial<SharedReviewDoc>): SharedReviewDoc {
  const files = raw.files?.length ? raw.files : mockDiffFiles;
  const changeset = raw.changeset?.rev ? raw.changeset : computeChangeset(files);
  const comments = (raw.comments ?? []).map((comment) => normalizeComment(comment, files, changeset.rev, LEGACY_BATCH_ID));
  const signoffs: Record<string, FileSignoff> = {};
  for (const [fileId, signoff] of Object.entries(raw.signoffs ?? {})) {
    if (!signoff) continue;
    signoffs[fileId] = {
      fileId,
      signedBy: signoff.signedBy ?? "历史数据",
      sessionId: signoff.sessionId ?? "legacy",
      batchId: signoff.batchId ?? LEGACY_BATCH_ID,
      changesetRev: signoff.changesetRev ?? changeset.rev,
      signedAt: signoff.signedAt ?? nowIso(),
    };
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    changeset,
    files,
    comments,
    signoffs,
    claims: raw.claims ?? {},
    conflicts: (raw.conflicts ?? []).filter((conflict: MergeConflict) => conflict.status === "open"),
    batches: raw.batches ?? [],
    appliedBatchIds: raw.appliedBatchIds ?? [],
    submission: raw.submission ?? null,
    lamport: raw.lamport ?? 0,
    updatedAt: raw.updatedAt ?? nowIso(),
    updatedBy: raw.updatedBy ?? "system",
  };
}

export class SharedDocParseError extends Error {}

export function loadSharedDoc(): SharedReviewDoc | null {
  const raw = localStorage.getItem(SHARED_DOC_KEY);
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SharedDocParseError("共享文档不是合法 JSON（可能被损坏或手工改过）");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new SharedDocParseError("共享文档结构无效");
  }
  return normalizeDoc(parsed as Partial<SharedReviewDoc>);
}

export function loadSharedDocRaw(): string | null {
  return localStorage.getItem(SHARED_DOC_KEY);
}

export function saveSharedDoc(doc: SharedReviewDoc): void {
  localStorage.setItem(SHARED_DOC_KEY, JSON.stringify(doc));
}

/* ---------------- 首版数据 ---------------- */

const seedComments: Array<Omit<ReviewComment, "batchId" | "anchor" | "orphaned" | "updatedAt">> = [
  {
    id: "comment-payment-cache-version",
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

function seedBatch(summary: string, id: string, author: string): ReviewBatch {
  return {
    id,
    sessionId: "system",
    author,
    createdAt: nowIso(),
    changesetRev: computeChangeset(mockDiffFiles).rev,
    summary,
    ops: [],
  };
}

/** 没有任何历史数据时，用内置种子构造首版共享文档 */
export function createInitialDoc(): SharedReviewDoc {
  const changeset = computeChangeset(mockDiffFiles);
  const comments = seedComments.map((comment) => normalizeComment(comment, mockDiffFiles, changeset.rev, SEED_BATCH_ID));
  const signoffs: Record<string, FileSignoff> = {
    router: {
      fileId: "router",
      signedBy: "林澈",
      sessionId: "seed",
      batchId: SEED_BATCH_ID,
      changesetRev: changeset.rev,
      signedAt: nowIso(),
    },
  };
  return normalizeDoc({
    changeset,
    files: mockDiffFiles,
    comments,
    signoffs,
    batches: [seedBatch("初始审阅数据（4 条评论 · 1 个签收）", SEED_BATCH_ID, "系统")],
    appliedBatchIds: [SEED_BATCH_ID],
  });
}

/**
 * 旧版本地数据（diff-scope-review-v1，没有批次与持有人）迁移成首版共享文档。
 * 迁移成功后旧键改名备份，避免重复迁移。
 */
export function migrateLegacyDoc(): SharedReviewDoc | null {
  const raw = localStorage.getItem(LEGACY_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { state?: Record<string, unknown> } & Record<string, unknown>;
    const state = (parsed.state ?? parsed) as {
      comments?: Array<Partial<ReviewComment> & { id: string; fileId: string }>;
      reviewedFiles?: string[];
    };
    const changeset = computeChangeset(mockDiffFiles);
    const comments = (state.comments ?? []).map((comment) => normalizeComment(comment, mockDiffFiles, changeset.rev, LEGACY_BATCH_ID));
    const signoffs: Record<string, FileSignoff> = {};
    for (const fileId of state.reviewedFiles ?? []) {
      signoffs[fileId] = {
        fileId,
        signedBy: "历史数据",
        sessionId: "legacy",
        batchId: LEGACY_BATCH_ID,
        changesetRev: changeset.rev,
        signedAt: nowIso(),
      };
    }
    const doc = normalizeDoc({
      changeset,
      files: mockDiffFiles,
      comments,
      signoffs,
      batches: [seedBatch(`旧版本地数据迁移（${comments.length} 条评论 · ${Object.keys(signoffs).length} 个签收）`, LEGACY_BATCH_ID, "系统")],
      appliedBatchIds: [LEGACY_BATCH_ID],
    });
    localStorage.setItem(LEGACY_BACKUP_KEY, raw);
    localStorage.removeItem(LEGACY_KEY);
    return doc;
  } catch (error) {
    console.warn("[DiffScope] 旧数据迁移失败，保留原始数据", error);
    return null;
  }
}

/** 载入共享文档：优先现存的，其次迁移旧数据，最后造首版 */
export function loadOrCreateSharedDoc(): SharedReviewDoc {
  const existing = loadSharedDoc();
  if (existing) return existing;
  const migrated = migrateLegacyDoc();
  if (migrated) {
    saveSharedDoc(migrated);
    return migrated;
  }
  const initial = createInitialDoc();
  saveSharedDoc(initial);
  return initial;
}

/** 监听其他标签页对共享文档的写入 */
export function subscribeSharedDoc(onRemoteChange: () => void): () => void {
  const handler = (event: StorageEvent) => {
    if (event.key === SHARED_DOC_KEY) onRemoteChange();
  };
  window.addEventListener("storage", handler);
  return () => window.removeEventListener("storage", handler);
}
