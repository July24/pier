/**
 * Spawn model routing (RFC docs/rfc-spawn-model-routing.md, D159): pick a worker's model and thinking
 * level from the user's pool. jev supplies a model choice and a difficulty score; the pool domain,
 * escalation, effort bands and per-model effort allowlists are code. Every failure falls back to the
 * pre-routing launch (master model, no --thinking), so routing off stays byte-identical.
 */
import { isPlainObject } from './guards.ts';
import { containsLikelySecret } from './reducer-core.ts';
import type { JevAnswer, JevQuestion, JevRequest } from './jev-core.ts';

/** pi's `--thinking` levels, ascending. */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const MODEL_TIERS = ['cheap', 'balanced', 'heavy'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

export interface SpawnModel {
  /** `provider/model` as accepted by pi `--provider/--model` (split at the first slash). */
  readonly id: string;
  readonly tier: ModelTier;
  /** Human-written purpose line: jev's main evidence for the pick. */
  readonly description: string;
  /** Allowed thinking levels; the routed effort snaps to the nearest one. Absent = any level. */
  readonly efforts?: readonly ThinkingLevel[];
}

export interface RoutingConfig {
  enabled: boolean;
  spawnModels: readonly SpawnModel[];
  /** A jev model pick below this confidence is escalated one tier when the task is hard. */
  minModelConfidence: number;
  /** Difficulty score (0-4) at or above which an unconfident pick is escalated. */
  escalateDifficulty: number;
  /** Difficulty below this maps to `low` thinking. */
  effortLowBelow: number;
  /** Difficulty below this (and not low) maps to `medium`; everything above is `high`. */
  effortMediumBelow: number;
  /** Total jev budget for one routing ask. */
  timeoutMs: number;
}

export const SPAWN_POOL_MIN = 2;
export const SPAWN_POOL_MAX = 8;
/** jev degrades on large states; a full prompt beat a 1500-char head in the 2026-11-17 eval. */
export const ROUTE_PROMPT_MAX_CHARS = 8000;

const isThinkingLevel = (v: unknown): v is ThinkingLevel => typeof v === 'string' && (THINKING_LEVELS as readonly string[]).includes(v);
const isTier = (v: unknown): v is ModelTier => typeof v === 'string' && (MODEL_TIERS as readonly string[]).includes(v);

/** Validate the `routing.spawnModels` list; null value = invalid (the issue says why). */
export function parseSpawnModels(raw: unknown): { value: SpawnModel[] | null; issue?: string } {
  const path = 'routing.spawnModels';
  if (!Array.isArray(raw)) return { value: null, issue: `${path} must be an array` };
  if (raw.length < SPAWN_POOL_MIN || raw.length > SPAWN_POOL_MAX) {
    return { value: null, issue: `${path} must list ${SPAWN_POOL_MIN}-${SPAWN_POOL_MAX} models (got ${raw.length})` };
  }
  const out: SpawnModel[] = [];
  const seen = new Set<string>();
  for (const [i, entry] of raw.entries()) {
    const at = `${path}[${i}]`;
    if (!isPlainObject(entry)) return { value: null, issue: `${at} must be an object` };
    const unknown = Object.keys(entry).filter((k) => !['id', 'tier', 'description', 'efforts'].includes(k));
    if (unknown.length) return { value: null, issue: `${at} unknown key: "${unknown[0]}"` };
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (!id.includes('/') || id.startsWith('/') || id.endsWith('/')) return { value: null, issue: `${at}.id must be "provider/model"` };
    if (seen.has(id)) return { value: null, issue: `${at}.id duplicates "${id}"` };
    seen.add(id);
    if (!isTier(entry.tier)) return { value: null, issue: `${at}.tier must be one of ${MODEL_TIERS.join(' | ')}` };
    const description = typeof entry.description === 'string' ? entry.description.trim() : '';
    if (!description) return { value: null, issue: `${at}.description must be a non-empty string` };
    let efforts: ThinkingLevel[] | undefined;
    if (entry.efforts !== undefined) {
      if (!Array.isArray(entry.efforts) || entry.efforts.length === 0 || !entry.efforts.every(isThinkingLevel)) {
        return { value: null, issue: `${at}.efforts must be a non-empty array of ${THINKING_LEVELS.join(' | ')}` };
      }
      efforts = [...new Set(entry.efforts)].sort((a, b) => THINKING_LEVELS.indexOf(a) - THINKING_LEVELS.indexOf(b));
    }
    out.push({ id, tier: entry.tier, description, ...(efforts ? { efforts } : {}) });
  }
  return { value: out };
}

/** Snap a level to the model's allowlist: nearest by rank, ties go up (under-thinking costs more than over-thinking). */
export function clampEffort(model: Pick<SpawnModel, 'efforts'>, level: ThinkingLevel): ThinkingLevel {
  const allowed = model.efforts;
  if (!allowed || allowed.length === 0 || allowed.includes(level)) return level;
  const rank = THINKING_LEVELS.indexOf(level);
  let best = allowed[0]!;
  for (const candidate of allowed) {
    const d = Math.abs(THINKING_LEVELS.indexOf(candidate) - rank);
    const bestD = Math.abs(THINKING_LEVELS.indexOf(best) - rank);
    if (d < bestD || (d === bestD && THINKING_LEVELS.indexOf(candidate) > THINKING_LEVELS.indexOf(best))) best = candidate;
  }
  return best;
}

export function effortFromDifficulty(difficulty: number, cfg: Pick<RoutingConfig, 'effortLowBelow' | 'effortMediumBelow'>): ThinkingLevel {
  if (difficulty < cfg.effortLowBelow) return 'low';
  if (difficulty < cfg.effortMediumBelow) return 'medium';
  return 'high';
}

/** Explicit `model` matches a pool id exactly, else a unique `/`-boundary suffix (`claude-sonnet-5-5`). */
export function matchPoolModel(pool: readonly SpawnModel[], ref: string): SpawnModel | SpawnModel[] | null {
  const exact = pool.find((m) => m.id === ref);
  if (exact) return exact;
  const hits = pool.filter((m) => m.id.endsWith(`/${ref}`));
  if (hits.length === 1) return hits[0]!;
  return hits.length > 1 ? hits : null;
}

/* ── planning (sync: explicit-parameter validation happens before any side effect) ── */

export type SpawnRoutePlan =
  /** Routing off: launch exactly as before, plus an explicit effort if one was given. */
  | { kind: 'off'; effort: ThinkingLevel | null }
  /** Both fields fixed by the master; no jev ask. */
  | { kind: 'explicit'; model: SpawnModel; effort: ThinkingLevel }
  /** jev fills what the master left open. */
  | { kind: 'ask'; model: SpawnModel | null; effort: ThinkingLevel | null };

export function planSpawnRoute(
  params: { model?: unknown; effort?: unknown } | null | undefined,
  cfg: RoutingConfig,
): { ok: true; plan: SpawnRoutePlan } | { ok: false; error: string } {
  const rawModel = typeof params?.model === 'string' ? params.model.trim() : '';
  const rawEffort = typeof params?.effort === 'string' ? params.effort.trim() : '';
  if (params?.model !== undefined && !rawModel) return { ok: false, error: 'Error: `model` must be a non-empty string' };
  if (rawEffort && !isThinkingLevel(rawEffort)) {
    return { ok: false, error: `Error: \`effort\` must be one of ${THINKING_LEVELS.join(' | ')} (got "${rawEffort}")` };
  }
  const effort = rawEffort ? (rawEffort as ThinkingLevel) : null;
  const pool = cfg.enabled ? cfg.spawnModels : [];
  if (pool.length === 0) {
    if (rawModel) return { ok: false, error: 'Error: `model` needs a model pool (routing.enabled + routing.spawnModels in the pier efficiency config); omit it to run the master\'s model' };
    return { ok: true, plan: { kind: 'off', effort } };
  }
  let model: SpawnModel | null = null;
  if (rawModel) {
    const match = matchPoolModel(pool, rawModel);
    if (!match || Array.isArray(match)) {
      const why = Array.isArray(match) ? `is ambiguous (${match.map((m) => m.id).join(', ')})` : 'is not in the model pool';
      return { ok: false, error: `Error: model "${rawModel}" ${why}; pool: ${pool.map((m) => m.id).join(', ')}` };
    }
    model = match;
  }
  if (model && effort && model.efforts && !model.efforts.includes(effort)) {
    return { ok: false, error: `Error: effort "${effort}" is not allowed for ${model.id} (allowed: ${model.efforts.join(', ')})` };
  }
  if (model && effort) return { ok: true, plan: { kind: 'explicit', model, effort } };
  return { ok: true, plan: { kind: 'ask', model, effort } };
}

/* ── jev request / evaluation ── */

const DIFFICULTY_LEVELS = [
  'trivial mechanical step',
  'small well-specified change or lookup',
  'moderate single-issue fix or investigation',
  'hard multi-step change or multi-bug investigation',
  'very hard cross-service feature or design-level work',
] as const;

export function spawnRouteRequest(
  task: { description: string; prompt: string },
  candidates: readonly SpawnModel[] | null,
): JevRequest {
  const questions: Record<string, JevQuestion> = {
    difficulty: {
      type: 'score',
      instructions: 'How hard is this delegated coding-agent task for a capable model (amount of code to read/change, ambiguity, multi-step reasoning, verification needed)?',
      criteria: [...DIFFICULTY_LEVELS],
    },
  };
  if (candidates) {
    questions.model = {
      type: 'choice',
      instructions: 'Pick the cheapest model in the pool that will most likely complete this delegated coding-agent task correctly on the first attempt.',
      criteria: Object.fromEntries(candidates.map((m) => [m.id, m.description])),
    };
  }
  return { state: { task_title: task.description, task: task.prompt.slice(0, ROUTE_PROMPT_MAX_CHARS) }, questions };
}

/** Privacy gate shared with EPR: credential-shaped task text never leaves the host. */
export function spawnRouteAskIsSafe(task: { description: string; prompt: string }): boolean {
  return !containsLikelySecret(`${task.description}\n${task.prompt}`);
}

/** Next tier up with a candidate, in pool order (config order is the preference within a tier). */
function escalate(from: SpawnModel, candidates: readonly SpawnModel[]): SpawnModel {
  for (let t = MODEL_TIERS.indexOf(from.tier) + 1; t < MODEL_TIERS.length; t += 1) {
    const hit = candidates.find((m) => m.tier === MODEL_TIERS[t]);
    if (hit) return hit;
  }
  return from;
}

export interface RoutedDecision {
  readonly model: SpawnModel;
  readonly effort: ThinkingLevel;
  readonly difficulty: number;
  /** jev's pick confidence; null when the master fixed the model. */
  readonly modelConfidence: number | null;
  /** The jev pick before escalation, when escalation changed it. */
  readonly escalatedFrom: string | null;
}

/** Compose the decision; null = unanswered (wrong shape, out-of-domain pick, unconfident difficulty). */
export function evaluateSpawnRoute(
  plan: Extract<SpawnRoutePlan, { kind: 'ask' }>,
  candidates: readonly SpawnModel[],
  answers: Record<string, JevAnswer>,
  cfg: RoutingConfig,
  minConfidence: number,
): RoutedDecision | null {
  const diff = answers.difficulty;
  if (!diff || diff.type !== 'score' || diff.confidence < minConfidence) return null;
  let model = plan.model;
  let modelConfidence: number | null = null;
  let escalatedFrom: string | null = null;
  if (!model) {
    const pick = answers.model;
    if (!pick || pick.type !== 'choice') return null;
    const chosen = candidates.find((m) => m.id === pick.choice);
    if (!chosen) return null;
    modelConfidence = pick.confidence;
    model = chosen;
    if (pick.confidence < cfg.minModelConfidence && diff.score >= cfg.escalateDifficulty) {
      const up = escalate(chosen, candidates);
      if (up !== chosen) {
        escalatedFrom = chosen.id;
        model = up;
      }
    }
  }
  const effort = clampEffort(model, plan.effort ?? effortFromDifficulty(diff.score, cfg));
  return { model, effort, difficulty: diff.score, modelConfidence, escalatedFrom };
}

/* ── resolution (async, jev injected) ── */

export interface SpawnRoute {
  /** `provider/model` for the launch; null = the master's model. */
  readonly model: string | null;
  readonly thinking: ThinkingLevel | null;
  readonly source: 'off' | 'explicit' | 'jev' | 'fallback';
  /** One line for the spawn result; null when routing is off and nothing was requested. */
  readonly note: string | null;
}

export interface SpawnRouteDeps {
  readonly config: RoutingConfig;
  readonly minConfidence: number;
  /** null when jev is disabled or has no key. */
  readonly ask: ((request: JevRequest, timeoutMs: number, enrich: (answers: Record<string, JevAnswer> | null) => Record<string, unknown>) => Promise<{ ok: true; answers: Record<string, JevAnswer> } | { ok: false; reason: string }>) | null;
  /** Registry probe; pool entries pi cannot resolve are dropped from jev's domain. */
  readonly modelExists: (id: string) => boolean;
}

/** pi's `ctx.modelRegistry.find(provider, model)` as an id probe; null when the context has no registry. */
export function registryModelProbe(ctx: unknown): ((id: string) => boolean) | null {
  if (!ctx || typeof ctx !== 'object' || !('modelRegistry' in ctx)) return null;
  const registry = ctx.modelRegistry;
  if (!registry || typeof registry !== 'object' || !('find' in registry) || typeof registry.find !== 'function') return null;
  const find: (provider: string, model: string) => unknown = registry.find.bind(registry);
  return (id) => {
    const slash = id.indexOf('/');
    try {
      return Boolean(find(id.slice(0, slash), id.slice(slash + 1)));
    } catch {
      return false;
    }
  };
}

const shortId = (id: string): string => id.slice(id.lastIndexOf('/') + 1);

export async function resolveSpawnRoute(
  plan: SpawnRoutePlan,
  task: { description: string; prompt: string },
  masterModel: string | null,
  deps: SpawnRouteDeps,
): Promise<SpawnRoute> {
  if (plan.kind === 'off') {
    return { model: masterModel, thinking: plan.effort, source: 'off', note: plan.effort ? `thinking ${plan.effort} (explicit)` : null };
  }
  if (plan.kind === 'explicit') {
    return { model: plan.model.id, thinking: plan.effort, source: 'explicit', note: `model ${shortId(plan.model.id)} · thinking ${plan.effort} · explicit` };
  }
  const fallback = (reason: string): SpawnRoute => {
    const model = plan.model ?? null;
    const thinking = model ? clampEffort(model, plan.effort ?? 'medium') : plan.effort;
    const label = model ? shortId(model.id) : `${masterModel ? shortId(masterModel) : 'default'} (master)`;
    return {
      model: model ? model.id : masterModel,
      thinking,
      source: 'fallback',
      note: `model ${label}${thinking ? ` · thinking ${thinking}` : ''} · routing fell back (${reason})`,
    };
  };
  const candidates = plan.model ? null : deps.config.spawnModels.filter((m) => deps.modelExists(m.id));
  if (candidates && candidates.length === 0) return fallback('no pool model is known to pi');
  if (!deps.ask) return fallback('jev unavailable');
  if (!spawnRouteAskIsSafe(task)) return fallback('credential-shaped task text stays local');
  let decision: RoutedDecision | null = null;
  const result = await deps.ask(spawnRouteRequest(task, candidates), deps.config.timeoutMs, (answers) => {
    if (!answers) return {};
    decision = evaluateSpawnRoute(plan, candidates ?? [], answers, deps.config, deps.minConfidence);
    const d = decision as RoutedDecision | null;
    return d
      ? { route: d.model.id, effort: d.effort, difficulty: d.difficulty, modelConfidence: d.modelConfidence, escalatedFrom: d.escalatedFrom }
      : { route: null };
  });
  if (!result.ok) return fallback(`jev ${result.reason}`);
  const routed = decision as RoutedDecision | null;
  if (!routed) return fallback('jev answer unusable');
  const parts = [`difficulty ${routed.difficulty.toFixed(1)}`];
  if (routed.modelConfidence !== null) parts.unshift(`conf ${routed.modelConfidence.toFixed(2)}`);
  if (routed.escalatedFrom) parts.push(`escalated from ${shortId(routed.escalatedFrom)}`);
  return {
    model: routed.model.id,
    thinking: routed.effort,
    source: 'jev',
    note: `model ${shortId(routed.model.id)} · thinking ${routed.effort} · via jev (${parts.join(', ')})`,
  };
}
