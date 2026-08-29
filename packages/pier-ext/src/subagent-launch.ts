/**
 * Subagent `execute` planners (validation + foreground wait).
 *
 * Why: execute mixed param checks, isolate git I/O, spawn, and wait-loop
 * decisions. The decisions are pure and must stay testable without a pane.
 */
import { normalizeEntryKind } from './history-store.ts';

export const FOREGROUND_POLL_MS = 2_000;

export type LaunchParams = {
  description?: unknown;
  prompt?: unknown;
  run_in_background?: unknown;
  cwd?: unknown;
  isolate?: unknown;
  role?: unknown;
  allowed_tools?: unknown;
  tab?: unknown;
};

export type LaunchValidation =
  | { kind: 'error'; text: string }
  | {
      kind: 'ok';
      spec: SubagentSpec;
      background: boolean;
      isolate: boolean;
      cwdParam: string | null;
      roleKind: string;
      suggested: string[];
      tab: string | null;
    };

export function planLaunchValidation(
  params: LaunchParams | null | undefined,
  herdrAvailable: boolean,
): LaunchValidation {
  if (!herdrAvailable) {
    return {
      kind: 'error',
      text: 'Error: subagent requires pi to run inside a herdr-managed pane (HERDR_ENV not set).',
    };
  }
  const spec: SubagentSpec = {
    description: String(params?.description ?? 'subagent'),
    prompt: String(params?.prompt ?? ''),
  };
  if (!spec.prompt.trim()) {
    return { kind: 'error', text: 'Error: `prompt` must be a non-empty string' };
  }
  const cwdParam = typeof params?.cwd === 'string' && params.cwd.trim() ? params.cwd.trim() : null;
  const isolate = params?.isolate === true;
  if (isolate && cwdParam) {
    return {
      kind: 'error',
      text: 'Error: `isolate` and `cwd` are mutually exclusive — isolate creates a new worktree, cwd delegates into an existing one',
    };
  }
  const suggested = Array.isArray(params?.allowed_tools)
    ? params.allowed_tools.filter((t): t is string => typeof t === 'string' && t.trim() !== '')
    : [];
  const manifestRole =
    typeof params?.role === 'string' && params.role.trim() ? params.role.trim() : 'worker-default';
  const tab = typeof params?.tab === 'string' ? params.tab : null;
  return {
    kind: 'ok',
    spec,
    background: params?.run_in_background === true,
    isolate,
    cwdParam,
    roleKind: normalizeEntryKind(typeof params?.role === 'string' ? params.role.trim() : undefined),
    suggested,
    manifestRole,
    tab,
  };
}

export function planIsolateRepoGuard(baseSha: string | null): { kind: 'error'; text: string } | { kind: 'ok'; sha: string } {
  if (!baseSha) {
    return { kind: 'error', text: 'Error: isolate requires a git repository with at least one commit' };
  }
  return { kind: 'ok', sha: baseSha };
}

export type ForegroundTickPlan =
  | { kind: 'blocked' }
  | { kind: 'settled'; text: string }
  | { kind: 'wait'; delayMs: number }
  | { kind: 'collect-final' }
  | { kind: 'continue' };

export function planForegroundTick(input: {
  state: string | null;
  session: { text: string | null; pendingTool: boolean; activity: boolean };
}): ForegroundTickPlan {
  if (input.state === 'blocked') return { kind: 'blocked' };
  if (input.state === 'idle' || input.state === 'done') {
    if (input.session.text) return { kind: 'settled', text: input.session.text };
    if (input.session.pendingTool || !input.session.activity) {
      return { kind: 'wait', delayMs: FOREGROUND_POLL_MS };
    }
    return { kind: 'collect-final' };
  }
  return { kind: 'continue' };
}

export function planPatienceExpiry(alive: boolean): 'move-to-background' | 'timeout' {
  return alive ? 'move-to-background' : 'timeout';
}
