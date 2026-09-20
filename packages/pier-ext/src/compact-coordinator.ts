/**
 * D100 Online Context Compact Coordinator.
 *
 * Orchestrates:
 *  - Tracking todo completion boundaries (filtered to source === 'tool').
 *  - Evaluating KV-cache economics & window protection on turn_end.
 *  - Guarding against ejecting queued messages (hasPendingMessages check).
 *  - Aborting turn and executing Pi native compaction with custom instructions.
 *  - Feeding remaining tasks forward and injecting continuation turn.
 *  - Persisting state to session entries across branches and restores.
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  decideCompaction,
  DEFAULT_COMPACTION_ECONOMICS,
  estimateRemainingRequests,
  MAX_BOUNDARY_SAMPLES,
  nativeCompactionFeasible,
  resolveCacheRatioFromCost,
  type CompactionDecision,
} from './compact-economics-core.ts';
import type { TodoItem } from './todo-core.ts';
import type { TodoCompletionSource } from './todos-service.ts';
import type { OnlineContextCompactConfig } from './efficiency-config-core.ts';
import {
  appendEfficiencyLog,
  efficiencyLogPath,
  resolveSessionRoot,
} from './efficiency-store.ts';

export const COMPACT_STATE_CUSTOM_TYPE = 'pi-herdr.efficiency-state';
export const COMPACTION_CONTINUE_TYPE = 'pi-herdr.compaction-continue';
export const DEFAULT_KEEP_RECENT_TOKENS = 20_000;
export const DEFAULT_MEMO_TOKENS = 1_000;

export interface CoordinatorState {
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
  /** P1-3: consecutive summarization failures (token-cap class) driving exponential backoff. */
  consecutiveCompactionFailures: number;
  /** P1-3: turn-end compact decisions to skip after a failure (each abort costs an in-flight turn). */
  compactBackoffTurnEnds: number;
}

export function initialCoordinatorState(): CoordinatorState {
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
    consecutiveCompactionFailures: 0,
    compactBackoffTurnEnds: 0,
  };
}

export function restoreCoordinatorState(entries: readonly unknown[]): CoordinatorState {
  if (!Array.isArray(entries)) return initialCoordinatorState();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as { type?: string; customType?: string; data?: unknown };
    if (entry && entry.type === 'custom' && entry.customType === COMPACT_STATE_CUSTOM_TYPE) {
      const d = entry.data as Partial<CoordinatorState>;
      if (d && d.version === 1 && Array.isArray(d.completedBoundaryRequestCounts)) {
        return {
          version: 1,
          epoch: typeof d.epoch === 'number' ? d.epoch : 0,
          completedBoundaryRequestCounts: [...d.completedBoundaryRequestCounts],
          carriedDebtTokens: typeof d.carriedDebtTokens === 'number' ? d.carriedDebtTokens : 0,
          cacheDebtRepaymentTokens: typeof d.cacheDebtRepaymentTokens === 'number' ? d.cacheDebtRepaymentTokens : 0,
          priorCompactionCount: typeof d.priorCompactionCount === 'number' ? d.priorCompactionCount : 0,
          positiveContextDeltaTotal: typeof d.positiveContextDeltaTotal === 'number' ? d.positiveContextDeltaTotal : 0,
          positiveContextDeltaCount: typeof d.positiveContextDeltaCount === 'number' ? d.positiveContextDeltaCount : 0,
          lastContextTokens: typeof d.lastContextTokens === 'number' ? d.lastContextTokens : null,
          currentBoundaryRequestCount: typeof d.currentBoundaryRequestCount === 'number' ? d.currentBoundaryRequestCount : 0,
          consecutiveCompactionFailures: typeof d.consecutiveCompactionFailures === 'number' ? d.consecutiveCompactionFailures : 0,
          compactBackoffTurnEnds: typeof d.compactBackoffTurnEnds === 'number' ? d.compactBackoffTurnEnds : 0,
        };
      }
    }
  }
  return initialCoordinatorState();
}

