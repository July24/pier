/**
 * D100 Online Context Compact Integration & Lifecycle Tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CompactCoordinator,
  COMPACT_STATE_CUSTOM_TYPE,
  COMPACTION_CONTINUE_TYPE,
  COMPACTION_INFLIGHT_TYPE,
  COMPACTION_SETTLED_TYPE,
  restoreCoordinatorState,
} from '../src/compact-coordinator.ts';
import type { TodoItem } from '../src/todo-core.ts';
import { decideCompaction } from '../src/compact-economics-core.ts';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

/** The subset of pi's `ctx.compact()` options the coordinator passes. */
interface CompactCall {
  customInstructions: string;
  onComplete: (compaction: { summary?: string } | undefined) => void;
  onError: (error: Error) => void;
}

function createMockContext(opts: {
  tokens?: number;
  hasPending?: boolean;
  branch?: any[];
}): { ctx: ExtensionContext; abortCalls: () => number; compactCalls: CompactCall[] } {
  let abortCalls = 0;
  const compactCalls: CompactCall[] = [];

  const ctx: any = {
    getContextUsage: () => ({
      tokens: opts.tokens ?? 50000,
      contextWindow: 128000,
    }),
    getSystemPrompt: () => 'System prompt text',
    hasPendingMessages: () => opts.hasPending ?? false,
    isIdle: () => true,
    sessionManager: {
      getBranch: () => opts.branch ?? [],
      getSessionDir: () => '/tmp/sessions',
      getSessionId: () => 'test_sess_01',
    },
    abort() {
      abortCalls++;
    },
    compact(options: CompactCall) {
      compactCalls.push(options);
    },
  };

  return { ctx, abortCalls: () => abortCalls, compactCalls };
}

test('CompactCoordinator: tracks boundary completion only for tool source', () => {
  const coordinator = new CompactCoordinator();

  // 1. Reconcile source must be ignored
  coordinator.recordBoundaryCompleted(1, 'reconcile');
  assert.equal(coordinator.pendingBoundaryCompleted, false);

  // 2. Human command source must be ignored
  coordinator.recordBoundaryCompleted(1, 'human');
  assert.equal(coordinator.pendingBoundaryCompleted, false);

  // 3. Tool source is captured
  coordinator.onBeforeProviderRequest(1000);
  coordinator.onBeforeProviderRequest(1200);
  coordinator.recordBoundaryCompleted(1, 'tool');
  assert.equal(coordinator.pendingBoundaryCompleted, true);
  assert.deepEqual(coordinator.state.completedBoundaryRequestCounts, [2]);
});

test('CompactCoordinator: user input resets the pending plan but keeps pacing samples; extension messages do neither', () => {
  const coordinator = new CompactCoordinator();
  coordinator.state.completedBoundaryRequestCounts = [5, 5];
  coordinator.state.carriedDebtTokens = 10000;
  coordinator.pendingBoundaryCompleted = true;

  // 1. Extension message (e.g. D96 notice, pipe injection) must NOT reset state
  coordinator.onInput({ text: '注意：仍有 1 个后台 subagent 在运行', source: 'extension' });
  assert.deepEqual(coordinator.state.completedBoundaryRequestCounts, [5, 5]);
  assert.equal(coordinator.state.carriedDebtTokens, 10000);
  assert.equal(coordinator.pendingBoundaryCompleted, true);

  // 2. Human steer input resets plan-level state (P1-2) but KEEPS
  // completedBoundaryRequestCounts — the samples measure requests-per-boundary
  // pacing, which survives human turns. Clearing them zeroed the mean and pinned
  // expectedRemainingRequests at 1 after every prompt, so OCC never saw a horizon
  // worth compacting under (2026-09-17 review: epoch climbed 1→9, zero compactions).
  coordinator.onInput({ text: 'Wait, change the direction', source: 'interactive', streamingBehavior: 'steer' });
  assert.deepEqual(coordinator.state.completedBoundaryRequestCounts, [5, 5]);
  assert.equal(coordinator.state.carriedDebtTokens, 0);
  assert.equal(coordinator.pendingBoundaryCompleted, false);
});

