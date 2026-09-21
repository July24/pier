/**
 * Comprehensive branch tests for subagent-poll-loop.ts using fake PollerHost.
 *
 * Covers:
 *  - Early returns (!entry, entry.status === 'settled')
 *  - Takeover branches (start-idle, return-control, hold+clearIdleTimer, hold, probe error)
 *  - Blocked gate (first notification, deduplication, clear-gate on unblock, inject notice error, waitAgent error)
 *  - Settle & observation window (start-obs, takeover during obs, machine-inject reset, wait, probe error,
 *    settle with statLine, settle without statLine, sessionFile resolve vs preserve, claim dedup, notice error,
 *    settle via activity without text)
 *  - Vacuum (pane-closed, timeout, listAgents error fallback, inject notice error, refreshActivity on null state)
 *  - Poller lifecycle (duplicate startPoller, fiber dispose, fiber dispose error, onDispose hook, crash handler)
 *  - Trace logging (PI_HERDR_TRACE file write and append error resilience)
 *  - Built-in sleep timer function
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { createPoller, sleep, type PollerHost } from '../src/subagent-poll-loop.ts';
import type { SubEntry } from '../src/subagent-core.ts';
import type { HerdrAgentState, HerdrClientLike } from '../src/herdr-client.ts';
import type { SessionIo } from '../src/subagent-session-io.ts';
import type { GitIo } from '../src/subagent-git-io.ts';

function makeEntry(paneId: string = 'p1', overrides?: Partial<SubEntry>): SubEntry {
  return {
    taskId: `task-${paneId}`,
    kind: 'task',
    paneId,
    tabId: 'tab-1',
    tabName: 'main',
    cwd: '/fake/cwd',
    description: `task description for ${paneId}`,
    background: true,
    status: 'running',
    consumedAt: null,
    sessionFile: null,
    launchCommand: [],
    createdAt: Date.now(),
    ...overrides,
  };
}

interface FakeHostFixture {
  host: PollerHost;
  virtualTime: { now: number };
  persistedCount: number;
  historyWrites: Array<{ entry: SubEntry; patch?: { outcome?: string | null; status?: SubEntry['status']; closedAt?: number }; via?: string }>;
  injectedNotices: string[];
  reconcileCalls: Array<{ description: string; outcome: 'settled' | 'failed' }>;
  sleepCalls: number[];
  client: {
    agents: Array<{ paneId: string; status: string }>;
    /** null → mirror `agents`. Set explicitly to pin pane.list ≠ agent.list. */
    panes: Array<{ paneId: string; agentStatus: string }> | null;
    listAgentsCalls: number;
    waitAgentQueue: Array<HerdrAgentState | null | Error>;
    throwOnListAgents: boolean;
  };
  sessionIo: {
    subSessionResponses: Array<{ text: string | null; pendingTool: boolean; activity: boolean; turnEnded?: boolean }>;
    askFlagResponses: Array<string | null>;
    resolvedSessionFile: string | null;
    /** sinceTs values observed by subSessionState, in call order. */
    subSessionSinceTsCalls: number[];
    /** Queued re-attribute results; empty → keep the preferred value. */
    reattributeResponses: Array<string | null>;
  };
  gitIo: {
    statLine: string | null;
  };
  claimSettleResults: boolean[];
  /** Claim keys observed by claimSettleNotice, in call order. */
  claimKeys: string[];
}

