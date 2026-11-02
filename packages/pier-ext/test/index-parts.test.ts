/**
 * index.ts satellite parts: pipe dispatch, the D92 settlement-notice buffer with its rank hook, the
 * process-mode planner, cross-pane write locks, the pi-surface proxy with its tombstone compensation,
 * and the D93 sidebar identity transport seam.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handlePipeRequest, type MachineRequest, type PipeHandlerSession } from '../src/index-pipe.ts';
import { emptySubagentPortBox } from '../src/subagent-core.ts';
import { collapseNotices, createNoticeBuffer } from '../src/index-notices.ts';
import { planIndexMode, type IndexMode } from '../src/index-runtime.ts';
import { installWriteLocks } from '../src/index-locks.ts';
import { lockTokenKey, lockTokenValue } from '../src/lock-core.ts';
import { PiSurface } from '../src/pi-surface.ts';
import { DisposeLedger } from '../src/ledger.ts';
import type { CoreEnv, TerminalInfo } from '../src/core-client.ts';
import { fakeCore, fakePi, fire, terminalInfo, type FakePi } from './test-utils.ts';

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
    applyWorkerTodos: () => {},
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
  const consumed: Array<[string, string | null]> = [];
  const notices: string[] = [];
  const claimed: string[] = [];
  const port = emptySubagentPortBox();
  port.current = {
    applyReplySession(paneId, sessionFile) { applied.push([paneId, sessionFile]); },
    consumeReply(paneId, outcome) { consumed.push([paneId, outcome]); },
    reconcileOnReply() { return ['Reconciled: x']; },
    async settleStatLine() { return 'stat: clean'; },
    listRunningSubs() { return []; },
    listRows() { return []; },
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
  assert.deepEqual(consumed, [['p2', 'done']], 'a finish notice must drop the pane from the running set first');
  // the notice names the pane, the text, the session path, the stat line and the reconciliations
  for (const frag of [/p2/, /done/, /Session: \/tmp\/s\.jsonl/, /stat: clean/, /Reconciled: x/]) assert.match(notices[0]!, frag);
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

  await handlePipeRequest({ type: 'reply', id: state.pending!.id, paneId: 'p2', text: 'done', sessionFile: null }, session);
  assert.deepEqual(claims, [`p2:${sentId}`]);
});

test('handlePipeRequest: role switch ok/error is relayed verbatim', async () => {
  // P0 (RFC §4.4): the master switches a worker's role over the pipe; a mixed-version peer
  // answering `unknown type role` must reach the model as that same error.
  const calls: Array<{ role: string; by: string }> = [];
  const ROLE_MSG = 'role worker-default → reviewer (+bash)';
  const okSession = pipeSession({
    paneId: 'w1',
    applyRoleSwitch: async (role, by) => { calls.push({ role, by }); return { ok: true, message: ROLE_MSG }; },
  });
  const ok = await handlePipeRequest({ type: 'role', id: 'r1', role: 'reviewer' }, okSession);
  assert.deepEqual(ok, { type: 'ok', id: 'r1', detail: ROLE_MSG });
  assert.deepEqual(calls, [{ role: 'reviewer', by: 'w1' }], 'switchedBy = the pane that asked');

  const errSession = pipeSession({
    applyRoleSwitch: async () => ({ ok: false, message: 'Error: role "nope" unavailable: ROLE_NOT_FOUND' }),
  });
  const err = await handlePipeRequest({ type: 'role', id: 'r2', role: 'nope' }, errSession);
  assert.deepEqual(err, { type: 'error', id: 'r2', message: 'Error: role "nope" unavailable: ROLE_NOT_FOUND' });
});

/* ── index-notices: D92 settlement-notice buffer ────────────────── */

/** A buffer whose delivery sink is observable; `busy` picks the immediate or the queueing branch. */
const noticeBuf = (busy: boolean) => {
  const sent: Array<{ content: string; mode: string }> = [];
  const buf = createNoticeBuffer({ isBusy: () => busy, send: async (content, mode) => { sent.push({ content, mode }); } });
  return { buf, sent };
};

