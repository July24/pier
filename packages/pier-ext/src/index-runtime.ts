/**
 * Index process-mode planner (master vs worker, master-manifest gate): a pure function of
 * process env that must stay testable without booting the composition root. */
import { detectHerdrEnv } from './herdr-client.ts';

export interface IndexMode {
  /** PI_HERDR_SUBAGENT=1 → worker pane (no subagent tools, no cordis loader). */
  readonly isSubagent: boolean;
  /** HERDR_ENV + socket + pane are present. */
  readonly hasHerdr: boolean;
  /** herdr pane that is not a worker → apply builtin master manifest and mount workbench plugins. */
  readonly composeMaster: boolean;
}

export function planIndexMode(env: NodeJS.ProcessEnv = process.env): IndexMode {
  const isSubagent = env.PI_HERDR_SUBAGENT === '1';
  const hasHerdr = Boolean(detectHerdrEnv(env));
  return {
    isSubagent,
    hasHerdr,
    composeMaster: hasHerdr && !isSubagent,
  };
}

/**
 * herdr 0.9.2 restore path: a reopened worker pane runs pier's resume_argv, which cannot carry the
 * spawn env. A worker marker next to the session file is the durable identity, so the restored boot
 * plans worker mode (todo-only mount, no master services) instead of master composition.
 */
export function applyRestoredWorkerMode(
  mode: IndexMode,
  sessionFile: string | null | undefined,
  markerExists: (sessionFile: string) => boolean,
): IndexMode {
  if (mode.isSubagent || !mode.hasHerdr || !sessionFile) return mode;
  return markerExists(sessionFile) ? { isSubagent: true, hasHerdr: true, composeMaster: false } : mode;
}
