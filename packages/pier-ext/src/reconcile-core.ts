/**
 * M17: pure planner for automatic todo↔subagent reconciliation (development plan §M17; P2 = do not check off low-confidence matches, only prompt).
 *
 * Timing (adapter): after the controller receives a settlement push (pollLoop / pipe reply), before injecting followUp.
 * Semantics (aligned with omp reconcileTodosWithSubagents):
 *  - Match description ↔ todo.content: normalize (lowercase + collapse whitespace), then exact → bidirectional prefix
 *    → substring, in the same family as D38 fuzzyFind;
 *  - Auto-complete only when settled and the unique best tier is in {exact, prefix}; at most one item per settlement;
 *  - Unblock blocked items whose blocker ↔ description matches at any tier (exact/prefix)
 *    (multiple allowed; failed/low-confidence matches do not unblock);
 *  - Low confidence/ambiguity/failure: leave the list unchanged and add a noteLines prompt to the settlement notice (P2 decision);
 *  - Persistence: edits use the D38 authoritative path (pi-herdr.todo-edit custom entry, effective during branch replay).
 */

import { applyTodoEdits, type TodoEdit, type TodoItem } from './todo-core.ts';

export type ReconcileOutcome = 'settled' | 'failed';
export type MatchTier = 'exact' | 'prefix' | 'substring' | null;
export interface ReconcilePlan {
  /** List after applying edits (original reference when there are no edits). */
  items: TodoItem[];
  /** Edits persisted through the authoritative path (at most one done plus any unblocks). */
  edits: TodoEdit[];
  /** Item automatically checked off (at most one). */
  completed: TodoItem | null;
  /** Best matching tier for auto-completion (null when there are no candidates). */
  tier: MatchTier;
  /** Items unblocked by a blocker match. */
  unblocked: TodoItem[];
  /** Prompt lines injected into the settlement notice (aligned with D36 feedback tone; empty when none). */
  noteLines: string[];
  /** Match-rate metric (P2: collected with the settlement notice in session JSONL). */
  metric: {
    description: string;
    outcome: ReconcileOutcome;
    bestTier: MatchTier;
    candidates: number;
    autoCompleted: boolean;
    unblocked: number;
  };
}

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

function matchTier(a: string, b: string): MatchTier {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return null;
  if (na === nb) return 'exact';
  if (na.startsWith(nb) || nb.startsWith(na)) return 'prefix';
  if (na.includes(nb) || nb.includes(na)) return 'substring';
  return null;
}

const TIER_ORDER: Record<Exclude<MatchTier, null>, number> = { exact: 0, prefix: 1, substring: 2 };

export function reconcileTodos(
  prev: readonly TodoItem[],
  opts: { description: string; outcome: ReconcileOutcome },
): ReconcilePlan {
  const { description, outcome } = opts;
  const edits: TodoEdit[] = [];
  const noteLines: string[] = [];

  // 1) Check-off candidates: pending / in_progress (completed/abandoned never participate).
  const matchable = prev.filter((t) => t.status === 'pending' || t.status === 'in_progress');
  const scored = matchable
    .map((t) => ({ item: t, tier: matchTier(description, t.content) }))
    .filter((c): c is { item: TodoItem; tier: Exclude<MatchTier, null> } => c.tier !== null)
    .sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier]);
  const bestTier = scored.length ? scored[0].tier : null;
  const best = bestTier ? scored.filter((c) => c.tier === bestTier) : [];

  let completed: TodoItem | null = null;
  if (bestTier === 'exact' || bestTier === 'prefix') {
    if (best.length === 1 && outcome === 'settled') {
      completed = best[0].item;
      edits.push({ op: 'done', content: completed.content });
      noteLines.push(`Reconciled: completed "${completed.content}" (${bestTier} match with subagent description).`);
    } else if (best.length > 1) {
      // Ambiguous match: list candidates and leave the decision to a person.
      noteLines.push(
        `Todo match ambiguous between: ${best.map((c) => `"${c.item.content}"`).join(', ')} — update todo_write yourself.`,
      );
    } else if (outcome === 'failed') {
      // High-confidence candidate, but the subagent did not settle successfully: keep it open and prompt.
      for (const c of best) {
        noteLines.push(`Todo kept open: "${c.item.content}" (subagent did not settle successfully).`);
      }
    }
  } else if (bestTier === 'substring') {
    // Low-confidence match (P2): do not check it off; prompt with the candidate.
    for (const c of best) {
      noteLines.push(`Todo not auto-completed (low-confidence match): "${c.item.content}" — update todo_write if this work is done.`);
    }
  }

  // 2) Unblock on any blocker match, including substring—real blockers are phrases such as "waiting for X to finish",
  //    so the description may be embedded in the middle and prefix would miss it. The low-confidence gate applies only
  //    to check-offs; returning an unblocked item to pending is a soft operation. Only settled subagents can unblock (possibly multiple).
  const unblocked: TodoItem[] = [];
  if (outcome === 'settled') {
    for (const t of prev) {
      if (t.status !== 'blocked' || typeof t.blocker !== 'string') continue;
      if (matchTier(description, t.blocker) !== null) {
        unblocked.push(t);
        edits.push({ op: 'unblock', content: t.content });
        noteLines.push(`Unblocked "${t.content}" (was waiting on: ${t.blocker}).`);
      }
    }
  }

  return {
    items: edits.length ? applyTodoEdits(prev, edits) : prev as TodoItem[],
    edits,
    completed,
    tier: bestTier,
    unblocked,
    noteLines,
    metric: {
      description,
      outcome,
      bestTier,
      candidates: scored.length,
      autoCompleted: completed !== null,
      unblocked: unblocked.length,
    },
  };
}