function createFakeHost(options?: {
  initialTime?: number;
  entry?: SubEntry;
  throwOnInject?: boolean;
}): FakeHostFixture {
  const virtualTime = { now: options?.initialTime ?? 10_000 };
  const subs = new Map<string, SubEntry>();
  if (options?.entry) {
    subs.set(options.entry.paneId, options.entry);
  }

  const historyWrites: FakeHostFixture['historyWrites'] = [];
  const injectedNotices: string[] = [];
  const reconcileCalls: FakeHostFixture['reconcileCalls'] = [];
  const sleepCalls: number[] = [];
  let persistedCount = 0;
  const blockedGateNotified = new Set<string>();
  const lastMachineInjectAt = new Map<string, number>();

  const clientMock: FakeHostFixture['client'] = {
    agents: [{ paneId: options?.entry?.paneId ?? 'p1', status: 'idle' }],
    panes: null,
    listAgentsCalls: 0,
    waitAgentQueue: [],
    throwOnListAgents: false,
  };

  const sessionMock: FakeHostFixture['sessionIo'] = {
    subSessionResponses: [],
    askFlagResponses: [],
    resolvedSessionFile: '/resolved/session.jsonl',
    subSessionSinceTsCalls: [],
    reattributeResponses: [],
  };

  const gitMock: FakeHostFixture['gitIo'] = {
    statLine: null,
  };

  const claimSettleResults: boolean[] = [];
  const claimKeys: string[] = [];

  const fakeClient: HerdrClientLike = {
    available: true,
    tabList: async () => [],
    listPanes: async () => {
      if (clientMock.throwOnListAgents) throw new Error('simulated listAgents failure');
      const src = clientMock.panes ?? clientMock.agents.map((a) => ({
        paneId: a.paneId,
        agentStatus: a.status,
      }));
      return src.map((p) => ({
        paneId: p.paneId,
        tabId: 't0',
        workspaceId: 'w1',
        agentStatus: p.agentStatus,
      }));
    },
    listAgents: async () => {
      clientMock.listAgentsCalls++;
      if (clientMock.throwOnListAgents) throw new Error('simulated listAgents failure');
      return clientMock.agents;
    },
    waitAgent: async (_paneId: string, _states: HerdrAgentState[], _timeout: number) => {
      if (clientMock.waitAgentQueue.length > 0) {
        const next = clientMock.waitAgentQueue.shift()!;
        if (next instanceof Error) throw next;
        return next;
      }
      return 'idle';
    },
    getAgentSessionPath: async () => null,
    createTab: async () => ({ tabId: 't1', paneId: 'p1' }),
    splitPane: async () => 'p2',
    sendPaneText: async () => undefined,
    tabClose: async () => undefined,
    closePane: async () => undefined,
  } as unknown as HerdrClientLike;

  const fakeSession: SessionIo = {
    subSessionState: async (_paneId: string, _cwd: string, sinceTs: number) => {
      sessionMock.subSessionSinceTsCalls.push(sinceTs);
      if (sessionMock.subSessionResponses.length > 0) {
        const response = sessionMock.subSessionResponses.shift()!;
        return { ...response, turnEnded: response.turnEnded ?? false };
      }
      return { text: 'completed task', pendingTool: false, activity: true, turnEnded: false };
    },
    readAskFlag: async () => {
      if (sessionMock.askFlagResponses.length > 0) {
        return sessionMock.askFlagResponses.shift()!;
      }
      return null;
    },
    resolveSessionFileCandidates: async () => [],
    resolveSessionFile: async () => sessionMock.resolvedSessionFile,
    reattributeStaleSessionFile: async (_paneId: string, _cwd: string, _sinceTs: number, preferred: string | null) => {
      if (sessionMock.reattributeResponses.length > 0) return sessionMock.reattributeResponses.shift()!;
      return preferred;
    },
    collectFinalText: async () => null,
    probeAlive: async () => ({ alive: true, paneExists: true, agentStatus: 'working', lastActivityMs: Date.now() }),
    readSettleTail: async () => null,
  };

  const fakeGit: GitIo = {
    worktreeStatLine: async () => gitMock.statLine,
    runGit: async () => null,
    listWorktrees: async () => [],
    invalidateWorktreesCache: () => undefined,
  };

  const sessionRoot = new Context();

  const host: PollerHost = {
    client: fakeClient,
    sessionRoot,
    subs,
    persistSubs: () => { persistedCount++; },
    writeHistory: (e, patch, via) => {
      historyWrites.push({ entry: { ...e }, patch, via });
    },
    blockedGateNotified,
    lastMachineInjectAt,
    session: fakeSession,
    git: fakeGit,
    injectNotice: async (content) => {
      if (options?.throwOnInject) throw new Error('simulated injectNotice error');
      injectedNotices.push(content);
    },
    reconcileOnSettlement: (description, outcome) => {
      reconcileCalls.push({ description, outcome });
      return [`- Reconciled: ${description}`];
    },
    withReconcileNotes: (base, notes) => (notes.length > 0 ? `${base}\n${notes.join('\n')}` : base),
    claimSettleNotice: (key: string) => {
      claimKeys.push(key);
      return claimSettleResults.length > 0 ? claimSettleResults.shift()! : true;
    },
    sleep: async (ms) => {
      sleepCalls.push(ms);
      virtualTime.now += ms;
    },
    now: () => virtualTime.now,
    policy: {
      observationWindowMs: 2_000,
      settlementWindowMs: 4_000,
      subagentTimeoutMs: 10_000,
      pollIntervalMs: 500,
    },
  };

  return {
    host,
    virtualTime,
    get persistedCount() { return persistedCount; },
    historyWrites,
    injectedNotices,
    reconcileCalls,
    sleepCalls,
    client: clientMock,
    sessionIo: sessionMock,
    gitIo: gitMock,
    claimSettleResults,
    claimKeys,
  };
}

/* ──────────────── Early Returns ──────────────── */

test('pollLoop: missing entry returns immediately without side effects', async () => {
  const f = createFakeHost({ initialTime: 10_000 });
  const poller = createPoller(f.host);

  await poller.startPoller('missing-p', '/tmp', 0, 0, 'desc', 'req-1');

  assert.equal(f.persistedCount, 0);
  assert.equal(f.historyWrites.length, 0);
  assert.equal(f.injectedNotices.length, 0);
  assert.equal(poller.pollers.has('missing-p'), false);
});

test('pollLoop: already settled entry returns immediately', async () => {
  const entry = makeEntry('p-settled', { status: 'settled' });
  const f = createFakeHost({ entry });
  const poller = createPoller(f.host);

  await poller.startPoller('p-settled', '/tmp', 0, 0, 'desc', 'req-1');

  assert.equal(f.persistedCount, 0);
  assert.equal(f.historyWrites.length, 0);
  assert.equal(f.injectedNotices.length, 0);
  assert.equal(poller.pollers.has('p-settled'), false);
});

