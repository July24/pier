/**
 * Child-session I/O and output observation: candidate resolution (own/taken exclusions), liveness
 * probes, state derivation with cache invalidation, the output delta, the `output` action, and the
 * reply-session healing paths (resume, poisoned sessionFile, re-armed settlement watch).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentInfo, HerdrClientLike } from '../src/herdr-client.ts';
import { SUBS_CUSTOM_TYPE, type SubEntry } from '../src/subagent-core.ts';
import { sessionDirName } from '../src/session-tail.ts';
import {
  computeSubagentOutputDelta,
  createSessionIo,
  formatSubagentOutput,
  resolveSubagentStatus,
  type SubagentOutputCursor,
} from '../src/subagent-session.ts';
import { appendHistory } from '../src/history-store.ts';
import { preferredHistoryFile } from '../src/storage-layout.ts';
import {
  TempHome,
  fakeHerdr,
  fire,
  jsonl,
  mountSubagent,
  runSubagent,
  runSubagentRejects,
  subsSnapshot,
  subEntry,
  transcriptMessage,
  type FakePi,
} from './test-utils.ts';

const TS = 1_800_000_000_000;
const sessions = () => mkdtempSync(join(tmpdir(), 'pier-session-'));
const NO_STATE = { text: null, pendingTool: false, activity: false, turnEnded: false, compacting: false };

/** SessionIo over a scripted herdr report; `sessionsDir` is where candidate files are scanned. */
const io = (reported: string | null, sessionsDir: string, ownSession = '') => createSessionIo({
  client: fakeHerdr({ getAgentSessionPath: async () => reported }),
  getSessionId: () => ownSession,
  sessionsDir: () => sessionsDir,
});

const writeSession = (file: string, lines: unknown[], append = false): void => {
  writeFileSync(file, jsonl(...lines), append ? { flag: 'a' } : undefined);
};

test('subSessionState: a reported but not-yet-created session file is skipped, not fatal', async () => {
  const dir = sessions();
  const state = await io(join(dir, 'not-created-yet.jsonl'), dir).subSessionState('wC:p4', dir, Date.now());
  assert.deepEqual(state, NO_STATE);
});

test('subSessionState: a readable session with terminal text settles', async () => {
  const dir = sessions();
  const file = join(dir, 'child.jsonl');
  writeSession(file, [transcriptMessage('assistant', 'ok', TS + 10)]);
  assert.deepEqual(await io(file, dir).subSessionState('wC:p4', dir, TS), {
    text: 'ok', pendingTool: false, activity: true, turnEnded: true, compacting: false,
  });
});

