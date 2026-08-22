/**
 * M23 档 3（D91）：网格原地热力规划器单测。
 * D95：ask 分级 + 窄条衰减 + 权重表扩展。
 * 缝：planGridHeat 纯函数——零 swap / 路径几何均摊 / 旁支权重分饼 / 全覆盖不变量。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ASK_WEIGHT,
  BLOCKED_WEIGHT,
  FOCUS_SHARE,
  FOCUS_SHARE_BLOCKED,
  RATIO_FLOOR,
  SLIM_THRESHOLD,
  countPanes,
  flattenPanes,
  paneAreaShares,
  planGridHeat,
  tierWeight,
  type HeatOp,
  type LayoutNode,
} from '../src/heat-layout.ts';

const R2 = Math.sqrt(FOCUS_SHARE); // 0.72^(1/2)
const RB2 = Math.sqrt(FOCUS_SHARE_BLOCKED); // 0.60^(1/2)

function pane(id: string): LayoutNode {
  return { type: 'pane', pane_id: id };
}
function split(direction: 'right' | 'down', first: LayoutNode, second: LayoutNode, ratio = 0.5): LayoutNode {
  return { type: 'split', direction, ratio, first, second };
}
/** 2×2 网格：root=right(A, B)；A=down(p1,p3)；B=down(p2,p4)。 */
function grid2x2(): LayoutNode {
  return split('right', split('down', pane('p1'), pane('p3')), split('down', pane('p2'), pane('p4')));
}
function countSplits(node: LayoutNode): number {
  return node.type === 'pane' ? 0 : 1 + countSplits(node.first) + countSplits(node.second);
}
/** 把 ops 应用到树副本上（只改 ratio）。 */
function applied(root: LayoutNode, ops: HeatOp[]): LayoutNode {
  const clone: LayoutNode = structuredClone(root);
  for (const op of ops) {
    let node = clone;
    for (const go of op.path) {
      if (node.type !== 'split') throw new Error('bad path');
      node = go ? node.second : node.first;
    }
    if (node.type !== 'split') throw new Error('path 指向 pane');
    node.ratio = op.ratio;
  }
  return clone;
}
function ratioOps(ops: HeatOp[]): Array<[string, number]> {
  return ops.map((o) => [o.path.map((b) => (b ? '1' : '0')).join(''), o.ratio] as [string, number]);
}

test('零 swap 是立身之本：任意树/任意焦点，ops 全部是 ratio', () => {
  const root = grid2x2();
  for (const id of flattenPanes(root)) {
    const p = planGridHeat({ root, focusPaneId: id, paneCount: 4 });
    assert.equal(p.type, 'apply');
    if (p.type !== 'apply') continue;
    assert.ok(p.ops.every((o) => o.kind === 'ratio'), `${id} 不得产 swap`);
  }
});

test('全覆盖不变量：ratio op 数 = 树的 split 节点数，路径互不重复', () => {
  const root = grid2x2();
  const p = planGridHeat({ root, focusPaneId: 'p3', paneCount: 4 });
  if (p.type !== 'apply') throw new Error('apply');
  assert.equal(p.ops.length, countSplits(root));
  const keys = new Set(p.ops.map((o) => o.path.map(String).join(',')));
  assert.equal(keys.size, p.ops.length, '路径唯一');
});

test('2×2 网格、焦点 p3（左下）：每层 √0.72，乘积 = 0.72；其余格子被压小', () => {
  const p = planGridHeat({ root: grid2x2(), focusPaneId: 'p3', paneCount: 4 });
  if (p.type !== 'apply') throw new Error('apply');
  // 路径：root→first(A)，A→second(p3)：root ratio=r，A ratio=1-r；旁支 B 均分 0.5
  assert.deepEqual(ratioOps(p.ops), [['', R2], ['0', 1 - R2], ['1', 0.5]]);
  const shares = paneAreaShares(applied(grid2x2(), p.ops));
  assert.ok(Math.abs(shares.p3 - FOCUS_SHARE) < 1e-9, `p3=${shares.p3}`);
  assert.ok(shares.p1 < 0.2 && shares.p2 < 0.1 && shares.p4 < 0.1, JSON.stringify(shares));
});

test('blocked 在旁支：聚焦让位 0.60，blocked 在其子树内拿 3/4', () => {
  const p = planGridHeat({ root: grid2x2(), focusPaneId: 'p4', paneCount: 4, statuses: { p1: 'blocked' } });
  if (p.type !== 'apply') throw new Error('apply');
  // 路径 root→second(B)，B→second(p4)：root ratio=1-r，B ratio=1-r（r=√0.60）；
  // 旁支 A：p1(blocked,3) vs p3(1) → first 份额 0.75
  assert.deepEqual(ratioOps(p.ops), [['', 1 - RB2], ['1', 1 - RB2], ['0', 0.75]]);
  const shares = paneAreaShares(applied(grid2x2(), p.ops));
  assert.ok(Math.abs(shares.p4 - FOCUS_SHARE_BLOCKED) < 1e-9, `p4=${shares.p4}`);
  assert.ok(shares.p1 > shares.p3 * 2, `blocked p1=${shares.p1} 应显著大于 p3=${shares.p3}`);
});

