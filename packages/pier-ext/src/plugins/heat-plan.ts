/**
 * Controlled mirror of workbench heat-layout for spawn-time pane.split ratio — do NOT merge with
 * pier-workbench/src/heat-layout.ts (npm pi-pier has no workbench, and the workbench checkout has no
 * pi-pier). Only planSpawnSplitRatio / simulateSplit / SPAWN_PLACEHOLDER_ID / fromShapeTree / LayoutNode
 * are the interface; the weights stay in lockstep with packages/pier-workbench/test/heat-grid.test.ts.
 *
 * herdr src/layout.rs split_at: first = original, second = new, ratio = first share.
 */
import { type ShapeNode } from './grid-shape.ts';

export const SPAWN_PLACEHOLDER_ID = '__pier_new__';
const RATIO_FLOOR = 0.10;
const FOCUS_SHARE = 0.72;
const FOCUS_SHARE_BLOCKED = 0.60;
const MAX_AUTO_LAYOUT_PANES = 10;
const BLOCKED_WEIGHT = 3;
const ASK_WEIGHT = 2.5;
const WORKING_WEIGHT = 1.4;
const IDLE_WEIGHT = 1;
const SLIM_THRESHOLD = 4;
const SLIM_FACTOR = 0.6;

/** Same shape as pier-workbench heat-layout LayoutNode. */
export type LayoutNode =
  | { type: 'pane'; pane_id: string }
  | { type: 'split'; direction: 'right' | 'down'; ratio: number; first: LayoutNode; second: LayoutNode };

type AgentStatusMap = Record<string, string>;
type AskFlagMap = Record<string, boolean>;

export function fromShapeTree(node: ShapeNode): LayoutNode {
  if (node.type === 'pane') return { type: 'pane', pane_id: node.paneId };
  const direction = node.direction === 'down' || node.direction === 'vertical' ? 'down' : 'right';
  return {
    type: 'split',
    direction,
    ratio: node.ratio,
    first: fromShapeTree(node.first),
    second: fromShapeTree(node.second),
  };
}

function countPanes(node: LayoutNode): number {
  return node.type === 'pane' ? 1 : countPanes(node.first) + countPanes(node.second);
}

function flattenPanes(node: LayoutNode): string[] {
  return node.type === 'pane' ? [node.pane_id] : [...flattenPanes(node.first), ...flattenPanes(node.second)];
}

function containsPane(node: LayoutNode, paneId: string): boolean {
  if (node.type === 'pane') return node.pane_id === paneId;
  return containsPane(node.first, paneId) || containsPane(node.second, paneId);
}

function clampRatio(r: number): number {
  return Math.min(1 - RATIO_FLOOR, Math.max(RATIO_FLOOR, r));
}

function tierWeight(status: string | undefined, isAsk = false, slim = false): number {
  if (status === 'blocked') return isAsk ? ASK_WEIGHT : BLOCKED_WEIGHT;
  if (status === 'working') return slim ? WORKING_WEIGHT * SLIM_FACTOR : WORKING_WEIGHT;
  return slim ? IDLE_WEIGHT * SLIM_FACTOR : IDLE_WEIGHT;
}

type SplitNode = Extract<LayoutNode, { type: 'split' }>;
interface PathStep { node: SplitNode; side: 'first' | 'second' }

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

function weightOf(node: LayoutNode, statuses: AgentStatusMap, askFlags: AskFlagMap, slim: boolean): number {
  return flattenPanes(node).reduce((sum, id) => sum + tierWeight(statuses[id], askFlags[id] === true, slim), 0);
}

/** Replace target leaf with split(first=old, second=new). Matches herdr split_at. */
export function simulateSplit(
  root: LayoutNode,
  targetPaneId: string,
  newPaneId: string,
  direction: 'right' | 'down',
): LayoutNode | null {
  const rec = (n: LayoutNode): LayoutNode | null => {
    if (n.type === 'pane') {
      if (n.pane_id !== targetPaneId) return null;
      return {
        type: 'split',
        direction,
        ratio: 0.5,
        first: n,
        second: { type: 'pane', pane_id: newPaneId },
      };
    }
    const first = rec(n.first);
    if (first) return { ...n, first };
    const second = rec(n.second);
    if (second) return { ...n, second };
    return null;
  };
  return rec(root);
}

/**
 * First-child ratio for pane.split so the new layer matches post-spawn heat.
 * On-path: T^(1/depth) if focus is first, else 1-T. Off-path: weighted first share.
 * Null → omit ratio (herdr 0.5). Caller must skip when the tab is zoomed.
 */
export function planSpawnSplitRatio(opts: {
  root: LayoutNode;
  targetPaneId: string;
  focusPaneId: string;
  direction: 'right' | 'down';
  statuses?: AgentStatusMap;
  askFlags?: AskFlagMap;
  newPaneId?: string;
}): number | null {
  const newId = opts.newPaneId ?? SPAWN_PLACEHOLDER_ID;
  const simulated = simulateSplit(opts.root, opts.targetPaneId, newId, opts.direction);
  if (!simulated) return null;
  const paneCount = countPanes(simulated);
  if (paneCount <= 1 || paneCount > MAX_AUTO_LAYOUT_PANES) return null;
  if (!containsPane(simulated, opts.focusPaneId) || !containsPane(simulated, newId)) return null;

  const statuses = opts.statuses ?? {};
  const askFlags = opts.askFlags ?? {};
  const slim = paneCount - 1 >= SLIM_THRESHOLD;
  const focusSteps = findPath(simulated, opts.focusPaneId);
  const newSteps = findPath(simulated, newId);
  if (!focusSteps || !newSteps || newSteps.length === 0) return null;

  const newSplit = newSteps[newSteps.length - 1]!.node;
  const onFocusPath = focusSteps.some((s) => s.node === newSplit);

  if (onFocusPath) {
    const hasBlocked = focusSteps.some((step) => {
      const sibling = step.side === 'first' ? step.node.second : step.node.first;
      return flattenPanes(sibling).some((id) => statuses[id] === 'blocked');
    });
    const target = hasBlocked ? FOCUS_SHARE_BLOCKED : FOCUS_SHARE;
    const r = clampRatio(target ** (1 / focusSteps.length));
    const at = focusSteps.find((s) => s.node === newSplit);
    if (!at) return null;
    return at.side === 'first' ? r : 1 - r;
  }

  const wFirst = weightOf(newSplit.first, statuses, askFlags, slim);
  const wSecond = weightOf(newSplit.second, statuses, askFlags, slim);
  if (wFirst + wSecond <= 0) return null;
  return clampRatio(wFirst / (wFirst + wSecond));
}
