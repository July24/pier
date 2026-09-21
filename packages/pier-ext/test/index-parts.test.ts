/**
 * index.ts satellite parts: pipe-protocol dispatch, the D92 settlement-notice buffer, the
 * process-mode planner, and cross-pane write locks. All four are pure/plugin-level modules.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handlePipeRequest, type MachineRequest, type PipeHandlerSession } from '../src/index-pipe.ts';
import { emptySubagentPortBox } from '../src/subagent-core.ts';
import { collapseNotices, createNoticeBuffer } from '../src/index-notices.ts';
import { planIndexMode, type IndexMode } from '../src/index-runtime.ts';
import { installWriteLocks } from '../src/index-locks.ts';
import { lockTokenKey, lockTokenValue } from '../src/lock-core.ts';
import type { AgentInfo, HerdrEnv } from '../src/herdr-client.ts';
import { fakeHerdr, fakePi, type FakePi } from './test-utils.ts';

/* ── index-pipe: common-segment pipe dispatch ───────────────────── */

/** PipeHandlerSession with inert hooks; each test overrides only what it observes. */
function pipeSession(over: Partial<PipeHandlerSession> = {}): PipeHandlerSession {
  return {
    paneId: 'p0',
    port: emptySubagentPortBox(),
    claimSettleNotice: () => true,
    deliverNotice: async () => {},
    sendUserMessageIn: async () => {},
    sendUserMessageAs: async () => {},
    abort: () => {},
    setPendingMachineRequest: () => {},
    applyRoleSwitch: async () => ({ ok: true, message: 'stub' }),
    ...over,
  };
}

test('handlePipeRequest: ping / prompt / steer follow_up / interrupt', async () => {
  const inMsgs: string[] = [];
  const asMsgs: Array<{ text: string; mode: string }> = [];
  let aborted = 0;
  const state: { pending: MachineRequest | null } = { pending: null };
  const session = pipeSession({
    sendUserMessageIn: async (content) => { inMsgs.push(content); },
    sendUserMessageAs: async (content, mode) => { asMsgs.push({ text: content, mode }); },
    abort: () => { aborted += 1; },
    setPendingMachineRequest: (req) => { state.pending = req; },
  });

  assert.deepEqual(await handlePipeRequest({ type: 'ping', id: '1' }, session), { type: 'ok', id: '1', detail: 'p0' });

  await handlePipeRequest({ type: 'prompt', id: '2', text: 'go', from: 'src', push: true }, session);
  assert.ok(state.pending !== null && state.pending.id === '2');
  assert.deepEqual(inMsgs, ['go']);

  await handlePipeRequest({ type: 'follow_up', id: '3', text: 'more', steer: true }, session);
  assert.deepEqual(asMsgs, [{ text: 'more', mode: 'steer' }]);

  await handlePipeRequest({ type: 'interrupt', id: '4' }, session);
  assert.equal(aborted, 1);
  assert.equal(state.pending, null);
});

test('handlePipeRequest: reply binds port, claims once, delivers notice', async () => {
  const applied: Array<[string, string | null]> = [];
  const notices: string[] = [];
  const claimed: string[] = [];
  const port = emptySubagentPortBox();
  port.current = {
    applyReplySession(paneId, sessionFile) { applied.push([paneId, sessionFile]); },
    reconcileOnReply() { return ['Reconciled: x']; },
    async settleStatLine() { return 'stat: clean'; },
    listRunningSubs() { return []; },
  };
  const latch = new Set<string>();
  const session = pipeSession({
    port,
    claimSettleNotice: (key) => {
      claimed.push(key);
      if (latch.has(key)) return false;
      latch.add(key);
      return true;
    },
    deliverNotice: async (content) => { notices.push(content); },
  });

  const req = { type: 'reply' as const, id: 'r1', paneId: 'p2', text: 'done', sessionFile: '/tmp/s.jsonl' };
  assert.equal((await handlePipeRequest(req, session)).type, 'ok');
  assert.deepEqual(applied, [['p2', '/tmp/s.jsonl']]);
  assert.match(notices[0], /p2/);
  assert.match(notices[0], /done/);
  assert.match(notices[0], /Session: \/tmp\/s.jsonl/);
  assert.match(notices[0], /stat: clean/);
  assert.match(notices[0], /Reconciled: x/);

  await handlePipeRequest(req, session);
  assert.equal(notices.length, 1, 'a duplicate claim must not re-deliver');
  assert.deepEqual(claimed, ['p2:r1', 'p2:r1']);
});

