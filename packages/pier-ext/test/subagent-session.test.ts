/**
 * Child-session I/O and output observation: candidate resolution (own/taken exclusions),
 * liveness probes, state derivation with cache invalidation, the output delta, and the
 * `subagent(action: "output")` behavior including the transcript fallback.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import type { AgentInfo, HerdrClientLike } from '../src/herdr-client.ts';
import { PiSurface } from '../src/pi-surface.ts';
import subagentPlugin from '../src/plugins/subagent.ts';
import { SUBS_CUSTOM_TYPE, emptySubagentPortBox, type SubEntry } from '../src/subagent-core.ts';
import { sessionDirName } from '../src/session-tail.ts';
import {
  computeSubagentOutputDelta,
  createSessionIo,
  formatSubagentOutput,
  resolveSubagentStatus,
  type SubagentOutputCursor,
} from '../src/subagent-session.ts';

function io(reported: string | null, sessionsDir: string, ownSession = '') {
  return createSessionIo({
    client: {
      getAgentSessionPath: async () => reported,
      listAgents: async () => [],
    } as unknown as HerdrClientLike,
    getSessionId: () => ownSession,
    sessionsDir: () => sessionsDir,
  });
}

const TS = 1_800_000_000_000;
const sessions = () => mkdtempSync(join(tmpdir(), 'pier-session-'));

const writeSession = (file: string, lines: unknown[], append = false): void => {
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', append ? { flag: 'a' } : undefined);
};

const NO_STATE = { text: null, pendingTool: false, activity: false, turnEnded: false, compacting: false };

test('subSessionState: a reported but not-yet-created session file is skipped, not fatal', async () => {
  const dir = sessions();
  const state = await io(join(dir, 'not-created-yet.jsonl'), dir).subSessionState('wC:p4', dir, Date.now());
  assert.deepEqual(state, NO_STATE);
});

test('subSessionState: a readable session with terminal text settles', async () => {
  const dir = sessions();
  const file = join(dir, 'child.jsonl');
  writeSession(file, [{ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], timestamp: TS + 10, stopReason: 'stop' } }]);
  assert.deepEqual(await io(file, dir).subSessionState('wC:p4', dir, TS), {
    text: 'ok', pendingTool: false, activity: true, turnEnded: true, compacting: false,
  });
});

test('subSessionState: between tool calls the turn has NOT ended', async () => {
  const dir = sessions();
  const file = join(dir, 'child-midflight.jsonl');
  writeSession(file, [
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'task' }], timestamp: TS } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall' }], timestamp: TS + 10, stopReason: 'toolUse' } },
    { type: 'message', message: { role: 'toolResult', content: [{ type: 'text', text: 'ok' }], timestamp: TS + 20 } },
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
  writeSession(file, [{ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'finished' }], timestamp: TS + 20, stopReason: 'stop' } }], true);
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
  writeSession(file, [{ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'late result' }], timestamp: TS + 30, stopReason: 'stop' } }], true);
  assert.equal(await session.collectFinalText('wC:p4', dir, TS, 1), 'late result');
});

test('probeAlive: an unknown shell in pane.list is alive even when agent.list omits it', async () => {
  const dir = sessions();
  const session = createSessionIo({
    client: {
      getAgentSessionPath: async () => null,
      listAgents: async () => [],
      listPanes: async () => [{ paneId: 'wH:p3', tabId: 'wH:t1', workspaceId: 'wH', agentStatus: 'unknown', foregroundCwd: '/tmp/work' }],
    } as unknown as HerdrClientLike,
    getSessionId: () => '',
    sessionsDir: () => dir,
  });
  const probe = await session.probeAlive('wH:p3', dir);
  assert.equal(probe.paneExists, true);
  assert.equal(probe.agentStatus, 'unknown');
  assert.equal(probe.foregroundCwd, '/tmp/work');
});

test('probeAlive: a pane.list miss is death; agent.list cannot resurrect it', async () => {
  const dir = sessions();
  const session = createSessionIo({
    client: {
      getAgentSessionPath: async () => null,
      listPanes: async () => [],
      listAgents: async () => [{ paneId: 'wH:p3', status: 'working' }],
    } as unknown as HerdrClientLike,
    getSessionId: () => '',
    sessionsDir: () => dir,
  });
  assert.equal((await session.probeAlive('wH:p3', dir)).paneExists, false);
});

/* ── candidate resolution: own/taken sessions are never adopted ─── */

