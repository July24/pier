/**
 * Background settlement poller (takeover, blocked gate, observation, vacuum).
 *
 * Why: planners already live in subagent-poller.ts; this adapter owns the
 * herdr/session I/O loop and pane-scope lifecycle so the plugin only starts it.
 */
import { appendFileSync } from 'node:fs';
import type { Context } from '@deepseek-ai/cordis';
import type { HerdrClientLike, HerdrAgentState } from './herdr-client.ts';
import { applyReportedSessionFile } from './history-store.ts';
import { runtimePolicy, type RuntimePolicy } from './runtime-policy.ts';
import { mountSubagentScope } from './subagent-scope.ts';
import {
  OBSERVATION_TICK_MS,
  TAKEOVER_RECHECK_MS,
  buildSettlementNoticeText,
  formatObservationTimeoutNotice,
  formatPaneClosedNotice,
  isSettlementCandidate,
  planBlockedGate,
  planObservationTick,
  planTakeoverTick,
  planVacuumTick,
} from './subagent-poller.ts';
import type { JevRuntime } from './jev-client.ts';
import { evaluateSettleVerdict, settleAskIsSafe, settleVerdictRequest } from './jev-core.ts';
import type { SettlementNullReason } from './vocab.ts';
import { buildBlockedGateNotice, type SubEntry } from './subagent-core.ts';
import type { SessionIo } from './subagent-session-io.ts';
import type { GitIo } from './subagent-git-io.ts';

export function sleep(ms: number): Promise<void> {
  const wait = Promise.withResolvers<void>();
  setTimeout(wait.resolve, ms);
  return wait.promise;
}

export interface PollerHost {
  client: HerdrClientLike;
  sessionRoot: Context;
  subs: Map<string, SubEntry>;
  persistSubs(): void;
  writeHistory(e: SubEntry, patch?: { outcome?: string | null; status?: SubEntry['status']; closedAt?: number }, via?: string): void;
  blockedGateNotified: Set<string>;
  lastMachineInjectAt: Map<string, number>;
  session: SessionIo;
  git: GitIo;
  injectNotice(content: string): Promise<void>;
  reconcileOnSettlement(description: string, outcome: 'settled' | 'failed'): string[];
  withReconcileNotes(base: string, notes: readonly string[]): string;
  claimSettleNotice(key: string): boolean;
  /** Optional sleep seam for timing control without real delays */
  sleep?: (ms: number) => Promise<void>;
  /** Optional clock seam for deterministic virtual timestamps */
  now?: () => number;
  /** Optional runtime policy overrides for testing */
  policy?: Partial<RuntimePolicy>;
  /** Optional jev seam for the settle attribution check; absent → legacy wording (fail-open). */
  jev?: { ask: JevRuntime['ask']; getMinConfidence: () => number };
}

export interface Poller {
  startPoller(paneId: string, cwd: string, spawnedAt: number, injectTs: number, description: string, requestId: string): Promise<void>;
  readonly pollers: Set<string>;
}

