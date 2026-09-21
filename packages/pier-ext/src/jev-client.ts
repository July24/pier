/**
 * Jev decision layer — direct HTTP client (RFC docs/rfc-jev-integration.md §5). Not the official SDK
 * (@typesafe-ai/sdk): its retry machinery has no total-latency budget (timeouts retried by default,
 * Retry-After honored up to 60s), which is incompatible with pier's fail-open budgets, and the call
 * surface is one endpoint and three question types.
 *
 * Every ask() resolves (never throws): errors, timeouts, 429s and low confidence at the call site
 * all mean unanswered, and the caller fails open.
 */
import { sha256Hex } from './observation-core.ts';
import { appendEfficiencyLog, efficiencyLogPath } from './efficiency-store.ts';
import { parseJevAnswers, type JevAnswer, type JevQuestion, type JevUsage } from './jev-core.ts';
import type { JevConfig } from './efficiency-config-core.ts';

const JEV_DEFAULT_BASE_URL = 'https://api.typesafe.ai';

export interface JevAskMeta {
  /** Stable question-set id for telemetry rows (e.g. 'epr-diagnostic-gate'). */
  questionId: string;
  /** Total-budget override in ms; defaults to the config timeoutMs. */
  timeoutMs?: number;
  sessionId?: string;
  /** Site-specific static fields for telemetry; must never contain request bodies. */
  extra?: Record<string, unknown>;
  /**
   * Post-answer decision fields for telemetry (choices/scores/final verdicts — the data threshold
   * tuning needs; still never request bodies). Called exactly once per ask.
   */
  enrich?: (outcome: { ok: boolean; answers: Record<string, JevAnswer> | null }) => Record<string, unknown>;
}

export type JevAskResult =
  | { readonly ok: true; readonly answers: Record<string, JevAnswer>; readonly model: string; readonly usage: JevUsage; readonly latencyMs: number }
  | { readonly ok: false; readonly reason: string; readonly latencyMs: number };

export interface JevRuntimeDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Session root for jev.jsonl; telemetry is skipped when absent. */
  getSessionRoot?: () => string | null;
}

export interface JevRuntime {
  readonly available: boolean;
  ask(request: { state: unknown; questions: Record<string, JevQuestion> }, meta: JevAskMeta): Promise<JevAskResult>;
}

export function createJevRuntime(getConfig: () => JevConfig, deps: JevRuntimeDeps = {}): JevRuntime {
  const doFetch = deps.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const now = deps.now ?? Date.now;

  async function logAsk(
    config: JevConfig,
    meta: JevAskMeta,
    outcome: { ok: true; model: string; usage: JevUsage } | { ok: false; reason: string },
    latencyMs: number,
    state: unknown,
    enriched: Record<string, unknown>,
  ): Promise<void> {
    if (!config.logEnabled) return;
    const sessionRoot = deps.getSessionRoot?.() ?? null;
    if (!sessionRoot) return;
    const serialized = JSON.stringify(state) ?? '';
    const record: Record<string, unknown> = {
      schema: 'pier-efficiency/1',
      mechanism: 'jev',
      ts: new Date(now()).toISOString(),
      sessionId: meta.sessionId ?? 'unknown',
      questionId: meta.questionId,
      model: outcome.ok ? outcome.model : config.model,
      latencyMs,
      verdict: outcome.ok ? 'answered' : 'fallback',
      fallback: !outcome.ok,
      reason: outcome.ok ? null : outcome.reason,
      stateBytes: Buffer.byteLength(serialized, 'utf8'),
      stateHash: sha256Hex(serialized),
      ...(outcome.ok ? { usage: { input_tokens: outcome.usage.inputTokens, output_tokens: outcome.usage.outputTokens } } : {}),
      ...(meta.extra ?? {}),
      ...enriched,
    };
    try {
      await appendEfficiencyLog(efficiencyLogPath(sessionRoot, 'jev'), record);
    } catch {
      // Telemetry is best effort; never surface logging failures.
    }
  }

  return {
    // Getter: config reloads (session_start re-resolves from disk) propagate.
    get available(): boolean {
      const config = getConfig();
      return config.enabled && Boolean(config.apiKey);
    },
    async ask(request, meta): Promise<JevAskResult> {
      const startedAt = now();
      const config = getConfig();
      const fail = async (reason: string): Promise<JevAskResult> => {
        const latencyMs = now() - startedAt;
        const enriched = meta.enrich?.({ ok: false, answers: null }) ?? {};
        await logAsk(config, meta, { ok: false, reason }, latencyMs, request.state, enriched);
        return { ok: false, reason, latencyMs };
      };
      if (!config.enabled) return fail('disabled');
      if (!config.apiKey) return fail('no-api-key');

      const timeoutMs = meta.timeoutMs ?? config.timeoutMs;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const base = (config.baseUrl ?? JEV_DEFAULT_BASE_URL).replace(/\/+$/, '');
        const response = await doFetch(`${base}/v1/systemone`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ model: config.model, state: request.state, questions: request.questions }),
          signal: controller.signal,
        });
        if (!response.ok) {
          // 429 (and everything else) fails open immediately: limits are
          // dynamically adjusted upstream and every pier call is droppable.
          return fail(response.status === 429 ? 'rate-limited' : `http-${response.status}`);
        }
        const raw: unknown = await response.json();
        const parsed = parseJevAnswers(raw, Object.keys(request.questions));
        if (!parsed.ok) return fail(parsed.reason);
        const latencyMs = now() - startedAt;
        const enriched = meta.enrich?.({ ok: true, answers: parsed.answers }) ?? {};
        await logAsk(config, meta, { ok: true, model: parsed.model, usage: parsed.usage }, latencyMs, request.state, enriched);
        return { ok: true, answers: parsed.answers, model: parsed.model, usage: parsed.usage, latencyMs };
      } catch (error) {
        const aborted = error instanceof Error && error.name === 'AbortError';
        return fail(aborted ? 'timeout' : 'network-error');
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
