/**
 * Activity-anchored todo window used by the pi widget and the slim overlay.
 *
 * Why: both surfaces must keep the in-progress row visible instead of a fixed
 * head/tail slice. The widget budgets unwrapped render lines; the overlay
 * supplies its own `fits` so wrapping can consume extra rows.
 */
import { countTodos, type TodoItem, type TodoStatus } from './vocab.ts';

export const TODO_MARKS: Record<TodoStatus, string> = {
  pending: '○',
  in_progress: '▶',
  completed: '✓',
  blocked: '■',
  abandoned: '✗',
};

export function formatTodoSummary(items: readonly TodoItem[]): string {
  const c = countTodos(items as TodoItem[]);
  return `todo: ${c.inProgress}▶ ${c.pending}○ ${c.blocked}■ ${c.completed}✓`;
}

/** Share phase rendering so widget and overlay order entries identically. */
export function renderTodoGroups(items: readonly TodoItem[]): string[] {
  const groups = new Map<string, TodoItem[]>();
  for (const it of items) {
    const key = it.phase ?? '';
    const arr = groups.get(key) ?? [];
    arr.push(it);
    groups.set(key, arr);
  }
  const lines: string[] = [];
  for (const [phase, list] of groups) {
    if (phase) lines.push(`  [${phase}]`);
    for (const it of list) {
      const suffix = it.status === 'blocked' && it.blocker ? ` — ${it.blocker}` : '';
      lines.push(`  ${TODO_MARKS[it.status]} ${it.content}${suffix}`);
    }
  }
  return lines;
}

/**
 * Expand around the active anchor while `fits(start, end)` remains true.
 * Prefers upcoming work; the anchor stays visible. All-completed lists keep
 * the original head-shrink (widget-compatible).
 */
export function anchorTodoRange(
  items: readonly TodoItem[],
  fits: (start: number, end: number) => boolean,
): [number, number] {
  if (items.length === 0) return [0, 0];
  if (fits(0, items.length)) return [0, items.length];
  const anchor = items.findIndex((it) => it.status === 'in_progress');
  const anchorIdx = anchor >= 0
    ? anchor
    : items.reduce((acc, it, i) => (it.status !== 'completed' ? i : acc), -1);
  if (anchorIdx < 0) {
    let end = items.length;
    while (end > 1 && !fits(0, end)) end -= 1;
    return [0, end];
  }
  let start = anchorIdx;
  let end = anchorIdx + 1;
  let growTail = true;
  while ((end < items.length || start > 0) && (end - start) < items.length) {
    if (growTail && end < items.length) {
      end += 1;
      if (!fits(start, end)) { end -= 1; break; }
    } else if (start > 0) {
      start -= 1;
      if (!fits(start, end)) { start += 1; break; }
    } else if (end < items.length) {
      end += 1;
      if (!fits(start, end)) { end -= 1; break; }
    } else {
      break;
    }
    growTail = !growTail;
  }
  return [start, end];
}