test('subSessionState: between tool calls the turn has NOT ended', async () => {
  const dir = sessions();
  const file = join(dir, 'child-midflight.jsonl');
  writeSession(file, [
    transcriptMessage('user', 'task', TS),
    { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall' }], timestamp: TS + 10, stopReason: 'toolUse' } },
    transcriptMessage('toolResult', 'ok', TS + 20),
  ]);
  assert.deepEqual(await io(file, dir).subSessionState('wC:p4', dir, TS), {
    text: null, pendingTool: false, activity: true, turnEnded: false, compacting: false,
  });
});

test('subSessionState: cache invalidates on append (a stale hit would hang pendingTool forever)', async () => {
  const dir = sessions();
  const file = join(dir, 'child-growing.jsonl');
  writeSession(file, [{ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall' }], timestamp: TS + 10, stopReason: 'toolUse' } }]);
  const session = io(file, dir);
  assert.deepEqual(await session.subSessionState('wC:p4', dir, TS), {
    text: null, pendingTool: true, activity: true, turnEnded: false, compacting: false,
  });
  writeSession(file, [transcriptMessage('assistant', 'finished', TS + 20)], true);
  assert.deepEqual(await session.subSessionState('wC:p4', dir, TS), {
    text: 'finished', pendingTool: false, activity: true, turnEnded: true, compacting: false,
  });
});

test('collectFinalText: a cached null must not stick after the session gains closing text', async () => {
  const dir = sessions();
  const file = join(dir, 'child-late-text.jsonl');
  writeSession(file, [{ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall' }], timestamp: TS + 10, stopReason: 'toolUse' } }]);
  const session = io(file, dir);
  assert.equal(await session.collectFinalText('wC:p4', dir, TS, 1), null);
  writeSession(file, [transcriptMessage('assistant', 'late result', TS + 30)], true);
  assert.equal(await session.collectFinalText('wC:p4', dir, TS, 1), 'late result');
});

test('probeAlive: pane.list decides liveness; an unknown shell is alive and agent.list cannot resurrect a miss', async () => {
  const dir = sessions();
  const unknown = createSessionIo({
    client: fakeHerdr({
      listPanes: async () => [{ paneId: 'wH:p3', tabId: 'wH:t1', workspaceId: 'wH', agentStatus: 'unknown', foregroundCwd: '/tmp/work' }],
    }),
    getSessionId: () => '',
    sessionsDir: () => dir,
  });
  const probe = await unknown.probeAlive('wH:p3', dir);
  assert.equal(probe.paneExists, true);
  assert.equal(probe.agentStatus, 'unknown');
  assert.equal(probe.foregroundCwd, '/tmp/work');

  const gone = createSessionIo({
    client: fakeHerdr({
      listPanes: async () => [],
      listAgents: async () => [{ paneId: 'wH:p3', agent: 'pi', status: 'working', session: null, stateLabels: {}, tokens: {} }],
    }),
    getSessionId: () => '',
    sessionsDir: () => dir,
  });
  assert.equal((await gone.probeAlive('wH:p3', dir)).paneExists, false);
});

/* ── candidate resolution: own/taken sessions are never adopted ─── */

/** Agent home with a project session dir ready for candidate files. */
function projectSessions(prefix: string) {
  const home = new TempHome(prefix);
  const cwd = '/tmp/proj';
  const dir = home.dir('sessions', sessionDirName(cwd));
  const sessionsDir = join(home.path, 'sessions');
  const file = (name: string): string => {
    const path = join(dir, name);
    writeFileSync(path, '{}\n');
    return path;
  };
  return { home, cwd, file, sessionsDir };
}

const MASTER_ID = '01a0bd3a-c2e5-7569-8d2c-aea4d82630cd';
const agentInfo = (over: Partial<AgentInfo>): AgentInfo => ({
  paneId: 'pWorker', agent: 'pi', status: 'working', session: null, stateLabels: {}, tokens: {}, ...over,
});

test('resolveSessionFile: the master transcript and sessions claimed by other panes are excluded', async () => {
  const { home, cwd, file, sessionsDir } = projectSessions('pier-session-own-');
  const master = file('2026-09-20T05-12-19-942Z_01a0bd3a-c2e5-7569-8d2c-aea4d82630cd.jsonl');
  const stale = file('2026-09-20T05-05-04-206Z_01a0bd34-1ccd-73e1-a93f-e57e7f124d49.jsonl');
  const sub = file('2026-09-20T05-21-01-111Z_11111111-2222-3333-4444-555555555555.jsonl');
  // The master writes continuously, so an mtime fallback would pick it first.
  utimesSync(sub, 1_000, 1_000);
  utimesSync(stale, 2_000, 2_000);
  utimesSync(master, 3_000, 3_000);

  const fallback = createSessionIo({
    client: fakeHerdr(),
    getSessionId: () => MASTER_ID,
    sessionsDir: () => sessionsDir,
  });
  assert.equal(await fallback.resolveSessionFile('wA:p25', cwd), stale);

  const reported = createSessionIo({
    client: fakeHerdr({
      // herdr's report itself points at the master's file; another pane claims a bare id.
      getAgentSessionPath: async () => master,
      listAgents: async () => [
        agentInfo({ paneId: 'wA:p1F', status: 'idle', session: master }),
        agentInfo({ paneId: 'wA:p24', status: 'idle', session: '01a0bd34-1ccd-73e1-a93f-e57e7f124d49' }),
      ],
    }),
    getSessionId: () => MASTER_ID,
    sessionsDir: () => sessionsDir,
  });
  assert.equal(await reported.resolveSessionFile('wA:p25', cwd), sub, 'own and taken reports (paths or bare ids) are rejected');
  home.dispose();
});

test('resolveSessionFile: own report returned as-is; the pipe self-report outranks a lagging herdr report', async () => {
  const { home, cwd, file, sessionsDir } = projectSessions('pier-session-pref-');
  const sub = file('2026-09-20T05-21-01-111Z_11111111-2222-3333-4444-555555555555.jsonl');
  const preferred = file('2026-09-20T05-14-07-064Z_01a0bd3c-6557-746b-adf6-5128f2326c57.jsonl');
  const reported = file('2026-09-20T05-05-04-206Z_01a0bd34-1ccd-73e1-a93f-e57e7f124d49.jsonl');
  utimesSync(preferred, 1_000, 1_000);
  utimesSync(reported, 2_000, 2_000);
  const ioFor = (agents: AgentInfo[] = []) => createSessionIo({
    client: fakeHerdr({ getAgentSessionPath: async () => reported, listAgents: async () => agents }),
    getSessionId: () => '22222222-2222-3333-4444-555555555555',
    sessionsDir: () => sessionsDir,
  });
  assert.equal(
    await ioFor([agentInfo({ paneId: 'wA:p25', status: 'working', session: sub })]).resolveSessionFile('wA:p25', cwd),
    sub,
    'a report naming the pane\'s own session wins',
  );
  assert.equal(await ioFor().resolveSessionFile('wA:p24', cwd, preferred), preferred, 'a pipe self-report wins over the lagging report');
  assert.equal(await ioFor().resolveSessionFile('wA:p24', cwd), reported, 'without a self-report the old order holds');
  home.dispose();
});

test('readSettleTail: last assistant text of any stopReason, bounded to maxChars', async () => {
  const { home, cwd, file, sessionsDir } = projectSessions('pier-session-tail-');
  const f = file('2026-09-20T05-30-00-000Z_33333333-3333-4444-5555-666666666666.jsonl');
  writeSession(f, [{ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '阶段性输出，未定稿'.repeat(200) }], timestamp: Date.now(), stopReason: 'toolUse' } }]);
  const session = createSessionIo({ client: fakeHerdr({ getAgentSessionPath: async () => f }), getSessionId: () => '', sessionsDir: () => sessionsDir });
  const tail = await session.readSettleTail('wA:p24', cwd);
  assert.ok(tail && tail.length <= 1200 && tail.includes('阶段性输出'), String(tail?.length));
  home.dispose();
});

test('reattributeStaleSessionFile: repairs a stale or poisoned value from herdr, never guesses', async () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'pier-session-reattr-'));
  const file = (name: string): string => {
    const path = join(agentDir, name);
    writeFileSync(path, '{}\n');
    return path;
  };
  const ownFile = file('2026-09-21T06-00-00-000Z_11111111-1111-4111-8111-111111111111.jsonl');
  const takenFile = file('2026-09-21T06-00-00-000Z_22222222-2222-4222-8222-222222222222.jsonl');
  const foreignFile = file('2026-09-21T06-05-00-000Z_33333333-3333-4333-8333-333333333333.jsonl');
  const stalePreferred = file('2026-09-16T07-15-46-751Z_44444444-4444-4444-8444-444444444444.jsonl');
  utimesSync(stalePreferred, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));

  const poisoned = createSessionIo({
    client: fakeHerdr({
      listAgents: async () => [
        agentInfo({ paneId: 'wA:pStale', session: ownFile }),
        agentInfo({ paneId: 'wA:pOther', session: takenFile }),
      ],
      getAgentSessionPath: async () => ownFile,
    }),
    getSessionId: () => ownFile,
    sessionsDir: () => agentDir,
  });
  assert.equal(
    await poisoned.reattributeStaleSessionFile('wA:pStale', '/tmp/proj', Date.now(), stalePreferred),
    null,
    'an own-transcript report is rejected even though the file is fresh',
  );

  const repairing = createSessionIo({
    client: fakeHerdr({
      listAgents: async () => [
        agentInfo({ paneId: 'wA:pStale', session: foreignFile }),
        agentInfo({ paneId: 'wA:pOther', session: takenFile }),
      ],
      getAgentSessionPath: async () => foreignFile,
    }),
    getSessionId: () => ownFile,
    sessionsDir: () => agentDir,
  });
  const now = Date.now();
  assert.equal(await repairing.reattributeStaleSessionFile('wA:pStale', '/tmp/proj', now, stalePreferred), foreignFile);
  assert.equal(await repairing.reattributeStaleSessionFile('wA:pStale', '/tmp/proj', now, foreignFile), foreignFile, 'a fresh preferred is kept as-is');
  // The master rewrites its own transcript continuously, so freshness alone must not preserve poison;
  // the report repairs it instead of returning null (= keep the old value).
  assert.equal(await repairing.reattributeStaleSessionFile('wA:pStale', '/tmp/proj', now, ownFile), foreignFile);
  assert.equal(await repairing.reattributeStaleSessionFile('wA:pStale', '/tmp/proj', now, takenFile), foreignFile);
});

