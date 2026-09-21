/**
 * Anti-freeze core: a fully completed list that new work never updates must stop impersonating
 * current state.
 *
 *  - stale (A): open==0 and ≥ STALE_TURNS turns since the last write → the read hook injects a
 *    rate-limited, capped warning;
 *  - archived (B): open==0 and age ≥ STALE_CLOCK_MS → the list is treated as absent;
 *  - title (D): an archived list renders `✓N done <age>` instead of impersonating current state.
 *
 * A list with open items is never stale — agent_settled covers unfinished work. Unknown
 * lastWriteAt (old sessions) conservatively suppresses the clock axis; turns is unaffected.
 */
import { countTodos, type TodoItem } from './vocab.ts';

/** A: turn-based expiry threshold, counted from the last todo write. */
export const STALE_TURNS = 6;

/** B: age of the last write above which a completed list is archived. */
export const STALE_CLOCK_MS = 60 * 60 * 1000;

/** A: cap on stale warnings injected during one stalled period. */
export const STALE_NOTICE_MAX = 3;

export type StalenessKind = 'fresh' | 'stale' | 'archived';

export interface Staleness {
  kind: StalenessKind;
  /** open = pending + in_progress + blocked (abandoned is not unfinished). */
  open: number;
  ageMs: number | null;
}

export function openTodos(items: readonly TodoItem[]): number {
  const c = countTodos(items);
  return c.pending + c.inProgress + c.blocked;
}

/**
 * Clock (archived) takes precedence over turns (stale). Empty list → fresh (a separate guard owns
 * empty-list handling); null lastWriteAt → never stale.
 */
export function evaluateStaleness(opts: {
  items: readonly TodoItem[];
  lastWriteAt: number | null;
  turnsSinceWrite: number | null;
  now: number;
}): Staleness {
  const open = openTodos(opts.items);
  const ageMs = opts.lastWriteAt == null ? null : Math.max(0, opts.now - opts.lastWriteAt);
  const st: Staleness = { kind: 'fresh', open, ageMs };
  if (opts.items.length === 0 || open > 0) return st;
  if (ageMs != null && ageMs >= STALE_CLOCK_MS) st.kind = 'archived';
  else if (opts.turnsSinceWrite != null && opts.turnsSinceWrite >= STALE_TURNS) st.kind = 'stale';
  return st;
}

/** Title/mirror paths have no turn information: only the wall-clock archive axis. */
export function isArchived(
  items: readonly TodoItem[],
  lastWriteAt: number | null,
  now: number,
): boolean {
  return evaluateStaleness({ items, lastWriteAt, turnsSinceWrite: null, now }).kind === 'archived';
}

/** <60m → `Nm`; <48h → `Nh` (floor); otherwise `Nd`. */
export function formatAge(ms: number): string {
  if (ms < 60 * 60_000) return `${Math.max(1, Math.floor(ms / 60_000))}m`;
  if (ms < 48 * 3_600_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}
