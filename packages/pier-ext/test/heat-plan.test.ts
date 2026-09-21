/** Spawn-time pane split ratio (heat model mirror, keep in lockstep with pier-workbench's heat-layout.ts)
 *  and the grid shape it is derived from. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planSpawnSplitRatio, simulateSplit, type LayoutNode } from '../src/plugins/heat-plan.ts';
import { paneCells, parseShapeTree, pickGridSplit, type ShapeNode } from '../src/plugins/grid-shape.ts';

/** Mirror of heat-layout's FOCUS_SHARE (0.72) and split ratio floor (0.10). */
const FOCUS_SHARE = 0.72;
const RATIO_FLOOR = 0.1;

const pane = (id: string): LayoutNode => ({ type: 'pane', pane_id: id });
const split = (direction: 'right' | 'down', first: LayoutNode, second: LayoutNode, ratio = 0.5): LayoutNode =>
  ({ type: 'split', direction, ratio, first, second });
const P = (id: string): ShapeNode => ({ type: 'pane', paneId: id });
const S = (direction: string, first: ShapeNode, second: ShapeNode, ratio = 0.5): ShapeNode =>
  ({ type: 'split', direction, ratio, first, second });

test('simulateSplit: first keeps the original pane, second is the new one', () => {
  assert.deepEqual(simulateSplit(pane('a'), 'a', 'new', 'down'), split('down', pane('a'), pane('new')));
});

test('planSpawnSplitRatio: 焦点留在原格 = T^(1/depth)，移到新格 = 1-T^(1/depth)，焦点外按热力份额', () => {
  assert.equal(planSpawnSplitRatio({ root: pane('a'), targetPaneId: 'a', focusPaneId: 'a', direction: 'down' }), FOCUS_SHARE);
  assert.equal(planSpawnSplitRatio({ root: pane('a'), targetPaneId: 'a', focusPaneId: '__pier_new__', direction: 'down' }), 1 - FOCUS_SHARE);

  const root = split('right', pane('focus'), pane('side'));
  assert.equal(planSpawnSplitRatio({ root, targetPaneId: 'side', focusPaneId: 'focus', direction: 'down' }), 0.5, 'idle vs idle');
  assert.equal(
    planSpawnSplitRatio({ root, targetPaneId: 'side', focusPaneId: 'focus', direction: 'down', statuses: { side: 'blocked' } }),
    3 / 4,
    'a blocked cell outweighs a new idle one',
  );

  // every plan stays inside the engine floor, whatever the inputs
  for (const opts of [
    { root: pane('a'), targetPaneId: 'a', focusPaneId: 'a', direction: 'down' as const },
    { root: pane('a'), targetPaneId: 'a', focusPaneId: '__pier_new__', direction: 'down' as const },
    { root, targetPaneId: 'side', focusPaneId: 'focus', direction: 'down' as const, statuses: { side: 'blocked' as const } },
  ]) {
    const r = planSpawnSplitRatio(opts);
    assert.ok(r != null && r >= RATIO_FLOOR && r <= 1 - RATIO_FLOOR, `ratio ${r} escapes the engine floor`);
  }
});

/* ── grid shape ─────────────────────────────────────────────────── */

test('parseShapeTree: nested pane leaves from layout.export, null for junk', () => {
  const raw = {
    type: 'split', direction: 'right', ratio: 0.5,
    first: { type: 'pane', pane: { pane_id: 'a' } },
    second: { type: 'split', direction: 'down', ratio: 0.5, first: { type: 'pane', pane: { pane_id: 'b' } }, second: { type: 'pane', pane: { pane_id: 'c' } } },
  };
  const tree = parseShapeTree(raw)!;
  assert.equal(tree.type, 'split');
  assert.deepEqual(paneCells(tree).map((c) => c.id), ['a', 'b', 'c']);
  assert.equal(parseShapeTree({ type: 'pane' }), null, 'no pane id → null');
  assert.equal(parseShapeTree('garbage'), null);
});

const splitAt = (node: ShapeNode, target: string, newId: string, direction: 'right' | 'down'): ShapeNode =>
  node.type === 'pane'
    ? (node.paneId === target ? S(direction, node, P(newId)) : node)
    : { ...node, first: splitAt(node.first, target, newId, direction), second: splitAt(node.second, target, newId, direction) };

test('pickGridSplit: successive spawns grow full-width strips (always downward)', () => {
  let tree: ShapeNode = P('p1');
  const seen: Array<[string, 'right' | 'down']> = [];
  const expected: Array<[string, 'right' | 'down']> = [
    ['p1', 'down'], // 200×50 → split top/bottom
    ['p1', 'down'], // p1/p2 are both 200×25 → preorder picks p1
    ['p2', 'down'], // p2 is the largest
    ['p1', 'down'],
    ['p3', 'down'],
  ];
  for (let i = 0; i < expected.length; i++) {
    const pick = pickGridSplit(tree);
    assert.ok(pick, `split #${i + 1}`);
    seen.push([pick.targetPaneId, pick.direction]);
    tree = splitAt(tree, pick.targetPaneId, `p${i + 2}`, pick.direction);
  }
  assert.deepEqual(seen, expected);
  const cells = paneCells(tree);
  assert.equal(cells.length, 6);
  for (const c of cells) assert.ok(c.w === 200 && c.h >= 6, `${c.id} ${c.w}x${c.h} is not a full-width strip`);
});

test('pickGridSplit: 排除的面板永不作目标；真实 cell 几何覆盖 200×50 模型；无格可分 → null', () => {
  const withBoard = S('right', S('down', P('work'), P('work2')), P('board'));
  assert.deepEqual(pickGridSplit(withBoard, { exclude: new Set(['board']) }), { targetPaneId: 'work', direction: 'down' });

  // real cell geometry (a narrow column) overrides the 200×50 model
  const geometry = S('right', P('narrow'), P('wide'));
  const cells = [{ id: 'narrow', x: 0, y: 0, w: 10, h: 50 }, { id: 'wide', x: 10, y: 0, w: 190, h: 50 }];
  assert.deepEqual(pickGridSplit(geometry, { cells }), { targetPaneId: 'wide', direction: 'down' });

  assert.equal(pickGridSplit(S('right', P('a'), P('b')), { exclude: new Set(['a', 'b']) }), null);
  assert.deepEqual(pickGridSplit(P('solo')), { targetPaneId: 'solo', direction: 'down' });
});
