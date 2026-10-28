/**
 * D100 Online Context Compact Coordinator: tracks tool-sourced todo completion boundaries, evaluates
 * KV-cache economics and window protection on turn_end, aborts the in-flight turn, runs pi's native
 * compaction, then continues the task. State persists to session entries (branch rebuilds restore it).
 */

import type { CompactionResult, ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { decideCompaction, DEFAULT_COMPACTION_ECONOMICS, estimateRemainingRequests, MAX_BOUNDARY_SAMPLES, nativeCompactionFeasible, resolveCacheRatioFromCost, type CompactionDecision } from './compact-economics-core.ts';
import type { TodoItem } from './todo-core.ts';
import type { TodoCompletionSource } from './todos-service.ts';
import { SUMMARY_THINKING_LEVELS, type OnlineContextCompactConfig } from './efficiency-config-core.ts';
import { appendEfficiencyLog, efficiencyLogPath, resolveSessionRoot } from './efficiency-store.ts';
import { swallow } from './swallow.ts';

export const COMPACT_STATE_CUSTOM_TYPE = 'pi-herdr.efficiency-state';
export const COMPACTION_CONTINUE_TYPE = 'pi-herdr.compaction-continue';
/** Shown to the model after a successful OCC. Names the abort so it is not retried as a failure. */
export const COMPACTION_CONTINUE_TEXT =
  'Online context compaction finished. The preceding abort ("This operation was aborted" / "Operation aborted") was this compaction aborting the in-flight turn on purpose — not a model failure, not a user cancel, and not a reason to retry that call. Active tasks are preserved. Continue the remaining work.';
/**
 * Cross-session compaction markers: OCC's abort lands in the child transcript as an assistant
 * message with stopReason 'error', which a master's poller would read as a settled turn. The
 * inflight/settled pair gives it a "do not settle" window pane state cannot provide (pane shows idle).
 */
export const COMPACTION_INFLIGHT_TYPE = 'pi-herdr.compaction-inflight';
export const COMPACTION_SETTLED_TYPE = 'pi-herdr.compaction-settled';
const DEFAULT_KEEP_RECENT_TOKENS = 20_000;
const DEFAULT_MEMO_TOKENS = 1_000;
/**
 * A non-compacting decision is revisited after this many provider requests even without a fresh todo
 * boundary: an empty or stale todo list must not block OCC until the session ends (observed: 25/43
 * decisions deferred at zero remaining boundaries, with a median of 45 further requests).
 */
export const DEFERRED_REEVALUATION_REQUESTS = 10;

/**
 * Prefix-cache hit evidence is smoothed toward this many fully cached prefix tokens, so a single
 * early miss cannot multiply the expected saving (~15 requests of a 60k context).
 */
export const CACHE_HIT_PRIOR_TOKENS = 1_000_000;
/** Past this many observed prefix tokens both sums halve, so the rate tracks recent provider behavior. */
export const CACHE_HIT_WINDOW_TOKENS = 20_000_000;

/** Fields persisted in the state marker; `version: 1` gates restores. */
interface CoordinatorState {
  version: 1;
  epoch: number;
  completedBoundaryRequestCounts: number[];
  carriedDebtTokens: number;
  cacheDebtRepaymentTokens: number;
  priorCompactionCount: number;
  positiveContextDeltaTotal: number;
  positiveContextDeltaCount: number;
  lastContextTokens: number | null;
  currentBoundaryRequestCount: number;
  /** Request count of the last non-compacting decision; -1 when no re-evaluation is scheduled. */
  lastEvaluationRequestCount: number;
  /**
   * Context tokens pi estimated right after the last compaction (0 = unknown). Used as the retained
   * floor for archive savings: fixed system-prompt/keepRecent arithmetic excludes tool schemas.
   */
  retainedTokensAfterCompaction: number;
  consecutiveCompactionFailures: number;
  /** Prompt tokens of the previous request, summed per observed request (the reusable prefix). */
  cachePrefixTokens: number;
  /** Of those, tokens the provider served from cache. */
  cacheReadTokens: number;
  /** P1-3: turn-end compact decisions to skip after a failure (each abort costs an in-flight turn). */
  compactBackoffTurnEnds: number;
}

const NUMERIC_STATE_FIELDS = [
  'epoch',
  'carriedDebtTokens',
  'cacheDebtRepaymentTokens',
  'priorCompactionCount',
  'positiveContextDeltaTotal',
  'positiveContextDeltaCount',
  'currentBoundaryRequestCount',
  'lastEvaluationRequestCount',
  'retainedTokensAfterCompaction',
  'consecutiveCompactionFailures',
  'cachePrefixTokens',
  'cacheReadTokens',
  'compactBackoffTurnEnds',
] as const satisfies readonly (keyof CoordinatorState)[];

function initialCoordinatorState(): CoordinatorState {
  return {
    version: 1,
    epoch: 0,
    completedBoundaryRequestCounts: [],
    carriedDebtTokens: 0,
    cacheDebtRepaymentTokens: 0,
    priorCompactionCount: 0,
    positiveContextDeltaTotal: 0,
    positiveContextDeltaCount: 0,
    lastContextTokens: null,
    currentBoundaryRequestCount: 0,
    lastEvaluationRequestCount: -1,
    retainedTokensAfterCompaction: 0,
    consecutiveCompactionFailures: 0,
    cachePrefixTokens: 0,
    cacheReadTokens: 0,
    compactBackoffTurnEnds: 0,
  };
}

export function restoreCoordinatorState(entries: readonly unknown[]): CoordinatorState {
  const base = initialCoordinatorState();
  if (!Array.isArray(entries)) return base;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as { type?: string; customType?: string; data?: unknown };
    if (entry?.type !== 'custom' || entry.customType !== COMPACT_STATE_CUSTOM_TYPE) continue;
    const d = entry.data as Partial<CoordinatorState> | null | undefined;
    if (!d || d.version !== 1 || !Array.isArray(d.completedBoundaryRequestCounts)) continue;
    for (const field of NUMERIC_STATE_FIELDS) {
      const value = d[field];
      if (typeof value === 'number') base[field] = value;
    }
    if (typeof d.lastContextTokens === 'number') base.lastContextTokens = d.lastContextTokens;
    base.completedBoundaryRequestCounts = [...d.completedBoundaryRequestCounts];
    return base;
  }
  return base;
}

