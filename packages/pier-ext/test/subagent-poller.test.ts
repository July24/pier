/** Settlement poller: pure transition planners plus a lean set of loop-level behaviors (settle
 * claim, takeover recovery, blocked gate, vacuum, compaction hold, request refresh) and the scope. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import {
  buildSettlementNoticeText, createPoller, createSessionRoot, disposeSessionRoot, formatObservationTimeoutNotice,
  formatPaneClosedNotice, isSettlementCandidate, mountSubagentScope, planBlockedGate, planObservationTick,
  planTakeoverTick, planVacuumTick, type PollerHost,
} from '../src/subagent-poller.ts';
import type { SubEntry } from '../src/subagent-core.ts';
import { subEntry } from './test-utils.ts';
import type { HerdrAgentState, HerdrClientLike } from '../src/herdr-client.ts';
import type { SubSessionState } from '../src/session-tail.ts';
import type { SessionIo } from '../src/subagent-session.ts';
import type { GitIo } from '../src/subagent-spawn.ts';

/* ── planners ───────────────────────────────────────────────────── */

test('planTakeoverTick: missing agent ignores; the idle edge starts the timer; sustained idle returns control', () => {
  const tick = (over: Partial<Parameters<typeof planTakeoverTick>[0]>) =>
    planTakeoverTick({ currentStatus: 'idle', previousStatus: 'idle', idleStartedAt: 1, now: 2, idleMs: 60_000, ...over });
  assert.equal(tick({ currentStatus: null, previousStatus: 'working' }).kind, 'ignore');
  assert.equal(tick({ previousStatus: 'working', idleStartedAt: null, now: 10 }).kind, 'start-idle');
  assert.equal(tick({ now: 60_002 }).kind, 'return-control');
  assert.deepEqual(tick({ now: 50_000 }), { kind: 'hold', lastAgentStatus: 'idle', clearIdleTimer: false });
  assert.deepEqual(tick({ currentStatus: 'working' }), { kind: 'hold', lastAgentStatus: 'working', clearIdleTimer: true });
});

test('planBlockedGate: the first block notifies, repeats stay silent, any other state clears', () => {
  assert.deepEqual(planBlockedGate('blocked', false), { kind: 'stay-blocked', notify: true });
  assert.deepEqual(planBlockedGate('blocked', true), { kind: 'stay-blocked', notify: false });
  assert.equal(planBlockedGate('idle', true).kind, 'clear-gate');
  assert.equal(planBlockedGate(null, false).kind, 'pass');
});

test('planObservationTick: window opens, machine injects reset it, a human takeover wins', () => {
  const base = { observationStartedAt: 1, now: 10, windowMs: 30_000, machineInjectGraceMs: 60_000 };
  assert.equal(planObservationTick({ ...base, observationStartedAt: null, agentStatus: 'idle', machineInjectAgoMs: 1 }).kind, 'start-observation');
  assert.equal(planObservationTick({ ...base, agentStatus: 'working', machineInjectAgoMs: 61_000 }).kind, 'user-takeover');
  assert.equal(planObservationTick({ ...base, agentStatus: 'working', machineInjectAgoMs: 100 }).kind, 'machine-inject-reset');
  assert.equal(planObservationTick({ ...base, now: 29_000, agentStatus: 'idle', machineInjectAgoMs: 99_000 }).kind, 'wait');
  assert.equal(planObservationTick({ ...base, now: 30_001, agentStatus: 'idle', machineInjectAgoMs: 99_000 }).kind, 'settle');
});

test('planVacuumTick: a null wait state is a heartbeat; a dead pane outranks the timeout', () => {
  assert.deepEqual(planVacuumTick({ waitState: null, paneAlive: true, now: 50, lastActivityAt: 1, timeoutMs: 100 }), { refreshActivity: true, action: 'continue' });
  assert.deepEqual(planVacuumTick({ waitState: 'idle', paneAlive: false, now: 50, lastActivityAt: 1, timeoutMs: 10 }), { refreshActivity: false, action: 'pane-closed' });
  assert.deepEqual(planVacuumTick({ waitState: 'idle', paneAlive: true, now: 50, lastActivityAt: 1, timeoutMs: 10 }), { refreshActivity: false, action: 'timeout' });
});