/* ── output delta (pure) ────────────────────────────────────────── */

const CURSOR = (tail: string, fullLength: number): SubagentOutputCursor => ({ tail, fullLength });

test('computeSubagentOutputDelta: full, empty, appended and truncated deltas', async (t) => {
  await t.test('first call returns the full buffer bounded to maxChars', () => {
    const res = computeSubagentOutputDelta(null, 'Line 1\nLine 2\nLine 3\n', { maxChars: 100 });
    assert.equal(res.delta, 'Line 1\nLine 2\nLine 3\n');
    assert.equal(res.restart, false);
    assert.equal(res.truncated, false);
    assert.equal(res.nextCursor.fullLength, 21);
    assert.ok(res.nextCursor.tail.endsWith('Line 3\n'));
  });

  await t.test('unchanged buffer returns an empty delta and keeps the cursor', () => {
    const text = 'Line 1\nLine 2\n';
    const initial = computeSubagentOutputDelta(null, text);
    const second = computeSubagentOutputDelta(initial.nextCursor, text);
    assert.equal(second.delta, '');
    assert.equal(second.truncated, false);
    assert.equal(second.nextCursor, initial.nextCursor);
  });

  await t.test('an append yields only the new text', () => {
    const first = computeSubagentOutputDelta(null, 'Step 1: start\nStep 2: build\n');
    const second = computeSubagentOutputDelta(first.nextCursor, 'Step 1: start\nStep 2: build\nStep 3: test passed\n');
    assert.equal(second.delta, 'Step 3: test passed\n');
    assert.equal(second.restart, false);
    assert.equal(second.nextCursor.fullLength, second.delta.length + first.nextCursor.fullLength);
  });

  await t.test('a delta over maxChars is truncated from the beginning', () => {
    const res = computeSubagentOutputDelta(CURSOR('START\n', 6), 'START\n' + 'x'.repeat(500) + 'END', { maxChars: 50 });
    assert.equal(res.restart, false);
    assert.equal(res.truncated, true);
    assert.equal(res.delta.length, 50);
    assert.ok(res.delta.endsWith('END'));
  });
});

