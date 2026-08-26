/**
 * D97 网格形态单测：parseShapeTree / paneCells / pickGridSplit（一律 down = 全宽横条）。
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

test('pickGridSplit 序列：6 个 pane 依次长成全宽横条（一律 down）', () => {
  // 模拟增量分裂：每次 pick 后把目标格拆成 first=原 pane / second=新 pane
  let tree: ShapeNode = P('p1');
  const expected: Array<[string, 'right' | 'down']> = [
    ['p1', 'down'], // 200×50 → 上下分
    ['p1', 'down'], // p1/p2 各 200×25 并列取先序 p1 → 下
    ['p2', 'down'], // p2=200×25 最大 → 下
    ['p1', 'down'], // p1/p3/p2=200×12.5 并列取先序 p1 → 下
    ['p3', 'down'], // p3/p2/p4=200×12.5 并列取先序 p3 → 下
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
  // 终态：6 条全宽横条（w=200），条高最低 6 行 —— 静帧语义（<12 行即 title 帧）
  const cells = paneCells(tree);
  assert.equal(cells.length, 6);
  for (const c of cells) assert.ok(c.w === 200 && c.h >= 6, `${c.id} ${c.w}x${c.h} 非全宽横条`);
});

test('pickGridSplit：exclude 把 board（无 agent 常驻 shell）摘出候选', () => {
  const tree = S('right', S('down', P('work'), P('work2')), P('board')); // board 独占右半
  const pick = pickGridSplit(tree, { exclude: new Set(['board']) });
  assert.ok(pick);
  assert.equal(pick.targetPaneId, 'work'); // work/work2 各 100×25 并列 → 先序第一
  assert.equal(pick.direction, 'down'); // D97：一律上下拆（横条）
});

test('pickGridSplit：全被 exclude / 单 pane', () => {
  const tree = S('right', P('a'), P('b'));
  assert.equal(pickGridSplit(tree, { exclude: new Set(['a', 'b']) }), null);
  const single = pickGridSplit(P('solo'));
  assert.deepEqual(single, { targetPaneId: 'solo', direction: 'down' });
});

function splitAt(node: ShapeNode, target: string, newId: string, direction: 'right' | 'down'): ShapeNode {
  if (node.type === 'pane') {
    return node.paneId === target ? S(direction, node, P(newId)) : node;
  }
  return { ...node, first: splitAt(node.first, target, newId, direction), second: splitAt(node.second, target, newId, direction) };
}
