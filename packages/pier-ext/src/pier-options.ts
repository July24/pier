/**
 * B10 environment naming. Two prefixes grew side by side — `PI_HERDR_*` (older tuning knobs) and
 * `PIER_*` (newer ones) — so this module fixes one rule and enforces it in code:
 *
 *  - `PIER_*` is the canonical namespace for *pier options* (timeouts, windows, toggles); the
 *    historical `PI_HERDR_*` spelling stays accepted as a fallback alias.
 *  - `PI_HERDR_SUBAGENT`, `PI_HERDR_ROLE_MANIFEST`, `PI_HERDR_TUI`, `PI_HERDR_META_KEY` stay as they
 *    are: those are *contracts* handed to the child process by pier itself (or read by pi/herdr), and
 *    renaming them would split running workers from their parent.
 *
 * `pierOption()` is the single reader; this registry is also the single source of the numeric
 * bounds/defaults behind `runtimePolicy` (runtime-policy.ts) and the `/pier-config` catalog
 * (config-catalog-core.ts), so a knob cannot mean three different things.
 */

/** RuntimePolicy field fed by an integer option (see runtime-policy.ts). */
export type PolicyField =
  | 'subagentTimeoutMs'
  | 'gcTickMs'
  | 'pollIntervalMs'
  | 'settlementWindowMs'
  | 'observationWindowMs'
  | 'foregroundPatienceMs'
  | 'sessionTtlSeconds'
  | 'gitTimeoutMs'
  | 'readinessTimeoutMs';

export interface OptionSpec {
  /** Canonical name. */
  readonly name: string;
  /** Historical `PI_HERDR_*` spelling still accepted. */
  readonly legacy?: string;
  /** Default when neither name is set. */
  readonly fallback: string;
  readonly description: string;
  /** Integer option: smallest value the readers accept (omitted for string/enum options). */
  readonly min?: number;
  /** Integer option read into `RuntimePolicy`. */
  readonly policy?: PolicyField;
}

