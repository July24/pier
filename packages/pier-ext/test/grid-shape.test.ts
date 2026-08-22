/**
 * D91 网格形态单测：parseShapeTree / paneCells / pickGridSplit。
 * 缝：纯函数——spawn 增量分裂的选格与方向。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paneCells, parseShapeTree, pickGridSplit, type ShapeNode } from '../src/core/grid-shape.ts';

const P = (id: string): ShapeNode => ({ type: 'pane', paneId: id });
const S = (direction: string, first: ShapeNode, second: ShapeNode, ratio = 0.5): ShapeNode =>
  ({ type: 'split', direction, ratio, first, second });

test('parseShapeTree：嵌套 pane 叶（layout.export 真实形状）+ 容错', () => {
  const raw = {
    type: 'split', direction: 'right', ratio: 0.5,
    first: { type: 'pane', pane: { pane_id: 'a' } },
    second: { type: 'split', direction: 'down', ratio: 0.5, first: { type: 'pane', pane: { pane_id: 'b' } }, second: { type: 'pane', pane: { pane_id: 'c' } } },
  };
  const t = parseShapeTree(raw)!;
  assert.equal(t.type, 'split');
  assert.deepEqual(paneCells(t).map((c) => c.id), ['a', 'b', 'c']);
  assert.equal(parseShapeTree({ type: 'pane' }), null, '无 pane_id → null');
  assert.equal(parseShapeTree('garbage'), null);
});

test('pickGridSplit 序列：6 个 pane 依次长成方格（右→右→右→下→下）', () => {
  // 模拟增量分裂：每次 pick 后把目标格拆成 first=原 pane / second=新 pane
  let tree: ShapeNode = P('p1');
  const expected: Array<[string, 'right' | 'down']> = [
    ['p1', 'right'], // 200×50 → 左右分
    ['p1', 'right'], // p1/p2 各 100×50，并列取先序 p1，仍宽 → 右
    ['p2', 'right'], // p1,p3=50×50；p2=100×50 最大 → 右
    ['p1', 'down'],  // 四格 50×50，并列取先序 p1，方 → 下
    ['p3', 'down'],  // p3/p2/p4=50×50 最大并列取先序 p3 → 下
  ];
  const seen: Array<[string, 'right' | 'down']> = [];
  for (let i = 0; i < expected.length; i++) {
    const pick = pickGridSplit(tree);
    assert.ok(pick, `第 ${i + 1} 次分裂`);
    seen.push([pick.targetPaneId, pick.direction]);
    // 应用分裂（重嵌树）
    tree = splitAt(tree, pick.targetPaneId, `p${i + 2}`, pick.direction);
  }
  assert.deepEqual(seen, expected);
  // 终态：6 格，最窄不小于 25 列（200/4/2），全部横向或方形
  const cells = paneCells(tree);
  assert.equal(cells.length, 6);
  for (const c of cells) assert.ok(c.w >= 25 && c.h >= 12, `${c.id} ${c.w}x${c.h} 过碎`);
});

test('pickGridSplit：exclude 把 board（无 agent 常驻 shell）摘出候选', () => {
  const tree = S('right', S('down', P('work'), P('work2')), P('board')); // board 独占右半
  const pick = pickGridSplit(tree, { exclude: new Set(['board']) });
  assert.ok(pick);
  assert.equal(pick.targetPaneId, 'work'); // work/work2 各 100×25 并列 → 先序第一
  assert.equal(pick.direction, 'right'); // 100 > 25*1.3 → 沿长轴左右分
});

test('pickGridSplit：全被 exclude / 单 pane', () => {
  const tree = S('right', P('a'), P('b'));
  assert.equal(pickGridSplit(tree, { exclude: new Set(['a', 'b']) }), null);
  const single = pickGridSplit(P('solo'));
  assert.deepEqual(single, { targetPaneId: 'solo', direction: 'right' });
});

function splitAt(node: ShapeNode, target: string, newId: string, direction: 'right' | 'down'): ShapeNode {
  if (node.type === 'pane') {
    return node.paneId === target ? S(direction, node, P(newId)) : node;
  }
  return { ...node, first: splitAt(node.first, target, newId, direction), second: splitAt(node.second, target, newId, direction) };
}
