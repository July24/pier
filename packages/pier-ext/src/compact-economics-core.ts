/**
 * D100 Online Context Compact economics & feasibility core: pure decision-making, request horizon
 * estimation, cache debt tracking and native compaction feasibility preflights — no dependencies
 * except pi's public cut-point helper.
 */

import { findCutPoint, sessionEntryToContextMessages, type SessionEntry } from '@earendil-works/pi-coding-agent';

interface CompactionEconomics {
  readonly remainingRequestScale: number;
  readonly windowReserveTokens: number;
  readonly firstCompactionRequestScale: number;
  readonly subsequentCompactionMargin: number;
}

export const DEFAULT_COMPACTION_ECONOMICS: CompactionEconomics = Object.freeze({
  remainingRequestScale: 1.0,
  windowReserveTokens: 16_384,
  firstCompactionRequestScale: 2.0,
  subsequentCompactionMargin: 1.5,
});

/**
 * Token-account cache ratio: a compaction request re-reads the whole context once (writeTokens), so
 * breakeven = writeTokens / savingTokens ⇔ ratio 2. This is the `auto` fallback when no usable cache
 * pricing exists, and a floor: ratio ≤ 1 would zero the incremental cost and compact even on the last
 * boundary with nothing left to amortize.
 */
export const TOKEN_ACCOUNT_CACHE_RATIO = 2.0;

/** Provider-family `auto` fallbacks (implicit-cache families without a write SKU). */
const PROVIDER_FAMILY_CACHE_RATIOS: Readonly<Record<string, number>> = Object.freeze({
  gemini: 4,
  grok: 10,
  deepseek: 10,
});

type CompactionReason =
  | 'economic'
  | 'window_protection'
  | 'deferred_economic'
  | 'deferred_subsequent_margin'
  | 'deferred_carried_debt'
  | 'horizon_unavailable'
  | 'cache_ratio_unavailable'
  | 'native_not_compactable'
  | 'failure_backoff'
  | 'non_positive_saving';

interface RequestHorizonEstimate {
  readonly requestsPerBoundaryMean: number;
  readonly requestsPerBoundaryEstimate: number;
  readonly windowRequestUpperBound: number | null;
  readonly expectedRemainingRequests: number;
}

export interface CompactionDecision {
  readonly writeTokens: number;
  readonly archiveTokens: number;
  readonly memoTokens: number;
  readonly contextTokens: number;
  readonly expectedRemainingRequests: number | null;
  readonly breakevenRequests: number | null;
  readonly effectiveHorizonRequests: number | null;
  readonly remainingBoundaries: number;
  readonly cacheWriteReadRatio: number | null;
  readonly incrementalCacheCostRatio: number | null;
  /** Observed fraction of the reusable prefix served from cache (1 = every request a hit). */
  readonly prefixCacheHitRate: number;
  /**
   * Expected per-request saving in cache-read-token units: a missed request bills the archived
   * prefix at the write/input price, so it saves `cacheWriteReadRatio` times more than a hit.
   */
  readonly savingTokensPerRequest: number;
  readonly priorCompactionCount: number;
  readonly carriedDebtTokens: number;
  readonly cacheDebtRepaymentTokens: number;
  readonly compact: boolean;
  readonly reason: CompactionReason;
}

/**
 * Sparse boundary samples are noisy: a single 127-request boundary extrapolated over ten todos once
 * predicted 509 remaining requests where 16 were left. Shrink each mean toward a small prior (a todo
 * completion typically lands after a handful of model/tool steps) so one or two samples cannot
 * dominate; after a few samples the prior fades out.
 */
const SAMPLE_PRIOR_REQUESTS_PER_BOUNDARY = 5;
const SAMPLE_PRIOR_WEIGHT = 2;
/**
 * Hard ceiling on any projected horizon. Compaction must pay for itself, and no observed boundary is
 * evidence for an arbitrarily long remaining stretch.
 */
export const MAX_HORIZON_REQUESTS = 100;
/** Retained boundary-request sample cap so the mean tracks recent pacing. */
export const MAX_BOUNDARY_SAMPLES = 16;

