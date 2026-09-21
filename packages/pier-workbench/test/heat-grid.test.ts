/**
 * Grid planner op-stream contract: zero swaps, one ratio op per split, path geometry, area shares, plus
 * the D95 ask tier and slim decay. Mirrored constants live in pier-ext heat-plan.ts (lockstep).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ASK_WEIGHT, BLOCKED_WEIGHT, FOCUS_SHARE, FOCUS_SHARE_BLOCKED, RATIO_FLOOR, SLIM_THRESHOLD,
  applyHeatOps, countPanes, flattenPanes, paneAreaShares, planGridHeat, tierWeight, type LayoutNode,
} from '../src/heat-layout.ts';
import { planSpawnSplitRatio, simulateSplit, SPAWN_PLACEHOLDER_ID } from '../../pier-ext/src/plugins/heat-plan.ts';
import { countSplits, grid2x2, pane, ratioOps, slimTree, split, splitPathOf } from './heat-fixtures.ts';

const R2 = Math.sqrt(FOCUS_SHARE); // 0.72^(1/2)
const RB2 = Math.sqrt(FOCUS_SHARE_BLOCKED); // 0.60^(1/2)

test('零 swap 是立身之本：任意树/任意焦点，ops 全部是 ratio', () => {
  for (const id of flattenPanes(grid2x2())) {
    const p = planGridHeat({ root: grid2x2(), focusPaneId: id, paneCount: 4 });
    assert.equal(p.type, 'apply');
    if (p.type !== 'apply') continue;
    assert.ok(p.ops.every((o) => o.kind === 'ratio'), `${id} 不得产 swap`);
  }
});

test('全覆盖不变量：ratio op 数 = 树的 split 节点数，路径互不重复', () => {
  const root = grid2x2();
  assert.equal(countPanes(root), 4);
  const p = planGridHeat({ root, focusPaneId: 'p3', paneCount: 4 });
  assert.ok(p.type === 'apply');
  assert.equal(p.ops.length, countSplits(root));
  const keys = new Set(p.ops.map((o) => o.path.map(String).join(',')));
  assert.equal(keys.size, p.ops.length, '路径唯一');
});

// Per-cell focus with no statuses: √0.72 per path level (0.72 product); siblings split purely geometrically
const GRID_FOCUS_CASES = [
  { name: '焦点 p3（左下）', focus: 'p3', ops: [['', R2], ['0', 1 - R2], ['1', 0.5]], compressed: [['p1', 0.2], ['p2', 0.1], ['p4', 0.1]] },
  { name: '焦点 p1（左上）：旁支均分、无状态语义', focus: 'p1', ops: [['', R2], ['0', R2], ['1', 0.5]], compressed: [['p3', 0.2], ['p2', 0.1], ['p4', 0.1]] },
] as const;

test('2×2 网格逐格聚焦：op 路径/比例 + 焦点占比 0.72', async (t) => {
  for (const c of GRID_FOCUS_CASES) {
    await t.test(c.name, () => {
      const p = planGridHeat({ root: grid2x2(), focusPaneId: c.focus, paneCount: 4 });
      assert.ok(p.type === 'apply');
      assert.deepEqual(ratioOps(p.ops), c.ops);
      const shares = paneAreaShares(applyHeatOps(grid2x2(), p.ops));
      assert.ok(Math.abs(shares[c.focus] - FOCUS_SHARE) < 1e-9, `${c.focus}=${shares[c.focus]}`);
      for (const [id, bound] of c.compressed) assert.ok(shares[id] < bound, `${id}=${shares[id]}`);
    });
  }
});

test('blocked 在旁支：聚焦让位 0.60，blocked 在其子树内拿 3/4', () => {
  const p = planGridHeat({ root: grid2x2(), focusPaneId: 'p4', paneCount: 4, statuses: { p1: 'blocked' } });
  assert.ok(p.type === 'apply');
  // Path root→second(B), B→second(p4): both levels = 1-√0.60; sibling A: p1(blocked,3) vs p3(1) → first share 0.75
  assert.deepEqual(ratioOps(p.ops), [['', 1 - RB2], ['1', 1 - RB2], ['0', 0.75]]);
  const shares = paneAreaShares(applyHeatOps(grid2x2(), p.ops));
  assert.ok(Math.abs(shares.p4 - FOCUS_SHARE_BLOCKED) < 1e-9, `p4=${shares.p4}`);
  assert.ok(shares.p1 > shares.p3 * 2, `blocked p1=${shares.p1} 应显著大于 p3=${shares.p3}`);
});

test('深层链（5 pane 焦点在末叶）：每层钳 0.9，焦点仍占 0.9^4=0.656 全场最大', () => {
  const root = split('right', pane('a'), split('right', pane('b'), split('right', pane('c'), split('right', pane('d'), pane('e')))));
  const p = planGridHeat({ root, focusPaneId: 'e', paneCount: 5 });
  assert.ok(p.type === 'apply');
  const shares = paneAreaShares(applyHeatOps(root, p.ops));
  assert.ok(Math.abs(shares.e - 0.9 ** 4) < 1e-9, `e=${shares.e}`);
  for (const id of ['a', 'b', 'c', 'd']) assert.ok(shares.e > shares[id] * 2, `e=${shares.e} 必须碾压 ${id}=${shares[id]}`);
});

test('地板/天棚：任何 ratio 都在 [0.10, 0.90]（引擎钳制区间）', () => {
  const root = split('right', pane('a'), split('down', pane('b'), split('down', pane('c'), split('down', pane('d'), pane('e')))));
  for (const id of ['a', 'c', 'e']) {
    const p = planGridHeat({ root, focusPaneId: id, paneCount: 5, statuses: { b: 'blocked' } });
    if (p.type !== 'apply') continue;
    for (const op of p.ops) assert.ok(op.ratio >= RATIO_FLOOR - 1e-9 && op.ratio <= 1 - RATIO_FLOOR + 1e-9, `${id} ratio=${op.ratio}`);
  }
});

/* ════════ D95: ask tier + slim decay ════════ */

