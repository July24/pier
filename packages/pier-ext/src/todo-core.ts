/** Why: Preserve the established compatibility and safety behavior (D34–D43, M10). */
import {
  TODO_DETAILS_KEY,
  TODO_STATUSES,
  TODO_TOOL_NAME,
  type TodoCounts,
  type TodoItem,
  type TodoSnapshot,
  type TodoStatus,
} from './vocab.ts';
import { countTodos } from './vocab.ts';

export type { TodoItem, TodoSnapshot, TodoStatus, TodoCounts };

/** Why: Preserve the established compatibility and safety behavior (D43). */
export const PHASE_MAX_LEN = 30;

/** Why: Preserve the established compatibility and safety behavior (D38). */
export const TODO_EDIT_CUSTOM_TYPE = 'pi-herdr.todo-edit';

/** Why: Preserve the established compatibility and safety behavior (D38, M17). */
export type TodoEditOp = 'done' | 'drop' | 'rm' | 'unblock';

export interface TodoEdit {
  op: TodoEditOp;
  content: string;
}

export interface TodoEditPayload {
  version: 1;
  edits: TodoEdit[];
  ts: number;
}

export interface TodoValidationResult {
  ok: boolean;
  items?: TodoItem[];
  error?: string;
}

/** Why: Preserve the established compatibility and safety behavior (B2, D34, D43). */
export function validateTodos(
  todos: unknown,
  allowParallelInProgress = true,
): TodoValidationResult {
  if (!Array.isArray(todos)) {
    return { ok: false, error: 'invalid todos: `todos` must be an array' };
  }
  const seen = new Set<string>();
  let inProgress = 0;
  const items: TodoItem[] = [];
  for (const raw of todos) {
    if (typeof raw !== 'object' || raw === null) {
      return { ok: false, error: 'invalid todos: each todo must be an object' };
    }
    const entry = raw as Record<string, unknown>;
    const allowed = ['content', 'status', 'blocker', 'phase'];
    const keys = Object.keys(entry);
    for (const k of keys) {
      if (!allowed.includes(k)) {
        return { ok: false, error: `invalid todos: unknown field "${k}" (allowed: content, status, blocker, phase)` };
      }
    }
    if (!('content' in entry) || !('status' in entry)) {
      return { ok: false, error: 'invalid todos: each todo must have `content` and `status`' };
    }
    const content = entry.content;
    if (typeof content !== 'string' || content.trim() === '') {
      return { ok: false, error: 'invalid todo: `content` must be a non-empty string' };
    }
    if (seen.has(content)) {
      return { ok: false, error: `invalid todos: duplicate content "${content}"` };
    }
    seen.add(content);
    const status = entry.status;
    if (typeof status !== 'string' || !(TODO_STATUSES as readonly string[]).includes(status)) {
      return { ok: false, error: `invalid todo: \`status\` must be one of ${TODO_STATUSES.join('|')}` };
    }
    const item: TodoItem = { content, status: status as TodoStatus };
    if ('blocker' in entry) {
      const blocker = entry.blocker;
      // Why: Preserve the established compatibility and safety behavior.
      // Why: Preserve the established compatibility and safety behavior.
      // Why: Preserve the established compatibility and safety behavior.
      if (blocker != null && typeof blocker !== 'string') {
        return { ok: false, error: 'invalid todo: `blocker` must be a non-empty string' };
      }
      if (status === 'blocked') {
        if (typeof blocker !== 'string' || blocker.trim() === '') {
          return { ok: false, error: 'invalid todo: `blocker` must be a non-empty string' };
        }
        item.blocker = blocker;
      }
    }
    if ('phase' in entry) {
      const phase = entry.phase;
      if (phase != null && typeof phase !== 'string') {
        return { ok: false, error: `invalid todo: \`phase\` must be a non-empty string ≤ ${PHASE_MAX_LEN} chars` };
      }
      // Why: Preserve the established compatibility and safety behavior.
      if (typeof phase === 'string') {
        if (phase.length > PHASE_MAX_LEN) {
          return { ok: false, error: `invalid todo: \`phase\` must be a non-empty string ≤ ${PHASE_MAX_LEN} chars` };
        }
        if (phase.trim() !== '') item.phase = phase;
      }
    }
    if (status === 'in_progress') {
      inProgress++;
      if (!allowParallelInProgress && inProgress > 1) {
        return {
          ok: false,
          error: `invalid todos: at most one task may be in_progress (got ${inProgress})`,
        };
      }
    }
    items.push(item);
  }
  return { ok: true, items };
}

