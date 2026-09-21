/** D100 Online Context Compact: the pure economics/feasibility/cache-ratio core, then the
 * CompactCoordinator lifecycle (sampling, guards, abort→compact→continue, backoff) over a mock pi. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExtensionAPI, ExtensionContext, SessionEntry } from '@earendil-works/pi-coding-agent';
import { decideCompaction, estimateRemainingRequests, nativeCompactionFeasible, resolveCacheRatioFromCost, type CompactionDecision } from '../src/compact-economics-core.ts';
import {
  CompactCoordinator, COMPACT_STATE_CUSTOM_TYPE, COMPACTION_CONTINUE_TYPE, COMPACTION_INFLIGHT_TYPE,
  COMPACTION_SETTLED_TYPE, restoreCoordinatorState,
} from '../src/compact-coordinator.ts';
import type { TodoItem } from '../src/todo-core.ts';
import { fakePi, type FakePi } from './test-utils.ts';
/* economics / feasibility core */
/** Baseline horizon: 5 requests per boundary, ample window. */
const horizonBase = {
  completedBoundaryRequestCounts: [4, 6], remainingBoundaries: 3, scale: 1.0, standardDeviationK: 0.0,
  contextTokens: 10000, contextWindowTokens: 100000, averageContextTokenIncrement: 1000,
};
const estimate = (over: Partial<typeof horizonBase> = {}) => estimateRemainingRequests({ ...horizonBase, ...over });

/** Baseline decision: 40K context / 21K compressible / ratio 12.5 (increment 11.5) / 3 boundaries left. */
const decideBase = {
  writeTokens: 40000, archiveTokens: 22000, memoTokens: 1000, contextTokens: 40000,
  completedBoundaryRequestCounts: [10], remainingBoundaries: 3, averageContextTokenIncrement: null,
  contextWindowTokens: 200000, priorCompactionCount: 0, carriedDebtTokens: 0, cacheDebtRepaymentTokens: 0,
  cacheWriteReadRatio: 12.5,
};
const decide = (over: Partial<typeof decideBase> = {}) => decideCompaction({ ...decideBase, ...over });

test('estimateRemainingRequests: mean × remaining boundaries, capped by the context window', () => {
  // mean = 5 → unbounded = 1 + floor(5 * 3) = 16; window cap = floor((100000 - 10000) / 1000) = 90
  const wide = estimate();
  assert.equal(wide.requestsPerBoundaryMean, 5);
  assert.equal(wide.requestsPerBoundaryLowerBound, 5);
  assert.equal(wide.unboundedExpectedRemainingRequests, 16);
  assert.equal(wide.windowRequestUpperBound, 90);
  assert.equal(wide.expectedRemainingRequests, 16);
  // Tight window: unbounded = 1 + floor(10 * 5) = 51, cap = floor((100000 - 90000) / 2000) = 5
  const tight = estimate({ completedBoundaryRequestCounts: [10], remainingBoundaries: 5, contextTokens: 90000, averageContextTokenIncrement: 2000 });
  assert.deepEqual([tight.unboundedExpectedRemainingRequests, tight.windowRequestUpperBound, tight.expectedRemainingRequests], [51, 5, 5]);
});

