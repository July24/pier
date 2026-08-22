/**
 * pane-title 纯函数单测（M22：标题即看板，D68 公式）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BLOCKED_LABEL_KEY,
  SIDEBAR_TODO_TOKEN,
  TITLE_MAX,
  formatBlockedLabel,
  formatPaneTitle,
  sidebarTodoTokens,
  staleTokenClearance,
} from '../src/pane-title.ts';

test('formatPaneTitle: 空列表 → null（clear_title）', () => {
  assert.equal(formatPaneTitle([]), null);
  assert.equal(formatPaneTitle([], '调研 kimi'), null);
});

test('formatPaneTitle: 计数 + 第一条 in_progress（D91 四件套 ▶○■✓）', () => {
  assert.equal(
    formatPaneTitle([
      { content: 'pending 的', status: 'pending' },
      { content: 'Clone kimi-code', status: 'in_progress' },
      { content: '另一条并行', status: 'in_progress' },
      { content: '已完成', status: 'completed' },
    ]),
    '▶2 ○1 ■0 ✓1 · Clone kimi-code',
  );
  assert.equal(
    formatPaneTitle([
      { content: '卡住', status: 'blocked', blocker: '等确认' },
      { content: '写测试', status: 'pending' },
    ], '调研'),
    '▶0 ○1 ■1 ✓0 · 调研',
  );
});

test('formatPaneTitle: 无 in_progress 时用 fallback；再没有就只报计数', () => {
  const pendingOnly = [{ content: '写测试', status: 'pending' as const }];
  assert.equal(formatPaneTitle(pendingOnly, '调研'), '▶0 ○1 ■0 ✓0 · 调研');
  assert.equal(formatPaneTitle(pendingOnly), '▶0 ○1 ■0 ✓0');
});

test('formatPaneTitle: M16 progressSuffix 拼进计数后（保守/ETA/空）', () => {
  const items = [
    { content: 'a', status: 'in_progress' as const },
    { content: 'b', status: 'pending' as const },
    { content: 'c', status: 'completed' as const },
  ];
  assert.equal(formatPaneTitle(items, null, { progressSuffix: '1/3' }), '▶1 ○1 ■0 ✓1 (1/3) · a');
  assert.equal(formatPaneTitle(items, null, { progressSuffix: '1/3 ~4m' }), '▶1 ○1 ■0 ✓1 (1/3 ~4m) · a');
  assert.equal(formatPaneTitle(items, null, {}), '▶1 ○1 ■0 ✓1 · a');
  assert.equal(formatPaneTitle(items, null, { progressSuffix: '' }), '▶1 ○1 ■0 ✓1 · a');
});

test('formatPaneTitle: 超 TITLE_MAX 本地先裁', () => {
  const long = 'x'.repeat(200);
  const title = formatPaneTitle([{ content: long, status: 'in_progress' }]);
  assert.ok(title);
  assert.ok(title.length <= TITLE_MAX);
  assert.equal(title.slice(0, 8), '▶1 ○0 ■0');
});

test('formatBlockedLabel: 取第一条 blocked 的 blocker；无 blocked → null', () => {
  assert.equal(formatBlockedLabel([{ content: 'a', status: 'pending' }]), null);
  assert.equal(
    formatBlockedLabel([{ content: '等文档', status: 'blocked', blocker: '人类确认范围' }]),
    '人类确认范围',
  );
  assert.equal(
    formatBlockedLabel([{ content: '卡住了', status: 'blocked' }]),
    '卡住了',
  );
});

test('staleTokenClearance: 头 + 15 分块全部 null（清 M13b 残留）', () => {
  const tokens = staleTokenClearance();
  assert.equal(tokens['pi-herdr'], null);
  assert.equal(Object.keys(tokens).length, 16);
  for (let i = 0; i < 15; i++) assert.equal(tokens[`pi-herdr-${i}`], null);
  assert.equal(BLOCKED_LABEL_KEY, 'blocked');
});

test('sidebarTodoTokens（D93）：有 title → 键=pi-todo 值=title；无 → 空串清键；stale 合并', () => {
  assert.equal(SIDEBAR_TODO_TOKEN, 'pi-todo');
  const withTodo = sidebarTodoTokens('▶1 ○0 ■0 ✓0 · a');
  assert.equal(withTodo['pi-todo'], '▶1 ○0 ■0 ✓0 · a');
  assert.equal(Object.keys(withTodo).length, 1);
  // 无 todo：空串（herdr patch 语义 = 删除键，不留旧摘要）
  assert.equal(sidebarTodoTokens(null)['pi-todo'], '');
  // stale 清理头合并进同一次上报（M13b 一次性清干净）
  const merged = sidebarTodoTokens('t', { 'pi-herdr': null });
  assert.equal(merged['pi-herdr'], null as unknown as string);
  assert.equal(merged['pi-todo'], 't');
});
