/**
 * D69：todo 阅读钩子规划（before_agent_start + display:false）。
 */
import { boundedView, currentActivity, type TodoItem } from './todo-core.ts';
import { countTodos } from './vocab.ts';

export const EMPTY_GUARD_EVERY_N = 4;
export const TODO_READ_CUSTOM_TYPE = 'pi-herdr.todo-read';

export interface TodoReadPlan {
  inject: boolean;
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
}): TodoReadPlan {
  const empty = opts.items.length === 0;
  if (empty) {
    const due = opts.lastEmptyGuardTurn == null
      || opts.turn - opts.lastEmptyGuardTurn >= EMPTY_GUARD_EVERY_N;
    return {
      inject: due,
      message: {
        customType: TODO_READ_CUSTOM_TYPE,
        content: 'Your todo list is empty. If the current work needs tracking, call todo_write before stopping.',
        display: false,
      },
    };
  }
  const c = countTodos(opts.items);
  const view = boundedView(opts.items, 6);
  const lines = view.visible.map((it) => {
    const mark = it.status === 'in_progress' ? '▶' : it.status === 'blocked' ? '■' : it.status === 'completed' ? '✓' : '○';
    return `${mark} ${it.content}`;
  });
  const activity = currentActivity(opts.items as TodoItem[]);
  const head = `todos ▶${c.inProgress} ○${c.pending} ■${c.blocked} ✓${c.completed}`
    + (activity ? ` · ${activity}` : '');
  return {
    inject: true,
    message: {
      customType: TODO_READ_CUSTOM_TYPE,
      content: [head, ...lines].join('\n'),
      display: false,
    },
  };
}
