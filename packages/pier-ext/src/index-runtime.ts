/**
 * Index process-mode planner (master vs worker, master-manifest gate).
 *
 * Why: index.ts mixed env branching with cordis/plugin mounting. The mode
 * decision is a pure function of process env and must stay testable without
 * booting the composition root.
 */
import { detectHerdrEnv } from './herdr-client.ts';

export interface IndexMode {
  /** PI_HERDR_SUBAGENT=1 → worker pane (no subagent tools, no cordis loader). */
  readonly isSubagent: boolean;
  /** herdr pane that is not a worker → apply builtin master manifest. */
  readonly composeMaster: boolean;
}

export function planIndexMode(env: NodeJS.ProcessEnv = process.env): IndexMode {
  const isSubagent = env.PI_HERDR_SUBAGENT === '1';
  return {
    isSubagent,
    composeMaster: Boolean(detectHerdrEnv(env)) && !isSubagent,
  };
}
