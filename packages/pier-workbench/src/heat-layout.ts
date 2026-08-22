/**
 * M23 热力布局规划器（D91 档 3：网格原地热力）。
 *
 * 核心原则（用户拍板）：pane 一律**不动位置**（零 swap），只调 split ratio——
 * 聚焦 pane「原地变大」，其余格子缩小；无 blocked/ask 的小格自然被压成 title 条。
 *
 * 几何：herdr ratio = split 节点 first child 的份额（0.8.2 源码 split_rect：
 * first_w = width * ratio），引擎钳制 [0.10, 0.90]。
 *
 * 历史：档 1（D67 swap-to-first + 0.65）与档 2（D90 栈顶升位 + 权重链）已被本档
 * 取代——实机反馈「点击 = 原位置变大，不是换到第一个位置」。档 2 还藏着一个
 * 方向反写的 bug（ratio 误当 second 份额，活体只断言位置未断言尺寸而漏网），
 * 本档按 herdr 源码语义重写。
 */
export const MAX_AUTO_LAYOUT_PANES = 10;
export const PANE_MIN_AGE_MS = 3000;
export const REFLOW_DEBOUNCE_MS = 150;
/** herdr 引擎对 split ratio 的静默钳制下限（d90-C 实测；0.8.2 源码 set_ratio_at clamp(0.1,0.9) 佐证）。 */
export const RATIO_FLOOR = 0.10;
/** 聚焦 pane 的目标面积占比（全 tab）。沿路径每层取 T^(1/depth) 几何均摊，避免深层复利萎缩。 */
export const FOCUS_SHARE = 0.72;
/** 焦点外存在 blocked pane 时聚焦让位（0.72 → 0.60），面积让给「最需要关注」的格子。 */
export const FOCUS_SHARE_BLOCKED = 0.60;
/** D95 兄弟子树按状态分饼的权重：blocked 3 / ask 2.5 / working 1.4 / idle 1。 */
export const BLOCKED_WEIGHT = 3;
export const ASK_WEIGHT = 2.5;
export const WORKING_WEIGHT = 1.4;
export const IDLE_WEIGHT = 1;
/** D95 窄条阈值：非焦点 pane ≥ 此数时，idle/working 权重 ×0.6（压向 0.10 地板 = title 条视觉）。 */
export const SLIM_THRESHOLD = 4;
export const SLIM_FACTOR = 0.6;

export type LayoutNode =
  | { type: 'pane'; pane_id: string }
  | { type: 'split'; direction: 'right' | 'down'; ratio: number; first: LayoutNode; second: LayoutNode };

/** 网格规划器只产 ratio op（零 swap 是本档的立身之本）。 */
export type HeatOp = { kind: 'ratio'; path: boolean[]; ratio: number };

export type HeatPlan =
  | { type: 'skip'; reason?: string }
  | { type: 'apply'; ops: HeatOp[] };

export function countPanes(node: LayoutNode): number {
  return node.type === 'pane' ? 1 : countPanes(node.first) + countPanes(node.second);
}

export function unwrapLayout(exported: unknown): {
  root: LayoutNode | null;
  tabId: string | null;
  zoomed: boolean;
} {
  const obj = (exported ?? {}) as Record<string, unknown>;
  const layout = (obj.layout ?? obj) as Record<string, unknown>;
  const root = (layout.root ?? obj.root ?? null) as LayoutNode | null;
  const tabId = (typeof layout.tab_id === 'string' ? layout.tab_id : null)
    ?? (typeof obj.tab_id === 'string' ? obj.tab_id : null);
  return { root, tabId, zoomed: Boolean(layout.zoomed ?? obj.zoomed) };
}

export function firstPaneId(node: LayoutNode): string {
  return node.type === 'pane' ? node.pane_id : firstPaneId(node.first);
}

export function containsPane(node: LayoutNode, paneId: string): boolean {
  if (node.type === 'pane') return node.pane_id === paneId;
  return containsPane(node.first, paneId) || containsPane(node.second, paneId);
}

export function shouldAcceptFocus(opts: { paneAgeMs: number; cause?: string | null }): boolean {
  if (opts.cause === 'user') return true;
  if (opts.cause === 'plugin') return false;
  return opts.paneAgeMs >= PANE_MIN_AGE_MS;
}

export function shouldFireDebounced(opts: { stored: string; incoming: string }): boolean {
  return opts.stored === opts.incoming;
}

/* ════════ 档 3（D91）：网格原地热力 ════════ */

/** paneId → agent 状态（'blocked' | 'working' | 'idle' | 'done' | 'unknown' | …）。 */
export type AgentStatusMap = Record<string, string>;
/** paneId → 是否 ask_user_question 等待（人类闸门；tokens['pi-ask'] 非空）。 */
export type AskFlagMap = Record<string, boolean>;

/** 展平树（先序）。 */
export function flattenPanes(node: LayoutNode): string[] {
  return node.type === 'pane' ? [node.pane_id] : [...flattenPanes(node.first), ...flattenPanes(node.second)];
}

/** 分级权重：blocked 最受关注，ask（人类闸门）次之，working 再次，idle 最小。 */
export function tierWeight(status: string | undefined, isAsk = false, slim = false): number {
  if (status === 'blocked') return isAsk ? ASK_WEIGHT : BLOCKED_WEIGHT;
  if (status === 'working') return slim ? WORKING_WEIGHT * SLIM_FACTOR : WORKING_WEIGHT;
  return slim ? IDLE_WEIGHT * SLIM_FACTOR : IDLE_WEIGHT;
}

