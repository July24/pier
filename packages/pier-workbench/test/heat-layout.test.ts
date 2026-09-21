/**
 * Planner guards and helpers (planGridHeat guards / shouldAcceptFocus / shouldFireDebounced /
 * unwrapLayout / drag hold). Geometry and area assertions live in heat-grid.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  FOCUS_SHARE, MAX_AUTO_LAYOUT_PANES, PANE_MIN_AGE_MS, REFLOW_DEBOUNCE_MS,
  layoutFingerprint, planGridHeat, shouldAcceptFocus, shouldFireDebounced, shouldHoldHeat, unwrapLayout,
} from '../src/heat-layout.ts';
import { pane, split } from './heat-fixtures.ts';

// Two panes: zero swap, ratio = 0.72 on the focus side (first), else 1-0.72; right and D97 down splits share the rule
const TWO_PANE_CASES = [
  { name: '右拆、焦点在 first：根比例直接拉到 0.72', direction: 'right', focus: 'a', ratio: FOCUS_SHARE },
  { name: '右拆、焦点在 second：根比例 = 1-0.72（原地放大，不换位）', direction: 'right', focus: 'b', ratio: 1 - FOCUS_SHARE },
  { name: '上下拆（D97 down）、焦点在 first：同样原地放大到 0.72', direction: 'down', focus: 'a', ratio: FOCUS_SHARE },
  { name: '上下拆（D97 down）、焦点在 second：根比例 = 1-0.72', direction: 'down', focus: 'b', ratio: 1 - FOCUS_SHARE },
] as const;

test('单 pane：无分裂，跳过', () => {
  assert.equal(planGridHeat({ root: pane('p1'), focusPaneId: 'p1', paneCount: 1 }).type, 'skip');
});

test('两 pane：零 swap 原地放大（ratio = 焦点所在侧）', async (t) => {
  for (const c of TWO_PANE_CASES) {
    await t.test(c.name, () => {
      const plan = planGridHeat({ root: split(c.direction, pane('a'), pane('b')), focusPaneId: c.focus, paneCount: 2 });
      assert.equal(plan.type, 'apply');
      if (plan.type !== 'apply') return;
      assert.deepEqual(plan.ops, [{ kind: 'ratio', path: [], ratio: c.ratio }]);
    });
  }
});

test('zoomed / 超员 / 停用 / 焦点不在树：跳过', () => {
  const root = split('right', pane('a'), split('right', pane('b'), pane('c')));
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
  const envelope = unwrapLayout({ type: 'layout_export', layout: { root, tab_id: 't2', zoomed: true } });
  assert.equal(envelope.tabId, 't2');
  assert.equal(envelope.zoomed, true);
});

test('unwrapLayout: herdr 嵌套 pane.pane_id + direction=down', () => {
  const exported = {
    layout: {
      tab_id: 'w1:t1',
      zoomed: false,
      root: {
        type: 'split', direction: 'down', ratio: 0.5,
        first: { type: 'pane', pane: { pane_id: 'w1:p1' } },
        second: { type: 'pane', pane: { pane_id: 'w1:p2' } },
      },
    },
  };
  const { root, tabId } = unwrapLayout(exported);
  assert.equal(tabId, 'w1:t1');
  assert.ok(root && root.type === 'split' && root.direction === 'down');
  if (!root || root.type !== 'split') return;
  assert.equal(root.first.type === 'pane' ? root.first.pane_id : '', 'w1:p1');
  assert.equal(planGridHeat({ root, focusPaneId: 'w1:p1', paneCount: 2 }).type, 'apply');
});

test('S3：150ms 防抖，后来的 token 取消先到的', () => {
  assert.equal(REFLOW_DEBOUNCE_MS, 150);
  assert.equal(shouldFireDebounced({ stored: 't1', incoming: 't1' }), true);
  assert.equal(shouldFireDebounced({ stored: 't2', incoming: 't1' }), false);
});

test('heat-reflow.mjs 不依赖 cordis（user-mode GitHub checkout 无 node_modules）', () => {
  const src = readFileSync(fileURLToPath(new URL('../scripts/heat-reflow.mjs', import.meta.url)), 'utf8');
  assert.doesNotMatch(src, /from ['"]@deepseek-ai\/cordis['"]|createWorkbenchApp/);
  assert.match(src, /runReflow/);
});

test('指纹：同 pane 集合 ratio 偏差 → hold；集合增减 → 不 hold', () => {
  const a = split('right', pane('p1'), pane('p2'), 0.72);
  const dragged = split('right', pane('p1'), pane('p2'), 0.2);
  const grown = split('right', pane('p1'), split('down', pane('p2'), pane('p3')), 0.72);
  const prior = layoutFingerprint(a);
  assert.equal(shouldHoldHeat({ prior, current: layoutFingerprint(dragged), acceptedFocus: false }).hold, true);
  assert.equal(shouldHoldHeat({ prior, current: layoutFingerprint(grown), acceptedFocus: false }).reason, 'pane-set-changed');
  assert.equal(shouldHoldHeat({ prior, current: layoutFingerprint(dragged), acceptedFocus: true }).hold, false);
});