test('CompactCoordinator: turn_end skips abort if user has pending messages or disabled', () => {
  const coordinator = new CompactCoordinator();
  coordinator.pendingBoundaryCompleted = true;

  const todos: TodoItem[] = [{ content: 'Task 1', status: 'pending' }];

  // Case 1: OCC disabled
  const { ctx: ctxDisabled, abortCalls: aborts1 } = createMockContext({});
  coordinator.onTurnEnd({
    ctx: ctxDisabled,
    todos,
    config: {
      enabled: false,
      logEnabled: false,
      cacheWriteReadRatio: 12.5,
      firstCompactionRequestScale: 2.0,
      subsequentCompactionMargin: 1.5,
    },
  });
  assert.equal(aborts1(), 0);

  // Case 2: User has pending messages queued (e.g. steer message in progress)
  coordinator.pendingBoundaryCompleted = true;
  const { ctx: ctxPending, abortCalls: aborts2 } = createMockContext({ hasPending: true });
  coordinator.onTurnEnd({
    ctx: ctxPending,
    todos,
    config: {
      enabled: true,
      logEnabled: false,
      cacheWriteReadRatio: 12.5,
      firstCompactionRequestScale: 2.0,
      subsequentCompactionMargin: 1.5,
    },
  });
  assert.equal(aborts2(), 0);
});

test('CompactCoordinator: full lifecycle from turn_end abort through agent_settled compact', async () => {
  const coordinator = new CompactCoordinator();
  coordinator.state.completedBoundaryRequestCounts = [10]; // established horizon
  coordinator.pendingBoundaryCompleted = true;

  const todos: TodoItem[] = [
    { content: 'Done item', status: 'completed' },
    { content: 'Remaining task', status: 'in_progress', blocker: 'awaiting approval' },
  ];

  // Prepare a branch with enough messages (>20k tokens) so nativeCompactionFeasible passes
  const branchEntries = Array.from({ length: 25 }, (_, i) => ({
    type: 'message',
    id: `msg_${i}`,
    parentId: i > 0 ? `msg_${i - 1}` : null,
    message: {
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: [{ type: 'text', text: 'Some long log content exceeding threshold...\n'.repeat(200) }],
    },
  }));

  const mock = createMockContext({ tokens: 60000, branch: branchEntries });
  let reminderCancelled = false;

  // 1. turn_end triggers economic abort
  coordinator.onTurnEnd({
    ctx: mock.ctx,
    todos,
    config: {
      enabled: true,
      logEnabled: false,
      cacheWriteReadRatio: 2.0, // generous ratio so breakeven is met easily
      firstCompactionRequestScale: 2.0,
      subsequentCompactionMargin: 1.5,
    },
    cancelReminder: () => {
      reminderCancelled = true;
    },
  });

  assert.equal(mock.abortCalls(), 1);
  assert.equal(coordinator.intentionalAbort, true);
  assert.equal(reminderCancelled, true);
  assert.ok(coordinator.selectedCompaction !== null);

  // 2. agent_settled carries out compaction
  const sentMessages: any[] = [];
  const appendedEntries: Array<{ type: string; data?: { outcome?: string; at?: number } }> = [];
  const mockPi: any = {
    appendEntry(type: string, data?: { outcome?: string; at?: number }) {
      appendedEntries.push({ type, data });
    },
    sendMessage(msg: any, opts: any) {
      sentMessages.push({ msg, opts });
      return Promise.resolve();
    },
  };

  let beforeCompactCalled = false;
  const settlePromise = coordinator.onAgentSettled({
    ctx: mock.ctx,
    todos,
    pi: mockPi,
    config: {
      enabled: true,
      logEnabled: false,
      cacheWriteReadRatio: 2.0,
      firstCompactionRequestScale: 2.0,
      subsequentCompactionMargin: 1.5,
    },
    onBeforeCompact: async () => {
      beforeCompactCalled = true;
    },
  });

  // Allow async onBeforeCompact microtask to resolve
  await new Promise((r) => setTimeout(r, 10));

  // Verify onBeforeCompact hook and compact was called with remaining task instructions
  assert.equal(beforeCompactCalled, true);
  assert.equal(mock.compactCalls.length, 1);
  const compactCall = mock.compactCalls[0];
  assert.ok(compactCall.customInstructions.includes('Remaining task'));
  assert.ok(compactCall.customInstructions.includes('awaiting approval'));

  // The inflight marker must already be on disk while the summary request runs —
  // the supervising master polls this transcript and must hold settlement (01a0be1f).
  assert.equal(appendedEntries.length, 1);
  assert.equal(appendedEntries[0].type, COMPACTION_INFLIGHT_TYPE);

  // Trigger completion callback
  compactCall.onComplete({ summary: 'Compacted history summary' });
  await settlePromise;

  // Verify post-compaction state
  assert.equal(coordinator.compactionInFlight, false);
  assert.equal(coordinator.intentionalAbort, false);
  assert.equal(coordinator.state.priorCompactionCount, 1);

  // Verify marker + state persisted to session entries, in write order
  assert.deepEqual(appendedEntries.map((e) => e.type), [
    COMPACTION_INFLIGHT_TYPE,
    COMPACT_STATE_CUSTOM_TYPE,
    COMPACTION_SETTLED_TYPE,
  ]);
  assert.equal(appendedEntries[2]?.data?.outcome, 'completed');
  assert.ok(typeof appendedEntries[2]?.data?.at === 'number');

  // Verify silent continuation message dispatched
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].msg.customType, COMPACTION_CONTINUE_TYPE);
  assert.equal(sentMessages[0].opts.triggerTurn, true);
});

