/**
 * 档1 core/todo（todo 族迁 loader entry —— D78 挂载树 / D81 融合核心）。
 *
 * 形态：cordis 插件（master 经 loader.create 挂 = 热换面；worker 裸根手动 mount，
 * D81 one-shot 裁剪）。依赖全部经服务注入：
 *  - `pi-herdr.surface`：pi 注册面代理（D79 tombstone）；
 *  - `pi-herdr.todo-deps`：todos 服务（session 状态层，留在 index）+ options +
 *    mirrorTodos 回调 + appendEntry + state 槽（renderWidget 回填给 index 生命周期）。
 *
 * 本文件承接：todo_write 工具 + /todos 命令（查看/编辑）+ TUI widget（widgetLines/
 * renderWidget）+ 读钩（before_agent_start planTodoReadHook，
 * 轮次计数器内聚）。reconcile / 镜像 / reportAgent 仍在 index（session 状态层）。
 */
import { Context } from '@deepseek-ai/cordis';
import { Type } from 'typebox';
import type { PiSurface } from '../pi-surface.ts';
import type { TodosService } from '../todos-service.ts';
import { planTodoReadHook } from '../todo-read-hook.ts';
import { makeProgressUpdate } from '../subagent-core.ts';
import { TODO_DETAILS_KEY, TODO_TOOL_NAME, formatTodoConfirmation, type TodoItem, type TodoStatus } from '../vocab.ts';
import { formatAge, isArchived } from '../stale-core.ts';
import {
  TODO_EDIT_CUSTOM_TYPE,
  completionTransitions,
  countTodos,
  fuzzyFind,
  listsEqual,
  makeSnapshot,
  normalizeStrict,
  revertedCompleted,
  validateTodos,
} from '../todo-core.ts';

export interface TodoUiSlot {
  /** index 的 session_start/session_tree 生命周期调用（plugin 回填）。 */
  renderWidget: (ctx: unknown) => void;
}

export interface TodoDeps {
  todos: TodosService;
  allowParallelInProgress: boolean;
  /** 软上限提示（不硬拒）。 */
  maxItems: number;
  mirrorTodos: () => void;
  appendEntry: (customType: string, data: unknown) => void;
  state: TodoUiSlot;
}

const TOOL_DESCRIPTION = [
  'Record and update the complete task list for the current work. Every call REPLACES the entire list (last write wins), so always resend the full list.',
  'Entries: `content` (non-empty, unique; short imperative, what-not-how; no numbering prefixes), `status` (pending | in_progress | completed | blocked | abandoned), optional `blocker` (only when blocked: what it is waiting for), optional `phase` (group name for multi-stage plans; omit for a flat list).',
  'Keep the list short (at most 15 entries): one entry per meaningful unit of work, not per micro-step.',
  'Mark tasks you are actively working on as in_progress; several may be in_progress when work genuinely runs in parallel.',
  'Before stopping, reconcile open entries: anything waiting on a human (decision, approval, or an ops action you cannot perform) must be marked blocked with a blocker note — never left pending, and never executed just to clear the list; finished or obsolete entries must be completed or removed.',
  'Do not make todo_write the only tool call of a turn — batch it together with real work.',
  'Delegated work belongs on this list too. When you hand an entry to a subagent, append ` <sub>` to its content (the subagent is doing it, not you); when the subagent settles, a matching entry is auto-completed — you will see "Reconciled:" in the settlement note. If no auto-match fired, update the entry yourself.',
].join(' ');

const TODO_MARKS: Record<TodoStatus, string> = {
  pending: '○',
  in_progress: '▶',
  completed: '✓',
  blocked: '■',
  abandoned: '✗',
};

/** pi TUI widget 硬上限（interactive-mode MAX_WIDGET_LINES=10，头部截断；我们自己控制在限内）。 */
export const WIDGET_MAX_LINES = 10;

