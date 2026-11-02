/**
 * Background settlement watcher: blocked gate, observation window, vacuum — plus its per-subagent
 * Cordis scope. Each loop reads the worker from the master's `WorkerWatch` snapshot and parks on its
 * change counter, so a worker that is working, blocked or idle costs no RPCs between events.
 */
import { appendFileSync } from 'node:fs';
import { Context } from '@deepseek-ai/cordis';
import type { CoreClientLike, CoreStatus, TerminalInfo } from './core-client.ts';
import { applyReportedSessionFile } from './history-store.ts';
import { runtimePolicy, type RuntimePolicy } from './runtime-policy.ts';
import type { JevRuntime } from './jev-client.ts';
import { evaluateSettleVerdict, settleAskIsSafe, settleVerdictRequest } from './jev-core.ts';
import { formatSettlementNotice, type SettlementNullReason } from './vocab.ts';
import { buildBlockedGateNotice, reportFingerprint, type SubEntry } from './subagent-core.ts';
import type { SessionIo } from './subagent-session.ts';
import type { GitIo } from './subagent-spawn.ts';

/** `null` = no word to act on (working, never reported, or the watch is blind). */
type WaitState = CoreStatus | null;

export type BlockedGatePlan =
  | { kind: 'stay-blocked'; notify: boolean }
  | { kind: 'clear-gate' }
  | { kind: 'pass' };

/** Blocked is sticky (one notice per gate); any other observed state clears the gate. */
export function planBlockedGate(state: WaitState, alreadyNotified: boolean): BlockedGatePlan {
  if (state === 'blocked') return { kind: 'stay-blocked', notify: !alreadyNotified };
  if (state !== null) return { kind: 'clear-gate' };
  return { kind: 'pass' };
}

export type ObservationTickPlan =
  | { kind: 'start-observation' }
  | { kind: 'wait' }
  | { kind: 'settle' };

/** The window delays settlement so a worker is not announced before its transcript settles; a
 *  finalized answer on a terminal that is not working skips it (the transcript cannot grow). */
export function planObservationTick(input: {
  observationStartedAt: number | null | undefined;
  now: number;
  windowMs: number;
  /** The transcript already holds a finalized answer (stopReason 'stop', no pending tool call). */
  finalized?: boolean;
}): ObservationTickPlan {
  if (!input.observationStartedAt) return input.finalized ? { kind: 'settle' } : { kind: 'start-observation' };
  if (input.now - input.observationStartedAt < input.windowMs) return { kind: 'wait' };
  return { kind: 'settle' };
}

