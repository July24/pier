/**
 * M23 heat layout planner (D91 Tier 3: in-place grid heat).
 *
 * Panes NEVER move position (zero swaps) — only split ratios change: the focused pane expands in place
 * and the remaining cells shrink. Geometry: herdr's ratio is the split node's first child share
 * (0.8.2 split_rect: first_w = width * ratio), clamped by the engine to [0.10, 0.90].
 */
export const MAX_AUTO_LAYOUT_PANES = 10;
export const PANE_MIN_AGE_MS = 3000;
export const REFLOW_DEBOUNCE_MS = 150;
/** Herdr engine silent ratio clamp lower bound (0.8.2 set_ratio_at clamps to [0.1, 0.9]). */
export const RATIO_FLOOR = 0.10;
/** Target area share of the focused pane (whole tab), split geometrically along the path at T^(1/depth) per level to avoid deep compounding shrinkage. */
export const FOCUS_SHARE = 0.72;
/** Focused pane yields share (0.72 -> 0.60) when blocked panes exist outside the focus. */
export const FOCUS_SHARE_BLOCKED = 0.60;
/** D95 sibling subtree status weighting: blocked 3 / ask 2.5 / working 1.4 / idle 1. */
export const BLOCKED_WEIGHT = 3;
export const ASK_WEIGHT = 2.5;
export const WORKING_WEIGHT = 1.4;
export const IDLE_WEIGHT = 1;
/** D95 slim threshold: at this many non-focused panes, idle/working weights * 0.6 (compress toward the 0.10 floor = title bar). */
export const SLIM_THRESHOLD = 4;
export const SLIM_FACTOR = 0.6;

export type LayoutNode =
  | { type: 'pane'; pane_id: string }
  | { type: 'split'; direction: 'right' | 'down'; ratio: number; first: LayoutNode; second: LayoutNode };

/** Grid planner produces only ratio ops (zero swaps is the foundational rule of this tier). */
export type HeatOp = { kind: 'ratio'; path: boolean[]; ratio: number };

export type HeatPlan =
  | { type: 'skip'; reason?: string }
  | { type: 'apply'; ops: HeatOp[] };

export function countPanes(node: LayoutNode): number {
  return node.type === 'pane' ? 1 : countPanes(node.first) + countPanes(node.second);
}

function normalizeNode(raw: unknown): LayoutNode | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.type === 'pane') {
    const nested = o.pane as Record<string, unknown> | undefined;
    const id = typeof o.pane_id === 'string' ? o.pane_id
      : typeof nested?.pane_id === 'string' ? nested.pane_id : null;
    return id ? { type: 'pane', pane_id: id } : null;
  }
  if (o.type === 'split') {
    const first = normalizeNode(o.first);
    const second = normalizeNode(o.second);
    if (!first || !second) return null;
    const direction = o.direction === 'down' || o.direction === 'vertical' ? 'down' : 'right';
    return {
      type: 'split',
      direction,
      ratio: typeof o.ratio === 'number' ? o.ratio : 0.5,
      first,
      second,
    };
  }
  return null;
}

