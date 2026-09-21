/**
 * M17: pure planner for automatic todo↔subagent reconciliation, run after a settlement push and
 * before the followUp is injected.
 *
 * Match description ↔ todo.content after normalize (lowercase + collapse whitespace) at tiers
 * exact → prefix → substring, the same family as D38 fuzzyFind.
 *  - Auto-complete only a settled subagent's unique best candidate at exact/prefix, at most one item;
 *  - Unblock blocked items whose blocker matches at any tier (blockers are phrases like "waiting for
 *    X to finish", so substring matters and a soft return to pending is safe);
 *  - Low confidence / ambiguity / failure leaves the list untouched and adds a prompt line (P2: never
 *    check off a guess);
 *  - Edits persist through the D38 authoritative path (pi-herdr.todo-edit), so branch replay reproduces them.
 */

import { applyTodoEdits, type TodoEdit, type TodoItem } from './todo-core.ts';

type ReconcileOutcome = 'settled' | 'failed';
type MatchTier = 'exact' | 'prefix' | 'substring' | null;
interface ReconcilePlan {
  /** List after applying edits (original reference when there are no edits). */
  items: TodoItem[];
  /** Edits persisted through the authoritative path (at most one done plus any unblocks). */
  edits: TodoEdit[];
  /** Item automatically checked off (at most one). */
  completed: TodoItem | null;
  /** Best matching tier for auto-completion (null when there are no candidates). */
  tier: MatchTier;
  unblocked: TodoItem[];
  /** Prompt lines appended to the settlement notice (empty when none). */
  noteLines: string[];
  /** Match-rate metric, collected with the settlement notice in session JSONL (P2). */
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

  // Check-off candidates: completed/abandoned never participate.
  const scored = prev
    .filter((t) => t.status === 'pending' || t.status === 'in_progress')
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
      noteLines.push(
        `Todo match ambiguous between: ${best.map((c) => `"${c.item.content}"`).join(', ')} — update todo_write yourself.`,
      );
    } else {
      // High-confidence candidate, but the subagent did not settle successfully: keep it open.
      for (const c of best) {
        noteLines.push(`Todo kept open: "${c.item.content}" (subagent did not settle successfully).`);
      }
    }
  } else if (bestTier === 'substring') {
    for (const c of best) {
      noteLines.push(`Todo not auto-completed (low-confidence match): "${c.item.content}" — update todo_write if this work is done.`);
    }
  }

  // Unblocking is a soft operation, so any tier counts; only a settled subagent can unblock.
  const unblocked: TodoItem[] = [];
  if (outcome === 'settled') {
    for (const t of prev) {
      if (t.status !== 'blocked' || typeof t.blocker !== 'string') continue;
      if (matchTier(description, t.blocker) === null) continue;
      unblocked.push(t);
      edits.push({ op: 'unblock', content: t.content });
      noteLines.push(`Unblocked "${t.content}" (was waiting on: ${t.blocker}).`);
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
