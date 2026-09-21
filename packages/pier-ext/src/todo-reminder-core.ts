/**
 * Pure decision core for reminders about unfinished todos when stopping (D41 rev 3, from 01a040cc:
 * a user-role "keep working" injection overrode the model's judgment from seconds earlier).
 *
 * Reminders therefore go out as sendMessage(custom) and ask for reconciliation rather than
 * continuation, making human-blocked items a first-class outcome. Guards: suppress on abort, cap
 * reminders, skip while a subagent runs, a human gate is blocked, or no open item remains.
 */
import { ABORT_STOP_REASON } from './settle-wake-core.ts';
import { pierOption } from './pier-options.ts';

/** Cap reminders for the lifetime of the process. */
const REMINDERS_MAX = 3;

/** Custom message type for reminder injection (registerMessageRenderer can customize its TUI appearance). */
export const TODO_REMINDER_CUSTOM_TYPE = 'pi-herdr.todo-reminder';

/**
 * B3 grace window (ms): delay from settled to injection so the user can read the
 * closing answer and intervene; starting any agent during the window cancels it.
 * PIER_TODO_GRACE_MS is read per call, not at module load, so tests can shrink it.
 */
export function todoReminderGraceMs(): number {
  // B10: canonical PIER_TODO_GRACE_MS, legacy PI_HERDR_TODO_GRACE_MS.
  return Number(pierOption('PIER_TODO_GRACE_MS') ?? 30_000) || 30_000;
}

interface TodoReminderInput {
  /** Stop reason of the last assistant turn before this settlement (null = treat as natural completion). */
  lastStopReason: string | null;
  intentionalAbort?: boolean;
  compactionInFlight?: boolean;
  reminders: number;
  /** Running background subagents; positive means the master is already waiting. */
  runningSubs: number;
  /** ask_user_question wait depth; positive means the master waits on a human. */
  blockedDepth: number;
  items: ReadonlyArray<{ content: string; status: string }>;
}

interface TodoReminderPlan {
  due: boolean;
  /** Complete injected content, or null when due is false. */
  content: string | null;
  /** New count after successful injection, or the original count when due is false. */
  nextReminders: number;
}

/**
 * Due only when every guard passes and at least one open (pending/in_progress) item exists.
 * blocked/abandoned/completed are not unfinished: once human-waiting work is modeled correctly,
 * reminding again would only pressure the model to act without authorization.
 */
export function planStopTodoReminder(input: TodoReminderInput): TodoReminderPlan {
  const noInject: TodoReminderPlan = { due: false, content: null, nextReminders: input.reminders };
  if (input.intentionalAbort || input.compactionInFlight) return noInject;
  if (input.lastStopReason === ABORT_STOP_REASON) return noInject;
  if (input.reminders >= REMINDERS_MAX) return noInject;
  if (input.runningSubs > 0) return noInject;
  if (input.blockedDepth > 0) return noInject;
  const open = input.items.filter((it) => it.status === 'pending' || it.status === 'in_progress');
  if (open.length === 0) return noInject;
  const list = open
    .map((it) => (it.status === 'in_progress' ? `▶ ${it.content}` : `· ${it.content}`))
    .join('\n');
  const content = [
    `<system-reminder>You stopped with unfinished todos (Reminder ${input.reminders + 1}/${REMINDERS_MAX}):`,
    list,
    'Reconcile the list instead of blindly continuing:',
    '- work that is yours AND already authorized by the user → continue it;',
    '- work waiting on a human (decision / approval / ops action) → mark it blocked with a blocker note, and ask the user via ask_user_question when you need their input — never execute it yourself just to clear the list;',
    '- entries that no longer apply → remove them.',
    'Update the list with todo_write in any case.</system-reminder>',
  ].join('\n');
  return { due: true, content, nextReminders: input.reminders + 1 };
}
