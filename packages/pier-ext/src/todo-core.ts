/** Pure todo-list core: validation, diffing, edit and branch-replay folding (D34–D43, M10). */
import { TODO_DETAILS_KEY, TODO_STATUSES, TODO_TOOL_NAME, type TodoItem, type TodoSnapshot, type TodoStatus } from './vocab.ts';

export type { TodoItem, TodoSnapshot, TodoStatus };

/** D43 phase label cap, mirrored by the todo_write tool description. */
const PHASE_MAX_LEN = 30;

/** Session entry type for human/automated edits, replayed during branch rebuild (D38). */
export const TODO_EDIT_CUSTOM_TYPE = 'pi-herdr.todo-edit';

/** Session entry type recording that the near-archive rewrite window was already offered for one
 *  list; folded on rebuild so a resumed session proceeds to the terminal clear instead of re-warning. */
export const TODO_ARCHIVE_WINDOW_CUSTOM_TYPE = 'pi-herdr.todo-archive-window';

export interface ArchiveWindowMarker {
  version: 1;
  /** Ordered list identity at offer time. The marker only applies after the last snapshot, so any
   *  rewrite (new snapshot) or edit (list mutation) invalidates it without a timestamp comparison. */
  itemsHash: string;
}

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

export function validateTodos(
  todos: unknown,
  allowParallelInProgress = true,
): TodoValidationResult {
  if (!Array.isArray(todos)) return { ok: false, error: 'invalid todos: `todos` must be an array' };
  const seen = new Set<string>();
  let inProgress = 0;
  const items: TodoItem[] = [];
  for (const raw of todos) {
    if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'invalid todos: each todo must be an object' };
    const entry = raw as Record<string, unknown>;
    const unknownField = Object.keys(entry).find((k) => !['content', 'status', 'blocker', 'phase'].includes(k));
    if (unknownField) {
      return { ok: false, error: `invalid todos: unknown field "${unknownField}" (allowed: content, status, blocker, phase)` };
    }
    if (!('content' in entry) || !('status' in entry)) {
      return { ok: false, error: 'invalid todos: each todo must have `content` and `status`' };
    }
    const content = entry.content;
    if (typeof content !== 'string' || content.trim() === '') {
      return { ok: false, error: 'invalid todo: `content` must be a non-empty string' };
    }
    if (seen.has(content)) return { ok: false, error: `invalid todos: duplicate content "${content}"` };
    seen.add(content);
    const status = entry.status;
    if (typeof status !== 'string' || !(TODO_STATUSES as readonly string[]).includes(status)) {
      return { ok: false, error: `invalid todo: \`status\` must be one of ${TODO_STATUSES.join('|')}` };
    }
    const item: TodoItem = { content, status: status as TodoStatus };
    // blocker/phase tolerate empty-string filler (models fill optional fields with ''), but a
    // malformed type is a hard reject: it would hide intent.
    if ('blocker' in entry) {
      const blocker = entry.blocker;
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
      const phaseError = { ok: false, error: `invalid todo: \`phase\` must be a non-empty string ≤ ${PHASE_MAX_LEN} chars` };
      if (phase != null && typeof phase !== 'string') return phaseError;
      if (typeof phase === 'string') {
        if (phase.length > PHASE_MAX_LEN) return phaseError;
        if (phase.trim() !== '') item.phase = phase;
      }
    }
    if (status === 'in_progress' && ++inProgress > 1 && !allowParallelInProgress) {
      return { ok: false, error: `invalid todos: at most one task may be in_progress (got ${inProgress})` };
    }
    items.push(item);
  }
  return { ok: true, items };
}

/** Keep exactly one in_progress item, promoting the first pending one when none exists (D42). */
export function normalizeStrict(items: readonly TodoItem[]): TodoItem[] {
  if (items.length === 0) return [];
  const out = items.map((it) => ({ ...it }));
  let kept = false;
  for (const it of out) {
    if (it.status !== 'in_progress') continue;
    if (kept) it.status = 'pending';
    else kept = true;
  }
  if (!kept) {
    const firstPending = out.find((it) => it.status === 'pending');
    if (firstPending) firstPending.status = 'in_progress';
  }
  return out;
}

