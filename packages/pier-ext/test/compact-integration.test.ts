/**
 * D100 Online Context Compact 生命周期集成测试。
 * 缝：CompactCoordinator（边界采样 / 决策前置守卫 / abort→compact→continue 全链 / 退避）。
 * 经济公式与 restore 的字段级默认值由 compact-economics-core.test.ts 覆盖，这里只测状态机。
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

/** pi `ctx.compact()` 中协调器会传的子集。 */
interface CompactCall {
  customInstructions: string;
  onComplete: (compaction: { summary?: string } | undefined) => void;
  onError: (error: Error) => void;
}

/** OnlineContextCompactConfig 的测试基线（协调器只读这些字段）。 */
const configBase = {
  enabled: true,
  logEnabled: false,
  cacheWriteReadRatio: 2.0,
  firstCompactionRequestScale: 2.0,
  subsequentCompactionMargin: 1.5,
};
const CONFIG = configBase as never;

function createMockContext(opts: {
  tokens?: number;
  hasPending?: boolean;
  branch?: unknown[];
}): { ctx: ExtensionContext; abortCalls: () => number; compactCalls: CompactCall[] } {
  let abortCalls = 0;
  const compactCalls: CompactCall[] = [];
  const ctx = {
    getContextUsage: () => ({ tokens: opts.tokens ?? 50000, contextWindow: 128000 }),
    getSystemPrompt: () => 'System prompt text',
    hasPendingMessages: () => opts.hasPending ?? false,
    isIdle: () => true,
    sessionManager: {
      getBranch: () => opts.branch ?? [],
      getSessionDir: () => '/tmp/sessions',
      getSessionId: () => 'test_sess_01',
    },
    abort() { abortCalls++; },
    compact(options: CompactCall) { compactCalls.push(options); },
  };
  return { ctx: ctx as unknown as ExtensionContext, abortCalls: () => abortCalls, compactCalls };
}

/** 25 条长消息，让 nativeCompactionFeasible 通过（>keepRecentTokens）。 */
const bigBranch = () => Array.from({ length: 25 }, (_, i) => ({
  type: 'message',
  id: `msg_${i}`,
  parentId: i > 0 ? `msg_${i - 1}` : null,
  message: {
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: [{ type: 'text', text: 'Some long log content exceeding threshold...\n'.repeat(200) }],
  },
}));