export function estimateRemainingRequests(input: {
  readonly completedBoundaryRequestCounts: readonly number[];
  readonly remainingBoundaries: number;
  readonly scale: number;
  readonly contextTokens: number;
  readonly contextWindowTokens: number | null;
  readonly averageContextTokenIncrement: number | null;
  /**
   * Requests already spent since the last completed boundary or compaction. While work is visibly
   * continuing the horizon must not collapse to 1 just because the todo list is momentarily empty.
   */
  readonly observedRequestsSinceBoundary?: number;
}): RequestHorizonEstimate {
  const counts = input.completedBoundaryRequestCounts;
  const mean = counts.reduce((total, count) => total + count, 0) / Math.max(1, counts.length);
  const estimatePerBoundary =
    counts.length === 0
      ? 0
      : (mean * counts.length + SAMPLE_PRIOR_REQUESTS_PER_BOUNDARY * SAMPLE_PRIOR_WEIGHT)
        / (counts.length + SAMPLE_PRIOR_WEIGHT);

  const observedWorkFloor = Math.min(
    MAX_HORIZON_REQUESTS,
    Math.max(0, input.observedRequestsSinceBoundary ?? 0),
  );
  const requestEstimate = Math.max(
    1 + Math.floor(estimatePerBoundary * Math.max(0, input.remainingBoundaries) * input.scale),
    observedWorkFloor,
  );
  const windowRequestUpperBound =
    input.contextWindowTokens === null ||
    input.averageContextTokenIncrement === null ||
    input.averageContextTokenIncrement <= 0
      ? null
      : Math.max(
          0,
          Math.floor((input.contextWindowTokens - input.contextTokens) / input.averageContextTokenIncrement),
        );

  return {
    requestsPerBoundaryMean: mean,
    requestsPerBoundaryEstimate: estimatePerBoundary,
    windowRequestUpperBound,
    expectedRemainingRequests: Math.min(
      MAX_HORIZON_REQUESTS,
      requestEstimate,
      windowRequestUpperBound ?? Number.POSITIVE_INFINITY,
    ),
  };
}

