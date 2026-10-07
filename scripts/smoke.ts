/* 冒烟测试：验证合并引擎的关键行为 */
import { mockDiffFiles } from "../src/data/mockDiff";
import { computeChangeset } from "../src/sync/hash";
import { buildAnchor } from "../src/sync/anchors";
import { applyChangesetToDoc, commitOps, CLAIM_TTL_MS } from "../src/sync/merge";
import { applyOpsToView } from "../src/sync/ops";
import { createInitialDoc, normalizeDoc } from "../src/sync/sharedDoc";
import type { BatchOp, ReviewBatch, ReviewComment, SharedReviewDoc } from "../src/types/review";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.error(`  ✗ ${name}`, extra ?? "");
  }
}

const T0 = Date.now();
const AFTER_LEASE = T0 + CLAIM_TTL_MS + 1000;
const EVEN_LATER = AFTER_LEASE + CLAIM_TTL_MS + 1000;

const at = (sessionId: string, author: string, now: number) => ({ sessionId, author, now });
const ctxA = at("tab-A", "甲", T0);
const ctxB = at("tab-B", "乙", T0);

function makeComment(id: string, fileId: string, line: number, author: string, batchId: string): ReviewComment {
  const file = mockDiffFiles.find((f) => f.id === fileId)!;
  return {
    id, fileId, line, side: "modified", author, body: `评论 ${id}`,
    createdAt: new Date(T0).toISOString(), resolved: false, replies: [],
    batchId, anchor: buildAnchor(file, "modified", line, "rev0"), orphaned: false,
    updatedAt: new Date(T0).toISOString(),
  };
}

function batch(id: string, sessionId: string, ops: BatchOp[]): ReviewBatch {
  return { id, sessionId, author: sessionId, createdAt: new Date(T0).toISOString(), changesetRev: "rev0", summary: "test", ops };
}

function signoffOp(opId: string, fileId: string, by: string, sessionId: string, batchId: string): BatchOp {
  return {
    opId, kind: "signoff", fileId, prevRecord: null,
    record: { fileId, signedBy: by, sessionId, batchId, changesetRev: "rev0", signedAt: new Date(T0).toISOString() },
  };
}

console.log("1. 首版文档与旧数据迁移");
{
  const doc = createInitialDoc();
  check("种子评论带批次号", doc.comments.every((c) => c.batchId));
  check("种子评论带锚点", doc.comments.every((c) => c.anchor.changesetRev === doc.changeset.rev));
  check("schemaVersion 为 1", doc.schemaVersion === 1);
  const legacy = normalizeDoc({
    comments: [{ id: "c1", fileId: "router", line: 5 }] as never,
    signoffs: { router: { fileId: "router" } as never },
  });
  check("缺批次的评论迁移到 legacy 批次", legacy.comments[0].batchId === "batch-legacy-0001");
  check("缺持有人的签收补默认值", legacy.signoffs.router.signedBy === "历史数据" && legacy.signoffs.router.batchId === "batch-legacy-0001");
}

console.log("2. 同时提交不同文件：互不干扰直接采用");
{
  const base = createInitialDoc();
  const opA: BatchOp = { opId: "op-a1", kind: "add-comment", comment: makeComment("c-A1", "payment-service", 42, "甲", "batch-A-1") };
  const opB: BatchOp = { opId: "op-b1", kind: "add-comment", comment: makeComment("c-B1", "order-table", 90, "乙", "batch-B-1") };
  const afterA = commitOps(base, [opA], batch("batch-A-1", "tab-A", [opA]), ctxA).doc;
  const outcomeB = commitOps(afterA, [opB], batch("batch-B-1", "tab-B", [opB]), ctxB);
  check("两条评论都在", ["c-A1", "c-B1"].every((id) => outcomeB.doc.comments.some((c) => c.id === id)));
  check("无冲突", outcomeB.newConflicts.length === 0);
  check("两个批次都记录", ["batch-A-1", "batch-B-1"].every((id) => outcomeB.doc.batches.some((b) => b.id === id)));
}

