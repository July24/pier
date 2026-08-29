/**
 * Centralized runtime policy and timeouts.
 * 
 * Why: Prevents drift between hardcoded literals and environment overrides;
 * makes timing behavior explicit and testable.
 */

export interface RuntimePolicy {
  /** Subagent overall timeout (ms) */
  readonly subagentTimeoutMs: number
  /** Subagent GC tick interval (ms) */
  readonly gcTickMs: number
  /** Poll interval for subagent state observation (ms) */
  readonly pollIntervalMs: number
  /** Stale check cadence (turns) */
  readonly staleCadenceTurns: number
  /** Settlement notice window (ms) */
  readonly settlementWindowMs: number
  /** Foreground patience before background promotion (ms) */
  readonly foregroundPatienceMs: number
  /** Default session TTL (seconds) */
  readonly sessionTtlSeconds: number
  /** Terminal read maximum bytes */
  readonly terminalReadMaxBytes: number
  /** Git operation timeout (ms) */
  readonly gitTimeoutMs: number
}

function parseEnvInt(key: string, defaultValue: number, min: number = 0): number {
  const raw = process.env[key]
  if (!raw) return defaultValue
  
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < min) {
    console.warn(`Invalid ${key}="${raw}", using default ${defaultValue}`)
    return defaultValue
  }
  
  return parsed
}

export function createRuntimePolicy(overrides?: Partial<RuntimePolicy>): RuntimePolicy {
  return {
    subagentTimeoutMs: overrides?.subagentTimeoutMs ?? parseEnvInt('PIER_SUBAGENT_TIMEOUT_MS', 600_000, 1000),
    gcTickMs: overrides?.gcTickMs ?? parseEnvInt('PIER_GC_TICK_MS', 30_000, 1000),
    pollIntervalMs: overrides?.pollIntervalMs ?? parseEnvInt('PIER_POLL_INTERVAL_MS', 30_000, 1000),
    staleCadenceTurns: overrides?.staleCadenceTurns ?? parseEnvInt('PIER_STALE_CADENCE_TURNS', 3, 1),
    settlementWindowMs: overrides?.settlementWindowMs ?? parseEnvInt('PIER_SETTLEMENT_WINDOW_MS', 60_000, 0),
    foregroundPatienceMs: overrides?.foregroundPatienceMs ?? parseEnvInt('PIER_FOREGROUND_PATIENCE_MS', 300_000, 0),
    sessionTtlSeconds: overrides?.sessionTtlSeconds ?? parseEnvInt('PIER_SESSION_TTL_SECONDS', 600, 0),
    terminalReadMaxBytes: overrides?.terminalReadMaxBytes ?? parseEnvInt('TERM_READ_MAX', 4096, 1),
    gitTimeoutMs: overrides?.gitTimeoutMs ?? 10_000,
  }
}

/**
 * Singleton runtime policy for production use.
 * Tests should inject via createRuntimePolicy().
 */
export const runtimePolicy = createRuntimePolicy()
