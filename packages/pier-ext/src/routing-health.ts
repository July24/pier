/**
 * D159 `/pier-config health`: live readiness of spawn model routing. Static `check` only proves the
 * JSON is well-formed; this probes what a spawn will actually hit — each pool model is registered in
 * pi, has credentials, supports its `efforts`, and answers a tiny request — and asks jev one routing
 * question the way spawn does. Probes run in parallel; every failure is reported, never thrown.
 */
import type { JevRuntime } from './jev-client.ts';
import type { JevConfig } from './efficiency-config-core.ts';
import { spawnRouteRequest, type RoutingConfig, type SpawnModel, type ThinkingLevel } from './spawn-routing-core.ts';

/** What pi's registry tells us about one pool id; null = pi does not know it. */
export interface PoolModelInfo {
  readonly reasoning: boolean;
  /** pi's thinkingLevelMap: a `null` value marks the level unsupported for this model. */
  readonly thinkingLevelMap?: Readonly<Record<string, unknown>>;
  readonly hasAuth: boolean;
}

export interface RoutingHealthDeps {
  readonly routing: RoutingConfig;
  readonly jevConfig: JevConfig;
  readonly jev: Pick<JevRuntime, 'available' | 'ask'>;
  lookup(id: string): PoolModelInfo | null;
  /** One tiny completion through pi's own provider auth. */
  ping(id: string): Promise<{ ok: true; latencyMs: number } | { ok: false; error: string; latencyMs: number }>;
}

export interface RoutingHealthReport {
  readonly ok: boolean;
  readonly lines: readonly string[];
}

/** Levels in `efforts` the model cannot run: anything above `off` on a non-reasoning model, or a level its map nulls out. */
export function unsupportedEfforts(model: Pick<SpawnModel, 'efforts'>, info: Pick<PoolModelInfo, 'reasoning' | 'thinkingLevelMap'>): ThinkingLevel[] {
  return (model.efforts ?? []).filter((level) => level !== 'off' && (!info.reasoning || info.thinkingLevelMap?.[level] === null));
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

/** A jev failure reason plus the one config move that usually fixes it. */
function jevHint(reason: string, jevConfig: JevConfig): string {
  if (reason === 'http-451') return 'api.typesafe.ai is region-blocked here: set jev.baseUrl "https://openrouter.ai/api" + jev.model "typesafe/jev-1.13" (key from OPENROUTER_API_KEY)';
  if (reason === 'http-401' || reason === 'http-403') return `the key was rejected by ${jevConfig.baseUrl ?? 'https://api.typesafe.ai'}: check which env/config key is in use (/pier-config show efficiency)`;
  if (reason === 'timeout') return `no answer within routing.timeoutMs; raise it or check the network path to ${jevConfig.baseUrl ?? 'https://api.typesafe.ai'}`;
  return '';
}

async function probeModel(model: SpawnModel, deps: RoutingHealthDeps): Promise<{ ok: boolean; line: string }> {
  const head = `${model.id}  [${model.tier}${model.efforts ? `; efforts ${model.efforts.join(',')}` : ''}]`;
  const info = deps.lookup(model.id);
  if (!info) return { ok: false, line: `  FAIL ${head}\n       not a model pi knows — spawns drop it from jev's choices (check \`pi --list-models\`)` };
  if (!info.hasAuth) return { ok: false, line: `  FAIL ${head}\n       pi has no credentials for this provider (\`pi auth\`)` };
  const unsupported = unsupportedEfforts(model, info);
  const ping = await deps.ping(model.id);
  if (!ping.ok) return { ok: false, line: `  FAIL ${head}\n       test request failed after ${seconds(ping.latencyMs)}: ${ping.error}` };
  if (unsupported.length > 0) {
    const why = info.reasoning ? 'the model marks these levels unsupported' : 'the model has no thinking support';
    return { ok: false, line: `  WARN ${head}  answered in ${seconds(ping.latencyMs)}\n       efforts ${unsupported.join(',')} will not take effect: ${why}` };
  }
  return { ok: true, line: `  OK   ${head}  answered in ${seconds(ping.latencyMs)}` };
}

async function probeJev(deps: RoutingHealthDeps): Promise<{ ok: boolean; line: string }> {
  const where = `${deps.jevConfig.model} @ ${deps.jevConfig.baseUrl ?? 'https://api.typesafe.ai'}`;
  if (!deps.jevConfig.enabled) return { ok: false, line: `  OFF  jev (${where}) — jev.enabled=false: only explicit spawn model/effort apply, everything else runs the master model` };
  if (!deps.jevConfig.apiKey) return { ok: false, line: `  FAIL jev (${where}) — no API key (PIER_JEV_API_KEY, jev.apiKey, or OPENROUTER_API_KEY / TYPESAFE_API_KEY for the matching host)` };
  // A fixed synthetic task: the probe never sends the user's own text.
  const request = spawnRouteRequest({ description: 'health check', prompt: 'Rename one local variable in a single file and run its unit test.' }, deps.routing.spawnModels);
  const result = await deps.jev.ask(request, { questionId: 'routing-health', timeoutMs: deps.routing.timeoutMs });
  if (!result.ok) {
    const hint = jevHint(result.reason, deps.jevConfig);
    return { ok: false, line: `  FAIL jev (${where}) — ${result.reason} after ${seconds(result.latencyMs)}${hint ? `\n       ${hint}` : ''}` };
  }
  const pick = result.answers.model;
  const picked = pick?.type === 'choice' ? pick.choice.slice(pick.choice.lastIndexOf('/') + 1) : '?';
  return { ok: true, line: `  OK   jev (${where}) — answered in ${seconds(result.latencyMs)} (sample task → ${picked}); budget routing.timeoutMs ${deps.routing.timeoutMs}ms` };
}

export async function runRoutingHealth(deps: RoutingHealthDeps): Promise<RoutingHealthReport> {
  const pool = deps.routing.spawnModels;
  if (!deps.routing.enabled || pool.length === 0) {
    return {
      ok: false,
      lines: [
        'pier routing health',
        `  OFF  routing ${deps.routing.enabled ? 'has an empty routing.spawnModels' : 'is disabled (routing.enabled=false)'} — workers run the master's model`,
        '  → run /pier-config with no argument and ask the agent to set up a model pool (docs/rfc-spawn-model-routing.md)',
      ],
    };
  }
  const [models, jev] = await Promise.all([Promise.all(pool.map((m) => probeModel(m, deps))), probeJev(deps)]);
  const usable = models.filter((m) => m.ok).length;
  const ok = usable === pool.length && jev.ok;
  return {
    ok,
    lines: [
      `pier routing health — pool ${pool.length} model(s); each probe sends one tiny request`,
      ...models.map((m) => m.line),
      jev.line,
      ok
        ? '  → routing is ready: spawns pick from the pool'
        : `  → ${usable}/${pool.length} pool model(s) usable${jev.ok ? '' : '; jev is not answering, so auto-pick falls back to the master model'}`,
    ],
  };
}
