/**
 * D92 settlement-notice buffer: `sendUserMessage(followUp)` only delivers when the agent has no
 * more tool calls, so a long master run would queue every settlement and flood at the end. Buffer
 * while busy; flush at turn_end (steer) / agent_settled (followUp), collapsing large batches. */

export type NoticeSendMode = 'steer' | 'followUp';

export const NOTICE_MAX_SHOWN = 3;

/** Collapse a batch into one message body: empty → null; above the cap, the first max originals plus
 *  a tail pointing at history / subagent list. A single-item batch stays byte-identical to the
 *  direct-send format. */
export function collapseNotices(contents: readonly string[], max = NOTICE_MAX_SHOWN): string | null {
  if (contents.length === 0) return null;
  if (contents.length <= max) return contents.join('\n\n');
  const hidden = contents.length - max;
  const tail = `…另有 ${hidden} 条结算未逐条展示。全量结果看 history 台账（路径公式见 subagent resume 工具描述）；在跑代理用 subagent list 查看。`;
  return [...contents.slice(0, max), tail].join('\n\n');
}

export interface NoticeBuffer {
  deliverNotice(content: string, paneId?: string): Promise<void>;
  noticePending(): ReadonlySet<string>;
  flush(mode: NoticeSendMode): Promise<void>;
}

export function createNoticeBuffer(opts: {
  /** True while the agent is in a turn, or after an abort that must not wake a new run. */
  isBusy: () => boolean;
  send: (content: string, mode: NoticeSendMode) => Promise<void>;
  /**
   * P0-2 (RFC docs/rfc-jev-integration.md §3): relevance reorder of a collapsed batch before truncation.
   * Only consulted above the show cap; returning null (or omitting the hook) keeps arrival order.
   * Implementations must not throw. */
  rank?: (contents: readonly string[]) => Promise<readonly string[] | null>;
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
      const batch = pending.splice(0);
      let ordered: readonly string[] = batch;
      if (opts.rank && batch.length > NOTICE_MAX_SHOWN) {
        ordered = (await opts.rank(batch)) ?? batch;
      }
      pendingPaneIds.clear();
      const collapsed = collapseNotices(ordered);
      if (collapsed) await opts.send(collapsed, mode);
    },
  };
}