console.log("3. 同文件先后提交（租约超时后）：不同实体干净合并");
{
  const base = createInitialDoc();
  const opA: BatchOp = { opId: "op-a2", kind: "add-comment", comment: makeComment("c-A2", "order-store", 42, "甲", "batch-A-2") };
  const opB: BatchOp = { opId: "op-b2", kind: "add-comment", comment: makeComment("c-B2", "order-store", 90, "乙", "batch-B-2") };
  const afterA = commitOps(base, [opA], batch("batch-A-2", "tab-A", [opA]), ctxA).doc;
  const outcomeB = commitOps(afterA, [opB], batch("batch-B-2", "tab-B", [opB]), at("tab-B", "乙", AFTER_LEASE));
  check("两条评论都在", ["c-A2", "c-B2"].every((id) => outcomeB.doc.comments.some((c) => c.id === id)));
  check("无冲突", outcomeB.newConflicts.length === 0);
}

console.log("4. 两边都签收同一文件：各留一份、挡住完成、裁决后生效");
{
  const base = createInitialDoc();
  const signA = signoffOp("op-a3", "validators", "甲", "tab-A", "batch-A-3");
  const signB = signoffOp("op-b3", "validators", "乙", "tab-B", "batch-B-3");
  const afterA = commitOps(base, [signA], batch("batch-A-3", "tab-A", [signA]), ctxA).doc;
  const outcomeB = commitOps(afterA, [signB], batch("batch-B-3", "tab-B", [signB]), at("tab-B", "乙", AFTER_LEASE));
  check("产生一个签收冲突", outcomeB.newConflicts.length === 1 && outcomeB.newConflicts[0].entity === "signoff");
  const conflict = outcomeB.doc.conflicts[0];
  check("两份都保留", conflict?.incoming.value !== null && conflict?.current?.value !== null);
  check("已生效值保持先到者（甲）", (outcomeB.doc.signoffs.validators as { signedBy: string }).signedBy === "甲");

  const adj: BatchOp = { opId: "op-b3a", kind: "adjudicate", conflictId: conflict.id, fileId: "validators", choice: "incoming" };
  const afterAdj = commitOps(outcomeB.doc, [adj], batch("batch-B-3a", "tab-B", [adj]), at("tab-B", "乙", EVEN_LATER)).doc;
  check("裁决后冲突清除", afterAdj.conflicts.filter((c) => c.status === "open").length === 0);
  check("裁决后采用乙的签收", (afterAdj.signoffs.validators as { signedBy: string }).signedBy === "乙");
}

console.log("5. 认领租约：先到者领走，超时后别人接手");
{
  const base = createInitialDoc();
  const opA: BatchOp = { opId: "op-a4", kind: "add-comment", comment: makeComment("c-A4", "order-store", 10, "甲", "batch-A-4") };
  const afterA = commitOps(base, [opA], batch("batch-A-4", "tab-A", [opA]), ctxA).doc;
  check("A 提交后持有租约", afterA.claims["order-store"]?.holderId === "tab-A");

  const opB: BatchOp = { opId: "op-b4", kind: "add-comment", comment: makeComment("c-B4", "order-store", 20, "乙", "batch-B-4") };
  const denied = commitOps(afterA, [opB], batch("batch-B-4", "tab-B", [opB]), ctxB);
  check("B 被租约挡住，操作暂缓", denied.deferredOps.length === 1 && denied.appliedOps.length === 0);
  check("暂缓原因指向持有人", denied.deniedFiles[0]?.holderName === "甲");
  check("被挡的评论未入库", !denied.doc.comments.some((c) => c.id === "c-B4"));

  const afterExpiry = commitOps(denied.doc, denied.deferredOps, batch("batch-B-4", "tab-B", denied.deferredOps), at("tab-B", "乙", AFTER_LEASE));
  check("租约超时后 B 接手成功", afterExpiry.appliedOps.length === 1 && afterExpiry.doc.comments.some((c) => c.id === "c-B4"));
}

console.log("6. 幂等重试：同一批次重复提交不重复追加");
{
  const base = createInitialDoc();
  const op: BatchOp = { opId: "op-a5", kind: "add-comment", comment: makeComment("c-A5", "readme", 3, "甲", "batch-A-5") };
  const theBatch = batch("batch-A-5", "tab-A", [op]);
  const first = commitOps(base, [op], theBatch, ctxA).doc;
  const retry = commitOps(first, [op], theBatch, ctxA);
  check("识别为已应用批次", retry.alreadyApplied);
  check("评论只有一条", retry.doc.comments.filter((c) => c.id === "c-A5").length === 1);
  check("批次只记录一次", retry.doc.batches.filter((b) => b.id === "batch-A-5").length === 1);
  check("appliedBatchIds 不重复", retry.doc.appliedBatchIds.filter((id) => id === "batch-A-5").length === 1);
}