test('handlePipeRequest: the reply claim key is the id the parent pushed (B8)', async () => {
  // The parent pushes `prompt-<taskId>`, the child echoes that id on settle, and the poll loop
  // claims `${paneId}:${id}` (subagent-poller.ts). A mismatch shows as two settlement notices.
  const claims: string[] = [];
  const state: { pending: MachineRequest | null } = { pending: null };
  const session = pipeSession({
    claimSettleNotice: (key) => { claims.push(key); return true; },
    setPendingMachineRequest: (req) => { state.pending = req; },
  });

  const sentId = 'prompt-3f1a-任务';
  await handlePipeRequest({ type: 'prompt', id: sentId, text: 'go', from: 'src', push: true }, session);
  assert.equal(state.pending?.id, sentId, 'the pushed id is the pending machine request id');

  await handlePipeRequest(
    { type: 'reply', id: state.pending!.id, paneId: 'p2', text: 'done', sessionFile: null },
    session,
  );
  assert.deepEqual(claims, [`p2:${sentId}`]);
});

test('handlePipeRequest: role switch ok/error is relayed verbatim', async () => {
  // P0 (RFC §4.4): the master switches a worker's role over the pipe; a mixed-version peer
  // answering `unknown type role` must reach the model as that same error.
  const calls: Array<{ role: string; by: string }> = [];
  const okSession = pipeSession({
    paneId: 'w1',
    applyRoleSwitch: async (role, by) => {
      calls.push({ role, by });
      return { ok: true, message: 'role worker-default → reviewer (+bash)' };
    },
  });
  const ok = await handlePipeRequest({ type: 'role', id: 'r1', role: 'reviewer' }, okSession);
  assert.deepEqual(ok, { type: 'ok', id: 'r1', detail: 'role worker-default → reviewer (+bash)' });
  assert.deepEqual(calls, [{ role: 'reviewer', by: 'w1' }], 'switchedBy = the pane that asked');

  const errSession = pipeSession({
    applyRoleSwitch: async () => ({ ok: false, message: 'Error: role "nope" unavailable: ROLE_NOT_FOUND' }),
  });
  const err = await handlePipeRequest({ type: 'role', id: 'r2', role: 'nope' }, errSession);
  assert.deepEqual(err, { type: 'error', id: 'r2', message: 'Error: role "nope" unavailable: ROLE_NOT_FOUND' });
});

/* ── index-notices: D92 settlement-notice buffer ────────────────── */

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

test('collapseNotices: empty → null; ≤3 verbatim; >3 → first three + count/pointer tail', () => {
  assert.equal(collapseNotices([]), null, 'an empty batch is not injected');
  const three = [
    'Background subagent w8:p5 (task) finished.',
    'Background subagent w8:p6 (task) finished.',
    'Background subagent w8:p7 (task) finished.',
  ];
  // At or below the cap the panes' own wording survives byte-identical: no wrapper, no tail line.
  for (const batch of [[three[0]!], three]) assert.equal(collapseNotices(batch), batch.join('\n\n'));

  const over = collapseNotices([...three, 'n4', 'n5'])!;
  assert.ok(over.startsWith(`${three.join('\n\n')}\n\n`));
  const tail = over.split('\n\n').pop()!;
  assert.match(tail, /另有 2 条结算未逐条展示/);
  assert.match(tail, /history 台账/);
  assert.match(tail, /subagent list 查看/);
  assert.ok(!over.includes('\n\nn4') && !over.includes('\n\nn5'));
});

