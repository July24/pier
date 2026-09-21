/**
 * D102 Evidence-Preserving Reducer invoker: intercepts `bash` diagnostic tool results and replaces
 * the log block with a verified receipt.
 *
 * Fail-open throughout — every stage that cannot be satisfied (untrusted project, size, credential
 * shape, failed archive, model error, unverifiable quote, no size win) returns undefined and the
 * original text reaches the model unchanged. The swap happens only after a receipt validates
 * byte-for-byte against a source that was archived first.
 */

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { countLines } from './observation-core.ts';
import {
  containsLikelySecret,
  DEFAULT_MAX_CHARS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_MIN_BYTES,
  DEFAULT_TIMEOUT_MS,
  extractLikelySecretMatch,
  formatReceiptText,
  fullOutputPathFromNotice,
  isDiagnosticCommand,
  mergeUsage,
  reducerInputPrompt,
  reducerInstructions,
  sha256Hex,
  validateReceipt,
  type UsageLike,
  type UsageTotals,
} from './reducer-core.ts';
import {
  appendEfficiencyLog,
  efficiencyLogPath,
  readBashFullOutput,
  reducerObjectPath,
  resolveSessionRoot,
  storeContentAddressedObject,
} from './efficiency-store.ts';
import type { EvidencePreservingReducerConfig } from './efficiency-config-core.ts';
import { diagnosticGateRequest, evaluateDiagnosticGate, isDiagnosticGateUnanswered } from './jev-core.ts';
import type { JevRuntime } from './jev-client.ts';

/** P0-1 seam: the runtime plus a live confidence gate (config can reload mid-session). */
export interface JevEprGateDependency {
  ask: JevRuntime['ask'];
  getMinConfidence: () => number;
}

export interface ToolResultEventLike {
  toolName: string;
  toolCallId: string;
  input?: Record<string, unknown>;
  content: Array<{ type: string; text?: string; [k: string]: unknown }>;
  details?: Record<string, unknown>;
  isError: boolean;
  usage?: UsageLike;
}

export interface ReducerInvocationResult {
  /** pi's ToolResultEventResult.content uses TextContent, so the literal type must stay narrow. */
  content?: Array<{ type: 'text'; text: string; [k: string]: unknown }>;
  /** Complete pi `Usage` (see mergeUsage): a partial object crashes pi's footer renderer. */
  usage?: UsageTotals;
}

/** The subset of pi's AssistantMessage the reducer reads. */
type ReducerModelOutput = {
  content?: readonly unknown[];
  text?: unknown;
  usage?: UsageLike;
};

type ReducerModel = NonNullable<ExtensionContext['model']>;

interface ReducerCandidate {
  command: string;
  block: { type: string; text?: string; [k: string]: unknown };
  text: string;
  fullOutputPath?: string;
  fullOutputSource: 'details' | 'notice' | 'none';
  isTruncated: boolean;
}

type ReducerLog = (record: Record<string, unknown>) => Promise<void>;

let untrustedWarningEmitted = false;

/** Steps 1–5: the trust boundary sits BEFORE the jev gate — an untrusted project must not send
 * commands to a third-party API even with user-level EPR on, and a refusing host must not be second-guessed. */