export class CompactCoordinator {
  state: CoordinatorState = initialCoordinatorState();
  compactionInFlight = false;
  intentionalAbort = false;
  selectedCompaction: CompactionDecision | null = null;
  pendingBoundaryCompleted = false;

  recordBoundaryCompleted(count: number, source?: TodoCompletionSource): void {
    // Only count completed transitions originating from model tool calls
    if (source !== 'tool' || count <= 0) return;
    this.pendingBoundaryCompleted = true;
    if (this.state.currentBoundaryRequestCount > 0) {
      this.state.completedBoundaryRequestCounts.push(this.state.currentBoundaryRequestCount);
      if (this.state.completedBoundaryRequestCounts.length > MAX_BOUNDARY_SAMPLES) {
        this.state.completedBoundaryRequestCounts.splice(
          0,
          this.state.completedBoundaryRequestCounts.length - MAX_BOUNDARY_SAMPLES,
        );
      }
      this.state.currentBoundaryRequestCount = 0;
    }
  }

  onBeforeProviderRequest(contextTokens: number): void {
    this.state.currentBoundaryRequestCount++;
    if (this.state.carriedDebtTokens > 0 && this.state.cacheDebtRepaymentTokens > 0) {
      this.state.carriedDebtTokens = Math.max(
        0,
        this.state.carriedDebtTokens - this.state.cacheDebtRepaymentTokens,
      );
      if (this.state.carriedDebtTokens === 0) {
        this.state.cacheDebtRepaymentTokens = 0;
      }
    }
    if (this.state.lastContextTokens !== null && contextTokens > this.state.lastContextTokens) {
      this.state.positiveContextDeltaTotal += contextTokens - this.state.lastContextTokens;
      this.state.positiveContextDeltaCount++;
    }
    this.state.lastContextTokens = contextTokens;
  }

  onInput(event: { text?: string; source?: string; streamingBehavior?: string }): void {
    // Ignore internal messages dispatched by extensions (D96 reminders, pipe injections, followUps)
    if (event.source === 'extension' || event.text?.startsWith('CORRECTION:')) {
      return;
    }

    const fromHuman =
      event.source === 'interactive' ||
      event.source === 'rpc' ||
      event.source === undefined;

    // If human typed a new prompt or steer directive, reset expectations (correction)
    if (fromHuman) {
      this.selectedCompaction = null;
      this.intentionalAbort = false;
      this.pendingBoundaryCompleted = false;
      // completedBoundaryRequestCounts deliberately survives: it measures
      // requests-per-boundary pacing, which holds across human turns. Clearing it
      // zeroed the mean and pinned expectedRemainingRequests at 1 after every
      // prompt, so OCC never saw a horizon worth compacting under (2026-09-17
      // review: compact.jsonl epoch kept climbing 1→9 with zero compactions).
      this.state.carriedDebtTokens = 0;
      this.state.epoch++;
    }
  }