function averageContextIncrement(state: CoordinatorState): number | null {
  return state.positiveContextDeltaCount > 0
    ? state.positiveContextDeltaTotal / state.positiveContextDeltaCount
    : null;
}

export function prefixCacheHitRate(state: CoordinatorState): number {
  return (state.cacheReadTokens + CACHE_HIT_PRIOR_TOKENS) / (state.cachePrefixTokens + CACHE_HIT_PRIOR_TOKENS);
}

function remainingTodos(todos: readonly TodoItem[]): readonly TodoItem[] {
  return todos.filter((it) => it.status !== 'completed' && it.status !== 'abandoned');
}

/**
 * Todos that pace the remaining-work horizon. Blocked items wait on something outside the agent's
 * control and may never become actionable, so they must not inflate the horizon (observed: 7 blocked
 * items were counted as seven remaining boundaries).
 */
export function horizonTodos(todos: readonly TodoItem[]): readonly TodoItem[] {
  return remainingTodos(todos).filter((it) => it.status !== 'blocked');
}

/** P1-3: bound the payload — a huge open-task list inflates the summary request itself. */
function compactionInstructions(todos: readonly TodoItem[]): string {
  const remaining = remainingTodos(todos);
  const taskLines = remaining
    .slice(0, 25)
    .map((it) => `- [${it.status}] ${it.content.slice(0, 160)}${it.blocker ? ` (waiting on: ${it.blocker.slice(0, 80)})` : ''}`)
    .join('\n');
  const elided = remaining.length > 25 ? `\n… (+${remaining.length - 25} more, elided)` : '';
  return [
    'Preserve completed work, verification results, important decisions, and remaining work.',
    remaining.length > 0 ? `Active/remaining tasks to preserve:\n${taskLines}${elided}` : 'All listed tasks are completed.',
  ].join('\n\n');
}

export class CompactCoordinator {
  state: CoordinatorState = initialCoordinatorState();
  compactionInFlight = false;
  intentionalAbort = false;
  selectedCompaction: CompactionDecision | null = null;
  pendingBoundaryCompleted = false;
  /** Last carried-debt value written to the session; 0 on a fresh state (nothing to persist). */
  private persistedDebtTokens = 0;
  /** Prompt size of the previous request; 0 = no reusable prefix (session start, after compaction). */
  private lastPromptTokens = 0;

