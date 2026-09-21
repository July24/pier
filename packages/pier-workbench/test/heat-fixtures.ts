/**
 * Shared fixtures for the workbench heat-planner tests: layout tree builders, the boolean-path key of a
 * ratio op stream, and the two trees pinned by the grid contract.
 */
import type { HeatOp, LayoutNode } from '../src/heat-layout.ts';
import type { ReflowDeps, ReflowEvent } from '../src/reflow.ts';

export function pane(id: string): LayoutNode {
  return { type: 'pane', pane_id: id };
}

export function split(
  direction: 'right' | 'down',
  first: LayoutNode,
  second: LayoutNode,
  ratio = 0.5,
): LayoutNode {
  return { type: 'split', direction, ratio, first, second };
}

export function countSplits(node: LayoutNode): number {
  return node.type === 'pane' ? 0 : 1 + countSplits(node.first) + countSplits(node.second);
}

/** Boolean path key: '0' = first step, '1' = second, '' = the root split. */
export function pathKey(path: boolean[]): string {
  return path.map((b) => (b ? '1' : '0')).join('');
}

/** Ratio ops of a plan as [path key, ratio] pairs. */
export function ratioOps(ops: HeatOp[]): Array<[string, number]> {
  return ops.map((o) => [pathKey(o.path), o.ratio]);
}

/** `[method, params]` rows recorded by a deps harness. */
export type Calls = Array<[string, Record<string, unknown>]>;

/** The `layout.set_split_ratio` rows of a harness run, in the same shape as ratioOps. */
export function callRatioOps(calls: Calls): Array<[string, number]> {
  return calls
    .filter(([method]) => method === 'layout.set_split_ratio')
    .map(([, params]) => [pathKey(params.path as boolean[]), params.ratio as number]);
}

/** Boolean path of the split node that directly holds `paneId` (null when the pane is absent). */
export function splitPathOf(node: LayoutNode, paneId: string, path: boolean[] = []): boolean[] | null {
  if (node.type === 'pane') return null;
  const holds = (child: LayoutNode): boolean => child.type === 'pane' && child.pane_id === paneId;
  if (holds(node.first) || holds(node.second)) return path;
  return splitPathOf(node.first, paneId, [...path, false]) ?? splitPathOf(node.second, paneId, [...path, true]);
}

/** 2×2 grid: root=right(A, B); A=down(p1,p3); B=down(p2,p4). */
export function grid2x2(): LayoutNode {
  return split('right', split('down', pane('p1'), pane('p3')), split('down', pane('p2'), pane('p4')));
}

/** 7 panes: root=right(focus, rest); rest=down(A,B); A=down(a,b); B=down(c, down(d,e)). */
export function slimTree(): LayoutNode {
  return split('right', pane('focus'), split('down',
    split('down', pane('a'), pane('b')),
    split('down', pane('c'), split('down', pane('d'), pane('e'))),
  ));
}

/* ════════ reflow deps fake: records RPC, keeps state in a closure, no socket, no debounce wait ════════ */

/** layout.export payload of the standard tab: root=right(pane-a, down(pane-b, pane-c)). */
export const REFLOW_LAYOUT = {
  layout: { tab_id: 'tab-1', zoomed: false, root: split('right', pane('pane-a'), split('down', pane('pane-b'), pane('pane-c'))) },
};
export const OLD_PANE = { createdAt: Date.now() - 60_000 };
export const OLD_TAB = { enabled: true, lastFocusPaneId: 'pane-a', lastApplyAt: 1 };

export const calledRpc = (calls: Calls, method: string): boolean => calls.some(([m]) => m === method);
export const piTabIds = (...ids: string[]) => ({ piTabIds: async () => new Set(ids) });

export type ReflowDepsOpts = Omit<Partial<ReflowDeps>, 'ev'> & {
  ev?: Partial<ReflowEvent>;
  exported?: unknown;
  state?: Record<string, any>;
};

export function makeReflowDeps(opts: ReflowDepsOpts = {}) {
  const { exported = REFLOW_LAYOUT, ev: evOver, state: initialState, ...depsOver } = opts;
  const calls: Calls = [];
  let state: Record<string, any> = initialState ?? { tabs: {}, panes: {}, debounce: null };
  const event = { hook: 'pane.focused', paneId: 'pane-b', workspaceId: 'ws', tabId: 'tab-1', cause: 'user', ...evOver };
  const deps: ReflowDeps = {
    ev: { ...event, type: event.type ?? event.hook },
    request: async (method, params = {}) => { calls.push([method, params]); return method === 'layout.export' ? exported : {}; },
    loadState: () => state,
    saveState: (s) => { state = s; },
    sleep: async () => { /* no debounce wait in tests */ },
    ...depsOver,
  };
  return { deps, calls, get state() { return state; }, set state(next: Record<string, any>) { state = next; } };
}