/** 分组渲染（phase 头 + 条目行；不设预算，widget 与 /todos 共用）。 */
function renderGroups(items: readonly TodoItem[]): string[] {
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
 * widget 行（活动锚定窗口，用户实证二修）：
 *  - 全局预算 = WIDGET_MAX_LINES（含摘要行与 +N 行）；
 *  - 窗口锚定第一条 in_progress：可见的条目是它前后的连续区段（正在做的
 *    上下文——前因后果可见），不再是固定头部/尾部（旧实现超窗时只剩尾部，
 *    正在执行的条目滚出视窗，01a03c0d 实证"显示最后几条，不管当前执行到哪"）；
 *  - 无 in_progress → 锚定最后一条 open；全完成 → 尾部切片（刚完成的可见）；
 *  - +N 行指路 /todos（全量视图）。
 */
export function widgetLines(items: readonly TodoItem[], opts?: { archivedAgeMs?: number | null }): string[] {
  if (items.length === 0) return [];
  const c = countTodos(items);
  // 反冻结：归档列表不逐条渲染，两行说明 + 指路 /todos（死计划不再占满视窗）。
  if (opts?.archivedAgeMs != null) {
    return [
      `todo: ${c.inProgress}▶ ${c.pending}○ ${c.blocked}■ ${c.completed}✓ · archived ${formatAge(opts.archivedAgeMs)}`,
      '  archived — /todos 全量',
    ];
  }

  // 条目预算 = 总预算 - 摘要行 -（隐藏时的）+N 行。phase 头也占行——按渲染行数
  // 迭代收缩：锚定窗口切片 → 超行则两端各收一格（保锚点），直到装得下。
  const renderBudget = WIDGET_MAX_LINES - 1 - 1;
  const [start, end] = anchorRange(items, renderBudget);
  const kept = items.slice(start, end);
  const hidden = items.filter((_, i) => i < start || i >= end);
  const lines = [`todo: ${c.inProgress}▶ ${c.pending}○ ${c.blocked}■ ${c.completed}✓`, ...renderGroups(kept)];
  if (hidden.length > 0) {
    const hiddenCompleted = hidden.filter((it) => it.status === 'completed').length;
    lines.push(`   +${hidden.length} hidden (${hiddenCompleted}✓) · /todos 全量`);
  }
  return lines;
}

/**
 * 活动锚定窗口：锚点 = 第一条 in_progress（无则最后一条 open；全完成 → 尾部）。
 * 以渲染行数（含 phase 头）为预算，从锚点贪心扩张（尾部优先——后续工作先
 * 可见），装不下即停；锚点条目永远在窗内。
 */
function anchorRange(items: readonly TodoItem[], renderBudget: number): [number, number] {
  if (renderGroups(items).length <= renderBudget) return [0, items.length];
  const anchor = items.findIndex((it) => it.status === 'in_progress');
  const anchorIdx = anchor >= 0
    ? anchor
    : items.reduce((acc, it, i) => (it.status !== 'completed' ? i : acc), -1);
  if (anchorIdx < 0) {
    // 全完成：尾部切片（按行数从头收缩）
    let end = items.length;
    while (renderGroups(items.slice(0, end)).length > renderBudget && end > 1) end -= 1;
    return [0, end];
  }
  let start = anchorIdx;
  let end = anchorIdx + 1;
  const fits = () => renderGroups(items.slice(start, end)).length <= renderBudget;
  let growTail = true;
  while ((end < items.length || start > 0) && (end - start) < items.length) {
    if (growTail && end < items.length) {
      end += 1;
      if (!fits()) { end -= 1; break; }
    } else if (start > 0) {
      start -= 1;
      if (!fits()) { start += 1; break; }
    } else if (end < items.length) {
      end += 1;
      if (!fits()) { end -= 1; break; }
    } else {
      break;
    }
    growTail = !growTail; // 严格交替：锚点前因与后果均衡可见（用户实证诉求）
  }
  return [start, end];
}

export default function todoPlugin(ctx: Context): void {
  const surface = ctx.get('pi-herdr.surface') as PiSurface<object>;
  const { todos, allowParallelInProgress, maxItems, mirrorTodos, appendEntry, state } =
    ctx.get('pi-herdr.todo-deps') as TodoDeps;
  const scoped = surface.forModule(import.meta.url);

  /** 归档年龄（非归档 → null）；widget / /todos 共用。 */
  function archivedAgeMs(now = Date.now()): number | null {
    return todos.lastWriteAt != null && isArchived(todos.items, todos.lastWriteAt, now)
      ? now - todos.lastWriteAt
      : null;
  }

  /** 事件 ctx 里的 widget UI（有则 setWidget；守卫后具名使用，不做行内断言）。 */
  function widgetUi(eventCtx: unknown): { setWidget?: (id: string, lines: string[]) => void } | undefined {
    if (eventCtx === null || typeof eventCtx !== 'object' || !('ui' in eventCtx)) return undefined;
    const ui = (eventCtx as { ui: unknown }).ui; // 'ui' in 已守卫
    return ui !== null && typeof ui === 'object'
      ? (ui as { setWidget?: (id: string, lines: string[]) => void })
      : undefined;
  }

  function renderWidget(eventCtx: unknown): void {
    try {
      widgetUi(eventCtx)?.setWidget?.('todos', widgetLines(todos.items, { archivedAgeMs: archivedAgeMs() }));
    } catch {
      /* 无 widget 能力的 pi 版本静默降级 */
    }
  }

  // 槽回填：index 的 session_start/session_tree 调用
  state.renderWidget = renderWidget;

  /* ── 读钩（轮次计数器内聚；D39 提示注入 + 反冻结 stale-core） ── */
  let todoReadTurn = 0;
  let lastEmptyGuardTurn: number | null = null;
  // 反冻结状态：距上次写入轮数 / stale 警告计数与节奏 / 归档翻转检测
  let lastWriteTurn: number | null = null;
  let staleNotices = 0;
  let lastStaleGuardTurn: number | null = null;
  let lastArchivedMirror = false;

  // 任何真实变更（todo_write / 人类编辑 / 对账 / 分支重建）都终结当前停滞期
  todos.on('todo.updated', () => {
    lastWriteTurn = todoReadTurn;
    staleNotices = 0;
  });

  scoped.on('before_agent_start', async (eventCtx?: unknown) => {
    const plan = planTodoReadHook({
      items: todos.items,
      turn: todoReadTurn,
      lastEmptyGuardTurn,
      lastWriteAt: todos.lastWriteAt,
      turnsSinceWrite: lastWriteTurn == null ? null : todoReadTurn - lastWriteTurn,
      now: Date.now(),
      staleNotices,
      lastStaleGuardTurn,
    });
    if (plan.inject && plan.effect === 'stale-notice') {
      staleNotices += 1;
      lastStaleGuardTurn = todoReadTurn;
    }
    // 空守卫 / 归档通知 / R2 重写窗口共用注入节奏（archived=true 的 stale 窗口同享，
    // 否则终态通知会在窗口后紧跟一拍挤掉宽限）。
    if (plan.inject && (plan.effect === 'empty-guard' || plan.archived)) {
      lastEmptyGuardTurn = todoReadTurn;
    }
    // R1：归档通知注入即清空——明细早已不再注入，保留死列表只会挡住空守卫的
    // before-stopping 驱动（01a03c0d：归档后 2h 多步工作零跟踪）。rm 全量落
    // JSONL，重启 rebuild 同样折叠得空表；历史明细仍在会话文件里。
    if (plan.inject && plan.effect === 'archive-notice' && plan.clearArchived && todos.items.length > 0) {
      const edits = todos.items.map((it) => ({ op: 'rm' as const, content: it.content }));
      try {
        appendEntry(TODO_EDIT_CUSTOM_TYPE, { version: 1, edits, ts: Date.now() });
      } catch {
        /* 尽力而为（内存清空照常） */
      }
      todos.replace([]);
    }
    todoReadTurn += 1;
    if (!plan.inject) return;
    return {
      message: {
        customType: plan.message.customType,
        content: plan.message.content,
        display: false,
      },
    };
  });

  /* ── 工具：todo_write ── */
  scoped.registerTool({
    name: TODO_TOOL_NAME,
    label: 'Todo',
    description: TOOL_DESCRIPTION,
    promptGuidelines: [
      'Before stopping with open todo_write entries, reconcile them: entries waiting on a human decision, approval, or ops action must be marked blocked with a blocker note — never left pending, and never executed just to clear the list.',
    ],
    parameters: Type.Object({
      todos: Type.Array(
        Type.Object(
          {
            content: Type.String({ description: 'What the task is — a short imperative line' }),
            status: Type.Union([
              Type.Literal('pending'),
              Type.Literal('in_progress'),
              Type.Literal('completed'),
              Type.Literal('blocked'),
              Type.Literal('abandoned'),
            ], { description: 'pending | in_progress | completed | blocked | abandoned' }),
            blocker: Type.Optional(Type.String({ description: 'Only when status is "blocked": what it is waiting for. Omit the field entirely (never an empty string) for other statuses' })),
            phase: Type.Optional(Type.String({ description: 'Optional group name (≤30 chars); omit for a flat list (never an empty string)' })),
          },
          { additionalProperties: false },
        ),
        { description: 'The COMPLETE task list; this call replaces the previous list' },
      ),
    }),
    async execute(toolCallId, params, signal, onUpdate, eventCtx) {
      void toolCallId;
      void signal;
      const result = validateTodos(params?.todos, allowParallelInProgress);
      if (!result.ok) {
        return {
          content: [{ type: 'text', text: `Error: ${result.error}` }],
          details: {},
        };
      }
      const strictMode = todos.config.strict; // D75 阶段 2：策略进 service config
      let next = result.items!;
      const strictNotes: string[] = [];
      if (strictMode) {
        const strict = normalizeStrict(next);
        const demoted = next
          .filter((it, i) => it.status === 'in_progress' && strict[i]?.status === 'pending')
          .map((it) => it.content);
        const promoted = strict
          .find((it, i) => it.status === 'in_progress' && next[i]?.status !== 'in_progress')?.content;
        if (demoted.length > 0) strictNotes.push(`demoted to pending: ${demoted.join(', ')}`);
        if (promoted) strictNotes.push(`auto-promoted to in_progress: ${promoted}`);
        next = strict;
      }
      // D35：no-op（与当前列表全等 → 不落盘不镜像）
      if (listsEqual(todos.items, next)) {
        return { content: [{ type: 'text', text: 'No change: todo list already matches.' }], details: {} };
      }
      // D36/D37：过渡信号与回退警告
      const completed = completionTransitions(todos.items, next);
      const reverted = revertedCompleted(todos.items, next);
      todos.replace(next);
      if (todos.items.length > maxItems) {
        onUpdate?.(makeProgressUpdate(`Note: list has ${todos.items.length} entries; consider keeping it under ${maxItems}.`));
      }
      mirrorTodos();
      renderWidget(eventCtx);
      const lines = [formatTodoConfirmation(todos.items)];
      if (completed.length > 0) lines.push(`Completed: ${completed.join(' | ')}`);
      if (reverted.length > 0) {
        lines.push(`Warning: previously completed item(s) reverted to open: ${reverted.join(' | ')} — is that intentional?`);
      }
      for (const n of strictNotes) lines.push(`Normalized (strict mode): ${n}`);
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        details: {
          [TODO_DETAILS_KEY]: makeSnapshot(todos.items),
          ...(completed.length > 0 ? { completedTasks: completed } : {}),
        },
      };
    },
  });

  /* ── 命令：/todos（查看 + done/drop/rm/unblock 人类编辑，D38）── */
  scoped.registerCommand('todos', {
    description: 'Show the todo list, or edit it: /todos done|drop|rm|unblock <fuzzy content match>',
    handler: async (args: unknown, eventCtx: unknown) => {
      const ui = (eventCtx as { ui?: { notify?: (text: string, level?: string) => void } }).ui;
      const ops = ['done', 'drop', 'rm', 'unblock'] as const;
      const raw = typeof args === 'string'
        ? args.split(/\s+/).filter(Boolean)
        : Array.isArray(args) ? args.map(String) : [];
      const opArg = raw[0];
      if (opArg && (ops as readonly string[]).includes(opArg)) {
        const query = raw.slice(1).join(' ').trim();
        if (!query) {
          ui?.notify?.('usage: /todos done|drop|rm|unblock <content>', 'warning');
          return;
        }
        const candidates = fuzzyFind(todos.items, query);
        if (candidates.length === 0) {
          ui?.notify?.(`no todo matches "${query}"`, 'warning');
          return;
        }
        if (candidates.length > 1) {
          ui?.notify?.(`ambiguous — matches:\n${candidates.map((c) => `  - ${c}`).join('\n')}`, 'warning');
          return;
        }
        const content = candidates[0];
        const edit = { op: opArg as 'done' | 'drop' | 'rm' | 'unblock', content };
        const before = todos.items;
        todos.applyEdits([edit]);
        if (listsEqual(before, todos.items)) {
          ui?.notify?.(`no change: "${content}" is already in that state`, 'info');
          return;
        }
        // D38：人类编辑写回权威（custom 条目，重启后分支回放生效）
        try {
          appendEntry(TODO_EDIT_CUSTOM_TYPE, { version: 1, edits: [edit], ts: Date.now() });
        } catch {
          /* 尽力而为 */
        }
        mirrorTodos();
        renderWidget(eventCtx);
        const verb = opArg === 'done' ? 'completed'
          : opArg === 'drop' ? 'abandoned'
          : opArg === 'unblock' ? 'unblocked (back to pending)'
          : 'removed';
        ui?.notify?.(`"${content}" ${verb}`, 'info');
        return;
      }
      // 全量视图（/todos 不受 widget 行预算限制——"看整个列表"的正式入口）
      const body = renderGroups(todos.items);
      if (body.length === 0) {
        ui?.notify?.('todo list is empty', 'info');
        return;
      }
      const c = countTodos(todos.items);
      const age = archivedAgeMs();
      const head = `todo: ${c.inProgress}▶ ${c.pending}○ ${c.blocked}■ ${c.completed}✓`
        + (age != null ? ` · archived ${formatAge(age)}（不再注入）` : '');
      ui?.notify?.([head, ...body].join('\n'), 'info');
    },
  });
}

