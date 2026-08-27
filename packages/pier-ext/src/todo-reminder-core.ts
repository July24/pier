/**
 * stop 未完成提醒决策纯核心（D41 二修；session 01a040cc 实证）。
 *
 * 实证链：模型收尾 prose 写「待 push、建议随车发布」（= 有意留给用户决定），
 * 但 todo 列表残留 `[pending] push 到仓库`；旧版 D41 在 agent_settled 后
 * 116ms 以 user-role sendUserMessage 注入「Continue working on them before
 * stopping」——通道权威高于模型 20s 前的判断，12s 内 git push 执行了不在
 * 授权范围内的操作。
 *
 * 三修（决策与文案全在本模块，时序宽限在 core/subagent 接线）：
 *  - 通道：sendMessage(custom)（非 user 角色）——提醒来源可辨，不冒充用户；
 *  - 措辞：祈使「继续干」→ 对账请求——「等人工的条目标 blocked / 问用户」
 *    升为一等出口，与「继续已授权工作」「删除失效条目」并列；
 *  - 守卫矩阵不变：abort 抑制 / 封顶 / 在途 subagent / blocked 深度 / 无 open 项。
 */
import { ABORT_STOP_REASON } from './settle-wake-core.ts';

/** 提醒封顶（整个进程生命周期；与旧版一致）。 */
export const TODO_REMINDERS_MAX = 3;

/** 提醒注入的 custom 消息类型（registerMessageRenderer 可按此定制 TUI 外观）。 */
export const TODO_REMINDER_CUSTOM_TYPE = 'pi-herdr.todo-reminder';

/**
 * B3 宽限窗（毫秒）：settled → 实际注入的延迟——用户反制窗口（收尾答案先被
 * 人读到；期间任何 agent 启动即取消）。对齐 MACHINE_INJECT_GRACE_MS 模式；
 * PI_HERDR_TODO_GRACE_MS 可调（测试用小值）。逐次读取（非模块加载时定格）。
 */
export function todoReminderGraceMs(): number {
  return Number(process.env.PI_HERDR_TODO_GRACE_MS ?? 30_000) || 30_000;
}

export interface TodoReminderInput {
  /** 本次 settled 前最后一次 assistant turn 的 stopReason（未知 = null，视作自然结束）。 */
  lastStopReason: string | null;
  /** 已注入的提醒次数。 */
  reminders: number;
  /** 在途后台 subagent 数（>0 = 主控本就在等，不催）。 */
  runningSubs: number;
  /** ask_user_question 等待深度（>0 = 等人类回答，不催）。 */
  blockedDepth: number;
  /** 当前 todo 列表。 */
  items: ReadonlyArray<{ content: string; status: string }>;
}

export interface TodoReminderPlan {
  /** 是否应注入。 */
  due: boolean;
  /** 注入的完整 content（due=false 时 null）。 */
  content: string | null;
  /** 注入成功后的新计数（due=false 时原样返回）。 */
  nextReminders: number;
}

function noInject(reminders: number): TodoReminderPlan {
  return { due: false, content: null, nextReminders: reminders };
}

/**
 * stop 提醒决策：全部守卫通过且存在 open（pending/in_progress）条目时 due。
 * blocked / abandoned / completed 均不算未完成——等人工的条目正确建模后
 * 不应再被催（这正是 01a040cc 事故里缺失的一步）。
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
