import type { ChangesetRevision, DiffFile } from "../types/review";

/** FNV-1a 32 位哈希，输出 8 位十六进制，足够做内容指纹 */
export function hashString(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function hashFile(file: DiffFile): string {
  return hashString(`${file.id}\n${file.path}\n${file.oldPath ?? ""}\n${file.oldContent}\n${file.newContent}`);
}

export function computeChangeset(files: DiffFile[]): ChangesetRevision {
  const fileHashes: Record<string, string> = {};
  for (const file of files) fileHashes[file.id] = hashFile(file);
  const revSource = files
    .map((file) => `${file.id}:${fileHashes[file.id]}`)
    .sort()
    .join("|");
  return {
    rev: hashString(revSource),
    fileHashes,
    computedAt: new Date().toISOString(),
  };
}

/** 返回内容哈希发生变化的文件 id */
export function changedFileIds(previous: ChangesetRevision, next: ChangesetRevision): string[] {
  const ids = new Set([...Object.keys(previous.fileHashes), ...Object.keys(next.fileHashes)]);
  return [...ids].filter((id) => previous.fileHashes[id] !== next.fileHashes[id]);
}
