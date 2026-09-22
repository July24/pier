/**
 * Plan the todo read hook (before_agent_start + display:false). Stale-core keeps a fully completed list
 * from being recited forever: stale (turn-based) warns with the old entries as rewrite references,
 * rate-limited and capped; archived (wall-clock) treats the list as absent, sharing the guard cadence
 * with empty lists.
 */
import { boundedView, currentActivity, type TodoItem } from './todo-core.ts';
import { countTodos } from './vocab.ts';
import { STALE_NOTICE_MAX, evaluateStaleness, formatAge } from './stale-core.ts';
import { todoMark } from './todo-window.ts';

/** Cadence shared by empty-list guards, stale warnings, and archive notices. */
const EMPTY_GUARD_EVERY_N = 4;
const TODO_READ_CUSTOM_TYPE = 'pi-herdr.todo-read';

type TodoReadEffect =
  | 'recite' // Recite normally while the list is fresh.
  | 'empty-guard' // Guard against an empty list.
  | 'stale-notice' // Warn when the list is stale by turns, or when archiving is one window away.
  | 'archive-notice' // Notify once the list is archived by wall-clock age.
  | 'none'; // Skip because of rate limits or caps.

interface TodoReadPlan {
  inject: boolean;
  effect: TodoReadEffect;
  /** Current archive state, independent of injection, so callers can refresh widget/title projections. */
  archived: boolean;
  /** Clear the in-memory list when injecting the archive notice (the caller persists the empty JSONL);
   * a kept dead list would suppress the empty guard that resumes tracking after an idle gap. */
  clearArchived: boolean;
  message: {
    customType: string;
    content: string;
    display: false;
  };
}

export function planTodoReadHook(opts: {
  items: readonly TodoItem[];
  turn: number;
  lastEmptyGuardTurn: number | null;
  /** stale-core clock anchor (TodosService.lastWriteAt). */
  lastWriteAt: number | null;
  turnsSinceWrite: number | null;
  now: number;
  staleNotices: number;
  lastStaleGuardTurn: number | null;
}): TodoReadPlan {
  const msg = (content: string) => ({
    customType: TODO_READ_CUSTOM_TYPE,
    content,
    display: false as const,
  });
  const guardDue = opts.lastEmptyGuardTurn == null
    || opts.turn - opts.lastEmptyGuardTurn >= EMPTY_GUARD_EVERY_N;

  if (opts.items.length === 0) {
    return {
      inject: guardDue,
      effect: 'empty-guard',
      clearArchived: false,
      archived: false,
      message: msg(
        guardDue
          ? 'Your todo list is empty. If the current work needs tracking, call todo_write before stopping.'
          : '',
      ),
    };
  }

  const st = evaluateStaleness({
    items: opts.items,
    lastWriteAt: opts.lastWriteAt,
    turnsSinceWrite: opts.turnsSinceWrite,
    now: opts.now,
  });

  if (st.kind === 'archived') {
    const c = countTodos(opts.items);
    const age = st.ageMs == null ? '' : ` ${formatAge(st.ageMs)} ago`;
    // Idle periods do not consume turns, so give one rewrite window with the old entries as reference
    // before the terminal notice.
    if (opts.staleNotices === 0 && guardDue) {
      const lines = opts.items.map((it) => `  ${todoMark(it.status)} ${it.content}`);
      const head = `todos ✓${c.completed} (all completed, last updated${age}) — about to be archived`;
      const warn = 'One rewrite window before archiving: if the work you are doing now is multi-step, rewrite the full list with todo_write to track it (old entries below as reference — reuse what still applies). Single-step Q&A may skip tracking. If the list stays untouched, it will be archived and cleared on the next reminder.';
      return {
        inject: true,
        effect: 'stale-notice',
        archived: true,
        clearArchived: false,
        message: msg([head, ...lines, warn].join('\n')),
      };
    }
    // The terminal notice carries no details and no "skip tracking" escape hatch — multi-step work
    // must get a fresh list, single-step Q&A may proceed untracked.
    return {
      inject: guardDue,
      effect: 'archive-notice',
      archived: true,
      clearArchived: guardDue,
      message: msg(
        guardDue
          ? `Your previous todo list (${c.completed} completed entries, last updated${age}) has been archived and cleared from tracking; the list is now empty. If the current work is multi-step, call todo_write with a fresh list now — multi-step work must be tracked. Single-step answers may proceed without a list.`
          : '',
      ),
    };
  }

  if (st.kind === 'stale') {
    const staleDue = opts.lastStaleGuardTurn == null
      || opts.turn - opts.lastStaleGuardTurn >= EMPTY_GUARD_EVERY_N;
    if (!staleDue || opts.staleNotices >= STALE_NOTICE_MAX) {
      return { inject: false, effect: 'none', archived: false, clearArchived: false, message: msg('') };
    }
    const c = countTodos(opts.items);
    const head = `todos ▶${c.inProgress} ○${c.pending} ■${c.blocked} ✓${c.completed}`
      + ` · unchanged for ${opts.turnsSinceWrite} turns, nothing open`;
    const lines = opts.items.map((it) => `  ${todoMark(it.status)} ${it.content}`);
    const warn = 'This list no longer reflects the work you are doing. Rewrite the full list with todo_write to match current work, or send [] to clear it.';
    return {
      inject: true,
      effect: 'stale-notice',
      clearArchived: false,
      archived: false,
      message: msg([head, ...lines, warn].join('\n')),
    };
  }

  // Fresh lists are recited every turn to keep current work visible.
  const c = countTodos(opts.items);
  const view = boundedView(opts.items, 6);
  const lines = view.visible.map((it) => `${todoMark(it.status)} ${it.content}`);
  const activity = currentActivity(opts.items);
  const head = `todos ▶${c.inProgress} ○${c.pending} ■${c.blocked} ✓${c.completed}`
    + (activity ? ` · ${activity}` : '');
  return {
    inject: true,
    effect: 'recite',
    clearArchived: false,
    archived: false,
    message: msg([head, ...lines].join('\n')),
  };
}
