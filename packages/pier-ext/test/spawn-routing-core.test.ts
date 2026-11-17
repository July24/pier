/** D159 spawn model routing core: pool validation, effort snapping, explicit-parameter planning,
 *  jev answer evaluation (domain filter, escalation) and the fail-open resolution paths. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_EFFICIENCY_CONFIG, validateEfficiencyConfig } from '../src/efficiency-config-core.ts';
import type { JevAnswer } from '../src/jev-core.ts';
import {
  clampEffort, evaluateSpawnRoute, parseSpawnModels, planSpawnRoute, resolveSpawnRoute,
  type RoutingConfig, type SpawnModel, type SpawnRouteDeps,
} from '../src/spawn-routing-core.ts';

const OPUS: SpawnModel = { id: 'magpie/remote-magpie/claude/claude-opus-5-5', tier: 'heavy', description: 'hard' };
const SONNET: SpawnModel = { id: 'magpie/cloudflareaigateway/claude-sonnet-5-5', tier: 'balanced', description: 'mid' };
const HAIKU: SpawnModel = { id: 'magpie/cloudflareaigateway/claude-haiku-5-5', tier: 'cheap', description: 'lookups', efforts: ['off', 'low', 'medium'] };
const FLASH: SpawnModel = { id: 'magpie/mistral/deepseek-v4-1-flash-1017', tier: 'cheap', description: 'mechanical', efforts: ['max'] };
const POOL = [OPUS, SONNET, FLASH, HAIKU];
const CFG: RoutingConfig = { ...DEFAULT_EFFICIENCY_CONFIG.routing, enabled: true, spawnModels: POOL };
const TASK = { description: 'fix', prompt: 'Fix the NPE in OrderService and add a test.' };

const answers = (model: string, confidence: number, difficulty: number, diffConfidence = 0.9): Record<string, JevAnswer> => ({
  model: { type: 'choice', choice: model, probabilities: {}, confidence },
  difficulty: { type: 'score', score: difficulty, probabilities: {}, confidence: diffConfidence },
});

test('parseSpawnModels: rejects malformed pools with the offending path', () => {
  assert.match(parseSpawnModels([OPUS]).issue!, /2-8 models/);
  assert.match(parseSpawnModels([OPUS, { ...SONNET, id: 'sonnet' }]).issue!, /\[1\]\.id must be "provider\/model"/);
  assert.match(parseSpawnModels([OPUS, OPUS]).issue!, /duplicates/);
  assert.match(parseSpawnModels([OPUS, { ...SONNET, tier: 'fast' }]).issue!, /\[1\]\.tier/);
  assert.match(parseSpawnModels([OPUS, { ...FLASH, efforts: ['ultra'] }]).issue!, /\[1\]\.efforts/);
  assert.match(parseSpawnModels([OPUS, { ...SONNET, model: 'x' }]).issue!, /unknown key: "model"/);
  assert.deepEqual(parseSpawnModels([OPUS, { ...HAIKU, efforts: ['medium', 'off', 'medium'] }]).value?.[1]?.efforts, ['off', 'medium'], 'deduped, ascending');
});

test('validateEfficiencyConfig: an invalid pool disables routing instead of half-applying it', () => {
  const bad = validateEfficiencyConfig({ routing: { enabled: true, spawnModels: [OPUS] } });
  assert.equal(bad.config.routing.enabled, false);
  assert.match(bad.issues.join(';'), /routing\.spawnModels must list 2-8/);
  const good = validateEfficiencyConfig({ routing: { enabled: true, spawnModels: [OPUS, FLASH] } });
  assert.equal(good.ok, true);
  assert.deepEqual(good.config.routing.spawnModels.map((m) => m.id), [OPUS.id, FLASH.id]);
});

test('clampEffort: the allowlist wins; nearest level, ties go up', () => {
  assert.equal(clampEffort(FLASH, 'low'), 'max', 'a max-only model always runs max');
  assert.equal(clampEffort(HAIKU, 'high'), 'medium');
  assert.equal(clampEffort({ efforts: ['low', 'high'] }, 'medium'), 'high', 'equidistant → the higher level');
  assert.equal(clampEffort(SONNET, 'xhigh'), 'xhigh', 'no allowlist → unchanged');
});

test('planSpawnRoute: explicit parameters are validated against the pool', () => {
  const off = planSpawnRoute({ effort: 'high' }, DEFAULT_EFFICIENCY_CONFIG.routing);
  assert.deepEqual(off, { ok: true, plan: { kind: 'off', effort: 'high' } }, 'effort alone works without a pool');
  assert.match((planSpawnRoute({ model: 'x/y' }, DEFAULT_EFFICIENCY_CONFIG.routing) as { error: string }).error, /needs a model pool/);
  assert.match((planSpawnRoute({ effort: 'ultra' }, CFG) as { error: string }).error, /must be one of/);
  assert.match((planSpawnRoute({ model: 'claude-opus-4' }, CFG) as { error: string }).error, /not in the model pool/);
  assert.match((planSpawnRoute({ model: 'cloudflareaigateway/claude-sonnet-5-5', effort: 'high' }, CFG) as { ok: boolean; plan: { kind: string } }).plan.kind, /explicit/, 'any /-boundary suffix matches');
  const ambiguous = planSpawnRoute({ model: 'x' }, { ...CFG, spawnModels: [{ ...OPUS, id: 'a/x' }, { ...SONNET, id: 'b/x' }] });
  assert.match((ambiguous as { error: string }).error, /ambiguous/);
  assert.match((planSpawnRoute({ model: 'deepseek-v4-1-flash-1017', effort: 'high' }, CFG) as { error: string }).error, /allowed: max/);
  assert.deepEqual(planSpawnRoute({ model: 'claude-opus-5-5' }, CFG), { ok: true, plan: { kind: 'ask', model: OPUS, effort: null } });
});

test('evaluateSpawnRoute: domain filter, escalation and effort bands', () => {
  const plan = { kind: 'ask' as const, model: null, effort: null };
  assert.equal(evaluateSpawnRoute(plan, POOL, answers('openai/gpt-6', 0.9, 2), CFG, 0.6), null, 'out-of-pool pick is unanswered');
  assert.equal(evaluateSpawnRoute(plan, POOL, answers(SONNET.id, 0.9, 2, 0.4), CFG, 0.6), null, 'unconfident difficulty is unanswered');

  const confident = evaluateSpawnRoute(plan, POOL, answers(SONNET.id, 0.9, 3.5), CFG, 0.6)!;
  assert.equal(confident.model, SONNET);
  assert.equal(confident.effort, 'high');

  const hard = evaluateSpawnRoute(plan, POOL, answers(SONNET.id, 0.4, 3.0), CFG, 0.6)!;
  assert.equal(hard.model, OPUS, 'unconfident pick on a hard task escalates one tier');
  assert.equal(hard.escalatedFrom, SONNET.id);

  const easy = evaluateSpawnRoute(plan, POOL, answers(SONNET.id, 0.4, 1.5), CFG, 0.6)!;
  assert.equal(easy.model, SONNET, 'unconfident but easy stays');
  assert.equal(easy.effort, 'medium');

  const top = evaluateSpawnRoute(plan, POOL, answers(OPUS.id, 0.3, 3.9), CFG, 0.6)!;
  assert.equal(top.escalatedFrom, null, 'nothing above heavy');

  const pinned = evaluateSpawnRoute({ kind: 'ask', model: FLASH, effort: null }, [], { difficulty: answers('', 0, 0.2).difficulty! }, CFG, 0.6)!;
  assert.equal(pinned.model, FLASH, 'a pinned model needs only the difficulty answer');
  assert.equal(pinned.effort, 'max');
});

function deps(over: Partial<SpawnRouteDeps> = {}): SpawnRouteDeps {
  return {
    config: CFG,
    minConfidence: 0.6,
    modelExists: () => true,
    ask: async (_request, _timeout, enrich) => {
      const a = answers(SONNET.id, 0.9, 2.0);
      enrich(a);
      return { ok: true, answers: a };
    },
    ...over,
  };
}

test('resolveSpawnRoute: every failure keeps the master model; routing off is the legacy launch', async () => {
  const ask = { kind: 'ask' as const, model: null, effort: null };
  assert.deepEqual(await resolveSpawnRoute({ kind: 'off', effort: null }, TASK, 'p/m', deps()), { model: 'p/m', thinking: null, source: 'off', note: null });

  const routed = await resolveSpawnRoute(ask, TASK, 'p/m', deps());
  assert.deepEqual([routed.model, routed.thinking, routed.source], [SONNET.id, 'medium', 'jev']);

  const noJev = await resolveSpawnRoute(ask, TASK, 'p/m', deps({ ask: null }));
  assert.deepEqual([noJev.model, noJev.thinking, noJev.source], ['p/m', null, 'fallback']);
  assert.match(noJev.note!, /jev unavailable/);

  const failed = await resolveSpawnRoute(ask, TASK, 'p/m', deps({ ask: async () => ({ ok: false, reason: 'timeout' }) }));
  assert.match(failed.note!, /fell back \(jev timeout\)/);

  let asked = false;
  const secret = await resolveSpawnRoute(ask, { ...TASK, prompt: 'use api_key=sk-abcdefghijklmnopqrstuvwxyz123456' }, 'p/m', deps({ ask: async () => { asked = true; return { ok: false, reason: 'x' }; } }));
  assert.equal(asked, false, 'credential-shaped task text never leaves the host');
  assert.equal(secret.source, 'fallback');

  const unknown = await resolveSpawnRoute(ask, TASK, 'p/m', deps({ modelExists: () => false }));
  assert.match(unknown.note!, /no pool model is known to pi/);

  const pinnedFallback = await resolveSpawnRoute({ kind: 'ask', model: FLASH, effort: null }, TASK, 'p/m', deps({ ask: null }));
  assert.deepEqual([pinnedFallback.model, pinnedFallback.thinking], [FLASH.id, 'max'], 'a pinned model keeps its pool effort on fallback');
});
