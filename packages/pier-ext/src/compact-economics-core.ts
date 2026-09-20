/**
 * D100 Online Context Compact Economics & Feasibility Core.
 *
 * Implements pure economics decision-making, request horizon estimation,
 * cache debt tracking, and native compaction feasibility preflights.
 *
 * Zero-dependency / pure algorithm core (except Pi's public cut point helper).
 */

import {
  findCutPoint,
  sessionEntryToContextMessages,
  type SessionEntry,
} from '@earendil-works/pi-coding-agent';

export interface CompactionEconomics {
  readonly remainingRequestScale: number;
  readonly remainingRequestStddevK: number;
  readonly windowReserveTokens: number;
  readonly firstCompactionRequestScale: number;
  readonly subsequentCompactionMargin: number;
}

export const DEFAULT_COMPACTION_ECONOMICS: CompactionEconomics = Object.freeze({
  remainingRequestScale: 1.0,
  remainingRequestStddevK: 0.0,
  windowReserveTokens: 16_384,
  firstCompactionRequestScale: 2.0,
  subsequentCompactionMargin: 1.5,
});

/**
 * Token-account cache ratio: a compaction request re-reads the whole current
 * context once (writeTokens), so breakeven = writeTokens / savingTokens ⇔ ratio 2.
 * `auto` fallback when no usable cache pricing exists (2026-09-17 review: every
 * model actually in use reports zero cacheWrite; the old `null` disabled OCC
 * for all of them — 61/61 decisions `cache_ratio_unavailable`, zero compactions).
 */
export const TOKEN_ACCOUNT_CACHE_RATIO = 2.0;

/** Provider-family `auto` fallbacks (implicit-cache families without a write SKU). */
const PROVIDER_FAMILY_CACHE_RATIOS: Readonly<Record<string, number>> = Object.freeze({
  gemini: 4,
  grok: 10,
  deepseek: 10,
});

export type CompactionReason =
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

export interface RequestHorizonEstimate {
  readonly completedBoundaryRequestCounts: readonly number[];
  readonly requestsPerBoundaryMean: number;
  readonly requestsPerBoundaryLowerBound: number;
  readonly unboundedExpectedRemainingRequests: number;
  readonly averageContextTokenIncrement: number | null;
  readonly windowRequestUpperBound: number | null;
  readonly expectedRemainingRequests: number;
}

export interface CompactionDecision {
  readonly writeTokens: number;
  readonly archiveTokens: number;
  readonly memoTokens: number;
  readonly contextTokens: number;
  readonly completedBoundaryRequestCounts: readonly number[] | null;
  readonly requestsPerBoundaryMean: number | null;
  readonly requestsPerBoundaryLowerBound: number | null;
  readonly unboundedExpectedRemainingRequests: number | null;
  readonly averageContextTokenIncrement: number | null;
  readonly windowRequestUpperBound: number | null;
  readonly expectedRemainingRequests: number | null;
  readonly breakevenRequests: number | null;
  readonly combinedBreakevenRequests: number | null;
  readonly effectiveHorizonRequests: number | null;
  readonly remainingBoundaries: number;
  readonly cacheWriteReadRatio: number | null;
  readonly incrementalCacheCostRatio: number | null;
  readonly priorCompactionCount: number;
  readonly carriedDebtTokens: number;
  readonly cacheDebtRepaymentTokens: number;
  readonly compact: boolean;
  readonly reason: CompactionReason;
}

const MINIMUM_VARIANCE_SAMPLES = 3;
const SMALL_SAMPLE_SCALE = 0.5;
/** Retained boundary-request sample cap so the mean tracks recent pacing. */
export const MAX_BOUNDARY_SAMPLES = 16;

