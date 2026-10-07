const SESSION_KEY = "diff-scope-session-id";
const REVIEWER_KEY = "diff-scope-reviewer";

const REVIEWER_POOL = ["林澈", "赵明", "周岚"];

function randomId(prefix: string): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj?.randomUUID) return `${prefix}-${cryptoObj.randomUUID().slice(0, 8)}`;
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 每个标签页一个会话 id（sessionStorage 天然按标签页隔离） */
export function getSessionId(): string {
  let id = sessionStorage.getItem(SESSION_KEY);
  if (!id) {
    id = randomId("tab");
    sessionStorage.setItem(SESSION_KEY, id);
  }
  return id;
}

/**
 * 每个标签页分配一个审查员身份。优先沿用 sessionStorage 中已有身份，
 * 否则从候选池里挑一个当前未被其他标签页占用的名字。
 */
export function getReviewerName(): string {
  const existing = sessionStorage.getItem(REVIEWER_KEY);
  if (existing) return existing;
  const taken = new Set<string>();
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key?.startsWith("diff-scope-taken:")) {
      const value = localStorage.getItem(key);
      if (value && Date.now() - Number(value) < 30_000) taken.add(key.slice("diff-scope-taken:".length));
    }
  }
  const name = REVIEWER_POOL.find((candidate) => !taken.has(candidate)) ?? REVIEWER_POOL[Math.floor(Math.random() * REVIEWER_POOL.length)];
  sessionStorage.setItem(REVIEWER_KEY, name);
  return name;
}

/** 心跳式占用上报，让其他标签页错开审查员身份 */
export function announceReviewerPresence(name: string): void {
  localStorage.setItem(`diff-scope-taken:${name}`, String(Date.now()));
}