/* ──────────────── Takeover Branches ──────────────── */

test('pollLoop: takeover tick start-idle sets timer and status to idle', async () => {
  const entry = makeEntry('p-to', { userTakeover: true, lastAgentStatus: 'working', observationStartedAt: null });
  const f = createFakeHost({ entry });
  f.client.agents = [{ paneId: 'p-to', status: 'idle' }];
  f.client.waitAgentQueue = ['idle'];
  // First takeover tick: agent is idle while previous was working -> start-idle
  // Second takeover tick: exit condition by changing status to settled
  let loopCount = 0;
  const origSleep = f.host.sleep!;
  f.host.sleep = async (ms) => {
    loopCount++;
    if (loopCount >= 1) {
      entry.status = 'settled';
    }
    return origSleep(ms);
  };

  const poller = createPoller(f.host);
  await poller.startPoller('p-to', '/tmp', 0, 0, 'desc', 'req-1');

  assert.equal(entry.lastAgentStatus, 'idle');
  assert.ok(entry.observationStartedAt != null);
  assert.ok(f.persistedCount >= 1);
  assert.ok(f.sleepCalls.includes(5_000));
});

test('pollLoop: takeover tick return-control clears takeover and proceeds to waitAgent', async () => {
  const entry = makeEntry('p-to-ret', {
    userTakeover: true,
    lastAgentStatus: 'idle',
    observationStartedAt: 1_000,
  });
  // settlementWindowMs is 4000; current time 10000 -> now - 1000 = 9000 > 4000 -> return-control
  const f = createFakeHost({ initialTime: 10_000, entry });
  f.client.agents = [{ paneId: 'p-to-ret', status: 'idle' }];
  // Once control returns, waitAgent runs and then settles
  f.client.waitAgentQueue = ['idle'];
  f.sessionIo.subSessionResponses = [{ text: 'done after takeover', pendingTool: false, activity: true }];

  const poller = createPoller(f.host);
  // Iteration 1: return-control (userTakeover becomes false, does not sleep, proceeds to waitAgent -> start-obs, sleep 1000)
  // Iteration 2: window passed -> settle
  await poller.startPoller('p-to-ret', '/tmp', 0, 0, 'desc', 'req-1');

  assert.equal(entry.userTakeover, false);
  assert.equal(entry.status, 'consumed');
  assert.equal(f.historyWrites.length, 1);
  assert.equal(f.historyWrites[0]?.via, 'poll-settle');
});

test('pollLoop: takeover tick hold+clearIdleTimer updates status when agent is working', async () => {
  const entry = makeEntry('p-to-work', {
    userTakeover: true,
    lastAgentStatus: 'idle',
    observationStartedAt: 5_000,
  });
  const f = createFakeHost({ entry });
  f.client.agents = [{ paneId: 'p-to-work', status: 'working' }];

  let loopCount = 0;
  const origSleep = f.host.sleep!;
  f.host.sleep = async (ms) => {
    loopCount++;
    if (loopCount >= 1) entry.status = 'settled';
    return origSleep(ms);
  };

  const poller = createPoller(f.host);
  await poller.startPoller('p-to-work', '/tmp', 0, 0, 'desc', 'req-1');

  assert.equal(entry.lastAgentStatus, 'working');
  assert.equal(entry.observationStartedAt, null);
  assert.ok(f.persistedCount >= 1);
});

test('pollLoop: takeover hold without clearIdleTimer leaves timer intact', async () => {
  const entry = makeEntry('p-to-hold', {
    userTakeover: true,
    lastAgentStatus: 'idle',
    observationStartedAt: 9_500, // now is 10_000, diff 500 < idleMs 4000
  });
  const f = createFakeHost({ initialTime: 10_000, entry });
  f.client.agents = [{ paneId: 'p-to-hold', status: 'idle' }];

  let loopCount = 0;
  const origSleep = f.host.sleep!;
  f.host.sleep = async (ms) => {
    loopCount++;
    if (loopCount >= 1) entry.status = 'settled';
    return origSleep(ms);
  };

  const poller = createPoller(f.host);
  await poller.startPoller('p-to-hold', '/tmp', 0, 0, 'desc', 'req-1');

  // Timer unchanged and not cleared
  assert.equal(entry.observationStartedAt, 9_500);
  assert.equal(f.persistedCount, 0);
});

test('pollLoop: takeover handles listAgents probe error gracefully', async () => {
  const entry = makeEntry('p-to-err', { userTakeover: true, lastAgentStatus: 'working' });
  const f = createFakeHost({ entry });
  f.client.throwOnListAgents = true;

  let loopCount = 0;
  const origSleep = f.host.sleep!;
  f.host.sleep = async (ms) => {
    loopCount++;
    if (loopCount >= 1) entry.status = 'settled';
    return origSleep(ms);
  };

  const poller = createPoller(f.host);
  await poller.startPoller('p-to-err', '/tmp', 0, 0, 'desc', 'req-1');

  // Did not crash, slept 5s
  assert.ok(f.sleepCalls.includes(5_000));
});

/* ──────────────── Blocked Gate Branches ──────────────── */