  recordBoundaryCompleted(count: number, source?: TodoCompletionSource): void {
    // Only model tool calls count, and the sample is the requests spent reaching this boundary.
    if (source !== 'tool' || count <= 0) return;
    this.pendingBoundaryCompleted = true;
    if (this.state.currentBoundaryRequestCount <= 0) return;
    this.state.completedBoundaryRequestCounts.push(this.state.currentBoundaryRequestCount);
    if (this.state.completedBoundaryRequestCounts.length > MAX_BOUNDARY_SAMPLES) {
      this.state.completedBoundaryRequestCounts.splice(
        0,
        this.state.completedBoundaryRequestCounts.length - MAX_BOUNDARY_SAMPLES,
      );
    }
    this.state.currentBoundaryRequestCount = 0;
  }

  onBeforeProviderRequest(contextTokens: number): void {
    this.state.currentBoundaryRequestCount++;
    // Fallback calibration: when pi omitted estimatedTokensAfter, the first request after a
    // compaction measures the retained context (summary + kept turns + fixed overhead) directly.
    if (
      this.state.retainedTokensAfterCompaction === 0 &&
      this.state.priorCompactionCount > 0 &&
      contextTokens > 0
    ) {
      this.state.retainedTokensAfterCompaction = contextTokens;
    }
    if (this.state.carriedDebtTokens > 0 && this.state.cacheDebtRepaymentTokens > 0) {
      this.state.carriedDebtTokens = Math.max(
        0,
        this.state.carriedDebtTokens - this.state.cacheDebtRepaymentTokens,
      );
      if (this.state.carriedDebtTokens === 0) this.state.cacheDebtRepaymentTokens = 0;
    }
    if (this.state.lastContextTokens !== null && contextTokens > this.state.lastContextTokens) {
      this.state.positiveContextDeltaTotal += contextTokens - this.state.lastContextTokens;
      this.state.positiveContextDeltaCount++;
    }
    this.state.lastContextTokens = contextTokens;
  }

  /**
   * Measures how much of the previous request's prompt the provider served from cache. Fed from each
   * assistant message's `usage`; a request with no usage (error, abort) measures nothing.
   */
  onAssistantUsage(usage: { input?: number; cacheRead?: number; cacheWrite?: number } | undefined): void {
    const cacheRead = usage?.cacheRead ?? 0;
    const promptTokens = (usage?.input ?? 0) + cacheRead + (usage?.cacheWrite ?? 0);
    if (promptTokens <= 0) return;
    if (this.lastPromptTokens > 0) {
      this.state.cachePrefixTokens += this.lastPromptTokens;
      this.state.cacheReadTokens += Math.min(cacheRead, this.lastPromptTokens);
      if (this.state.cachePrefixTokens > CACHE_HIT_WINDOW_TOKENS) {
        this.state.cachePrefixTokens /= 2;
        this.state.cacheReadTokens /= 2;
      }
    }
    this.lastPromptTokens = promptTokens;
  }

  onInput(event: { text?: string; source?: string; streamingBehavior?: string }): void {
    // Ignore messages dispatched by extensions (D96 reminders, pipe injections, followUps).
    if (event.source === 'extension' || event.text?.startsWith('CORRECTION:')) return;

    const fromHuman =
      event.source === 'interactive' ||
      event.source === 'rpc' ||
      event.source === undefined;
    if (!fromHuman) return;

    this.selectedCompaction = null;
    this.intentionalAbort = false;
    this.pendingBoundaryCompleted = false;
    this.state.lastEvaluationRequestCount = -1;
    // completedBoundaryRequestCounts deliberately survives: it measures requests-per-boundary pacing,
    // which holds across human turns — clearing it pinned expectedRemainingRequests at 1 every prompt.
    this.state.carriedDebtTokens = 0;
    this.state.epoch++;
  }

