/**
 * D92 结算通知折叠器单测。
 * 缝：collapseNotices 纯函数——空/单条/满额/超额折叠。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOTICE_MAX_SHOWN, collapseNotices, createNoticeBuffer } from '../src/index-notices.ts';

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

// ---------------------------------------------------------------------------
// P0-2 rank 钩子（index-notices）：>3 才触发；null → 到达序；结果重排后折叠
// ---------------------------------------------------------------------------

test('rank 钩子：≤3 条不触发 rank', async () => {
  const sent: string[] = [];
  let rankCalls = 0;
  const buffer = createNoticeBuffer({
    isBusy: () => true,
    send: async (content) => {
      sent.push(content);
    },
    rank: async (contents) => {
      rankCalls++;
      return [...contents].reverse();
    },
  });
  for (const n of ['a', 'b', 'c']) await buffer.deliverNotice(n);
  await buffer.flush('steer');
  assert.equal(rankCalls, 0);
  assert.equal(sent[0], 'a\n\nb\n\nc');
});

test('rank 钩子：>3 条按重排结果折叠展示前 3', async () => {
  const sent: string[] = [];
  const buffer = createNoticeBuffer({
    isBusy: () => true,
    send: async (content) => {
      sent.push(content);
    },
    rank: async (contents) => [...contents].reverse(),
  });
  for (const n of ['a', 'b', 'c', 'd']) await buffer.deliverNotice(n);
  await buffer.flush('steer');
  const out = sent[0]!;
  assert.ok(out.startsWith('d\n\nc\n\nb\n\n'));
  assert.match(out, /另有 1 条结算未逐条展示/);
});

test('rank 钩子：返回 null → 保持到达序（fail-open）', async () => {
  const sent: string[] = [];
  const buffer = createNoticeBuffer({
    isBusy: () => true,
    send: async (content) => {
      sent.push(content);
    },
    rank: async () => null,
  });
  for (const n of ['a', 'b', 'c', 'd']) await buffer.deliverNotice(n);
  await buffer.flush('steer');
  assert.ok(sent[0]!.startsWith('a\n\nb\n\nc\n\n'));
});