function resolveCandidate(
  event: ToolResultEventLike,
  ctx: ExtensionContext,
  config: EvidencePreservingReducerConfig,
): ReducerCandidate | undefined {
  if (event.toolName !== 'bash') return undefined;
  const command = typeof event.input?.command === 'string' ? event.input.command.trim() : '';
  if (!command) return undefined;

  const isTrusted =
    typeof (ctx as { isProjectTrusted?: () => boolean }).isProjectTrusted === 'function'
      ? (ctx as { isProjectTrusted: () => boolean }).isProjectTrusted()
      : false;
  if (!isTrusted) {
    if (!untrustedWarningEmitted) {
      untrustedWarningEmitted = true;
      console.warn('[pi-herdr] EPR 提炼已在未受信任项目中被安全禁用');
    }
    return undefined;
  }

  const block = event.content.find((b) => b && b.type === 'text' && typeof b.text === 'string');
  if (!block || typeof block.text !== 'string') return undefined;
  const text = block.text;

  const maxChars = config.maxChars ?? DEFAULT_MAX_CHARS;
  const detailPath = typeof event.details?.fullOutputPath === 'string' ? event.details.fullOutputPath : undefined;
  // Pi repeats the path inside the truncation notice that ships with the result text; a replayed or
  // re-shaped event can keep only that text, and reducing the preview would lose the evidence.
  const noticePath = fullOutputPathFromNotice(text);
  const isTruncated =
    (event.details?.truncation as { truncated?: boolean } | undefined)?.truncated === true;

  // Cheap reducibility precondition: a truncated output is presumed large (that is why pi truncated
  // it); anything else must clear minBytes/maxChars on the preview, which for non-truncated results
  // IS the full body. Commands below this line never pay for the gate call or the full read.
  if (!isTruncated && (Buffer.byteLength(text, 'utf8') < (config.minBytes ?? DEFAULT_MIN_BYTES) || text.length > maxChars)) {
    return undefined;
  }

  const fullOutputPath = detailPath ?? noticePath;
  return {
    command,
    block,
    text,
    ...(fullOutputPath ? { fullOutputPath } : {}),
    fullOutputSource: detailPath ? 'details' : noticePath ? 'notice' : 'none',
    isTruncated,
  };
}

/**
 * Step 6, jev first (RFC §3 P0-1): a confident jev rejection is authoritative even for regex-listed
 * commands; the regex list decides only when jev is absent, fails or answers below the confidence
 * gate (credential-shaped command lines stay local).
 */
async function isDiagnosticCandidate(
  command: string,
  gate: JevEprGateDependency | undefined,
  sessionId: string | undefined,
): Promise<boolean> {
  const regexHit = isDiagnosticCommand(command);
  if (!gate || containsLikelySecret(command)) return regexHit;
  const result = await gate.ask(diagnosticGateRequest(command), {
    questionId: 'epr-diagnostic-gate',
    timeoutMs: 1500, // cold TLS handshake hit 1002ms and timed out at 1s, warm calls run 250-770ms
    sessionId,
    // regex_hit makes the flip observable: how often and in which direction jev overrides the regex list (jev.jsonl).
    extra: { site: 'epr-gate', commandSha256: sha256Hex(command), regexHit },
    enrich: ({ answers }) => {
      if (!answers) return {};
      const verdict = evaluateDiagnosticGate(answers, gate.getMinConfidence());
      return {
        verdict: verdict.hit ? 'hit' : verdict.reason,
        choice: verdict.choice,
        noul: verdict.noul,
        confidence: verdict.confidence,
      };
    },
  });
  if (!result.ok) return regexHit;
  const verdict = evaluateDiagnosticGate(result.answers, gate.getMinConfidence());
  if (verdict.hit) return true;
  return isDiagnosticGateUnanswered(verdict) ? regexHit : false;
}

/** Step 7: the untruncated source; both failure modes write the same `truncated-source` evidence
 * row, which lands only for candidates that got here — gate-rejected commands never read a file. */
async function readSource(
  candidate: ReducerCandidate,
  config: EvidencePreservingReducerConfig,
  log: ReducerLog,
): Promise<string | null> {
  const truncatedRow = (): Promise<void> =>
    log({
      model: config.model ?? 'default',
      verificationOk: false,
      reason: 'truncated-source',
      action: 'fallback_full_text',
      fullOutputSource: candidate.fullOutputSource,
    });

  if (candidate.isTruncated && !candidate.fullOutputPath) {
    await truncatedRow();
    return null; // Truncated with no recoverable full log: fail open rather than reduce the preview.
  }
  if (!candidate.fullOutputPath) return candidate.text;
  const full = await readBashFullOutput(candidate.fullOutputPath, config.maxChars ?? DEFAULT_MAX_CHARS);
  if (!full) {
    await truncatedRow();
    return null;
  }
  return full.content;
}

