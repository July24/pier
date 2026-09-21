/**
 * D78/D81 todo loader entry.
 *
 * A Cordis plugin keeps the master surface hot-swappable while workers mount the one-shot subset
 * directly; injected services preserve the D79 registration boundary and keep session-owned todo
 * state in index. This module owns the tool, command, widget, read hook, and master stop reminder —
 * reconciliation, mirroring, and agent reporting stay in the session state layer (cycle avoidance).
 */
import { Context } from '@deepseek-ai/cordis';
import { Type } from 'typebox';
import type { PiSurface } from '../pi-surface.ts';
import type { TodosService } from '../todos-service.ts';
import { planTodoReadHook } from '../todo-read-hook.ts';
import { TODO_REMINDER_CUSTOM_TYPE, planStopTodoReminder, todoReminderGraceMs } from '../todo-reminder-core.ts';
import { makeProgressUpdate } from '../subagent-core.ts';
import { TODO_DETAILS_KEY, TODO_STATUSES, TODO_TOOL_NAME, formatTodoConfirmation, type TodoItem } from '../vocab.ts';
import { toolError } from '../tool-error.ts';
import { formatAge, isArchived } from '../stale-core.ts';
import { TODO_EDIT_CUSTOM_TYPE, completionTransitions, fuzzyFind, listsEqual, makeSnapshot, normalizeStrict, revertedCompleted, validateTodos, type TodoEditOp } from '../todo-core.ts';
import { anchorTodoRange, formatTodoSummary, renderTodoGroups } from '../todo-window.ts';
import { swallow } from '../swallow.ts';

/** Raw tool arguments: every field is validated inside the action handlers. */
type ToolParams = Record<string, unknown> | undefined;

export interface TodoUiSlot {
  /** Lets index lifecycle events render through the currently mounted plugin. */
  renderWidget: (ctx: unknown) => void;
  /** Re-render from the last seen context without a fresh event (human-gate open/close). */
  rerenderWidget?: () => void;
  /** Cancel any pending unfinished-todo reminder timer. */
  cancelReminder?: () => void;
}