/** [case, overrides, compacts, reason, extra assertions on the decision] */
const DECIDE_CASES: Array<[string, Partial<typeof decideBase>, boolean, string, ((d: CompactionDecision) => void)?]> = [
  // breakeven = 45000 * 11.5 / 21000 = 24.64; horizon: mean 10 × 3 boundaries = 31, first compaction ×2 → 62
  ['breakeven met is economic', { writeTokens: 45000, completedBoundaryRequestCounts: [10, 10] }, true, 'economic', (d) => {
    assert.ok(Math.abs(d.breakevenRequests! - 24.642857) < 0.001);
    assert.equal(d.incrementalCacheCostRatio, 11.5);
  }],
  ['archiveTokens ≤ memoTokens is non_positive_saving', { writeTokens: 20000, archiveTokens: 1000, memoTokens: 1000, contextTokens: 20000 }, false, 'non_positive_saving'],
  // reserve 16384 → window cutoff 83616 ≤ 95000
  ['window protection compacts below breakeven', { writeTokens: 90000, archiveTokens: 15000, contextTokens: 95000, completedBoundaryRequestCounts: [1], remainingBoundaries: 1, contextWindowTokens: 100000, priorCompactionCount: 1 }, true, 'window_protection'],
  // ratio 2.0 (increment 1.0): single breakeven 30000/19000 = 1.57 ≤ 21, combined (500000+30000)/19000 = 27.89 > 21
  ['unpaid debt raises the combined breakeven', { writeTokens: 30000, archiveTokens: 20000, contextTokens: 30000, completedBoundaryRequestCounts: [10], remainingBoundaries: 2, contextWindowTokens: 100000, priorCompactionCount: 1, carriedDebtTokens: 500000, cacheDebtRepaymentTokens: 19000, cacheWriteReadRatio: 2.0 }, false, 'deferred_carried_debt'],
  // increment 2.0 → breakeven 40000 * 2 / 10000 = 8.0 ≤ 11, but 8.0 × 1.5 = 12.0 > 11
  ['a later compaction needs a 1.5× margin', { writeTokens: 40000, archiveTokens: 11000, contextTokens: 40000, completedBoundaryRequestCounts: [10], remainingBoundaries: 1, contextWindowTokens: 100000, priorCompactionCount: 1, cacheWriteReadRatio: 3.0 }, false, 'deferred_subsequent_margin'],
  // ratio 2 → increment 1 → breakeven 40000/21000 ≈ 1.905; horizon = 1, the old ×2.0 invented a 2
  ['the last boundary gets no first-compaction boost', { writeTokens: 40000, contextTokens: 40000, completedBoundaryRequestCounts: [10, 10], remainingBoundaries: 0, contextWindowTokens: 1000000, cacheWriteReadRatio: 2.0 }, false, 'deferred_economic', (d) => {
    assert.equal(d.effectiveHorizonRequests, 1);
    assert.equal(d.remainingBoundaries, 0);
  }],
];

test('decideCompaction: one named reason per decision shape', () => {
  for (const [name, over, compact, reason, check] of DECIDE_CASES) {
    const decision = decide(over);
    assert.equal(decision.compact, compact, name);
    assert.equal(decision.reason, reason, name);
    check?.(decision);
  }
});

test('resolveCacheRatioFromCost: explicit config > cost metadata > provider family > token account', () => {
  assert.equal(resolveCacheRatioFromCost(10), 10);
  assert.equal(resolveCacheRatioFromCost('auto', { cacheRead: 0.1, cacheWrite: 1.25 }), 12.5); assert.equal(resolveCacheRatioFromCost('auto', { cacheRead: 0.25, cacheWrite: 1.0 }), 4.0);
  // Implicit caching: no write SKU, so the rewritten prefix is billed as input.
  assert.equal(resolveCacheRatioFromCost('auto', { input: 0.3, cacheRead: 0.03, cacheWrite: 0 }), 10);
  // A zero price table resolves by provider family and never returns null (null once disabled OCC for
  // every model in use).
  const free = { input: 0, cacheRead: 0, cacheWrite: 0 };
  assert.equal(resolveCacheRatioFromCost('auto', free, { provider: 'cliproxy', modelId: 'gemini-3.8-flash-high' }), 4);
  assert.equal(resolveCacheRatioFromCost('auto', free, { provider: 'xai', modelId: 'grok-4.6' }), 10);
  assert.equal(resolveCacheRatioFromCost('auto', free, { provider: 'opencode-go', modelId: 'deepseek-v4.1-flash' }), 10);
  // Unknown family / missing metadata → the token account 2.0 (a compaction re-reads writeTokens once).
  assert.equal(resolveCacheRatioFromCost('auto', null), 2); assert.equal(resolveCacheRatioFromCost('auto', { cacheRead: 0, cacheWrite: 0 }), 2);
  assert.equal(resolveCacheRatioFromCost('auto', { cacheRead: 0, cacheWrite: 0.5 }, { provider: 'other', modelId: 'm1' }), 2);
});

test('nativeCompactionFeasible: an empty or small branch is not compactable', () => {
  assert.equal(nativeCompactionFeasible([], 20000), false);
  const smallBranch = [{
    type: 'message', id: 'm1', parentId: null, timestamp: new Date().toISOString(),
    message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
  }] as unknown as SessionEntry[];
  assert.equal(nativeCompactionFeasible(smallBranch, 20000), false);
});

/** The subset of `ctx.compact()` the coordinator passes. */
interface CompactCall {
  customInstructions: string;
  onComplete: (compaction: { summary?: string } | undefined) => void;
  onError: (error: Error) => void;
}

/** The coordinator reads only these fields of OnlineContextCompactConfig. */
const configBase = { enabled: true, logEnabled: false, cacheWriteReadRatio: 2.0, firstCompactionRequestScale: 2.0, subsequentCompactionMargin: 1.5 };
const CONFIG = configBase as never;