/** 真实 decision（经济公式本身由 economics 单测覆盖），只用于驱动 settled 分支。 */
const economicDecision = () => decideCompaction({
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

function piStub(): { pi: ExtensionAPI; appended: Array<{ type: string; data?: Record<string, unknown> }>; sent: Array<{ msg: { customType?: string; content?: unknown }; opts: { triggerTurn?: boolean } }> } {
  const appended: Array<{ type: string; data?: Record<string, unknown> }> = [];
  const sent: Array<{ msg: { customType?: string; content?: unknown }; opts: { triggerTurn?: boolean } }> = [];
  const pi = {
    appendEntry: (type: string, data?: Record<string, unknown>) => { appended.push({ type, data }); },
    sendMessage: (msg: { customType?: string; content?: unknown }, opts: { triggerTurn?: boolean }) => { sent.push({ msg, opts }); },
  } as unknown as ExtensionAPI;
  return { pi, appended, sent };
}

test('CompactCoordinator: 只为 tool 来源的完成记账，并累积每次边界的请求数', () => {
  const coordinator = new CompactCoordinator();
  coordinator.recordBoundaryCompleted(1, 'reconcile');
  coordinator.recordBoundaryCompleted(1, 'human');
  assert.equal(coordinator.pendingBoundaryCompleted, false, '非 tool 来源忽略');

  coordinator.onBeforeProviderRequest(1000);
  coordinator.onBeforeProviderRequest(1200);
  coordinator.recordBoundaryCompleted(1, 'tool');
  assert.equal(coordinator.pendingBoundaryCompleted, true);
  assert.deepEqual(coordinator.state.completedBoundaryRequestCounts, [2]);
});

test('CompactCoordinator: 人类输入重置计划态但保留 pacing 采样；扩展消息两者都不动', () => {
  const coordinator = new CompactCoordinator();
  coordinator.state.completedBoundaryRequestCounts = [5, 5];
  coordinator.state.carriedDebtTokens = 10000;
  coordinator.pendingBoundaryCompleted = true;

  coordinator.onInput({ text: '注意：仍有 1 个后台 subagent 在运行', source: 'extension' });
  assert.deepEqual(coordinator.state.completedBoundaryRequestCounts, [5, 5]);
  assert.equal(coordinator.state.carriedDebtTokens, 10000);
  assert.equal(coordinator.pendingBoundaryCompleted, true);

  // 采样测的是“每个边界花多少请求”，跨人类轮次依然成立；清掉会把均值钉在 1，OCC 永远看不到值得压缩的 horizon。
  coordinator.onInput({ text: 'Wait, change the direction', source: 'interactive', streamingBehavior: 'steer' });
  assert.deepEqual(coordinator.state.completedBoundaryRequestCounts, [5, 5]);
  assert.equal(coordinator.state.carriedDebtTokens, 0);
  assert.equal(coordinator.pendingBoundaryCompleted, false);
});

test('CompactCoordinator: turn_end 在禁用或用户有排队消息时不 abort', () => {
  const todos: TodoItem[] = [{ content: 'Task 1', status: 'pending' }];
  const coordinator = new CompactCoordinator();
  coordinator.pendingBoundaryCompleted = true;
  const disabled = createMockContext({});
  coordinator.onTurnEnd({ ctx: disabled.ctx, todos, config: { ...configBase, enabled: false } as never });
  assert.equal(disabled.abortCalls(), 0);

  coordinator.pendingBoundaryCompleted = true;
  const pending = createMockContext({ hasPending: true });
  coordinator.onTurnEnd({ ctx: pending.ctx, todos, config: CONFIG });
  assert.equal(pending.abortCalls(), 0, '排队消息守卫');
});

test('CompactCoordinator: abort → compact → 标记落盘 → 静默续跑的全链', async () => {
  const coordinator = new CompactCoordinator();
  coordinator.state.completedBoundaryRequestCounts = [10];
  coordinator.pendingBoundaryCompleted = true;
  const todos: TodoItem[] = [
    { content: 'Done item', status: 'completed' },
    { content: 'Remaining task', status: 'in_progress', blocker: 'awaiting approval' },
  ];
  const mock = createMockContext({ tokens: 60000, branch: bigBranch() });
  let reminderCancelled = false;
  coordinator.onTurnEnd({
    ctx: mock.ctx,
    todos,
    config: CONFIG,
    cancelReminder: () => { reminderCancelled = true; },
  });
  assert.equal(mock.abortCalls(), 1);
  assert.equal(coordinator.intentionalAbort, true);
  assert.equal(reminderCancelled, true, 'abort 前取消待发提醒');
  assert.ok(coordinator.selectedCompaction !== null);

  const { pi, appended, sent } = piStub();
  const beforeCompact = Promise.withResolvers<void>();
  const settle = coordinator.onAgentSettled({
    ctx: mock.ctx,
    todos,
    pi,
    config: CONFIG,
    onBeforeCompact: async () => { beforeCompact.resolve(); },
  });
  await beforeCompact.promise;
  assert.equal(mock.compactCalls.length, 1);
  assert.match(mock.compactCalls[0].customInstructions, /Remaining task/);
  assert.match(mock.compactCalls[0].customInstructions, /awaiting approval/);
  // inflight 标记必须在摘要请求期间就已落盘：监督方轮询该文件并据此推迟 settle。
  assert.deepEqual(appended.map((e) => e.type), [COMPACTION_INFLIGHT_TYPE]);

  mock.compactCalls[0].onComplete({ summary: 'Compacted history summary' });
  await settle;
  assert.equal(coordinator.compactionInFlight, false);
  assert.equal(coordinator.intentionalAbort, false);
  assert.equal(coordinator.state.priorCompactionCount, 1);
  assert.deepEqual(appended.map((e) => e.type), [
    COMPACTION_INFLIGHT_TYPE,
    COMPACT_STATE_CUSTOM_TYPE,
    COMPACTION_SETTLED_TYPE,
  ], '写入顺序 = 轮询方可依赖的协议');
  assert.equal(appended[2]?.data?.outcome, 'completed');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].msg.customType, COMPACTION_CONTINUE_TYPE);
  assert.equal(sent[0].opts.triggerTurn, true);
});

