/**
 * Centralized runtime policy and timeouts.
 *
 * Every field comes from the `PIER_OPTIONS` registry (canonical/legacy env names, bounds and
 * default), so the numbers cannot drift from `/pier-config doctor`; an out-of-range or unparsable
 * value warns once and falls back to the registry default.
 */
import { PIER_OPTIONS, pierOption, type PolicyField } from './pier-options.ts';

export interface RuntimePolicy {
  /** Subagent overall timeout (ms) */
  readonly subagentTimeoutMs: number
  /** Subagent GC tick interval (ms) */
  readonly gcTickMs: number
  /** Poll interval for subagent state observation (ms) */
  readonly pollIntervalMs: number
  /** Settlement notice window / machine-inject grace / takeover idle (ms) */
  readonly settlementWindowMs: number
  /** Post-settle observation window before auto-consume (ms) */
  readonly observationWindowMs: number
  /** Foreground patience before background promotion (ms) */
  readonly foregroundPatienceMs: number
  /** Default session TTL (seconds) */
  readonly sessionTtlSeconds: number
  /** Git operation timeout (ms) */
  readonly gitTimeoutMs: number
  /** Subagent pane pipe readiness wait (ms) */
  readonly readinessTimeoutMs: number
}

function policyValue(field: PolicyField): number {
  const spec = PIER_OPTIONS.find((o) => o.policy === field);
  if (!spec) throw new Error(`no PIER_OPTIONS entry feeds RuntimePolicy.${field}`);
  const fallback = Number(spec.fallback);
  const raw = pierOption(spec.name);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < (spec.min ?? 0)) {
    console.warn(`Invalid ${spec.name}="${raw}", using default ${spec.fallback}`);
    return fallback;
  }
  return parsed;
}

export function createRuntimePolicy(overrides?: Partial<RuntimePolicy>): RuntimePolicy {
  const policy = {} as { -readonly [K in keyof RuntimePolicy]: number };
  for (const spec of PIER_OPTIONS) {
    if (spec.policy) policy[spec.policy] = policyValue(spec.policy);
  }
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (typeof value === 'number') policy[key as keyof RuntimePolicy] = value;
  }
  return policy;
}

/**
 * Singleton runtime policy for production use.
 * Tests should inject via createRuntimePolicy().
 */
export const runtimePolicy = createRuntimePolicy()