function mockContext(opts: { tokens?: number; hasPending?: boolean; branch?: unknown[] }): {
  ctx: ExtensionContext; abortCalls: () => number; compactCalls: CompactCall[];
} {
  let abortCalls = 0;
  const compactCalls: CompactCall[] = [];
  const ctx = {
    getContextUsage: () => ({ tokens: opts.tokens ?? 50000, contextWindow: 128000 }),
    getSystemPrompt: () => 'System prompt text', hasPendingMessages: () => opts.hasPending ?? false, isIdle: () => true,
    sessionManager: { getBranch: () => opts.branch ?? [], getSessionDir: () => '/tmp/sessions', getSessionId: () => 'test_sess_01' },
    abort: () => { abortCalls++; }, compact: (options: CompactCall) => { compactCalls.push(options); },
  } as unknown as ExtensionContext;
  return { ctx, abortCalls: () => abortCalls, compactCalls };
}

/** 25 long messages, enough for nativeCompactionFeasible (> keepRecentTokens). */
const bigBranch = () => Array.from({ length: 25 }, (_, i) => ({
  type: 'message', id: `msg_${i}`, parentId: i > 0 ? `msg_${i - 1}` : null,
  message: { role: i % 2 === 0 ? 'user' : 'assistant', content: [{ type: 'text', text: 'long log content exceeding the threshold...\n'.repeat(200) }] },
}));

/** A real decision (the formula is covered above), only used to drive the settled branch. */
const economicDecision = () => decide({ writeTokens: 60000, archiveTokens: 40000, contextTokens: 60000,
  completedBoundaryRequestCounts: [10], remainingBoundaries: 1, contextWindowTokens: 128000, priorCompactionCount: 1, cacheWriteReadRatio: 2.0 });

test('CompactCoordinator: only tool-sourced boundaries are sampled, extension input changes nothing', () => {
  const coordinator = new CompactCoordinator();
  assert.equal(coordinator.getRemainingHorizon(), 4, 'no samples yet → conservative default');
  coordinator.recordBoundaryCompleted(1, 'reconcile');
  coordinator.recordBoundaryCompleted(1, 'human');
  assert.equal(coordinator.pendingBoundaryCompleted, false, 'non-tool sources are ignored');
  coordinator.onBeforeProviderRequest(1000);
  coordinator.onBeforeProviderRequest(1200);
  coordinator.recordBoundaryCompleted(1, 'tool');
  assert.equal(coordinator.pendingBoundaryCompleted, true); assert.deepEqual(coordinator.state.completedBoundaryRequestCounts, [2]);
  coordinator.state.completedBoundaryRequestCounts = [5, 5]; coordinator.state.carriedDebtTokens = 10000; coordinator.pendingBoundaryCompleted = true;
  coordinator.onInput({ text: '注意：仍有 1 个后台 subagent 在运行', source: 'extension' });
  assert.deepEqual(coordinator.state.completedBoundaryRequestCounts, [5, 5]); assert.equal(coordinator.state.carriedDebtTokens, 10000);
  assert.equal(coordinator.pendingBoundaryCompleted, true);
  // The samples measure requests-per-boundary, which holds across human turns; clearing them would
  // pin the mean at 1 and hide every horizon worth compacting.
  coordinator.onInput({ text: 'Wait, change the direction', source: 'interactive', streamingBehavior: 'steer' });
  assert.deepEqual(coordinator.state.completedBoundaryRequestCounts, [5, 5]); assert.equal(coordinator.state.carriedDebtTokens, 0);
  assert.equal(coordinator.pendingBoundaryCompleted, false);
});

test('CompactCoordinator: turn_end does not abort when disabled, with a queued message, or without usage', () => {
  const todos: TodoItem[] = [{ content: 'Task 1', status: 'pending' }];
  const coordinator = new CompactCoordinator();
  coordinator.pendingBoundaryCompleted = true;
  const disabled = mockContext({});
  coordinator.onTurnEnd({ ctx: disabled.ctx, todos, config: { ...configBase, enabled: false } as never });
  assert.equal(disabled.abortCalls(), 0);
  coordinator.pendingBoundaryCompleted = true;
  const pending = mockContext({ hasPending: true });
  coordinator.onTurnEnd({ ctx: pending.ctx, todos, config: CONFIG });
  assert.equal(pending.abortCalls(), 0, 'queued-message guard');
  // usage.tokens null/0 falls back to the last known context instead of polluting the state.
  coordinator.state.lastContextTokens = 35000; coordinator.pendingBoundaryCompleted = true;
  const stale = mockContext({});
  stale.ctx.getContextUsage = () => ({ tokens: null, contextWindow: 128000, percent: 0 }) as never;
  coordinator.onTurnEnd({ ctx: stale.ctx, todos: [{ content: 'test', status: 'completed' }], config: CONFIG });
  assert.equal(coordinator.state.lastContextTokens, 35000);
});

