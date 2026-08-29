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
import { runtimePolicy } from './runtime-policy.ts';
import { mountSubagentScope } from './subagent-scope.ts';
import {
  OBSERVATION_TICK_MS,
  TAKEOVER_RECHECK_MS,
  planBlockedGate,
  planObservationTick,
  planTakeoverTick,
  planVacuumTick,
} from './subagent-poller.ts';
import { buildBlockedGateNotice, type SubEntry } from './subagent-core.ts';
import { formatSettlementNotice } from './vocab.ts';
import type { SessionIo } from './subagent-session-io.ts';
import type { GitIo } from './subagent-git-io.ts';

function sleep(ms: number): Promise<void> {
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
}

export interface Poller {
  startPoller(paneId: string, cwd: string, spawnedAt: number, injectTs: number, description: string, requestId: string): void;
  readonly pollers: Set<string>;
}

export function createPoller(h: PollerHost): Poller {
  const pollers = new Set<string>();
  const subScopes = new Map<string, { dispose: () => Promise<void> }>();
  const observeWindowMs = runtimePolicy.observationWindowMs;
  const machineInjectGraceMs = runtimePolicy.settlementWindowMs;
  const takeoverIdleMs = runtimePolicy.settlementWindowMs;
  const timeoutMs = runtimePolicy.subagentTimeoutMs;

  async function pollLoop(
    paneId: string,
    cwd: string,
    spawnedAt: number,
    injectTs: number,
    description: string,
    requestId: string,
  ): Promise<void> {
    void spawnedAt;
    const startedAt = Date.now();
    let lastActivityAt = Date.now();
    const pollTrace = process.env.PI_HERDR_TRACE
      ? (msg: string) => { try { appendFileSync(process.env.PI_HERDR_TRACE!, `d98poll ${Date.now()} ${paneId} ${msg}\n`); } catch { /* best-effort */ } }
      : null;
    try {
      while (true) {
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
              now: Date.now(),
              idleMs: takeoverIdleMs,
            });
            if (tick.kind === 'start-idle') {
              entry.observationStartedAt = Date.now();
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
            await sleep(TAKEOVER_RECHECK_MS);
            continue;
          }
        }

        let state: HerdrAgentState | null;
        try {
          state = await h.client.waitAgent(paneId, ['idle', 'done', 'blocked'], runtimePolicy.pollIntervalMs);
        } catch {
          state = null;
        }
        const gate = planBlockedGate(state, h.blockedGateNotified.has(paneId));
        if (gate.kind === 'stay-blocked') {
          if (gate.notify) {
            h.blockedGateNotified.add(paneId);
            const question = await h.session.readAskFlag(paneId);
            try {
              await h.injectNotice(buildBlockedGateNotice({ paneId, description, question }));
            } catch {
              /* list_agents can recover a missed notice */
            }
          }
          continue;
        }
        if (gate.kind === 'clear-gate') h.blockedGateNotified.delete(paneId);
        if (state === 'idle' || state === 'done') {
          const s = await h.session.subSessionState(paneId, cwd, injectTs);
          pollTrace?.(`state=${state} text=${s.text ? s.text.length : 'null'} pend=${s.pendingTool} act=${s.activity} obs=${String(entry.observationStartedAt ?? null)} takeover=${String(entry.userTakeover === true)}`);
          if (s.text || (!s.pendingTool && s.activity)) {
            const closing = s.text;
            const obs = planObservationTick({
              observationStartedAt: entry.observationStartedAt,
              now: Date.now(),
              windowMs: observeWindowMs,
              agentStatus: null,
              machineInjectAgoMs: Date.now() - (h.lastMachineInjectAt.get(paneId) ?? 0),
              machineInjectGraceMs,
            });
            if (obs.kind === 'start-observation') {
              entry.observationStartedAt = Date.now();
              entry.lastAgentStatus = 'idle';
              h.persistSubs();
              await sleep(OBSERVATION_TICK_MS);
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
              now: Date.now(),
              windowMs: observeWindowMs,
              agentStatus,
              machineInjectAgoMs: Date.now() - (h.lastMachineInjectAt.get(paneId) ?? 0),
              machineInjectGraceMs,
            });
            if (obs2.kind === 'user-takeover') {
              entry.userTakeover = true;
              entry.observationStartedAt = Date.now();
              entry.lastAgentStatus = 'working';
              h.persistSubs();
              continue;
            }
            if (obs2.kind === 'machine-inject-reset') {
              entry.observationStartedAt = Date.now();
              h.persistSubs();
              await sleep(OBSERVATION_TICK_MS);
              continue;
            }
            if (obs2.kind === 'wait') {
              await sleep(OBSERVATION_TICK_MS);
              continue;
            }
            entry.observationStartedAt = null;
            if (!entry.sessionFile) {
              entry.sessionFile = applyReportedSessionFile(
                entry.sessionFile,
                await h.session.resolveSessionFile(paneId, cwd),
              );
            }
            entry.status = 'consumed';
            entry.consumedAt = Date.now();
            h.writeHistory(entry, { outcome: closing }, 'poll-settle');
            const notes = h.reconcileOnSettlement(description, 'settled');
            const statLine = await h.git.worktreeStatLine(entry);
            const notice = h.withReconcileNotes(
              formatSettlementNotice(`${paneId} (${description})`, closing) + (statLine ? `\n${statLine}` : ''),
              notes,
            );
            if (h.claimSettleNotice(`${paneId}:${requestId}`)) {
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
          alive = (await h.client.listAgents()).some((a) => a.paneId === paneId);
        } catch {
          alive = true;
        }
        const vacuum = planVacuumTick({
          waitState: state,
          paneAlive: alive,
          now: Date.now(),
          lastActivityAt,
          timeoutMs,
        });
        if (vacuum.refreshActivity) lastActivityAt = Date.now();
        if (vacuum.action === 'pane-closed') {
          entry.status = 'consumed';
          entry.consumedAt = Date.now();
          h.persistSubs();
          h.writeHistory(entry, { outcome: 'pane closed before settling' }, 'poll-pane-closed');
          const notes = h.reconcileOnSettlement(description, 'failed');
          const notice = h.withReconcileNotes(
            `Background subagent ${paneId} (${description}) stopped before settling (its pane closed).`,
            notes,
          );
          try {
            await h.injectNotice(notice);
          } catch { /* non-fatal */ }
          return;
        }
        if (vacuum.action === 'timeout') {
          entry.status = 'consumed';
          entry.consumedAt = Date.now();
          h.persistSubs();
          h.writeHistory(entry, { outcome: 'observation timeout' }, 'poll-timeout');
          const notes = h.reconcileOnSettlement(description, 'failed');
          const notice = h.withReconcileNotes(
            `Background subagent ${paneId} (${description}) has shown no progress for ${Math.round((Date.now() - lastActivityAt) / 1000)}s (observed since ${new Date(startedAt).toISOString()}). Run list_agents to check its live state; if it is working, let it run — its settlement notice will arrive automatically. Do not sleep-wait.`,
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

  function startPoller(paneId: string, cwd: string, spawnedAt: number, injectTs: number, description: string, requestId: string): void {
    if (pollers.has(paneId)) return;
    pollers.add(paneId);
    void (async () => {
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