export function planVacuumTick(input: {
  waitState: WaitState;
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
  reportDeliveredAt: number | null = null,
): string {
  const base = formatSettlementNotice(agentLabel, closing, nullReason, reportDeliveredAt);
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
  client: CoreClientLike;
  sessionRoot: Context;
  subs: Map<string, SubEntry>;
  persistSubs(): void;
  writeHistory(e: SubEntry, patch?: { outcome?: string | null; status?: SubEntry['status']; closedAt?: number }, via?: string): void;
  blockedGateNotified: Set<string>;
  session: SessionIo;
  git: GitIo;
  injectNotice(content: string, paneId?: string): Promise<void>;
  reconcileOnSettlement(description: string, outcome: 'settled' | 'failed'): string[];
  withReconcileNotes(base: string, notes: readonly string[]): string;
  claimSettleNotice(key: string): boolean;
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
  const now = h.now ?? Date.now;
  const observeWindowMs = h.policy?.observationWindowMs ?? runtimePolicy.observationWindowMs;
  const timeoutMs = h.policy?.subagentTimeoutMs ?? runtimePolicy.subagentTimeoutMs;
  /** Safety re-check while no event arrives; events, not this interval, drive the loop. */
  const recheckMs = h.policy?.pollIntervalMs ?? runtimePolicy.pollIntervalMs;
  const watch = h.client.watchChildren();

  /** The worker as the watch sees it. A blind watch (disconnected) never settles or fails anything. */
  async function observe(paneId: string): Promise<{ state: CoreStatus | 'exited' | null; alive: boolean }> {
    if (!watch.connected) return { state: null, alive: true };
    let info: TerminalInfo | null | undefined = watch.get(paneId);
    if (!info) {
      // Not in the snapshot: a fresh spawn racing its `created` event, or a terminal that is gone.
      try {
        info = await h.client.getTerminal(paneId);
      } catch {
        return { state: null, alive: true }; // an unreachable socket must not be read as a dead terminal
      }
    }
    if (!info || info.state === 'finished') return { state: 'exited', alive: false };
    return { state: info.status, alive: true };
  }

  async function pollLoop(
    paneId: string,
    cwd: string,
    injectTs: number,
    description: string,
    requestId: string,
  ): Promise<void> {
    const startedAt = now();
    let lastActivityAt = now();
    /** Claimed settle key: on a rejected injection the claim stays ours, so the next wake retries
     *  the notice instead of suppressing it as someone else's. */
    let claimedKey: string | null = null;
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
    await watch.ready();
    try {
      while (true) {
        const current = requestByPane.get(paneId) ?? { injectTs, description, requestId };
        const entry = h.subs.get(paneId);
        if (!entry || entry.status === 'settled' || entry.status === 'consumed' || entry.status === 'closed') return;

        // Read the version BEFORE the state: an event landing in between still wakes the park below.
        const seen = watch.version(paneId);
        const park = (ms: number): Promise<boolean> => watch.changed(paneId, seen, Math.max(0, ms));
        const { state, alive } = await observe(paneId);
        // Working is activity (vacuum heartbeat); `exited`/`unknown` carry no word to gate or settle on.
        const waitState: WaitState = state === 'exited' || state === 'unknown' || state === 'working' ? null : state;
        if (state === 'working' && entry.observationStartedAt) {
          // A continuation turn (e.g. after an OCC abort) restarts the observation from scratch.
          entry.observationStartedAt = null;
          h.persistSubs();
        }
        const gate = planBlockedGate(waitState, h.blockedGateNotified.has(paneId));
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
          lastActivityAt = now(); // a person is being asked: waiting on them is not a stall
          await park(recheckMs);
          continue;
        }
        if (gate.kind === 'clear-gate') h.blockedGateNotified.delete(paneId);

        if (state === 'idle' || state === 'done' || state === 'error') {
          // Spawn can mis-attribute entry.sessionFile (the `pier.session` label lags; the mtime
          // fallback records the newest PRE-EXISTING session), freezing settlement detection until
          // the vacuum timeout.
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
          pollTrace?.(`state=${state} text=${s.text ? s.text.length : 'null'} pend=${s.pendingTool} act=${s.activity} compact=${String(s.compacting)} obs=${String(entry.observationStartedAt ?? null)}`);
          // OCC compaction is live child work (the terminal reports idle, the transcript holds the
          // inflight marker): keep the vacuum timer fed so the timeout does not fire mid-summary.
          if (s.compacting) lastActivityAt = now();

          if (isSettlementCandidate(s)) {
            const closing = s.text;
            const obs = planObservationTick({
              observationStartedAt: entry.observationStartedAt,
              now: now(),
              windowMs: observeWindowMs,
              finalized: closing != null && !s.pendingTool,
            });
            if (obs.kind === 'start-observation') {
              entry.observationStartedAt = now();
              h.persistSubs();
              await park(observeWindowMs);
              continue;
            }
            if (obs.kind === 'wait') {
              await park(observeWindowMs - (now() - (entry.observationStartedAt ?? now())));
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
                      {
                        questionId: 'settle-attribution',
                        timeoutMs: 2500,
                        // Calibration fields (D115): noul answers carry no confidence, so the
                        // probabilities and the composed verdict are what SETTLE_*_MIN_NOUL
                        // tuning reads from jev.jsonl.
                        enrich: ({ ok, answers }) => {
                          if (!ok || !answers) return {};
                          const match = answers.tail_matches_task;
                          const fin = answers.tail_has_final_answer;
                          return {
                            tailMatchesTaskNoul: match?.type === 'noul' ? match.noul : null,
                            tailHasFinalAnswerNoul: fin?.type === 'noul' ? fin.noul : null,
                            settleVerdict: evaluateSettleVerdict(answers) ?? 'unanswered',
                          };
                        },
                      },
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
            // Claim before delivering: the pipe fast-path may already own this settlement's notice.
            // The row is consumed only after the notice is accepted, and a claim we own is retried
            // on the next wake — a rejected injection must not strand a finished worker as 'running'
            // with no notice, nor consume the row while the result is still undelivered.
            const claimKey = `${paneId}:${current.requestId}`;
            if (claimedKey !== claimKey) {
              if (!h.claimSettleNotice(claimKey)) {
                consume(closing, 'poll-settle', now());
                return;
              }
              claimedKey = claimKey;
            }
            const notes = h.reconcileOnSettlement(current.description, 'settled');
            const statLine = await h.git.worktreeStatLine(entry);
            // `subagent output` may already have returned this exact report: point there, don't repeat it.
            const delivered = closing && entry.reportDelivered?.fingerprint === reportFingerprint(closing)
              ? entry.reportDelivered.at
              : null;
            const notice = h.withReconcileNotes(
              buildSettlementNoticeText(`${paneId} (${current.description})`, closing, statLine, nullReason, delivered),
              notes,
            );
            try {
              // Tag the pane: a notice buffered during compaction must keep its row GC-exempt
              // until the post-compaction flush actually delivers it.
              await h.injectNotice(notice, paneId);
            } catch {
              // Notification refused (e.g. the master is compacting): leave the row running and
              // re-detect the same closing text on the next wake.
              await park(recheckMs);
              continue;
            }
            consume(closing, 'poll-settle', now());
            return;
          }
        }

        const vacuum = planVacuumTick({ waitState, paneAlive: alive, now: now(), lastActivityAt, timeoutMs });
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
        await park(Math.min(recheckMs, timeoutMs - (now() - lastActivityAt)));
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