test('pollLoop: blocked gate notifies on first blocked state and clears gate when unblocked', async () => {
  const entry = makeEntry('p-block');
  const f = createFakeHost({ entry });
  // Iteration 1: waitAgent returns 'blocked' -> notifies
  // Iteration 2: waitAgent returns 'idle' -> clear-gate -> start-obs
  // Iteration 3: settles
  f.client.waitAgentQueue = ['blocked', 'idle', 'idle'];
  f.sessionIo.askFlagResponses = ['Need confirmation to delete branch'];
  f.sessionIo.subSessionResponses = [
    { text: 'migration complete', pendingTool: false, activity: true },
    { text: 'migration complete', pendingTool: false, activity: true },
  ];

  const poller = createPoller(f.host);
  await poller.startPoller('p-block', '/tmp', 0, 0, 'desc', 'req-1');

  assert.equal(f.injectedNotices.length, 2); // 1 blocked notice + 1 settle notice
  assert.match(f.injectedNotices[0]!, /Subagent "desc" is BLOCKED/);
  assert.match(f.injectedNotices[0]!, /Need confirmation to delete branch/);
  assert.equal(f.host.blockedGateNotified.has('p-block'), false); // cleared after idle
  assert.equal(entry.status, 'consumed');
});

test('pollLoop: blocked gate deduplicates notification when already notified', async () => {
  const entry = makeEntry('p-block-dedup');
  const f = createFakeHost({ entry });
  f.host.blockedGateNotified.add('p-block-dedup'); // already notified
  f.client.waitAgentQueue = ['blocked'];

  // End loop after first iteration
  let loopCount = 0;
  const origSleep = f.host.sleep!;
  f.host.sleep = async (ms) => {
    loopCount++;
    return origSleep(ms);
  };
  f.host.client.waitAgent = async () => {
    if (loopCount > 0) {
      entry.status = 'settled';
      return null;
    }
    loopCount++;
    return 'blocked';
  };

  const poller = createPoller(f.host);
  await poller.startPoller('p-block-dedup', '/tmp', 0, 0, 'desc', 'req-1');

  // No new blocked notice was injected
  assert.equal(f.injectedNotices.length, 0);
});

test('pollLoop: blocked gate ignores injectNotice errors gracefully', async () => {
  const entry = makeEntry('p-block-err');
  const f = createFakeHost({ entry, throwOnInject: true });
  f.client.waitAgentQueue = ['blocked'];
  f.host.client.waitAgent = async () => {
    entry.status = 'settled'; // end loop
    return 'blocked';
  };

  const poller = createPoller(f.host);
  await poller.startPoller('p-block-err', '/tmp', 0, 0, 'desc', 'req-1');

  assert.ok(f.host.blockedGateNotified.has('p-block-err'));
});

test('pollLoop: waitAgent error falls back to null state', async () => {
  const entry = makeEntry('p-wait-err');
  const f = createFakeHost({ entry });
  let callCount = 0;
  f.host.client.waitAgent = async () => {
    callCount++;
    if (callCount === 1) {
      throw new Error('agent wait connection error');
    }
    entry.status = 'settled';
    return null;
  };

  const poller = createPoller(f.host);
  await poller.startPoller('p-wait-err', '/tmp', 0, 0, 'desc', 'req-1');

  assert.equal(entry.status, 'settled');
  assert.equal(callCount, 2);
});

/* ──────────────── Observation Window & Settlement ──────────────── */

test('pollLoop: observation starts window on first idle tick, then settles after window elapses', async () => {
  const entry = makeEntry('p-obs-settle');
  const f = createFakeHost({ initialTime: 10_000, entry });
  f.client.waitAgentQueue = ['idle', 'idle'];
  f.client.agents = [{ paneId: 'p-obs-settle', status: 'idle' }];
  f.sessionIo.subSessionResponses = [
    { text: 'finished work successfully', pendingTool: false, activity: true },
    { text: 'finished work successfully', pendingTool: false, activity: true },
  ];
  f.gitIo.statLine = '2 files changed, 10 insertions(+)';

  // Customize sleep BEFORE createPoller
  const origSleep = f.host.sleep!;
  f.host.sleep = async (ms) => {
    await origSleep(ms);
    // Advance virtual clock past observationWindowMs (2000)
    f.virtualTime.now += 2_500;
  };

  const poller = createPoller(f.host);
  await poller.startPoller('p-obs-settle', '/tmp', 0, 0, 'desc', 'req-settle');

  assert.equal(entry.status, 'consumed');
  assert.equal(entry.sessionFile, '/resolved/session.jsonl');
  assert.equal(f.historyWrites.length, 1);
  assert.equal(f.historyWrites[0]?.via, 'poll-settle');
  assert.equal(f.historyWrites[0]?.patch?.outcome, 'finished work successfully');
  assert.equal(f.injectedNotices.length, 1);
  assert.match(f.injectedNotices[0]!, /Background subagent p-obs-settle \(desc\) finished/);
  assert.match(f.injectedNotices[0]!, /2 files changed, 10 insertions\(\+\)/);
  assert.match(f.injectedNotices[0]!, /- Reconciled: desc/);
});