export function estimateRemainingRequests(input: {
  readonly completedBoundaryRequestCounts: readonly number[];
  readonly remainingBoundaries: number;
  readonly scale: number;
  readonly standardDeviationK: number;
  readonly contextTokens: number;
  readonly contextWindowTokens: number | null;
  readonly averageContextTokenIncrement: number | null;
}): RequestHorizonEstimate {
  const counts = input.completedBoundaryRequestCounts;
  const mean =
    counts.reduce((total, count) => total + count, 0) /
    Math.max(1, counts.length);
  let lowerBound = mean;
  if (input.standardDeviationK !== 0) {
    if (counts.length < MINIMUM_VARIANCE_SAMPLES) {
      lowerBound *= SMALL_SAMPLE_SCALE;
    } else {
      const variance = counts.reduce((total, count) => total + (count - mean) ** 2, 0);
      const deviation = Math.sqrt(variance / (counts.length - 1));
      lowerBound = Math.max(0, mean - input.standardDeviationK * deviation);
    }
  }

  const unboundedExpectedRemainingRequests =
    1 + Math.floor(lowerBound * Math.max(0, input.remainingBoundaries) * input.scale);
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
    completedBoundaryRequestCounts: [...counts],
    requestsPerBoundaryMean: mean,
    requestsPerBoundaryLowerBound: lowerBound,
    unboundedExpectedRemainingRequests,
    averageContextTokenIncrement: input.averageContextTokenIncrement,
    windowRequestUpperBound,
    expectedRemainingRequests:
      windowRequestUpperBound === null
        ? unboundedExpectedRemainingRequests
        : Math.min(unboundedExpectedRemainingRequests, windowRequestUpperBound),
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
  readonly economics?: CompactionEconomics;
}): CompactionDecision {
  const economics = input.economics ?? DEFAULT_COMPACTION_ECONOMICS;
  const horizon =
    input.completedBoundaryRequestCounts === null
      ? null
      : estimateRemainingRequests({
          completedBoundaryRequestCounts: input.completedBoundaryRequestCounts,
          remainingBoundaries: input.remainingBoundaries,
          scale: economics.remainingRequestScale,
          standardDeviationK: economics.remainingRequestStddevK,
          contextTokens: input.contextTokens,
          contextWindowTokens: input.contextWindowTokens,
          averageContextTokenIncrement: input.averageContextTokenIncrement,
        });

  const savingTokens = input.archiveTokens - input.memoTokens;
  const incrementalCacheCostRatio =
    input.cacheWriteReadRatio === null ? null : Math.max(0, input.cacheWriteReadRatio - 1);

  const breakevenRequests =
    savingTokens > 0 && incrementalCacheCostRatio !== null
      ? (input.writeTokens * incrementalCacheCostRatio) / savingTokens
      : null;

  const combinedBreakevenRequests =
    savingTokens > 0 && incrementalCacheCostRatio !== null
      ? (input.carriedDebtTokens + input.writeTokens * incrementalCacheCostRatio) / savingTokens
      : null;
  const firstCompaction = input.priorCompactionCount === 0;
  // The first-compaction relaxation survives cold-start sample noise when real work
  // remains. With zero remaining boundaries the horizon is 1 (nothing left to amortize
  // over); scaling it by firstCompactionRequestScale would "discover" a horizon of 2
  // and burn a full-context summarization for zero future benefit (2026-09-17 review).
  const relaxFirstCompaction = firstCompaction && input.remainingBoundaries > 0;
  const effectiveHorizonRequests =
    horizon === null
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
    horizon !== null &&
    horizon.expectedRemainingRequests > 0 &&
    breakevenRequests !== null &&
    breakevenRequests <= horizon.expectedRemainingRequests;

  const firstEconomic =
    firstCompaction &&
    effectiveHorizonRequests !== null &&
    effectiveHorizonRequests > 0 &&
    breakevenRequests !== null &&
    breakevenRequests <= effectiveHorizonRequests;

  const subsequentMarginOpen =
    !firstCompaction &&
    horizon !== null &&
    breakevenRequests !== null &&
    breakevenRequests * economics.subsequentCompactionMargin <= horizon.expectedRemainingRequests;

  const carriedDebtGateOpen =
    !firstCompaction &&
    horizon !== null &&
    combinedBreakevenRequests !== null &&
    combinedBreakevenRequests <= horizon.expectedRemainingRequests;

  const economic = firstCompaction ? firstEconomic : baseEconomic && subsequentMarginOpen && carriedDebtGateOpen;
  const compressible = savingTokens > 0;
  const compact = compressible && (windowProtection || economic);

  return {
    writeTokens: input.writeTokens,
    archiveTokens: input.archiveTokens,
    memoTokens: input.memoTokens,
    contextTokens: input.contextTokens,
    ...(horizon ?? {
      completedBoundaryRequestCounts: null,
      requestsPerBoundaryMean: null,
      requestsPerBoundaryLowerBound: null,
      unboundedExpectedRemainingRequests: null,
      averageContextTokenIncrement: input.averageContextTokenIncrement,
      windowRequestUpperBound: null,
      expectedRemainingRequests: null,
    }),
    breakevenRequests,
    combinedBreakevenRequests,
    effectiveHorizonRequests,
    remainingBoundaries: input.remainingBoundaries,
    cacheWriteReadRatio: input.cacheWriteReadRatio,
    incrementalCacheCostRatio,
    priorCompactionCount: input.priorCompactionCount,
    carriedDebtTokens: input.carriedDebtTokens,
    cacheDebtRepaymentTokens: input.cacheDebtRepaymentTokens,
    compact,
    reason: !compressible
      ? 'non_positive_saving'
      : windowProtection
        ? 'window_protection'
        : economic
          ? 'economic'
          : horizon === null
            ? 'horizon_unavailable'
            : breakevenRequests === null
              ? 'cache_ratio_unavailable'
              : !firstCompaction && baseEconomic && !subsequentMarginOpen
                ? 'deferred_subsequent_margin'
                : !firstCompaction && baseEconomic && !carriedDebtGateOpen
                  ? 'deferred_carried_debt'
                  : 'deferred_economic',
  };
}