test('restoreCoordinatorState: replays state from branch custom entries', () => {
  const branch = [
    { type: 'message', id: 'm1' },
    {
      type: 'custom',
      customType: COMPACT_STATE_CUSTOM_TYPE,
      data: {
        version: 1,
        epoch: 3,
        completedBoundaryRequestCounts: [4, 6],
        carriedDebtTokens: 12000,
        cacheDebtRepaymentTokens: 5000,
        priorCompactionCount: 2,
        positiveContextDeltaTotal: 8000,
        positiveContextDeltaCount: 4,
        lastContextTokens: 45000,
        currentBoundaryRequestCount: 1,
      },
    },
  ];

  const restored = restoreCoordinatorState(branch);
  assert.equal(restored.epoch, 3);
  assert.deepEqual(restored.completedBoundaryRequestCounts, [4, 6]);
  assert.equal(restored.carriedDebtTokens, 12000);
  assert.equal(restored.priorCompactionCount, 2);
});

test('CompactCoordinator: decrements carried debt on each provider request and clamps to zero (P2-6)', () => {
  const coordinator = new CompactCoordinator();
  coordinator.state.carriedDebtTokens = 1000;
  coordinator.state.cacheDebtRepaymentTokens = 300;

  // Request 1: 1000 - 300 = 700
  coordinator.onBeforeProviderRequest(10000);
  assert.equal(coordinator.state.carriedDebtTokens, 700);

  // Request 2: 700 - 300 = 400
  coordinator.onBeforeProviderRequest(10500);
  assert.equal(coordinator.state.carriedDebtTokens, 400);

  // Request 3: 400 - 300 = 100
  coordinator.onBeforeProviderRequest(11000);
  assert.equal(coordinator.state.carriedDebtTokens, 100);

  // Request 4: 100 - 300 = 0 (clamps to zero and resets repayment tokens)
  coordinator.onBeforeProviderRequest(11500);
  assert.equal(coordinator.state.carriedDebtTokens, 0);
  assert.equal(coordinator.state.cacheDebtRepaymentTokens, 0);
});

test('CompactCoordinator: onError safely resets inFlight and intentional flags (8.2)', async () => {
  const coordinator = new CompactCoordinator();
  coordinator.selectedCompaction = {
    compact: true,
    reason: 'economic',
  } as any;
  coordinator.intentionalAbort = true;

  const mock = createMockContext({});
  const mockPi: any = { appendEntry: () => {}, sendMessage: () => Promise.resolve() };

  const settlePromise = coordinator.onAgentSettled({
    ctx: mock.ctx,
    todos: [],
    pi: mockPi,
    config: {
      enabled: true,
      logEnabled: false,
      cacheWriteReadRatio: 2.0,
      firstCompactionRequestScale: 2.0,
      subsequentCompactionMargin: 1.5,
    },
  });

  assert.equal(coordinator.compactionInFlight, true);
  assert.equal(mock.compactCalls.length, 1);

  // Simulate user abort / compaction error
  mock.compactCalls[0].onError(new Error('User pressed ESC / cancelled'));
  await settlePromise;

  assert.equal(coordinator.compactionInFlight, false);
  assert.equal(coordinator.intentionalAbort, false);
});

