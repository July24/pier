/**
 * todo 纯逻辑：校验 / 折叠 / M10 增量（D34–D43）。
 *
 * 全部无副作用、无 pi API 依赖 → 可单测（node --test 直接跑 TS）。
 * 语义 = DESIGN.md §5.1.1 + §15：全量替换（last-wins），五态 + blocker + phase。
 */
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

/** D43：phase 名长度上限。 */
export const PHASE_MAX_LEN = 30;

/** D38：人类编辑 custom 条目类型（/todos done/drop/rm 写回权威的通道）。 */
export const TODO_EDIT_CUSTOM_TYPE = 'pi-herdr.todo-edit';

/** 人类编辑操作（D38）：done=completed、drop=abandoned、rm=移除、unblock=blocked→pending（M17）。 */
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

/**
 * 校验一次 todo_write 的入参并规范化为条目数组（D34/D43 扩展）。
 * 规则：
 *  - todos 必须是数组（空数组合法 = 清空列表）；
 *  - 每条允许键 = content/status/blocker/phase，不允许其他键；
 *  - content 非空且全局唯一；status ∈ 五态；
 *  - blocker 仅 status==='blocked' 时允许（非空字符串），其他状态携带即拒绝；
 *  - phase 可选：非空、≤30 字符；
 *  - allowParallelInProgress=false 时，至多一条 in_progress（B2 严格模式的第一道闸）。
 */
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
      if (status !== 'blocked') {
        return { ok: false, error: `invalid todo: \`blocker\` is only allowed when status is "blocked" (got "${status}")` };
      }
      if (typeof blocker !== 'string' || blocker.trim() === '') {
        return { ok: false, error: 'invalid todo: `blocker` must be a non-empty string' };
      }
      item.blocker = blocker;
    }
    if ('phase' in entry) {
      const phase = entry.phase;
      if (typeof phase !== 'string' || phase.trim() === '' || phase.length > PHASE_MAX_LEN) {
        return { ok: false, error: `invalid todo: \`phase\` must be a non-empty string ≤ ${PHASE_MAX_LEN} chars` };
      }
      item.phase = phase;
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

/**
 * D42 严格模式归一化（OMP normalizeInProgressTask 语义，按 pane 角色自动推导）：
 *  - 多余 in_progress（列表顺序第二条起）退回 pending；
 *  - 无 in_progress 且有 pending → 晋升列表顺序第一条 pending；
 *  - blocked/abandoned 不参与晋升。
 * 返回新数组（不改入参）。
 */
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

/** D35：逐项全等比较（content/status/blocker/phase），用于 no-op 检测。 */
export function listsEqual(a: readonly TodoItem[], b: readonly TodoItem[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.content !== y.content || x.status !== y.status || x.blocker !== y.blocker || x.phase !== y.phase) return false;
  }
  return true;
}

/** D36：本轮新变为 completed 的 content 列表（prev → next）。 */
export function completionTransitions(prev: readonly TodoItem[], next: readonly TodoItem[]): string[] {
  const prevMap = new Map(prev.map((it) => [it.content, it.status]));
  const out: string[] = [];
  for (const it of next) {
    if (it.status === 'completed' && prevMap.get(it.content) !== 'completed') out.push(it.content);
  }
  return out;
}

/** D37：上轮 completed、本轮退回 pending/in_progress 的 content 列表（软警告用）。 */
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

/** 构造持久化快照（version 字段让消费方在未来形状变化时丢弃陈旧数据）。 */
export function makeSnapshot(items: TodoItem[]): TodoSnapshot {
  return { version: 1, items };
}

export interface BranchEntryLike {
  /** pi 会话条目：type 为 'message' 的消息条目或 'custom' 的自定义条目。 */
  type?: string;
  message?: {
    role?: string;
    toolName?: string;
    details?: Record<string, unknown> | unknown;
  } | unknown;
  customType?: string;
  data?: unknown;
}

/**
 * D38：在列表上应用人类编辑（幂等：目标不存在则 no-op）。
 *  - done：pending/in_progress/blocked → completed；completed 保持（completed 不可逆，D37）；
 *  - drop：非 completed/abandoned → abandoned；
 *  - rm：移除（任意状态）；
 *  - unblock（M17）：blocked → pending（清 blocker）；非 blocked 为 no-op。
 */
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

/**
 * 从 pi 会话分支条目里折叠出最新 todo 列表（D38 双源）：
 *  - toolResult(todo_write) → 快照替换（last-wins）；
 *  - custom(pi-herdr.todo-edit) → 在当前列表上应用 edits（人类编辑）。
 * 分支正确性 = 沿分支路径顺序折叠。
 */
export function foldLatestTodos(entries: readonly BranchEntryLike[]): TodoItem[] | null {
  let found: TodoItem[] | null = null;
  for (const entry of entries) {
    if (entry.type === 'message') {
      const msg = entry.message;
      if (typeof msg !== 'object' || msg === null) continue;
      if (msg.role !== 'toolResult' || msg.toolName !== TODO_TOOL_NAME) continue;
      const snapshot = extractSnapshotFromDetails(msg.details);
      if (snapshot) found = snapshot.items.map((it) => ({ ...it }));
    } else if (entry.type === 'custom' && entry.customType === TODO_EDIT_CUSTOM_TYPE) {
      const payload = extractEditPayload(entry.data);
      if (payload && found) found = applyTodoEdits(found, payload.edits);
    }
  }
  return found;
}

export function extractSnapshotFromDetails(details: unknown): TodoSnapshot | null {
  if (typeof details !== 'object' || details === null) return null;
  const raw = (details as Record<string, unknown>)[TODO_DETAILS_KEY];
  if (typeof raw !== 'object' || raw === null) return null;
  const snap = raw as Partial<TodoSnapshot>;
  if (snap.version !== 1 || !Array.isArray(snap.items)) return null;
  return { version: 1, items: snap.items as TodoItem[] };
}

/** D38：模糊匹配（精确 → 前缀 → 子串），返回候选 content 列表（多候选 = 歧义）。 */
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

/** D39：有界视图选择——先丢 completed、再截 open；两端都超额时保最新（尾部切片）。 */
export interface BoundedView {
  visible: TodoItem[];
  /** 被隐藏的数量按状态计数（completed 单独计，其余合并）。 */
  hiddenCompleted: number;
  hiddenOpen: number;
}

export function boundedView(items: readonly TodoItem[], budget: number): BoundedView {
  if (items.length <= budget) {
    return { visible: items.map((it) => ({ ...it })), hiddenCompleted: 0, hiddenOpen: 0 };
  }
  const completed = items.filter((it) => it.status === 'completed');
  const open = items.filter((it) => it.status !== 'completed');
  // 修正（用户实证）：widget 是头部可见窗口——超预算必须隐最老（丢头部），保最新可见；
  // 旧实现 slice(0, budget) 保最老，最新任务永远落在窗口外。
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

/** 当前 in_progress 中的第一条（上报 agent 状态时作为 message，供侧边栏显示"正在做什么"）。 */
export function currentActivity(items: TodoItem[]): string | null {
  return items.find((it) => it.status === 'in_progress')?.content ?? null;
}

export { countTodos };
