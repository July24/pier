/** D159 `/pier-config health`: every pool-model failure mode is named with its fix, and jev failures carry the config hint. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_EFFICIENCY_CONFIG } from '../src/efficiency-config-core.ts';
import { runRoutingHealth, unsupportedEfforts, type PoolModelInfo, type RoutingHealthDeps } from '../src/routing-health.ts';
import type { SpawnModel } from '../src/spawn-routing-core.ts';

const POOL: SpawnModel[] = [
  { id: 'magpie/remote-magpie/claude/claude-opus-5-5', tier: 'heavy', description: 'hard', efforts: ['low', 'medium', 'high'] },
  { id: 'magpie/mistral/deepseek-v4-1-flash-1017', tier: 'cheap', description: 'mechanical', efforts: ['max'] },
];
const REASONING: PoolModelInfo = { reasoning: true, hasAuth: true };

function deps(over: Partial<RoutingHealthDeps> = {}): RoutingHealthDeps {
  return {
    routing: { ...DEFAULT_EFFICIENCY_CONFIG.routing, enabled: true, spawnModels: POOL },
    jevConfig: { ...DEFAULT_EFFICIENCY_CONFIG.jev, enabled: true, apiKey: 'k' },
    jev: {
      available: true,
      ask: async () => ({
        ok: true,
        answers: { model: { type: 'choice', choice: POOL[1]!.id, probabilities: {}, confidence: 0.9 } },
        model: 'jev-1.13.0',
        usage: { inputTokens: 1, outputTokens: 0 },
        latencyMs: 400,
      }),
    },
    lookup: () => REASONING,
    ping: async () => ({ ok: true, latencyMs: 900 }),
    ...over,
  };
}

test('unsupportedEfforts: non-reasoning models run only `off`; a null map entry marks a level unsupported', () => {
  assert.deepEqual(unsupportedEfforts({ efforts: ['off', 'low'] }, { reasoning: false }), ['low']);
  assert.deepEqual(unsupportedEfforts({ efforts: ['high', 'max'] }, { reasoning: true, thinkingLevelMap: { max: null } }), ['max']);
  assert.deepEqual(unsupportedEfforts({}, { reasoning: false }), [], 'no allowlist → nothing to check');
});

test('runRoutingHealth: a healthy pool and jev report ready', async () => {
  const report = await runRoutingHealth(deps());
  assert.equal(report.ok, true);
  assert.equal(report.lines.filter((l) => l.startsWith('  OK ')).length, 3, 'two models + jev');
  assert.match(report.lines.join('\n'), /sample task → deepseek-v4-1-flash-1017/);
});

test('runRoutingHealth: each pool failure names its cause and fix', async () => {
  const report = await runRoutingHealth(deps({
    lookup: (id): PoolModelInfo | null => (id.includes('opus') ? null : { reasoning: true, hasAuth: true, thinkingLevelMap: { max: null } }),
  }));
  const text = report.lines.join('\n');
  assert.equal(report.ok, false);
  assert.match(text, /FAIL magpie\/remote-magpie\/claude\/claude-opus-5-5.*\n.*not a model pi knows/);
  assert.match(text, /WARN magpie\/mistral\/deepseek-v4-1-flash-1017.*\n.*efforts max will not take effect/);
  assert.match(text, /0\/2 pool model\(s\) usable/);

  const noAuth = await runRoutingHealth(deps({ lookup: () => ({ ...REASONING, hasAuth: false }) }));
  assert.match(noAuth.lines.join('\n'), /no credentials/);
  const down = await runRoutingHealth(deps({ ping: async () => ({ ok: false, error: '401 Unauthorized', latencyMs: 300 }) }));
  assert.match(down.lines.join('\n'), /test request failed after 0\.3s: 401 Unauthorized/);
});

test('runRoutingHealth: jev failures carry the config move that fixes them', async () => {
  const blocked = await runRoutingHealth(deps({ jev: { available: true, ask: async () => ({ ok: false, reason: 'http-451', latencyMs: 200 }) } }));
  const text = blocked.lines.join('\n');
  assert.equal(blocked.ok, false);
  assert.match(text, /FAIL jev .* http-451/);
  assert.match(text, /jev\.baseUrl "https:\/\/openrouter\.ai\/api"/);
  assert.match(text, /auto-pick falls back to the master model/);

  const noKey = await runRoutingHealth(deps({ jevConfig: { ...DEFAULT_EFFICIENCY_CONFIG.jev, enabled: true } }));
  assert.match(noKey.lines.join('\n'), /no API key/);
});

test('runRoutingHealth: routing off says so and points at the guided setup without probing', async () => {
  let probed = false;
  const report = await runRoutingHealth(deps({
    routing: DEFAULT_EFFICIENCY_CONFIG.routing,
    ping: async () => { probed = true; return { ok: true, latencyMs: 1 }; },
  }));
  assert.equal(probed, false);
  assert.match(report.lines.join('\n'), /routing is disabled[\s\S]*\/pier-config with no argument/);
});