export function createPoller(h: PollerHost): Poller {
  const pollers = new Set<string>();
  const subScopes = new Map<string, { dispose: () => Promise<void> }>();
  /** Current tracked request per pane. startPoller refreshes it even when a poller is already
   * running (01a0c282: a follow_up's startPoller used to be a no-op, so the loop kept judging
   * settlement against the ORIGINAL request's injectTs and claimed notices under a stale id). */
  const requestByPane = new Map<string, { injectTs: number; description: string; requestId: string }>();
  const doSleep = h.sleep ?? sleep;
  const now = h.now ?? Date.now;
  const observeWindowMs = h.policy?.observationWindowMs ?? runtimePolicy.observationWindowMs;
  const machineInjectGraceMs = h.policy?.settlementWindowMs ?? runtimePolicy.settlementWindowMs;
  const takeoverIdleMs = h.policy?.settlementWindowMs ?? runtimePolicy.settlementWindowMs;
  const timeoutMs = h.policy?.subagentTimeoutMs ?? runtimePolicy.subagentTimeoutMs;
  const pollIntervalMs = h.policy?.pollIntervalMs ?? runtimePolicy.pollIntervalMs;

  async function pollLoop(
    paneId: string,
    cwd: string,
    spawnedAt: number,
    injectTs: number,
    description: string,
    requestId: string,
  ): Promise<void> {
    void spawnedAt;
    const startedAt = now();
    let lastActivityAt = now();
    const pollTrace = process.env.PI_HERDR_TRACE
      ? (msg: string) => { try { appendFileSync(process.env.PI_HERDR_TRACE!, `d98poll ${now()} ${paneId} ${msg}\n`); } catch { /* best-effort */ } }
      : null;
    try {
      while (true) {
        // A follow_up refreshes the tracked request mid-flight (see requestByPane): judge
        // settlement against the newest injectTs, not the one this loop was started with.
        const current = requestByPane.get(paneId) ?? { injectTs, description, requestId };
        const entry = h.subs.get(paneId);
        if (!entry || entry.status === 'settled') return;

        if (entry.userTakeover) {
          try {
            const agents = await h.client.listAgents();
            const agent = agents.find((a) => a.paneId === paneId);
            const tick = planTakeoverTick({
              currentStatus: agent?.status ?? null,
              previousStatus: entry.lastAgentStatus,
              idleStartedAt: entry.observationStartedAt,
              now: now(),
              idleMs: takeoverIdleMs,
            });
            if (tick.kind === 'start-idle') {
              entry.observationStartedAt = now();
              entry.lastAgentStatus = 'idle';
              h.persistSubs();
            } else if (tick.kind === 'return-control') {
              entry.userTakeover = false;
              entry.observationStartedAt = null;
              entry.lastAgentStatus = null;
              h.persistSubs();
            } else if (tick.kind === 'hold' && tick.clearIdleTimer) {
              entry.lastAgentStatus = tick.lastAgentStatus;
              entry.observationStartedAt = null;
              h.persistSubs();
            }
          } catch {
            /* status probe failure must not stop the poller */
          }
          if (entry.userTakeover) {
            await doSleep(TAKEOVER_RECHECK_MS);
            continue;
          }
        }

        let state: HerdrAgentState | null;
        try {
          state = await h.client.waitAgent(paneId, ['idle', 'done', 'blocked'], pollIntervalMs);
        } catch {
          state = null;
        }
        const gate = planBlockedGate(state, h.blockedGateNotified.has(paneId));
        if (gate.kind === 'stay-blocked') {
          if (gate.notify) {
            h.blockedGateNotified.add(paneId);
            const question = await h.session.readAskFlag(paneId);
            try {
              await h.injectNotice(buildBlockedGateNotice({ paneId, description: current.description, question }));
            } catch {
              /* list_agents can recover a missed notice */
            }
          }
          continue;
        }
        if (gate.kind === 'clear-gate') h.blockedGateNotified.delete(paneId);
        if (state === 'idle' || state === 'done') {
          // p25 (01a0c282): spawn can mis-attribute entry.sessionFile (herdr's report lags and
          // the mtime fallback records the newest PRE-EXISTING session). A file with no writes
          // since the request then freezes settlement detection until the 600s vacuum. Re-attribute
          // from herdr's per-pane report before judging; only a null value falls back to mtime.
          if (entry.sessionFile) {
            const fixed = await h.session.reattributeStaleSessionFile(paneId, cwd, current.injectTs, entry.sessionFile);
            if (fixed && fixed !== entry.sessionFile) {
              entry.sessionFile = fixed;
              h.persistSubs();
            }
          } else {
            entry.sessionFile = applyReportedSessionFile(
              entry.sessionFile,
              await h.session.resolveSessionFile(paneId, cwd, undefined, { minMtimeMs: current.injectTs - 2_000 }),
            );
          }
          const s = await h.session.subSessionState(paneId, cwd, current.injectTs, entry.sessionFile);
          pollTrace?.(`state=${state} text=${s.text ? s.text.length : 'null'} pend=${s.pendingTool} act=${s.activity} compact=${String(s.compacting)} obs=${String(entry.observationStartedAt ?? null)} takeover=${String(Boolean(entry.userTakeover))}`);
          // OCC compaction is live child work (pane reports idle, transcript holds the
          // inflight marker): keep the vacuum timer fed so the subagent timeout does not
          // fire mid-summary. Settlement candidacy is suppressed inside isSettlementCandidate.
          if (s.compacting) lastActivityAt = now();
          if (isSettlementCandidate(s)) {
            const closing = s.text;
            const obs = planObservationTick({
              observationStartedAt: entry.observationStartedAt,
              now: now(),
              windowMs: observeWindowMs,
              agentStatus: null,
              machineInjectAgoMs: now() - (h.lastMachineInjectAt.get(paneId) ?? 0),
              machineInjectGraceMs,
            });
            if (obs.kind === 'start-observation') {
              entry.observationStartedAt = now();
              entry.lastAgentStatus = 'idle';
              h.persistSubs();
              await doSleep(OBSERVATION_TICK_MS);
              continue;
            }
            let agentStatus: string | null = null;
            try {
              const agents = await h.client.listAgents();
              agentStatus = agents.find((a) => a.paneId === paneId)?.status ?? null;
            } catch {
              /* observation continues */
            }
            const obs2 = planObservationTick({
              observationStartedAt: entry.observationStartedAt,
              now: now(),
              windowMs: observeWindowMs,
              agentStatus,
              machineInjectAgoMs: now() - (h.lastMachineInjectAt.get(paneId) ?? 0),
              machineInjectGraceMs,
            });
            if (obs2.kind === 'user-takeover') {
              entry.userTakeover = true;
              entry.observationStartedAt = now();
              entry.lastAgentStatus = 'working';
              h.persistSubs();
              continue;
            }
            if (obs2.kind === 'machine-inject-reset') {
              entry.observationStartedAt = now();
              h.persistSubs();
              await doSleep(OBSERVATION_TICK_MS);
              continue;
            }
            if (obs2.kind === 'wait') {
              await doSleep(OBSERVATION_TICK_MS);
              continue;
            }
            entry.observationStartedAt = null;

            // p24-class: null closing text is ambiguous — a mis-attributed transcript reads
            // the same as a worker that truly died silent. Computed AFTER the observation
            // gates settle on 'settle' so a full window of 'wait' ticks does not pay a jev
            // call per iteration. Deterministic signal first: when NO readable candidate
            // existed at all (activity false), claiming "left no closing message" would be
            // a lie — that is an attribution failure by definition. Otherwise ask jev to
            // classify the tail we did read (semantic judgment); fail-open keeps the
            // legacy wording byte-identical.
            let nullReason: SettlementNullReason = 'silent';
            if (closing == null) {
              if (!s.activity) {
                nullReason = 'attribution-suspect';
              } else if (h.jev) {
                try {
                  const tail = await h.session.readSettleTail(paneId, cwd, entry.sessionFile);
                  if (tail && settleAskIsSafe(tail)) {
                    const res = await h.jev.ask(
                      settleVerdictRequest({ description: current.description, tail }),
                      { questionId: 'settle-attribution', timeoutMs: 2500 },
                    );
                    if (res.ok) {
                      const verdict = evaluateSettleVerdict(res.answers);
                      if (verdict) nullReason = verdict;
                    }
                  }
                } catch {
                  /* jev down → legacy wording */
                }
              }
            }
            if (!entry.sessionFile) {
              entry.sessionFile = applyReportedSessionFile(
                entry.sessionFile,
                await h.session.resolveSessionFile(paneId, cwd, undefined, { minMtimeMs: current.injectTs - 2_000 }),
              );
            }
            entry.status = 'consumed';
            entry.consumedAt = now();
            // A3: this path consumed the sub too - persist, or the session snapshot keeps it
            // "running" and a restart replays a ghost subagent into list/settle-wake/zombie sweep.
            h.persistSubs();
            h.writeHistory(entry, { outcome: closing }, 'poll-settle');
            const notes = h.reconcileOnSettlement(current.description, 'settled');
            const statLine = await h.git.worktreeStatLine(entry);
            const notice = h.withReconcileNotes(
              buildSettlementNoticeText(`${paneId} (${current.description})`, closing, statLine, nullReason),
              notes,
            );
            if (h.claimSettleNotice(`${paneId}:${current.requestId}`)) {
              try {
                await h.injectNotice(notice);
              } catch {
                /* list_agents can recover */
              }
            }
            return;
          }
        }
        let alive = false;
        try {
          alive = (await h.client.listPanes()).some((p) => p.paneId === paneId);
        } catch {
          alive = true;
        }
        const vacuum = planVacuumTick({
          waitState: state,
          paneAlive: alive,
          now: now(),
          lastActivityAt,
          timeoutMs,
        });
        if (vacuum.refreshActivity) lastActivityAt = now();
        if (vacuum.action === 'pane-closed') {
          entry.status = 'consumed';
          entry.consumedAt = now();
          h.persistSubs();
          h.writeHistory(entry, { outcome: 'pane closed before settling' }, 'poll-pane-closed');
          const notes = h.reconcileOnSettlement(current.description, 'failed');
          const notice = h.withReconcileNotes(
            formatPaneClosedNotice(paneId, current.description),
            notes,
          );
          try {
            await h.injectNotice(notice);
          } catch { /* non-fatal */ }
          return;
        }
        if (vacuum.action === 'timeout') {
          entry.status = 'consumed';
          entry.consumedAt = now();
          h.persistSubs();
          h.writeHistory(entry, { outcome: 'observation timeout' }, 'poll-timeout');
          const notes = h.reconcileOnSettlement(current.description, 'failed');
          const notice = h.withReconcileNotes(
            formatObservationTimeoutNotice({
              paneId,
              description: current.description,
              idleSeconds: Math.round((now() - lastActivityAt) / 1000),
              startedAtIso: new Date(startedAt).toISOString(),
            }),
            notes,
          );
          try {
            await h.injectNotice(notice);
          } catch { /* non-fatal */ }
          return;
        }
      }
    } finally {
      pollers.delete(paneId);
    }
  }

  function startPoller(paneId: string, cwd: string, spawnedAt: number, injectTs: number, description: string, requestId: string): Promise<void> {
    // Always refresh first: a follow_up arriving while the spawn poller still runs must move
    // settlement judgment to the new request instead of being dropped by the has() guard.
    requestByPane.set(paneId, { injectTs, description, requestId });
    if (pollers.has(paneId)) return Promise.resolve();
    pollers.add(paneId);
    return (async () => {
      try {
        if (!subScopes.has(paneId)) {
          const fiber = await mountSubagentScope(h.sessionRoot, paneId, {
            onDispose: () => { pollers.delete(paneId); },
          });
          subScopes.set(paneId, fiber);
        }
        await pollLoop(paneId, cwd, spawnedAt, injectTs, description, requestId);
        const fiber = subScopes.get(paneId);
        subScopes.delete(paneId);
        try { await fiber?.dispose(); } catch { /* already gone */ }
      } catch (err) {
        pollers.delete(paneId);
        console.error(`pier: subagent poller ${paneId} crashed: ${(err as Error)?.message ?? err}`);
      }
    })();
  }

  return { startPoller, pollers };
}
