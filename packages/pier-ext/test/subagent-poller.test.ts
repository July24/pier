/** Settlement poller: pure transition planners plus a lean set of loop-level behaviors (settle
 * claim, blocked gate, vacuum, compaction hold, request refresh) and the scope. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import {
  buildSettlementNoticeText, createPoller, createSessionRoot, disposeSessionRoot, formatObservationTimeoutNotice,
  formatPaneClosedNotice, isSettlementCandidate, mountSubagentScope, planBlockedGate, planObservationTick,
  planVacuumTick, type PollerHost,
} from '../src/subagent-poller.ts';
import type { SubEntry } from '../src/subagent-core.ts';
import { fakeWatch, subEntry, terminalInfo } from './test-utils.ts';
import type { CoreClientLike, CoreStatus } from '../src/core-client.ts';
import type { SubSessionState } from '../src/session-tail.ts';
import type { SessionIo } from '../src/subagent-session.ts';
import type { GitIo } from '../src/subagent-spawn.ts';
import type { JevAskMeta } from '../src/jev-client.ts';

/* ── planners ───────────────────────────────────────────────────── */

test('planBlockedGate: the first block notifies, repeats stay silent, any other state clears', () => {
  assert.deepEqual(planBlockedGate('blocked', false), { kind: 'stay-blocked', notify: true });
  assert.deepEqual(planBlockedGate('blocked', true), { kind: 'stay-blocked', notify: false });
  assert.equal(planBlockedGate('idle', true).kind, 'clear-gate');
  assert.equal(planBlockedGate(null, false).kind, 'pass');
});