test('computeSubagentOutputDelta: ambiguous tails, partial scrolls and clears restart with the full text', async (t) => {
  await t.test('a repeated tail is ambiguous → full text with restart', () => {
    const text = 'ping\nping\nping\nping\n';
    const res = computeSubagentOutputDelta(CURSOR('ping\n', 5), text);
    assert.equal(res.restart, true);
    assert.equal(res.delta, text);
  });

  await t.test('a partially scrolled buffer resyncs on the longest overlap', () => {
    const res = computeSubagentOutputDelta(
      CURSOR('line 15\nline 16\nline 17\nline 18\nline 19\nline 20\n', 200),
      'line 18\nline 19\nline 20\nline 21: new!\n',
      { minOverlap: 16 },
    );
    assert.equal(res.restart, false);
    assert.equal(res.delta, 'line 21: new!\n');
  });

  await t.test('a clear screen (no overlap) degrades to full text with restart', () => {
    const currText = 'Brand New Task Running\nAll previous scrolled away\n';
    const res = computeSubagentOutputDelta(CURSOR('Old Task Step 1\nOld Task Step 2\n', 100), currText);
    assert.equal(res.restart, true);
    assert.equal(res.delta, currText);
  });
});

test('resolveSubagentStatus: blocked > working > settled > idle, running as the default', () => {
  assert.equal(resolveSubagentStatus({ localStatus: 'running', herdrStatus: 'blocked' }), 'blocked');
  assert.equal(resolveSubagentStatus({ localStatus: 'running', hasAskFlag: true }), 'blocked');
  assert.equal(resolveSubagentStatus({ localStatus: 'running', herdrStatus: 'working' }), 'running');
  assert.equal(resolveSubagentStatus({ localStatus: 'settled', herdrStatus: 'idle' }), 'settled');
  assert.equal(resolveSubagentStatus({ localStatus: 'closed', herdrStatus: 'idle' }), 'settled');
  assert.equal(resolveSubagentStatus({ localStatus: 'running', herdrStatus: 'done' }), 'settled');
  assert.equal(resolveSubagentStatus({ localStatus: 'running', herdrStatus: 'idle' }), 'idle');
  assert.equal(resolveSubagentStatus({ localStatus: 'running', herdrStatus: null }), 'running');
});

