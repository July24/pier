/**
 * Background settlement poller: takeover, blocked gate, observation window, vacuum — plus its
 * per-subagent Cordis scope. `createPoller` owns the I/O loop (the window values are runtime-policy).
 */
import { appendFileSync } from 'node:fs';
import { Context } from '@deepseek-ai/cordis';
import type { HerdrClientLike, HerdrAgentState } from './herdr-client.ts';
import { applyReportedSessionFile } from './history-store.ts';
import { runtimePolicy, type RuntimePolicy } from './runtime-policy.ts';
import type { JevRuntime } from './jev-client.ts';
import { evaluateSettleVerdict, settleAskIsSafe, settleVerdictRequest } from './jev-core.ts';
import { formatSettlementNotice, type SettlementNullReason } from './vocab.ts';
import { buildBlockedGateNotice, sleep, type SubEntry } from './subagent-core.ts';
import type { SessionIo } from './subagent-session.ts';
import type { GitIo } from './subagent-spawn.ts';

export const TAKEOVER_RECHECK_MS = 5_000;
export const OBSERVATION_TICK_MS = 1_000;

type HerdrWaitState = 'idle' | 'working' | 'blocked' | 'done' | 'unknown' | null;

export type TakeoverTickPlan =
  | { kind: 'ignore' }
  | { kind: 'start-idle' }
  | { kind: 'return-control' }
  | { kind: 'hold'; lastAgentStatus: string; clearIdleTimer: boolean };

export function planTakeoverTick(input: {
  currentStatus: string | null;
  previousStatus: string | null | undefined;
  idleStartedAt: number | null | undefined;
  now: number;
  idleMs: number;
}): TakeoverTickPlan {
  if (input.currentStatus == null) return { kind: 'ignore' };
  if (input.currentStatus === 'idle') {
    if (input.previousStatus !== 'idle') return { kind: 'start-idle' };
    if (input.idleStartedAt != null && input.now - input.idleStartedAt > input.idleMs) {
      return { kind: 'return-control' };
    }
    return { kind: 'hold', lastAgentStatus: 'idle', clearIdleTimer: false };
  }
  return { kind: 'hold', lastAgentStatus: input.currentStatus, clearIdleTimer: true };
}

export type BlockedGatePlan =
  | { kind: 'stay-blocked'; notify: boolean }
  | { kind: 'clear-gate' }
  | { kind: 'pass' };

/** Blocked is sticky (one notice per gate); any other observed state clears the gate. */
export function planBlockedGate(state: HerdrWaitState, alreadyNotified: boolean): BlockedGatePlan {
  if (state === 'blocked') return { kind: 'stay-blocked', notify: !alreadyNotified };
  if (state !== null) return { kind: 'clear-gate' };
  return { kind: 'pass' };
}

export type ObservationTickPlan =
  | { kind: 'start-observation' }
  | { kind: 'user-takeover' }
  | { kind: 'machine-inject-reset' }
  | { kind: 'wait' }
  | { kind: 'settle' };

/** A working pane right after a machine inject is still our own work, not a human takeover. */
export function planObservationTick(input: {
  observationStartedAt: number | null | undefined;
  now: number;
  windowMs: number;
  agentStatus: string | null;
  machineInjectAgoMs: number;
  machineInjectGraceMs: number;
}): ObservationTickPlan {
  if (!input.observationStartedAt) return { kind: 'start-observation' };
  if (input.agentStatus === 'working') {
    if (input.machineInjectAgoMs > input.machineInjectGraceMs) return { kind: 'user-takeover' };
    return { kind: 'machine-inject-reset' };
  }
  if (input.now - input.observationStartedAt < input.windowMs) return { kind: 'wait' };
  return { kind: 'settle' };
}

export function planVacuumTick(input: {
  waitState: HerdrWaitState;
  paneAlive: boolean;
  now: number;
  lastActivityAt: number;
  timeoutMs: number;
}): { refreshActivity: boolean; action: 'pane-closed' | 'timeout' | 'continue' } {
  const refreshActivity = input.waitState === null;
  const lastActivityAt = refreshActivity ? input.now : input.lastActivityAt;
  if (!input.paneAlive) return { refreshActivity, action: 'pane-closed' };
  if (input.now - lastActivityAt > input.timeoutMs) return { refreshActivity, action: 'timeout' };
  return { refreshActivity, action: 'continue' };
}