test('createNoticeBuffer: idle delivers immediately and drops pane pending', async () => {
  const { buf, sent } = noticeBuf(false);
  await buf.deliverNotice('hello', 'p1');
  assert.deepEqual(sent, [{ content: 'hello', mode: 'followUp' }]);
  assert.equal(buf.noticePending().size, 0);
});

test('createNoticeBuffer: busy queues; flush steer collapses and clears GC exemption', async () => {
  const { buf, sent } = noticeBuf(true);
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

test('createNoticeBuffer: a settlement landing during compaction is buffered and flushed after it settles', async () => {
  // Mirrors index.ts: the agent is idle while compaction runs, so isBusy also covers compactionInFlight.
  const sent: Array<{ content: string; mode: string }> = [];
  let agentActive = false;
  let compactionInFlight = true;
  const buf = createNoticeBuffer({
    isBusy: () => agentActive || compactionInFlight,
    send: async (content, mode) => { sent.push({ content, mode }); },
  });
  await buf.deliverNotice('wA:p5F finished: report attached', 'wA:p5F');
  assert.equal(sent.length, 0, 'nothing is sent into a compacting session');
  assert.deepEqual([...buf.noticePending()], ['wA:p5F'], 'the pane stays GC-exempt while its notice is buffered');
  // The continuation run starts and ends; agent_settled flushes the buffer.
  compactionInFlight = false;
  await buf.flush('followUp');
  assert.deepEqual(sent, [{ content: 'wA:p5F finished: report attached', mode: 'followUp' }]);
  assert.equal(buf.noticePending().size, 0);
});

test('collapseNotices: empty → null; ≤3 verbatim; >3 → first three + count/pointer tail', () => {
  assert.equal(collapseNotices([]), null, 'an empty batch is not injected');
  const three = [5, 6, 7].map((n) => `Background subagent w8:p${n} (task) finished.`);
  // At or below the cap the panes' own wording survives byte-identical: no wrapper, no tail line.
  for (const batch of [[three[0]!], three]) assert.equal(collapseNotices(batch), batch.join('\n\n'));

  const over = collapseNotices([...three, 'n4', 'n5'])!;
  assert.ok(over.startsWith(`${three.join('\n\n')}\n\n`));
  const tail = over.split('\n\n').pop()!;
  assert.match(tail, /2 more settlement\(s\) not shown individually/);
  assert.match(tail, /history ledger/);
  assert.match(tail, /subagent list for running agents/);
  assert.ok(!over.includes('\n\nn4') && !over.includes('\n\nn5'));
});

/** Busy buffer with a scripted rank hook: the batch is observable only through the collapsed send. */
const rankedNotices = (rank?: (contents: readonly string[]) => Promise<readonly string[] | null>) => {
  const sent: string[] = [];
  const buf = createNoticeBuffer({ isBusy: () => true, send: async (content) => { sent.push(content); }, rank });
  return { buf, sent };
};

test('createNoticeBuffer rank hook: at or below the cap the arrival order reaches the model', async () => {
  let ranked = 0;
  const { buf, sent } = rankedNotices(async (contents) => {
    ranked += 1;
    return [...contents].reverse();
  });
  for (const n of ['a', 'b', 'c']) await buf.deliverNotice(n);
  await buf.flush('steer');
  assert.equal(sent[0], 'a\n\nb\n\nc', 'a small batch is injected verbatim in arrival order');
  assert.equal(ranked, 0, 'supporting: there is nothing to rank below the cap, so the hook is not consulted');
});

test('createNoticeBuffer rank hook: above the cap the shown three are the rank order', async () => {
  const { buf, sent } = rankedNotices(async (contents) => [...contents].reverse());
  for (const n of ['a', 'b', 'c', 'd']) await buf.deliverNotice(n);
  await buf.flush('steer');

  const out = sent[0]!;
  assert.ok(out.startsWith('d\n\nc\n\nb\n\n'), `the collapse step must be fed the rank result, got ${JSON.stringify(out)}`);
  assert.match(out, /1 more settlement\(s\) not shown individually/);
  assert.ok(!out.includes('\n\na'), 'the dropped notice is the one rank pushed past the cap, not the last arrival');
  // A second flush has nothing left: the ranked batch was drained, not re-injected.
  assert.equal(buf.noticePending().size, 0);
  await buf.flush('steer');
  assert.equal(sent.length, 1);
});

test('createNoticeBuffer rank hook: null falls back to arrival order (fail-open)', async () => {
  const { buf, sent } = rankedNotices(async () => null);
  for (const n of ['a', 'b', 'c', 'd']) await buf.deliverNotice(n);
  await buf.flush('steer');
  const out = sent[0]!;
  assert.ok(out.startsWith('a\n\nb\n\nc\n\n'), `a refusing ranker must not eat the batch, got ${JSON.stringify(out)}`);
  assert.match(out, /1 more settlement\(s\) not shown individually/, 'the tail still accounts for the batch above the cap');
});

test('createNoticeBuffer: a notice buffered while rank is pending keeps its pane exempt from GC', async () => {
  const gate = Promise.withResolvers<void>();
  const { buf, sent } = rankedNotices(async (contents) => { await gate.promise; return contents; });
  for (const [n, pane] of [['a', 'p1'], ['b', 'p2'], ['c', 'p3'], ['d', 'p4']] as const) await buf.deliverNotice(n, pane);
  const flushing = buf.flush('steer');
  await buf.deliverNotice('late', 'p7'); // settles during the rank await; the agent is still busy
  gate.resolve();
  await flushing;
  assert.equal(sent.length, 1);
  assert.deepEqual([...buf.noticePending()], ['p7'], 'only the flushed batch releases its panes');
  await buf.flush('followUp');
  assert.equal(sent[1], 'late');
  assert.equal(buf.noticePending().size, 0);
});

/* ── index-runtime: process-mode planner ────────────────────────── */

test('planIndexMode: worker flag wins inside a core terminal; core terminal → master; no core → neither', () => {
  const coreEnv = { HC_TERMINAL_SOCKET: '/tmp/s', HC_TERMINAL_ID: 't1' };
  const CASES: Array<[string, NodeJS.ProcessEnv, IndexMode]> = [
    ['worker flag inside core', { ...coreEnv, PI_HERDR_SUBAGENT: '1' }, { isSubagent: true, hasCore: true, composeMaster: false }],
    ['core terminal without the worker flag', coreEnv, { isSubagent: false, hasCore: true, composeMaster: true }],
    ['terminal id without a socket', { HC_TERMINAL_ID: 't1' }, { isSubagent: false, hasCore: false, composeMaster: false }],
    ['core unavailable', {}, { isSubagent: false, hasCore: false, composeMaster: false }],
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

/** One live terminal: the address plus whatever the case overrides. */
const terminalAt = (id: string, over: Partial<TerminalInfo> = {}): TerminalInfo => terminalInfo({ id, status: 'working', ...over });

test('installWriteLocks: a peer lock blocks a relative write at the pane-resolved cwd', async (t) => {
  const win = process.platform === 'win32';
  const ctxCwd = win ? 'C:\\repo' : '/repo';
  const CASES: Array<{ name: string; own: Partial<TerminalInfo>; lockedPath: string }> = [
    // The terminal's own foreground cwd outranks the event ctx.cwd:
    // 'file.ts' then resolves into /repo/sub and collides with t2's lock on /repo/sub/file.ts.
    { name: 'foreground cwd from the live terminal list outranks ctx.cwd', own: { foreground: { pid: 1, name: 'pi', argv: [], cwd: win ? 'C:\\repo\\sub' : '/repo/sub' } },
      lockedPath: win ? 'c:/repo/sub/file.ts' : '/repo/sub/file.ts' },
    // No foreground info: ctx.cwd is the resolution root.
    { name: 'falls back to ctx.cwd when the pane reports none', own: {}, lockedPath: win ? 'c:/repo/file.ts' : '/repo/file.ts' },
  ];

  for (const c of CASES) {
    await t.test(c.name, async () => {
      const reported: Array<Record<string, string | null>> = [];
      const client = fakeCore({
        listTerminals: async () => [
          // t1 is our own terminal; t2 holds a lock on the resolved target path.
          terminalAt('t1', c.own),
          terminalAt('t2', { labels: { [lockTokenKey(c.lockedPath)]: lockTokenValue(c.lockedPath, 't2') } }),
        ],
        setLabels: async (labels) => { reported.push(labels); },
      });
      const env: CoreEnv = { socketPath: '/tmp/core.sock', terminalId: 't1' };
      const pi = fakePi();
      const handle = installWriteLocks(pi as never, { client, env, hard: true });

      const verdict = await toolCallVerdict(pi, { toolName: 'write', toolCallId: 'call-1', input: { path: 'file.ts' } }, { cwd: ctxCwd });

      assert.ok(verdict?.block, 'a relative write colliding with a peer lock must be blocked');
      assert.match(verdict.reason ?? '', /locked by pane t2/);
      assert.deepEqual(handle.getHeldLocks(), [], 'a blocked call must not acquire the lock');
      assert.deepEqual(reported, [], 'a blocked call must not claim the lock in the pane registry');
    });
  }
});

/* ── pi-surface: the per-module registration proxy (D79) ────────── */

const callTool = (pi: FakePi, name: string, ...a: unknown[]) => pi.tools.get(name)?.execute?.(...a);

/** Mount a generation: a `demo` tool returning `tag`, plus a turn_start handler counting its fires. */
function mount(s: PiSurface<FakePi>, key: string, tag: string): { fired: () => number } {
  let fired = 0;
  const scoped = s.forModule(key);
  scoped.registerTool({ name: 'demo', execute: async () => tag });
  scoped.on('turn_start', () => { fired++; });
  return { fired: () => fired };
}

test('surface: registrations pass through while the generation is alive', async () => {
  const pi = fakePi();
  const scoped = new PiSurface(pi).forModule('core/a');
  let fired = 0;
  scoped.on('session_start', () => { fired++; });
  scoped.registerTool({ name: 't1', execute: async () => 'OK' });
  await fire(pi, 'session_start');
  assert.equal(fired, 1);
  assert.equal(await callTool(pi, 't1'), 'OK');
});

test('surface: disposeModule tombstones the handler and puts the tool inert', async () => {
  const pi = fakePi();
  const s = new PiSurface(pi);
  const scoped = s.forModule('core/a');
  let fired = 0;
  scoped.on('turn_start', () => { fired++; });
  scoped.registerTool({ name: 't1', execute: async () => 'OK' });
  assert.equal(s.disposeModule('core/a'), true);
  await fire(pi, 'turn_start');
  assert.equal(fired, 0, 'a tombstoned handler must not fire (hmr double-fire fix)');
  assert.match(((await callTool(pi, 't1')) as { content: Array<{ text: string }> }).content[0]!.text, /disposed/);
  assert.equal(s.disposeModule('core/a'), false, 'a second dispose is an idempotent false');
});

test('surface: hot swap — the new generation wins and the old handler stays silent', async () => {
  const pi = fakePi();
  const s = new PiSurface(pi);
  const v1 = mount(s, 'core/a', 'v1');
  s.disposeModule('core/a'); // hmr compensation tears the old generation down
  const v2 = mount(s, 'core/a', 'v2');
  assert.equal(await callTool(pi, 'demo'), 'v2', 'tools overwrite by name: the new version wins');
  await fire(pi, 'turn_start');
  assert.equal(v1.fired(), 0, 'the old handler is tombstoned (no double fire)');
  assert.equal(v2.fired(), 1, 'the new handler fires once');
});

test('surface: ledger interlock — disposing a key flips its tombstone', async () => {
  const pi = fakePi();
  const ledger = new DisposeLedger();
  const s = new PiSurface(pi, ledger);
  let fired = 0;
  s.forModule('core/a').on('session_start', () => { fired++; });
  ledger.disposeKey('core/a'); // the same path hmr/reload takes
  await fire(pi, 'session_start');
  assert.equal(fired, 0, 'ledger compensation is a tombstone');
});

test('surface: hmr ordering — a disposeKey after the remount must not kill the new generation', async () => {
  // Real cordis-plugin-hmr order: registry.delete → the replacement remounts on the same key →
  // emit('hmr/reload') → ledger.disposeKey(file). Generations mounted after the ledger entry are
  // exempt, so the replacement's tools survive instead of dying on arrival.
  const pi = fakePi();
  const ledger = new DisposeLedger();
  const s = new PiSurface(pi, ledger);
  const KEY = 'file:///F:/repo/src/plugins/demo.ts';
  const v1 = mount(s, KEY, 'v1');
  await fire(pi, 'turn_start');
  assert.equal(v1.fired(), 1, 'precondition: v1 alive');

  const v2 = mount(s, KEY, 'v2'); // the replacement body runs and re-registers
  ledger.disposeKey(KEY); // compensation arrives only after the remount

  assert.equal(await callTool(pi, 'demo'), 'v2', 'the new generation must survive (dead-on-arrival regression)');
  await fire(pi, 'turn_start');
  assert.equal(v1.fired(), 1, 'the old generation went no-op at remount (no double fire)');
  assert.equal(v2.fired(), 1, 'the new generation fires');
});

test('surface: pi 0.86 unsubscribe — retirement removes the listener instead of only tombstoning it', async () => {
  const base = fakePi();
  const removed: string[] = [];
  const pi: FakePi = {
    ...base,
    on(event, handler) {
      base.on(event, handler);
      return () => {
        base.listeners.set(event, (base.listeners.get(event) ?? []).filter((h) => h !== handler));
        removed.push(event);
      };
    },
  };
  const s = new PiSurface(pi);
  const scoped = s.forModule('core/a');
  let fired = 0;
  scoped.on('turn_start', () => { fired++; });
  scoped.registerTool({ name: 't1', execute: async () => 'OK' });
  await fire(pi, 'turn_start');
  assert.equal(fired, 1);
  assert.deepEqual(removed, [], 'no early unsubscribe while alive');

  s.disposeModule('core/a');
  assert.deepEqual(removed, ['turn_start'], 'retirement calls the unsubscribe');
  assert.deepEqual(pi.listeners.get('turn_start') ?? [], [], 'the dispatch list really shrinks');
  assert.match(((await callTool(pi, 't1')) as { content: Array<{ text: string }> }).content[0]!.text, /disposed/, 'tools still tombstone: pi has no unregisterTool');
});


test('handlePipeRequest: todo_sync routes the full worker list into the widget cache', async () => {
  const seen: Array<{ paneId: string; items: unknown[]; summary: string }> = [];
  const res = await handlePipeRequest(
    {
      type: 'todo_sync', id: 'ts-1', paneId: 'p2',
      items: [{ content: 'auth tests', status: 'in_progress' }, { content: 'extract', status: 'completed' }],
      summary: '▶1 ✓1 (1/2) · auth tests',
    },
    pipeSession({ applyWorkerTodos: (paneId, items, summary) => { seen.push({ paneId, items: [...items], summary }); } }),
  );
  assert.deepEqual(res, { type: 'ok', id: 'ts-1' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.paneId, 'p2');
  assert.equal(seen[0]!.items.length, 2);
  assert.equal(seen[0]!.summary, '▶1 ✓1 (1/2) · auth tests');
});