test('深层链（5 pane 焦点在末叶）：每层钳 0.9，焦点仍占 0.9^4=0.656 全场最大', () => {
  const root = split('right', pane('a'), split('right', pane('b'), split('right', pane('c'), split('right', pane('d'), pane('e')))));
  const p = planGridHeat({ root, focusPaneId: 'e', paneCount: 5 });
  if (p.type !== 'apply') throw new Error('apply');
  const shares = paneAreaShares(applied(root, p.ops));
  assert.ok(Math.abs(shares.e - 0.9 ** 4) < 1e-9, `e=${shares.e}`);
  for (const id of ['a', 'b', 'c', 'd']) {
    assert.ok(shares.e > shares[id] * 2, `e=${shares.e} 必须碾压 ${id}=${shares[id]}`);
  }
});

test('地板/天棚：任何 ratio 都在 [0.10, 0.90]（引擎钳制区间）', () => {
  const root = split('right', pane('a'), split('down', pane('b'), split('down', pane('c'), split('down', pane('d'), pane('e')))));
  for (const id of ['a', 'c', 'e']) {
    const p = planGridHeat({ root, focusPaneId: id, paneCount: 5, statuses: { b: 'blocked' } });
    if (p.type !== 'apply') continue;
    for (const op of p.ops) {
      assert.ok(op.ratio >= RATIO_FLOOR - 1e-9 && op.ratio <= 1 - RATIO_FLOOR + 1e-9, `${id} ratio=${op.ratio}`);
    }
  }
});

test('statuses 空：旁支均分（退化为纯几何热力，无状态语义）', () => {
  const p = planGridHeat({ root: grid2x2(), focusPaneId: 'p1', paneCount: 4 });
  if (p.type !== 'apply') throw new Error('apply');
  // p1 路径 depth2（root→first, A→first）：两节各 √0.72，乘积 0.72；旁支 B 均分
  assert.deepEqual(ratioOps(p.ops), [['', R2], ['0', R2], ['1', 0.5]]);
  const shares = paneAreaShares(applied(grid2x2(), p.ops));
  assert.ok(Math.abs(shares.p1 - FOCUS_SHARE) < 1e-9);
  assert.equal(countPanes(grid2x2()), 4);
});

/* ════════ D95：ask 分级 + 窄条衰减 ════════ */

test('D95 权重表：blocked 3 > ask 2.5 > working 1.4 > idle 1', () => {
  assert.equal(tierWeight('blocked'), BLOCKED_WEIGHT);
  assert.equal(tierWeight('blocked', true), ASK_WEIGHT);
  assert.equal(tierWeight('working'), 1.4);
  assert.equal(tierWeight('idle'), 1);
  assert.equal(tierWeight('done'), 1);
  assert.equal(tierWeight(undefined), 1);
});

test('D95 ask 分级：ask(blocked+pi-ask) 比纯 blocked 小，但仍大于 working（同层对比）', () => {
  // 旁支子树 A = down(p1, down(p3, p2))：p1=blocked(3)，p3=ask(2.5)，p2=working(1.4)
  // A 内加权：p1 份额 = 3/(3+2.5+1.4)；p3 vs p2 = 2.5/(2.5+1.4) > 0.5（ask 压过 working）
  const root = split('right',
    split('down', pane('p1'), split('down', pane('p3'), pane('p2'))),
    split('down', pane('p4'), pane('p5')));
  const p = planGridHeat({
    root, focusPaneId: 'p5', paneCount: 5,
    statuses: { p1: 'blocked', p3: 'blocked', p2: 'working' },
    askFlags: { p3: true },
  });
  if (p.type !== 'apply') throw new Error('apply');
  const shares = paneAreaShares(applied(root, p.ops));
  assert.ok(shares.p1 > shares.p3, `blocked p1=${shares.p1} > ask p3=${shares.p3}`);
  assert.ok(shares.p3 > shares.p2, `ask p3=${shares.p3} > working p2=${shares.p2}`);
});

test('D95 窄条衰减：非焦点 pane ≥ SLIM_THRESHOLD 时 idle/working 权重 ×0.6', () => {
  assert.equal(SLIM_THRESHOLD, 4);
  // 7 pane：焦点 + 6 个旁支（3 working + 3 idle）→ 超阈值 → slimming 生效
  const statuses = { a: 'working', b: 'working', c: 'working', d: 'idle', e: 'idle', f: 'idle' };
  const slimmed = planGridHeat({ root: slimTree(), focusPaneId: 'focus', paneCount: 7, statuses });
  const unslimmed = planGridHeat({ root: slimTree(), focusPaneId: 'focus', paneCount: 3, statuses: { a: 'working', b: 'working' } });
  if (slimmed.type !== 'apply' || unslimmed.type !== 'apply') throw new Error('apply');
  const s1 = paneAreaShares(applied(slimTree(), slimmed.ops));
  const s2 = paneAreaShares(applied(slimTree(), unslimmed.ops));
  // 窄条模式下同权重的 working pane 占比更低
  assert.ok(s1.a < s2.a, `slim working a=${s1.a} 应小于未衰减 a=${s2.a}`);
});

/** 7 pane 树：root=right(focus, rest)；rest=down(A,B)；A=down(a,b)；B=down(c,d)；c=down(e,f)。 */
function slimTree(): LayoutNode {
  return split('right', pane('focus'),
    split('down',
      split('down', pane('a'), pane('b')),
      split('down', pane('c'), split('down', pane('d'), pane('e'))),
    ));
}
