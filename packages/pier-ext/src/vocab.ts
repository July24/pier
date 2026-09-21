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

/** Model-facing todo tool name (DSH-compatible). */
export const TODO_TOOL_NAME = 'todo_write';

/** Snapshot key in tool-result details (persisted in session JSONL). */
export const TODO_DETAILS_KEY = 'pi-herdr.todo';

/** Confirmation copy (byte-aligned with DSH so model vocab transfers). */
export function formatTodoConfirmation(items: readonly TodoItem[]): string {
  const c = countTodos(items);
  const base = `Updated todo list: ${c.pending} pending, ${c.inProgress} in progress, ${c.completed} completed.`;
  // A4: append blocked only when non-zero — the model must not read "nothing pending" while
  // items sit blocked on a human. Zero keeps the DSH-aligned wording intact.
  return c.blocked > 0 ? `${base.slice(0, -1)}, ${c.blocked} blocked.` : base;
}

/** abandoned is deliberately uncounted; blocked is its own column (D34/D91). */
const COUNTED_STATUSES: Partial<Record<TodoStatus, keyof TodoCounts>> = {
  pending: 'pending',
  in_progress: 'inProgress',
  completed: 'completed',
  blocked: 'blocked',
};

export function countTodos(items: readonly TodoItem[]): TodoCounts {
  const counts: TodoCounts = { pending: 0, inProgress: 0, completed: 0, blocked: 0 };
  for (const it of items) {
    const key = COUNTED_STATUSES[it.status];
    if (key) counts[key] += 1;
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
