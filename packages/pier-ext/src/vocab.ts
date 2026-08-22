/**
 * pi-herdr 桥接词汇（M22：标题即看板）。
 *
 * 这是 DESIGN.md §4.2 定义的"词汇约定"：不发明新传输协议。
 * 传输层 = herdr socket API（NDJSON）；todo 权威 = pi 会话 JSONL。
 * 显示投影 = pane.report_metadata 的 title / state_labels（见 pane-title.ts）。
 */

/** todo 条目五态（D34：三态 + blocked/abandoned，对齐 OMP）。 */
export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'blocked' | 'abandoned';

export const TODO_STATUSES: readonly TodoStatus[] = ['pending', 'in_progress', 'completed', 'blocked', 'abandoned'];

/** todo 条目形状：content + 五态 status；可选 blocker（仅 blocked）、可选 phase（D43 分组）。无稳定 id（全量替换语义）。 */
export interface TodoItem {
  content: string;
  status: TodoStatus;
  /** 仅 status==='blocked' 时允许非空字符串（D34）。 */
  blocker?: string;
  /** 可选分组名（D43）；非空、≤30 字符。 */
  phase?: string;
}

/** 完整 todo 快照（每次 todo_write 提交的就是它，last-wins）。 */
export interface TodoSnapshot {
  /** 语义版本，形状变化时递增；消费方据此丢弃陈旧数据。 */
  version: 1;
  items: TodoItem[];
}

/** 快照计数（反馈文案与标题投影都用它）。 */
export interface TodoCounts {
  pending: number;
  inProgress: number;
  completed: number;
  /** D91：blocked 单列（title 四件套 ▶○■✓）。 */
  blocked: number;
}

/** pi 扩展经 `pane.report-agent` 上报语义状态时使用的 source 名。 */
export const REPORT_AGENT_SOURCE = 'pi-herdr';

/** 升级后首次上报用来清掉旧 16-key 分块的头键（M13b 残留）。 */
export const PI_HERDR_META_KEY = 'pi-herdr';

/** todo 工具面向模型的名称（与 DSH 一致）。 */
export const TODO_TOOL_NAME = 'todo_write';

/** 工具结果 details 里存放快照的键（随 pi 会话 JSONL 持久化，分支正确）。 */
export const TODO_DETAILS_KEY = 'pi-herdr.todo';

/** 反馈文案（与 DSH 逐字一致，模型词汇可互迁移）。 */
export function formatTodoConfirmation(items: TodoItem[]): string {
  const c = countTodos(items);
  return `Updated todo list: ${c.pending} pending, ${c.inProgress} in progress, ${c.completed} completed.`;
}

export function countTodos(items: TodoItem[]): TodoCounts {
  let pending = 0;
  let inProgress = 0;
  let completed = 0;
  let blocked = 0;
  for (const it of items) {
    if (it.status === 'pending') pending++;
    else if (it.status === 'in_progress') inProgress++;
    else if (it.status === 'completed') completed++;
    else if (it.status === 'blocked') blocked++;
    // abandoned 不计入计数（D34）；blocked 单列（D91 图标四件套进 title）
  }
  return { pending, inProgress, completed, blocked };
}

/** 子代理结算通知文案（对齐 DSH 的 settlement notice）。 */
export function formatSettlementNotice(
  agentId: string,
  closingMessage: string | null,
): string {
  const head = `Background subagent ${agentId} finished and will do no further work unless you send it more.`;
  return closingMessage
    ? `${head} Its closing message: ${closingMessage}`
    : `${head} It left no closing message.`;
}