test('isSettlementCandidate: final text or an ENDED turn without a pending tool', () => {
  assert.equal(isSettlementCandidate({ text: 'ready', pendingTool: false, activity: false }), true);
  assert.equal(isSettlementCandidate({ text: null, pendingTool: false, activity: true, turnEnded: true }), true);
  assert.equal(isSettlementCandidate({ text: null, pendingTool: true, activity: true, turnEnded: true }), false);
  assert.equal(isSettlementCandidate({ text: null, pendingTool: false, activity: false }), false);
  // Between tool calls (toolResult written, next assistant streaming) the turn has NOT ended.
  assert.equal(isSettlementCandidate({ text: null, pendingTool: false, activity: true }), false);
  assert.equal(isSettlementCandidate({ text: null, pendingTool: false, activity: true, turnEnded: false }), false);
});

test('isSettlementCandidate: OCC compaction suppresses settlement even with closing text', () => {
  assert.equal(isSettlementCandidate({ text: null, pendingTool: false, activity: true, turnEnded: true, compacting: true }), false);
  assert.equal(isSettlementCandidate({ text: 'all done', pendingTool: false, activity: true, compacting: true }), false);
  assert.equal(isSettlementCandidate({ text: 'all done', pendingTool: false, activity: true, compacting: false }), true);
});

test('notice formatting: settlement text, pane-closed and observation-timeout wording', () => {
  const withStat = buildSettlementNoticeText('p1 (task)', 'finished all', '1 file changed');
  assert.match(withStat, /Background subagent p1 \(task\) finished/);
  assert.match(withStat, /Its closing message: finished all/);
  assert.match(withStat, /\n1 file changed$/);
  const withoutStat = buildSettlementNoticeText('p1 (task)', null, null);
  assert.match(withoutStat, /It left no closing message\.$/);
  assert.ok(!withoutStat.includes('\n'));

  assert.equal(formatPaneClosedNotice('p1', 'build assets'), 'Background subagent p1 (build assets) stopped before settling (its pane closed).');
  const timeout = formatObservationTimeoutNotice({
    paneId: 'p1', description: 'build assets', idleSeconds: 120, startedAtIso: '2025-01-01T00:00:00.000Z',
  });
  assert.match(timeout, /no progress for 120s \(observed since 2025-01-01T00:00:00\.000Z\)/);
  assert.match(timeout, /Run subagent\(action: "list"\)/);
});

/* ── pane scope ─────────────────────────────────────────────────── */

test('pane scope: disposing one fiber leaves its siblings, disposing the root clears session effects', async () => {
  const log: string[] = [];
  const root = createSessionRoot({ onDispose: () => { log.push('session'); } });
  const a = await mountSubagentScope(root, 'pA', { onDispose: () => { log.push('a'); } });
  const b = await mountSubagentScope(root, 'pB', { onDispose: () => { log.push('b'); } });
  await a.dispose();
  assert.deepEqual(log, ['a']);
  await disposeSessionRoot(root);
  assert.deepEqual([...log].sort(), ['a', 'b', 'session']);
  await b.dispose(); // a second dispose is a no-op
  assert.deepEqual([...log].sort(), ['a', 'b', 'session']);
});

/* ── poll loop ──────────────────────────────────────────────────── */

/** Fixed createdAt keeps the virtual clock (initialTime 13_000) deterministic. */
const makeEntry = (paneId: string, overrides: Partial<SubEntry> = {}): SubEntry => subEntry({
  paneId, tabId: 'tab-1', cwd: '/fake/cwd', description: `task description for ${paneId}`,
  createdAt: 10_000, ...overrides,
});

type HistoryWrite = { entry: SubEntry; patch?: { outcome?: string | null; status?: SubEntry['status']; closedAt?: number }; via?: string };
type Reconcile = { description: string; outcome: 'settled' | 'failed' };