/* ── index-runtime: process-mode planner ────────────────────────── */

test('planIndexMode: worker flag wins inside herdr; herdr pane → master; no herdr → neither', () => {
  const herdrEnv = { HERDR_ENV: '1', HERDR_SOCKET_PATH: '/tmp/s', HERDR_PANE_ID: 'p1' };
  const CASES: Array<[string, NodeJS.ProcessEnv, IndexMode]> = [
    ['worker flag inside herdr', { ...herdrEnv, PI_HERDR_SUBAGENT: '1' }, { isSubagent: true, hasHerdr: true, composeMaster: false }],
    ['herdr pane without the worker flag', herdrEnv, { isSubagent: false, hasHerdr: true, composeMaster: true }],
    ['herdr unavailable', {}, { isSubagent: false, hasHerdr: false, composeMaster: false }],
  ];
  for (const [name, env, expect] of CASES) assert.deepEqual(planIndexMode(env), expect, name);
});

/* ── index-locks: write-lock installer wiring ───────────────────── */

/** pi's tool_call dispatch: the first handler that returns a verdict wins. */
async function toolCallVerdict(pi: FakePi, event: unknown, ctx: unknown) {
  for (const handler of pi.listeners.get('tool_call') ?? []) {
    const verdict = await handler(event, ctx) as { block?: boolean; reason?: string } | undefined;
    if (verdict) return verdict;
  }
  return undefined;
}

test('installWriteLocks: a peer lock blocks a relative write at the pane-resolved cwd', async (t) => {
  const win = process.platform === 'win32';
  const ctxCwd = win ? 'C:\\repo' : '/repo';
  const CASES: Array<{ name: string; own: Partial<AgentInfo>; lockedPath: string }> = [
    // Herdr ≥ 0.9.1 reports the pane's own foregroundCwd, which outranks the event ctx.cwd:
    // 'file.ts' then resolves into /repo/sub and collides with p2's lock on /repo/sub/file.ts.
    {
      name: 'foregroundCwd from the live agent list outranks ctx.cwd',
      own: { foregroundCwd: win ? 'C:\\repo\\sub' : '/repo/sub' },
      lockedPath: win ? 'c:/repo/sub/file.ts' : '/repo/sub/file.ts',
    },
    // Herdr < 0.9.1 reports no foregroundCwd: ctx.cwd is the resolution root.
    { name: 'falls back to ctx.cwd when the pane reports none', own: {}, lockedPath: win ? 'c:/repo/file.ts' : '/repo/file.ts' },
  ];

  for (const c of CASES) {
    await t.test(c.name, async () => {
      const reported: Array<Record<string, string | null>> = [];
      const client = fakeHerdr({
        listAgents: async (): Promise<AgentInfo[]> => [
          // p1 is our own pane; p2 holds a lock on the resolved target path.
          { paneId: 'p1', agent: 'pi', status: 'working', session: null, stateLabels: {}, tokens: {}, ...c.own },
          { paneId: 'p2', agent: 'pi', status: 'working', session: null, stateLabels: {}, tokens: { [lockTokenKey(c.lockedPath)]: lockTokenValue(c.lockedPath, 'p2') } },
        ],
        reportLockTokens: async (tokens) => { reported.push(tokens); },
      });
      const env: HerdrEnv = { socketPath: '/tmp/herdr.sock', paneId: 'p1', workspaceId: 'w1', tabId: 't1' };
      const pi = fakePi();
      const handle = installWriteLocks(pi as never, { client, env, hard: true });

      const verdict = await toolCallVerdict(pi, { toolName: 'write', toolCallId: 'call-1', input: { path: 'file.ts' } }, { cwd: ctxCwd });

      assert.ok(verdict?.block, 'a relative write colliding with a peer lock must be blocked');
      assert.match(verdict.reason ?? '', /locked by pane p2/);
      assert.deepEqual(handle.getHeldLocks(), [], 'a blocked call must not acquire the lock');
      assert.deepEqual(reported, [], 'a blocked call must not claim the lock in the pane registry');
    });
  }
});
