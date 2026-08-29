/**
 * Pure decision core for reminders about unfinished todos when stopping (D41 revision 2;
 * evidenced by session 01a040cc).
 *
 * Evidence: the model's closing prose said that pushing should be left to the user,
 * yet the todo list still contained `[pending] push to repository`. The old D41 injected
 * “Continue working on them before stopping” as a user-role message 116 ms after agent_settled;
 * that channel overrode the model's judgment from 20 seconds earlier, and git push ran within
 * 12 seconds without authorization.
 *
 * Revision 3 keeps the decision and wording here while the timing grace period is wired in
 * core/subagent:
 *  - use sendMessage(custom), not the user role, so the reminder source is identifiable rather than impersonating the user;
 *  - replace “keep working” with a reconciliation request, making human-blocked items a first-class
 *    outcome alongside continuing authorized work and deleting obsolete entries;
 *  - preserve the guard matrix: suppress on abort, cap reminders, and skip while a subagent is
 *    running, a human gate is blocked, or no open items remain.
 */
import { ABORT_STOP_REASON } from './settle-wake-core.ts';

/** Cap reminders for the lifetime of the process, matching the previous behavior. */
export const TODO_REMINDERS_MAX = 3;

/** Custom message type for reminder injection (registerMessageRenderer can customize its TUI appearance). */
export const TODO_REMINDER_CUSTOM_TYPE = 'pi-herdr.todo-reminder';

/**
 * B3 grace window (milliseconds): delay from settled to injection, giving the user a chance to
 * read the closing answer and intervene; starting any agent during the window cancels it. This
 * follows the MACHINE_INJECT_GRACE_MS pattern; PI_HERDR_TODO_GRACE_MS is read per call so tests
 * can use a small value rather than freezing configuration at module load.
 */
export function todoReminderGraceMs(): number {
  return Number(process.env.PI_HERDR_TODO_GRACE_MS ?? 30_000) || 30_000;
}

export interface TodoReminderInput {
  /** Stop reason of the last assistant turn before this settlement (null means treat it as natural completion). */
  lastStopReason: string | null;
  /** Number of reminders already injected. */
  reminders: number;
  /** Number of running background subagents; a positive value means the master is already waiting. */
  runningSubs: number;
  /** ask_user_question wait depth; a positive value means the master is waiting for a human response. */
  blockedDepth: number;
  /** Current todo list. */
  items: ReadonlyArray<{ content: string; status: string }>;
}

export interface TodoReminderPlan {
  /** Whether a reminder should be injected. */
  due: boolean;
  /** Complete injected content, or null when due is false. */
  content: string | null;
  /** New count after successful injection, or the original count when due is false. */
  nextReminders: number;
}

function noInject(reminders: number): TodoReminderPlan {
  return { due: false, content: null, nextReminders: reminders };
}

/**
 * A stop reminder is due only when every guard passes and at least one open (pending/in_progress)
 * item exists. blocked, abandoned, and completed items are not unfinished: once human-waiting work
 * is modeled correctly, reminding again would only pressure the model to act without authorization
 * (the missing guard in the 01a040cc incident).
 */
export function planStopTodoReminder(input: TodoReminderInput): TodoReminderPlan {
  if (input.lastStopReason === ABORT_STOP_REASON) return noInject(input.reminders);
  if (input.reminders >= TODO_REMINDERS_MAX) return noInject(input.reminders);
  if (input.runningSubs > 0) return noInject(input.reminders);
  if (input.blockedDepth > 0) return noInject(input.reminders);
  const open = input.items.filter((it) => it.status === 'pending' || it.status === 'in_progress');
  if (open.length === 0) return noInject(input.reminders);
  const list = open
    .map((it) => (it.status === 'in_progress' ? `▶ ${it.content}` : `· ${it.content}`))
    .join('\n');
  const content = [
    `<system-reminder>You stopped with unfinished todos (Reminder ${input.reminders + 1}/${TODO_REMINDERS_MAX}):`,
    list,
    'Reconcile the list instead of blindly continuing:',
    '- work that is yours AND already authorized by the user → continue it;',
    '- work waiting on a human (decision / approval / ops action) → mark it blocked with a blocker note, and ask the user via ask_user_question when you need their input — never execute it yourself just to clear the list;',
    '- entries that no longer apply → remove them.',
    'Update the list with todo_write in any case.</system-reminder>',
  ].join('\n');
  return { due: true, content, nextReminders: input.reminders + 1 };
}
