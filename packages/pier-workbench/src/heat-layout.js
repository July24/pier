/**
 * M23 heat layout planner (D91 Tier 3: in-place grid heat).
 *
 * Panes NEVER move position (zero swaps) — only split ratios change. Geometry: herdr's ratio is the split
 * node's first child share (0.8.2 split_rect: first_w = width * ratio), engine-clamped to [0.10, 0.90].
 */
export const MAX_AUTO_LAYOUT_PANES = 10;
export const PANE_MIN_AGE_MS = 3000;
export const REFLOW_DEBOUNCE_MS = 150;
/** Herdr engine silent ratio clamp lower bound (0.8.2 set_ratio_at clamps to [0.1, 0.9]). */
export const RATIO_FLOOR = 0.10;
/** A split that mixes agent panes with agent-less panes (plain shells, no reported agent status)
 *  keeps the shell side at least this wide/down share: a 0.10 shell column cannot show command
 *  output, and the heat planner only exists to rank agent attention. */
export const NON_AGENT_RATIO_FLOOR = 0.25;
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
export function countPanes(node) {
    return node.type === 'pane' ? 1 : countPanes(node.first) + countPanes(node.second);
}
function normalizeNode(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const o = raw;
    if (o.type === 'pane') {
        const nested = o.pane;
        const id = typeof o.pane_id === 'string' ? o.pane_id
            : typeof nested?.pane_id === 'string' ? nested.pane_id : null;
        return id ? { type: 'pane', pane_id: id } : null;
    }
    if (o.type === 'split') {
        const first = normalizeNode(o.first);
        const second = normalizeNode(o.second);
        if (!first || !second)
            return null;
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
export function unwrapLayout(exported) {
    const obj = (exported ?? {});
    const layout = (obj.layout ?? obj);
    const root = normalizeNode(layout.root ?? obj.root ?? null);
    const tabId = (typeof layout.tab_id === 'string' ? layout.tab_id : null)
        ?? (typeof obj.tab_id === 'string' ? obj.tab_id : null);
    return { root, tabId, zoomed: Boolean(layout.zoomed ?? obj.zoomed) };
}
export function firstPaneId(node) {
    return node.type === 'pane' ? node.pane_id : firstPaneId(node.first);
}
export function containsPane(node, paneId) {
    if (node.type === 'pane')
        return node.pane_id === paneId;
    return containsPane(node.first, paneId) || containsPane(node.second, paneId);
}
export function shouldAcceptFocus(opts) {
    if (opts.cause === 'user')
        return true;
    if (opts.cause === 'plugin')
        return false;
    return opts.paneAgeMs >= PANE_MIN_AGE_MS;
}
export function shouldFireDebounced(opts) {
    return opts.stored === opts.incoming;
}
export function flattenPanes(node) {
    return node.type === 'pane' ? [node.pane_id] : [...flattenPanes(node.first), ...flattenPanes(node.second)];
}
/** Tier weight: blocked receives highest attention, ask (human gate) second, working third, idle least. */
export function tierWeight(status, isAsk = false, slim = false) {
    if (status === 'blocked')
        return isAsk ? ASK_WEIGHT : BLOCKED_WEIGHT;
    if (status === 'working')
        return slim ? WORKING_WEIGHT * SLIM_FACTOR : WORKING_WEIGHT;
    return slim ? IDLE_WEIGHT * SLIM_FACTOR : IDLE_WEIGHT;
}
/** Path from root to focused leaf (each step records the split node and which side the focus is on). */
function findPath(node, targetId) {
    if (node.type === 'pane')
        return node.pane_id === targetId ? [] : null;
    if (containsPane(node.first, targetId)) {
        return [{ node, side: 'first' }, ...(findPath(node.first, targetId) ?? [])];
    }
    if (containsPane(node.second, targetId)) {
        return [{ node, side: 'second' }, ...(findPath(node.second, targetId) ?? [])];
    }
    return null;
}
function clampRatio(r) {
    return Math.min(1 - RATIO_FLOOR, Math.max(RATIO_FLOOR, r));
}
function weightOf(node, statuses, askFlags, slim) {
    return flattenPanes(node).reduce((sum, id) => sum + tierWeight(statuses[id], askFlags[id] === true, slim), 0);
}
/** A pane is an agent pane only when the snapshot reports a real status; missing or `unknown`
 *  marks a plain shell (terminal panes), which must stay usable in mixed splits. */
function hasAgentPanes(node, statuses) {
    return flattenPanes(node).some((id) => statuses[id] !== undefined && statuses[id] !== 'unknown');
}
/** Clamp a first-share ratio for `node`, keeping a shell-only side at NON_AGENT_RATIO_FLOOR. */
function splitRatio(node, ratio, statuses) {
    const firstAgent = hasAgentPanes(node.first, statuses);
    const secondAgent = hasAgentPanes(node.second, statuses);
    if (firstAgent && !secondAgent)
        ratio = Math.min(ratio, 1 - NON_AGENT_RATIO_FLOOR);
    else if (!firstAgent && secondAgent)
        ratio = Math.max(ratio, NON_AGENT_RATIO_FLOOR);
    return clampRatio(ratio);
}
/** Inside sibling subtrees: each split divides share by first/second weight ratio (ratio = first share). */
function weightedEqualize(node, path, statuses, askFlags, slim, ops) {
    if (node.type === 'pane')
        return;
    const wFirst = weightOf(node.first, statuses, askFlags, slim);
    const wSecond = weightOf(node.second, statuses, askFlags, slim);
    ops.push({ kind: 'ratio', path, ratio: splitRatio(node, wFirst / (wFirst + wSecond), statuses) });
    weightedEqualize(node.first, [...path, false], statuses, askFlags, slim, ops);
    weightedEqualize(node.second, [...path, true], statuses, askFlags, slim, ops);
}
/**
 * In-place grid heat: the focused pane takes r = T^(1/depth) at each level along its path (ratio = r when
 * first is on the focus side, else 1 - r), compounding to T total tab share; off-path subtrees divide their
 * remaining share by status weight.
 */
export function planGridHeat(opts) {
    if (opts.enabled === false)
        return { type: 'skip', reason: 'disabled' };
    if (opts.zoomed)
        return { type: 'skip', reason: 'zoomed' };
    if (opts.paneCount > MAX_AUTO_LAYOUT_PANES)
        return { type: 'skip', reason: 'too-many' };
    if (opts.root.type === 'pane' || opts.paneCount <= 1)
        return { type: 'skip', reason: 'single' };
    if (!containsPane(opts.root, opts.focusPaneId))
        return { type: 'skip', reason: 'missing' };
    const statuses = opts.statuses ?? {};
    const askFlags = opts.askFlags ?? {};
    const slim = opts.paneCount - 1 >= SLIM_THRESHOLD;
    const steps = findPath(opts.root, opts.focusPaneId) ?? [];
    const onPathPaths = [];
    const offPath = [];
    let path = [];
    for (const step of steps) {
        const first = step.side === 'first';
        onPathPaths.push(path);
        offPath.push({ node: first ? step.node.second : step.node.first, path: [...path, first] });
        path = [...path, !first];
    }
    const hasBlocked = offPath.some(({ node }) => flattenPanes(node).some((id) => statuses[id] === 'blocked'));
    const r = clampRatio((hasBlocked ? FOCUS_SHARE_BLOCKED : FOCUS_SHARE) ** (1 / steps.length));
    const ops = steps.map((step, i) => ({
        kind: 'ratio',
        path: onPathPaths[i],
        ratio: splitRatio(step.node, step.side === 'first' ? r : 1 - r, statuses),
    }));
    for (const sibling of offPath) {
        weightedEqualize(sibling.node, sibling.path, statuses, askFlags, slim, ops);
    }
    return { type: 'apply', ops };
}
export function paneAreaShares(root) {
    const shares = {};
    const walk = (node, share) => {
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
function firstKey(ids) {
    return [...ids].sort().join('\0');
}
export function layoutFingerprint(root) {
    const paneIds = flattenPanes(root).slice().sort();
    const splits = [];
    const walk = (node) => {
        if (node.type === 'pane')
            return;
        splits.push({ firstKey: firstKey(flattenPanes(node.first)), ratio: node.ratio });
        walk(node.first);
        walk(node.second);
    };
    walk(root);
    splits.sort((a, b) => (a.firstKey < b.firstKey ? -1 : a.firstKey > b.firstKey ? 1 : 0));
    return { paneIds, splits };
}
export function shouldHoldHeat(opts) {
    if (opts.acceptedFocus)
        return { hold: false, reason: 'accepted-focus' };
    if (!opts.prior)
        return { hold: false, reason: 'no-prior' };
    if (opts.prior.paneIds.join('\0') !== opts.current.paneIds.join('\0')) {
        return { hold: false, reason: 'pane-set-changed' };
    }
    const eps = opts.epsilon ?? HEAT_HOLD_EPSILON;
    const priorMap = {};
    for (const s of opts.prior.splits)
        priorMap[s.firstKey] = s.ratio;
    for (const s of opts.current.splits) {
        const prev = priorMap[s.firstKey];
        if (prev === undefined)
            continue;
        if (Math.abs(prev - s.ratio) > eps)
            return { hold: true, reason: 'user-drag' };
    }
    return { hold: false, reason: 'within-eps' };
}
export function applyHeatOps(root, ops) {
    const clone = (n) => n.type === 'pane' ? { ...n } : { type: 'split', direction: n.direction, ratio: n.ratio, first: clone(n.first), second: clone(n.second) };
    const tree = clone(root);
    const setAt = (node, path, ratio) => {
        if (node.type !== 'split')
            return;
        if (path.length === 0) {
            node.ratio = ratio;
            return;
        }
        setAt(path[0] ? node.second : node.first, path.slice(1), ratio);
    };
    for (const op of ops)
        setAt(tree, op.path, op.ratio);
    return tree;
}
