/**
 * todo 陈旧度纯核心（反冻结：会话 01a03253 实证）。
 *
 * 实证：全完成列表（3✓）冻结 16h / 37 轮，模型持续做新工作但 todo_write 零调用；
 * 读钩每轮复读死列表反而背书"无事可跟踪"，标题满权重渲染死计数。
 * 本模块把"列表是否还反映现实"收敛为纯函数，三层消费：
 *  - stale（A）：open==0 且 ≥ STALE_TURNS 轮未写 → 读钩注入改 stale 警告（限频 + 封顶）；
 *  - archived（B）：open==0 且墙钟 ≥ STALE_CLOCK_MS 未写 → 按不存在处理
 *    （注入/投影不再复读明细；条目保留，/todos 可查；会话 JSONL 权威不动）；
 *  - 标题（D）：archived 时窗格/侧栏渲染 `✓N done <age>`，不再冒充当前状态。
 *
 * 有 open 项（pending/in_progress/blocked）的列表永不判 stale——未完成工作
 * 仍由 agent_settled 提醒兜底；lastWriteAt 未知（旧会话无时间戳）→ 时钟维度
 * 保守不判 archived，turns 维度不受影响。
 */
import { countTodos, type TodoItem } from './vocab.ts';

/** A：turns 维度过期阈值（用户轮次，自上次 todo 写入起算）。 */
export const STALE_TURNS = 6;

/** B：墙钟维度归档阈值（全完成列表最后一次写入距今）。 */
export const STALE_CLOCK_MS = 60 * 60 * 1000;

/** A：每次停滞期最多注入的 stale 警告数（防空转噪音；archived 后转归档通知节奏）。 */
export const STALE_NOTICE_MAX = 3;

export type StalenessKind = 'fresh' | 'stale' | 'archived';

export interface Staleness {
  kind: StalenessKind;
  /** open = pending + in_progress + blocked（abandoned 不算未完成）。 */
  open: number;
  /** now - lastWriteAt；lastWriteAt 未知 → null。 */
  ageMs: number | null;
}

/** open 计数：stale/archived 只对 open==0 的全完成（或全放弃）列表生效。 */
export function openTodos(items: readonly TodoItem[]): number {
  const c = countTodos(items as TodoItem[]);
  return c.pending + c.inProgress + c.blocked;
}

/**
 * 陈旧度判定（双条件：turns 维度 → stale；墙钟维度 → archived，时钟优先）。
 * 空列表 → fresh（空守卫另有归属）；lastWriteAt null → 永不 stale（保守）。
 */
export function evaluateStaleness(opts: {
  items: readonly TodoItem[];
  lastWriteAt: number | null;
  turnsSinceWrite: number | null;
  now: number;
}): Staleness {
  const open = openTodos(opts.items);
  const ageMs = opts.lastWriteAt == null ? null : Math.max(0, opts.now - opts.lastWriteAt);
  const st: Staleness = { kind: 'fresh', open, ageMs };
  if (opts.items.length === 0 || open > 0) return st;
  if (ageMs != null && ageMs >= STALE_CLOCK_MS) st.kind = 'archived';
  else if (opts.turnsSinceWrite != null && opts.turnsSinceWrite >= STALE_TURNS) st.kind = 'stale';
  return st;
}

/** 标题/镜像路径专用（无 turn 信息）：仅墙钟维度的 archived 判定。 */
export function isArchived(
  items: readonly TodoItem[],
  lastWriteAt: number | null,
  now: number,
): boolean {
  return evaluateStaleness({ items, lastWriteAt, turnsSinceWrite: null, now }).kind === 'archived';
}

/** 年龄显示：<60m → `Nm`；<48h → `Nh`（floor）；否则 `Nd`。 */
export function formatAge(ms: number): string {
  if (ms < 60 * 60_000) return `${Math.max(1, Math.floor(ms / 60_000))}m`;
  if (ms < 48 * 3_600_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}
