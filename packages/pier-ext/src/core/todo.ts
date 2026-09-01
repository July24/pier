/**
 * D78/D81 todo loader entry.
 *
 * A Cordis plugin keeps the master surface hot-swappable while allowing workers to mount the
 * one-shot subset directly. Injected services preserve the D79 registration boundary and keep
 * session-owned todo state in index. This module owns the tool, command, widget, read hook,
 * and master stop reminder; reconciliation, mirroring, and agent reporting stay with the
 * session state layer to avoid a dependency cycle.
 */
import { Context } from '@deepseek-ai/cordis';
import { Type } from 'typebox';
import type { PiSurface } from '../pi-surface.ts';
import type { TodosService } from '../todos-service.ts';
import { planTodoReadHook } from '../todo-read-hook.ts';
import { TODO_REMINDER_CUSTOM_TYPE, planStopTodoReminder, todoReminderGraceMs } from '../todo-reminder-core.ts';
import { makeProgressUpdate } from '../subagent-core.ts';
import { TODO_DETAILS_KEY, TODO_TOOL_NAME, formatTodoConfirmation, type TodoItem } from '../vocab.ts';
import { formatAge, isArchived } from '../stale-core.ts';
import {
  TODO_EDIT_CUSTOM_TYPE,
  completionTransitions,
  fuzzyFind,
  listsEqual,
  makeSnapshot,
  normalizeStrict,
  revertedCompleted,
  validateTodos,
} from '../todo-core.ts';
import { anchorTodoRange, formatTodoSummary, renderTodoGroups } from '../todo-window.ts';

export interface TodoUiSlot {
  /** Lets index lifecycle events render through the currently mounted plugin. */
  renderWidget: (ctx: unknown) => void;
}