test('formatSubagentOutput: header, body, empty-delta notice and flags', () => {
  const formatted = formatSubagentOutput({
    paneId: 'wD:p6',
    status: 'running',
    revision: 5,
    bufferTruncated: false,
    deltaResult: { delta: 'Compiling module A...\nDone.', restart: false, truncated: false },
  });
  assert.match(formatted, /\[Subagent Output \| pane: wD:p6 \| status: running \| revision: 5\]/);
  assert.match(formatted, /Compiling module A\.\.\.\nDone\./);

  const flagged = formatSubagentOutput({
    paneId: 'wD:p6',
    status: 'blocked',
    revision: 2,
    bufferTruncated: true,
    askQuestion: 'Confirm overwrite?',
    deltaResult: { delta: '', restart: true, truncated: false },
  });
  assert.match(flagged, /status: blocked \(question: "Confirm overwrite\?"\)/);
  assert.match(flagged, /buffer scrolled or reset — full text returned \(not a process restart\)/);
  assert.match(flagged, /truncated: true/);
  assert.match(flagged, /\(no new output since last read\)/);
  assert.doesNotMatch(flagged, /restart: true/);
});

/* ── output action ──────────────────────────────────────────────── */

const worker = (paneId: string, status: SubEntry['status'] = 'running') =>
  subEntry({ paneId, taskId: `task-${paneId}`, tabId: 't1', tabName: 'worker', status });

/** A throwing pane.list stands the zombie sweep and the settlement-watch recovery down, so neither
 * can rewrite a seeded row mid-test (no poller is armed to consume it). */
const NO_PANES = { listPanes: async (): Promise<never> => { throw new Error('pane.list unavailable in this fixture'); } };

/** Mounts the plugin over a scripted herdr client with one seeded worker row, then disposes it. */
async function withWorker(
  body: (pi: FakePi) => Promise<void>,
  client: Partial<HerdrClientLike> = {},
  status: SubEntry['status'] = 'running',
): Promise<void> {
  const { root, pi } = await mountSubagent({ client: { ...NO_PANES, ...client }, subs: [worker('pWorker', status)] });
  try {
    await body(pi);
  } finally {
    await root.fiber.dispose();
  }
}

test('output action: missing and unknown ids fail with actionable messages', async () => {
  const { root, pi } = await mountSubagent();
  try {
    await assert.rejects(runSubagent(pi, { action: 'output' }), /missing agentId for output/);
    await assert.rejects(runSubagent(pi, { action: 'output', agentId: 'nope' }), /unknown subagent id "nope"/);
  } finally {
    await root.fiber.dispose();
  }
});

test('output action: incremental reads return only the delta since the last call', async () => {
  let output = 'Initial output line 1\nInitial output line 2\n';
  await withWorker(async (pi) => {
    const first = await runSubagent(pi, { action: 'output', agentId: 'pWorker' });
    assert.equal(first.content[0]!.text.includes('Initial output line 1'), true);
    output += 'Progress: compiling module B\n';
    const second = await runSubagent(pi, { action: 'output', agentId: 'pWorker' });
    assert.match(second.content[0]!.text, /Progress: compiling module B/);
    assert.doesNotMatch(second.content[0]!.text, /Initial output line 2/, 'only the delta is returned');
  }, {
    listAgents: async () => [agentInfo({ status: 'working' })],
    readAgent: async () => ({ text: output, revision: 1, truncated: false }),
  });
});

test('output action: older herdr without agent.read still observes through pane.read', async () => {
  let readPaneCalled = false;
  await withWorker(async (pi) => {
    const res = await runSubagent(pi, { action: 'output', agentId: 'pWorker' });
    assert.equal(readPaneCalled, true);
    assert.match(res.content[0]!.text, /fallback text from readPane/);
  }, {
    listAgents: async () => [agentInfo({ status: 'working' })],
    readAgent: async () => { throw new Error('unknown method: agent.read'); },
    readPane: async () => {
      readPaneCalled = true;
      return { text: 'fallback text from readPane\n', revision: 0, truncated: false };
    },
  });
});

test('output action: a human gate is reported with its question', async () => {
  await withWorker(async (pi) => {
    const res = await runSubagent(pi, { action: 'output', agentId: 'pWorker' });
    assert.equal(res.details!.status, 'blocked');
    assert.match(res.content[0]!.text, /status: blocked \(question: "Should we delete existing tables\?"\)/);
  }, {
    listAgents: async () => [agentInfo({ status: 'blocked', tokens: { 'pi-ask': 'Should we delete existing tables?' } })],
    readAgent: async () => ({ text: 'waiting\n', revision: 1, truncated: false }),
  });
});