test('CompactCoordinator: abort → compact → markers → silent continuation', async () => {
  const coordinator = new CompactCoordinator();
  coordinator.state.completedBoundaryRequestCounts = [10];
  coordinator.pendingBoundaryCompleted = true;
  const todos: TodoItem[] = [
    { content: 'Done item', status: 'completed' },
    { content: 'Remaining task', status: 'in_progress', blocker: 'awaiting approval' },
  ];
  const mock = mockContext({ tokens: 60000, branch: bigBranch() });
  let reminderCancelled = false;
  coordinator.onTurnEnd({ ctx: mock.ctx, todos, config: CONFIG, cancelReminder: () => { reminderCancelled = true; } });
  assert.equal(mock.abortCalls(), 1); assert.equal(coordinator.intentionalAbort, true);
  assert.equal(reminderCancelled, true, 'cancel the pending reminder before aborting');
  assert.ok(coordinator.selectedCompaction !== null);
  const pi = fakePi();
  const beforeCompact = Promise.withResolvers<void>();
  const settle = coordinator.onAgentSettled({
    ctx: mock.ctx, todos, pi: pi as unknown as ExtensionAPI, config: CONFIG,
    onBeforeCompact: async () => beforeCompact.resolve(),
  });
  await beforeCompact.promise;
  assert.equal(mock.compactCalls.length, 1);
  assert.match(mock.compactCalls[0]!.customInstructions, /Remaining task/); assert.match(mock.compactCalls[0]!.customInstructions, /awaiting approval/);
  // The inflight marker must land while the summary request is still running: a supervising master
  // polls it and defers settling on it.
  assert.deepEqual(pi.entries.map(([type]) => type), [COMPACTION_INFLIGHT_TYPE]);
  mock.compactCalls[0]!.onComplete({ summary: 'Compacted history summary' });
  await settle;
  assert.equal(coordinator.compactionInFlight, false); assert.equal(coordinator.intentionalAbort, false); assert.equal(coordinator.state.priorCompactionCount, 1);
  const markers = pi.entries.map(([type]) => type);
  assert.deepEqual(markers, [COMPACTION_INFLIGHT_TYPE, COMPACT_STATE_CUSTOM_TYPE, COMPACTION_SETTLED_TYPE], 'write order is the protocol the poller depends on');
  assert.equal((pi.entries[2]?.[1] as { outcome?: string })?.outcome, 'completed');
  assert.equal(pi.sent.length, 1); assert.equal(pi.sent[0]!.msg.customType, COMPACTION_CONTINUE_TYPE); assert.equal(pi.sent[0]!.opts!.triggerTurn, true);
});

test('CompactCoordinator: a cancelled compaction stays cancelled, a failed one wakes the task', async () => {
  const setup = () => {
    const coordinator = new CompactCoordinator();
    coordinator.selectedCompaction = economicDecision();
    coordinator.intentionalAbort = true;
    const mock = mockContext({});
    const pi = fakePi();
    const settle = coordinator.onAgentSettled({ ctx: mock.ctx, todos: [], pi: pi as unknown as ExtensionAPI, config: CONFIG });
    return { coordinator, mock, pi, settle };
  };
  const outcome = (pi: FakePi) => (pi.entries.find(([type]) => type === COMPACTION_SETTLED_TYPE)?.[1] as { outcome?: string } | undefined)?.outcome;
  // 1. A user cancel (exactly the error pi throws) must not revive the turn it just stopped, but must
  // release the cross-session hold.
  const cancelled = setup();
  cancelled.mock.compactCalls[0]!.onError(new Error('Compaction cancelled'));
  await cancelled.settle;
  assert.equal(cancelled.pi.sent.length, 0); assert.equal(cancelled.coordinator.compactionInFlight, false); assert.equal(outcome(cancelled.pi), 'cancelled');
  // 2. A real failure leaves the session on an aborted turn → the continuation must carry a visible notice.
  const failed = setup();
  failed.mock.compactCalls[0]!.onError(new Error('Summarization failed: generation hit the token cap'));
  await failed.settle;
  assert.equal(failed.pi.sent.length, 1);
  assert.equal(failed.pi.sent[0]!.opts!.triggerTurn, true);
  assert.equal(failed.pi.sent[0]!.msg.display, true, 'a silent failure left a 209K-token session aware of nothing');
  assert.match(String(failed.pi.sent[0]!.msg.content), /compaction failed/i);
  assert.equal(failed.coordinator.compactionInFlight, false); assert.equal(failed.coordinator.intentionalAbort, false); assert.equal(outcome(failed.pi), 'failed');
  // 3. AbortError (ESC pressed during compaction) counts as a cancel, not a failure.
  const aborted = setup();
  const abortError = new Error('aborted');
  abortError.name = 'AbortError';
  aborted.mock.compactCalls[0]!.onError(abortError);
  await aborted.settle;
  assert.equal(aborted.pi.sent.length, 0);
  assert.equal(outcome(aborted.pi), 'cancelled');
});