/** Steps 7/P0: the source archive is mandatory before any modification; a failed write fails open. */
async function archiveSource(sessionRoot: string, body: string): Promise<string | null> {
  const path = reducerObjectPath(sessionRoot, sha256Hex(body));
  try {
    await storeContentAddressedObject(path, body);
  } catch {
    return null;
  }
  return path;
}

/** Step 8: the configured cheap reducer first, the session model as fallback. */
function resolveReducerModel(
  ctx: ExtensionContext,
  config: EvidencePreservingReducerConfig,
): { model: ReducerModel; label: string; source: 'configured' | 'session-fallback' } | undefined {
  let model: ReducerModel | undefined;
  if (config.model && typeof config.model === 'string' && config.model.includes('/')) {
    const [provider, ...rest] = config.model.split('/');
    try {
      model = ctx.modelRegistry?.find?.(provider, rest.join('/'));
    } catch {
      model = undefined;
    }
  }
  const source = model ? 'configured' : 'session-fallback';
  if (!model) model = ctx.model;
  if (!model || typeof ctx.modelRegistry?.complete !== 'function') return undefined;
  const label =
    model.provider && model.id ? `${model.provider}/${model.id}` : (config.model ?? 'unknown');
  return { model, label, source };
}

/** Step 9: in-process model call under a total-latency budget through pi's own completion, so the
 * reducer runs on the session's provider auth; failure text is returned for telemetry. */
async function invokeReducer(
  ctx: ExtensionContext,
  config: EvidencePreservingReducerConfig,
  model: ReducerModel,
  promptInput: string,
): Promise<{ output: ReducerModelOutput; durationMs: number } | { error: string; durationMs: number }> {
  const timeoutSignal = AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeoutSignal]) : timeoutSignal;
  const startMs = Date.now();
  try {
    const output: ReducerModelOutput = await ctx.modelRegistry.complete(
      model,
      {
        systemPrompt: reducerInstructions(),
        messages: [{ role: 'user', content: [{ type: 'text', text: promptInput }], timestamp: Date.now() }],
      },
      { maxTokens: config.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS, cacheRetention: 'none', signal },
    );
    return { output, durationMs: Date.now() - startMs };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - startMs };
  }
}

