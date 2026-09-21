/**
 * D100 Online Context Compact 经济性 / 可行性纯核心测试。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideCompaction,
  estimateRemainingRequests,
  nativeCompactionFeasible,
  resolveCacheRatioFromCost,
} from '../src/compact-economics-core.ts';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';

/** estimateRemainingRequests 的基线：边界外推 5 步/边界、窗口充裕。 */
const horizonBase = {
  completedBoundaryRequestCounts: [4, 6],
  remainingBoundaries: 3,
  scale: 1.0,
  standardDeviationK: 0.0,
  contextTokens: 10000,
  contextWindowTokens: 100000,
  averageContextTokenIncrement: 1000,
};
const estimate = (over: Partial<typeof horizonBase> = {}) => estimateRemainingRequests({ ...horizonBase, ...over });

/**
 * decideCompaction 的基线：40K 上下文 / 21K 可压缩 / ratio 12.5（增量 11.5）/ 首个压缩 / 3 个剩余边界。
 * 每个用例只覆盖自己关心的字段，其余走基线。
 */
const decideBase = {
  writeTokens: 40000,
  archiveTokens: 22000,
  memoTokens: 1000,
  contextTokens: 40000,
  completedBoundaryRequestCounts: [10],
  remainingBoundaries: 3,
  averageContextTokenIncrement: null,
  contextWindowTokens: 200000,
  priorCompactionCount: 0,
  carriedDebtTokens: 0,
  cacheDebtRepaymentTokens: 0,
  cacheWriteReadRatio: 12.5,
};
const decide = (over: Partial<typeof decideBase> = {}) => decideCompaction({ ...decideBase, ...over });

test('estimateRemainingRequests: 均值 × 剩余边界，并按上下文窗口封顶', () => {
  // mean = 5 → unbounded = 1 + floor(5 * 3) = 16；窗口上限 floor((100000 - 10000) / 1000) = 90
  const wide = estimate();
  assert.equal(wide.requestsPerBoundaryMean, 5);
  assert.equal(wide.requestsPerBoundaryLowerBound, 5);
  assert.equal(wide.unboundedExpectedRemainingRequests, 16);
  assert.equal(wide.windowRequestUpperBound, 90);
  assert.equal(wide.expectedRemainingRequests, 16);

  // 紧窗口：unbounded = 1 + floor(10 * 5) = 51，上限 floor((100000 - 90000) / 2000) = 5
  const tight = estimate({
    completedBoundaryRequestCounts: [10],
    remainingBoundaries: 5,
    contextTokens: 90000,
    averageContextTokenIncrement: 2000,
  });
  assert.equal(tight.unboundedExpectedRemainingRequests, 51);
  assert.equal(tight.windowRequestUpperBound, 5);
  assert.equal(tight.expectedRemainingRequests, 5);
});

test('decideCompaction: 数学 breakeven 公式（RFC §2.1）', () => {
  // saving = 22000 - 1000 = 21000；增量 = 12.5 - 1 = 11.5；breakeven = 45000 * 11.5 / 21000 = 24.642857…
  // horizon：mean 10 × 3 边界 = 31，首个压缩 ×2.0 → 62 ≥ breakeven
  const decision = decide({ writeTokens: 45000, completedBoundaryRequestCounts: [10, 10] });
  assert.equal(decision.compact, true);
  assert.equal(decision.reason, 'economic');
  assert.ok(Math.abs(decision.breakevenRequests! - 24.642857) < 0.001);
  assert.equal(decision.incrementalCacheCostRatio, 11.5);
});

test('decideCompaction: archiveTokens ≤ memoTokens → non_positive_saving', () => {
  const decision = decide({ writeTokens: 20000, archiveTokens: 1000, memoTokens: 1000, contextTokens: 20000 });
  assert.equal(decision.compact, false);
  assert.equal(decision.reason, 'non_positive_saving');
});

test('decideCompaction: window_protection 即使 breakeven 未达也压缩', () => {
  // reserve 16384 → 窗口截止 83616 ≤ 95000
  const decision = decide({
    writeTokens: 90000,
    archiveTokens: 15000,
    contextTokens: 95000,
    completedBoundaryRequestCounts: [1],
    remainingBoundaries: 1,
    contextWindowTokens: 100000,
    priorCompactionCount: 1,
  });
  assert.equal(decision.compact, true);
  assert.equal(decision.reason, 'window_protection');
});

