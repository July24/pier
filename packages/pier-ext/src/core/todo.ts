/**
 * 档1 core/todo（todo 族迁 loader entry —— D78 挂载树 / D81 融合核心）。
 *
 * 形态：cordis 插件（master 经 loader.create 挂 = 热换面；worker 裸根手动 mount，
 * D81 one-shot 裁剪）。依赖全部经服务注入：
 *  - `pi-herdr.surface`：pi 注册面代理（D79 tombstone）；
 *  - `pi-herdr.todo-deps`：todos 服务（session 状态层，留在 index）+ options +
 *    mirrorTodos 回调 + appendEntry + state 槽（renderWidget 回填给 index 生命周期）。
 *
 * 本文件承接：todo_write 工具 + /todos /todo 命令 + TUI widget（widgetLines/
 * renderWidget/formatTodosMarkdown）+ 读钩（before_agent_start planTodoReadHook，
 * 轮次计数器内聚）。reconcile / 镜像 / reportAgent 仍在 index（session 状态层）。
 */
import { Context } from '@deepseek-ai/cordis';
import { Type } from 'typebox';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import type { PiSurface } from '../pi-surface.ts';
import type { TodosService } from '../todos-service.ts';
import { planTodoReadHook } from '../todo-read-hook.ts';
import { makeProgressUpdate } from '../subagent-core.ts';
import { TODO_DETAILS_KEY, TODO_TOOL_NAME, formatTodoConfirmation, type TodoItem, type TodoStatus } from '../vocab.ts';
import {
  TODO_EDIT_CUSTOM_TYPE,
  boundedView,
  completionTransitions,
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
  'Mark tasks done immediately after finishing. Never mark a task completed while its tests fail or its work is incomplete. If you cannot remember the exact content of an entry, re-derive it from the previous todo_write result instead of guessing.',
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

function widgetLines(items: TodoItem[]): string[] {
  if (items.length === 0) return [];
  const counts = { pending: 0, inProgress: 0, completed: 0, blocked: 0 };
  for (const it of items) {
    if (it.status === 'pending') counts.pending++;
    else if (it.status === 'in_progress') counts.inProgress++;
    else if (it.status === 'completed') counts.completed++;
    else if (it.status === 'blocked') counts.blocked++;
  }
  const lines = [`todo: ${counts.inProgress}▶ ${counts.pending}○ ${counts.blocked}■ ${counts.completed}✓`];
  // D43 phase 分组 + D39 有界（每组预算 10 行）
  const groups = new Map<string, TodoItem[]>();
  for (const it of items) {
    const key = it.phase ?? '';
    const arr = groups.get(key) ?? [];
    arr.push(it);
    groups.set(key, arr);
  }
  for (const [phase, list] of groups) {
    if (phase) lines.push(`  [${phase}]`);
    const view = boundedView(list, 10);
    for (const it of view.visible) {
      const suffix = it.status === 'blocked' && it.blocker ? ` — ${it.blocker}` : '';
      lines.push(`  ${TODO_MARKS[it.status]} ${it.content}${suffix}`);
    }
    if (view.hiddenCompleted > 0 || view.hiddenOpen > 0) {
      lines.push(`   +${view.hiddenCompleted + view.hiddenOpen} more (${view.hiddenCompleted} completed, ${view.hiddenOpen} open)`);
    }
  }
  return lines;
}

/** D38：TODO.md 导出（分组 + 任务列表语法）。 */
function formatTodosMarkdown(items: TodoItem[]): string {
  const groups = new Map<string, TodoItem[]>();
  for (const it of items) {
    const key = it.phase ?? '默认';
    const arr = groups.get(key) ?? [];
    arr.push(it);
    groups.set(key, arr);
  }
  const lines = ['# TODO'];
  for (const [phase, list] of groups) {
    lines.push('', `## ${phase}`);
    for (const it of list) {
      const box = it.status === 'completed' ? 'x'
        : it.status === 'in_progress' ? '/'
        : it.status === 'blocked' ? '!'
        : it.status === 'abandoned' ? '~'
        : ' ';
      const suffix = it.status === 'blocked' && it.blocker ? ` — blocker: ${it.blocker}` : '';
      lines.push(`- [${box}] ${it.content}${suffix}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

export default function todoPlugin(ctx: Context): void {
  const surface = ctx.get('pi-herdr.surface') as PiSurface<object>;
  const { todos, allowParallelInProgress, maxItems, mirrorTodos, appendEntry, state } =
    ctx.get('pi-herdr.todo-deps') as TodoDeps;
  const scoped = surface.forModule(import.meta.url);

  function renderWidget(eventCtx: unknown): void {
    try {
      (eventCtx as { ui?: { setWidget?: (id: string, lines: string[]) => void } })?.ui?.setWidget?.(
        'todos',
        widgetLines(todos.items),
      );
    } catch {
      /* 无 widget 能力的 pi 版本静默降级 */
    }
  }

  // 槽回填：index 的 session_start/session_tree 调用
  state.renderWidget = renderWidget;

  /* ── 读钩（轮次计数器内聚；D39 提示注入） ── */
  let todoReadTurn = 0;
  let lastEmptyGuardTurn: number | null = null;
  scoped.on('before_agent_start', async () => {
    const plan = planTodoReadHook({
      items: todos.items,
      turn: todoReadTurn,
      lastEmptyGuardTurn,
    });
    todoReadTurn += 1;
    if (!plan.inject) return;
    if (todos.items.length === 0) lastEmptyGuardTurn = todoReadTurn - 1;
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
            blocker: Type.Optional(Type.String({ description: 'Only when status is "blocked": what it is waiting for' })),
            phase: Type.Optional(Type.String({ description: 'Optional group name (≤30 chars); omit for a flat list' })),
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

  /* ── 命令：/todos（查看 + done/drop/rm 人类编辑，D38）+ /todo export ── */
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
      const lines = widgetLines(todos.items);
      const text = lines.length ? lines.join('\n') : 'todo list is empty';
      ui?.notify?.(text, 'info');
    },
  });

  scoped.registerCommand('todo', {
    description: 'Export the current todo list to TODO.md in the working directory',
    handler: async (_args: unknown, eventCtx: unknown) => {
      const ui = (eventCtx as { ui?: { notify?: (text: string, level?: string) => void } }).ui;
      const cwd = (eventCtx as { cwd?: string }).cwd ?? process.cwd();
      try {
        const target = join(cwd, 'TODO.md');
        writeFileSync(target, formatTodosMarkdown(todos.items));
        ui?.notify?.(`TODO.md written: ${target} (${todos.items.length} items)`, 'info');
      } catch (err) {
        ui?.notify?.(`failed to write TODO.md: ${(err as Error).message}`, 'error');
      }
    },
  });
}