  onTurnEnd(opts: {
    ctx: ExtensionContext;
    todos: readonly TodoItem[];
    config: OnlineContextCompactConfig;
    pi: ExtensionAPI;
    /** stopReason of the assistant message that ended this turn ('toolUse' = work continues). */
    lastStopReason: string | null;
    cancelReminder?: () => void;
  }): void {
    if (opts.config.enabled) this.persistDebt(opts.pi);

    const boundary = this.pendingBoundaryCompleted;
    this.pendingBoundaryCompleted = false;

    if (this.selectedCompaction) return;
    if (!opts.config.enabled) return;
    // Safety guard: never abort while the user has a queued message.
    if (opts.ctx.hasPendingMessages?.()) return;

    // Revisit a non-compacting decision every N provider requests. Without this, a deferral made
    // when the todo list is momentarily empty is never reassessed: the horizon stays collapsed at 1
    // while the agent keeps working (evidence: 25/43 deferrals with zero open todos, median 45
    // further requests, up to 249). Only a tool-call turn proves the work continues; a final 'stop'
    // turn must not trigger a summary (and a spurious continuation) after the task is done.
    const requestCount = this.state.currentBoundaryRequestCount;
    const deferredDue =
      opts.lastStopReason === 'toolUse' &&
      this.state.lastEvaluationRequestCount >= 0 &&
      requestCount - this.state.lastEvaluationRequestCount >= DEFERRED_REEVALUATION_REQUESTS;
    if (!boundary && !deferredDue) return;

    const usage = opts.ctx.getContextUsage?.();
    const contextTokens =
      typeof usage?.tokens === 'number' && usage.tokens > 0
        ? usage.tokens
        : this.state.lastContextTokens ?? 0;
    const contextWindowTokens = usage?.contextWindow ?? opts.ctx.model?.contextWindow ?? null;
    // System prompt is re-sent verbatim, so it is never part of the compressible archive; ~4 chars/token.
    const fixedTokens = Math.ceil(Buffer.byteLength(opts.ctx.getSystemPrompt?.() ?? '') / 4);
    const keepRecentTokens = opts.config.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS;
    const memoTokens = DEFAULT_MEMO_TOKENS;
    // pi's estimatedTokensAfter is the measured retained context (summary + kept recent turns + all
    // fixed overhead, tool schemas included). Prefer it over the fixedTokens/keepRecent arithmetic,
    // which ignores tool schemas and understates the retained floor (observed: savings overstated
    // ~23%). The estimate already contains the memo, so rebuild the gross archive the model expects.
    const retainedTokens = this.state.retainedTokensAfterCompaction;
    const archiveTokens = retainedTokens > 0 && retainedTokens < contextTokens
      ? contextTokens - retainedTokens + memoTokens
      : Math.max(0, contextTokens - fixedTokens - keepRecentTokens);

    const decision = decideCompaction({
      writeTokens: contextTokens,
      archiveTokens,
      memoTokens,
      contextTokens,
      completedBoundaryRequestCounts: this.state.completedBoundaryRequestCounts,
      remainingBoundaries: horizonTodos(opts.todos).length,
      observedRequestsSinceBoundary: requestCount,
      averageContextTokenIncrement: averageContextIncrement(this.state),
      contextWindowTokens,
      priorCompactionCount: this.state.priorCompactionCount,
      carriedDebtTokens: this.state.carriedDebtTokens,
      cacheDebtRepaymentTokens: this.state.cacheDebtRepaymentTokens,
      cacheWriteReadRatio: resolveCacheRatioFromCost(
        opts.config.cacheWriteReadRatio,
        opts.ctx.model?.cost,
        { provider: opts.ctx.model?.provider, modelId: opts.ctx.model?.id },
      ),
      prefixCacheHitRate: prefixCacheHitRate(this.state),
      economics: {
        ...DEFAULT_COMPACTION_ECONOMICS,
        firstCompactionRequestScale: opts.config.firstCompactionRequestScale,
        subsequentCompactionMargin: opts.config.subsequentCompactionMargin,
      },
    });

    if (!decision.compact) {
      this.state.lastEvaluationRequestCount = requestCount;
      if (opts.config.logEnabled) this.logDecision(opts.ctx, decision);
      return;
    }

    // P1-3 backoff: after a failed summarization, skip compact decisions for a bounded window —
    // each attempt aborts an in-flight turn, so a doomed retry burns turns. (The token-cap failure
    // class is gone since pi 1.4.0 uncapped summary output; transient timeouts/aborts remain.)
    if (this.state.compactBackoffTurnEnds > 0) {
      this.state.compactBackoffTurnEnds--;
      this.state.lastEvaluationRequestCount = requestCount;
      if (opts.config.logEnabled) {
        this.logDecision(opts.ctx, { ...decision, compact: false, reason: 'failure_backoff' });
      }
      return;
    }

    const branch = opts.ctx.sessionManager?.getBranch?.() ?? [];
    if (!nativeCompactionFeasible(branch, keepRecentTokens)) {
      this.state.lastEvaluationRequestCount = requestCount;
      if (opts.config.logEnabled) {
        this.logDecision(opts.ctx, { ...decision, compact: false, reason: 'native_not_compactable' });
      }
      return;
    }

    this.state.lastEvaluationRequestCount = -1;
    this.selectedCompaction = decision;
    this.intentionalAbort = true;
    opts.cancelReminder?.();
    opts.ctx.abort();
  }

