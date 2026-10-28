/**
 * D78/D81 todo loader entry.
 * A Cordis plugin keeps the master surface hot-swappable while workers mount the one-shot subset directly;
 * injected services preserve the D79 registration boundary and keep session-owned todo state in index. This
 * module owns the tool, command, widget, read hook, and master stop reminder — reconciliation, mirroring, and
 * agent reporting stay in the session state layer (cycle avoidance).
 */
import { Context } from '@deepseek-ai/cordis';
import { Type } from 'typebox';
import { cordisGet } from '../cordis-services.ts';
import type { TodosService } from '../todos-service.ts';
import { planTodoReadHook, shouldRunTodoRead } from '../todo-read-hook.ts';
import { TODO_REMINDER_CUSTOM_TYPE, planStopTodoReminder, todoReminderGraceMs } from '../todo-reminder-core.ts';
import { makeProgressUpdate } from '../subagent-core.ts';
import { TODO_DETAILS_KEY, TODO_STATUSES, TODO_TOOL_NAME, formatTodoConfirmation, type TodoItem } from '../vocab.ts';
import { toolError } from '../tool-error.ts';
import { formatAge, isArchived } from '../stale-core.ts';
import { TODO_ARCHIVE_WINDOW_CUSTOM_TYPE, TODO_EDIT_CUSTOM_TYPE, completionTransitions, fuzzyFind, listsEqual, makeSnapshot, normalizeStrict, revertedCompleted, todoListHash, validateTodos, type TodoEditOp } from '../todo-core.ts';
import { formatTodoSummary, renderTodoGroups } from '../todo-window.ts';
import { unifiedWidgetLines, type WorkerWidgetRow } from '../tree-view.ts';
import { swallow } from '../swallow.ts';

type ToolParams = Record<string, unknown> | undefined;

export interface TodoUiSlot {
  /** Lets index lifecycle events render through the currently mounted plugin. */
  renderWidget: (ctx: unknown) => void;
  /** Re-render from the last seen context without a fresh event (human-gate open/close). */
  rerenderWidget?: () => void;
  cancelReminder?: () => void;
}

export interface TodoDeps {
  todos: TodosService;
  allowParallelInProgress: boolean;
  /** Warn above this size without rejecting otherwise valid plans. */
  maxItems: number;
  mirrorTodos: () => void;
  appendEntry: (customType: string, data: unknown) => void;
  state: TodoUiSlot;
  /** Human-gate depth (ask_user_question / herdr:blocked); >0 collapses the widget to one line. */
  getBlockedDepth?: () => number;
  /** D113: running subagent rows for the unified widget; master mounts only. */
  getWorkers?: () => readonly WorkerWidgetRow[];
  /** Master-only unfinished-todo reminder; omitted on worker panes. */
  stopReminder?: {
    getBlockedDepth: () => number;
    getRunningSubs: () => number;
    isCompactionInFlight?: () => boolean;
    isIntentionalAbort?: () => boolean;
  };
}

const TOOL_DESCRIPTION = [
  'Record the complete task list for the current work. Every call REPLACES the whole list, so always resend it in full.',
  'Entries: `content` (unique short imperative, no numbering), `status`, `blocker` (only when blocked: what it waits for), optional `phase` (group for a multi-stage plan). At most 15 entries, one per meaningful unit of work; several may be in_progress when work truly runs in parallel.',
  'Do not make todo_write the only tool call of a turn — batch it with real work.',
  'When you hand an entry to a subagent, append ` <sub>` to its content; it auto-completes when the subagent settles ("Reconciled:" in the note), otherwise update it yourself.',
].join(' ');


/** `/todos <op> <query>` verbs; the value is the user-facing past-tense feedback. */
const OP_VERBS: Record<TodoEditOp, string> = {
  done: 'completed',
  drop: 'abandoned',
  unblock: 'unblocked (back to pending)',
  rm: 'removed',
};

/** D113 unified resident widget (see tree-view.ts for the line rules). */
export function widgetLines(
  items: readonly TodoItem[],
  opts?: { archivedAgeMs?: number | null; blockedDepth?: number | null; workers?: readonly WorkerWidgetRow[] },
): string[] {
  return unifiedWidgetLines(items, opts?.workers ?? [], {
    archivedAgeMs: opts?.archivedAgeMs,
    blockedDepth: opts?.blockedDepth,
  });
}