export async function handleReducerToolResult(
  event: ToolResultEventLike,
  ctx: ExtensionContext,
  config: EvidencePreservingReducerConfig,
  opts?: { epoch?: number; jev?: JevEprGateDependency },
): Promise<ReducerInvocationResult | undefined> {
  if (!config.enabled) return undefined;
  const epoch = opts?.epoch ?? 0;

  const candidate = resolveCandidate(event, ctx, config);
  if (!candidate) return undefined;
  const { command, block } = candidate;
  const minBytes = config.minBytes ?? DEFAULT_MIN_BYTES;
  const maxChars = config.maxChars ?? DEFAULT_MAX_CHARS;

  const sessionId = ctx.sessionManager?.getSessionId?.();
  const sessionRoot = resolveSessionRoot(ctx.sessionManager?.getSessionDir?.(), sessionId);
  if (!sessionRoot) return undefined;

  if (!(await isDiagnosticCandidate(command, opts?.jev, sessionId))) return undefined;

  const log: ReducerLog = async (record) => {
    if (!config.logEnabled) return;
    await logReducerAttempt(sessionRoot, sessionId ?? 'unknown', epoch, {
      commandSha256: sha256Hex(command),
      ...record,
    });
  };

  const body = await readSource(candidate, config, log);
  if (body === null) return undefined;

  // Step 8: size gates on the resolved body (a truncated output's true size is only known here).
  const sourceBytes = Buffer.byteLength(body, 'utf8');
  if (sourceBytes < minBytes || body.length > maxChars) return undefined;

  // Step 9: credential heuristic; `secretSnippet` names the shape that tripped the gate.
  if (containsLikelySecret(body)) {
    await log({
      sourceBytes,
      model: config.model ?? 'default',
      verificationOk: false,
      reason: 'likely-secret',
      action: 'fallback_full_text',
      secretSnippet: extractLikelySecretMatch(body),
    });
    return undefined;
  }

  const sourceHash = sha256Hex(body);
  const sourceLines = countLines(body);
  const archivePath = await archiveSource(sessionRoot, body);
  if (archivePath === null) return undefined;
  if (config.localOnly) return undefined; // Archival is the whole job in local-only mode.

  const reducer = resolveReducerModel(ctx, config);
  if (!reducer) return undefined;
  /** Evidence row for a fail-open exit taken after the reducer model was resolved. */
  const fallbackRow = (reason: string, durationMs: number, extra: Record<string, unknown> = {}): Promise<void> =>
    log({
      sourceBytes,
      model: reducer.label,
      reducerModelSource: reducer.source,
      verificationOk: false,
      reason,
      action: 'fallback_full_text',
      durationMs,
      ...extra,
    });

  const invocation = await invokeReducer(
    ctx,
    config,
    reducer.model,
    reducerInputPrompt({ command, isError: event.isError, sourceHash, sourceBytes, sourceLines, body }),
  );
  if ('error' in invocation) {
    await fallbackRow('invoke-failed', invocation.durationMs, { error: invocation.error });
    return undefined;
  }
  const { output, durationMs } = invocation;

  const blocks: readonly unknown[] | undefined = Array.isArray(output.content) ? output.content : undefined;
  const modelOutput = blocks
    ? blocks
        .map((block) => {
          const text = (block as { text?: unknown }).text;
          return typeof text === 'string' ? text : '';
        })
        .join('')
    : typeof output.text === 'string'
      ? output.text
      : '';
  if (!modelOutput.trim()) return undefined;

  const validated = validateReceipt(modelOutput, sourceHash, body, event.isError);
  if (!validated.ok) {
    // Keep a sanitized head: invalid-json rows must show what the model actually returned.
    const head = validated.reason === 'invalid-json' ? { rawOutputHead: JSON.stringify(modelOutput.slice(0, 200)) } : {};
    await fallbackRow(validated.reason, durationMs, head);
    return undefined;
  }

  // Step 11: block-level replacement — only the log block, so write-lock warnings survive.
  const receipt = formatReceiptText({
    command,
    sourceHash,
    sourceBytes,
    sourceLines,
    sourceArtifactPath: archivePath,
    validated: validated.value,
    model: reducer.model.id ?? config.model ?? 'default',
    provider: typeof reducer.model.provider === 'string' ? reducer.model.provider : undefined,
    totalTokens: output.usage?.totalTokens,
  });
  const receiptBytes = Buffer.byteLength(receipt, 'utf8');
  if (receiptBytes >= sourceBytes) return undefined;

  await log({
    sourceBytes,
    receiptBytes,
    grossSavedBytes: sourceBytes - receiptBytes,
    compressionRatio: Number((receiptBytes / sourceBytes).toFixed(3)),
    model: reducer.label,
    reducerModelSource: reducer.source,
    verificationOk: true,
    action: 'applied',
    fullOutputSource: candidate.fullOutputSource,
    durationMs,
  });

  return {
    content: event.content.map((b): { type: 'text'; text: string } =>
      (b === block ? { ...b, text: receipt } : b) as { type: 'text'; text: string }),
    usage: mergeUsage(event.usage, output.usage),
  };
}

async function logReducerAttempt(
  sessionRoot: string,
  sessionId: string,
  epoch: number,
  record: Record<string, unknown>,
): Promise<void> {
  try {
    await appendEfficiencyLog(efficiencyLogPath(sessionRoot, 'reducer'), {
      schema: 'pier-efficiency/1',
      mechanism: 'evidencePreservingReducer',
      ts: new Date().toISOString(),
      sessionId,
      epoch,
      ...record,
    });
  } catch {
  }
}