/** Poller host over a virtual clock, with every recorded effect exposed for assertions. */
function fixture(entry: SubEntry | null, initialTime = 13_000) {
  const virtual = { now: initialTime };
  const subs = new Map<string, SubEntry>();
  if (entry) subs.set(entry.paneId, entry);
  const writes: HistoryWrite[] = [];
  const notices: string[] = [];
  const reconciled: Reconcile[] = [];
  const claimKeys: string[] = [];
  /** Registry snapshots taken at each persistSubs — the row a restarting process reads back. */
  const persisted: SubEntry[] = [];
  const panes: string[] = entry ? [entry.paneId] : [];
  let waitState: HerdrAgentState | null = 'idle';
  let agentState: HerdrAgentState = 'idle';
  let state: SubSessionState = { text: 'finished', pendingTool: false, activity: true, turnEnded: true, compacting: false };
  let reattributed: string | null = null;
  let claimResult = true;

  const client = {
    available: true,
    listPanes: async () => panes.map((paneId) => ({ paneId, tabId: 't0', workspaceId: 'w1', agentStatus: 'idle' })),
    listAgents: async () => (entry ? [{ paneId: entry.paneId, status: agentState }] : []),
    waitAgent: async () => waitState,
    getAgentSessionPath: async () => null,
    closePane: async () => undefined,
  } as unknown as HerdrClientLike;

  const session = {
    subSessionState: async () => state,
    readAskFlag: async () => 'Which data source?',
    resolveSessionFile: async () => '/resolved/session.jsonl',
    reattributeStaleSessionFile: async (_paneId: string, _cwd: string, _sinceTs: number, preferred: string | null) => reattributed ?? preferred,
    collectFinalText: async () => null,
    probeAlive: async () => ({ paneExists: true, agentStatus: 'working', lastActivityMs: 1 }),
    readSettleTail: async () => null,
  } as unknown as SessionIo;

  const git = { worktreeStatLine: async () => null } as unknown as GitIo;

  const host: PollerHost = {
    client,
    sessionRoot: new Context(),
    subs,
    persistSubs: () => { for (const row of subs.values()) persisted.push({ ...row }); },
    writeHistory: (e, patch, via) => { writes.push({ entry: { ...e }, patch, via }); },
    blockedGateNotified: new Set<string>(),
    lastMachineInjectAt: new Map<string, number>(),
    session,
    git,
    injectNotice: async (content) => { notices.push(content); },
    reconcileOnSettlement: (description, outcome) => {
      reconciled.push({ description, outcome });
      return [`- Reconciled: ${description}`];
    },
    withReconcileNotes: (base, notes) => (notes.length > 0 ? `${base}\n${notes.join('\n')}` : base),
    claimSettleNotice: (key) => { claimKeys.push(key); return claimResult; },
    sleep: async (ms) => { virtual.now += ms; },
    now: () => virtual.now,
    policy: {
      observationWindowMs: 2_000,
      settlementWindowMs: 4_000,
      subagentTimeoutMs: 10_000,
      pollIntervalMs: 500,
    },
  };

  return {
    host, entry, writes, notices, reconciled, claimKeys, persisted, virtual, panes,
    state: (s: Partial<SubSessionState>) => { state = { ...state, ...s }; },
    waitState: (s: HerdrAgentState | null) => { waitState = s; },
    agentStatus: (s: HerdrAgentState) => { agentState = s; },
    reattribute: (f: string | null) => { reattributed = f; },
    setClaim: (v: boolean) => { claimResult = v; },
  };
}

const start = (f: { host: PollerHost; entry: SubEntry | null }, requestId = 'req-1', injectTs = 10_000) =>
  createPoller(f.host).startPoller(f.entry!.paneId, '/tmp', injectTs, 'desc', requestId);

test('pollLoop: an already-settled row stops the loop without side effects', async () => {
  const f = fixture(makeEntry('p-settled', { status: 'settled' }));
  await start(f);
  assert.equal(f.writes.length, 0);
  assert.equal(f.notices.length, 0);
});

