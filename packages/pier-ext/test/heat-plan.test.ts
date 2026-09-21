/**
 * Spawn-time pane.split ratio: first=old, second=new (herdr split_at).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FOCUS_SHARE,
  RATIO_FLOOR,
  planSpawnSplitRatio,
  simulateSplit,
  type LayoutNode,
} from '../src/plugins/heat-plan.ts';

function pane(id: string): LayoutNode {
  return { type: 'pane', pane_id: id };
}
function split(direction: 'right' | 'down', first: LayoutNode, second: LayoutNode, ratio = 0.5): LayoutNode {
  return { type: 'split', direction, ratio, first, second };
}

test('simulateSplit: first=原格 second=新格', () => {
  const out = simulateSplit(pane('a'), 'a', 'new', 'down');
  assert.deepEqual(out, split('down', pane('a'), pane('new')));
});

test('焦点仍在原格（默认不抢焦）：ratio = T^(1/depth) = first 份额', () => {
  const r = planSpawnSplitRatio({
    root: pane('a'),
    targetPaneId: 'a',
    focusPaneId: 'a',
    direction: 'down',
  });
  assert.equal(r, FOCUS_SHARE);
});

test('焦点落到新格（second）：ratio = 1-T^(1/depth)', () => {
  const r = planSpawnSplitRatio({
    root: pane('a'),
    targetPaneId: 'a',
    focusPaneId: '__pier_new__',
    direction: 'down',
  });
  assert.equal(r, 1 - FOCUS_SHARE);
});

test('off-path 新 split：idle vs idle → 0.5', () => {
  const root = split('right', pane('focus'), pane('side'));
  const r = planSpawnSplitRatio({
    root,
    targetPaneId: 'side',
    focusPaneId: 'focus',
    direction: 'down',
  });
  assert.equal(r, 0.5);
});

test('off-path blocked 原格 vs 新 idle：first 拿 3/4', () => {
  const root = split('right', pane('focus'), pane('side'));
  const r = planSpawnSplitRatio({
    root,
    targetPaneId: 'side',
    focusPaneId: 'focus',
    direction: 'down',
    statuses: { side: 'blocked' },
  });
  assert.equal(r, 3 / 4);
});

test('ratio 落在引擎地板内', () => {
  const r = planSpawnSplitRatio({
    root: pane('a'),
    targetPaneId: 'a',
    focusPaneId: 'a',
    direction: 'down',
  });
  assert.ok(r != null && r >= RATIO_FLOOR && r <= 1 - RATIO_FLOOR);
});