  async onAgentSettled(opts: {
    ctx: ExtensionContext;
    todos: readonly TodoItem[];
    pi: ExtensionAPI;
    config: OnlineContextCompactConfig;
    cancelReminder?: () => void;
    onBeforeCompact?: (sessionRoot: string, ctx: ExtensionContext) => Promise<void>;
  }): Promise<void> {
    if (!this.selectedCompaction) return;
    if (!opts.ctx.isIdle()) {
      // The settlement is not consumable (another run already started): drop the stale selection.
      // Keeping it would latch OCC off every later turn and suppress settle-wake notices until the
      // next human input; a fresh decision re-selects when the economics still hold.
      this.selectedCompaction = null;
      this.intentionalAbort = false;
      return;
    }

    // Announce the compaction window before the summary request starts: the supervising master
    // polls this file, and its observation window is shorter than a large-context compaction.
    this.appendMarker(opts.pi, COMPACTION_INFLIGHT_TYPE, { at: Date.now() });
    const decision = this.selectedCompaction;
    this.selectedCompaction = null;

    opts.cancelReminder?.();
    this.compactionInFlight = true;

    const sessionRoot = resolveSessionRoot(
      opts.ctx.sessionManager?.getSessionDir?.(),
      opts.ctx.sessionManager?.getSessionId?.(),
    );
    if (sessionRoot && opts.onBeforeCompact) {
      try {
        await opts.onBeforeCompact(sessionRoot, opts.ctx);
      } catch {
      }
    }

    // pi summarizes at the session's thinking level; at `max`, 67% of summary output was reasoning
    // and one compaction took 144 s. Cap it for the summary only, and always restore the session's.
    const sessionThinking = opts.pi.getThinkingLevel();
    const cap = opts.config.summaryThinkingLevel;
    const lowered = cap !== 'inherit'
      && SUMMARY_THINKING_LEVELS.indexOf(cap) < SUMMARY_THINKING_LEVELS.indexOf(sessionThinking);
    if (lowered) opts.pi.setThinkingLevel(cap);
    const startMs = Date.now();
    const settled = Promise.withResolvers<void>();
    try {
      opts.ctx.compact({
        customInstructions: compactionInstructions(opts.todos),
        onComplete: (compaction) => {
          try {
            this.finishCompaction(opts, decision, startMs, compaction);
          } finally {
            settled.resolve();
          }
        },
        onError: (error) => {
          try {
            this.failCompaction(opts, decision, startMs, error);
          } finally {
            settled.resolve();
          }
        },
      });
      await settled.promise;
    } finally {
      if (lowered) opts.pi.setThinkingLevel(sessionThinking);
    }
  }