test('CompactCoordinator: a cancelled compaction stays cancelled, a failed one resumes the task', async () => {
  const decision = decideCompaction({
    writeTokens: 60000,
    archiveTokens: 40000,
    memoTokens: 1000,
    contextTokens: 60000,
    completedBoundaryRequestCounts: [10],
    remainingBoundaries: 1,
    averageContextTokenIncrement: null,
    contextWindowTokens: 128000,
    priorCompactionCount: 1,
    carriedDebtTokens: 0,
    cacheDebtRepaymentTokens: 0,
    cacheWriteReadRatio: 2.0,
  });

  const setup = () => {
    const coordinator = new CompactCoordinator();
    coordinator.selectedCompaction = decision;
    coordinator.intentionalAbort = true;

    const mock = createMockContext({});
    const sent: Array<{ msg: { content?: unknown }; opts: { triggerTurn?: boolean } }> = [];
    const appended: Array<{ type: string; data: unknown }> = [];
    // Test double: the coordinator's only touchpoints on `pi` are appendEntry and sendMessage.
    const piStub = {
      appendEntry: (type: string, data: unknown) => {
        appended.push({ type, data });
      },
      sendMessage: (msg: { content?: unknown }, opts: { triggerTurn?: boolean }) => {
        sent.push({ msg, opts });
      },
    } as unknown as ExtensionAPI;

    const settle = coordinator.onAgentSettled({
      ctx: mock.ctx,
      todos: [],
      pi: piStub,
      config: {
        enabled: true,
        logEnabled: false,
        cacheWriteReadRatio: 2.0,
        firstCompactionRequestScale: 2.0,
        subsequentCompactionMargin: 1.5,
      },
    });
    return { coordinator, mock, sent, settle, appended };
  };

  const settledOutcome = (appended: Array<{ type: string; data: unknown }>): { outcome?: string } => {
    const found = appended.find((e) => e.type === COMPACTION_SETTLED_TYPE)?.data;
    return typeof found === 'object' && found !== null ? found : {};
  };

  // 1. User cancel (pi throws exactly this) must NOT resurrect the turn the user just stopped.
  const cancelled = setup();
  cancelled.mock.compactCalls[0]!.onError(new Error('Compaction cancelled'));
  await cancelled.settle;
  assert.equal(cancelled.sent.length, 0, 'cancelling must not trigger a continuation turn');
  assert.equal(cancelled.coordinator.compactionInFlight, false);
  // Cancel still releases the cross-session hold — otherwise the master's poller
  // would hold settlement forever on a compaction that will never resume.
  assert.equal(settledOutcome(cancelled.appended).outcome, 'cancelled');

  // 2. A real failure left the session parked on the aborted turn, so it must resume.
  const failed = setup();
  failed.mock.compactCalls[0]!.onError(new Error('Summarization failed: generation hit the token cap'));
  await failed.settle;
  assert.equal(failed.sent.length, 1, 'a failed compaction must resume the task');
  assert.equal(failed.sent[0]!.opts.triggerTurn, true);
  assert.match(String(failed.sent[0]!.msg.content), /compaction failed/i);
  assert.equal(failed.coordinator.compactionInFlight, false);
  assert.equal(failed.coordinator.intentionalAbort, false);
  assert.equal(settledOutcome(failed.appended).outcome, 'failed');

  // 3. AbortError (ESC during compaction) is a cancel, not a failure.
  const aborted = setup();
  const abortError = new Error('aborted');
  abortError.name = 'AbortError';
  aborted.mock.compactCalls[0]!.onError(abortError);
  await aborted.settle;
  assert.equal(aborted.sent.length, 0);
  assert.equal(settledOutcome(aborted.appended).outcome, 'cancelled');
});

test('CompactCoordinator: turn_end falls back when usage.tokens is null or 0 (P2-11)', () => {
  const coordinator = new CompactCoordinator();
  coordinator.state.lastContextTokens = 35000;
  coordinator.pendingBoundaryCompleted = true;

  const mock = createMockContext({});
  // Mock usage with null tokens (as Pi returns right after compaction before next response)
  mock.ctx.getContextUsage = () => ({ tokens: null, contextWindow: 128000, percent: 0 });

  coordinator.onTurnEnd({
    ctx: mock.ctx,
    todos: [{ content: 'test', status: 'completed' }],
    config: {
      enabled: true,
      logEnabled: false,
      cacheWriteReadRatio: 12.5,
      firstCompactionRequestScale: 2.0,
      subsequentCompactionMargin: 1.5,
    },
  });

  // Must not throw or poison with 0
  assert.equal(coordinator.state.lastContextTokens, 35000);
});