/**
 * Resolve the cache write/read cost ratio for economic compaction decisions.
 *
 * Priority:
 *  1. Explicit numeric config → use as-is (e.g. 12.5 for Anthropic-style pricing)
 *  2. Model cost metadata:
 *     a. cacheWrite > 0 && cacheRead > 0 → write/read (explicit cache SKU)
 *     b. cacheWrite == 0 && cacheRead > 0 && input > 0 → input/cacheRead
 *        (implicit cache: rewriting the prefix is billed at the input price)
 *  3. Provider-family fallback (gemini≈4, grok/deepseek≈10 — implicit-cache
 *     families without a local cacheWrite SKU)
 *  4. Token-account fallback 2.0: a compaction re-reads writeTokens once,
 *     so breakeven = writeTokens/savingTokens ⇔ ratio 2
 *
 * Returns null only for an explicitly invalid numeric config.
 *
 * History (P0-1): `auto` used to return null when cacheWrite==0, reading that
 * as "no KV cache at all". The 2026-09-17 trial disproved it on this machine:
 * grok/deepseek/gemini sessions all show non-zero cacheRead usage while
 * cacheWrite stays 0 — there is no separate write SKU, not "no cache". null
 * disabled OCC for every model actually used (61/61 decisions
 * `cache_ratio_unavailable`, zero compactions). The floor matters as much as
 * the fix: never implicitly fall back below 2.0, because ratio <= 1 zeroes the
 * incremental cost and would compact even on the last boundary with nothing
 * left to amortize (the original P0-1 failure mode).
 */
export function resolveCacheRatioFromCost(
  ratioConfig: number | 'auto',
  cost?: { input?: number; cacheRead?: number; cacheWrite?: number } | null,
  identity?: { provider?: string; modelId?: string } | null,
): number | null {
  // Explicit config takes absolute precedence
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
    if (entry && entry.type !== 'compaction' && sessionEntryToContextMessages(entry).length > 0) {
      count++;
    }
  }
  return count;
}

function branchAfterAbort(entries: readonly SessionEntry[]): SessionEntry[] {
  const last = entries.at(-1);
  const markerProvider = 'pi-herdr';
  return [
    ...entries,
    {
      type: 'message',
      id: 'pi-herdr-online-context-compact-abort-marker',
      parentId: last?.id ?? null,
      timestamp: new Date(0).toISOString(),
      message: {
        role: 'assistant',
        content: [],
        api: markerProvider,
        provider: markerProvider,
        model: 'aborted',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'aborted',
        timestamp: 0,
      },
    } as SessionEntry,
  ];
}

export function nativeCompactionFeasible(entries: readonly SessionEntry[], keepRecentTokens: number): boolean {
  if (!Array.isArray(entries) || entries.length === 0) return false;
  const path = branchAfterAbort(entries);
  let startIndex = 0;
  for (let index = path.length - 1; index >= 0; index--) {
    const entry = path[index];
    if (entry?.type !== 'compaction') continue;
    const keptIndex = path.findIndex((item) => item.id === (entry as { firstKeptEntryId?: string }).firstKeptEntryId);
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
