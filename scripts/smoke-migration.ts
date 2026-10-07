/* 迁移链路验证：旧版 localStorage 数据 → 首版共享文档 */
// 先装好 localStorage/sessionStorage mock，再动态导入被测模块
const store = new Map();
const storage = () => ({
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => void store.set(k, String(v)),
  removeItem: (k) => void store.delete(k),
  key: (i) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
});
globalThis.localStorage = storage();
globalThis.sessionStorage = storage();

const { loadOrCreateSharedDoc, SHARED_DOC_KEY, LEGACY_KEY } = await import("../src/sync/sharedDoc.ts");

let failures = 0;
const check = (name, cond, extra) => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures += 1; console.error(`  ✗ ${name}`, extra ?? ""); }
};

console.log("A. 无任何数据 → 生成首版种子文档");
{
  const doc = loadOrCreateSharedDoc();
  check("schemaVersion 为 1", doc.schemaVersion === 1);
  check("种子评论带批次与锚点", doc.comments.length === 4 && doc.comments.every((c) => c.batchId && c.anchor.lineText !== undefined));
  check("种子签收存在", !!doc.signoffs.router);
  check("已写入共享键", !!store.get(SHARED_DOC_KEY));
}

console.log("B. 旧版数据（无批次/持有人）→ 迁移成首版");
{
  store.clear();
  const legacy = {
    state: {
      selectedFileId: "router",
      viewMode: "inline",
      hideUnchanged: false,
      reviewedFiles: ["router", "validators"],
      comments: [
        { id: "old-1", fileId: "payment-service", line: 42, side: "modified", author: "林澈", body: "旧评论", createdAt: new Date().toISOString(), resolved: false, replies: [] },
      ],
    },
    version: 0,
  };
  store.set(LEGACY_KEY, JSON.stringify(legacy));
  const doc = loadOrCreateSharedDoc();
  check("旧评论保留并补上批次", doc.comments.some((c) => c.id === "old-1" && c.batchId === "batch-legacy-0001"));
  check("旧评论锚点已按当前变更集构建", doc.comments.find((c) => c.id === "old-1").anchor.changesetRev === doc.changeset.rev);
  check("已查看状态转成签收且补持有人", !!doc.signoffs.router && !!doc.signoffs.validators && doc.signoffs.router.signedBy === "历史数据");
  check("迁移批次入审计日志", doc.batches.some((b) => b.id === "batch-legacy-0001"));
  check("旧键已移除并备份", !store.get(LEGACY_KEY) && !!store.get("diff-scope-review-v1.migrated"));
}

console.log("C. 已有共享文档 → 直接加载不迁移");
{
  const before = store.get(SHARED_DOC_KEY);
  const doc = loadOrCreateSharedDoc();
  check("文档未被重置", store.get(SHARED_DOC_KEY) === before && doc.comments.some((c) => c.id === "old-1"));
}

console.log(failures ? `\n共 ${failures} 项失败` : "\n迁移链路全部通过");
process.exit(failures ? 1 : 0);