interface TodoDeps {
  todos: TodosService;
  allowParallelInProgress: boolean;
  /** Warn above this size without rejecting otherwise valid plans. */
  maxItems: number;
  mirrorTodos: () => void;
  appendEntry: (customType: string, data: unknown) => void;
  state: TodoUiSlot;
  /** Master-only unfinished-todo reminder; omitted on worker panes. */
  stopReminder?: {
    getBlockedDepth: () => number;
    getRunningSubs: () => number;
  };
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

/** Stay within pi interactive mode's ten-line widget cap instead of relying on head truncation. */
export const WIDGET_MAX_LINES = 10;

/**
 * Keep the active task visible within WIDGET_MAX_LINES instead of truncating to a fixed head or
 * tail. The window anchors on the first in-progress item, then the last open item, then recent
 * completions. A +N line points to /todos when the full plan cannot fit. This fixes 01a03c0d,
 * where active work scrolled out while only the final entries remained visible.
 */
export function widgetLines(items: readonly TodoItem[], opts?: { archivedAgeMs?: number | null }): string[] {
  if (items.length === 0) return [];
  // Collapse archived plans to two lines so stale work cannot monopolize the widget.
  if (opts?.archivedAgeMs != null) {
    return [
      `${formatTodoSummary(items)} · archived ${formatAge(opts.archivedAgeMs)}`,
      '  archived — /todos 全量',
    ];
  }

  // Reserve summary and overflow lines, then shrink around the anchor because phase headers also consume the budget.
  const renderBudget = WIDGET_MAX_LINES - 1 - 1;
  const [start, end] = anchorTodoRange(
    items,
    (s, e) => renderTodoGroups(items.slice(s, e)).length <= renderBudget,
  );
  const kept = items.slice(start, end);
  const hidden = items.filter((_, i) => i < start || i >= end);
  const lines = [formatTodoSummary(items), ...renderTodoGroups(kept)];
  if (hidden.length > 0) {
    const hiddenCompleted = hidden.filter((it) => it.status === 'completed').length;
    lines.push(`   +${hidden.length} hidden (${hiddenCompleted}✓) · /todos 全量`);
  }
  return lines;
}

export default function todoPlugin(ctx: Context): void {
  const surface = ctx.get('pi-herdr.surface') as PiSurface<object>;
  const { todos, allowParallelInProgress, maxItems, mirrorTodos, appendEntry, state, stopReminder } =
    ctx.get('pi-herdr.todo-deps') as TodoDeps;
  const scoped = surface.forModule(import.meta.url);

  /** Share one archive-age decision between the widget and /todos. */
  function archivedAgeMs(now = Date.now()): number | null {
    return todos.lastWriteAt != null && isArchived(todos.items, todos.lastWriteAt, now)
      ? now - todos.lastWriteAt
      : null;
  }

  /** Name the guarded event UI once so callers do not repeat unsafe inline assertions. */
  function widgetUi(eventCtx: unknown): { setWidget?: (id: string, lines: string[]) => void } | undefined {
    if (eventCtx === null || typeof eventCtx !== 'object' || !('ui' in eventCtx)) return undefined;
    const ui = (eventCtx as { ui: unknown }).ui; // Safe after the property guard above.
    return ui !== null && typeof ui === 'object'
      ? (ui as { setWidget?: (id: string, lines: string[]) => void })
      : undefined;
  }

  function renderWidget(eventCtx: unknown): void {
    try {
      widgetUi(eventCtx)?.setWidget?.('todos', widgetLines(todos.items, { archivedAgeMs: archivedAgeMs() }));
    } catch {
      /* Older pi versions may omit widget support without disabling todo tracking. */
    }
  }

  // Let index lifecycle hooks call the current plugin implementation.
  state.renderWidget = renderWidget;

  /* ── Read hook: D39 reminders and stale-plan thawing ────────────── */
  let todoReadTurn = 0;
  let lastEmptyGuardTurn: number | null = null;
  // Track writes and notice cadence so a stale plan cannot remain frozen indefinitely.
  let lastWriteTurn: number | null = null;
  let staleNotices = 0;
  let lastStaleGuardTurn: number | null = null;
  let lastArchivedMirror = false;

  // Any real edit ends the current stale period because the plan is active again.
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
    // Share cadence across empty, archive, and R2 rewrite notices so adjacent notices do not
    // consume the grace window.
    if (plan.inject && (plan.effect === 'empty-guard' || plan.archived)) {
      lastEmptyGuardTurn = todoReadTurn;
    }
    // R1 clears archived entries after notice because retaining dead items suppresses the empty
    // guard that restored tracking after the 01a03c0d two-hour gap. Persist removals for replay;
    // the session log still retains history.
    if (plan.inject && plan.effect === 'archive-notice' && plan.clearArchived && todos.items.length > 0) {
      const edits = todos.items.map((it) => ({ op: 'rm' as const, content: it.content }));
      try {
        appendEntry(TODO_EDIT_CUSTOM_TYPE, { version: 1, edits, ts: Date.now() });
      } catch {
        /* Persistence is best-effort because the in-memory clear must still proceed. */
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

  if (stopReminder) {
    const pi = surface.raw as {
      sendMessage?: (
        message: { customType: string; content: string; display?: boolean; details?: Record<string, unknown> },
        opts?: { deliverAs?: string; triggerTurn?: boolean },
      ) => Promise<void>;
    };
    let todoReminders = 0;
    let lastAssistantStopReason: string | null = null;
    let todoReminderTimer: NodeJS.Timeout | null = null;
    function cancelTodoReminder(): void {
      if (todoReminderTimer !== null) {
        clearTimeout(todoReminderTimer);
        todoReminderTimer = null;
      }
    }
    scoped.on('turn_end', async (event: unknown) => {
      if (event === null || typeof event !== 'object' || !('message' in event)) return;
      const msg = (event as { message: unknown }).message;
      if (msg === null || typeof msg !== 'object') return;
      const { role, stopReason } = msg as { role?: unknown; stopReason?: unknown };
      if (role === 'assistant' && typeof stopReason === 'string') {
        lastAssistantStopReason = stopReason;
      }
    });
    scoped.on('agent_start', () => cancelTodoReminder());
    scoped.on('session_shutdown', () => cancelTodoReminder());
    scoped.on('agent_settled', async () => {
      cancelTodoReminder();
      const plan = planStopTodoReminder({
        lastStopReason: lastAssistantStopReason,
        reminders: todoReminders,
        runningSubs: stopReminder.getRunningSubs(),
        blockedDepth: stopReminder.getBlockedDepth(),
        items: todos.items,
      });
      if (!plan.due || plan.content == null) return;
      const content = plan.content;
      todoReminderTimer = setTimeout(() => {
        todoReminderTimer = null;
        void (async () => {
          const send = pi.sendMessage;
          if (typeof send !== 'function') return;
          try {
            await send(
              { customType: TODO_REMINDER_CUSTOM_TYPE, content, display: true },
              { deliverAs: 'followUp', triggerTurn: true },
            );
            todoReminders += 1;
          } catch {
            /* Delivery failure is non-fatal. */
          }
        })();
      }, todoReminderGraceMs());
      todoReminderTimer.unref?.();
    });
  }

  /* ── todo_write tool ───────────────────────────────────────────── */
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
      const strictMode = todos.config.strict; // D75 phase 2 keeps policy in the service config.
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
      // D35 avoids persistence and mirroring when the authoritative list is unchanged.
      if (listsEqual(todos.items, next)) {
        return { content: [{ type: 'text', text: 'No change: todo list already matches.' }], details: {} };
      }
      // D36/D37 surface completion transitions and regressions to the caller.
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

  /* ── /todos command: D38 human viewing and edits ───────────────── */
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
        // D38 persists human edits so branch replay rebuilds the same authoritative state.
        try {
          appendEntry(TODO_EDIT_CUSTOM_TYPE, { version: 1, edits: [edit], ts: Date.now() });
        } catch {
          /* Persistence failure must not discard the live human edit. */
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
      // /todos is the unbounded view because the widget intentionally prioritizes active context.
      const body = renderTodoGroups(todos.items);
      if (body.length === 0) {
        ui?.notify?.('todo list is empty', 'info');
        return;
      }
      const age = archivedAgeMs();
      const head = formatTodoSummary(todos.items)
        + (age != null ? ` · archived ${formatAge(age)}（不再注入）` : '');
      ui?.notify?.([head, ...body].join('\n'), 'info');
    },
  });
}