function projectSessions(prefix: string) {
  const agentDir = mkdtempSync(join(tmpdir(), prefix));
  const cwd = '/tmp/proj';
  const dir = join(agentDir, sessionDirName(cwd));
  mkdirSync(dir, { recursive: true });
  const file = (name: string): string => {
    const p = join(dir, name);
    writeFileSync(p, '{}\n');
    return p;
  };
  return { agentDir, cwd, file };
}

const MASTER_ID = '01a0bd3a-c2e5-7569-8d2c-aea4d82630cd';

test('resolveSessionFile: the master transcript and sessions claimed by other panes are excluded', async () => {
  const { agentDir, cwd, file } = projectSessions('pier-session-own-');
  const master = file('2026-09-20T05-12-19-942Z_01a0bd3a-c2e5-7569-8d2c-aea4d82630cd.jsonl');
  const stale = file('2026-09-20T05-05-04-206Z_01a0bd34-1ccd-73e1-a93f-e57e7f124d49.jsonl');
  const sub = file('2026-09-20T05-21-01-111Z_11111111-2222-3333-4444-555555555555.jsonl');
  // The master writes continuously, so an mtime fallback would pick it first.
  utimesSync(sub, 1_000, 1_000);
  utimesSync(stale, 2_000, 2_000);
  utimesSync(master, 3_000, 3_000);

  const fallback = createSessionIo({
    client: { getAgentSessionPath: async () => null, listAgents: async () => [] } as unknown as HerdrClientLike,
    getSessionId: () => MASTER_ID,
    sessionsDir: () => agentDir,
  });
  assert.equal(await fallback.resolveSessionFile('wA:p25', cwd), stale);

  const reported = createSessionIo({
    client: {
      // herdr's report itself points at the master's file; another pane claims a bare id.
      getAgentSessionPath: async () => master,
      listAgents: async () => [
        { paneId: 'wA:p1F', status: 'idle', session: master },
        { paneId: 'wA:p24', status: 'idle', session: '01a0bd34-1ccd-73e1-a93f-e57e7f124d49' },
      ],
    } as unknown as HerdrClientLike,
    getSessionId: () => MASTER_ID,
    sessionsDir: () => agentDir,
  });
  assert.equal(await reported.resolveSessionFile('wA:p25', cwd), sub, 'own and taken reports (paths or bare ids) are rejected');
});

test('resolveSessionFile: a report naming the pane\'s own session is returned as-is', async () => {
  const { agentDir, cwd, file } = projectSessions('pier-session-normal-');
  const sub = file('2026-09-20T05-21-01-111Z_11111111-2222-3333-4444-555555555555.jsonl');
  const session = createSessionIo({
    client: {
      getAgentSessionPath: async () => sub,
      listAgents: async () => [{ paneId: 'wA:p25', status: 'working', session: sub }],
    } as unknown as HerdrClientLike,
    getSessionId: () => MASTER_ID,
    sessionsDir: () => agentDir,
  });
  assert.equal(await session.resolveSessionFile('wA:p25', cwd), sub);
});

