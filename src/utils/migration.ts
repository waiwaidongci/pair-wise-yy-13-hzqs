import type { ReviewComment, ReviewSnapshot } from "../types/review";
import { BATCH_TTL_MS, buildThreadsFromComments, emptyProgress } from "./batch";

const STORAGE_KEY = "diff-scope-review-v1";
const SNAPSHOT_KEY = "diff-scope-snapshot-v1";

// 旧版本持久化数据的最小结构（缺少批次和持有人）。
interface LegacyPersistedState {
  files?: { id: string }[];
  selectedFileId?: string;
  viewMode?: string;
  hideUnchanged?: boolean;
  reviewedFiles?: string[];
  comments?: ReviewComment[];
}

function readLegacyState(): LegacyPersistedState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.state ?? null;
  } catch {
    return null;
  }
}

function readExistingSnapshot(): ReviewSnapshot | null {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as ReviewSnapshot;
  } catch {
    return null;
  }
}

// 把旧版本数据迁移成首版快照：补批次、持有人、线程 id。
export function migrateToSnapshot(legacy: LegacyPersistedState): ReviewSnapshot {
  const now = new Date().toISOString();
  const holder = "林澈";

  // 给缺少 threadId 的评论补稳定线程 id
  const comments: ReviewComment[] = (legacy.comments ?? []).map((comment, index) => ({
    ...comment,
    threadId: comment.threadId ?? `thread-${comment.fileId}-${comment.side}-${comment.line}-${index}`,
  }));

  const threads = buildThreadsFromComments(comments);

  const fileIds = new Set<string>([
    ...(legacy.files ?? []).map((file) => file.id),
    ...comments.map((comment) => comment.fileId),
  ]);

  const progress: Record<string, import("../types/review").FileProgress> = {};
  for (const fileId of fileIds) {
    const fileComments = comments.filter((comment) => comment.fileId === fileId);
    const reviewed = (legacy.reviewedFiles ?? []).includes(fileId);
    progress[fileId] = {
      ...emptyProgress(fileId),
      reviewed,
      signoffStatus: reviewed ? "signed" : "pending",
      holder: reviewed ? holder : null,
      batchId: null,
      signedAt: reviewed ? now : null,
      comments: fileComments,
    };
  }

  const batch: import("../types/review").ReviewBatch = {
    id: `batch-migrated-${Date.now()}`,
    holder,
    startedAt: now,
    expiresAt: new Date(Date.now() + BATCH_TTL_MS).toISOString(),
    status: "active",
  };

  return {
    version: 1,
    changesetVersion: 1,
    batches: [batch],
    threads,
    progress,
    updatedAt: now,
    updatedBy: holder,
  };
}

// 加载快照：若已有快照直接返回；否则迁移旧数据。
export function loadSnapshot(): { snapshot: ReviewSnapshot; migrated: boolean } {
  const existing = readExistingSnapshot();
  if (existing) return { snapshot: existing, migrated: false };

  const legacy = readLegacyState();
  if (legacy) {
    const snapshot = migrateToSnapshot(legacy);
    try {
      localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot));
    } catch {
      // 持久化失败不阻塞迁移
    }
    return { snapshot, migrated: true };
  }

  return { snapshot: createEmptySnapshot(), migrated: false };
}

export function createEmptySnapshot(): ReviewSnapshot {
  const now = new Date().toISOString();
  return {
    version: 1,
    changesetVersion: 1,
    batches: [],
    threads: [],
    progress: {},
    updatedAt: now,
    updatedBy: "林澈",
  };
}

export function saveSnapshot(snapshot: ReviewSnapshot): void {
  try {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot));
  } catch {
    // 存储失败时保留现场，由调用方标记合并失败
  }
}