export function decideCompaction(input: {
  readonly writeTokens: number;
  readonly archiveTokens: number;
  readonly memoTokens: number;
  readonly contextTokens: number;
  readonly completedBoundaryRequestCounts: readonly number[] | null;
  readonly remainingBoundaries: number;
  readonly averageContextTokenIncrement: number | null;
  readonly contextWindowTokens: number | null;
  readonly priorCompactionCount: number;
  readonly carriedDebtTokens: number;
  readonly cacheDebtRepaymentTokens: number;
  readonly cacheWriteReadRatio: number | null;
  /** Observed prefix cache hit rate in [0, 1]; omitted = every request priced as a hit. */
  readonly prefixCacheHitRate?: number;
  /** Requests observed since the last boundary/compaction; a floor on the remaining horizon. */
  readonly observedRequestsSinceBoundary?: number;
  readonly economics?: CompactionEconomics;
}): CompactionDecision {
  const economics = input.economics ?? DEFAULT_COMPACTION_ECONOMICS;
  const horizon = input.completedBoundaryRequestCounts === null ? null : estimateRemainingRequests({
    completedBoundaryRequestCounts: input.completedBoundaryRequestCounts,
    remainingBoundaries: input.remainingBoundaries,
    scale: economics.remainingRequestScale,
    contextTokens: input.contextTokens,
    contextWindowTokens: input.contextWindowTokens,
    averageContextTokenIncrement: input.averageContextTokenIncrement,
    observedRequestsSinceBoundary: input.observedRequestsSinceBoundary,
  });

  const savingTokens = input.archiveTokens - input.memoTokens;
  const compressible = savingTokens > 0;
  const incrementalCacheCostRatio =
    input.cacheWriteReadRatio === null ? null : Math.max(0, input.cacheWriteReadRatio - 1);
  const incrementalWriteCost = incrementalCacheCostRatio === null
    ? null
    : input.writeTokens * incrementalCacheCostRatio;
  // Pricing every request as a cache hit undervalues compaction: 1.4% of requests miss the prefix
  // cache (TTL expiry) and bill it at the input price — 50x cache-read on deepseek, ~1.7x the
  // expected saving. The ratio never drops below 1, so the scaled saving never shrinks.
  const prefixCacheHitRate = Math.min(1, Math.max(0, input.prefixCacheHitRate ?? 1));
  const missPriceRatio = Math.max(1, input.cacheWriteReadRatio ?? 1);
  const savingTokensPerRequest = Math.max(0, savingTokens)
    * (prefixCacheHitRate + (1 - prefixCacheHitRate) * missPriceRatio);

  const breakevenRequests = compressible && incrementalWriteCost !== null
    ? incrementalWriteCost / savingTokensPerRequest
    : null;
  const combinedBreakevenRequests = compressible && incrementalWriteCost !== null
    ? (input.carriedDebtTokens + incrementalWriteCost) / savingTokensPerRequest
    : null;

  const firstCompaction = input.priorCompactionCount === 0;
  const horizonRequests = horizon?.expectedRemainingRequests ?? null;
  // The first-compaction relaxation absorbs cold-start sample noise, but only when work remains: with
  // zero remaining boundaries the horizon is 1, and scaling it to 2 would burn a full-context summary.
  const relaxFirstCompaction = firstCompaction && input.remainingBoundaries > 0;
  const effectiveHorizonRequests = horizon === null
    ? null
    : relaxFirstCompaction
      ? Math.min(
          horizon.expectedRemainingRequests * economics.firstCompactionRequestScale,
          horizon.windowRequestUpperBound ?? Number.POSITIVE_INFINITY,
        )
      : horizon.expectedRemainingRequests;

  const windowProtection =
    input.contextWindowTokens !== null &&
    input.contextTokens >= input.contextWindowTokens - economics.windowReserveTokens;
  const baseEconomic =
    horizonRequests !== null &&
    horizonRequests > 0 &&
    breakevenRequests !== null &&
    breakevenRequests <= horizonRequests;
  const firstEconomic =
    firstCompaction &&
    effectiveHorizonRequests !== null &&
    effectiveHorizonRequests > 0 &&
    breakevenRequests !== null &&
    breakevenRequests <= effectiveHorizonRequests;
  const subsequentMarginOpen =
    !firstCompaction &&
    horizonRequests !== null &&
    breakevenRequests !== null &&
    breakevenRequests * economics.subsequentCompactionMargin <= horizonRequests;
  const carriedDebtGateOpen =
    !firstCompaction &&
    horizonRequests !== null &&
    combinedBreakevenRequests !== null &&
    combinedBreakevenRequests <= horizonRequests;

  const economic = firstCompaction ? firstEconomic : baseEconomic && subsequentMarginOpen && carriedDebtGateOpen;
  const compact = compressible && (windowProtection || economic);

  // Ordered guards: first hit wins, so the tail entry is the fallback.
  const reason = ([
    ['non_positive_saving', !compressible],
    ['window_protection', windowProtection],
    ['economic', economic],
    ['horizon_unavailable', horizon === null],
    ['cache_ratio_unavailable', breakevenRequests === null],
    ['deferred_subsequent_margin', !firstCompaction && baseEconomic && !subsequentMarginOpen],
    ['deferred_carried_debt', !firstCompaction && baseEconomic && !carriedDebtGateOpen],
    ['deferred_economic', true],
  ] as Array<[CompactionReason, boolean]>).find(([, hit]) => hit)![0];

  return {
    writeTokens: input.writeTokens,
    archiveTokens: input.archiveTokens,
    memoTokens: input.memoTokens,
    contextTokens: input.contextTokens,
    expectedRemainingRequests: horizonRequests,
    breakevenRequests,
    effectiveHorizonRequests,
    remainingBoundaries: input.remainingBoundaries,
    cacheWriteReadRatio: input.cacheWriteReadRatio,
    incrementalCacheCostRatio,
    prefixCacheHitRate,
    savingTokensPerRequest,
    priorCompactionCount: input.priorCompactionCount,
    carriedDebtTokens: input.carriedDebtTokens,
    cacheDebtRepaymentTokens: input.cacheDebtRepaymentTokens,
    compact,
    reason,
  };
}

