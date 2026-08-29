/**
 * Pure core for todo staleness (anti-freeze behavior, evidenced by session 01a03253).
 *
 * Evidence: a fully completed list (3✓) froze for 16h / 37 turns while the model continued new work but made no
 * todo_write calls; rereading the dead list every read hook falsely endorsed "nothing to track," and the title
 * rendered dead counts at full weight. This module reduces whether a list still reflects reality to pure functions
 * consumed in three places:
 *  - stale (A): open==0 with ≥ STALE_TURNS turns since the last write → the read hook injects a rate-limited,
 *    capped stale warning;
 *  - archived (B): open==0 with wall-clock age ≥ STALE_CLOCK_MS since the last write → treat it as absent
 *    (injection/projection no longer rereads details; entries remain queryable through /todos; session JSONL stays authoritative);
 *  - title (D): when archived, pane/sidebar renders `✓N done <age>` instead of impersonating current state.
 *
 * A list with open items (pending/in_progress/blocked) is never stale: agent_settled continues to cover unfinished
 * work. When lastWriteAt is unknown (old sessions lack timestamps), conservatively do not archive on the clock axis;
 * the turns axis remains unaffected.
 */
import { countTodos, type TodoItem } from './vocab.ts';

/** A: turn-based expiry threshold (user turns counted from the last todo write). */
export const STALE_TURNS = 6;

/** B: wall-clock archive threshold (age of the last write for a completed list). */
export const STALE_CLOCK_MS = 60 * 60 * 1000;

/** A: maximum stale warnings injected during one stalled period (prevent spin noise; archived changes to archive-notice cadence). */
export const STALE_NOTICE_MAX = 3;

export type StalenessKind = 'fresh' | 'stale' | 'archived';

export interface Staleness {
  kind: StalenessKind;
  /** open = pending + in_progress + blocked (abandoned does not count as unfinished). */
  open: number;
  /** now - lastWriteAt; unknown lastWriteAt → null. */
  ageMs: number | null;
}

/** Count open items: stale/archived apply only to fully completed (or fully abandoned) lists with open==0. */
export function openTodos(items: readonly TodoItem[]): number {
  const c = countTodos(items as TodoItem[]);
  return c.pending + c.inProgress + c.blocked;
}

/**
 * Determine staleness (two conditions: turns → stale; wall clock → archived, with the clock taking precedence).
 * Empty list → fresh (a separate guard owns empty-list handling); null lastWriteAt → never stale (conservative).
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

/** For title/mirror paths without turn information: only evaluate wall-clock archive status. */
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
