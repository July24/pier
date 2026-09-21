/**
 * Every field is fed by the `PIER_OPTIONS` registry, so the numbers cannot drift from
 * `/pier-config doctor`; an out-of-range value warns and falls back to the registry default.
 */
import { PIER_OPTIONS, pierOption, type PolicyField } from './pier-options.ts';

export interface RuntimePolicy {
  readonly subagentTimeoutMs: number
  readonly gcTickMs: number
  readonly pollIntervalMs: number
  /** Settlement notice window / machine-inject grace / takeover idle */
  readonly settlementWindowMs: number
  /** Post-settle observation window before auto-consume */
  readonly observationWindowMs: number
  readonly foregroundPatienceMs: number
  readonly sessionTtlSeconds: number
  readonly gitTimeoutMs: number
  /** Subagent pane pipe readiness wait */
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

/** Singleton for production; tests inject via createRuntimePolicy(). */
export const runtimePolicy = createRuntimePolicy()