/** Why: Preserve the established compatibility and safety behavior (D42). */
export function normalizeStrict(items: readonly TodoItem[]): TodoItem[] {
  if (items.length === 0) return [];
  const out = items.map((it) => ({ ...it }));
  let kept = false;
  for (const it of out) {
    if (it.status === 'in_progress') {
      if (kept) it.status = 'pending';
      else kept = true;
    }
  }
  if (!kept) {
    const firstPending = out.find((it) => it.status === 'pending');
    if (firstPending) firstPending.status = 'in_progress';
  }
  return out;
}

/** Why: Preserve the established compatibility and safety behavior (D35). */
export function listsEqual(a: readonly TodoItem[], b: readonly TodoItem[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.content !== y.content || x.status !== y.status || x.blocker !== y.blocker || x.phase !== y.phase) return false;
  }
  return true;
}

/** Why: Preserve the established compatibility and safety behavior (D36). */
export function completionTransitions(prev: readonly TodoItem[], next: readonly TodoItem[]): string[] {
  const prevMap = new Map(prev.map((it) => [it.content, it.status]));
  const out: string[] = [];
  for (const it of next) {
    if (it.status === 'completed' && prevMap.get(it.content) !== 'completed') out.push(it.content);
  }
  return out;
}

/** Why: Preserve the established compatibility and safety behavior (D37). */
export function revertedCompleted(prev: readonly TodoItem[], next: readonly TodoItem[]): string[] {
  const nextMap = new Map(next.map((it) => [it.content, it.status]));
  const out: string[] = [];
  for (const it of prev) {
    if (it.status !== 'completed') continue;
    const now = nextMap.get(it.content);
    if (now === 'pending' || now === 'in_progress') out.push(it.content);
  }
  return out;
}

/** Why: Preserve the established compatibility and safety behavior. */
export function makeSnapshot(items: TodoItem[]): TodoSnapshot {
  return { version: 1, items };
}

export interface BranchEntryLike {
  /** Why: Preserve the established compatibility and safety behavior. */
  type?: string;
  /** Why: Preserve the established compatibility and safety behavior. */
  timestamp?: unknown;
  message?: {
    role?: string;
    toolName?: string;
    details?: Record<string, unknown> | unknown;
  } | unknown;
  customType?: string;
  data?: unknown;
}

/** Why: Preserve the established compatibility and safety behavior (D37, D38, M17). */
export function applyTodoEdits(items: readonly TodoItem[], edits: readonly TodoEdit[]): TodoItem[] {
  let out = items.map((it) => ({ ...it }));
  for (const edit of edits) {
    const target = out.find((it) => it.content === edit.content);
    if (!target) continue;
    switch (edit.op) {
      case 'done':
        if (target.status !== 'completed') {
          target.status = 'completed';
          delete target.blocker;
        }
        break;
      case 'drop':
        if (target.status !== 'completed' && target.status !== 'abandoned') {
          target.status = 'abandoned';
          delete target.blocker;
        }
        break;
      case 'rm':
        out = out.filter((it) => it.content !== edit.content);
        break;
      case 'unblock':
        if (target.status === 'blocked') {
          target.status = 'pending';
          delete target.blocker;
        }
        break;
    }
  }
  return out;
}

function extractEditPayload(data: unknown): TodoEditPayload | null {
  if (typeof data !== 'object' || data === null) return null;
  const raw = data as Partial<TodoEditPayload>;
  if (raw.version !== 1 || !Array.isArray(raw.edits)) return null;
  const edits: TodoEdit[] = [];
  for (const e of raw.edits) {
    if (
      typeof e === 'object' && e !== null &&
      (e.op === 'done' || e.op === 'drop' || e.op === 'rm' || e.op === 'unblock') &&
      typeof (e as TodoEdit).content === 'string'
    ) {
      edits.push({ op: (e as TodoEdit).op, content: (e as TodoEdit).content });
    }
  }
  if (edits.length === 0) return null;
  return { version: 1, edits, ts: typeof raw.ts === 'number' ? raw.ts : 0 };
}