test('restoreCoordinatorState: 回放最后一个状态标记，缺字段回落默认值', () => {
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
  assert.equal(restored.lastContextTokens, 45000);
  // 旧标记缺的字段不能污染状态（浅合并到默认值上）
  assert.equal(restored.consecutiveCompactionFailures, 0);
  assert.equal(restored.compactBackoffTurnEnds, 0);
  assert.equal(restored.version, 1);
});

test('CompactCoordinator: 每次 provider 请求抵扣 cache 债务，归零后清掉抵扣额', () => {
  const coordinator = new CompactCoordinator();
  coordinator.state.carriedDebtTokens = 1000;
  coordinator.state.cacheDebtRepaymentTokens = 300;
  for (const tokens of [10000, 10500, 11000]) coordinator.onBeforeProviderRequest(tokens);
  assert.equal(coordinator.state.carriedDebtTokens, 100);
  coordinator.onBeforeProviderRequest(11500);
  assert.equal(coordinator.state.carriedDebtTokens, 0);
  assert.equal(coordinator.state.cacheDebtRepaymentTokens, 0);
});

test('CompactCoordinator: 取消的压缩保持取消，失败的压缩唤醒任务', async () => {
  const setup = () => {
    const coordinator = new CompactCoordinator();
    coordinator.selectedCompaction = economicDecision();
    coordinator.intentionalAbort = true;
    const mock = createMockContext({});
    const stub = piStub();
    const settle = coordinator.onAgentSettled({ ctx: mock.ctx, todos: [], pi: stub.pi, config: CONFIG });
    return { coordinator, mock, settle, ...stub };
  };
  const outcome = (appended: Array<{ type: string; data?: Record<string, unknown> }>) => appended.find((e) => e.type === COMPACTION_SETTLED_TYPE)?.data?.outcome;

  // 1. 用户取消（pi 抛的正是这条）不得复活刚被停下的轮次，但必须释放跨会话 hold。
  const cancelled = setup();
  cancelled.mock.compactCalls[0]!.onError(new Error('Compaction cancelled'));
  await cancelled.settle;
  assert.equal(cancelled.sent.length, 0);
  assert.equal(cancelled.coordinator.compactionInFlight, false);
  assert.equal(outcome(cancelled.appended), 'cancelled');

  // 2. 真失败把会话留在 aborted 轮上 → 必须续跑（且提示可见）。
  const failed = setup();
  failed.mock.compactCalls[0]!.onError(new Error('Summarization failed: generation hit the token cap'));
  await failed.settle;
  assert.equal(failed.sent.length, 1);
  assert.equal(failed.sent[0]!.opts.triggerTurn, true);
  assert.match(String(failed.sent[0]!.msg.content), /compaction failed/i);
  assert.equal(failed.coordinator.compactionInFlight, false);
  assert.equal(failed.coordinator.intentionalAbort, false);
  assert.equal(outcome(failed.appended), 'failed');

  // 3. AbortError（压缩期间按 ESC）算取消，不算失败。
  const aborted = setup();
  const abortError = new Error('aborted');
  abortError.name = 'AbortError';
  aborted.mock.compactCalls[0]!.onError(abortError);
  await aborted.settle;
  assert.equal(aborted.sent.length, 0);
  assert.equal(outcome(aborted.appended), 'cancelled');
});

