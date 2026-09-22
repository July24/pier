/**
 * pi-herdr bridge vocabulary. DESIGN.md §4.2: no new transport — wire = herdr NDJSON, todo authority
 * = pi session JSONL, display = pane.report_metadata title / state_labels.
 */

/** Five states (D34): three-state + blocked/abandoned, aligned with OMP. */
export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'blocked' | 'abandoned';

export const TODO_STATUSES: readonly TodoStatus[] = ['pending', 'in_progress', 'completed', 'blocked', 'abandoned'];

/** Todo item: content + status; blocker only when blocked; optional phase groups (D43). No id (last-write-wins). */
export interface TodoItem {
  content: string;
  status: TodoStatus;
  blocker?: string;
  /** Optional group name (D43); non-empty, ≤30 chars. */
  phase?: string;
}

/** Full todo snapshot (each todo_write submits this; last-wins). */
export interface TodoSnapshot {
  /** Shape version; consumers drop stale snapshots. */
  version: 1;
  items: TodoItem[];
}

export interface TodoCounts {
  pending: number;
  inProgress: number;
  completed: number;
  /** D91: blocked is its own column (title quartet ▶○■✓). */
  blocked: number;
}

/** Source name for pane.report-agent. */
export const REPORT_AGENT_SOURCE = 'pi-herdr';

/** First-upgrade key used to clear the old 16-key chunked tokens (M13b). */
export const PI_HERDR_META_KEY = 'pi-herdr';

export const TODO_TOOL_NAME = 'todo_write';

/** Snapshot key in tool-result details (persisted in session JSONL). */
export const TODO_DETAILS_KEY = 'pi-herdr.todo';

/** Confirmation copy (byte-aligned with DSH so model vocab transfers). */
export function formatTodoConfirmation(items: readonly TodoItem[]): string {
  const c = countTodos(items);
  const base = `Updated todo list: ${c.pending} pending, ${c.inProgress} in progress, ${c.completed} completed.`;
  // Append blocked only when non-zero — the model must not read "nothing pending" while items sit
  // blocked on a human. Zero keeps the DSH-aligned wording intact.
  return c.blocked > 0 ? `${base.slice(0, -1)}, ${c.blocked} blocked.` : base;
}

/** Every status the todo model knows; anything else in a snapshot is corrupt data (D34). */
const STATUS_LOOKUP: Readonly<Record<TodoStatus, true>> = {
  pending: true,
  in_progress: true,
  completed: true,
  blocked: true,
  abandoned: true,
};

/**
 * Corrupt snapshots carry arbitrary JSON as `status` (`extractSnapshotFromDetails` does not validate),
 * so every table lookup keyed by status must pass through this first — `TODO_MARKS['constructor']`
 * would otherwise render a function, and `groups['constructor'].push` would throw.
 */
export const isTodoStatus = (value: unknown): value is TodoStatus =>
  typeof value === 'string' && Object.hasOwn(STATUS_LOOKUP, value);

const COUNTED_STATUSES = {
  pending: 'pending',
  in_progress: 'inProgress',
  completed: 'completed',
  blocked: 'blocked',
} as const satisfies Partial<Record<TodoStatus, keyof TodoCounts>>;

/** The four states that occupy a count column (`abandoned` is terminal and deliberately uncounted). */
const isCountedStatus = (status: TodoStatus): status is keyof typeof COUNTED_STATUSES =>
  Object.hasOwn(COUNTED_STATUSES, status);

export function countTodos(items: readonly TodoItem[]): TodoCounts {
  const counts: TodoCounts = { pending: 0, inProgress: 0, completed: 0, blocked: 0 };
  for (const it of items) {
    const status = it?.status;
    if (isTodoStatus(status) && isCountedStatus(status)) counts[COUNTED_STATUSES[status]] += 1;
  }
  return counts;
}

/** Why a settlement carried no closing text (p24-class mis-attribution vs a truly silent worker). */
export type SettlementNullReason = 'silent' | 'attribution-suspect' | 'extraction-failed';

const NULL_CLOSING_SENTENCE: Record<SettlementNullReason, string> = {
  'attribution-suspect': 'Its closing message could NOT be read — the session attribution is suspect (a wrong transcript may have been read). Check `subagent action output` / the ledger sessionFile before assuming it produced nothing; its work may be complete.',
  'extraction-failed': 'It appears to have ended with a final report, but the closing text could not be extracted — read it from the session transcript.',
  silent: 'It left no closing message.',
};

/** Subagent settlement notice (aligned with DSH). */
export function formatSettlementNotice(
  agentId: string,
  closingMessage: string | null,
  nullReason: SettlementNullReason = 'silent',
): string {
  const head = `Background subagent ${agentId} finished and will do no further work unless you send it more.`;
  return closingMessage
    ? `${head} Its closing message: ${closingMessage}`
    : `${head} ${NULL_CLOSING_SENTENCE[nullReason]}`;
}