test('planObservationTick: the window opens, waits, then settles; a finalized answer skips it', () => {
  const base = { observationStartedAt: 10_000, now: 12_000, windowMs: 30_000 };
  assert.equal(planObservationTick({ ...base, observationStartedAt: null }).kind, 'start-observation');
  assert.equal(planObservationTick({ ...base, observationStartedAt: null, finalized: true }).kind, 'settle', 'the transcript cannot grow under a finished turn');
  assert.equal(planObservationTick(base).kind, 'wait');
  assert.equal(planObservationTick({ ...base, now: 39_999 }).kind, 'wait', 'the window is not over yet');
  assert.equal(planObservationTick({ ...base, now: 40_001 }).kind, 'settle');
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
  /** Every pane the loop had to resolve through `getTerminal` because the watch snapshot lacked it. */
  const getTerminalCalls: string[] = [];
  let waitState: CoreStatus | 'exited' | null = 'idle';
  /** False takes the worker out of the watch snapshot, forcing the getTerminal fallback. */
  let inSnapshot = true;
  let connected = true;
  let state: SubSessionState = { text: 'finished', pendingTool: false, activity: true, turnEnded: true, compacting: false };
  let reattributed: string | null = null;
  let claimResult = true;
  /** Extra behavior around a park: advance the scripted state, or hold the wait open. */
  let parkHook: ((ms: number) => boolean | Promise<boolean>) | null = null;
  const paneId = entry?.paneId ?? 'p-none';

  const buildWatch = () => fakeWatch({
    connected,
    terminals: () => {
      if (!inSnapshot) return [];
      if (waitState === 'exited') return [terminalInfo({ id: paneId, state: 'finished', labels: { 'herdr.tab': 't0' } })];
      // `null` = no word to act on: the worker is (still) working.
      return [terminalInfo({ id: paneId, status: waitState ?? 'working', labels: { 'herdr.tab': 't0' } })];
    },
    // A park IS the wait: the virtual clock advances by exactly its duration, so the loop under
    // test moves only through its own parks — deterministic, and no real timers are involved.
    park: async (ms) => {
      virtual.now += ms;
      return (await parkHook?.(ms)) ?? false;
    },
  });
  let watch = buildWatch();

  const client = {
    available: true,
    getTerminal: async (id: string) => {
      getTerminalCalls.push(id);
      return panes.includes(id)
        ? terminalInfo({ id, status: 'idle', labels: { 'herdr.tab': 't0' } })
        : null;
    },
    watchChildren: () => watch,
    kill: async () => undefined,
    remove: async () => undefined,
  } as unknown as CoreClientLike;

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
    session,
    git,
    injectNotice: async (content) => { notices.push(content); },
    reconcileOnSettlement: (description, outcome) => {
      reconciled.push({ description, outcome });
      return [`- Reconciled: ${description}`];
    },
    withReconcileNotes: (base, notes) => (notes.length > 0 ? `${base}\n${notes.join('\n')}` : base),
    claimSettleNotice: (key) => { claimKeys.push(key); return claimResult; },
    now: () => virtual.now,
    policy: {
      observationWindowMs: 2_000,
      subagentTimeoutMs: 10_000,
      pollIntervalMs: 500,
    },
  };

  return {
    host, entry, writes, notices, reconciled, claimKeys, persisted, virtual, panes, getTerminalCalls,
    parks: () => watch.parks,
    state: (s: Partial<SubSessionState>) => { state = { ...state, ...s }; },
    waitState: (s: CoreStatus | 'exited' | null) => { waitState = s; },
    reattribute: (f: string | null) => { reattributed = f; },
    setClaim: (v: boolean) => { claimResult = v; },
    setInSnapshot: (v: boolean) => { inSnapshot = v; },
    setConnected: (v: boolean) => { connected = v; watch = buildWatch(); },
    onPark: (fn: (ms: number) => boolean | Promise<boolean>) => { parkHook = fn; },
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

test('pollLoop: a finalized answer on an idle pane settles on the detecting tick, not after the window', async () => {
  const f = fixture(makeEntry('p-fast'));
  await start(f);
  assert.equal(f.entry!.status, 'consumed');
  assert.equal(f.entry!.consumedAt, 13_000, 'the detecting tick settles; the observation window was not waited');
  assert.deepEqual(f.parks(), [], 'no observation tick was scheduled');
  assert.equal(f.notices.length, 1);
});

test('pollLoop: a closing message `subagent output` already returned is pointed at, not repeated', async () => {
  const report = 'FULL REPORT: four files changed, two tests green, committed on the bugfix branch.';
  const f = fixture(makeEntry('p-seen', { reportDelivered: { fingerprint: report.slice(-64), at: 12_000 } }));
  f.state({ text: report });
  await start(f);
  assert.match(f.notices[0]!, /closing message is the report subagent\(action:"output"\) already returned at/);
  assert.doesNotMatch(f.notices[0]!, /FULL REPORT/);
  assert.match(f.notices[0]!, /- Reconciled: desc/, 'stat line and reconcile notes still ride along');
  assert.equal(f.writes[0]!.patch?.outcome, report, 'the ledger keeps the full closing text');

  const changed = fixture(makeEntry('p-changed', { reportDelivered: { fingerprint: 'an older report tail', at: 12_000 } }));
  changed.state({ text: report });
  await start(changed);
  assert.match(changed.notices[0]!, /Its closing message: FULL REPORT/, 'a different report is delivered in full');
});

test('pollLoop: a turn that ended without text starts the observation window, then settles', async () => {
  const f = fixture(makeEntry('p-ambiguous'));
  f.state({ text: null, pendingTool: false, activity: true, turnEnded: true });
  await start(f);
  assert.equal(f.entry!.status, 'consumed');
  assert.equal(f.entry!.consumedAt, 15_000, 'the no-text case parks the full 2s window before settling');
  assert.deepEqual(f.parks(), [2_000], 'the park is the observation window itself');
});

test('pollLoop: a working state between candidate ticks clears and restarts the observation window', async () => {
  const f = fixture(makeEntry('p-obs-restart'));
  f.state({ text: null, pendingTool: false, activity: true, turnEnded: true });
  let parks = 0;
  f.onPark(() => {
    if (parks++ === 0) f.waitState('working'); // the window opened; a continuation turn starts
    else if (parks === 2) f.waitState('idle'); // the continuation ended; the candidate is back
    return false;
  });
  await start(f);
  assert.deepEqual(f.parks(), [2_000, 500, 2_000], 'window, activity heartbeat, then a fresh window');
  assert.ok(f.persisted.some((row) => row.observationStartedAt === null), 'the working tick cleared the started window');
  assert.equal(f.entry!.consumedAt, 17_500, 'settles only after the restarted window elapses');
  assert.match(f.notices[0]!, /It left no closing message/);
});

test('pollLoop: a notice refused during compaction leaves the row running and retries the settlement', async () => {
  const f = fixture(makeEntry('p-compact', { observationStartedAt: 10_000 }));
  let attempts = 0;
  let rowAtFirstAttempt: { status: string; writes: number } | null = null;
  f.host.injectNotice = async (content) => {
    if (attempts++ === 0) {
      rowAtFirstAttempt = { status: f.entry!.status, writes: f.writes.length };
      throw new Error('pi is compacting');
    }
    f.notices.push(content);
  };
  await start(f);
  assert.deepEqual(rowAtFirstAttempt, { status: 'running', writes: 0 }, 'the row is not consumed before the notice is accepted');
  assert.equal(attempts, 2, 'the rejected notice is retried, not lost');
  assert.equal(f.entry!.status, 'consumed');
  assert.equal(f.writes.length, 1, 'one ledger row for the one settlement');
  assert.deepEqual(f.claimKeys, ['p-compact:req-1'], 'the retry reuses the claim it already owns');
  assert.match(f.notices[0]!, /Background subagent p-compact \(desc\) finished/);
});

test('pollLoop: a turn that ended without text still settles, worded as no closing message', async () => {
  const f = fixture(makeEntry('p-no-msg', { observationStartedAt: 10_000 }));
  f.state({ text: null, activity: true, turnEnded: true });
  await start(f);
  assert.equal(f.entry!.status, 'consumed');
  assert.equal(f.writes[0]!.patch?.outcome, null);
  assert.match(f.notices[0]!, /It left no closing message\./);
});

test('pollLoop: jev settle attribution classifies a null closing text and logs calibration fields', async () => {
  const f = fixture(makeEntry('p-jev', { observationStartedAt: 10_000 }));
  f.state({ text: null, activity: true, turnEnded: true });
  f.host.session.readSettleTail = async () => 'tail text without secrets';
  const asked: Array<{ questionId?: string; enrich?: JevAskMeta['enrich'] }> = [];
  f.host.jev = {
    ask: async (_request, meta) => {
      asked.push(meta);
      return {
        ok: true,
        answers: {
          tail_matches_task: { type: 'noul', noul: 0.9 },
          tail_has_final_answer: { type: 'noul', noul: 0.8 },
        },
        model: 'jev-1.13.0',
        usage: { inputTokens: 100, outputTokens: 10 },
        latencyMs: 5,
      };
    },
    getMinConfidence: () => 0.6,
  } as NonNullable<PollerHost['jev']>;
  await start(f);
  assert.equal(f.entry!.status, 'consumed');
  assert.equal(asked.length, 1);
  assert.equal(asked[0]!.questionId, 'settle-attribution');
  assert.deepEqual(asked[0]!.enrich?.({
    ok: true,
    answers: {
      tail_matches_task: { type: 'noul', noul: 0.9 },
      tail_has_final_answer: { type: 'noul', noul: 0.8 },
    },
  }), {
    tailMatchesTaskNoul: 0.9,
    tailHasFinalAnswerNoul: 0.8,
    settleVerdict: 'extraction-failed',
  });
  assert.match(f.notices[0]!, /could not be extracted/);
});

test('pollLoop: a confident jev mis-attribution rewords the notice instead of trusting the tail', async () => {
  const f = fixture(makeEntry('p-jev2', { observationStartedAt: 10_000 }));
  f.state({ text: null, activity: true, turnEnded: true });
  f.host.session.readSettleTail = async () => 'tail about a different task';
  f.host.jev = {
    ask: async () => ({
      ok: true,
      answers: {
        tail_matches_task: { type: 'noul', noul: 0.2 },
        tail_has_final_answer: { type: 'noul', noul: 0.9 },
      },
      model: 'jev-1.13.0',
      usage: { inputTokens: 100, outputTokens: 10 },
      latencyMs: 5,
    }),
    getMinConfidence: () => 0.6,
  } as NonNullable<PollerHost['jev']>;
  await start(f);
  assert.match(f.notices[0]!, /attribution is suspect/);
});

test('pollLoop: the blocked gate notifies once with the human question, then clears', async () => {
  const f = fixture(makeEntry('p-gate'));
  f.waitState('blocked');
  f.onPark(() => { f.waitState('idle'); return false; });
  await start(f);
  const blocked = f.notices.filter((n) => n.includes('BLOCKED'));
  assert.equal(blocked.length, 1, 'one notice per gate, not one per tick');
  assert.match(blocked[0]!, /question: "Which data source\?"/);
  assert.equal(f.entry!.status, 'consumed', 'the loop resumes after the gate clears');
});

test('pollLoop: a blocked worker parks at the poll interval and makes no RPC', async () => {
  const f = fixture(makeEntry('p-blocked-long'));
  f.waitState('blocked');
  let parks = 0;
  f.onPark(() => {
    if (++parks >= 5) f.entry!.status = 'settled'; // end supervision without consuming
    return false;
  });
  await start(f);
  assert.deepEqual(f.parks(), [500, 500, 500, 500, 500], 'every blocked tick waits out the 500ms interval');
  assert.deepEqual(f.getTerminalCalls, [], 'the snapshot already has the worker: no getTerminal per tick');
  assert.equal(f.notices.filter((n) => n.includes('BLOCKED')).length, 1, 'the sticky gate notices once');
});

test('pollLoop: an idle pane that is not yet settleable parks at the poll interval', async () => {
  const f = fixture(makeEntry('p-idle-busy'));
  f.state({ text: null, pendingTool: false, activity: false, turnEnded: false });
  let parks = 0;
  f.onPark(() => {
    if (++parks >= 4) f.entry!.status = 'settled';
    return false;
  });
  await start(f);
  assert.deepEqual(f.parks(), [500, 500, 500, 500]);
});

test('pollLoop: a worker missing from the snapshot is read through getTerminal', async () => {
  const f = fixture(makeEntry('p-fallback'));
  f.setInSnapshot(false); // e.g. a fresh spawn racing its `created` event
  await start(f);
  assert.deepEqual(f.getTerminalCalls, ['p-fallback'], 'the snapshot lacked it, so the client was asked');
  assert.equal(f.entry!.status, 'consumed', 'the fallback terminal settles the row normally');
  assert.equal(f.notices.length, 1);
});

test('pollLoop: a disconnected watch never settles nor reports pane-closed/timeout while blind', async () => {
  const f = fixture(makeEntry('p-blind'));
  f.setConnected(false);
  f.state({ text: 'finished', pendingTool: false, activity: true, turnEnded: true });
  f.panes.length = 0; // even a getTerminal fallback would read "gone"
  let parks = 0;
  f.onPark(() => {
    if (++parks >= 20) f.entry!.status = 'settled'; // end supervision without consuming
    return false;
  });
  await start(f);
  assert.equal(f.entry!.status, 'settled');
  assert.deepEqual(f.getTerminalCalls, [], 'a stale snapshot is never trusted, and no fallback is made');
  assert.equal(f.writes.length, 0, 'blindness never consumes the row');
  assert.equal(f.notices.length, 0, 'no pane-closed and no timeout notice while blind');
  assert.equal(f.parks().length, 20, 'it keeps parking on the watch, not polling');
});

test('pollLoop: a vanished pane consumes the row as failed without waiting for the timeout', async () => {
  const f = fixture(makeEntry('p-gone'));
  f.setInSnapshot(false);
  f.panes.length = 0; // the watch dropped it and the terminal is gone
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
  f.onPark(() => { f.virtual.now += 15_000; return false; });
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
  await start(f, 'req-occ');
  assert.equal(f.entry!.status, 'consumed');
  assert.equal(f.writes.length, 1, 'the aborted-turn shape must not settle early');
  assert.equal(f.writes[0]!.patch?.outcome, 'all tests pass, committed on bugfix branch');
  assert.match(f.notices[0]!, /Its closing message: all tests pass, committed on bugfix branch/);
});

test('pollLoop: compaction keeps the vacuum timer fed instead of reporting an observation timeout', async () => {
  const f = fixture(makeEntry('p-occ-vac'));
  f.host.session.subSessionState = async () => ({ text: null, pendingTool: false, activity: true, turnEnded: true, compacting: true });
  let parks = 0;
  f.onPark(() => {
    f.virtual.now += 4_000;
    if (++parks >= 5) f.entry!.status = 'settled'; // end supervision without consuming
    return false;
  });
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
  f.state({ text: null, pendingTool: false, activity: false, turnEnded: false });
  const sinceTs: number[] = [];
  f.host.session.subSessionState = async (_paneId: string, _cwd: string, ts: number) => {
    sinceTs.push(ts);
    return { text: 'finished', pendingTool: false, activity: true, turnEnded: true, compacting: false };
  };
  const firstPark = Promise.withResolvers<void>();
  let parks = 0;
  f.onPark(async () => {
    if (parks++ === 0) {
      await firstPark.promise;
      f.state({ text: 'finished', pendingTool: false, activity: true, turnEnded: true });
    }
    return false;
  });
  const poller = createPoller(f.host);
  const loop = poller.startPoller('p-refresh', '/tmp', 1_000, 'desc', 'req-1');
  await poller.startPoller('p-refresh', '/tmp', 5_000, 'desc', 'req-2');
  firstPark.resolve();
  await loop;
  assert.ok(sinceTs.includes(5_000), `the loop must judge against the newest request, saw ${sinceTs.join(',')}`);
  assert.deepEqual(f.claimKeys, ['p-refresh:req-2']);
  assert.deepEqual([...poller.pollers], [], 'the pane leaves the poller set when the loop ends');
});

test('startPoller: a second call for an active pane does not start a second loop', async () => {
  const f = fixture(makeEntry('p-dup', { observationStartedAt: 10_000 }));
  f.state({ text: null, pendingTool: false, activity: false, turnEnded: false });
  const firstPark = Promise.withResolvers<void>();
  let parks = 0;
  f.onPark(async () => {
    if (parks++ === 0) {
      await firstPark.promise;
      f.state({ text: 'finished', pendingTool: false, activity: true, turnEnded: true });
    }
    return false;
  });
  const poller = createPoller(f.host);
  const loop = poller.startPoller('p-dup', '/tmp', 1_000, 'desc', 'req-1');
  await poller.startPoller('p-dup', '/tmp', 1_000, 'desc', 'req-1');
  assert.deepEqual([...poller.pollers], ['p-dup']);
  firstPark.resolve();
  await loop;
  assert.equal(f.writes.length, 1, 'exactly one settlement');
});