test('CompactCoordinator: usage.tokens 为 null/0 时回落上次上下文，不污染状态', () => {
  const coordinator = new CompactCoordinator();
  coordinator.state.lastContextTokens = 35000;
  coordinator.pendingBoundaryCompleted = true;
  const mock = createMockContext({});
  mock.ctx.getContextUsage = () => ({ tokens: null, contextWindow: 128000, percent: 0 }) as never;
  coordinator.onTurnEnd({ ctx: mock.ctx, todos: [{ content: 'test', status: 'completed' }], config: CONFIG });
  assert.equal(coordinator.state.lastContextTokens, 35000);
});

test('CompactCoordinator.getRemainingHorizon: 无采样保守回落 4，有采样按边界外推并受窗口封顶', () => {
  const coordinator = new CompactCoordinator();
  assert.equal(coordinator.getRemainingHorizon(), 4);
  coordinator.state.completedBoundaryRequestCounts = [5, 5];
  assert.equal(coordinator.getRemainingHorizon(2), 11); // 1 + floor(5 * 2)
  coordinator.state.lastContextTokens = 90000;
  coordinator.state.positiveContextDeltaTotal = 2000;
  coordinator.state.positiveContextDeltaCount = 1; // 平均增量 2000
  assert.equal(coordinator.getRemainingHorizon(2, 100000), 5); // (100000 - 90000) / 2000
});

test('P1-3：压缩失败后退避，退避期内不再白付 abort，成功后复位', async () => {
  const coordinator = new CompactCoordinator();
  const todos: TodoItem[] = [{ content: 'Remaining task', status: 'in_progress' }];
  const { ctx, abortCalls, compactCalls } = createMockContext({ tokens: 60000, branch: bigBranch() });
  const rearm = (): void => {
    coordinator.state.completedBoundaryRequestCounts = [1];
    coordinator.pendingBoundaryCompleted = true;
  };

  rearm();
  coordinator.onTurnEnd({ ctx, todos, config: CONFIG });
  assert.equal(abortCalls(), 1, '首次决策走 OCC 正常路径');

  const messages: Array<{ content: string; display?: boolean }> = [];
  const pi = {
    sendMessage: (m: { content: string; display?: boolean }) => { messages.push(m); },
    appendEntry: () => {},
  } as never;
  const settled = coordinator.onAgentSettled({ ctx, todos, pi, config: CONFIG });
  compactCalls[0].onError(new Error('Summarization failed: generation hit the token cap and the summary is incomplete'));
  await settled;
  assert.ok(coordinator.state.compactBackoffTurnEnds >= 2, '退避窗口 ≥2');
  assert.equal(messages[0]?.display, true, '失败消息必须可见');
  assert.match(messages[0]?.content ?? '', /FAILED/);

  rearm();
  coordinator.onTurnEnd({ ctx, todos, config: CONFIG });
  assert.equal(abortCalls(), 1, '退避期内不得再次 abort');
  rearm();
  coordinator.onTurnEnd({ ctx, todos, config: CONFIG }); // 窗口 2 → 1
  rearm();
  coordinator.onTurnEnd({ ctx, todos, config: CONFIG }); // 窗口 0 → 正常决策
  assert.equal(abortCalls(), 2, '退避耗尽后恢复 abort');

  const settled2 = coordinator.onAgentSettled({ ctx, todos, pi, config: CONFIG });
  compactCalls.at(-1)!.onComplete({ summary: 'ok' });
  await settled2;
  assert.equal(coordinator.state.consecutiveCompactionFailures, 0, '成功后失败计数复位');
  assert.equal(coordinator.state.compactBackoffTurnEnds, 0, '成功后退避复位');
});