test('pollLoop: settlement consumes the row, appends the stat line and reconciles', async () => {
  const f = fixture(makeEntry('p-settle', { observationStartedAt: 10_000 }));
  f.host.git.worktreeStatLine = async () => '2 files changed, 10 insertions(+)';
  await start(f);
  assert.equal(f.entry!.status, 'consumed');
  assert.equal(f.entry!.sessionFile, '/resolved/session.jsonl');
  assert.deepEqual(f.writes.map((w) => w.via), ['poll-settle']);
  assert.equal(f.writes[0]!.patch?.outcome, 'finished');
  assert.equal(f.reconciled[0]!.outcome, 'settled');
  assert.deepEqual(f.claimKeys, ['p-settle:req-1']);
  assert.match(f.notices[0]!, /Background subagent p-settle \(desc\) finished/);
  assert.match(f.notices[0]!, /2 files changed, 10 insertions\(\+\)/);
  assert.match(f.notices[0]!, /- Reconciled: desc/);
});

test('pollLoop: a lost settle claim suppresses the notice but not the ledger write', async () => {
  const f = fixture(makeEntry('p-dedup', { observationStartedAt: 10_000 }));
  f.setClaim(false);
  await start(f);
  assert.equal(f.entry!.status, 'consumed');
  assert.equal(f.writes.length, 1, 'the ledger row is written even when the notice is dropped');
  assert.equal(f.notices.length, 0);
});

test('pollLoop: a turn that ended without text still settles, worded as no closing message', async () => {
  const f = fixture(makeEntry('p-no-msg', { observationStartedAt: 10_000 }));
  f.state({ text: null, activity: true, turnEnded: true });
  await start(f);
  assert.equal(f.entry!.status, 'consumed');
  assert.equal(f.writes[0]!.patch?.outcome, null);
  assert.match(f.notices[0]!, /It left no closing message\./);
});

test('pollLoop: sustained idle during a user takeover hands control back and settles', async () => {
  const f = fixture(makeEntry('p-takeover', { userTakeover: true, lastAgentStatus: 'idle', observationStartedAt: 1_000 }));
  await start(f);
  assert.equal(f.entry!.userTakeover, false);
  assert.equal(f.entry!.status, 'consumed');
});

test('pollLoop: observation detects user takeover when agent is working after grace period', async () => {
  // Timer already running since 10_000 and no machine inject for far more than the 4_000ms grace:
  // a working pane here is a human at the keyboard, not our own child.
  const f = fixture(makeEntry('p-obs-takeover', { observationStartedAt: 10_000 }), 11_000);
  f.agentStatus('working');
  const sleep = f.host.sleep!;
  let ticks = 0;
  f.host.sleep = async (ms) => { if (++ticks === 1) f.entry!.status = 'settled'; await sleep(ms); };

  await start(f);

  assert.equal(f.entry!.userTakeover, true);
  assert.equal(f.entry!.lastAgentStatus, 'working');
  assert.ok(
    f.persisted.some((row) => row.userTakeover === true && row.lastAgentStatus === 'working'),
    'the takeover must reach the registry, or a restart resumes supervising a human-driven pane',
  );
  assert.equal(f.writes.length, 0, 'a taken-over pane is not settled');
  assert.equal(f.entry!.consumedAt, null);
});

test('pollLoop: observation resets timer on machine-inject-reset', async () => {
  // Machine inject 500ms ago, inside the 4_000ms grace: the child is still working OUR prompt, so
  // the observation window restarts instead of settling or declaring a human takeover.
  const f = fixture(makeEntry('p-obs-reset', { observationStartedAt: 10_000 }), 11_000);
  f.host.lastMachineInjectAt.set('p-obs-reset', 10_500);
  f.agentStatus('working');
  const sleep = f.host.sleep!;
  let ticks = 0;
  f.host.sleep = async (ms) => { if (++ticks === 1) f.entry!.status = 'settled'; await sleep(ms); };

  await start(f);

  assert.equal(f.entry!.userTakeover, undefined, 'our own work is not a human takeover');
  assert.equal(f.entry!.observationStartedAt, 11_000, 'the window restarts from now');
  assert.ok(
    f.persisted.some((row) => row.observationStartedAt === 11_000),
    'the restarted window must be persisted, or a restart replays the pre-inject deadline',
  );
  assert.equal(f.writes.length, 0, 'a fresh machine inject must not settle the row');
});

