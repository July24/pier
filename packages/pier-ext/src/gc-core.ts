/**
 * Task-tab GC decisions (D29 rules as a pure function; M22 dropped resident exemption).
 * No I/O, no pi/herdr — unit-testable.
 */
export type GcEntryKind = string;
export type GcEntryStatus = 'running' | 'settled' | 'consumed' | 'closed';

export interface GcEntryLike {
  /** 'task' or a role name; legacy short/resident is a label only. */
  kind: GcEntryKind;
  status: GcEntryStatus;
  /** Consume timestamp (GC grace); closed rows keep the original value. */
  consumedAt?: number | null;
}

function isFinished(status: GcEntryStatus): boolean {
  return status === 'consumed' || status === 'closed' || status === 'settled';
}

/**
 * Close a task tab only when every condition holds:
 *  - ≥1 work pane (the main tab with no delegated entries never closes);
 *  - every work pane is settled/consumed/closed (kind is not an exemption);
 *  - grace TTL elapsed (`ttlMs=0` means never auto-close);
 *  - no blocked pane (human-gate exemption);
 *  - remaining panes are idle/done/unknown (non-work panes may be unknown).
 */
export function shouldCloseTaskTab(opts: {
  entries: readonly GcEntryLike[];
  paneStatuses: readonly string[];
  ttlMs: number;
  now: number;
}): boolean {
  if (opts.entries.length === 0) return false;
  if (!opts.entries.every((e) => isFinished(e.status))) return false;
  if (!opts.entries.every((e) => (e.consumedAt ?? 0) > 0 && (e.consumedAt ?? 0) < opts.now - opts.ttlMs)) return false;
  if (opts.paneStatuses.some((s) => s === 'blocked')) return false;
  if (!opts.paneStatuses.every((s) => s === 'idle' || s === 'done' || s === 'unknown')) return false;
  return true;
}

/**
 * Pane-level collection (orphan / compat path):
 *  - consumed before the previous turn (grace so the settlement notice is still visible);
 *  - herdr status idle/done (unknown/working/blocked retry next turn);
 *  - missing pane (status undefined) → record closed (caller handles the write).
 */
export function shouldClosePane(opts: {
  consumedAt: number | null;
  herdrStatus: string | undefined;
  prevTurnStart: number;
}): boolean {
  if (opts.herdrStatus === undefined) return true; // pane gone → record closed
  if (opts.herdrStatus !== 'idle' && opts.herdrStatus !== 'done') return false;
  return (opts.consumedAt ?? 0) > 0 && opts.consumedAt! < opts.prevTurnStart;
}
