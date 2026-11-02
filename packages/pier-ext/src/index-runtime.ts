/**
 * Index process-mode planner (master vs worker, master-manifest gate): a pure function of
 * process env that must stay testable without booting the composition root. */
import { detectCoreEnv } from './core-client.ts';

export interface IndexMode {
  /** PI_HERDR_SUBAGENT=1 → worker terminal (no subagent tools, no cordis loader). */
  readonly isSubagent: boolean;
  /** HC_TERMINAL_SOCKET + HC_TERMINAL_ID are present. */
  readonly hasCore: boolean;
  /** core terminal that is not a worker → apply builtin master manifest and mount master plugins. */
  readonly composeMaster: boolean;
}

export function planIndexMode(env: NodeJS.ProcessEnv = process.env): IndexMode {
  const isSubagent = env.PI_HERDR_SUBAGENT === '1';
  const hasCore = Boolean(detectCoreEnv(env));
  return {
    isSubagent,
    hasCore,
    composeMaster: hasCore && !isSubagent,
  };
}
