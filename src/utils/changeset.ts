import type { DiffFile, FileProgress, ReviewComment } from "../types/review";
import { emptyProgress } from "./batch";

// 当变更集内容变化时：
// - 相关文件的签收失效（回到待签收，需要重新审阅）
// - 相关评论定位失效并重算（尝试在新内容中按行内容重新定位）
// - 其他文件照旧
export function handleChangesetChange(
  oldFiles: DiffFile[],
  newFiles: DiffFile[],
  progress: Record<string, FileProgress>,
): { progress: Record<string, FileProgress>; orphanedComments: string[] } {
  const newProgress: Record<string, FileProgress> = { ...progress };
  const orphanedComments: string[] = [];

  for (const newFile of newFiles) {
    const oldFile = oldFiles.find((file) => file.id === newFile.id);
    if (!oldFile) continue;

    const fileProgress = newProgress[newFile.id];
    if (!fileProgress) {
      newProgress[newFile.id] = emptyProgress(newFile.id);
      continue;
    }

    const contentChanged =
      oldFile.oldContent !== newFile.oldContent || oldFile.newContent !== newFile.newContent;
    if (!contentChanged) continue;

    // 签收失效
    newProgress[newFile.id] = {
      ...fileProgress,
      signoffStatus: "pending",
      reviewed: false,
      holder: null,
      batchId: null,
      claimedAt: null,
      signedAt: null,
      comments: [],
    };

    // 评论定位重算
    const { comments: recalculated, orphaned } = recalculateCommentPositions(
      fileProgress.comments,
      oldFile,
      newFile,
    );
    newProgress[newFile.id].comments = recalculated;
    orphanedComments.push(...orphaned);
  }

  return { progress: newProgress, orphanedComments };
}

// 评论定位重算：按评论所在行的内容，在新文件对应侧中查找相同行。
// 找到则更新行号；找不到则标记为 orphaned（定位失效）。
export function recalculateCommentPositions(
  comments: ReviewComment[],
  oldFile: DiffFile,
  newFile: DiffFile,
): { comments: ReviewComment[]; orphaned: string[] } {
  const orphaned: string[] = [];

  const recalculated = comments.map((comment) => {
    const oldContent = comment.side === "original" ? oldFile.oldContent : oldFile.newContent;
    const newContent = comment.side === "original" ? newFile.oldContent : newFile.newContent;
    const oldLines = oldContent.split("\n");
    const newLines = newContent.split("\n");

    const commentLine = oldLines[comment.line - 1];
    if (!commentLine) {
      orphaned.push(comment.id);
      return comment;
    }

    const newLineIndex = newLines.findIndex((line) => line === commentLine);
    if (newLineIndex === -1) {
      orphaned.push(comment.id);
      return comment;
    }

    return { ...comment, line: newLineIndex + 1 };
  });

  return { comments: recalculated, orphaned };
}

// 检测哪些文件的内容发生了变化。
export function detectChangedFileIds(oldFiles: DiffFile[], newFiles: DiffFile[]): string[] {
  const changed: string[] = [];
  for (const newFile of newFiles) {
    const oldFile = oldFiles.find((file) => file.id === newFile.id);
    if (!oldFile) {
      changed.push(newFile.id);
      continue;
    }
    if (oldFile.oldContent !== newFile.oldContent || oldFile.newContent !== newFile.newContent) {
      changed.push(newFile.id);
    }
  }
  return changed;
}