test('pollLoop: the blocked gate notifies once with the human question, then clears', async () => {
  const f = fixture(makeEntry('p-gate'));
  let waits = 0;
  f.host.client.waitAgent = async () => (waits++ === 0 ? 'blocked' : 'idle');
  await start(f);
  const blocked = f.notices.filter((n) => n.includes('BLOCKED'));
  assert.equal(blocked.length, 1, 'one notice per gate, not one per tick');
  assert.match(blocked[0]!, /question: "Which data source\?"/);
  assert.equal(f.entry!.status, 'consumed', 'the loop resumes after the gate clears');
});

test('pollLoop: a pane that stays blocked is re-polled at the poll interval, not in a hot loop', async () => {
  const f = fixture(makeEntry('p-blocked-long'));
  let waits = 0;
  // herdr answers at once for a pane already in a wanted state; the virtual clock does not move.
  f.host.client.waitAgent = async () => {
    if (++waits >= 5) f.entry!.status = 'settled';
    return 'blocked';
  };
  const slept: number[] = [];
  const sleep = f.host.sleep!;
  f.host.sleep = async (ms) => { slept.push(ms); await sleep(ms); };
  await start(f);
  assert.equal(waits, 5);
  assert.deepEqual(slept, [500, 500, 500, 500, 500], 'every blocked tick waits out the 500ms interval');
});

test('pollLoop: an idle pane that is not yet settleable is paced too', async () => {
  const f = fixture(makeEntry('p-idle-busy'));
  f.state({ text: null, pendingTool: false, activity: false, turnEnded: false });
  let waits = 0;
  f.host.client.waitAgent = async () => {
    if (++waits >= 4) f.entry!.status = 'settled';
    return 'idle';
  };
  const slept: number[] = [];
  const sleep = f.host.sleep!;
  f.host.sleep = async (ms) => { slept.push(ms); await sleep(ms); };
  await start(f);
  assert.deepEqual(slept, [500, 500, 500, 500]);
});

test('pollLoop: a slow wait already spent the interval, so no extra sleep follows', async () => {
  const f = fixture(makeEntry('p-slow-wait'));
  f.state({ text: null, pendingTool: false, activity: false, turnEnded: false });
  let waits = 0;
  f.host.client.waitAgent = async () => {
    f.virtual.now += 500;
    if (++waits >= 3) f.entry!.status = 'settled';
    return null;
  };
  const slept: number[] = [];
  const sleep = f.host.sleep!;
  f.host.sleep = async (ms) => { slept.push(ms); await sleep(ms); };
  await start(f);
  assert.deepEqual(slept, []);
});

test('pollLoop: a vanished pane consumes the row as failed without waiting for the timeout', async () => {
  const f = fixture(makeEntry('p-gone'));
  f.panes.length = 0;
  f.waitState('working');
  await start(f);
  assert.equal(f.entry!.status, 'consumed');
  assert.deepEqual(f.writes.map((w) => w.via), ['poll-pane-closed']);
  assert.equal(f.writes[0]!.patch?.outcome, 'pane closed before settling');
  assert.equal(f.reconciled[0]!.outcome, 'failed');
  assert.match(f.notices[0]!, /stopped before settling \(its pane closed\)/);
});

test('pollLoop: no progress past the timeout window consumes the row as a timeout', async () => {
  const f = fixture(makeEntry('p-timeout'));
  f.state({ text: null, pendingTool: true, activity: false });
  f.host.client.waitAgent = async () => { f.virtual.now += 15_000; return 'idle'; };
  await start(f);
  assert.equal(f.entry!.status, 'consumed');
  assert.deepEqual(f.writes.map((w) => w.via), ['poll-timeout']);
  assert.match(f.notices[0]!, /has shown no progress for/);
});

test('pollLoop: OCC compaction defers settlement until the continuation text lands', async () => {
  const f = fixture(makeEntry('p-occ'));
  let reads = 0;
  f.host.session.subSessionState = async () => {
    reads += 1;
    return reads <= 2
      ? { text: null, pendingTool: false, activity: true, turnEnded: true, compacting: true }
      : { text: 'all tests pass, committed on bugfix branch', pendingTool: false, activity: true, turnEnded: true, compacting: false };
  };
  const sleep = f.host.sleep!;
  f.host.sleep = async (ms) => { await sleep(ms); f.virtual.now += 2_500; };
  await start(f, 'req-occ');
  assert.equal(f.entry!.status, 'consumed');
  assert.equal(f.writes.length, 1, 'the aborted-turn shape must not settle early');
  assert.equal(f.writes[0]!.patch?.outcome, 'all tests pass, committed on bugfix branch');
  assert.match(f.notices[0]!, /Its closing message: all tests pass, committed on bugfix branch/);
});