  onTurnEnd(opts: {
    ctx: ExtensionContext;
    todos: readonly TodoItem[];
    config: OnlineContextCompactConfig;
    cancelReminder?: () => void;
  }): void {
    const boundary = this.pendingBoundaryCompleted;
    this.pendingBoundaryCompleted = false;

    if (!boundary || this.selectedCompaction) return;
    if (!opts.config.enabled) return;

    // Safety guard: if user typed something that is queued, don't abort!
    if (opts.ctx.hasPendingMessages?.()) return;

    const usage = opts.ctx.getContextUsage?.();
    const contextTokens =
      typeof usage?.tokens === 'number' && usage.tokens > 0
        ? usage.tokens
        : this.state.lastContextTokens ?? 0;
    const contextWindowTokens = usage?.contextWindow ?? opts.ctx.model?.contextWindow ?? null;
    const fixedTokens = Math.ceil(Buffer.byteLength(opts.ctx.getSystemPrompt?.() ?? '') / 4);
    const keepRecentTokens = opts.config.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS;
    const archiveTokens = Math.max(0, contextTokens - fixedTokens - keepRecentTokens);
    const remainingBoundaries = opts.todos.filter(
      (it) => it.status !== 'completed' && it.status !== 'abandoned',
    ).length;

    const averageContextTokenIncrement =
      this.state.positiveContextDeltaCount > 0
        ? this.state.positiveContextDeltaTotal / this.state.positiveContextDeltaCount
        : null;
    const cacheRatio = resolveCacheRatioFromCost(
      opts.config.cacheWriteReadRatio,
      opts.ctx.model?.cost,
      { provider: opts.ctx.model?.provider, modelId: opts.ctx.model?.id },
    );

    const decision = decideCompaction({
      writeTokens: contextTokens,
      archiveTokens,
      memoTokens: DEFAULT_MEMO_TOKENS,
      contextTokens,
      completedBoundaryRequestCounts: this.state.completedBoundaryRequestCounts,
      remainingBoundaries,
      averageContextTokenIncrement,
      contextWindowTokens,
      priorCompactionCount: this.state.priorCompactionCount,
      carriedDebtTokens: this.state.carriedDebtTokens,
      cacheDebtRepaymentTokens: this.state.cacheDebtRepaymentTokens,
      cacheWriteReadRatio: cacheRatio,
      economics: {
        ...DEFAULT_COMPACTION_ECONOMICS,
        firstCompactionRequestScale: opts.config.firstCompactionRequestScale,
        subsequentCompactionMargin: opts.config.subsequentCompactionMargin,
      },
    });

    if (decision.compact) {
      // P1-3: after a failed summarization (token-cap class), skip compact decisions for
      // a bounded backoff window — each attempt aborts an in-flight turn, so retrying a
      // doomed compaction burns turns for nothing (observed 05:47:03→05:48:37, 01a0bd3a).
      if (this.state.compactBackoffTurnEnds > 0) {
        this.state.compactBackoffTurnEnds--;
        if (opts.config.logEnabled) {
          this.logDecision(opts.ctx, { ...decision, compact: false, reason: 'failure_backoff' });
        }
        return;
      }
      const branch = opts.ctx.sessionManager?.getBranch?.() ?? [];
      const keepRecentTokens = opts.config.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS;
      const feasible = nativeCompactionFeasible(branch, keepRecentTokens);
      if (!feasible) {
        if (opts.config.logEnabled) {
          this.logDecision(opts.ctx, { ...decision, compact: false, reason: 'native_not_compactable' });
        }
        return;
      }

      this.selectedCompaction = decision;
      this.intentionalAbort = true;
      opts.cancelReminder?.();
      opts.ctx.abort();
    } else if (opts.config.logEnabled) {
      this.logDecision(opts.ctx, decision);
    }
  }