test('output action: a settled row reports settled even while the pane is idle', async () => {
  await withWorker(async (pi) => {
    const res = await runSubagent(pi, { action: 'output', agentId: 'pWorker' });
    assert.equal(res.details!.status, 'settled');
    assert.match(res.content[0]!.text, /status: settled/);
  }, {
    listAgents: async () => [agentInfo({ status: 'idle' })],
    readAgent: async () => ({ text: 'Task completed successfully.\n', revision: 4, truncated: false }),
  }, 'settled');
});

test('output action: an idle pane showing only its overlay still surfaces the transcript report, once', async () => {
  const home = new TempHome('pier-out-home-');
  const reportFile = home.dir('sessions', 'sub-report');
  const report = join(reportFile, '2026-09-20T07-00-00-000Z_55555555-6666-4777-8888-999999999999.jsonl');
  writeSession(report, [transcriptMessage('assistant', 'FINAL REPORT: region enum + converter delivered byte-identical to dev_eu', Date.now())]);

  await withWorker(async (pi) => {
    const first = await runSubagent(pi, { action: 'output', agentId: 'pWorker', max_chars: 3000 });
    assert.equal(first.details!.status, 'idle');
    assert.ok((first.details!.deltaLength as number) > 0, 'the overlay footer is the pane text');
    assert.equal(first.details!.reportDelivered, true);
    assert.match(first.content[0]!.text, /Subagent Report \| latest finalized message from session transcript/);
    assert.match(first.content[0]!.text, /FINAL REPORT: region enum/);

    const second = await runSubagent(pi, { action: 'output', agentId: 'pWorker', max_chars: 3000 });
    assert.equal(second.details!.deltaLength, 0);
    assert.equal(second.details!.reportDelivered, false, 'an unchanged report is not re-delivered');
    assert.doesNotMatch(second.content[0]!.text, /Subagent Report/);
  }, {
    listAgents: async () => [agentInfo({ status: 'idle', session: report })],
    readAgent: async () => ({ text: 'todo: 0▶ 0○ 0■ 7✓\n   +3 hidden (7✓) · /todos\n', revision: 0, truncated: false }),
  });
  home.dispose();
});

/* ── reply-session healing ──────────────────────────────────────── */

const branchOf = (entry: SubEntry) => [{ type: 'custom', customType: SUBS_CUSTOM_TYPE, data: { subs: [entry] } }] as never;