console.log("7. 变更集更新：相关签收失效、评论重算，其他文件照旧");
{
  const base = createInitialDoc();
  const before = base.comments.find((c) => c.id === "comment-payment-cache-version")!;
  const mutated = mockDiffFiles.map((f) =>
    f.id === "payment-service"
      ? { ...f, newContent: ["// 新增三行", "const a = 1;", "const b = 2;", ...f.newContent.split("\n")].join("\n") }
      : f,
  );
  const next = computeChangeset(mutated);
  const withSignoff: SharedReviewDoc = {
    ...base,
    signoffs: {
      ...base.signoffs,
      "payment-service": { fileId: "payment-service", signedBy: "甲", sessionId: "tab-A", batchId: "b", changesetRev: base.changeset.rev, signedAt: new Date(T0).toISOString() },
    },
  };
  const updated = applyChangesetToDoc(withSignoff, mutated, next);
  check("改动文件的签收失效", !updated.signoffs["payment-service"]);
  check("未改动文件的签收保留", !!updated.signoffs["router"]);
  const moved = updated.comments.find((c) => c.id === "comment-payment-cache-version")!;
  check("评论行号跟随内容下移 3 行", moved.line === before.line + 3, `got ${moved.line}, want ${before.line + 3}`);
  check("锚点版本更新", moved.anchor.changesetRev === next.rev);
  check("其他文件评论不动", updated.comments.find((c) => c.fileId === "validators")!.line === base.comments.find((c) => c.fileId === "validators")!.line);
  const again = applyChangesetToDoc(updated, mutated, next);
  check("相同 rev 重复应用是幂等的", again === updated);
}

console.log("8. 删除 vs 回复冲突：各留一份");
{
  const base = createInitialDoc();
  const target = base.comments.find((c) => c.id === "comment-order-table-selection")!;
  const opReply: BatchOp = { opId: "op-a8", kind: "add-reply", commentId: target.id, fileId: target.fileId, reply: { id: "r1", author: "甲", body: "补充", createdAt: new Date(T0).toISOString() } };
  const afterA = commitOps(base, [opReply], batch("batch-A-8", "tab-A", [opReply]), ctxA).doc;
  const opDel: BatchOp = { opId: "op-b8", kind: "delete-comment", commentId: target.id, fileId: target.fileId, baseComment: target };
  const outcomeB = commitOps(afterA, [opDel], batch("batch-B-8", "tab-B", [opDel]), at("tab-B", "乙", AFTER_LEASE));
  check("删除 vs 编辑产生冲突", outcomeB.newConflicts.length === 1 && outcomeB.newConflicts[0].field === "_deleted");
  check("评论本体保留（各留一份）", outcomeB.doc.comments.some((c) => c.id === target.id));
}

console.log("9. 解决状态 vs 评论被删 冲突");
{
  const base = createInitialDoc();
  const target = base.comments.find((c) => c.id === "comment-validator-phone")!;
  const opDel: BatchOp = { opId: "op-a9", kind: "delete-comment", commentId: target.id, fileId: target.fileId, baseComment: target };
  const afterA = commitOps(base, [opDel], batch("batch-A-9", "tab-A", [opDel]), ctxA).doc;
  check("A 删除成功", !afterA.comments.some((c) => c.id === target.id));
  const opResolve: BatchOp = { opId: "op-b9", kind: "resolve-comment", commentId: target.id, fileId: target.fileId, resolved: true, prevResolved: false };
  const outcomeB = commitOps(afterA, [opResolve], batch("batch-B-9", "tab-B", [opResolve]), at("tab-B", "乙", AFTER_LEASE));
  check("解决 vs 删除产生冲突", outcomeB.newConflicts.length === 1 && outcomeB.newConflicts[0].field === "resolved");
}

console.log("10. 视图推导：待提交操作乐观生效");
{
  const base = createInitialDoc();
  const op: BatchOp = { opId: "op-a10", kind: "add-comment", comment: makeComment("c-A10", "router", 7, "甲", "batch-A-10") };
  const view = applyOpsToView(base, [op]);
  check("视图含未提交评论", view.comments.some((c) => c.id === "c-A10"));
  check("共享文档本体未被污染", !base.comments.some((c) => c.id === "c-A10"));
  const viewTwice = applyOpsToView(base, [op, op]);
  check("重复应用同一操作不重复追加", viewTwice.comments.filter((c) => c.id === "c-A10").length === 1);
}

console.log(failures ? `\n共 ${failures} 项失败` : "\n全部通过");
process.exit(failures ? 1 : 0);