interface TodoDeps {
  todos: TodosService;
  allowParallelInProgress: boolean;
  /** Warn above this size without rejecting otherwise valid plans. */
  maxItems: number;
  mirrorTodos: () => void;
  appendEntry: (customType: string, data: unknown) => void;
  state: TodoUiSlot;
  /** Human-gate depth (ask_user_question / herdr:blocked); >0 collapses the widget to one line. */
  getBlockedDepth?: () => number;
  /** Master-only unfinished-todo reminder; omitted on worker panes. */
  stopReminder?: {
    getBlockedDepth: () => number;
    getRunningSubs: () => number;
    isCompactionInFlight?: () => boolean;
    isIntentionalAbort?: () => boolean;
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

/** pi interactive mode renders at most ten widget lines. */
const WIDGET_MAX_LINES = 10;

/** `/todos <op> <query>` verbs; the value is the user-facing past-tense feedback. */
const OP_VERBS: Record<TodoEditOp, string> = {
  done: 'completed',
  drop: 'abandoned',
  unblock: 'unblocked (back to pending)',
  rm: 'removed',
};

/**
 * Keep the active task visible within WIDGET_MAX_LINES rather than truncating to a fixed head or
 * tail: the window anchors on the first in-progress item, then the last open item, then recent
 * completions, and a +N line points to /todos when the full plan cannot fit.
 */
export function widgetLines(
  items: readonly TodoItem[],
  opts?: { archivedAgeMs?: number | null; blockedDepth?: number | null },
): string[] {
  if (items.length === 0) return [];
  // Human gate open (ask_user_question waiting): the question and editor own the fixed area, so the
  // widget collapses to one summary line — otherwise a 10-line widget plus a multi-line question
  // leaves almost no scrollable transcript.
  if ((opts?.blockedDepth ?? 0) > 0) {
    return [`${formatTodoSummary(items)} · /todos 全量`];
  }
  // Collapse archived plans to two lines so stale work cannot monopolize the widget.
  if (opts?.archivedAgeMs != null) {
    return [
      `${formatTodoSummary(items)} · archived ${formatAge(opts.archivedAgeMs)}`,
      '  archived — /todos 全量',
    ];
  }

  // Reserve summary and overflow lines; phase headers consume the budget too, hence the shrink loop.
  const renderBudget = WIDGET_MAX_LINES - 2;
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
  const { todos, allowParallelInProgress, maxItems, mirrorTodos, appendEntry, state, stopReminder, getBlockedDepth } =
    ctx.get('pi-herdr.todo-deps') as TodoDeps;
  const scoped = surface.forModule(import.meta.url);

  /** Share one archive-age decision between the widget and /todos. */
  function archivedAgeMs(now = Date.now()): number | null {
    return todos.lastWriteAt != null && isArchived(todos.items, todos.lastWriteAt, now)
      ? now - todos.lastWriteAt
      : null;
  }

  /** Gate transitions fire outside lifecycle events; remember one ctx so rerenderWidget can target the live ui. */
  let lastEventCtx: unknown = null;
  function renderWidget(eventCtx: unknown): void {
    if (eventCtx !== null && eventCtx !== undefined) lastEventCtx = eventCtx;
    const ui = (eventCtx as { ui?: { setWidget?: (id: string, lines: string[]) => void } } | null | undefined)?.ui;
    try {
      ui?.setWidget?.('todos', widgetLines(todos.items, {
        archivedAgeMs: archivedAgeMs(),
        blockedDepth: getBlockedDepth?.() ?? 0,
      }));
    } catch {
      /* Older pi versions may omit widget support without disabling todo tracking. */
    }
  }

  // Let index lifecycle hooks call the current plugin implementation.
  state.renderWidget = renderWidget;
  state.rerenderWidget = () => renderWidget(lastEventCtx);

  /* ── Read hook: D39 reminders and stale-plan thawing ────────────── */
  let todoReadTurn = 0;
  let lastEmptyGuardTurn: number | null = null;
  // Track writes and notice cadence so a stale plan cannot remain frozen indefinitely.
  let lastWriteTurn: number | null = null;
  let staleNotices = 0;
  let lastStaleGuardTurn: number | null = null;

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
    // Empty, archive, and R2 rewrite notices share one cadence so adjacent notices do not each
    // consume the grace window.
    if (plan.inject && (plan.effect === 'empty-guard' || plan.archived)) {
      lastEmptyGuardTurn = todoReadTurn;
    }
    // R1: persist the clear as one rm-per-item edit so replay folds to an empty list. The session
    // log keeps the history; a dead in-memory list would suppress the empty guard.
    if (plan.inject && plan.effect === 'archive-notice' && plan.clearArchived && todos.items.length > 0) {
      const edits = todos.items.map((it) => ({ op: 'rm' as const, content: it.content }));
      try {
        appendEntry(TODO_EDIT_CUSTOM_TYPE, { version: 1, edits, ts: Date.now() });
      } catch (err) {
        // The in-memory clear must proceed, but a silent failure here is how the archive/replay
        // path broke unnoticed before (SA-13).
        swallow('todo.persist-archive', err);
      }
      todos.replace([], { source: 'archive' });
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
    state.cancelReminder = cancelTodoReminder;
    scoped.on('turn_end', async (event: unknown) => {
      const msg = (event as { message?: unknown } | null | undefined)?.message;
      if (msg === null || typeof msg !== 'object') return;
      const { role, stopReason } = msg as { role?: unknown; stopReason?: unknown };
      if (role === 'assistant' && typeof stopReason === 'string') lastAssistantStopReason = stopReason;
    });
    for (const ev of ['agent_start', 'session_shutdown']) scoped.on(ev, () => cancelTodoReminder());
    scoped.on('agent_settled', async () => {
      cancelTodoReminder();
      const plan = planStopTodoReminder({
        lastStopReason: lastAssistantStopReason,
        intentionalAbort: stopReminder.isIntentionalAbort?.() ?? false,
        compactionInFlight: stopReminder.isCompactionInFlight?.() ?? false,
        reminders: todoReminders,
        runningSubs: stopReminder.getRunningSubs(),
        blockedDepth: stopReminder.getBlockedDepth(),
        items: todos.items,
      });
      if (!plan.due || plan.content == null) return;
      const content = plan.content;
      todoReminderTimer = setTimeout(() => {
        todoReminderTimer = null;
        if (stopReminder.isCompactionInFlight?.()) return;
        const send = pi.sendMessage;
        if (typeof send !== 'function') return;
        try {
          void send(
            { customType: TODO_REMINDER_CUSTOM_TYPE, content, display: true },
            { deliverAs: 'followUp', triggerTurn: true },
          ).then(() => { todoReminders += 1; }, () => {});
        } catch {
          /* A synchronous send failure must not escape the timer callback. */
        }
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
            status: Type.Union(
              TODO_STATUSES.map((status) => Type.Literal(status)),
              { description: TODO_STATUSES.join(' | ') },
            ),
            blocker: Type.Optional(Type.String({ description: 'Only when status is "blocked": what it is waiting for. Omit the field entirely (never an empty string) for other statuses' })),
            phase: Type.Optional(Type.String({ description: 'Optional group name (≤30 chars); omit for a flat list (never an empty string)' })),
          },
          { additionalProperties: false },
        ),
        { description: 'The COMPLETE task list; this call replaces the previous list' },
      ),
    }),
    async execute(toolCallId: string, params: ToolParams, signal: AbortSignal | undefined, onUpdate: ((update: unknown) => void) | undefined, eventCtx: unknown) {
      void toolCallId;
      void signal;
      const result = validateTodos(params?.todos, allowParallelInProgress);
      if (!result.ok) {
        // A1: an invalid list is a hard failure — throw so pi flags isError for the model.
        return toolError(result.error ?? 'invalid todo list');
      }
      let next = result.items!;
      const strictNotes: string[] = [];
      if (todos.config.strict) {
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
      // D35: skip persistence and mirroring when the authoritative list is unchanged.
      if (listsEqual(todos.items, next)) {
        return { content: [{ type: 'text', text: 'No change: todo list already matches.' }], details: {} };
      }
      const completed = completionTransitions(todos.items, next);
      const reverted = revertedCompleted(todos.items, next);
      todos.replace(next, { source: 'tool' });
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
      const raw = typeof args === 'string'
        ? args.split(/\s+/).filter(Boolean)
        : Array.isArray(args) ? args.map(String) : [];
      const opArg = raw[0];
      if (opArg && Object.hasOwn(OP_VERBS, opArg)) {
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
        const edit = { op: opArg as TodoEditOp, content };
        const before = todos.items;
        todos.applyEdits([edit], { source: 'human' });
        if (listsEqual(before, todos.items)) {
          ui?.notify?.(`no change: "${content}" is already in that state`, 'info');
          return;
        }
        // D38: persist human edits so branch replay rebuilds the same authoritative state.
        try {
          appendEntry(TODO_EDIT_CUSTOM_TYPE, { version: 1, edits: [edit], ts: Date.now() });
        } catch {
          /* Persistence failure must not discard the live human edit. */
        }
        mirrorTodos();
        renderWidget(eventCtx);
        ui?.notify?.(`"${content}" ${OP_VERBS[edit.op]}`, 'info');
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