test('resolveSessionFile: the pipe self-report (preferred) outranks herdr\'s lagging report', async () => {
  const { agentDir, cwd, file } = projectSessions('pier-session-pref-');
  const preferred = file('2026-09-20T05-14-07-064Z_01a0bd3c-6557-746b-adf6-5128f2326c57.jsonl');
  const reported = file('2026-09-20T05-05-04-206Z_01a0bd34-1ccd-73e1-a93f-e57e7f124d49.jsonl');
  utimesSync(preferred, 1_000, 1_000);
  utimesSync(reported, 2_000, 2_000);
  const session = createSessionIo({
    client: {
      getAgentSessionPath: async () => reported,
      listAgents: async () => [],
    } as unknown as HerdrClientLike,
    getSessionId: () => '22222222-2222-3333-4444-555555555555',
    sessionsDir: () => agentDir,
  });
  assert.equal(await session.resolveSessionFile('wA:p24', cwd, preferred), preferred);
  assert.equal(await session.resolveSessionFile('wA:p24', cwd), reported, 'without a self-report the old order holds');
});

test('readSettleTail: last assistant text of any stopReason, bounded to maxChars', async () => {
  const { agentDir, cwd, file } = projectSessions('pier-session-tail-');
  const f = file('2026-09-20T05-30-00-000Z_33333333-3333-4444-5555-666666666666.jsonl');
  writeSession(f, [{ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '阶段性输出，未定稿'.repeat(200) }], timestamp: Date.now(), stopReason: 'toolUse' } }]);
  const session = createSessionIo({
    client: { getAgentSessionPath: async () => f, listAgents: async () => [] } as unknown as HerdrClientLike,
    getSessionId: () => '',
    sessionsDir: () => agentDir,
  });
  const tail = await session.readSettleTail('wA:p24', cwd);
  assert.ok(tail && tail.length <= 1200 && tail.includes('阶段性输出'), String(tail?.length));
});

