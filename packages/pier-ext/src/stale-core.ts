/**
 * Pure core for todo staleness (anti-freeze behavior: a fully completed list once froze for 16h /
 * 37 turns while new work went untracked).
 *
 *  - stale (A): open==0 and ≥ STALE_TURNS turns since the last write → the read hook injects a
 *    rate-limited, capped stale warning;
 *  - archived (B): open==0 and wall-clock age ≥ STALE_CLOCK_MS → treat the list as absent (injection
 *    and title projection stop rereading details; /todos still shows it, session JSONL stays authoritative);
 *  - title (D): when archived, pane/sidebar renders `✓N done <age>` instead of impersonating current state.
 *
 * A list with open items (pending/in_progress/blocked) is never stale — agent_settled covers unfinished
 * work. Unknown lastWriteAt (old sessions) conservatively suppresses the clock axis; turns is unaffected.
 */
import { countTodos, type TodoItem } from './vocab.ts';

/** A: turn-based expiry threshold (user turns counted from the last todo write). */
export const STALE_TURNS = 6;

/** B: wall-clock archive threshold (age of the last write for a completed list). */
export const STALE_CLOCK_MS = 60 * 60 * 1000;

/** A: maximum stale warnings injected during one stalled period. */
export const STALE_NOTICE_MAX = 3;

export type StalenessKind = 'fresh' | 'stale' | 'archived';

export interface Staleness {
  kind: StalenessKind;
  /** open = pending + in_progress + blocked (abandoned does not count as unfinished). */
  open: number;
  /** now - lastWriteAt; unknown lastWriteAt → null. */
  ageMs: number | null;
}

/** Open items: stale/archived apply only to fully completed (or fully abandoned) lists with open==0. */
export function openTodos(items: readonly TodoItem[]): number {
  const c = countTodos(items);
  return c.pending + c.inProgress + c.blocked;
}

/**
 * Staleness from two axes (turns → stale; wall clock → archived, clock taking precedence).
 * Empty list → fresh (a separate guard owns empty-list handling); null lastWriteAt → never stale.
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

/** For title/mirror paths without turn information: only the wall-clock archive axis. */
export function isArchived(
  items: readonly TodoItem[],
  lastWriteAt: number | null,
  now: number,
): boolean {
  return evaluateStaleness({ items, lastWriteAt, turnsSinceWrite: null, now }).kind === 'archived';
}

/** Age display: <60m → `Nm`; <48h → `Nh` (floor); otherwise `Nd`. */
export function formatAge(ms: number): string {
  if (ms < 60 * 60_000) return `${Math.max(1, Math.floor(ms / 60_000))}m`;
  if (ms < 48 * 3_600_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}