/**
 * Resolve the cache write/read cost ratio for compaction decisions, in order: explicit numeric config
 * (as-is, e.g. 12.5 for Anthropic-style pricing), model cost metadata (write/read, or input/cacheRead
 * when cache writes are billed at the input price), provider-family fallback (gemini ≈ 4, grok/deepseek
 * ≈ 10), then TOKEN_ACCOUNT_CACHE_RATIO. Returns null only for an explicitly invalid numeric config:
 * `auto` must never resolve to null, since a zero-price table means "no local cacheWrite SKU", not
 * "no cache", and null would disable OCC for every model in actual use.
 */
export function resolveCacheRatioFromCost(
  ratioConfig: number | 'auto',
  cost?: { input?: number; cacheRead?: number; cacheWrite?: number } | null,
  identity?: { provider?: string; modelId?: string } | null,
): number | null {
  if (typeof ratioConfig === 'number') {
    return Number.isFinite(ratioConfig) && ratioConfig >= 0 ? ratioConfig : null;
  }

  if (cost) {
    const read = cost.cacheRead ?? 0;
    const write = cost.cacheWrite ?? 0;
    const input = cost.input ?? 0;
    if (read > 0 && write > 0) return write / read;
    if (read > 0 && write === 0 && input > 0) return input / read;
  }

  const familyKey = `${identity?.provider ?? ''}/${identity?.modelId ?? ''}`.toLowerCase();
  for (const [family, ratio] of Object.entries(PROVIDER_FAMILY_CACHE_RATIOS)) {
    if (familyKey.includes(family)) return ratio;
  }
  return TOKEN_ACCOUNT_CACHE_RATIO;
}

function compactionMessageCount(entries: readonly SessionEntry[], startIndex: number, endIndex: number): number {
  let count = 0;
  for (let index = startIndex; index < endIndex; index++) {
    const entry = entries[index];
    if (entry && entry.type !== 'compaction' && sessionEntryToContextMessages(entry).length > 0) count++;
  }
  return count;
}

/** Appends the abort marker pi's cut-point search expects after our intentional abort. */
function branchAfterAbort(entries: readonly SessionEntry[]): SessionEntry[] {
  return [
    ...entries,
    {
      type: 'message',
      id: 'pi-herdr-online-context-compact-abort-marker',
      parentId: entries.at(-1)?.id ?? null,
      timestamp: new Date(0).toISOString(),
      message: {
        role: 'assistant',
        content: [],
        api: 'pi-herdr',
        provider: 'pi-herdr',
        model: 'aborted',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'aborted',
        timestamp: 0,
      },
    } as SessionEntry,
  ];
}

/** Would pi's own compaction find history to summarize on this branch? OCC must not abort otherwise. */
export function nativeCompactionFeasible(entries: readonly SessionEntry[], keepRecentTokens: number): boolean {
  if (!Array.isArray(entries) || entries.length === 0) return false;
  const path = branchAfterAbort(entries);
  let startIndex = 0;
  for (let index = path.length - 1; index >= 0; index--) {
    const entry = path[index];
    if (entry?.type !== 'compaction') continue;
    const keptIndex = path.findIndex((item) => item.id === entry.firstKeptEntryId);
    startIndex = keptIndex >= 0 ? keptIndex : index + 1;
    break;
  }

  const cut = findCutPoint(path, startIndex, path.length, keepRecentTokens);
  const historyEnd = cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptEntryIndex;
  const historyMessages = historyEnd > startIndex ? compactionMessageCount(path, startIndex, historyEnd) : 0;
  const prefixMessages =
    cut.isSplitTurn && cut.turnStartIndex >= 0
      ? compactionMessageCount(path, cut.turnStartIndex, cut.firstKeptEntryIndex)
      : 0;
  return historyMessages > 0 || prefixMessages > 0;
}
