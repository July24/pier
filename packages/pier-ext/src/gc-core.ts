/**
 * 任务 tab GC 决策（D29 的判定规则抽成纯函数；M22 取消 resident 豁免）。
 * 无副作用、无 pi/herdr API 依赖 → 可单测。
 */
export type GcEntryKind = string;
export type GcEntryStatus = 'running' | 'settled' | 'consumed' | 'closed';

export interface GcEntryLike {
  /** 'task' 或 role 名；旧值 short/resident 只作标签，不参与判定。 */
  kind: GcEntryKind;
  status: GcEntryStatus;
  /** 消费时间（GC 宽限期判据；closed 条目保留原值）。 */
  consumedAt?: number | null;
}

function isFinished(status: GcEntryStatus): boolean {
  return status === 'consumed' || status === 'closed' || status === 'settled';
}

/**
 * D29 / M22：任务 tab 是否该关（全部条件同时成立）：
 *  - 含 ≥1 个工作 pane（主 tab 无委派条目 → 永不关）；
 *  - 全部工作 pane 已 settled/consumed/closed（kind 不再豁免）；
 *  - 宽限期已过（时间制 TTL；ttlMs=0 表示不自动关，由调用方把关）；
 *  - 无 blocked pane（人类闸门豁免）；
 *  - 其余 pane 全部 idle/done/unknown（非工作 pane 允许 unknown）。
 */
export function shouldCloseTaskTab(opts: {
  entries: readonly GcEntryLike[];
  paneStatuses: readonly string[];
  ttlMs: number;
  now: number;
}): boolean {
  if (opts.entries.length === 0) return false;
  if (!opts.entries.every((e) => isFinished(e.status))) return false;
  if (!opts.entries.every((e) => (e.consumedAt ?? 0) > 0 && (e.consumedAt ?? 0) < opts.now - opts.ttlMs)) return false;
  if (opts.paneStatuses.some((s) => s === 'blocked')) return false;
  if (!opts.paneStatuses.every((s) => s === 'idle' || s === 'done' || s === 'unknown')) return false;
  return true;
}

/**
 * pane 级回收判定（孤儿/兼容路径，v1.2 语义）：
 *  - 消费于上一轮之前（宽限：结算通知那一轮人可看、模型可用）；
 *  - herdr 显式状态 idle/done（unknown/working/blocked → 下轮重试，#943 容错）；
 *  - pane 已消失（status undefined）→ 补记 closed（返回 true 由调用方处理）。
 */
export function shouldClosePane(opts: {
  consumedAt: number | null;
  herdrStatus: string | undefined;
  prevTurnStart: number;
}): boolean {
  if (opts.herdrStatus === undefined) return true; // pane 没了 → 补记 closed
  if (opts.herdrStatus !== 'idle' && opts.herdrStatus !== 'done') return false;
  return (opts.consumedAt ?? 0) > 0 && opts.consumedAt! < opts.prevTurnStart;
}