export function unwrapLayout(exported: unknown): {
  root: LayoutNode | null;
  tabId: string | null;
  zoomed: boolean;
} {
  const obj = (exported ?? {}) as Record<string, unknown>;
  const layout = (obj.layout ?? obj) as Record<string, unknown>;
  const root = normalizeNode(layout.root ?? obj.root ?? null);
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

/* ════════ Tier 3 (D91): in-place grid heat ════════ */

/** paneId -> agent status ('blocked' | 'working' | 'idle' | 'done' | 'unknown' | ...). */
export type AgentStatusMap = Record<string, string>;
/** paneId -> whether waiting on ask_user_question (human gate; tokens['pi-ask'] non-empty). */
export type AskFlagMap = Record<string, boolean>;

/** Flatten tree (pre-order). */
export function flattenPanes(node: LayoutNode): string[] {
  return node.type === 'pane' ? [node.pane_id] : [...flattenPanes(node.first), ...flattenPanes(node.second)];
}

/** Tier weight: blocked receives highest attention, ask (human gate) second, working third, idle least. */
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

/** Path from root to focused leaf (each step records the split node and which side the focus is on). */
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

/** Inside sibling subtrees: each split divides share by first/second weight ratio (ratio = first share). */
function weightedEqualize(node: LayoutNode, path: boolean[], statuses: AgentStatusMap, askFlags: AskFlagMap, slim: boolean, ops: HeatOp[]): void {
  if (node.type === 'pane') return;
  const wFirst = weightOf(node.first, statuses, askFlags, slim);
  const wSecond = weightOf(node.second, statuses, askFlags, slim);
  ops.push({ kind: 'ratio', path, ratio: clampRatio(wFirst / (wFirst + wSecond)) });
  weightedEqualize(node.first, [...path, false], statuses, askFlags, slim, ops);
  weightedEqualize(node.second, [...path, true], statuses, askFlags, slim, ops);
}

/**
 * In-place grid heat: the focused pane takes r = T^(1/depth) at each level along its path (ratio=r when
 * first is on the focus side, else 1-r), compounding to T total tab share; off-path subtrees divide their
 * remaining share by status weight. Every split yields exactly one ratio op and panes never move.
 */
export function planGridHeat(opts: {
  root: LayoutNode;
  focusPaneId: string;
  paneCount: number;
  zoomed?: boolean;
  enabled?: boolean;
  statuses?: AgentStatusMap;
  /** D95: ask_user_question waiting flag (human gate, distinguishing pure blocked). */
  askFlags?: AskFlagMap;
}): HeatPlan {
  if (opts.enabled === false) return { type: 'skip', reason: 'disabled' };
  if (opts.zoomed) return { type: 'skip', reason: 'zoomed' };
  if (opts.paneCount > MAX_AUTO_LAYOUT_PANES) return { type: 'skip', reason: 'too-many' };
  if (opts.root.type === 'pane' || opts.paneCount <= 1) return { type: 'skip', reason: 'single' };
  if (!containsPane(opts.root, opts.focusPaneId)) return { type: 'skip', reason: 'missing' };

  const statuses = opts.statuses ?? {};
  const askFlags = opts.askFlags ?? {};
  // D95 slim threshold: non-focused panes >= threshold -> idle/working weight * 0.6 (blocked/ask unaffected)
  const slim = opts.paneCount - 1 >= SLIM_THRESHOLD;
  const steps = findPath(opts.root, opts.focusPaneId) ?? [];

  // One walk down the focus path: on-path ratios wait for r, off-path siblings split by status weight.
  const onPathPaths: boolean[][] = [];
  const offPath: Array<{ node: LayoutNode; path: boolean[] }> = [];
  let path: boolean[] = [];
  for (const step of steps) {
    const first = step.side === 'first';
    onPathPaths.push(path);
    offPath.push({ node: first ? step.node.second : step.node.first, path: [...path, first] });
    path = [...path, !first];
  }
  const hasBlocked = offPath.some(({ node }) => flattenPanes(node).some((id) => statuses[id] === 'blocked'));
  const r = clampRatio((hasBlocked ? FOCUS_SHARE_BLOCKED : FOCUS_SHARE) ** (1 / steps.length));

  const ops: HeatOp[] = steps.map((step, i) => ({
    kind: 'ratio',
    path: onPathPaths[i],
    ratio: step.side === 'first' ? r : 1 - r,
  }));
  for (const sibling of offPath) {
    weightedEqualize(sibling.node, sibling.path, statuses, askFlags, slim, ops);
  }
  return { type: 'apply', ops };
}

/** Shared by tests/live runs: calculates area share of each pane from the exported tree (pre-order). */
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

export const HEAT_HOLD_EPSILON = 0.03;

/** Stable split identity: first-child leaf set. Boolean path re-numbers on created/closed. */
export type SplitFingerprint = {
  paneIds: string[];
  splits: Array<{ firstKey: string; ratio: number }>;
};

function firstKey(ids: string[]): string {
  return [...ids].sort().join('\0');
}

export function layoutFingerprint(root: LayoutNode): SplitFingerprint {
  const paneIds = flattenPanes(root).slice().sort();
  const splits: Array<{ firstKey: string; ratio: number }> = [];
  const walk = (node: LayoutNode): void => {
    if (node.type === 'pane') return;
    splits.push({ firstKey: firstKey(flattenPanes(node.first)), ratio: node.ratio });
    walk(node.first);
    walk(node.second);
  };
  walk(root);
  splits.sort((a, b) => (a.firstKey < b.firstKey ? -1 : a.firstKey > b.firstKey ? 1 : 0));
  return { paneIds, splits };
}

export function shouldHoldHeat(opts: {
  prior: SplitFingerprint | null | undefined;
  current: SplitFingerprint;
  acceptedFocus: boolean;
  epsilon?: number;
}): { hold: boolean; reason: 'accepted-focus' | 'no-prior' | 'pane-set-changed' | 'user-drag' | 'within-eps' } {
  if (opts.acceptedFocus) return { hold: false, reason: 'accepted-focus' };
  if (!opts.prior) return { hold: false, reason: 'no-prior' };
  if (opts.prior.paneIds.join('\0') !== opts.current.paneIds.join('\0')) {
    return { hold: false, reason: 'pane-set-changed' };
  }
  const eps = opts.epsilon ?? HEAT_HOLD_EPSILON;
  const priorMap: Record<string, number> = {};
  for (const s of opts.prior.splits) priorMap[s.firstKey] = s.ratio;
  for (const s of opts.current.splits) {
    const prev = priorMap[s.firstKey];
    if (prev === undefined) continue;
    if (Math.abs(prev - s.ratio) > eps) return { hold: true, reason: 'user-drag' };
  }
  return { hold: false, reason: 'within-eps' };
}

export function applyHeatOps(root: LayoutNode, ops: HeatOp[]): LayoutNode {
  const clone = (n: LayoutNode): LayoutNode =>
    n.type === 'pane' ? { ...n } : { type: 'split', direction: n.direction, ratio: n.ratio, first: clone(n.first), second: clone(n.second) };
  const tree = clone(root);
  const setAt = (node: LayoutNode, path: boolean[], ratio: number): void => {
    if (node.type !== 'split') return;
    if (path.length === 0) {
      node.ratio = ratio;
      return;
    }
    setAt(path[0] ? node.second : node.first, path.slice(1), ratio);
  };
  for (const op of ops) setAt(tree, op.path, op.ratio);
  return tree;
}