test('resume: a ledger row pointing at the master session is refused; another pane is reused', async () => {
  const home = new TempHome('pier-resume-self-');
  const cwd = mkdtempSync(join(tmpdir(), 'pier-resume-self-cwd-'));
  const masterFile = join(cwd, 'master-session.jsonl');
  const otherFile = join(cwd, 'other-session.jsonl');
  writeFileSync(masterFile, '{}\n');
  writeFileSync(otherFile, '{}\n');

  const { root, pi } = await mountSubagent({
    client: {
      listPanes: async () => [
        { paneId: 'p0', tabId: 't0', workspaceId: 'w1', agentStatus: 'idle' },
        { paneId: 'p2', tabId: 't0', workspaceId: 'w1', agentStatus: 'idle' },
      ],
      listAgents: async () => [
        agentInfo({ paneId: 'p0', status: 'idle', session: masterFile }),
        agentInfo({ paneId: 'p2', status: 'idle', session: otherFile }),
      ],
    },
  });
  try {
    const histFile = preferredHistoryFile(home.path, cwd);
    const base = {
      kind: 'task' as const, tabId: 't0', workspaceId: 'w1', cwd,
      launchCommand: ['node', 'cli.js'], status: 'closed' as const,
    };
    appendHistory(histFile, { ...base, taskId: '8183022d-a733-4292-911b-850e6dffba5a', paneId: 'wA:p25', description: 'Investigate bug 19812', sessionFile: masterFile, createdAt: Date.now() });
    appendHistory(histFile, { ...base, taskId: '937f4abf-0000-4111-8222-333333333333', paneId: 'wA:p2old', description: 'healthy task', sessionFile: otherFile, createdAt: Date.now() + 1 });

    assert.match(await runSubagentRejects(pi, { action: 'resume', taskId: '8183022d' }, cwd), /master's own session/);
    assert.ok(!subsSnapshot(pi)?.subs.some((s) => s.paneId === 'p0'), 'the master pane never enters the registry');

    const ok = await runSubagent(pi, { action: 'resume', taskId: '937f4abf' }, cwd);
    assert.match(ok.content[0]!.text, /reused existing pane/);
    assert.equal(ok.details?.paneId, 'p2');
  } finally {
    await root.fiber.dispose();
    home.dispose();
  }
});

test('applyReplySession: a bare session id self-report repairs a poisoned sessionFile', async () => {
  const home = new TempHome('pier-reply-session-');
  const cwd = mkdtempSync(join(tmpdir(), 'pier-reply-cwd-'));
  const dir = home.dir('sessions', sessionDirName(cwd));
  const realFile = join(dir, '2026-09-20T05-14-07-064Z_01a0bd3c-6557-746b-adf6-5128f2326c57.jsonl');
  writeFileSync(realFile, '{}\n');
  const poisoned = join(cwd, 'stale-01a0bd34.jsonl');
  writeFileSync(poisoned, '{}\n');

  const { root, pi, port } = await mountSubagent({
    client: { getAgentSessionPath: async () => realFile },
    deps: { getSessionId: () => '99999999-9999-4999-8999-999999999999' },
  });
  try {
    await fire(pi, 'session_start', {}, {
      sessionManager: {
        getBranch: () => branchOf(subEntry({
          taskId: '11111111-2222-4333-8444-555555555555', paneId: 'p2', tabId: 't0', tabName: 'main',
          cwd, description: 'Investigate bug 19803', status: 'settled',
          sessionFile: poisoned, createdAt: Date.now() - 60_000,
        })),
      },
    });
    port.current!.applyReplySession('p2', '01a0bd3c-6557-746b-adf6-5128f2326c57');
    assert.equal(subsSnapshot(pi)!.subs.find((s) => s.paneId === 'p2')!.sessionFile, realFile);
  } finally {
    await root.fiber.dispose();
    home.dispose();
  }
});

test('session recovery: a still-running subagent gets its settlement watch re-armed', async () => {
  const home = new TempHome('pier-recover-home-');
  const cwd = mkdtempSync(join(tmpdir(), 'pier-recover-cwd-'));
  const dir = home.dir('sessions', sessionDirName(cwd));
  const workerFile = join(dir, '2026-09-20T06-10-00-000Z_aaaa1111-2222-4333-8444-555555555555.jsonl');
  writeFileSync(workerFile, jsonl(transcriptMessage('assistant', 'RECOVERED_REPORT: fix committed, 199 tests green', Date.now())));

  const notices: string[] = [];
  const { root, pi } = await mountSubagent({
    client: {
      listPanes: async () => [{ paneId: 'pAlive', tabId: 't0', workspaceId: 'w1', agentStatus: 'idle' }],
      listAgents: async () => [agentInfo({ paneId: 'pAlive', status: 'idle', session: workerFile })],
      waitAgent: async () => 'idle',
      getAgentSessionPath: async () => workerFile,
    },
    deps: {
      getSessionId: () => 'bbbb2222-3333-4444-8555-666666666666',
      deliverNotice: async (content: string) => { notices.push(content); },
    },
  });
  try {
    const createdAt = Date.now() - 120_000;
    await fire(pi, 'session_start', {}, {
      sessionManager: {
        getBranch: () => branchOf(subEntry({
          taskId: 'cccc3333-4444-4555-8666-777777777777', paneId: 'pAlive', tabId: 't0', tabName: 'main',
          cwd, description: 'Fix bugs in isolated worktree', status: 'running',
          sessionFile: null, createdAt,
          // An already-elapsed observation window lets the recovered poller settle on its first tick.
          observationStartedAt: createdAt,
        })),
      },
    });
    assert.ok(notices.some((n) => n.includes('settlement watch re-armed')), `missing recovery notice: ${JSON.stringify(notices)}`);
    const settle = notices.find((n) => n.includes('closing message'));
    assert.ok(settle, `missing settlement notice: ${JSON.stringify(notices)}`);
    assert.match(settle!, /RECOVERED_REPORT/);
    assert.equal(subsSnapshot(pi)!.subs.find((s) => s.paneId === 'pAlive')!.status, 'consumed');
  } finally {
    await root.fiber.dispose();
    home.dispose();
  }
});