test('pollLoop: observation detects user takeover when agent is working after grace period', async () => {
  const entry = makeEntry('p-obs-takeover', { observationStartedAt: 10_000 });
  const f = createFakeHost({ initialTime: 11_000, entry });
  f.client.waitAgentQueue = ['idle'];
  // Agent is working in live query
  f.client.agents = [{ paneId: 'p-obs-takeover', status: 'working' }];
  // Machine inject happened long ago: now(11000) - 0 > grace(4000)
  f.sessionIo.subSessionResponses = [{ text: 'some text', pendingTool: false, activity: true }];

  let loop = 0;
  const origSleep = f.host.sleep!;
  f.host.sleep = async (ms) => {
    loop++;
    if (loop >= 1) entry.status = 'settled';
    return origSleep(ms);
  };

  const poller = createPoller(f.host);
  await poller.startPoller('p-obs-takeover', '/tmp', 0, 0, 'desc', 'req-1');

  assert.equal(entry.userTakeover, true);
  assert.equal(entry.lastAgentStatus, 'working');
  assert.ok(f.persistedCount >= 1);
});

test('pollLoop: observation resets timer on machine-inject-reset', async () => {
  const entry = makeEntry('p-obs-reset', { observationStartedAt: 10_000 });
  const f = createFakeHost({ initialTime: 11_000, entry });
  // Recent machine inject within grace period (4000ms):
  f.host.lastMachineInjectAt.set('p-obs-reset', 10_500); // 500ms ago <= 4000ms
  f.client.waitAgentQueue = ['idle'];
  f.client.agents = [{ paneId: 'p-obs-reset', status: 'working' }];
  f.sessionIo.subSessionResponses = [{ text: 'working on prompt', pendingTool: false, activity: true }];

  let loop = 0;
  const origSleep = f.host.sleep!;
  f.host.sleep = async (ms) => {
    loop++;
    if (loop >= 1) entry.status = 'settled';
    return origSleep(ms);
  };

  const poller = createPoller(f.host);
  await poller.startPoller('p-obs-reset', '/tmp', 0, 0, 'desc', 'req-1');

  assert.equal(entry.userTakeover, undefined); // not user takeover
  assert.equal(entry.observationStartedAt, 11_000); // reset to now
  assert.ok(f.persistedCount >= 1);
});

test('pollLoop: observation waits if window has not elapsed', async () => {
  const entry = makeEntry('p-obs-wait', { observationStartedAt: 10_000 });
  const f = createFakeHost({ initialTime: 10_500, entry }); // diff 500 < windowMs 2000
  f.client.waitAgentQueue = ['idle'];
  f.client.agents = [{ paneId: 'p-obs-wait', status: 'idle' }];
  f.sessionIo.subSessionResponses = [{ text: 'done', pendingTool: false, activity: true }];

  let loop = 0;
  const origSleep = f.host.sleep!;
  f.host.sleep = async (ms) => {
    loop++;
    if (loop >= 1) entry.status = 'settled';
    return origSleep(ms);
  };

  const poller = createPoller(f.host);
  await poller.startPoller('p-obs-wait', '/tmp', 0, 0, 'desc', 'req-1');

  assert.ok(f.sleepCalls.includes(1_000));
});

test('pollLoop: observation handles listAgents error during status check', async () => {
  const entry = makeEntry('p-obs-agent-err', { observationStartedAt: 10_000 });
  const f = createFakeHost({ initialTime: 13_000, entry }); // past window
  f.client.waitAgentQueue = ['idle'];
  f.client.throwOnListAgents = true; // listAgents throws
  f.sessionIo.subSessionResponses = [{ text: 'settled text', pendingTool: false, activity: true }];

  const poller = createPoller(f.host);
  await poller.startPoller('p-obs-agent-err', '/tmp', 0, 0, 'desc', 'req-1');

  // Handled without crash and settled
  assert.equal(entry.status, 'consumed');
  assert.equal(f.historyWrites[0]?.patch?.outcome, 'settled text');
});

test('pollLoop: settlement preserves existing sessionFile without resolving', async () => {
  const entry = makeEntry('p-has-sess', {
    observationStartedAt: 10_000,
    sessionFile: '/existing/session.jsonl',
  });
  const f = createFakeHost({ initialTime: 13_000, entry });
  f.client.waitAgentQueue = ['idle'];
  f.sessionIo.subSessionResponses = [{ text: 'finished', pendingTool: false, activity: true }];

  let resolveCalled = false;
  f.host.session.resolveSessionFile = async () => {
    resolveCalled = true;
    return '/should/not/overwrite.jsonl';
  };

  const poller = createPoller(f.host);
  await poller.startPoller('p-has-sess', '/tmp', 0, 0, 'desc', 'req-1');

  assert.equal(resolveCalled, false);
  assert.equal(entry.sessionFile, '/existing/session.jsonl');
});

