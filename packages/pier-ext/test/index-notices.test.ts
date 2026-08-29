/**
 * D92 notice buffer: busy queues, idle delivers, flush collapses.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNoticeBuffer } from '../src/index-notices.ts';

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