test('decideCompaction: 未偿债务抬高 combined breakeven → deferred_carried_debt', () => {
  // ratio 2.0（增量 1.0）：单次 breakeven = 30000 / 19000 = 1.57 ≤ 21，但
  // combined = (500000 + 30000) / 19000 = 27.89 > 21
  const decision = decide({
    writeTokens: 30000,
    archiveTokens: 20000,
    contextTokens: 30000,
    completedBoundaryRequestCounts: [10],
    remainingBoundaries: 2,
    contextWindowTokens: 100000,
    priorCompactionCount: 1,
    carriedDebtTokens: 500000,
    cacheDebtRepaymentTokens: 19000,
    cacheWriteReadRatio: 2.0,
  });
  assert.equal(decision.compact, false);
  assert.equal(decision.reason, 'deferred_carried_debt');
});

test('decideCompaction: 后续压缩需要 1.5 倍余量 → deferred_subsequent_margin', () => {
  // 增量 2.0 → breakeven = 40000 * 2 / 10000 = 8.0 ≤ 11，但 8.0 × 1.5 = 12.0 > 11
  const decision = decide({
    writeTokens: 40000,
    archiveTokens: 11000,
    contextTokens: 40000,
    completedBoundaryRequestCounts: [10],
    remainingBoundaries: 1,
    contextWindowTokens: 100000,
    priorCompactionCount: 1,
    cacheWriteReadRatio: 3.0,
  });
  assert.equal(decision.compact, false);
  assert.equal(decision.reason, 'deferred_subsequent_margin');
});

test('resolveCacheRatioFromCost: 显式配置 > 成本元数据 > 厂商族 > token 账户', () => {
  assert.equal(resolveCacheRatioFromCost(10), 10);
  assert.equal(resolveCacheRatioFromCost('auto', { cacheRead: 0.1, cacheWrite: 1.25 }), 12.5);
  assert.equal(resolveCacheRatioFromCost('auto', { cacheRead: 0.25, cacheWrite: 1.0 }), 4.0);
  // 隐式缓存：没有 write SKU，重写前缀按 input 计价
  assert.equal(resolveCacheRatioFromCost('auto', { input: 0.3, cacheRead: 0.03, cacheWrite: 0 }), 10);
  // 零价目表按厂商族解析，绝不返回 null（null 曾让所有在用的模型都禁用 OCC）
  assert.equal(resolveCacheRatioFromCost('auto', { input: 0, cacheRead: 0, cacheWrite: 0 }, { provider: 'cliproxy', modelId: 'gemini-3.8-flash-high' }), 4);
  assert.equal(resolveCacheRatioFromCost('auto', { input: 0, cacheRead: 0, cacheWrite: 0 }, { provider: 'xai', modelId: 'grok-4.6' }), 10);
  assert.equal(resolveCacheRatioFromCost('auto', { input: 0, cacheRead: 0, cacheWrite: 0 }, { provider: 'opencode-go', modelId: 'deepseek-v4.1-flash' }), 10);
  // 未知族 / 缺元数据 → token 账户 2.0（压缩请求重读一次 writeTokens）
  assert.equal(resolveCacheRatioFromCost('auto', null), 2);
  assert.equal(resolveCacheRatioFromCost('auto', { cacheRead: 0, cacheWrite: 0 }), 2);
  assert.equal(resolveCacheRatioFromCost('auto', { cacheRead: 0, cacheWrite: 0.5 }, { provider: 'other', modelId: 'm1' }), 2);
});

test('decideCompaction: 最后一个边界不做首压放宽（零剩余工作不烧摘要）', () => {
  // ratio 2 → 增量 1 → breakeven = 40000 / 21000 ≈ 1.905；horizon = 1，旧 ×2.0 会凭空造出 2
  const decision = decide({
    writeTokens: 40000,
    contextTokens: 40000,
    completedBoundaryRequestCounts: [10, 10],
    remainingBoundaries: 0,
    contextWindowTokens: 1000000,
    cacheWriteReadRatio: 2.0,
  });
  assert.equal(decision.compact, false);
  assert.equal(decision.reason, 'deferred_economic');
  assert.equal(decision.effectiveHorizonRequests, 1);
  assert.equal(decision.remainingBoundaries, 0);
});

test('nativeCompactionFeasible: 空分支或小分支返回 false', () => {
  assert.equal(nativeCompactionFeasible([], 20000), false);
  const smallBranch: SessionEntry[] = [
    {
      type: 'message',
      id: 'm1',
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    } as unknown as SessionEntry,
  ];
  assert.equal(nativeCompactionFeasible(smallBranch, 20000), false);
});
