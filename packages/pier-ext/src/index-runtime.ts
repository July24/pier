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
