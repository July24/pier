/**
 * Common-segment pipe dispatch over the subagent port.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handlePipeRequest, type MachineRequest } from '../src/index-pipe.ts';
import { emptySubagentPortBox, type SubagentPort } from '../src/subagent-port.ts';

function fakePort(over: Partial<SubagentPort> = {}): SubagentPort {
  return {
    applyReplySession() {},
    reconcileOnReply() { return []; },
    listRunningSubs() { return []; },
    async settleStatLine() { return null; },
    ...over,
  };
}

test('handlePipeRequest: ping / prompt / steer follow_up / interrupt', async () => {
  const port = emptySubagentPortBox();
  port.current = fakePort();
  let pending: MachineRequest | null = null;
  let aborted = 0;
  const inMsgs: string[] = [];
  const asMsgs: Array<{ text: string; mode: string }> = [];
  const session = {
    paneId: 'p0',
    port,
    claimSettleNotice: () => true,
    deliverNotice: async () => {},
    sendUserMessageIn: async (c: string) => { inMsgs.push(c); },
    sendUserMessageAs: async (c: string, mode: 'steer' | 'followUp') => { asMsgs.push({ text: c, mode }); },
    abort: () => { aborted += 1; },
    setPendingMachineRequest: (req: MachineRequest | null) => { pending = req; },
  };

  assert.deepEqual(await handlePipeRequest({ type: 'ping', id: '1' }, session), {
    type: 'ok', id: '1', detail: 'p0',
  });

  await handlePipeRequest({ type: 'prompt', id: '2', text: 'go', from: 'src', push: true }, session);
  assert.equal(pending?.id, '2');
  assert.deepEqual(inMsgs, ['go']);

  await handlePipeRequest({ type: 'follow_up', id: '3', text: 'more', steer: true }, session);
  assert.deepEqual(asMsgs, [{ text: 'more', mode: 'steer' }]);

  await handlePipeRequest({ type: 'interrupt', id: '4' }, session);
  assert.equal(aborted, 1);
  assert.equal(pending, null);
});

test('handlePipeRequest: reply binds port, claims once, delivers notice', async () => {
  const applied: Array<[string, string | null]> = [];
  const notices: string[] = [];
  const claimed: string[] = [];
  const port = emptySubagentPortBox();
  port.current = fakePort({
    applyReplySession(paneId, sessionFile) { applied.push([paneId, sessionFile]); },
    reconcileOnReply() { return ['Reconciled: x']; },
    async settleStatLine() { return 'stat: clean'; },
  });
  const latch = new Set<string>();
  const session = {
    paneId: 'p0',
    port,
    claimSettleNotice: (key: string) => {
      claimed.push(key);
      if (latch.has(key)) return false;
      latch.add(key);
      return true;
    },
    deliverNotice: async (content: string) => { notices.push(content); },
    sendUserMessageIn: async () => {},
    sendUserMessageAs: async () => {},
    abort: () => {},
    setPendingMachineRequest: () => {},
  };

  const req = {
    type: 'reply' as const,
    id: 'r1',
    paneId: 'p2',
    text: 'done',
    sessionFile: '/tmp/s.jsonl',
  };
  assert.equal((await handlePipeRequest(req, session)).type, 'ok');
  assert.deepEqual(applied, [['p2', '/tmp/s.jsonl']]);
  assert.match(notices[0], /p2/);
  assert.match(notices[0], /done/);
  assert.match(notices[0], /Session: \/tmp\/s.jsonl/);
  assert.match(notices[0], /stat: clean/);
  assert.match(notices[0], /Reconciled: x/);

  await handlePipeRequest(req, session);
  assert.equal(notices.length, 1, 'duplicate claim must not re-deliver');
  assert.deepEqual(claimed, ['p2:r1', 'p2:r1']);
});