  async onAgentSettled(opts: {
    ctx: ExtensionContext;
    todos: readonly TodoItem[];
    pi: ExtensionAPI;
    config: OnlineContextCompactConfig;
    cancelReminder?: () => void;
    onBeforeCompact?: (sessionRoot: string, ctx: ExtensionContext) => Promise<void>;
  }): Promise<void> {
    if (!this.selectedCompaction || !opts.ctx.isIdle()) return;
    const decision = this.selectedCompaction;
    this.selectedCompaction = null;

    opts.cancelReminder?.();
    this.compactionInFlight = true;

    const sessionDir = opts.ctx.sessionManager?.getSessionDir?.();
    const sessionId = opts.ctx.sessionManager?.getSessionId?.();
    const sessionRoot = resolveSessionRoot(sessionDir, sessionId);

    if (sessionRoot && opts.onBeforeCompact) {
      try {
        await opts.onBeforeCompact(sessionRoot, opts.ctx);
      } catch {
        /* ignore batch packing errors before compaction */
      }
    }

    const remaining = opts.todos.filter(
      (it) => it.status !== 'completed' && it.status !== 'abandoned',
    );
    // P1-3: bound the instruction payload — a huge open-task list inflates the summary
    // request itself (token-cap failures were observed with a 10M-token debt session).
    const taskLines = remaining
      .slice(0, 25)
      .map((it) => `- [${it.status}] ${it.content.slice(0, 160)}${it.blocker ? ` (waiting on: ${it.blocker.slice(0, 80)})` : ''}`)
      .join('\n');
    const elided = remaining.length > 25 ? `\n… (+${remaining.length - 25} more, elided)` : '';

    const customInstructions = [
      'Preserve completed work, verification results, important decisions, and remaining work.',
      remaining.length > 0 ? `Active/remaining tasks to preserve:\n${taskLines}${elided}` : 'All listed tasks are completed.',
    ].join('\n\n');

    const startMs = Date.now();
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      opts.ctx.compact({
        customInstructions,
        onComplete: (compaction) => {
          try {
            this.state.priorCompactionCount++;
            const incrementalRatio = decision.incrementalCacheCostRatio ?? 0;
            this.state.carriedDebtTokens = decision.writeTokens * incrementalRatio;
            this.state.cacheDebtRepaymentTokens = Math.max(0, decision.archiveTokens - decision.memoTokens);
            this.state.epoch++;
            this.state.consecutiveCompactionFailures = 0;
            this.state.compactBackoffTurnEnds = 0;

            opts.pi.appendEntry(COMPACT_STATE_CUSTOM_TYPE, this.state);

            if (opts.config.logEnabled) {
              const sessionDir = opts.ctx.sessionManager?.getSessionDir?.();
              const sessionId = opts.ctx.sessionManager?.getSessionId?.();
              const root = resolveSessionRoot(sessionDir, sessionId);
              if (root) {
                const logPath = efficiencyLogPath(root, 'compact');
                void appendEfficiencyLog(logPath, {
                  schema: 'pier-efficiency/1',
                  mechanism: 'onlineContextCompact',
                  ts: new Date().toISOString(),
                  sessionId: sessionId ?? 'unknown',
                  epoch: this.state.epoch,
                  decision: decision.reason,
                  writeTokens: decision.writeTokens,
                  archiveTokens: decision.archiveTokens,
                  savedTokens: Math.max(0, decision.archiveTokens - decision.memoTokens),
                  breakevenRequests: decision.breakevenRequests,
                  expectedRemainingRequests: decision.expectedRemainingRequests,
                  carriedDebtTokens: this.state.carriedDebtTokens,
                  summaryTokens: typeof compaction?.summary === 'string' ? Math.ceil(compaction.summary.length / 4) : 0,
                  priorCompactionCount: this.state.priorCompactionCount,
                  durationMs: Date.now() - startMs,
                }).catch(() => {});
              }
            }

            try {
              opts.pi.sendMessage(
                {
                  customType: COMPACTION_CONTINUE_TYPE,
                  content: 'Online context compaction finished. Active tasks preserved. Continue working on remaining tasks.',
                  display: false,
                },
                { triggerTurn: true },
              );
            } catch {
              /* ignore continuation failure */
            }
          } finally {
            this.compactionInFlight = false;
            this.intentionalAbort = false;
            finish();
          }
        },
        onError: (error) => {
          this.compactionInFlight = false;
          this.intentionalAbort = false;

          // `Compaction cancelled` / AbortError mean the user (or pi) cancelled on purpose.
          // Telemetry must keep those apart from real failures, and a cancelled compaction
          // must NOT be answered with a turn-triggering continuation.
          const cancelled =
            error instanceof Error &&
            (error.name === 'AbortError' || error.message === 'Compaction cancelled');

          if (opts.config.logEnabled) {
            const sessionDir = opts.ctx.sessionManager?.getSessionDir?.();
            const sessionId = opts.ctx.sessionManager?.getSessionId?.();
            const root = resolveSessionRoot(sessionDir, sessionId);
            if (root) {
              const logPath = efficiencyLogPath(root, 'compact');
              void appendEfficiencyLog(logPath, {
                schema: 'pier-efficiency/1',
                mechanism: 'onlineContextCompact',
                event: 'compaction-failed',
                ts: new Date().toISOString(),
                sessionId: sessionId ?? 'unknown',
                epoch: this.state.epoch,
                decision: decision.reason,
                cancelled,
                error: error instanceof Error ? error.message : String(error),
                consecutiveCompactionFailures: this.state.consecutiveCompactionFailures,
                durationMs: Date.now() - startMs,
              }).catch(() => {});
            }
          }

          if (cancelled) {
            finish();
            return;
          }

          // P1-3: record the failure and back off exponentially (cap 4 skipped decisions)
          // so a token-cap-sized context does not buy repeated abort-then-fail cycles.
          this.state.consecutiveCompactionFailures++;
          this.state.compactBackoffTurnEnds = Math.min(2 ** this.state.consecutiveCompactionFailures, 4);

          // Resume the task: OCC aborted the turn on purpose, so a failed compaction would
          // otherwise leave the session parked on an aborted assistant message. Pi's own
          // threshold compaction stays available as the safety net. Visible (display: true):
          // a silent failure left a 209K-token session running unaware (01a0bd3a).
          const approxTokens = this.state.lastContextTokens;
          try {
            opts.pi.sendMessage(
              {
                customType: COMPACTION_CONTINUE_TYPE,
                content: `Context compaction FAILED (${error instanceof Error ? error.message : String(error)}). `
                  + `Context ≈ ${approxTokens != null ? `${Math.round(approxTokens / 1000)}K tokens` : 'near the window limit'}; `
                  + `OCC backs off for the next ${this.state.compactBackoffTurnEnds} opportunities. `
                  + 'If this repeats, run /compact manually, prune large outputs, or restart the session.',
                display: true,
              },
              { triggerTurn: true },
            );
          } catch {
            /* ignore continuation failure */
          }

          finish();
        },
      });
    });
  }

  rebuildFromBranch(entries: readonly unknown[]): void {
    this.state = restoreCoordinatorState(entries);
    this.selectedCompaction = null;
    this.compactionInFlight = false;
    this.intentionalAbort = false;
    this.pendingBoundaryCompleted = false;
  }

  getRemainingHorizon(remainingBoundaries = 3, contextWindowTokens: number | null = null): number {
    const counts = this.state.completedBoundaryRequestCounts;
    if (counts.length === 0) return 4;

    const est = estimateRemainingRequests({
      completedBoundaryRequestCounts: counts,
      remainingBoundaries,
      scale: 1.0,
      standardDeviationK: 0.0,
      contextTokens: this.state.lastContextTokens ?? 0,
      contextWindowTokens,
      averageContextTokenIncrement:
        this.state.positiveContextDeltaCount > 0
          ? this.state.positiveContextDeltaTotal / this.state.positiveContextDeltaCount
          : null,
    });
    return Math.max(1, est.expectedRemainingRequests);
  }

  private logDecision(ctx: ExtensionContext, decision: CompactionDecision): void {
    const sessionDir = ctx.sessionManager?.getSessionDir?.();
    const sessionId = ctx.sessionManager?.getSessionId?.();
    const root = resolveSessionRoot(sessionDir, sessionId);
    if (!root) return;
    const logPath = efficiencyLogPath(root, 'compact');
    void appendEfficiencyLog(logPath, {
      schema: 'pier-efficiency/1',
      mechanism: 'onlineContextCompact',
      event: 'decision',
      ts: new Date().toISOString(),
      sessionId: sessionId ?? 'unknown',
      epoch: this.state.epoch,
      decision: decision.reason,
      compact: decision.compact,
      writeTokens: decision.writeTokens,
      archiveTokens: decision.archiveTokens,
      breakevenRequests: decision.breakevenRequests,
      expectedRemainingRequests: decision.expectedRemainingRequests,
      // 2026-09-17: without resolvedRatio/model the 61x cache_ratio_unavailable
      // run was un-diagnosable from logs alone (which price table? which family?).
      resolvedRatio: decision.cacheWriteReadRatio,
      incrementalCacheCostRatio: decision.incrementalCacheCostRatio,
      remainingBoundaries: decision.remainingBoundaries,
      model: ctx.model?.id ?? undefined,
      provider: ctx.model?.provider ?? undefined,
    }).catch(() => {});
  }
}