test('pollLoop: compaction keeps the vacuum timer fed instead of reporting an observation timeout', async () => {
  const f = fixture(makeEntry('p-occ-vac'));
  f.host.session.subSessionState = async () => ({ text: null, pendingTool: false, activity: true, turnEnded: true, compacting: true });
  let waits = 0;
  f.host.client.waitAgent = async () => {
    f.virtual.now += 4_000;
    if (++waits >= 5) f.entry!.status = 'settled'; // end supervision without consuming
    return 'idle';
  };
  await start(f);
  assert.equal(f.entry!.status, 'settled');
  assert.equal(f.writes.length, 0);
  assert.equal(f.notices.length, 0);
});

test('pollLoop: a stale sessionFile is re-attributed before settlement judgment', async () => {
  const f = fixture(makeEntry('p-stale', { observationStartedAt: 10_000, sessionFile: '/stale/last-week.jsonl' }));
  f.reattribute('/fresh/real-session.jsonl');
  f.state({ text: 'FINAL REPORT delivered from the real session', activity: true, turnEnded: true });
  await start(f);
  assert.equal(f.entry!.sessionFile, '/fresh/real-session.jsonl');
  assert.equal(f.writes[0]!.patch?.outcome, 'FINAL REPORT delivered from the real session');
});

test('pollLoop: an existing sessionFile is never re-resolved through the mtime fallback', async () => {
  const f = fixture(makeEntry('p-has-sess', { observationStartedAt: 10_000, sessionFile: '/existing/session.jsonl' }));
  let resolveCalled = false;
  f.host.session.resolveSessionFile = async () => { resolveCalled = true; return '/should/not/overwrite.jsonl'; };
  await start(f);
  assert.equal(resolveCalled, false);
  assert.equal(f.entry!.sessionFile, '/existing/session.jsonl');
});

test('startPoller: a follow_up refreshes the tracked request while the loop is running', async () => {
  const f = fixture(makeEntry('p-refresh'));
  const sinceTs: number[] = [];
  f.host.session.subSessionState = async (_paneId: string, _cwd: string, ts: number) => {
    sinceTs.push(ts);
    return { text: 'finished', pendingTool: false, activity: true, turnEnded: true, compacting: false };
  };
  const firstWait = Promise.withResolvers<void>();
  let waits = 0;
  f.host.client.waitAgent = async () => {
    if (waits++ === 0) await firstWait.promise;
    return 'idle';
  };
  const poller = createPoller(f.host);
  const loop = poller.startPoller('p-refresh', '/tmp', 1_000, 'desc', 'req-1');
  await poller.startPoller('p-refresh', '/tmp', 5_000, 'desc', 'req-2');
  firstWait.resolve();
  await loop;
  assert.ok(sinceTs.includes(5_000), `the loop must judge against the newest request, saw ${sinceTs.join(',')}`);
  assert.deepEqual(f.claimKeys, ['p-refresh:req-2']);
  assert.deepEqual([...poller.pollers], [], 'the pane leaves the poller set when the loop ends');
});

test('startPoller: a second call for an active pane does not start a second loop', async () => {
  const f = fixture(makeEntry('p-dup', { observationStartedAt: 10_000 }));
  const firstWait = Promise.withResolvers<void>();
  let waits = 0;
  f.host.client.waitAgent = async () => {
    if (waits++ === 0) await firstWait.promise;
    return 'idle';
  };
  const poller = createPoller(f.host);
  const loop = poller.startPoller('p-dup', '/tmp', 1_000, 'desc', 'req-1');
  await poller.startPoller('p-dup', '/tmp', 1_000, 'desc', 'req-1');
  assert.deepEqual([...poller.pollers], ['p-dup']);
  firstWait.resolve();
  await loop;
  assert.equal(f.writes.length, 1, 'exactly one settlement');
});