test('CompactCoordinator.getRemainingHorizon: fallback when empty and derived from samples (P2-7)', () => {
  const coordinator = new CompactCoordinator();

  // 1. No samples -> conservative fallback 4
  assert.equal(coordinator.getRemainingHorizon(), 4);

  // 2. With samples: [5, 5], remainingBoundaries = 2 -> 1 + floor(5 * 2) = 11
  coordinator.state.completedBoundaryRequestCounts = [5, 5];
  assert.equal(coordinator.getRemainingHorizon(2), 11);

  // 3. With tight window tokens: clamps to upper bound
  coordinator.state.lastContextTokens = 90000;
  coordinator.state.positiveContextDeltaTotal = 2000;
  coordinator.state.positiveContextDeltaCount = 1; // avg increment = 2000
  // window = 100000 -> (100000 - 90000)/2000 = 5
  assert.equal(coordinator.getRemainingHorizon(2, 100000), 5);
});




test('P1-3: 压缩失败后进入退避——下一次 compact 决策被跳过（不再白付 abort），成功后复位', async () => {
  const coordinator = new CompactCoordinator();
  const todos: TodoItem[] = [{ content: 'Remaining task', status: 'in_progress' }];
  const config = {
    enabled: true,
    logEnabled: false,
    cacheWriteReadRatio: 2.0,
    firstCompactionRequestScale: 2.0,
    subsequentCompactionMargin: 1.5,
  } as never;
  const branchEntries = Array.from({ length: 25 }, (_, i) => ({
    type: 'message',
    id: `msg_${i}`,
    parentId: i > 0 ? `msg_${i - 1}` : null,
    message: {
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: [{ type: 'text', text: 'Some long log content exceeding threshold...\n'.repeat(200) }],
    },
  }));
  coordinator.state.completedBoundaryRequestCounts = [1];
  coordinator.pendingBoundaryCompleted = true;
  const { ctx, abortCalls, compactCalls } = createMockContext({ tokens: 60000, branch: branchEntries });
  coordinator.onTurnEnd({ ctx, todos, config });
  assert.equal(abortCalls(), 1, '首次决策应 abort（OCC 正常路径）');

  // 2. 压缩失败（token cap 类）→ 失败计数 + 退避窗口 + 可见失败消息
  const messages: Array<{ content: string; display?: boolean }> = [];
  const pi = {
    sendMessage: (m: { content: string; display?: boolean }) => { messages.push(m); },
    appendEntry: () => {},
  } as never;
  const settled = coordinator.onAgentSettled({ ctx, todos, pi, config });
  assert.equal(compactCalls.length, 1);
  compactCalls[0].onError(new Error('Summarization failed: generation hit the token cap and the summary is incomplete'));
  await settled;
  assert.ok(coordinator.state.compactBackoffTurnEnds >= 2, '退避窗口 ≥2');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].display, true, '失败消息必须可见');
  assert.match(messages[0].content, /FAILED/);

  // 3. 退避期内：同样的决策不再 abort（窗口 2 → 消耗 1）。每次决策前复位经济前置，
  //    因为 onTurnEnd 会消耗 pendingBoundaryCompleted 并更新边界采样。
  const rearm = (): void => {
    coordinator.state.completedBoundaryRequestCounts = [1];
    coordinator.pendingBoundaryCompleted = true;
  };
  rearm();
  coordinator.onTurnEnd({ ctx, todos, config });
  assert.equal(abortCalls(), 1, '退避期内不得再次 abort');

  // 4. 退避耗尽后恢复 abort，onComplete 复位失败计数
  rearm();
  coordinator.onTurnEnd({ ctx, todos, config }); // 窗口 1 → 0
  rearm();
  coordinator.onTurnEnd({ ctx, todos, config }); // 正常决策 → abort
  assert.equal(abortCalls(), 2, '退避耗尽后应恢复 abort');
  const settled2 = coordinator.onAgentSettled({ ctx, todos, pi, config });
  compactCalls.at(-1)!.onComplete({ summary: 'ok' });
  await settled2;
  assert.equal(coordinator.state.consecutiveCompactionFailures, 0, '成功后失败计数复位');
  assert.equal(coordinator.state.compactBackoffTurnEnds, 0, '成功后退避复位');
});