test('D95 权重表：blocked 3 > ask 2.5 > working 1.4 > idle 1', () => {
  assert.equal(tierWeight('blocked'), BLOCKED_WEIGHT);
  assert.equal(tierWeight('blocked', true), ASK_WEIGHT);
  assert.equal(tierWeight('working'), 1.4);
  assert.equal(tierWeight('idle'), 1);
  assert.equal(tierWeight('done'), 1);
  assert.equal(tierWeight(undefined), 1);
});

test('D95 ask 分级：ask(blocked+pi-ask) 比纯 blocked 小，但仍大于 working（同层对比）', () => {
  // Sibling subtree A = down(p1, down(p3, p2)): p1=blocked(3), p3=ask(2.5), p2=working(1.4)
  const root = split('right',
    split('down', pane('p1'), split('down', pane('p3'), pane('p2'))),
    split('down', pane('p4'), pane('p5')));
  const p = planGridHeat({ root, focusPaneId: 'p5', paneCount: 5,
    statuses: { p1: 'blocked', p3: 'blocked', p2: 'working' }, askFlags: { p3: true } });
  assert.ok(p.type === 'apply');
  const shares = paneAreaShares(applyHeatOps(root, p.ops));
  assert.ok(shares.p1 > shares.p3, `blocked p1=${shares.p1} > ask p3=${shares.p3}`);
  assert.ok(shares.p3 > shares.p2, `ask p3=${shares.p3} > working p2=${shares.p2}`);
});

test('D95 窄条衰减：非焦点 pane ≥ SLIM_THRESHOLD 时 idle/working 权重 ×0.6', () => {
  assert.equal(SLIM_THRESHOLD, 4);
  // 7 panes (focus + 6 siblings: 3 working + 3 idle) → over the threshold → slimming active
  const statuses = { a: 'working', b: 'working', c: 'working', d: 'idle', e: 'idle', f: 'idle' };
  const slimmed = planGridHeat({ root: slimTree(), focusPaneId: 'focus', paneCount: 7, statuses });
  const unslimmed = planGridHeat({ root: slimTree(), focusPaneId: 'focus', paneCount: 3, statuses: { a: 'working', b: 'working' } });
  assert.equal(slimmed.type, 'apply');
  assert.equal(unslimmed.type, 'apply');
  if (slimmed.type !== 'apply' || unslimmed.type !== 'apply') return;
  const s1 = paneAreaShares(applyHeatOps(slimTree(), slimmed.ops));
  const s2 = paneAreaShares(applyHeatOps(slimTree(), unslimmed.ops));
  assert.ok(s1.a < s2.a, `slim working a=${s1.a} 应小于未衰减 a=${s2.a}`);
});

test('planSpawnSplitRatio 与 planGridHeat 新节点 op 锁步', () => {
  const cases: Array<{ name: string; root: LayoutNode; target: string; focus: string; statuses: Record<string, string> }> = [
    { name: '拆焦点格', root: pane('a'), target: 'a', focus: 'a', statuses: {} },
    { name: 'off-path idle', root: split('right', pane('f'), pane('s')), target: 's', focus: 'f', statuses: {} },
    { name: 'off-path blocked', root: split('right', pane('f'), pane('s')), target: 's', focus: 'f', statuses: { s: 'blocked' } },
  ];
  for (const c of cases) {
    const ratio = planSpawnSplitRatio({ root: c.root, targetPaneId: c.target, focusPaneId: c.focus, direction: 'down', statuses: c.statuses });
    const simulated = simulateSplit(c.root, c.target, SPAWN_PLACEHOLDER_ID, 'down');
    assert.ok(simulated, c.name);
    const plan = planGridHeat({ root: simulated, focusPaneId: c.focus, paneCount: countPanes(simulated), statuses: c.statuses });
    assert.equal(plan.type, 'apply', c.name);
    if (plan.type !== 'apply') continue;
    const newPath = splitPathOf(simulated, SPAWN_PLACEHOLDER_ID);
    assert.ok(newPath, c.name);
    const op = plan.ops.find((o) => o.path.length === newPath.length && o.path.every((b, i) => b === newPath[i]));
    assert.ok(op, c.name);
    assert.equal(op.ratio, ratio, c.name);
  }
});