  private finishCompaction(
    opts: { ctx: ExtensionContext; pi: ExtensionAPI; config: OnlineContextCompactConfig },
    decision: CompactionDecision,
    startMs: number,
    compaction: CompactionResult | undefined,
  ): void {
    const usage = compaction?.usage;
    // Debt is the summary request's real extra spend, converted to cache-read-token units so the
    // ledger stays in the same unit as savingTokens. Fall back to the modeled rewrite surcharge when
    // pi reports no usage or the model has no cache-read price.
    const cacheReadPricePerToken = (opts.ctx.model?.cost?.cacheRead ?? 0) / 1_000_000;
    const measuredDebtTokens =
      usage !== undefined && cacheReadPricePerToken > 0
        ? usage.cost.total / cacheReadPricePerToken
        : null;
    const summaryDebtTokens =
      measuredDebtTokens ?? decision.writeTokens * (decision.incrementalCacheCostRatio ?? 0);
    // Unpaid debt from the previous compaction survives: repayment happens per subsequent request,
    // so a new compaction must not write off what the ledger has not collected yet.
    const unpaidDebtTokens = this.state.carriedDebtTokens;

    this.state.priorCompactionCount++;
    this.state.carriedDebtTokens = unpaidDebtTokens + summaryDebtTokens;
    this.state.cacheDebtRepaymentTokens = decision.savingTokensPerRequest;
    // The summary replaced the prefix: the next request is a cold rewrite the debt already prices.
    this.lastPromptTokens = 0;
    this.state.retainedTokensAfterCompaction =
      typeof compaction?.estimatedTokensAfter === 'number' ? compaction.estimatedTokensAfter : 0;
    // The pacing window restarts after a compaction: requests before it measured the old context.
    this.state.currentBoundaryRequestCount = 0;
    this.state.lastEvaluationRequestCount = -1;
    this.state.epoch++;
    this.state.consecutiveCompactionFailures = 0;
    this.state.compactBackoffTurnEnds = 0;
    this.appendMarker(opts.pi, COMPACT_STATE_CUSTOM_TYPE, this.state);
    this.persistedDebtTokens = this.state.carriedDebtTokens;

    if (opts.config.logEnabled) {
      this.logCompact(opts.ctx, {
        decision: decision.reason,
        writeTokens: decision.writeTokens,
        archiveTokens: decision.archiveTokens,
        savedTokens: Math.max(0, decision.archiveTokens - decision.memoTokens),
        breakevenRequests: decision.breakevenRequests,
        expectedRemainingRequests: decision.expectedRemainingRequests,
        carriedDebtTokens: this.state.carriedDebtTokens,
        summaryTokens: usage !== undefined
          ? usage.output
          : Math.ceil((compaction?.summary.length ?? 0) / 4),
        priorCompactionCount: this.state.priorCompactionCount,
        durationMs: Date.now() - startMs,
      });
    }

    this.sendContinuation(
      opts.pi,
      COMPACTION_CONTINUE_TEXT,
      false,
    );
    // Settled marker last: the master's poller releases its hold as soon as it appears.
    this.appendMarker(opts.pi, COMPACTION_SETTLED_TYPE, { outcome: 'completed', at: Date.now() });
    this.compactionInFlight = false;
    this.intentionalAbort = false;
  }

  private failCompaction(
    opts: { ctx: ExtensionContext; pi: ExtensionAPI; config: OnlineContextCompactConfig },
    decision: CompactionDecision,
    startMs: number,
    error: unknown,
  ): void {
    this.compactionInFlight = false;
    this.intentionalAbort = false;
    const message = error instanceof Error ? error.message : String(error);
    // 'Compaction cancelled' / AbortError mean the user (or pi) cancelled on purpose: telemetry keeps
    // that apart from real failures, and a cancel must NOT trigger a continuation turn.
    const cancelled =
      error instanceof Error &&
      (error.name === 'AbortError' || error.message === 'Compaction cancelled');

    // Release the cross-session hold in every outcome — the cancel path returns before continuing.
    this.appendMarker(opts.pi, COMPACTION_SETTLED_TYPE, {
      outcome: cancelled ? 'cancelled' : 'failed',
      at: Date.now(),
    });
    // P1-3: record the failure and back off exponentially (cap 4 skipped decisions). Increment
    // before logging so the record carries this failure's ordinal instead of the previous count.
    if (!cancelled) {
      this.state.consecutiveCompactionFailures++;
      this.state.compactBackoffTurnEnds = Math.min(2 ** this.state.consecutiveCompactionFailures, 4);
    }
    if (opts.config.logEnabled) {
      this.logCompact(opts.ctx, {
        event: 'compaction-failed',
        decision: decision.reason,
        cancelled,
        error: message,
        consecutiveCompactionFailures: this.state.consecutiveCompactionFailures,
        durationMs: Date.now() - startMs,
      });
    }
    if (cancelled) return;

    // Persist the bumped counters: state is restored from this marker, so a restart without it
    // would reset the P1-3 backoff window and retry the doomed compaction immediately.
    this.appendMarker(opts.pi, COMPACT_STATE_CUSTOM_TYPE, this.state);
    this.persistedDebtTokens = this.state.carriedDebtTokens;

    // OCC aborted the turn on purpose, so a failed compaction would leave the session parked on an
    // aborted message; the notice must be visible rather than a silent failure.
    const approxTokens = this.state.lastContextTokens;
    this.sendContinuation(
      opts.pi,
      `Context compaction FAILED (${message}). `
        + `Context ≈ ${approxTokens != null ? `${Math.round(approxTokens / 1000)}K tokens` : 'near the window limit'}; `
        + `OCC backs off for the next ${this.state.compactBackoffTurnEnds} opportunities. `
        + 'If this repeats, run /compact manually, prune large outputs, or restart the session.',
      true,
    );
  }