type SplitNode = Extract<LayoutNode, { type: 'split' }>;

interface PathStep {
  node: SplitNode;
  side: 'first' | 'second';
}

/** 根→焦点叶的路径（每步记录 split 节点与焦点所在侧）。 */
function findPath(node: LayoutNode, targetId: string): PathStep[] | null {
  if (node.type === 'pane') return node.pane_id === targetId ? [] : null;
  if (containsPane(node.first, targetId)) {
    return [{ node, side: 'first' }, ...(findPath(node.first, targetId) ?? [])];
  }
  if (containsPane(node.second, targetId)) {
    return [{ node, side: 'second' }, ...(findPath(node.second, targetId) ?? [])];
  }
  return null;
}

function clampRatio(r: number): number {
  return Math.min(1 - RATIO_FLOOR, Math.max(RATIO_FLOOR, r));
}

function weightOf(node: LayoutNode, statuses: AgentStatusMap, askFlags: AskFlagMap, slim: boolean): number {
  return flattenPanes(node).reduce((sum, id) => sum + tierWeight(statuses[id], askFlags[id] === true, slim), 0);
}

/** 兄弟子树内部：每个 split 按 first/second 权重比分饼（ratio = first 份额）。 */
function weightedEqualize(node: LayoutNode, path: boolean[], statuses: AgentStatusMap, askFlags: AskFlagMap, slim: boolean, ops: HeatOp[]): void {
  if (node.type === 'pane') return;
  const wFirst = weightOf(node.first, statuses, askFlags, slim);
  const wSecond = weightOf(node.second, statuses, askFlags, slim);
  ops.push({ kind: 'ratio', path, ratio: clampRatio(wFirst / (wFirst + wSecond)) });
  weightedEqualize(node.first, [...path, false], statuses, askFlags, slim, ops);
  weightedEqualize(node.second, [...path, true], statuses, askFlags, slim, ops);
}

/**
 * 网格原地热力：聚焦 pane 沿路径每层拿 r = T^(1/depth)（first 在焦点侧则 ratio=r，
 * 否则 1-r），乘积 = 聚焦格占全 tab 的 T；每个旁支子树按状态权重均分余量。
 *
 * 性质：树上每个 split 恰好产出一个 ratio op（路径上的按 r，旁支的按权重）；
 * 不产任何 swap——pane 位置永远不动。
 */
export function planGridHeat(opts: {
  root: LayoutNode;
  focusPaneId: string;
  paneCount: number;
  zoomed?: boolean;
  enabled?: boolean;
  statuses?: AgentStatusMap;
  /** D95：ask_user_question 等待标志（人类闸门，区分纯 blocked）。 */
  askFlags?: AskFlagMap;
}): HeatPlan {
  if (opts.enabled === false) return { type: 'skip', reason: 'disabled' };
  if (opts.zoomed) return { type: 'skip', reason: 'zoomed' };
  if (opts.paneCount > MAX_AUTO_LAYOUT_PANES) return { type: 'skip', reason: 'too-many' };
  if (opts.root.type === 'pane' || opts.paneCount <= 1) return { type: 'skip', reason: 'single' };
  if (!containsPane(opts.root, opts.focusPaneId)) return { type: 'skip', reason: 'missing' };

  const statuses = opts.statuses ?? {};
  const askFlags = opts.askFlags ?? {};
  // D95 窄条：非焦点 pane ≥ 阈值 → idle/working 权重 ×0.6（blocked/ask 不受影响）
  const slim = opts.paneCount - 1 >= SLIM_THRESHOLD;
  const steps = findPath(opts.root, opts.focusPaneId) ?? [];

  // 焦点路径各层的旁支子树（含其在树中的 bool 路径）
  const offPath: Array<{ node: LayoutNode; path: boolean[] }> = [];
  let bools: boolean[] = [];
  for (const step of steps) {
    const siblingSide = step.side === 'first' ? true : false;
    offPath.push({
      node: step.side === 'first' ? step.node.second : step.node.first,
      path: [...bools, siblingSide],
    });
    bools = [...bools, step.side === 'first' ? false : true];
  }

  const hasBlocked = offPath.some(({ node }) => flattenPanes(node).some((id) => statuses[id] === 'blocked'));
  const target = hasBlocked ? FOCUS_SHARE_BLOCKED : FOCUS_SHARE;
  const r = clampRatio(target ** (1 / steps.length));

  const ops: HeatOp[] = [];
  bools = [];
  for (const step of steps) {
    ops.push({ kind: 'ratio', path: bools, ratio: step.side === 'first' ? r : 1 - r });
    bools = [...bools, step.side === 'first' ? false : true];
  }
  for (const { node, path } of offPath) weightedEqualize(node, path, statuses, askFlags, slim, ops);
  return { type: 'apply', ops };
}

/** 测试/活体共用：按导出的树算每个 pane 的面积占比（先序）。 */
export function paneAreaShares(root: LayoutNode): Record<string, number> {
  const shares: Record<string, number> = {};
  const walk = (node: LayoutNode, share: number): void => {
    if (node.type === 'pane') {
      shares[node.pane_id] = share;
      return;
    }
    walk(node.first, share * node.ratio);
    walk(node.second, share * (1 - node.ratio));
  };
  walk(root, 1);
  return shares;
}
