/** Projects the todo snapshot into a one-line summary (M22, D62/D68): the slim frame title, the
 *  worker's todo_sync summary, and the `pier.todo` label a resumed master folds worker summaries from.
 *  The pi session JSONL stays authoritative. */
import { countTodos, type TodoItem } from './vocab.ts';
import { formatAge, isArchived } from './stale-core.ts';

/** Terminal label carrying the todo summary; read back by the master's resync (index.ts). */
export const TODO_LABEL = 'pier.todo';

/**
 * `▶i ○p ■b ✓c (N/M [~eta]) · <activity>` (D91 unifies the four status glyphs). activity is the
 * first in_progress item, then fallbackDescription, then only the counts. Empty list → null, which
 * callers translate into removing the label; progressSuffix (M16) comes from formatProgressSuffix.
 * Anti-freeze (stale-core D): once all work completed and the wall clock expired (archived), the
 * dead list degrades to `✓N done <age>` instead of presenting itself as a current-state view.
 */
export function formatPaneTitle(
  items: readonly TodoItem[],
  fallbackDescription?: string | null,
  opts?: { progressSuffix?: string | null; lastWriteAt?: number | null; now?: number },
): string | null {
  if (items.length === 0) return null;
  const c = countTodos(items);
  const now = opts?.now ?? Date.now();
  if (isArchived(items, opts?.lastWriteAt ?? null, now)) {
    const age = formatAge(now - (opts?.lastWriteAt as number));
    return `✓${c.completed} done ${age}`;
  }
  const activity =
    items.find((it) => it.status === 'in_progress')?.content
    ?? (fallbackDescription?.trim() ? fallbackDescription.trim() : null);
  const head = `▶${c.inProgress} ○${c.pending} ■${c.blocked} ✓${c.completed}`;
  const suffix = opts?.progressSuffix?.trim();
  const withProgress = suffix ? `${head} (${suffix})` : head;
  return activity ? `${withProgress} · ${activity}` : withProgress;
}