/** Every pier option, with its alias, default and bounds. */
export const PIER_OPTIONS: readonly OptionSpec[] = [
  { name: 'PIER_GIT_TIMEOUT_MS', legacy: 'PI_HERDR_GIT_TIMEOUT_MS', fallback: '10000', min: 1, policy: 'gitTimeoutMs', description: 'git command timeout (worktree/status batches)' },
  { name: 'PIER_SUBAGENT_TIMEOUT_MS', legacy: 'PI_HERDR_SUBAGENT_TIMEOUT_MS', fallback: '600000', min: 1000, policy: 'subagentTimeoutMs', description: 'subagent inactivity budget before forced termination' },
  { name: 'PIER_READY_TIMEOUT_MS', legacy: 'PI_HERDR_READY_TIMEOUT_MS', fallback: '90000', min: 1000, policy: 'readinessTimeoutMs', description: 'how long to wait for a spawned pane to open its pipe (a dead pane fails fast)' },
  { name: 'PIER_OBSERVATION_WINDOW_MS', legacy: 'PI_HERDR_OBSERVATION_WINDOW_MS', fallback: '30000', min: 0, policy: 'observationWindowMs', description: 'observation window before a subagent is called settled' },
  { name: 'PIER_POLL_INTERVAL_MS', legacy: 'PI_HERDR_POLL_INTERVAL_MS', fallback: '30000', min: 1000, policy: 'pollIntervalMs', description: 'subagent poll cadence' },
  { name: 'PIER_GC_TICK_MS', legacy: 'PI_HERDR_GC_TICK_MS', fallback: '30000', min: 1000, policy: 'gcTickMs', description: 'idle GC sweep cadence (panes/worktrees)' },
  { name: 'PIER_SETTLEMENT_WINDOW_MS', legacy: 'PI_HERDR_SETTLEMENT_WINDOW_MS', fallback: '60000', min: 0, policy: 'settlementWindowMs', description: 'settlement notice window / machine-inject grace / takeover idle' },
  { name: 'PIER_FOREGROUND_PATIENCE_MS', legacy: 'PI_HERDR_FOREGROUND_PATIENCE_MS', fallback: '300000', min: 0, policy: 'foregroundPatienceMs', description: 'foreground patience before demoting a subagent to background' },
  { name: 'PIER_SESSION_TTL_SECONDS', legacy: 'PI_HERDR_SESSION_TTL_SECONDS', fallback: '600', min: 0, policy: 'sessionTtlSeconds', description: 'session retention after a subagent exits, before GC' },
  { name: 'PIER_FOCUS_POLL_MS', fallback: '1500', min: 0, description: 'pane-focus sampling cadence for the heat layout (0 disables; event-first on herdr 0.9.1+)' },
  { name: 'PIER_TERMINAL_PROMPT', legacy: 'PI_HERDR_TERMINAL_PROMPT', fallback: '(auto from $SHELL)', description: 'prompt strategy for terminal readiness: bash|zsh|powershell|pwsh' },
  { name: 'PIER_SLIM_FRAME', legacy: 'PI_HERDR_SLIM_FRAME', fallback: '1', description: 'mutation frame around todo-tool cards (0 disables)' },
  { name: 'PIER_TRACE', legacy: 'PI_HERDR_TRACE', fallback: '', description: 'write diagnostics (renderers, swallowed errors) to stderr (or to this file when it is a path)' },
  { name: 'PIER_TERM_IDLE_MS', legacy: 'PI_HERDR_TERM_IDLE_MS', fallback: '1800000', min: 1, description: 'idle time before pier nudges about an open terminal (0/NaN falls back to the default)' },
  { name: 'PIER_TERM_GRACE_MS', legacy: 'PI_HERDR_TERM_GRACE_MS', fallback: '30000', min: 1, description: 'settle grace before the terminal idle nudge (0/NaN falls back to the default)' },
  { name: 'PIER_TERM_READ_MAX', legacy: 'PI_HERDR_TERM_READ_MAX', fallback: '8000', min: 1, description: 'characters returned per terminal read (0/NaN falls back to the default)' },
  { name: 'PIER_TODO_GRACE_MS', legacy: 'PI_HERDR_TODO_GRACE_MS', fallback: '30000', min: 1, description: 'settle grace before the unfinished-todo reminder (0/NaN falls back to the default)' },
  { name: 'PIER_HMR', legacy: 'PI_HERDR_HMR', fallback: '', description: 'dev: enable the cordis HMR boundary (requires --expose-internals)' },
  { name: 'PIER_ISOLATE_SWEEP_ORPHANS', legacy: 'PI_HERDR_ISOLATE_SWEEP_ORPHANS', fallback: '', description: 'opt-in sweeping of isolate worktrees this session never registered' },
];

/**
 * Read a pier option: canonical name first, then the legacy alias, then the fallback.
 * An empty string counts as unset for both names (shells export empty vars easily).
 */
export function pierOption(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const spec = PIER_OPTIONS.find((o) => o.name === name);
  for (const key of [name, spec?.legacy]) {
    if (!key) continue;
    const raw = env[key];
    if (typeof raw === 'string' && raw.trim() !== '') return raw;
  }
  return undefined;
}

/** `/pier-config` catalog rows: name, effective value and where it came from. */
export function pierOptionRows(env: NodeJS.ProcessEnv = process.env): Array<{
  name: string;
  value: string;
  source: 'env' | 'legacy-env' | 'default';
  description: string;
}> {
  return PIER_OPTIONS.map((spec) => {
    const own = typeof env[spec.name] === 'string' && env[spec.name]!.trim() !== '';
    const legacyRaw = spec.legacy ? env[spec.legacy] : undefined;
    const viaLegacy = typeof legacyRaw === 'string' && legacyRaw.trim() !== '';
    if (own || viaLegacy) {
      return { name: spec.name, value: String(own ? env[spec.name] : legacyRaw), source: own ? 'env' : 'legacy-env', description: spec.description };
    }
    return { name: spec.name, value: spec.fallback, source: 'default' as const, description: spec.description };
  });
}

/**
 * Human-readable option table for `/pier-config doctor`, one line per option:
 * `NAME = value (source) — description`. Legacy env names are called out so a stale export is visible.
 */
export function formatOptionRows(env: NodeJS.ProcessEnv = process.env): string[] {
  return pierOptionRows(env).map((row) => {
    const source = row.source === 'default' ? 'default' : row.source === 'env' ? 'env' : 'env (legacy name)';
    return `  ${row.name} = ${row.value}  (${source})  — ${row.description}`;
  });
}
