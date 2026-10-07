import type { ReviewSnapshot } from "../types/review";

const CHANNEL_NAME = "diff-scope-review-sync";

export type SyncMessage =
  | { type: "snapshot-update"; snapshot: ReviewSnapshot; tabId: string }
  | { type: "request-snapshot"; tabId: string };

type MessageHandler = (message: SyncMessage) => void;

// 跨标签页同步通道。同一来源的标签页通过 BroadcastChannel 交换快照。
export class SyncChannel {
  private channel: BroadcastChannel | null = null;
  private handlers = new Set<MessageHandler>();
  readonly tabId: string;

  constructor() {
    this.tabId = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    if (typeof BroadcastChannel !== "undefined") {
      this.channel = new BroadcastChannel(CHANNEL_NAME);
      this.channel.onmessage = (event: MessageEvent<SyncMessage>) => {
        for (const handler of this.handlers) handler(event.data);
      };
    }
  }

  subscribe(handler: MessageHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  broadcast(snapshot: ReviewSnapshot): void {
    this.channel?.postMessage({ type: "snapshot-update", snapshot, tabId: this.tabId });
  }

  requestSnapshot(): void {
    this.channel?.postMessage({ type: "request-snapshot", tabId: this.tabId });
  }

  close(): void {
    this.channel?.close();
    this.handlers.clear();
  }
}

// 模拟一个远端标签页的快照（用于演示，无需真的打开两个标签页）。
export function simulateRemoteSnapshot(
  local: ReviewSnapshot,
  holder: string = "赵明",
): ReviewSnapshot {
  const now = new Date().toISOString();
  const fileIds = Object.keys(local.progress);
  const targetFileId = fileIds[Math.floor(Math.random() * fileIds.length)];
  const target = local.progress[targetFileId];

  const remoteProgress = { ...local.progress };
  if (target) {
    remoteProgress[targetFileId] = {
      ...target,
      comments: [
        ...target.comments,
        {
          id: `comment-remote-${Date.now()}`,
          threadId: `thread-remote-${Date.now()}`,
          fileId: targetFileId,
          line: 1,
          side: "modified",
          author: holder,
          body: `【远端标签页 · ${holder}】这是一条模拟并发评论，用于验证合并不会被覆盖。`,
          createdAt: now,
          resolved: false,
          replies: [],
        },
      ],
    };
  }

  return {
    ...local,
    progress: remoteProgress,
    updatedAt: now,
    updatedBy: holder,
  };
}