/**
 * Closing text (only a terminal assistant message produces it) OR an ENDED turn settles; a mere
 * assistant message — the state between tool calls — must NOT qualify, or live workers get announced
 * as finished. OCC compaction hold: a compacting child is not settleable even with closing text, since
 * that turn was aborted on purpose and the continuation is coming — an early wake would be a false
 * settlement.
 */
export function isSettlementCandidate(input: {
  text: string | null;
  pendingTool: boolean;
  activity: boolean;
  turnEnded?: boolean;
  compacting?: boolean;
}): boolean {
  if (input.compacting) return false;
  if (input.text) return true;
  return !input.pendingTool && input.turnEnded === true;
}

export function buildSettlementNoticeText(
  agentLabel: string,
  closing: string | null,
  statLine: string | null,
  nullReason: SettlementNullReason = 'silent',
): string {
  const base = formatSettlementNotice(agentLabel, closing, nullReason);
  return statLine ? `${base}\n${statLine}` : base;
}

export function formatPaneClosedNotice(paneId: string, description: string): string {
  return `Background subagent ${paneId} (${description}) stopped before settling (its pane closed).`;
}

export function formatObservationTimeoutNotice(input: {
  paneId: string;
  description: string;
  idleSeconds: number;
  startedAtIso: string;
}): string {
  return `Background subagent ${input.paneId} (${input.description}) has shown no progress for ${input.idleSeconds}s (observed since ${input.startedAtIso}). Run subagent(action: "list") to check its live state; if it is working, let it run — its settlement notice will arrive automatically. Do not sleep-wait.`;
}

/* ── pane scope ─────────────────────────────────────────────────── */

export interface ScopeHooks {
  onDispose?: () => void;
}

export function createSessionRoot(hooks: ScopeHooks = {}): Context {
  const root = new Context();
  if (hooks.onDispose) {
    root.effect(() => () => { hooks.onDispose?.(); }, 'session-root');
  }
  return root;
}

export async function mountSubagentScope(
  root: Context,
  paneId: string,
  hooks: ScopeHooks = {},
) {
  // One argument only: the pinned cordis version takes just the plugin object; the pane id is the scope name.
  return root.plugin({
    name: `subagent:${paneId}`,
    apply(ctx: Context) {
      ctx.effect(() => () => { hooks.onDispose?.(); }, `subagent:${paneId}`);
    },
  });
}

export async function disposeSessionRoot(root: Context): Promise<void> {
  try {
    await root.fiber.dispose();
  } catch {
  }
}

/* ── poll loop ──────────────────────────────────────────────────── */

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
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  policy?: Partial<RuntimePolicy>;
  /** Optional jev seam for the settle attribution check; absent → legacy wording (fail-open). */
  jev?: { ask: JevRuntime['ask']; getMinConfidence: () => number };
}

export interface Poller {
  startPoller(paneId: string, cwd: string, injectTs: number, description: string, requestId: string): Promise<void>;
  readonly pollers: Set<string>;
}

