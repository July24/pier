/**
 * D69：todo 阅读钩子规划（before_agent_start + display:false）。
 * 反冻结（stale-core）：全完成列表过期后不再复读——
 *  - stale（turns 维度）→ 警告 + 旧条目（供改写参照），每 N 轮一次、封顶；
 *  - archived（墙钟维度）→ 按不存在处理，归档通知与空列表共用守卫节奏。
 */
import { boundedView, currentActivity, type TodoItem } from './todo-core.ts';
import { countTodos } from './vocab.ts';
import { STALE_NOTICE_MAX, evaluateStaleness, formatAge } from './stale-core.ts';

/** 空守卫 / stale 警告 / 归档通知共用的注入节奏（每 N 轮）。 */
export const EMPTY_GUARD_EVERY_N = 4;
export const TODO_READ_CUSTOM_TYPE = 'pi-herdr.todo-read';

export type TodoReadEffect =
  | 'recite' // 正常复读（列表新鲜）
  | 'empty-guard' // 空列表守卫
  | 'stale-notice' // A：turns 维度过期警告
  | 'archive-notice' // B：墙钟维度归档通知
  | 'none'; // 限频/封顶跳过

export interface TodoReadPlan {
  inject: boolean;
  effect: TodoReadEffect;
  /** 当前归档态（与 inject 无关；调用方据此刷新 widget/title 投影）。 */
  archived: boolean;
  message: {
    customType: string;
    content: string;
    display: false;
  };
}

const MARKS: Record<TodoItem['status'], string> = {
  pending: '○',
  in_progress: '▶',
  completed: '✓',
  blocked: '■',
  abandoned: '✗',
};

export function planTodoReadHook(opts: {
  items: readonly TodoItem[];
  turn: number;
  lastEmptyGuardTurn: number | null;
  /** stale-core 时钟锚点（TodosService.lastWriteAt）。 */
  lastWriteAt: number | null;
  /** 距上次 todo 写入的轮数（本进程内已知时）。 */
  turnsSinceWrite: number | null;
  now: number;
  /** 本停滞期已注入的 stale 警告数。 */
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
    // B：明细不再注入（按不存在处理）；归档通知与空守卫共用节奏与计数器。
    const c = countTodos(opts.items as TodoItem[]);
    const age = st.ageMs == null ? '' : ` ${formatAge(st.ageMs)} ago`;
    return {
      inject: guardDue,
      effect: 'archive-notice',
      archived: true,
      message: msg(
        guardDue
          ? `Your previous todo list (${c.completed} completed entries, last updated${age}) is complete and stale — it has been archived and is no longer shown or injected. Work after it is untracked. Call todo_write with a fresh list matching the current work, or [] if tracking is not needed.`
          : '',
      ),
    };
  }

  if (st.kind === 'stale') {
    // A：复读改警告；保留旧条目行供模型改写参照。封顶 STALE_NOTICE_MAX。
    const staleDue = opts.lastStaleGuardTurn == null
      || opts.turn - opts.lastStaleGuardTurn >= EMPTY_GUARD_EVERY_N;
    if (!staleDue || opts.staleNotices >= STALE_NOTICE_MAX) {
      return { inject: false, effect: 'none', archived: false, message: msg('') };
    }
    const c = countTodos(opts.items as TodoItem[]);
    const head = `todos ▶${c.inProgress} ○${c.pending} ■${c.blocked} ✓${c.completed}`
      + ` · unchanged for ${opts.turnsSinceWrite} turns, nothing open`;
    const lines = opts.items.map((it) => `  ${MARKS[it.status]} ${it.content}`);
    const warn = 'This list no longer reflects the work you are doing. Rewrite the full list with todo_write to match current work, or send [] to clear it.';
    return {
      inject: true,
      effect: 'stale-notice',
      archived: false,
      message: msg([head, ...lines, warn].join('\n')),
    };
  }

  // fresh：原有每轮复读。
  const c = countTodos(opts.items);
  const view = boundedView(opts.items, 6);
  const lines = view.visible.map((it) => `${MARKS[it.status]} ${it.content}`);
  const activity = currentActivity(opts.items);
  const head = `todos ▶${c.inProgress} ○${c.pending} ■${c.blocked} ✓${c.completed}`
    + (activity ? ` · ${activity}` : '');
  return {
    inject: true,
    effect: 'recite',
    archived: false,
    message: msg([head, ...lines].join('\n')),
  };
}