export function listsEqual(a: readonly TodoItem[], b: readonly TodoItem[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.content !== y.content || x.status !== y.status || x.blocker !== y.blocker || x.phase !== y.phase) return false;
  }
  return true;
}

/** Stable list identity (FNV-1a over content/status/blocker/phase): keys the archive-window marker
 *  so it never applies to a list that was edited after the window was offered. */
export function todoListHash(items: readonly TodoItem[]): string {
  let hash = 0x811c9dc5;
  for (const it of items) {
    const text = `${it.content}\u0000${it.status}\u0000${it.blocker ?? ''}\u0000${it.phase ?? ''}\u0001`;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Items completed by this write (D36: surfaced back to the caller). */
export function completionTransitions(prev: readonly TodoItem[], next: readonly TodoItem[]): string[] {
  const prevMap = new Map(prev.map((it) => [it.content, it.status]));
  return next
    .filter((it) => it.status === 'completed' && prevMap.get(it.content) !== 'completed')
    .map((it) => it.content);
}

/** Completed items pushed back to open by this write (D37: reversible, but warn). A previous list
 *  with no open item was a finished plan, and a new plan legitimately reuses generic task names, so
 *  content-keyed reversion is meaningless there: warn only while the same plan is still in flight. */
export function revertedCompleted(prev: readonly TodoItem[], next: readonly TodoItem[]): string[] {
  if (!prev.some((it) => it.status === 'pending' || it.status === 'in_progress')) return [];
  const nextMap = new Map(next.map((it) => [it.content, it.status]));
  return prev
    .filter((it) => {
      if (it.status !== 'completed') return false;
      const now = nextMap.get(it.content);
      return now === 'pending' || now === 'in_progress';
    })
    .map((it) => it.content);
}

export function makeSnapshot(items: readonly TodoItem[]): TodoSnapshot {
  // Copy: the snapshot is persisted, the service list stays owned by TodosService.
  return { version: 1, items: [...items] };
}

/** Loose shape of pi session JSONL entries we fold over; only the fields we read. */
interface BranchEntryLike {
  type?: string;
  timestamp?: unknown;
  message?: {
    role?: string;
    toolName?: string;
    details?: Record<string, unknown> | unknown;
  } | unknown;
  customType?: string;
  data?: unknown;
}

/** Edit semantics (D37/D38): done/drop keep completed|abandoned terminal; unblock returns blocked to pending. */
export function applyTodoEdits(items: readonly TodoItem[], edits: readonly TodoEdit[]): TodoItem[] {
  let out = items.map((it) => ({ ...it }));
  for (const edit of edits) {
    if (edit.op === 'rm') {
      out = out.filter((it) => it.content !== edit.content);
      continue;
    }
    const target = out.find((it) => it.content === edit.content);
    if (!target) continue;
    switch (edit.op) {
      case 'done':
        if (target.status === 'completed') break;
        target.status = 'completed';
        delete target.blocker;
        break;
      case 'drop':
        if (target.status === 'completed' || target.status === 'abandoned') break;
        target.status = 'abandoned';
        delete target.blocker;
        break;
      case 'unblock':
        if (target.status !== 'blocked') break;
        target.status = 'pending';
        delete target.blocker;
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

export interface FoldedTodos {
  items: TodoItem[];
  /** Timestamp of the last write that shaped these items; null when the entry carried none. */
  writtenAt: number | null;
  /** True when the anti-freeze rewrite window was already offered for exactly this untouched list. */
  archiveWindowOffered: boolean;
}

function extractArchiveWindowMarker(data: unknown): ArchiveWindowMarker | null {
  if (typeof data !== 'object' || data === null) return null;
  const raw = data as Partial<ArchiveWindowMarker>;
  if (raw.version !== 1 || typeof raw.itemsHash !== 'string') return null;
  return { version: 1, itemsHash: raw.itemsHash };
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

/** Fold the branch to the authoritative list: last todo snapshot, then interleaved edits (D38). */
export function foldLatestTodosMeta(entries: readonly BranchEntryLike[]): FoldedTodos | null {
  let found: TodoItem[] | null = null;
  let writtenAt: number | null = null;
  // The marker applies only when it follows the last snapshot; a later snapshot resets it, and any
  // edit that actually changes the list makes the hash mismatch (a no-op edit leaves it untouched).
  let windowMarker: ArchiveWindowMarker | null = null;
  for (const entry of entries) {
    if (entry.type === 'message') {
      const msg = entry.message as { role?: unknown; toolName?: unknown; details?: unknown } | null | undefined;
      if (typeof msg !== 'object' || msg === null) continue;
      if (msg.role !== 'toolResult' || msg.toolName !== TODO_TOOL_NAME) continue;
      const snapshot = extractSnapshotFromDetails(msg.details);
      if (snapshot) {
        found = snapshot.items.map((it) => ({ ...it }));
        writtenAt = entryTimestamp(entry);
        windowMarker = null;
      }
    } else if (entry.type === 'custom' && entry.customType === TODO_EDIT_CUSTOM_TYPE) {
      const payload = extractEditPayload(entry.data);
      if (payload && found) {
        found = applyTodoEdits(found, payload.edits);
        writtenAt = entryTimestamp(entry) ?? (payload.ts > 0 ? payload.ts : writtenAt);
      }
    } else if (entry.type === 'custom' && entry.customType === TODO_ARCHIVE_WINDOW_CUSTOM_TYPE && found) {
      windowMarker = extractArchiveWindowMarker(entry.data);
    }
  }
  if (!found) return null;
  const archiveWindowOffered = windowMarker != null && windowMarker.itemsHash === todoListHash(found);
  return { items: found, writtenAt, archiveWindowOffered };
}

function extractSnapshotFromDetails(details: unknown): TodoSnapshot | null {
  if (typeof details !== 'object' || details === null) return null;
  const raw = (details as Record<string, unknown>)[TODO_DETAILS_KEY];
  if (typeof raw !== 'object' || raw === null) return null;
  const snap = raw as Partial<TodoSnapshot>;
  if (snap.version !== 1 || !Array.isArray(snap.items)) return null;
  return { version: 1, items: snap.items as TodoItem[] };
}

/** Exact match, then unique prefix, then substring candidates (D38 `/todos <verb> <query>`). */
export function fuzzyFind(items: readonly TodoItem[], query: string): string[] {
  const q = query.trim();
  if (!q) return [];
  const exact = items.filter((it) => it.content === q);
  if (exact.length > 0) return [exact[0].content];
  const prefix = items.filter((it) => it.content.startsWith(q));
  if (prefix.length === 1) return [prefix[0].content];
  if (prefix.length > 1) return prefix.map((it) => it.content);
  return items.filter((it) => it.content.includes(q)).map((it) => it.content);
}

export interface BoundedView {
  visible: TodoItem[];
  hiddenCompleted: number;
  hiddenOpen: number;
}

/** Keep the newest open items, then fill leftover budget with the newest completions (D39). */
export function boundedView(items: readonly TodoItem[], budget: number): BoundedView {
  if (items.length <= budget) {
    return { visible: items.map((it) => ({ ...it })), hiddenCompleted: 0, hiddenOpen: 0 };
  }
  const completed = items.filter((it) => it.status === 'completed');
  const open = items.filter((it) => it.status !== 'completed');
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

export function currentActivity(items: readonly TodoItem[]): string | null {
  return items.find((it) => it.status === 'in_progress')?.content ?? null;
}
