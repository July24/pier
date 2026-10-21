/**
 * Unified TUI status surface (RFC docs/rfc-unified-widget.md, D113): the resident widget shows one
 * line per agent — self plus every running subagent — each reduced to its CURRENT item and a
 * done/total suffix; the full todo × subagent tree lives behind /pier-tree. Pure builders only.
 */
import { formatAge } from './stale-core.ts';
import { formatTodoSummary, renderTodoGroups } from './todo-window.ts';
import type { TodoItem } from './vocab.ts';

/** Minimal todo shape carried over the pipe (todo_sync); status matches TodoStatus strings. */
export interface TodoLikeItem {
  content: string;
  status: string;
  blocker?: string;
}

/** What the master caches per worker: the pushed full list, or a summary fallback after a resume. */
export interface WorkerTodoSnapshot {
  items?: readonly TodoLikeItem[];
  summary?: string;
  ts?: number;
}

/** One running worker row as the widget/tree consumes it. */
export interface WorkerWidgetRow {
  paneId: string;
  slug?: string;
  description: string;
  kind?: string;
  todos?: WorkerTodoSnapshot | null;
}

/** A settled (delivered) worker row for the tree view only — never in the resident widget. */
export interface SettledWidgetRow {
  paneId: string;
  slug?: string;
  description: string;
  settledAt?: number | null;
}

const CONTENT_CLIP = 60;

function clip(text: string, max = CONTENT_CLIP): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function countsOf(items: readonly TodoLikeItem[]): string {
  const done = items.filter((it) => it.status === 'completed').length;
  return `✓${done}/${items.length}`;
}

function currentOf(items: readonly TodoLikeItem[]): TodoLikeItem | undefined {
  return items.find((it) => it.status === 'in_progress')
    ?? items.find((it) => it.status === 'blocked')
    ?? items.find((it) => it.status === 'pending');
}

/** `↳ <ref> ▶ <current> ✓d/n` — blocked names the waiting TASK (the actionable identity) with the
 * blocker as a parenthetical reason; a cold cache falls back to the summary token. */
export function workerLine(row: WorkerWidgetRow): string {
  const ref = row.slug ?? `${row.paneId} · ${clip(row.description, 30)}`;
  const items = row.todos?.items;
  if (items && items.length > 0) {
    const cur = currentOf(items);
    const counts = countsOf(items);
    if (!cur) return `↳ ${ref} ${counts}`;
    if (cur.status === 'blocked') {
      const why = cur.blocker && cur.blocker !== cur.content ? `（${clip(cur.blocker, 24)}）` : '';
      return `↳ ${ref} ■ ${clip(cur.content, 40)}${why} ${counts}`;
    }
    return `↳ ${ref} ▶ ${clip(cur.content)} ${counts}`;
  }
  const summary = row.todos?.summary;
  if (summary) return `↳ ${ref} · ${clip(summary, 50)}`;
  return `↳ ${ref}`;
}


/** Self line: the current item with a done/total suffix — the anchored multi-line window is retired.
 * A finished plan (no in_progress / blocked / pending item) has no actionable row, so it renders
 * nothing at all: a bare `✓8/8` is noise that the human cannot act on. */
export function selfLine(items: readonly TodoItem[]): string | null {
  if (items.length === 0) return null;
  const cur = currentOf(items);
  if (!cur) return null;
  const counts = countsOf(items);
  if (cur.status === 'blocked') return `■ 等人: ${clip(cur.blocker || cur.content, 40)} ${counts}`;
  return `▶ ${clip(cur.content)} ${counts}`;
}

/** pi caps the resident widget at ten lines; overflow workers fold into a count tail. */
export const WIDGET_MAX_LINES = 10;

export function unifiedWidgetLines(
  items: readonly TodoItem[],
  workers: readonly WorkerWidgetRow[],
  opts?: { archivedAgeMs?: number | null; blockedDepth?: number | null },
): string[] {
  // Human gate open: the question owns the fixed area (unchanged discipline from the old widget).
  if ((opts?.blockedDepth ?? 0) > 0) {
    return workers.length === 0 || items.length === 0
      ? [`${formatTodoSummary(items)} · /todos 全量`]
      : [`${formatTodoSummary(items)} · ↳×${workers.length} · /todos 全量`];
  }
  if (items.length === 0 && workers.length === 0) return [];
  // Archived plans keep their degraded two-line form; workers stay visible underneath.
  const self = items.length > 0 ? selfLine(items) : null;
  const head = opts?.archivedAgeMs != null && items.length > 0
    ? [`${formatTodoSummary(items)} · archived ${formatAge(opts.archivedAgeMs)}`]
    : self ? [self] : [];
  if (head.length === 0 && workers.length === 0) return [];
  const rows = workers.map(workerLine);
  const budget = WIDGET_MAX_LINES - head.length - 1;
  const shown = rows.slice(0, Math.max(budget, 0));
  const hidden = rows.length - shown.length;
  return [...head, ...shown, ...(hidden > 0 ? [`…另 ${hidden} 个子代理 · /pier-tree`] : [])];
}

/** Full delegation tree for /pier-tree: self todos in full + per-worker full lists + settled nodes. */
export function formatDelegationTree(opts: {
  selfItems: readonly TodoItem[];
  workers: readonly WorkerWidgetRow[];
  settled?: readonly SettledWidgetRow[];
  now?: number;
}): string[] {
  const now = opts.now ?? Date.now();
  const lines: string[] = ['==================== PIER DELEGATION TREE ===================='];
  lines.push(`● master（本 pane）· ${opts.selfItems.length} 项`);
  lines.push(...renderTodoGroups(opts.selfItems).map((l) => `  ${l}`));
  if (opts.workers.length > 0 || (opts.settled?.length ?? 0) > 0) lines.push('  │');
  for (const w of opts.workers) {
    const ref = w.slug ?? w.paneId;
    const items = w.todos?.items;
    const headSuffix = items && items.length > 0
      ? `· ${items.length} 项`
      : w.todos?.summary ? `· ${clip(w.todos.summary, 40)}` : '· todo 未同步';
    lines.push(`  ├─ ↳ ${ref} (${w.paneId} · running${w.kind && w.kind !== 'task' ? ` · ${w.kind}` : ''}) ${headSuffix}`);
    if (items && items.length > 0) {
      lines.push(...renderTodoGroups(toTodoItems(items)).map((l) => `  │    ${l}`));
    }
  }
  for (const s of opts.settled ?? []) {
    const ref = s.slug ?? s.paneId;
    const age = s.settledAt ? ` · settled ${formatAge(Math.max(now - s.settledAt, 0))} ago` : ' · settled';
    lines.push(`  └─ ✓ ${ref} (${s.paneId}${age}) — 结果已注入结算通知`);
  }
  lines.push('----------------------------------------------------------------');
  lines.push('提示: /todos 编辑自己的清单 · subagent list 交互子代理 · /dashboard ops 面板');
  return lines;
}

/** Narrow a pipe-pushed item list back to TodoItem for the shared group renderer. */
function toTodoItems(items: readonly TodoLikeItem[]): TodoItem[] {
  return items.map((it) => ({
    content: it.content,
    status: (['pending', 'in_progress', 'blocked', 'completed', 'abandoned'].includes(it.status)
      ? it.status
      : 'pending') as TodoItem['status'],
    ...(it.blocker ? { blocker: it.blocker } : {}),
  }));
}
