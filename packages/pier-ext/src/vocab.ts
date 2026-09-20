/**
 * pi-herdr bridge vocabulary (M22: title is the board).
 *
 * DESIGN.md §4.2: no new transport. Wire = herdr NDJSON; todo authority = pi
 * session JSONL; display = pane.report_metadata title / state_labels.
 */

/** Todo five-state (D34: three-state + blocked/abandoned, aligned with OMP). */
export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'blocked' | 'abandoned';

export const TODO_STATUSES: readonly TodoStatus[] = ['pending', 'in_progress', 'completed', 'blocked', 'abandoned'];

/** Todo item: content + status; optional blocker (blocked only) and phase (D43). No stable id (last-write-wins). */
export interface TodoItem {
  content: string;
  status: TodoStatus;
  /** Non-empty string only when status==='blocked' (D34). */
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

/** Snapshot counts (confirmation copy and title projection). */
export interface TodoCounts {
  pending: number;
  inProgress: number;
  completed: number;
  /** D91: blocked as its own column (title quartet ▶○■✓). */
  blocked: number;
}

/** Source name for pane.report-agent. */
export const REPORT_AGENT_SOURCE = 'pi-herdr';

/** First-upgrade key used to clear the old 16-key chunked tokens (M13b leftover). */
export const PI_HERDR_META_KEY = 'pi-herdr';

/** Model-facing todo tool name (DSH-compatible). */
export const TODO_TOOL_NAME = 'todo_write';

/** Snapshot key in tool-result details (persisted in session JSONL). */
export const TODO_DETAILS_KEY = 'pi-herdr.todo';

/** Confirmation copy (byte-aligned with DSH so model vocab transfers; blocked is appended only when present). */
export function formatTodoConfirmation(items: readonly TodoItem[]): string {
  const c = countTodos(items);
  const base = `Updated todo list: ${c.pending} pending, ${c.inProgress} in progress, ${c.completed} completed.`;
  // A4: blocked items used to be invisible here (the model read "nothing pending" while items sat
  // blocked waiting on a human). Appending only when non-zero keeps the DSH-aligned wording intact.
  return c.blocked > 0 ? `${base.slice(0, -1)}, ${c.blocked} blocked.` : base;
}

export function countTodos(items: readonly TodoItem[]): TodoCounts {
  let pending = 0;
  let inProgress = 0;
  let completed = 0;
  let blocked = 0;
  for (const it of items) {
    if (it.status === 'pending') pending++;
    else if (it.status === 'in_progress') inProgress++;
    else if (it.status === 'completed') completed++;
    else if (it.status === 'blocked') blocked++;
    // abandoned is omitted (D34); blocked is its own column (D91)
  }
  return { pending, inProgress, completed, blocked };
}

/** Why a settlement carried no closing text (p24-class mis-attribution vs a truly silent worker). */
export type SettlementNullReason = 'silent' | 'attribution-suspect' | 'extraction-failed';

function nullClosingSentence(reason: SettlementNullReason): string {
  if (reason === 'attribution-suspect') {
    return 'Its closing message could NOT be read — the session attribution is suspect (a wrong transcript may have been read). Check `subagent action output` / the ledger sessionFile before assuming it produced nothing; its work may be complete.';
  }
  if (reason === 'extraction-failed') {
    return 'It appears to have ended with a final report, but the closing text could not be extracted — read it from the session transcript.';
  }
  return 'It left no closing message.';
}

/** Subagent settlement notice (aligned with DSH). */
export function formatSettlementNotice(
  agentId: string,
  closingMessage: string | null,
  nullReason: SettlementNullReason = 'silent',
): string {
  const head = `Background subagent ${agentId} finished and will do no further work unless you send it more.`;
  return closingMessage
    ? `${head} Its closing message: ${closingMessage}`
    : `${head} ${nullClosingSentence(nullReason)}`;
}
