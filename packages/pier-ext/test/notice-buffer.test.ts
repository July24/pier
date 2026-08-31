/**
 * D92 结算通知折叠器单测。
 * 缝：collapseNotices 纯函数——空/单条/满额/超额折叠。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOTICE_MAX_SHOWN, collapseNotices } from '../src/notice-buffer.ts';

test('空 → null（不注入）', () => {
  assert.equal(collapseNotices([]), null);
});

test('单条 → 原文（与旧格式逐字节一致，无包装）', () => {
  const one = 'Background subagent w8:p5 (task) finished.';
  assert.equal(collapseNotices([one]), one);
});

test('恰满 3 条 → 逐条原文，无折叠尾行', () => {
  const items = ['a-finished', 'b-finished', 'c-finished'];
  assert.equal(collapseNotices(items), items.join('\n\n'));
  assert.equal(NOTICE_MAX_SHOWN, 3);
});

test('超 3 条 → 前 3 条原文 + 尾行计数 + 全量指引', () => {
  const items = ['n1', 'n2', 'n3', 'n4', 'n5'];
  const out = collapseNotices(items)!;
  assert.ok(out.startsWith('n1\n\nn2\n\nn3\n\n'));
  const tail = out.split('\n\n').pop()!;
  assert.match(tail, /另有 2 条结算未逐条展示/);
  assert.match(tail, /history 台账/);
  assert.match(tail, /subagent list/);
  // 原文第 4/5 条不出现
  assert.ok(!out.includes('\n\nn4') && !out.includes('\n\nn5'));
});

test('自定义 max', () => {
  const out = collapseNotices(['x', 'y'], 1)!;
  assert.equal(out, 'x\n\n…另有 1 条结算未逐条展示。全量结果看 history 台账（路径公式见 subagent resume 工具描述）；在跑代理用 subagent list 查看。');
});
