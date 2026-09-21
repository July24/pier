/** pane-title pure functions (M22: the title is the kanban, D68 formula). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BLOCKED_LABEL_KEY, formatBlockedLabel, formatPaneTitle, sidebarTodoTokens, staleTokenClearance } from '../src/pane-title.ts';

test('formatPaneTitle: 计数 + 标题选取（D91 四件套 ▶○■✓）；空列表 → null（clear_title）', () => {
  assert.equal(formatPaneTitle([]), null);
  assert.equal(formatPaneTitle([], '调研 kimi'), null);
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
    formatPaneTitle([{ content: '卡住', status: 'blocked', blocker: '等确认' }, { content: '写测试', status: 'pending' }], '调研'),
    '▶0 ○1 ■1 ✓0 · 调研',
  );
  // no in_progress → the fallback label; without one, counts only
  const pendingOnly = [{ content: '写测试', status: 'pending' as const }];
  assert.equal(formatPaneTitle(pendingOnly, '调研'), '▶0 ○1 ■0 ✓0 · 调研');
  assert.equal(formatPaneTitle(pendingOnly), '▶0 ○1 ■0 ✓0');
});

test('formatPaneTitle: M16 progressSuffix 拼进计数后（保守/ETA/空）；超 TITLE_MAX 本地先裁', () => {
  const items = [
    { content: 'a', status: 'in_progress' as const },
    { content: 'b', status: 'pending' as const },
    { content: 'c', status: 'completed' as const },
  ];
  assert.equal(formatPaneTitle(items, null, { progressSuffix: '1/3' }), '▶1 ○1 ■0 ✓1 (1/3) · a');
  assert.equal(formatPaneTitle(items, null, { progressSuffix: '1/3 ~4m' }), '▶1 ○1 ■0 ✓1 (1/3 ~4m) · a');
  assert.equal(formatPaneTitle(items, null, {}), '▶1 ○1 ■0 ✓1 · a');
  assert.equal(formatPaneTitle(items, null, { progressSuffix: '' }), '▶1 ○1 ■0 ✓1 · a');

  // herdr truncates title/state_label at 80 characters, so the clip has to happen locally first
  const title = formatPaneTitle([{ content: 'x'.repeat(200), status: 'in_progress' }]);
  assert.ok(title);
  assert.equal(title.length, 80);
  assert.equal(title.slice(0, 8), '▶1 ○0 ■0');
});

test('formatPaneTitle: 反冻结（stale-core D）——归档列表降权为 ✓N done <age>', () => {
  const done3 = [
    { content: 'Verify gateway', status: 'completed' as const },
    { content: 'Verify ids', status: 'completed' as const },
    { content: 'Update doc', status: 'completed' as const },
  ];
  const t0 = 100 * 3_600_000;
  // no lastWriteAt (older callers) → unchanged behaviour (the full four-glyph summary)
  assert.equal(formatPaneTitle(done3, null, {}), '▶0 ○0 ■0 ✓3');
  // fresh (<1h) → full weight
  assert.equal(formatPaneTitle(done3, null, { lastWriteAt: t0, now: t0 + 30 * 60_000 }), '▶0 ○0 ■0 ✓3');
  // archived (≥1h) → `✓3 done <age>`; a dead list no longer poses as the current state
  assert.equal(formatPaneTitle(done3, null, { lastWriteAt: t0, now: t0 + 16 * 3_600_000 }), '✓3 done 16h');
  // any open item → never archived, however old the list is
  const withOpen = [...done3, { content: 'next', status: 'in_progress' as const }];
  assert.equal(formatPaneTitle(withOpen, null, { lastWriteAt: t0, now: t0 + 48 * 3_600_000 }), '▶1 ○0 ■0 ✓3 · next');
});

test('formatBlockedLabel: 取第一条 blocked 的 blocker；无 blocked → null', () => {
  assert.equal(formatBlockedLabel([{ content: 'a', status: 'pending' }]), null);
  assert.equal(formatBlockedLabel([{ content: '等文档', status: 'blocked', blocker: '人类确认范围' }]), '人类确认范围');
  assert.equal(formatBlockedLabel([{ content: '卡住了', status: 'blocked' }]), '卡住了');
});

test('herdr token maps: stale 清理为 16 个 null 键；侧栏日报只带 pi-todo', () => {
  const tokens = staleTokenClearance();
  assert.equal(Object.keys(tokens).length, 16);
  assert.equal(tokens['pi-herdr'], null);
  for (let i = 0; i < 15; i += 1) assert.equal(tokens[`pi-herdr-${i}`], null);
  // the blocked state_label key herdr accepts (anything else is rejected as invalid_state_label)
  assert.equal(BLOCKED_LABEL_KEY, 'blocked');

  const withTodo = sidebarTodoTokens('▶1 ○0 ■0 ✓0 · a');
  assert.equal(withTodo['pi-todo'], '▶1 ○0 ■0 ✓0 · a');
  assert.equal(Object.keys(withTodo).length, 1);
  // no todo: an empty string (herdr patch semantics delete the key instead of keeping a stale summary)
  assert.equal(sidebarTodoTokens(null)['pi-todo'], '');
  // D96: the stale cleanup is never merged into the daily report (stale 16 + pi-todo 1 = 17 > herdr's
  // tokens maxProperties=16, which rejects the whole request and drops title and tokens alike).
  const daily = sidebarTodoTokens('t');
  assert.ok(!('pi-herdr' in daily), 'the daily report carries pi-todo only, never the stale chunks');
  assert.deepEqual(Object.keys(daily), ['pi-todo']);
});
