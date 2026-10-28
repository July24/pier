/**
 * Jev decision layer — direct HTTP client (RFC docs/rfc-jev-integration.md §5). Not the official SDK
 * (@typesafe-ai/sdk): its retry machinery has no total-latency budget (timeouts retried by default,
 * Retry-After honored up to 60s), which is incompatible with pier's fail-open budgets.
 *
 * Every ask() resolves (never throws): errors, timeouts, 429s and low confidence at the call site
 * all mean unanswered, and the caller fails open.
 */
import { sha256Hex } from './observation-core.ts';
import { appendEfficiencyLog, efficiencyLogPath } from './efficiency-store.ts';
import { parseJevAnswers, type JevAnswer, type JevQuestion, type JevUsage } from './jev-core.ts';
import type { JevConfig } from './efficiency-config-core.ts';

const JEV_DEFAULT_BASE_URL = 'https://api.typesafe.ai';
/** Consecutive transport failures (timeout / network / 5xx) that open the breaker. */
export const JEV_BREAKER_FAILURES = 2;
/** While open, asks fail open locally without a request or a telemetry row; the tripping row says so. */
export const JEV_BREAKER_OPEN_MS = 60_000;

export interface JevAskMeta {
  /** Stable question-set id for telemetry rows (e.g. 'epr-diagnostic-gate'). */
  questionId: string;
  /** Total-budget override in ms; defaults to the config timeoutMs. */
  timeoutMs?: number;
  sessionId?: string;
  /** Site-specific static fields for telemetry; must never contain request bodies. */
  extra?: Record<string, unknown>;
  /**
   * Post-answer decision fields for telemetry (choices/scores/final verdicts — what threshold tuning
   * needs; still never request bodies). Called exactly once per ask, with null answers on failure.
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
  /** Session id fallback for telemetry rows; sites that know it pass meta.sessionId instead. */
  getSessionId?: () => string | null | undefined;
}

export interface JevRuntime {
  readonly available: boolean;
  ask(request: { state: unknown; questions: Record<string, JevQuestion> }, meta: JevAskMeta): Promise<JevAskResult>;
}

export function createJevRuntime(getConfig: () => JevConfig, deps: JevRuntimeDeps = {}): JevRuntime {
  const doFetch = deps.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const now = deps.now ?? Date.now;
  // A run of 12 back-to-back network failures and 2.5s timeout stalls showed every site paying
  // the full budget during an outage; the breaker makes an outage cost one tripping ask.
  let transportFailures = 0;
  let breakerOpenUntil = 0;
  async function logAsk(
    config: JevConfig,
    meta: JevAskMeta,
    outcome: { ok: true; model: string; usage: JevUsage } | { ok: false; reason: string; extra?: Record<string, unknown> },
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
      sessionId: meta.sessionId ?? deps.getSessionId?.() ?? 'unknown',
      ts: new Date(now()).toISOString(),
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
      ...(outcome.ok ? {} : outcome.extra ?? {}),
      ...enriched,
    };
    try {
      await appendEfficiencyLog(efficiencyLogPath(sessionRoot, 'jev'), record);
    } catch {
      /* Never surfaced to the caller. */
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
      const fail = async (reason: string, extra?: Record<string, unknown>): Promise<JevAskResult> => {
        const latencyMs = now() - startedAt;
        const enriched = meta.enrich?.({ ok: false, answers: null }) ?? {};
        await logAsk(config, meta, { ok: false, reason, extra }, latencyMs, request.state, enriched);
        return { ok: false, reason, latencyMs };
      };
      const transportFail = (reason: string, extra: Record<string, unknown> = {}): Promise<JevAskResult> => {
        transportFailures += 1;
        if (transportFailures < JEV_BREAKER_FAILURES) return fail(reason, extra);
        transportFailures = 0;
        breakerOpenUntil = now() + JEV_BREAKER_OPEN_MS;
        return fail(reason, { ...extra, breakerOpenedMs: JEV_BREAKER_OPEN_MS });
      };
      if (!config.enabled) return fail('disabled');
      if (!config.apiKey) return fail('no-api-key');
      if (now() < breakerOpenUntil) {
        meta.enrich?.({ ok: false, answers: null });
        return { ok: false, reason: 'breaker-open', latencyMs: 0 };
      }

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
          if (response.status >= 500) return transportFail(`http-${response.status}`);
          transportFailures = 0;
          return fail(response.status === 429 ? 'rate-limited' : `http-${response.status}`);
        }
        transportFailures = 0;
        const raw: unknown = await response.json();
        const parsed = parseJevAnswers(raw, Object.keys(request.questions));
        if (!parsed.ok) return fail(parsed.reason);
        const latencyMs = now() - startedAt;
        const enriched = meta.enrich?.({ ok: true, answers: parsed.answers }) ?? {};
        await logAsk(config, meta, { ok: true, model: parsed.model, usage: parsed.usage }, latencyMs, request.state, enriched);
        return { ok: true, answers: parsed.answers, model: parsed.model, usage: parsed.usage, latencyMs };
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') return transportFail('timeout');
        // fetch wraps the socket error in `cause`; its code (ECONNRESET, ENOTFOUND, ...) is the diagnosis.
        const source = error instanceof Error && error.cause instanceof Error ? error.cause : error;
        const code = source instanceof Error && 'code' in source && typeof source.code === 'string' ? source.code : undefined;
        return transportFail('network-error', code ? { errorCode: code } : {});
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
