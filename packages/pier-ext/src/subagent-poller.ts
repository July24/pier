/**
 * Subagent pollLoop transition planners.
 *
 * Why: pollLoop mixed herdr I/O with takeover / observation / vacuum decisions.
 * Extracting the decisions makes the 30s observation window vs 60s takeover-idle
 * window explicit and unit-testable without a live pane.
 */

import { formatSettlementNotice, type SettlementNullReason } from './vocab.ts';

export const TAKEOVER_RECHECK_MS = 5_000;
export const OBSERVATION_TICK_MS = 1_000;

export type HerdrWaitState = 'idle' | 'working' | 'blocked' | 'done' | 'unknown' | null;

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

export type VacuumTickPlan = {
  refreshActivity: boolean;
  action: 'pane-closed' | 'timeout' | 'continue';
};

export function planVacuumTick(input: {
  waitState: HerdrWaitState;
  paneAlive: boolean;
  now: number;
  lastActivityAt: number;
  timeoutMs: number;
}): VacuumTickPlan {
  const refreshActivity = input.waitState === null;
  const lastActivityAt = refreshActivity ? input.now : input.lastActivityAt;
  if (!input.paneAlive) return { refreshActivity, action: 'pane-closed' };
  if (input.now - lastActivityAt > input.timeoutMs) return { refreshActivity, action: 'timeout' };
  return { refreshActivity, action: 'continue' };
}

/**
 * Determine whether subSessionState qualifies as an observation candidate.
 *
 * A16: closing text (only produced by a terminal assistant message) OR an ENDED turn settles.
 * Merely having an assistant message — the state a worker is in between tool calls, while the next
 * assistant message streams — must NOT qualify: on 2026-09-13 three live workers were announced as
 * "finished … left no closing message" and one was closed mid-task by GC afterwards.
 */
export function isSettlementCandidate(input: {
  text: string | null;
  pendingTool: boolean;
  activity: boolean;
  turnEnded?: boolean;
}): boolean {
  if (input.text) return true;
  return !input.pendingTool && input.turnEnded === true;
}

/** Formats the combined settlement notice with optional git worktree stat. */
export function buildSettlementNoticeText(
  agentLabel: string,
  closing: string | null,
  statLine: string | null,
  nullReason: SettlementNullReason = 'silent',
): string {
  const base = formatSettlementNotice(agentLabel, closing, nullReason);
  return statLine ? `${base}\n${statLine}` : base;
}

/** Formats notice when background subagent pane was closed prematurely. */
export function formatPaneClosedNotice(paneId: string, description: string): string {
  return `Background subagent ${paneId} (${description}) stopped before settling (its pane closed).`;
}

/** Formats notice when background subagent exceeded observation timeout. */
export function formatObservationTimeoutNotice(input: {
  paneId: string;
  description: string;
  idleSeconds: number;
  startedAtIso: string;
}): string {
  return `Background subagent ${input.paneId} (${input.description}) has shown no progress for ${input.idleSeconds}s (observed since ${input.startedAtIso}). Run subagent(action: "list") to check its live state; if it is working, let it run — its settlement notice will arrive automatically. Do not sleep-wait.`;
}

