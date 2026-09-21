/**
 * D92 notice buffer: busy queues, idle delivers, flush collapses.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOTICE_MAX_SHOWN, collapseNotices, createNoticeBuffer } from '../src/index-notices.ts';

test('createNoticeBuffer: idle delivers immediately and drops pane pending', async () => {
  const sent: Array<{ content: string; mode: string }> = [];
  const buf = createNoticeBuffer({
    isBusy: () => false,
    send: async (content, mode) => { sent.push({ content, mode }); },
  });
  await buf.deliverNotice('hello', 'p1');
  assert.deepEqual(sent, [{ content: 'hello', mode: 'followUp' }]);
  assert.equal(buf.noticePending().size, 0);
});

test('createNoticeBuffer: busy queues; flush steer collapses and clears GC exemption', async () => {
  const sent: Array<{ content: string; mode: string }> = [];
  const buf = createNoticeBuffer({
    isBusy: () => true,
    send: async (content, mode) => { sent.push({ content, mode }); },
  });
  await buf.deliverNotice('a', 'p1');
  await buf.deliverNotice('b', 'p2');
  assert.equal(sent.length, 0);
  assert.deepEqual([...buf.noticePending()], ['p1', 'p2']);
  await buf.flush('steer');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].mode, 'steer');
  assert.match(sent[0].content, /a/);
  assert.match(sent[0].content, /b/);
  assert.equal(buf.noticePending().size, 0);
});

/* ── collapseNotices: empty / single / full / overflow folding ── */

test('collapseNotices: 空 → null（不注入）', () => {
  assert.equal(collapseNotices([]), null);
});

test('collapseNotices: 单条 → 原文（与旧格式逐字节一致，无包装）', () => {
  const one = 'Background subagent w8:p5 (task) finished.';
  assert.equal(collapseNotices([one]), one);
});

test('collapseNotices: 恰满 3 条 → 逐条原文，无折叠尾行', () => {
  const items = ['a-finished', 'b-finished', 'c-finished'];
  assert.equal(collapseNotices(items), items.join('\n\n'));
  assert.equal(NOTICE_MAX_SHOWN, 3);
});

test('collapseNotices: 超 3 条 → 前 3 条原文 + 尾行计数 + 全量指引', () => {
  const items = ['n1', 'n2', 'n3', 'n4', 'n5'];
  const out = collapseNotices(items)!;
  assert.ok(out.startsWith('n1\n\nn2\n\nn3\n\n'));
  const tail = out.split('\n\n').pop()!;
  assert.match(tail, /另有 2 条结算未逐条展示/);
  assert.match(tail, /history 台账/);
  assert.match(tail, /subagent list 查看/);
  assert.ok(!out.includes('\n\nn4') && !out.includes('\n\nn5'));
});