export default function todoPlugin(ctx: Context): void {
  const surface = cordisGet(ctx, 'pi-herdr.surface');
  const { todos, allowParallelInProgress, maxItems, mirrorTodos, appendEntry, state, stopReminder, getBlockedDepth, getWorkers } =
    cordisGet(ctx, 'pi-herdr.todo-deps');
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
        workers: getWorkers?.() ?? [],
      }));
    } catch {
      /* Older pi versions may omit widget support without disabling todo tracking. */
    }
  }

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

  scoped.on('before_agent_start', async (eventCtx?: unknown, ctx?: unknown) => {
    // pi 1.2+ also fires this for extension-triggered runs; skip the ones that would double-inject
    // or consume the guard cadence (stop reminder, config guide, third-party custom runs).
    if (!shouldRunTodoRead(eventCtx)) return;
    const plan = planTodoReadHook({
      items: todos.items,
      turn: todoReadTurn,
      lastEmptyGuardTurn,
      lastWriteAt: todos.lastWriteAt,
      turnsSinceWrite: lastWriteTurn == null ? null : todoReadTurn - lastWriteTurn,
      now: Date.now(),
      staleNotices,
      lastStaleGuardTurn,
      archiveWindowOffered: todos.archiveWindowOffered,
    });
    if (plan.inject && plan.effect === 'stale-notice') {
      staleNotices += 1;
      lastStaleGuardTurn = todoReadTurn;
    }
    // Persist the one-window offer against this list identity: the plugin closure dies with the
    // process, and on /resume the same dead list must reach the terminal clear instead of re-warning.
    if (plan.inject && plan.offerArchiveWindow) {
      try {
        appendEntry(TODO_ARCHIVE_WINDOW_CUSTOM_TYPE, {
          version: 1,
          itemsHash: todoListHash(todos.items),
        });
      } catch (err) {
        // The in-memory mark still advances escalation in this process.
        swallow('todo.persist-archive-window', err);
      }
      todos.markArchiveWindowOffered();
    }
    // Empty-list guards and the archive rewrite window share one cadence so adjacent notices do not
    // each consume the grace window; the terminal clear is immediate and only marks the tick.
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
        // The in-memory clear must proceed even when this persistence fails.
        swallow('todo.persist-archive', err);
      }
      todos.replace([], { source: 'archive' });
      // The clear is the one todo mutation outside the tool/human paths that must refresh the
      // title, sidebar token and widget; the dead list would otherwise stay authoritative. The hook's
      // first argument is the event (no ui), so render through the run ctx; tests pass a ui ctx first.
      mirrorTodos();
      renderWidget(ctx ?? eventCtx);
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
      ) => void;
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
    // A retry starts a fresh turn, not necessarily a fresh agent_start: cancel the pending reminder
    // there too so a provider-error retry cannot be interrupted by a stale 30 s timer.
    for (const ev of ['agent_start', 'turn_start', 'session_shutdown']) scoped.on(ev, () => cancelTodoReminder());
    scoped.on('agent_settled', async (event: unknown) => {
      cancelTodoReminder();
      // pi ≥ 1.1 carries `aborted` on agent_settled: authoritative for ESC mid-tool, where stopReason
      // tracking sees a stale natural reason and would still schedule a reminder.
      const aborted = event !== null && typeof event === 'object'
        && 'aborted' in event && event.aborted === true;
      const plan = planStopTodoReminder({
        lastStopReason: lastAssistantStopReason,
        aborted,
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
          // pi's sendMessage is fire-and-forget (it returns void), so the cap counter must advance
          // synchronously: `send(...).then(...)` threw, got swallowed here, and every settle re-sent
          // "Reminder 1/3" forever.
          send(
            { customType: TODO_REMINDER_CUSTOM_TYPE, content, display: true },
            { deliverAs: 'followUp', triggerTurn: true },
          );
          todoReminders += 1;
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
      'Before stopping, reconcile open entries: anything waiting on a human (decision, approval, an ops action you cannot perform) is marked blocked with a blocker note — never left pending, never executed just to clear the list; finished or obsolete entries are completed or removed.',
    ],
    parameters: Type.Object({
      todos: Type.Array(
        Type.Object(
          {
            content: Type.String({ description: 'Short imperative line' }),
            status: Type.Union(TODO_STATUSES.map((status) => Type.Literal(status))),
            blocker: Type.Optional(Type.String({ description: 'Only for blocked; omit otherwise (never an empty string)' })),
            phase: Type.Optional(Type.String({ description: 'Group name (≤30 chars); omit for a flat list' })),
          },
          { additionalProperties: false },
        ),
        { description: 'The COMPLETE list; replaces the previous one' },
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
      const body = renderTodoGroups(todos.items);
      if (body.length === 0) {
        ui?.notify?.('todo list is empty', 'info');
        return;
      }
      const age = archivedAgeMs();
      const head = formatTodoSummary(todos.items)
        + (age != null ? ` · archived ${formatAge(age)} (no longer injected)` : '');
      ui?.notify?.([head, ...body].join('\n'), 'info');
    },
  });
}