test('reattributeStaleSessionFile: repairs a stale or poisoned value from herdr, never guesses', async () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'pier-session-reattr-'));
  const mk = (name: string): string => {
    const f = join(agentDir, name);
    writeFileSync(f, '{}\n');
    return f;
  };
  const ownFile = mk('2026-09-21T06-00-00-000Z_11111111-1111-4111-8111-111111111111.jsonl');
  const takenFile = mk('2026-09-21T06-00-00-000Z_22222222-2222-4222-8222-222222222222.jsonl');
  const foreignFile = mk('2026-09-21T06-05-00-000Z_33333333-3333-4333-8333-333333333333.jsonl');
  const stalePreferred = mk('2026-09-16T07-15-46-751Z_44444444-4444-4444-8444-444444444444.jsonl');
  utimesSync(stalePreferred, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));

  const poisoned = createSessionIo({
    client: {
      listAgents: async () => [
        { paneId: 'wA:pStale', session: ownFile },
        { paneId: 'wA:pOther', session: takenFile },
      ],
      getAgentSessionPath: async () => ownFile,
    } as unknown as HerdrClientLike,
    getSessionId: () => ownFile,
    sessionsDir: () => agentDir,
  });
  assert.equal(
    await poisoned.reattributeStaleSessionFile('wA:pStale', '/tmp/proj', Date.now(), stalePreferred),
    null,
    'an own-transcript report is rejected even though the file is fresh',
  );

  const repairing = createSessionIo({
    client: {
      listAgents: async () => [
        { paneId: 'wA:pStale', session: foreignFile },
        { paneId: 'wA:pOther', session: takenFile },
      ],
      getAgentSessionPath: async () => foreignFile,
    } as unknown as HerdrClientLike,
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

test('computeSubagentOutputDelta: first call returns the full buffer bounded to maxChars', () => {
  const res = computeSubagentOutputDelta(null, 'Line 1\nLine 2\nLine 3\n', { maxChars: 100 });
  assert.equal(res.delta, 'Line 1\nLine 2\nLine 3\n');
  assert.equal(res.restart, false);
  assert.equal(res.truncated, false);
  assert.equal(res.nextCursor.fullLength, 21);
  assert.ok(res.nextCursor.tail.endsWith('Line 3\n'));
});

test('computeSubagentOutputDelta: unchanged buffer returns an empty delta and keeps the cursor', () => {
  const text = 'Line 1\nLine 2\n';
  const initial = computeSubagentOutputDelta(null, text);
  const second = computeSubagentOutputDelta(initial.nextCursor, text);
  assert.equal(second.delta, '');
  assert.equal(second.truncated, false);
  assert.equal(second.nextCursor, initial.nextCursor);
});

test('computeSubagentOutputDelta: an append yields only the new text', () => {
  const first = computeSubagentOutputDelta(null, 'Step 1: start\nStep 2: build\n');
  const second = computeSubagentOutputDelta(first.nextCursor, 'Step 1: start\nStep 2: build\nStep 3: test passed\n');
  assert.equal(second.delta, 'Step 3: test passed\n');
  assert.equal(second.restart, false);
  assert.equal(second.nextCursor.fullLength, second.delta.length + first.nextCursor.fullLength);
});

test('computeSubagentOutputDelta: a repeated tail is ambiguous → full text with restart', () => {
  const cursor: SubagentOutputCursor = { tail: 'ping\n', fullLength: 5 };
  const text = 'ping\nping\nping\nping\n';
  const res = computeSubagentOutputDelta(cursor, text);
  assert.equal(res.restart, true);
  assert.equal(res.delta, text);
});

test('computeSubagentOutputDelta: a partially scrolled buffer resyncs on the longest overlap', () => {
  const cursor: SubagentOutputCursor = {
    tail: 'line 15\nline 16\nline 17\nline 18\nline 19\nline 20\n',
    fullLength: 200,
  };
  const res = computeSubagentOutputDelta(cursor, 'line 18\nline 19\nline 20\nline 21: new!\n', { minOverlap: 16 });
  assert.equal(res.restart, false);
  assert.equal(res.delta, 'line 21: new!\n');
});

test('computeSubagentOutputDelta: a clear screen (no overlap) degrades to full text with restart', () => {
  const cursor: SubagentOutputCursor = { tail: 'Old Task Step 1\nOld Task Step 2\n', fullLength: 100 };
  const currText = 'Brand New Task Running\nAll previous scrolled away\n';
  const res = computeSubagentOutputDelta(cursor, currText);
  assert.equal(res.restart, true);
  assert.equal(res.delta, currText);
});

test('computeSubagentOutputDelta: a delta over maxChars is truncated from the beginning', () => {
  const cursor: SubagentOutputCursor = { tail: 'START\n', fullLength: 6 };
  const res = computeSubagentOutputDelta(cursor, 'START\n' + 'x'.repeat(500) + 'END', { maxChars: 50 });
  assert.equal(res.restart, false);
  assert.equal(res.truncated, true);
  assert.equal(res.delta.length, 50);
  assert.ok(res.delta.endsWith('END'));
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

interface FakePi {
  tools: Map<string, { execute?: (...a: unknown[]) => unknown }>;
  listeners: Map<string, Array<(...a: unknown[]) => unknown>>;
  entries: Array<[string, unknown]>;
  registerTool(def: { name: string; execute?: (...a: unknown[]) => unknown }): void;
  on(event: string, handler: (...a: unknown[]) => unknown): void;
  appendEntry(customType: string, data: unknown): void;
}

function createFakePi(): FakePi {
  return {
    tools: new Map(),
    listeners: new Map(),
    entries: [],
    registerTool(def) { this.tools.set(def.name, def); },
    on(event, handler) { this.listeners.set(event, [...(this.listeners.get(event) ?? []), handler]); },
    appendEntry(type, data) { this.entries.push([type, data]); },
  };
}

function makeSubEntry(paneId: string, status: SubEntry['status'] = 'running'): SubEntry {
  return {
    taskId: `task-${paneId}`,
    kind: 'task',
    paneId,
    tabId: 't1',
    tabName: 'worker',
    cwd: '/test/cwd',
    description: 'test worker subagent',
    background: true,
    status,
    consumedAt: null,
    sessionFile: null,
    launchCommand: [],
    createdAt: Date.now(),
    revivedFrom: null,
  };
}

async function mountSubagent(opts: { pi: FakePi; client: HerdrClientLike; subs?: SubEntry[] }): Promise<Context> {
  const root = new Context();
  root.provide('pi-herdr.surface', new PiSurface(opts.pi as unknown as object));
  root.provide('pi-herdr.subagent-deps', {
    client: opts.client,
    env: { paneId: 'masterPane', tabId: 't0', workspaceId: 'w0' },
    extPath: '/test/index.ts',
    sessionRoot: root,
    port: emptySubagentPortBox(),
    getSessionId: () => 'sess-1',
    reconcileOnSettlement: () => [],
    withReconcileNotes: (b: string) => b,
    claimSettleNotice: () => true,
    terminalState: { activePaneIds: () => new Set<string>() },
  });
  await root.plugin(subagentPlugin);
  if (opts.subs?.length) {
    for (const h of opts.pi.listeners.get('session_start') ?? []) {
      await h({}, { sessionManager: { getBranch: () => [{ type: 'custom', customType: SUBS_CUSTOM_TYPE, data: { subs: opts.subs } }] } });
    }
  }
  return root;
}

type OutputResult = { content: Array<{ text: string }>; details: Record<string, unknown> };

const agentInfo = (over: Partial<AgentInfo>): AgentInfo => ({
  paneId: 'pWorker', agent: 'pi', status: 'working', session: null, stateLabels: {}, tokens: {}, ...over,
} as AgentInfo);

test('output action: missing and unknown ids fail with actionable messages', async () => {
  const pi = createFakePi();
  const root = await mountSubagent({ pi, client: { available: true, listAgents: async () => [] } as unknown as HerdrClientLike });
  try {
    const execute = pi.tools.get('subagent')!.execute!;
    await assert.rejects(async () => { await execute(null, { action: 'output' }); }, /missing agentId for output/);
    await assert.rejects(async () => { await execute(null, { action: 'output', agentId: 'nope' }); }, /unknown subagent id "nope"/);
  } finally {
    await root.fiber.dispose();
  }
});

test('output action: incremental reads return only the delta since the last call', async () => {
  const pi = createFakePi();
  let output = 'Initial output line 1\nInitial output line 2\n';
  const client = {
    available: true,
    listAgents: async () => [agentInfo({ status: 'working' })],
    readAgent: async () => ({ text: output, revision: 1, truncated: false }),
  } as unknown as HerdrClientLike;
  const root = await mountSubagent({ pi, client, subs: [makeSubEntry('pWorker')] });
  try {
    const execute = pi.tools.get('subagent')!.execute!;
    const first = await execute(null, { action: 'output', agentId: 'pWorker' }) as OutputResult;
    assert.equal(first.content[0]!.text.includes('Initial output line 1'), true);
    output += 'Progress: compiling module B\n';
    const second = await execute(null, { action: 'output', agentId: 'pWorker' }) as OutputResult;
    assert.match(second.content[0]!.text, /Progress: compiling module B/);
    assert.doesNotMatch(second.content[0]!.text, /Initial output line 2/, 'only the delta is returned');
  } finally {
    await root.fiber.dispose();
  }
});

test('output action: older herdr without agent.read still observes through pane.read', async () => {
  const pi = createFakePi();
  let readPaneCalled = false;
  const client = {
    available: true,
    listAgents: async () => [agentInfo({ status: 'working' })],
    readAgent: async () => { throw new Error('unknown method: agent.read'); },
    readPane: async () => {
      readPaneCalled = true;
      return { text: 'fallback text from readPane\n', revision: 0, truncated: false };
    },
  } as unknown as HerdrClientLike;
  const root = await mountSubagent({ pi, client, subs: [makeSubEntry('pWorker')] });
  try {
    const res = await pi.tools.get('subagent')!.execute!(null, { action: 'output', agentId: 'pWorker' }) as OutputResult;
    assert.equal(readPaneCalled, true);
    assert.match(res.content[0]!.text, /fallback text from readPane/);
  } finally {
    await root.fiber.dispose();
  }
});

test('output action: a human gate is reported with its question', async () => {
  const pi = createFakePi();
  const client = {
    available: true,
    listAgents: async () => [agentInfo({ status: 'blocked', tokens: { 'pi-ask': 'Should we delete existing tables?' } })],
    readAgent: async () => ({ text: 'waiting\n', revision: 1, truncated: false }),
  } as unknown as HerdrClientLike;
  const root = await mountSubagent({ pi, client, subs: [makeSubEntry('pWorker')] });
  try {
    const res = await pi.tools.get('subagent')!.execute!(null, { action: 'output', agentId: 'pWorker' }) as OutputResult;
    assert.equal(res.details.status, 'blocked');
    assert.match(res.content[0]!.text, /status: blocked \(question: "Should we delete existing tables\?"\)/);
  } finally {
    await root.fiber.dispose();
  }
});

test('output action: a settled row reports settled even while the pane is idle', async () => {
  const pi = createFakePi();
  const client = {
    available: true,
    listAgents: async () => [agentInfo({ status: 'idle' })],
    readAgent: async () => ({ text: 'Task completed successfully.\n', revision: 4, truncated: false }),
  } as unknown as HerdrClientLike;
  const root = await mountSubagent({ pi, client, subs: [makeSubEntry('pWorker', 'settled')] });
  try {
    const res = await pi.tools.get('subagent')!.execute!(null, { action: 'output', agentId: 'pWorker' }) as OutputResult;
    assert.equal(res.details.status, 'settled');
    assert.match(res.content[0]!.text, /status: settled/);
  } finally {
    await root.fiber.dispose();
  }
});

test('output action: an idle pane showing only its overlay still surfaces the transcript report, once', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pier-out-home-'));
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = home;
  const reportFile = join(home, 'sessions', 'sub-report.jsonl');
  mkdirSync(join(home, 'sessions'), { recursive: true });
  writeSession(reportFile, [{
    type: 'message',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'FINAL REPORT: region enum + converter delivered byte-identical to dev_eu' }],
      timestamp: Date.now(),
      stopReason: 'stop',
    },
  }]);

  const pi = createFakePi();
  const client = {
    available: true,
    listAgents: async () => [agentInfo({ status: 'idle', session: reportFile })],
    readAgent: async () => ({ text: 'todo: 0▶ 0○ 0■ 7✓\n   +3 hidden (7✓) · /todos\n', revision: 0, truncated: false }),
  } as unknown as HerdrClientLike;
  const root = await mountSubagent({ pi, client, subs: [makeSubEntry('pWorker')] });
  try {
    const execute = pi.tools.get('subagent')!.execute!;
    const first = await execute(null, { action: 'output', agentId: 'pWorker', max_chars: 3000 }) as OutputResult;
    assert.equal(first.details.status, 'idle');
    assert.ok((first.details.deltaLength as number) > 0, 'the overlay footer is the pane text');
    assert.equal(first.details.reportDelivered, true);
    assert.match(first.content[0]!.text, /Subagent Report \| latest finalized message from session transcript/);
    assert.match(first.content[0]!.text, /FINAL REPORT: region enum/);

    const second = await execute(null, { action: 'output', agentId: 'pWorker', max_chars: 3000 }) as OutputResult;
    assert.equal(second.details.deltaLength, 0);
    assert.equal(second.details.reportDelivered, false, 'an unchanged report is not re-delivered');
    assert.doesNotMatch(second.content[0]!.text, /Subagent Report/);
  } finally {
    await root.fiber.dispose();
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    rmSync(home, { recursive: true, force: true });
  }
});
