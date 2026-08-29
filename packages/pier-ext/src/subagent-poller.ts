/**
 * Subagent pollLoop transition planners.
 *
 * Why: pollLoop mixed herdr I/O with takeover / observation / vacuum decisions.
 * Extracting the decisions makes the 30s observation window vs 60s takeover-idle
 * window explicit and unit-testable without a live pane.
 */

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
