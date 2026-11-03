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
  const tail = `…${hidden} more settlement(s) not shown individually. See the history ledger for full results (path formula in the subagent resume tool description); use subagent list for running agents.`;
  return [...contents.slice(0, max), tail].join('\n\n');
}

export interface NoticeBuffer {
  deliverNotice(content: string, paneId?: string): Promise<void>;
  noticePending(): ReadonlySet<string>;
  flush(mode: NoticeSendMode): Promise<void>;
  /** `subagent wait`: remove and return the buffered notices tagged with one of `paneIds`, so the
   *  tool result carries them instead of a later turn-gap delivery. */
  takeNotices(paneIds: ReadonlySet<string>): string[];
  /** Resolves true once a notice tagged with one of `paneIds` is buffered (or already is), false on
   *  timeout or abort. */
  awaitNotice(paneIds: ReadonlySet<string>, timeoutMs: number, signal?: AbortSignal): Promise<boolean>;
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
  const pending: Array<{ content: string; paneId?: string }> = [];
  const pendingPaneIds = new Set<string>();
  const waiters = new Set<{ paneIds: ReadonlySet<string>; wake: () => void }>();
  return {
    async deliverNotice(content, paneId) {
      if (content !== '' && paneId !== undefined) pendingPaneIds.add(paneId);
      if (opts.isBusy()) {
        pending.push({ content, paneId });
        if (paneId !== undefined) for (const w of waiters) if (w.paneIds.has(paneId)) w.wake();
        return;
      }
      await opts.send(content, 'followUp');
      if (content !== '' && paneId !== undefined) pendingPaneIds.delete(paneId);
    },
    noticePending: () => pendingPaneIds,
    async flush(mode) {
      if (pending.length === 0) return;
      const flushed = pending.splice(0);
      const batch = flushed.map((n) => n.content);
      let ordered: readonly string[] = batch;
      if (opts.rank && batch.length > NOTICE_MAX_SHOWN) {
        ordered = (await opts.rank(batch)) ?? batch;
      }
      // Release only this batch's panes: a notice buffered during the rank await is still undelivered,
      // and GC must keep its pane until it is.
      for (const { paneId } of flushed) {
        if (paneId !== undefined && !pending.some((n) => n.paneId === paneId)) pendingPaneIds.delete(paneId);
      }
      const collapsed = collapseNotices(ordered);
      if (collapsed) await opts.send(collapsed, mode);
    },
    takeNotices(paneIds) {
      const taken = pending.filter((n) => n.paneId !== undefined && paneIds.has(n.paneId));
      if (taken.length === 0) return [];
      pending.splice(0, pending.length, ...pending.filter((n) => !taken.includes(n)));
      // Taken notices are delivered by the tool result: their panes are no longer GC-exempt.
      for (const { paneId } of taken) pendingPaneIds.delete(paneId!);
      return taken.map((n) => n.content).filter((c) => c !== '');
    },
    awaitNotice(paneIds, timeoutMs, signal) {
      if (pending.some((n) => n.paneId !== undefined && paneIds.has(n.paneId))) return Promise.resolve(true);
      if (signal?.aborted) return Promise.resolve(false);
      const { promise, resolve } = Promise.withResolvers<boolean>();
      const done = (hit: boolean): void => {
        clearTimeout(timer);
        waiters.delete(waiter);
        signal?.removeEventListener('abort', onAbort);
        resolve(hit);
      };
      const waiter = { paneIds, wake: () => done(true) };
      const onAbort = (): void => done(false);
      const timer = setTimeout(() => done(false), Math.max(0, timeoutMs));
      waiters.add(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
      return promise;
    },
  };
}