  /** Best-effort session entry write: onAgentSettled runs detached, so a full disk must not become an
   *  unhandled rejection (a missing marker only delays one settlement notice). */
  private appendMarker(pi: ExtensionAPI, customType: string, data: unknown): void {
    try {
      pi.appendEntry(customType, data);
    } catch (err) {
      swallow(`compact.append-${customType}`, err);
    }
  }

  /**
   * Persist repayment progress when the debt moves. restoreCoordinatorState reads the last state
   * marker, so an in-memory-only ledger resurrects already-repaid debt after a resume.
   */
  private persistDebt(pi: ExtensionAPI): void {
    if (this.persistedDebtTokens === this.state.carriedDebtTokens) return;
    this.appendMarker(pi, COMPACT_STATE_CUSTOM_TYPE, this.state);
    this.persistedDebtTokens = this.state.carriedDebtTokens;
  }

  /** Resume the task after compaction; must never throw into the detached settled handler. */
  private sendContinuation(pi: ExtensionAPI, content: string, display: boolean): void {
    try {
      pi.sendMessage({ customType: COMPACTION_CONTINUE_TYPE, content, display }, { triggerTurn: true });
    } catch {
    }
  }

  rebuildFromBranch(entries: readonly unknown[]): void {
    this.state = restoreCoordinatorState(entries);
    this.persistedDebtTokens = this.state.carriedDebtTokens;
    this.selectedCompaction = null;
    this.compactionInFlight = false;
    this.intentionalAbort = false;
    this.pendingBoundaryCompleted = false;
  }

  getRemainingHorizon(remainingBoundaries = 3, contextWindowTokens: number | null = null): number {
    const counts = this.state.completedBoundaryRequestCounts;
    if (counts.length === 0) return 4; // No samples yet: conservative default horizon.
    const est = estimateRemainingRequests({
      completedBoundaryRequestCounts: counts,
      remainingBoundaries,
      scale: DEFAULT_COMPACTION_ECONOMICS.remainingRequestScale,
      contextTokens: this.state.lastContextTokens ?? 0,
      contextWindowTokens,
      averageContextTokenIncrement: averageContextIncrement(this.state),
      observedRequestsSinceBoundary: this.state.currentBoundaryRequestCount,
    });
    return Math.max(1, est.expectedRemainingRequests);
  }

  /** Append one compact.jsonl record (shared envelope); logging is always best-effort. */
  private logCompact(ctx: ExtensionContext, fields: Record<string, unknown>): void {
    const sessionId = ctx.sessionManager?.getSessionId?.();
    const root = resolveSessionRoot(ctx.sessionManager?.getSessionDir?.(), sessionId);
    if (!root) return;
    void appendEfficiencyLog(efficiencyLogPath(root, 'compact'), {
      schema: 'pier-efficiency/1',
      mechanism: 'onlineContextCompact',
      ts: new Date().toISOString(),
      sessionId: sessionId ?? 'unknown',
      epoch: this.state.epoch,
      ...fields,
    }).catch(() => {});
  }

  private logDecision(ctx: ExtensionContext, decision: CompactionDecision): void {
    this.logCompact(ctx, {
      event: 'decision',
      decision: decision.reason,
      compact: decision.compact,
      writeTokens: decision.writeTokens,
      archiveTokens: decision.archiveTokens,
      breakevenRequests: decision.breakevenRequests,
      expectedRemainingRequests: decision.expectedRemainingRequests,
      // Without resolvedRatio/model a cache_ratio_unavailable run is undiagnosable from logs alone.
      resolvedRatio: decision.cacheWriteReadRatio,
      incrementalCacheCostRatio: decision.incrementalCacheCostRatio,
      prefixCacheHitRate: decision.prefixCacheHitRate,
      savingTokensPerRequest: decision.savingTokensPerRequest,
      remainingBoundaries: decision.remainingBoundaries,
      model: ctx.model?.id ?? undefined,
      provider: ctx.model?.provider ?? undefined,
    });
  }
}