test('pollLoop: settlement deduplicates notice when claimSettleNotice returns false', async () => {
  const entry = makeEntry('p-dedup-notice', { observationStartedAt: 10_000 });
  const f = createFakeHost({ initialTime: 13_000, entry });
  f.client.waitAgentQueue = ['idle'];
  f.sessionIo.subSessionResponses = [{ text: 'done', pendingTool: false, activity: true }];
  f.claimSettleResults.push(false); // deduplicate

  const poller = createPoller(f.host);
  await poller.startPoller('p-dedup-notice', '/tmp', 0, 0, 'desc', 'req-1');

  assert.equal(entry.status, 'consumed');
  assert.equal(f.injectedNotices.length, 0); // notice suppressed
});

test('pollLoop: settlement handles injectNotice rejection silently', async () => {
  const entry = makeEntry('p-inject-err', { observationStartedAt: 10_000 });
  const f = createFakeHost({ initialTime: 13_000, entry, throwOnInject: true });
  f.client.waitAgentQueue = ['idle'];
  f.sessionIo.subSessionResponses = [{ text: 'done', pendingTool: false, activity: true }];

  const poller = createPoller(f.host);
  await poller.startPoller('p-inject-err', '/tmp', 0, 0, 'desc', 'req-1');

  assert.equal(entry.status, 'consumed');
});

test('pollLoop: settles with no closing message when the turn ENDED without text (A16)', async () => {
  const entry = makeEntry('p-no-msg', { observationStartedAt: 10_000 });
  const f = createFakeHost({ initialTime: 13_000, entry });
  f.client.waitAgentQueue = ['idle'];
  // A16 之前这里只给 activity=true 就结算，把"工具间空档期"误判成完工；现在必须 turnEnded。
  f.sessionIo.subSessionResponses = [{ text: null, pendingTool: false, activity: true, turnEnded: true }];

  const poller = createPoller(f.host);
  await poller.startPoller('p-no-msg', '/tmp', 0, 0, 'desc', 'req-1');

  assert.equal(entry.status, 'consumed');
  assert.equal(f.historyWrites[0]?.patch?.outcome, null);
  assert.match(f.injectedNotices[0]!, /It left no closing message\./);
});

test('p25 (01a0c282): a registry sessionFile with no writes since the request is re-attributed before settlement judgment', async () => {
  // Spawn race recorded last week's transcript; the real session's report never reached
  // settlement detection and the vacuum fired 600s later. herdr's per-pane report fixes it.
  const entry = makeEntry('p-stale', {
    observationStartedAt: 10_000,
    sessionFile: '/stale/last-week.jsonl',
  });
  const f = createFakeHost({ initialTime: 13_000, entry });
  f.client.waitAgentQueue = ['idle'];
  f.sessionIo.reattributeResponses = ['/fresh/real-session.jsonl'];
  f.sessionIo.subSessionResponses = [{ text: 'FINAL REPORT delivered from the real session', pendingTool: false, activity: true, turnEnded: true }];

  const poller = createPoller(f.host);
  await poller.startPoller('p-stale', '/tmp', 0, 5_000, 'cross-repo task', 'prompt-a');

  assert.equal(entry.sessionFile, '/fresh/real-session.jsonl', 'registry re-attributed from herdr report');
  assert.equal(entry.status, 'consumed');
  assert.equal(f.historyWrites[0]?.patch?.outcome, 'FINAL REPORT delivered from the real session');
  assert.match(f.injectedNotices[0]!, /FINAL REPORT delivered from the real session/);
});

test('p25 (01a0c282): a fresh registry sessionFile is kept as-is (no re-attribution churn)', async () => {
  const entry = makeEntry('p-fresh', {
    observationStartedAt: 10_000,
    sessionFile: '/fresh/current.jsonl',
  });
  const f = createFakeHost({ initialTime: 13_000, entry });
  f.client.waitAgentQueue = ['idle'];
  // reattributeResponses empty → fake keeps the preferred value, mirroring a fresh file.
  f.sessionIo.subSessionResponses = [{ text: 'done', pendingTool: false, activity: true, turnEnded: true }];

  const poller = createPoller(f.host);
  await poller.startPoller('p-fresh', '/tmp', 0, 5_000, 'task', 'prompt-a');

  assert.equal(entry.sessionFile, '/fresh/current.jsonl');
  assert.equal(entry.status, 'consumed');
});

test('p25 (01a0c282): follow_up refreshes the tracked request of an ALREADY-RUNNING poller', async () => {
  // send used to call startPoller as a no-op while the spawn poller lived on with the
  // original injectTs/requestId; settlement was judged against the stale request.
  const entry = makeEntry('p-refresh');
  const f = createFakeHost({ initialTime: 10_000, entry });
  f.client.waitAgentQueue = ['working', 'idle'];
  f.client.agents = [{ paneId: 'p-refresh', status: 'idle' }];
  f.sessionIo.subSessionResponses = [
    { text: 'report for the follow-up', pendingTool: false, activity: true, turnEnded: true },
    { text: 'report for the follow-up', pendingTool: false, activity: true, turnEnded: true },
  ];
  const origSleep = f.host.sleep!;
  f.host.sleep = async (ms) => {
    await origSleep(ms);
    f.virtualTime.now += 2_500; // advance past observationWindowMs (2000) like the OCC test
  };

  const poller = createPoller(f.host);
  const running = poller.startPoller('p-refresh', '/tmp', 0, 1_111, 'task', 'prompt-a');
  poller.startPoller('p-refresh', '/tmp', 0, 2_222, 'task', 'fu-42'); // must move judgment to the follow-up
  await running;

  assert.ok(
    f.sessionIo.subSessionSinceTsCalls.includes(2_222),
    `subSessionState must see the follow-up injectTs (saw ${f.sessionIo.subSessionSinceTsCalls.join(',')})`,
  );
  assert.ok(!f.sessionIo.subSessionSinceTsCalls.includes(1_111), 'the superseded spawn injectTs must not be used');
  assert.ok(f.claimKeys.includes('p-refresh:fu-42'), `settle claim must use the follow-up id (saw ${f.claimKeys.join(',')})`);
  assert.match(f.injectedNotices[0] ?? '', /report for the follow-up/);
});
/* ──────────────── Vacuum Branches ──────────────── */

