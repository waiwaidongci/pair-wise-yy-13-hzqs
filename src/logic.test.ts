import { mergeProgress, mergeSnapshots, adjudicateConflict, progressEquals } from "./utils/merge";
import {
  claimFile,
  signFile,
  handbackFile,
  takeoverFile,
  isClaimable,
  isClaimExpired,
  isSigned,
  isConflicted,
  emptyProgress,
  createBatch,
  isBatchExpired,
  buildThreadsFromComments,
} from "./utils/batch";
import { migrateToSnapshot } from "./utils/migration";
import { handleChangesetChange, recalculateCommentPositions } from "./utils/changeset";
import type { FileProgress, ReviewSnapshot, DiffFile, ReviewComment } from "./types/review";

declare const process: { exit: (code: number) => void };

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${message}`);
  }
}

function makeProgress(fileId: string, overrides: Partial<FileProgress> = {}): FileProgress {
  return { ...emptyProgress(fileId), ...overrides };
}

function makeSnapshot(progress: Record<string, FileProgress>): ReviewSnapshot {
  const now = new Date().toISOString();
  return {
    version: 1,
    changesetVersion: 1,
    batches: [],
    threads: [],
    progress,
    updatedAt: now,
    updatedBy: "test",
  };
}

// === 1. 三路合并：只有一边动过直接采用 ===
{
  const base = makeProgress("f1", { reviewed: false });
  const local = makeProgress("f1", { reviewed: true, signoffStatus: "signed" });
  const remote = makeProgress("f1", { reviewed: false });
  const result = mergeProgress(base, local, remote);
  assert(result.conflict === false, "only local changed -> no conflict");
  assert(result.value?.reviewed === true, "only local changed -> adopt local");
}

{
  const base = makeProgress("f1", { reviewed: false });
  const local = makeProgress("f1", { reviewed: false });
  const remote = makeProgress("f1", { reviewed: true, signoffStatus: "signed" });
  const result = mergeProgress(base, local, remote);
  assert(result.conflict === false, "only remote changed -> no conflict");
  assert(result.value?.reviewed === true, "only remote changed -> adopt remote");
}

// === 2. 两边都改过 -> 冲突，各留一份 ===
{
  const base = makeProgress("f1", { reviewed: false });
  const local = makeProgress("f1", { reviewed: true, signoffStatus: "signed", holder: "A" });
  const remote = makeProgress("f1", { reviewed: true, signoffStatus: "signed", holder: "B" });
  const result = mergeProgress(base, local, remote);
  assert(result.conflict === true, "both changed -> conflict");
  assert(result.value?.reviewed === false, "conflict keeps base (blocks completion)");
}

// === 3. 都没动 -> 保留 base ===
{
  const base = makeProgress("f1", { reviewed: true, signoffStatus: "signed" });
  const result = mergeProgress(base, base, base);
  assert(result.conflict === false, "no change -> no conflict");
  assert(result.value?.reviewed === true, "no change -> keep base");
}

// === 4. 冲突裁决 ===
{
  const base = makeProgress("f1", { reviewed: false });
  const local = makeProgress("f1", { reviewed: true, holder: "A" });
  const remote = makeProgress("f1", { reviewed: true, holder: "B" });
  const { conflicts } = mergeSnapshots(makeSnapshot({ f1: base }), makeSnapshot({ f1: local }), makeSnapshot({ f1: remote }));
  assert(Object.keys(conflicts).length === 1, "mergeSnapshots detects conflict");
  const resolvedLocal = adjudicateConflict(conflicts["f1"], "local");
  assert(resolvedLocal.holder === "A", "adjudicate local");
  const resolvedRemote = adjudicateConflict(conflicts["f1"], "remote");
  assert(resolvedRemote.holder === "B", "adjudicate remote");
}

// === 5. 签收认领：先到者领走 ===
{
  const p = makeProgress("f1");
  assert(isClaimable(p), "pending file is claimable");
  const claimed = claimFile(p, "A", "batch-1");
  assert(claimed.signoffStatus === "claimed", "claim sets status");
  assert(claimed.holder === "A", "claim sets holder");
  assert(!isClaimable(claimed), "claimed file not claimable by others");
}

// === 6. 签收 ===
{
  const p = claimFile(makeProgress("f1"), "A", "batch-1");
  const signed = signFile(p);
  assert(isSigned(signed), "sign sets signed");
  assert(signed.reviewed === true, "sign marks reviewed");
}

// === 7. 交回后他人可接手 ===
{
  const p = claimFile(makeProgress("f1"), "A", "batch-1");
  const handedBack = handbackFile(p);
  assert(handedBack.signoffStatus === "pending", "handback returns to pending");
  assert(handedBack.holder === null, "handback clears holder");
  assert(isClaimable(handedBack), "handback file is claimable");
  const takenOver = takeoverFile(handedBack, "B", "batch-2");
  assert(takenOver.holder === "B", "takeover sets new holder");
}

// === 8. 超时后他人可接手 ===
{
  const p = claimFile(makeProgress("f1"), "A", "batch-1", Date.now() - 5 * 60 * 1000);
  assert(isClaimExpired(p), "old claim is expired");
  assert(isClaimable(p), "expired claim is claimable");
}

// === 9. 合并幂等：重试不重复追加线程 ===
{
  const comment: ReviewComment = {
    id: "c1",
    threadId: "t1",
    fileId: "f1",
    line: 1,
    side: "modified",
    author: "A",
    body: "hello",
    createdAt: new Date().toISOString(),
    resolved: false,
    replies: [],
  };
  const base = makeSnapshot({ f1: makeProgress("f1") });
  const local = makeSnapshot({ f1: makeProgress("f1") });
  const remote = makeSnapshot({ f1: makeProgress("f1", { comments: [comment] }) });
  remote.threads = [{ id: "t1", fileId: "f1", line: 1, side: "modified", resolved: false, createdAt: comment.createdAt, updatedAt: comment.createdAt }];

  const { merged: merged1 } = mergeSnapshots(base, local, remote);
  // 幂等：第一次合并后，base 更新为 merged1；再次合并相同远端不应重复
  const { merged: merged2 } = mergeSnapshots(merged1, merged1, remote);
  assert(merged2.threads.length === 1, "idempotent merge: no duplicate threads");
  assert(merged2.progress["f1"].comments.length === 1, "idempotent merge: no duplicate comments");
}

// === 10. 迁移旧数据 ===
{
  const legacy = {
    files: [{ id: "f1" }],
    reviewedFiles: ["f1"],
    comments: [
      {
        id: "c1",
        threadId: "t1",
        fileId: "f1",
        line: 1,
        side: "modified" as const,
        author: "A",
        body: "old comment",
        createdAt: new Date().toISOString(),
        resolved: false,
        replies: [],
      },
    ],
  };
  const snapshot = migrateToSnapshot(legacy);
  assert(snapshot.batches.length === 1, "migration creates a batch");
  assert(snapshot.batches[0].holder === "林澈", "migration sets holder");
  assert(snapshot.progress["f1"].signoffStatus === "signed", "migration signs reviewed file");
  assert(snapshot.progress["f1"].comments[0].threadId !== undefined, "migration assigns threadId");
  assert(snapshot.threads.length === 1, "migration builds threads");
}

// === 11. 变更集变化：签收失效 ===
{
  const oldFile: DiffFile = {
    id: "f1",
    path: "a.ts",
    language: "typescript",
    status: "modified",
    oldContent: "line1\nline2\nline3",
    newContent: "line1\nchanged\nline3",
    additions: 1,
    deletions: 1,
    description: "",
  };
  const newFile: DiffFile = {
    ...oldFile,
    newContent: "line1\nchanged more\nline3",
  };
  const progress: Record<string, FileProgress> = {
    f1: makeProgress("f1", { reviewed: true, signoffStatus: "signed", holder: "A", comments: [] }),
  };
  const { progress: newProgress } = handleChangesetChange([oldFile], [newFile], progress);
  assert(newProgress["f1"].signoffStatus === "pending", "changeset change invalidates signoff");
  assert(newProgress["f1"].reviewed === false, "changeset change marks unreviewed");
}

// === 12. 变更集变化：评论定位重算 ===
{
  const oldFile: DiffFile = {
    id: "f1",
    path: "a.ts",
    language: "typescript",
    status: "modified",
    oldContent: "alpha\nbeta\ngamma",
    newContent: "alpha\nbeta\ngamma",
    additions: 0,
    deletions: 0,
    description: "",
  };
  const newFile: DiffFile = {
    ...oldFile,
    newContent: "alpha\nbeta inserted\nbeta\ngamma",
  };
  const comment: ReviewComment = {
    id: "c1",
    threadId: "t1",
    fileId: "f1",
    line: 2,
    side: "modified",
    author: "A",
    body: "on beta",
    createdAt: new Date().toISOString(),
    resolved: false,
    replies: [],
  };
  const { comments: recalculated, orphaned } = recalculateCommentPositions([comment], oldFile, newFile);
  assert(recalculated[0].line === 3, "comment position recalculated (shifted)");
  assert(orphaned.length === 0, "no orphaned comments");
}

// === 13. 变更集变化：定位失效 ===
{
  const oldFile: DiffFile = {
    id: "f1",
    path: "a.ts",
    language: "typescript",
    status: "modified",
    oldContent: "alpha\nbeta\ngamma",
    newContent: "alpha\nbeta\ngamma",
    additions: 0,
    deletions: 0,
    description: "",
  };
  const newFile: DiffFile = {
    ...oldFile,
    newContent: "alpha\ncompletely different\ngamma",
  };
  const comment: ReviewComment = {
    id: "c1",
    threadId: "t1",
    fileId: "f1",
    line: 2,
    side: "modified",
    author: "A",
    body: "on beta",
    createdAt: new Date().toISOString(),
    resolved: false,
    replies: [],
  };
  const { orphaned } = recalculateCommentPositions([comment], oldFile, newFile);
  assert(orphaned.length === 1, "comment position invalidated (orphaned)");
}

// === 14. 冲突文件挡住完成 ===
{
  const p = makeProgress("f1", { signoffStatus: "conflict" });
  assert(isConflicted(p), "conflict detected");
  // signFile should not work on conflicted file
  const signed = signFile(p);
  assert(signed.signoffStatus === "conflict", "cannot sign conflicted file");
}

// === 15. 批次过期 ===
{
  const batch = createBatch("A", Date.now() - 10 * 60 * 1000);
  assert(isBatchExpired(batch), "old batch is expired");
  const fresh = createBatch("A");
  assert(!isBatchExpired(fresh), "fresh batch not expired");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
