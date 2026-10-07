import type { CommentAnchor, CommentSide, DiffFile, ReviewComment } from "../types/review";

const CONTEXT_RADIUS = 2;
const SEARCH_WINDOW = 60;

function linesOf(file: DiffFile, side: CommentSide): string[] {
  return (side === "original" ? file.oldContent : file.newContent).split("\n");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 在指定行号处构建锚点：记录行文本与前后各两行上下文 */
export function buildAnchor(file: DiffFile, side: CommentSide, line: number, changesetRev: string): CommentAnchor {
  const lines = linesOf(file, side);
  const safeLine = clamp(line, 1, Math.max(1, lines.length));
  const index = safeLine - 1;
  return {
    side,
    line: safeLine,
    lineText: lines[index] ?? "",
    contextBefore: lines.slice(Math.max(0, index - CONTEXT_RADIUS), index),
    contextAfter: lines.slice(index + 1, index + 1 + CONTEXT_RADIUS),
    changesetRev,
  };
}

function contextScore(lines: string[], index: number, anchor: CommentAnchor): number {
  let score = 0;
  for (let offset = 1; offset <= anchor.contextBefore.length; offset += 1) {
    if (lines[index - offset] === anchor.contextBefore[anchor.contextBefore.length - offset]) score += 1;
  }
  for (let offset = 0; offset < anchor.contextAfter.length; offset += 1) {
    if (lines[index + 1 + offset] === anchor.contextAfter[offset]) score += 1;
  }
  return score;
}

/**
 * 变更集改动后重算评论定位：
 * 在旧行号附近按行文本 + 上下文匹配寻找新位置；
 * 找不到则标记 orphaned（定位失效），保留原行号仅供展示。
 */
export function reanchorComment(comment: ReviewComment, file: DiffFile, changesetRev: string): ReviewComment {
  if (comment.orphaned) return { ...comment, anchor: { ...comment.anchor, changesetRev } };
  const anchor = comment.anchor;
  const lines = linesOf(file, anchor.side);
  if (!lines.length) return { ...comment, orphaned: true, anchor: { ...anchor, changesetRev } };

  const oldIndex = clamp(anchor.line, 1, lines.length) - 1;
  let bestIndex = -1;
  let bestScore = -1;
  const from = Math.max(0, oldIndex - SEARCH_WINDOW);
  const to = Math.min(lines.length - 1, oldIndex + SEARCH_WINDOW);
  for (let index = from; index <= to; index += 1) {
    if (lines[index] !== anchor.lineText) continue;
    const score = contextScore(lines, index, anchor) * 10 - Math.abs(index - oldIndex);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }

  if (bestIndex === -1) {
    return { ...comment, orphaned: true, anchor: { ...anchor, changesetRev } };
  }

  const nextLine = bestIndex + 1;
  return {
    ...comment,
    line: nextLine,
    orphaned: false,
    anchor: buildAnchor(file, anchor.side, nextLine, changesetRev),
  };
}