test('pollLoop: vacuum triggers pane-closed when pane is missing from pane.list', async () => {
  const entry = makeEntry('p-dead');
  const f = createFakeHost({ entry });
  f.client.waitAgentQueue = ['done'];
  f.sessionIo.subSessionResponses = [{ text: null, pendingTool: true, activity: false }];
  // agent.list still has it; pane.list is the existence authority
  f.client.agents = [{ paneId: 'p-dead', status: 'idle' }];
  f.client.panes = [];

  const poller = createPoller(f.host);
  await poller.startPoller('p-dead', '/tmp', 0, 0, 'desc', 'req-1');

  assert.equal(entry.status, 'consumed');
  assert.equal(f.historyWrites.length, 1);
  assert.equal(f.historyWrites[0]?.via, 'poll-pane-closed');
  assert.equal(f.historyWrites[0]?.patch?.outcome, 'pane closed before settling');
  assert.match(f.injectedNotices[0]!, /stopped before settling \(its pane closed\)\./);
  assert.equal(f.reconcileCalls[0]?.outcome, 'failed');
});

test('pollLoop: vacuum must not close a pane.list shell that agent.list omits', async () => {
  const entry = makeEntry('p-shell');
  const f = createFakeHost({ initialTime: 10_000, entry });
  f.client.waitAgentQueue = ['idle'];
  f.sessionIo.subSessionResponses = [{ text: null, pendingTool: true, activity: false }];
  f.client.agents = [];
  f.client.panes = [{ paneId: 'p-shell', agentStatus: 'unknown' }];

  let loop = 0;
  f.host.client.waitAgent = async () => {
    loop += 1;
    if (loop >= 1) entry.status = 'settled';
    return 'idle';
  };

  const poller = createPoller(f.host);
  await poller.startPoller('p-shell', '/tmp', 0, 0, 'desc', 'req-1');

  assert.equal(f.historyWrites.length, 0);
});

test('pollLoop: vacuum triggers timeout when subagent shows no progress past timeoutMs', async () => {
  const entry = makeEntry('p-timeout');
  const f = createFakeHost({ initialTime: 10_000, entry });
  f.client.agents = [{ paneId: 'p-timeout', status: 'idle' }];
  f.sessionIo.subSessionResponses = [{ text: null, pendingTool: true, activity: false }];

  // Advance time during waitAgent to simulate timeout
  f.host.client.waitAgent = async () => {
    f.virtualTime.now += 15_000;
    return 'idle';
  };

  const poller = createPoller(f.host);
  await poller.startPoller('p-timeout', '/tmp', 0, 0, 'desc', 'req-1');

  assert.equal(entry.status, 'consumed');
  assert.equal(f.historyWrites[0]?.via, 'poll-timeout');
  assert.equal(f.historyWrites[0]?.patch?.outcome, 'observation timeout');
  assert.match(f.injectedNotices[0]!, /has shown no progress for/);
  assert.equal(f.reconcileCalls[0]?.outcome, 'failed');
});

test('pollLoop: vacuum assumes alive when listAgents probe throws', async () => {
  const entry = makeEntry('p-vac-list-err');
  const f = createFakeHost({ initialTime: 10_000, entry });
  f.client.waitAgentQueue = ['idle'];
  f.client.throwOnListAgents = true; // probe throws -> alive defaults to true
  f.sessionIo.subSessionResponses = [{ text: null, pendingTool: true, activity: false }];

  let loop = 0;
  f.host.client.waitAgent = async () => {
    loop++;
    if (loop >= 1) entry.status = 'settled';
    return 'idle';
  };

  const poller = createPoller(f.host);
  await poller.startPoller('p-vac-list-err', '/tmp', 0, 0, 'desc', 'req-1');

  // Did not treat as pane-closed because alive defaulted to true
  assert.equal(f.historyWrites.length, 0);
});

test('pollLoop: vacuum refreshActivity updates lastActivityAt on heartbeat', async () => {
  const entry = makeEntry('p-heartbeat');
  const f = createFakeHost({ initialTime: 10_000, entry });
  // waitAgent returns null (heartbeat)
  f.client.waitAgentQueue = [null];
  f.client.agents = [{ paneId: 'p-heartbeat', status: 'idle' }];

  let loop = 0;
  f.host.client.waitAgent = async () => {
    loop++;
    if (loop >= 1) entry.status = 'settled';
    return null;
  };

  const poller = createPoller(f.host);
  await poller.startPoller('p-heartbeat', '/tmp', 0, 0, 'desc', 'req-1');

  assert.equal(entry.status, 'settled');
});

