/**
 * D92 settlement-notice buffer (busy-run collapse).
 *
 * Why: `sendUserMessage(followUp)` only delivers when the agent has no more
 * tool calls — a long master run queues every settlement and floods at the
 * end. Buffer while busy; flush at turn_end (steer) / agent_settled (followUp).
 */
import { collapseNotices } from './notice-buffer.ts';

export type NoticeSendMode = 'steer' | 'followUp';

export interface NoticeBuffer {
  deliverNotice(content: string, paneId?: string): Promise<void>;
  noticePending(): ReadonlySet<string>;
  flush(mode: NoticeSendMode): Promise<void>;
}

export function createNoticeBuffer(opts: {
  /** True while the agent is in a turn, or after an abort that must not wake a new run. */
  isBusy: () => boolean;
  send: (content: string, mode: NoticeSendMode) => Promise<void>;
}): NoticeBuffer {
  const pending: string[] = [];
  const pendingPaneIds = new Set<string>();
  return {
    async deliverNotice(content, paneId) {
      if (content !== '' && paneId !== undefined) pendingPaneIds.add(paneId);
      if (opts.isBusy()) {
        pending.push(content);
        return;
      }
      await opts.send(content, 'followUp');
      if (content !== '' && paneId !== undefined) pendingPaneIds.delete(paneId);
    },
    noticePending: () => pendingPaneIds,
    async flush(mode) {
      if (pending.length === 0) return;
      const collapsed = collapseNotices(pending.splice(0));
      pendingPaneIds.clear();
      if (collapsed) await opts.send(collapsed, mode);
    },
  };
}