/** Why: Preserve the established compatibility and safety behavior (D38). */
export interface FoldedTodos {
  items: TodoItem[];
  /** Why: Preserve the established compatibility and safety behavior. */
  writtenAt: number | null;
}

function entryTimestamp(entry: BranchEntryLike): number | null {
  const ts = entry.timestamp;
  if (typeof ts === 'number') return ts;
  if (typeof ts === 'string') {
    const parsed = Date.parse(ts);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/** Why: Preserve the established compatibility and safety behavior (D38). */
export function foldLatestTodosMeta(entries: readonly BranchEntryLike[]): FoldedTodos | null {
  let found: TodoItem[] | null = null;
  let writtenAt: number | null = null;
  for (const entry of entries) {
    if (entry.type === 'message') {
      const msg = entry.message;
      if (typeof msg !== 'object' || msg === null) continue;
      if (msg.role !== 'toolResult' || msg.toolName !== TODO_TOOL_NAME) continue;
      const snapshot = extractSnapshotFromDetails(msg.details);
      if (snapshot) {
        found = snapshot.items.map((it) => ({ ...it }));
        writtenAt = entryTimestamp(entry);
      }
    } else if (entry.type === 'custom' && entry.customType === TODO_EDIT_CUSTOM_TYPE) {
      const payload = extractEditPayload(entry.data);
      if (payload && found) {
        found = applyTodoEdits(found, payload.edits);
        writtenAt = entryTimestamp(entry) ?? (payload.ts > 0 ? payload.ts : writtenAt);
      }
    }
  }
  return found ? { items: found, writtenAt } : null;
}

/** Why: Preserve the established compatibility and safety behavior. */
export function foldLatestTodos(entries: readonly BranchEntryLike[]): TodoItem[] | null {
  return foldLatestTodosMeta(entries)?.items ?? null;
}

export function extractSnapshotFromDetails(details: unknown): TodoSnapshot | null {
  if (typeof details !== 'object' || details === null) return null;
  const raw = (details as Record<string, unknown>)[TODO_DETAILS_KEY];
  if (typeof raw !== 'object' || raw === null) return null;
  const snap = raw as Partial<TodoSnapshot>;
  if (snap.version !== 1 || !Array.isArray(snap.items)) return null;
  return { version: 1, items: snap.items as TodoItem[] };
}

/** Why: Preserve the established compatibility and safety behavior (D38). */
export function fuzzyFind(items: readonly TodoItem[], query: string): string[] {
  const q = query.trim();
  if (!q) return [];
  const exact = items.filter((it) => it.content === q);
  if (exact.length > 0) return [exact[0].content];
  const prefix = items.filter((it) => it.content.startsWith(q));
  if (prefix.length === 1) return [prefix[0].content];
  if (prefix.length > 1) return prefix.map((it) => it.content);
  const substr = items.filter((it) => it.content.includes(q));
  return substr.map((it) => it.content);
}

/** Why: Preserve the established compatibility and safety behavior (D39). */
export interface BoundedView {
  visible: TodoItem[];
  /** Why: Preserve the established compatibility and safety behavior. */
  hiddenCompleted: number;
  hiddenOpen: number;
}

export function boundedView(items: readonly TodoItem[], budget: number): BoundedView {
  if (items.length <= budget) {
    return { visible: items.map((it) => ({ ...it })), hiddenCompleted: 0, hiddenOpen: 0 };
  }
  const completed = items.filter((it) => it.status === 'completed');
  const open = items.filter((it) => it.status !== 'completed');
  // Why: Preserve the established compatibility and safety behavior.
  // Why: Preserve the established compatibility and safety behavior.
  const visible = open.length > budget ? open.slice(-budget) : open;
  const hiddenOpen = open.length - visible.length;
  let hiddenCompleted = completed.length;
  let final = visible;
  if (hiddenOpen === 0 && visible.length < budget) {
    const room = budget - visible.length;
    final = [...visible, ...completed.slice(-room)];
    hiddenCompleted = completed.length - room;
  }
  return { visible: final, hiddenCompleted, hiddenOpen };
}

/** Why: Preserve the established compatibility and safety behavior. */
export function currentActivity(items: TodoItem[]): string | null {
  return items.find((it) => it.status === 'in_progress')?.content ?? null;
}

export { countTodos };