test('restoreCoordinatorState: the last marker wins and missing fields keep their defaults', () => {
  const branch = [
    { type: 'message', id: 'm1' },
    {
      type: 'custom', customType: COMPACT_STATE_CUSTOM_TYPE,
      data: {
        version: 1, epoch: 3, completedBoundaryRequestCounts: [4, 6], carriedDebtTokens: 12000,
        cacheDebtRepaymentTokens: 5000, priorCompactionCount: 2, positiveContextDeltaTotal: 8000,
        positiveContextDeltaCount: 4, lastContextTokens: 45000, currentBoundaryRequestCount: 1,
      },
    },
  ];
  const restored = restoreCoordinatorState(branch);
  assert.equal(restored.epoch, 3); assert.deepEqual(restored.completedBoundaryRequestCounts, [4, 6]);
  assert.equal(restored.carriedDebtTokens, 12000); assert.equal(restored.priorCompactionCount, 2); assert.equal(restored.lastContextTokens, 45000);
  // Fields missing from an old marker must not pollute the state (shallow merge onto defaults).
  assert.equal(restored.consecutiveCompactionFailures, 0); assert.equal(restored.compactBackoffTurnEnds, 0); assert.equal(restored.version, 1);
});

test('CompactCoordinator: every provider request repays the cache debt, clearing the rate at zero', () => {
  const coordinator = new CompactCoordinator();
  coordinator.state.carriedDebtTokens = 1000;
  coordinator.state.cacheDebtRepaymentTokens = 300;
  for (const tokens of [10000, 10500, 11000]) coordinator.onBeforeProviderRequest(tokens);
  assert.equal(coordinator.state.carriedDebtTokens, 100);
  coordinator.onBeforeProviderRequest(11500);
  assert.equal(coordinator.state.carriedDebtTokens, 0); assert.equal(coordinator.state.cacheDebtRepaymentTokens, 0);
});

test('P1-3: a failed compaction backs off, pays no abort during the window, and resets on success', async () => {
  const coordinator = new CompactCoordinator();
  const todos: TodoItem[] = [{ content: 'Remaining task', status: 'in_progress' }];
  const { ctx, abortCalls, compactCalls } = mockContext({ tokens: 60000, branch: bigBranch() });
  const rearm = (): void => {
    coordinator.state.completedBoundaryRequestCounts = [1];
    coordinator.pendingBoundaryCompleted = true;
  };
  rearm();
  coordinator.onTurnEnd({ ctx, todos, config: CONFIG });
  assert.equal(abortCalls(), 1, 'the first decision takes the normal OCC path');
  const pi = fakePi();
  const settled = coordinator.onAgentSettled({ ctx, todos, pi: pi as unknown as ExtensionAPI, config: CONFIG });
  compactCalls[0]!.onError(new Error('Summarization failed: generation hit the token cap and the summary is incomplete'));
  await settled;
  assert.ok(coordinator.state.compactBackoffTurnEnds >= 2, 'backoff window ≥2');
  assert.equal(pi.sent[0]!.msg.display, true, 'the failure notice must be visible'); assert.match(String(pi.sent[0]!.msg.content), /FAILED/);
  rearm();
  coordinator.onTurnEnd({ ctx, todos, config: CONFIG });
  assert.equal(abortCalls(), 1, 'no second abort inside the backoff window');
  rearm();
  coordinator.onTurnEnd({ ctx, todos, config: CONFIG }); // window 2 → 1
  rearm();
  coordinator.onTurnEnd({ ctx, todos, config: CONFIG }); // window 0 → normal decisions
  assert.equal(abortCalls(), 2, 'aborting resumes once the backoff is exhausted');
  const settled2 = coordinator.onAgentSettled({ ctx, todos, pi: pi as unknown as ExtensionAPI, config: CONFIG });
  compactCalls.at(-1)!.onComplete({ summary: 'ok' });
  await settled2;
  assert.equal(coordinator.state.consecutiveCompactionFailures, 0, 'the failure count resets on success');
  assert.equal(coordinator.state.compactBackoffTurnEnds, 0, 'the backoff resets on success');
});
