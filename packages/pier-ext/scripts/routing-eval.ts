/**
 * D159 offline routing eval: replays a local labeled task set through the same jev request and
 * evaluation code spawn uses, against the user's effective efficiency config, and prints accuracy.
 *
 *   node packages/pier-ext/scripts/routing-eval.ts [tasks.jsonl]
 *
 * Default set: ~/.pi/agent/herdr-pi/router-eval/tasks.jsonl (real prompts; never committed). Rows:
 * {id, description, prompt, ref: {tier: cheap|balanced|heavy, effort: low|medium|high}}. Effort is
 * scored before the per-model allowlist (a max-only model would otherwise hide the band's verdict).
 * Calls jev for real (jev.enabled + apiKey required); credential-shaped prompts are skipped.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadEfficiencyConfigFromDisk } from '../src/efficiency-config-core.ts';
import { createJevRuntime } from '../src/jev-client.ts';
import {
  MODEL_TIERS, effortFromDifficulty, evaluateSpawnRoute, spawnRouteAskIsSafe, spawnRouteRequest, type ModelTier,
} from '../src/spawn-routing-core.ts';

interface EvalRow {
  id: number;
  description: string;
  prompt: string;
  ref: { tier: ModelTier; effort: 'low' | 'medium' | 'high' };
}

const file = process.argv[2] ?? join(homedir(), '.pi', 'agent', 'herdr-pi', 'router-eval', 'tasks.jsonl');
const rows: EvalRow[] = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as EvalRow);
const config = loadEfficiencyConfigFromDisk({ onWarning: (w) => console.error(`config: ${w}`) });
const pool = config.routing.spawnModels;
if (pool.length === 0) throw new Error('routing.spawnModels is empty in the effective efficiency config');
const jev = createJevRuntime(() => ({ ...config.jev, logEnabled: false }));
if (!jev.available) throw new Error('jev is not available (jev.enabled + apiKey)');

const plan = { kind: 'ask' as const, model: null, effort: null };
let scored = 0;
let tierHits = 0;
let under = 0;
let over = 0;
let effortHits = 0;
const latencies: number[] = [];
const picks = new Map<string, number>();
for (const row of rows) {
  const task = { description: row.description, prompt: row.prompt };
  if (!spawnRouteAskIsSafe(task)) {
    console.log(`#${row.id} skipped (credential-shaped text)`);
    continue;
  }
  const result = await jev.ask(spawnRouteRequest(task, pool), { questionId: 'spawn-route-eval', timeoutMs: Math.max(config.routing.timeoutMs, 10_000) });
  const decision = result.ok ? evaluateSpawnRoute(plan, pool, result.answers, config.routing, config.jev.minConfidence) : null;
  if (!decision) {
    console.log(`#${row.id} unanswered (${result.ok ? 'answer unusable' : result.reason})`);
    continue;
  }
  scored += 1;
  latencies.push(result.latencyMs);
  const delta = MODEL_TIERS.indexOf(decision.model.tier) - MODEL_TIERS.indexOf(row.ref.tier);
  if (delta === 0) tierHits += 1;
  else if (delta < 0) under += 1;
  else over += 1;
  const band = effortFromDifficulty(decision.difficulty, config.routing);
  if (band === row.ref.effort) effortHits += 1;
  const short = decision.model.id.slice(decision.model.id.lastIndexOf('/') + 1);
  picks.set(short, (picks.get(short) ?? 0) + 1);
  console.log(`#${row.id} ref ${row.ref.tier}/${row.ref.effort} -> ${short} (${decision.model.tier}) band ${band} launch ${decision.effort} diff ${decision.difficulty.toFixed(2)}${decision.escalatedFrom ? ' escalated' : ''} | ${row.description.slice(0, 40)}`);
}
latencies.sort((a, b) => a - b);
const pct = (n: number): string => (scored ? (n / scored).toFixed(2) : '-');
console.log([
  '',
  `scored ${scored}/${rows.length}  tier_acc ${pct(tierHits)}  under ${pct(under)}  over ${pct(over)}  effort_acc ${pct(effortHits)}`,
  `latency p50 ${latencies[Math.floor(latencies.length / 2)] ?? '-'}ms  p90 ${latencies[Math.floor(latencies.length * 0.9)] ?? '-'}ms`,
  `picks ${[...picks].map(([id, n]) => `${id}=${n}`).join(' ')}`,
].join('\n'));
