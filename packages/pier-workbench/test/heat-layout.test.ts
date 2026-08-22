/**
 * M23 热力规划器基础缝（D91 档 3 后的守卫与工具）。
 * 缝：planGridHeat 守卫 / shouldAcceptFocus / shouldFireDebounced / unwrapLayout。
 * 不测 RPC、不测钩子进程。几何与面积断言见 heat-grid.test.ts。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_AUTO_LAYOUT_PANES,
  PANE_MIN_AGE_MS,
  REFLOW_DEBOUNCE_MS,
  FOCUS_SHARE,
  planGridHeat,
  shouldAcceptFocus,
  shouldFireDebounced,
  unwrapLayout,
  type LayoutNode,
} from '../src/heat-layout.ts';

function pane(id: string): LayoutNode {
  return { type: 'pane', pane_id: id };
}

function split(direction: 'right' | 'down', first: LayoutNode, second: LayoutNode, ratio = 0.5): LayoutNode {
  return { type: 'split', direction, ratio, first, second };
}

/** 右链：a | (b | (c | d)) */
function rightSpine(ids: string[]): LayoutNode {
  if (ids.length === 0) throw new Error('empty');
  if (ids.length === 1) return pane(ids[0]);
  return split('right', pane(ids[0]), rightSpine(ids.slice(1)), 0.5);
}

test('单 pane：无分裂，跳过', () => {
  const plan = planGridHeat({ root: pane('p1'), focusPaneId: 'p1', paneCount: 1 });
  assert.equal(plan.type, 'skip');
});

test('两 pane、焦点在 first：根比例直接拉到 0.72（零 swap）', () => {
  const plan = planGridHeat({ root: split('right', pane('a'), pane('b')), focusPaneId: 'a', paneCount: 2 });
  assert.equal(plan.type, 'apply');
  if (plan.type !== 'apply') return;
  assert.deepEqual(plan.ops, [{ kind: 'ratio', path: [], ratio: FOCUS_SHARE }]);
});

test('两 pane、焦点在 second：根比例 = 1-0.72（原地放大，不换位）', () => {
  const plan = planGridHeat({ root: split('right', pane('a'), pane('b')), focusPaneId: 'b', paneCount: 2 });
  assert.equal(plan.type, 'apply');
  if (plan.type !== 'apply') return;
  assert.deepEqual(plan.ops, [{ kind: 'ratio', path: [], ratio: 1 - FOCUS_SHARE }]);
});

test('zoomed / 超员 / 停用 / 焦点不在树：跳过', () => {
  const root = rightSpine(['a', 'b', 'c']);
  assert.equal(planGridHeat({ root, focusPaneId: 'a', paneCount: 3, zoomed: true }).type, 'skip');
  assert.equal(planGridHeat({ root, focusPaneId: 'a', paneCount: MAX_AUTO_LAYOUT_PANES + 1 }).type, 'skip');
  assert.equal(planGridHeat({ root, focusPaneId: 'a', paneCount: 3, enabled: false }).type, 'skip');
  assert.equal(planGridHeat({ root, focusPaneId: 'zz', paneCount: 3 }).type, 'skip');
});

test('F1：无 cause 时只接受存活满 3s 的 pane', () => {
  assert.equal(shouldAcceptFocus({ paneAgeMs: 500 }), false);
  assert.equal(shouldAcceptFocus({ paneAgeMs: PANE_MIN_AGE_MS }), true);
  assert.equal(shouldAcceptFocus({ paneAgeMs: 0, cause: 'user' }), true);
  assert.equal(shouldAcceptFocus({ paneAgeMs: 10_000, cause: 'plugin' }), false);
});

test('unwrapLayout: 兼容 result 直接树 与 {type,layout} 信封', () => {
  const root = split('right', pane('a'), pane('b'));
  assert.deepEqual(unwrapLayout({ root, tab_id: 't1', zoomed: false }).tabId, 't1');
  assert.equal(unwrapLayout({ type: 'layout_export', layout: { root, tab_id: 't2', zoomed: true } }).tabId, 't2');
  assert.equal(unwrapLayout({ type: 'layout_export', layout: { root, tab_id: 't2', zoomed: true } }).zoomed, true);
});

test('S3：150ms 防抖，后来的 token 取消先到的', () => {
  assert.equal(REFLOW_DEBOUNCE_MS, 150);
  assert.equal(shouldFireDebounced({ stored: 't1', incoming: 't1' }), true);
  assert.equal(shouldFireDebounced({ stored: 't2', incoming: 't1' }), false);
});