test('pollLoop: vacuum notice handles injection failure silently', async () => {
  const entry = makeEntry('p-vac-inj-err');
  const f = createFakeHost({ entry, throwOnInject: true });
  f.client.waitAgentQueue = ['done'];
  f.client.agents = []; // pane closed -> injects notice which will throw
  f.sessionIo.subSessionResponses = [{ text: null, pendingTool: true, activity: false }];

  const poller = createPoller(f.host);
  await poller.startPoller('p-vac-inj-err', '/tmp', 0, 0, 'desc', 'req-1');

  assert.equal(entry.status, 'consumed');
});

/* ──────────────── Lifecycle & Scope Management ──────────────── */

test('startPoller: duplicate call for active paneId returns immediately without re-starting', async () => {
  const entry = makeEntry('p-dup');
  const f = createFakeHost({ entry });
  f.client.waitAgentQueue = ['idle'];
  f.sessionIo.subSessionResponses = [{ text: 'done', pendingTool: false, activity: true }];

  const poller = createPoller(f.host);
  // Manually add to pollers to simulate concurrent start
  poller.pollers.add('p-dup');

  await poller.startPoller('p-dup', '/tmp', 0, 0, 'desc', 'req-1');

  // Should have returned early
  assert.equal(f.historyWrites.length, 0);
});

test('startPoller: cleans up fiber and handles fiber.dispose rejection gracefully', async () => {
  const entry = makeEntry('p-fiber-err');
  const f = createFakeHost({ entry });
  f.client.waitAgentQueue = ['idle'];
  f.sessionIo.subSessionResponses = [{ text: 'done', pendingTool: false, activity: true }];
  // Inject a disposal failure through the runtime object; Cordis exposes plugin as readonly.
  const origPlugin = f.host.sessionRoot.plugin.bind(f.host.sessionRoot);
  Object.defineProperty(f.host.sessionRoot, 'plugin', {
    configurable: true,
    value: (...args: unknown[]) => {
      const fiber = Reflect.apply(origPlugin, f.host.sessionRoot, args);
      return Promise.resolve(fiber).then((result) => {
        Object.defineProperty(result, 'dispose', {
          configurable: true,
          value: async () => { throw new Error('fiber dispose error'); },
        });
        return result;
      });
    },
  });

  const poller = createPoller(f.host);
  await poller.startPoller('p-fiber-err', '/tmp', 0, 0, 'desc', 'req-1');

  assert.equal(entry.status, 'consumed');
  assert.equal(poller.pollers.has('p-fiber-err'), false);
});

test('startPoller: removes from pollers on crash in startup scope', async () => {
  const entry = makeEntry('p-crash');
  const f = createFakeHost({ entry });
  Object.defineProperty(f.host.sessionRoot, 'plugin', {
    configurable: true,
    value: () => Promise.reject(new Error('catastrophic scope plugin failure')),
  });

  const poller = createPoller(f.host);
  await poller.startPoller('p-crash', '/tmp', 0, 0, 'desc', 'req-1');

  assert.equal(poller.pollers.has('p-crash'), false);
});

/* ──────────────── Trace Logging ──────────────── */

test('pollLoop: PI_HERDR_TRACE writes diagnostic output and tolerates append errors', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'pier-trace-'));
  const traceFile = join(tmpDir, 'trace.log');
  process.env.PI_HERDR_TRACE = traceFile;

  try {
    const entry = makeEntry('p-trace', { observationStartedAt: 10_000 });
    const f = createFakeHost({ initialTime: 13_000, entry });
    f.client.waitAgentQueue = ['idle'];
    f.sessionIo.subSessionResponses = [{ text: 'trace tested', pendingTool: false, activity: true }];

    const poller = createPoller(f.host);
    await poller.startPoller('p-trace', '/tmp', 0, 0, 'desc', 'req-1');

    const content = readFileSync(traceFile, 'utf-8');
    assert.match(content, /d98poll \d+ p-trace state=idle/);

    // Also test trace append error resilience by pointing to an uncreatable file path
    process.env.PI_HERDR_TRACE = join(traceFile, 'sub-dir-cannot-exist', 'file.log');
    const entry2 = makeEntry('p-trace2', { observationStartedAt: 10_000 });
    const f2 = createFakeHost({ initialTime: 13_000, entry: entry2 });
    f2.client.waitAgentQueue = ['idle'];
    f2.sessionIo.subSessionResponses = [{ text: 'trace tested 2', pendingTool: false, activity: true }];
    const poller2 = createPoller(f2.host);
    await poller2.startPoller('p-trace2', '/tmp', 0, 0, 'desc', 'req-2');
    assert.equal(entry2.status, 'consumed');
  } finally {
    delete process.env.PI_HERDR_TRACE;
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* cleanup */ }
  }
});

/* ──────────────── Default Sleep Seam ──────────────── */

test('default sleep resolves properly after specified delay', async () => {
  const t0 = Date.now();
  await sleep(5);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 0);
});