export function createPoller(h: PollerHost): Poller {
  const pollers = new Set<string>();
  const subScopes = new Map<string, { dispose: () => Promise<void> }>();
  /** Current tracked request per pane. startPoller refreshes it even while a poller runs: a
   * follow_up must judge settlement against its own injectTs, not the original request's. */
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
    injectTs: number,
    description: string,
    requestId: string,
  ): Promise<void> {
    const startedAt = now();
    let lastActivityAt = now();
    /** Stop watching this pane: persist + ledger first, or a restart replays a ghost running row. */
    const consume = (outcome: string | null, via: string, at: number): void => {
      const row = h.subs.get(paneId);
      if (!row) return;
      row.status = 'consumed';
      row.consumedAt = at;
      h.persistSubs();
      h.writeHistory(row, { outcome }, via);
    };
    const pollTrace = process.env.PI_HERDR_TRACE
      ? (msg: string) => { try { appendFileSync(process.env.PI_HERDR_TRACE!, `d98poll ${now()} ${paneId} ${msg}\n`); } catch { /* best-effort */ } }
      : null;
    try {
      while (true) {
        const current = requestByPane.get(paneId) ?? { injectTs, description, requestId };
        const entry = h.subs.get(paneId);
        if (!entry || entry.status === 'settled') return;

        if (entry.userTakeover) {
          try {
            const agent = (await h.client.listAgents()).find((a) => a.paneId === paneId);
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
          }
          if (entry.userTakeover) {
            await doSleep(TAKEOVER_RECHECK_MS);
            continue;
          }
        }

        const tickStartedAt = now();
        /** waitAgent returns at once for a pane already idle/done/blocked; never re-poll faster than the interval. */
        const pace = async (): Promise<void> => {
          const left = pollIntervalMs - (now() - tickStartedAt);
          if (left > 0) await doSleep(left);
        };
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
          await pace();
          continue;
        }
        if (gate.kind === 'clear-gate') h.blockedGateNotified.delete(paneId);

        if (state === 'idle' || state === 'done') {
          // Spawn can mis-attribute entry.sessionFile (herdr's report lags; the mtime fallback records
          // the newest PRE-EXISTING session), freezing settlement detection until the vacuum timeout.
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
          // OCC compaction is live child work (pane reports idle, transcript holds the inflight
          // marker): keep the vacuum timer fed so the timeout does not fire mid-summary.
          if (s.compacting) lastActivityAt = now();

          if (isSettlementCandidate(s)) {
            const closing = s.text;
            if (!entry.observationStartedAt) {
              entry.observationStartedAt = now();
              entry.lastAgentStatus = 'idle';
              h.persistSubs();
              await doSleep(OBSERVATION_TICK_MS);
              continue;
            }
            let agentStatus: string | null = null;
            try {
              agentStatus = (await h.client.listAgents()).find((a) => a.paneId === paneId)?.status ?? null;
            } catch {
            }
            const obs = planObservationTick({
              observationStartedAt: entry.observationStartedAt,
              now: now(),
              windowMs: observeWindowMs,
              agentStatus,
              machineInjectAgoMs: now() - (h.lastMachineInjectAt.get(paneId) ?? 0),
              machineInjectGraceMs,
            });
            if (obs.kind === 'user-takeover') {
              entry.userTakeover = true;
              entry.observationStartedAt = now();
              entry.lastAgentStatus = 'working';
              h.persistSubs();
              continue;
            }
            if (obs.kind === 'machine-inject-reset') {
              entry.observationStartedAt = now();
              h.persistSubs();
              await doSleep(OBSERVATION_TICK_MS);
              continue;
            }
            if (obs.kind === 'wait') {
              await doSleep(OBSERVATION_TICK_MS);
              continue;
            }
            entry.observationStartedAt = null;

            // Null closing text is ambiguous — a mis-attributed transcript reads like a worker that
            // died silent. Deterministic signal first: no readable candidate at all (activity false)
            // makes "left no closing message" a lie; otherwise ask jev to classify the tail we read.
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
            consume(closing, 'poll-settle', now());
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
              }
            }
            return;
          }
        }

        let alive = false;
        try {
          alive = (await h.client.listPanes()).some((p) => p.paneId === paneId);
        } catch {
          alive = true; // an unreachable socket must not be read as a dead pane
        }
        const vacuum = planVacuumTick({ waitState: state, paneAlive: alive, now: now(), lastActivityAt, timeoutMs });
        if (vacuum.refreshActivity) lastActivityAt = now();
        if (vacuum.action === 'pane-closed') {
          consume('pane closed before settling', 'poll-pane-closed', now());
          const notes = h.reconcileOnSettlement(current.description, 'failed');
          try {
            await h.injectNotice(h.withReconcileNotes(formatPaneClosedNotice(paneId, current.description), notes));
          } catch { /* non-fatal */ }
          return;
        }
        if (vacuum.action === 'timeout') {
          consume('observation timeout', 'poll-timeout', now());
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
        await pace();
      }
    } finally {
      pollers.delete(paneId);
    }
  }

  function startPoller(paneId: string, cwd: string, injectTs: number, description: string, requestId: string): Promise<void> {
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
        await pollLoop(paneId, cwd, injectTs, description, requestId);
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
