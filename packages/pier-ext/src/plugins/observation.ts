/**
 * D101 ObservationPack plugin: the `obs_recall` tool plus the `context` interceptor projecting
 * placeholders for large tool results after their first fullSends requests (JSONL stays intact).
 * Cache-aware packing decisions, role visibility gates, append-only telemetry.
 */
import type {
  ContextEvent,
  ContextEventResult,
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { containsReducerReceipt, countLines, deriveObservationId, estimateTokens, formatObservationPlaceholder, isObservationId, sha256Hex, shouldPackForCache } from '../observation-core.ts';
import { appendEfficiencyLog, efficiencyLogPath, observationObjectPath, readStoredObjectChunk, resolveSessionRoot, storeContentAddressedObject } from '../efficiency-store.ts';
import { resolveEfficiencyConfig, type EfficiencyConfig, type ObservationPackConfig } from '../efficiency-config-core.ts';
import { resolveCacheRatioFromCost } from '../compact-economics-core.ts';
import { planToolGate, type RuntimeRoleManifest } from '../tool-gate.ts';
import { toolError } from '../tool-error.ts';

export const RECALL_TOOL_NAME = 'obs_recall';
const RECALL_MAX_BYTES = 16 * 1024;
const RECALL_MAX_LINES = 400;
const MAX_MEMO_ENTRIES = 256;
const MAX_BATCH_PACK_ITEMS = 20;
const MAX_BATCH_PACK_BYTES = 10 * 1024 * 1024;

const loggedPackedObsIds = new Set<string>();

interface MemoizedPlaceholder { placeholder: string; obsId: string }

const placeholderMemo = new Map<string, MemoizedPlaceholder>();

/** Subset of pi context messages this plugin reads; anything else is left untouched. */
interface ContextMessage { role?: unknown; isError?: unknown; toolName?: unknown; toolCallId?: unknown; content?: unknown }

function contentCharLength(content: readonly unknown[]): number {
  let length = content.length - 1;
  for (const b of content as Array<{ text?: unknown }>) {
    if (b && typeof b.text === 'string') length += b.text.length;
  }
  return length;
}

/** Id + placeholder for a candidate message, derived from name/call/text (no I/O). */
function buildPlaceholder(
  toolName: string,
  toolCallId: string,
  text: string,
  textBytes: number,
  obsConfig: ObservationPackConfig,
  middle?: ExcerptMiddlePick,
): { id: string; placeholder: string; contentHash: string } {
  const contentHash = sha256Hex(text);
  const id = deriveObservationId(toolName, toolCallId, contentHash);
  return {
    id,
    contentHash,
    placeholder: formatObservationPlaceholder({
      id,
      toolName,
      bytes: textBytes,
      lines: countLines(text),
      tokens: estimateTokens(text),
      text,
      fullSends: obsConfig.fullSends,
      excerptBudget: obsConfig.excerptBytes,
      middle,
    }),
  };
}

function memoKeyFor(sessionRoot: string, toolCallId: string, charLength: number): string {
  return `${sessionRoot}:${toolCallId}:${charLength}`;
}

/** Append one observation.jsonl record; telemetry is always best-effort. */
async function logObservation(sessionRoot: string, fields: Record<string, unknown>): Promise<void> {
  try {
    await appendEfficiencyLog(efficiencyLogPath(sessionRoot, 'observation'), {
      schema: 'pier-efficiency/1',
      mechanism: 'observationPack',
      ts: new Date().toISOString(),
      ...fields,
    });
  } catch {
    /* Telemetry is best-effort. */
  }
}

export function clearObservationMemoForTest(): void {
  placeholderMemo.clear();
  loggedPackedObsIds.clear();
}

interface ExcerptMiddlePick {
  text: string;
  label: string;
}

/** P0-3 seam: async middle-window picker (jev-backed); null keeps the legacy head+tail halves. */
export type PickMiddleExcerpt = (text: string, excerptBudgetBytes: number) => Promise<ExcerptMiddlePick | null>;

/**
 * Build the OCC `onBeforeCompact` hook: role-gated, config-gated batch packing of the branch's
 * large tool results before `ctx.compact()` rewrites the prefix. Exported (rather than inlined in
 * index.ts) so the gate behaviour is unit-testable.
 */
export function createCompactionBatchPackHook(deps: {
  getObsConfig: () => ObservationPackConfig;
  getManifest?: () => RuntimeRoleManifest | null;
  getSessionId?: () => string | undefined;
  pickMiddleExcerpt?: PickMiddleExcerpt;
}): (sessionRoot: string, ctx: unknown) => Promise<void> {
  return async (sessionRoot: string, ctx: unknown): Promise<void> => {
    const obsConfig = deps.getObsConfig();
    if (!obsConfig.enabled) return;

    // Role gate: a role that cannot call obs_recall must not receive placeholders.
    const manifest = deps.getManifest?.() ?? null;
    if (manifest && planToolGate(RECALL_TOOL_NAME, manifest).kind === 'deny') return;

    const branch = (ctx as { sessionManager?: { getBranch?: () => readonly unknown[] } })
      ?.sessionManager?.getBranch?.() ?? [];
    const messages = branch.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const e = entry as { type?: unknown; message?: unknown };
      return e.type === 'message' && e.message ? [e.message] : [];
    });

    await batchPackObservations({
      sessionRoot,
      sessionId: deps.getSessionId?.(),
      messages,
      obsConfig,
      pickMiddleExcerpt: deps.pickMiddleExcerpt,
    });
  };
}

/**
 * Shared packing primitive: derive id/placeholder, archive the object, memoize it, and append the
 * `observation.jsonl` record exactly once. Keeping memo + telemetry in one place prevents the
 * "memo written but log forgotten" (or vice versa) divergence between projection and batch paths.
 * Returns the placeholder, or null when the object could not be stored.
 */
async function packOneMessage(opts: {
  sessionRoot: string;
  toolName: string;
  toolCallId: string;
  text: string;
  textBytes: number;
  charLength: number;
  obsConfig: ObservationPackConfig;
  /** `extra` carries audit fields such as `source: 'compaction'`, `sendCount`, `tailTokensAfter`. */
  log?: { logEnabled: boolean; event: 'packed' | 'packed-batch'; sessionId?: string; extra?: Record<string, unknown> };
  pickMiddleExcerpt?: PickMiddleExcerpt;
  /** Prefetched middle excerpt (the batch path runs picks concurrently); null/undefined = none. */
  middle?: ExcerptMiddlePick | null;
}): Promise<string | null> {
  const { sessionRoot, toolName, toolCallId, text, textBytes, charLength, obsConfig, log, pickMiddleExcerpt } = opts;
  const middle = opts.middle !== undefined
    ? (opts.middle ?? undefined)
    : pickMiddleExcerpt
      ? (await pickMiddleExcerpt(text, obsConfig.excerptBytes)) ?? undefined
      : undefined;
  const { id: obsId, placeholder, contentHash } = buildPlaceholder(toolName, toolCallId, text, textBytes, obsConfig, middle);
  const originalTokens = estimateTokens(text);
  const placeholderTokens = estimateTokens(placeholder);

  try {
    await storeContentAddressedObject(observationObjectPath(sessionRoot, obsId), text, {
      bytes: textBytes,
      hash: contentHash,
      lines: countLines(text),
    });
  } catch {
    return null;
  }

  if (placeholderMemo.size >= MAX_MEMO_ENTRIES) {
    const oldest = placeholderMemo.keys().next().value;
    if (oldest) placeholderMemo.delete(oldest);
  }
  placeholderMemo.set(memoKeyFor(sessionRoot, toolCallId, charLength), { placeholder, obsId });

  if (log?.logEnabled && !loggedPackedObsIds.has(obsId)) {
    loggedPackedObsIds.add(obsId);
    await logObservation(sessionRoot, {
      event: log.event,
      sessionId: log.sessionId ?? 'unknown',
      obsId,
      toolName,
      originalBytes: textBytes,
      originalTokens,
      placeholderTokens,
      grossSavedTokens: Math.max(0, originalTokens - placeholderTokens),
      ...(log.extra ?? {}),
    });
  }

  return placeholder;
}

/** One packable message: a non-error tool result with text-only content that is not yet packed. */
interface PackCandidate { toolName: string; toolCallId: string; text: string; textBytes: number; charLength: number }

/** Eligibility shared by the projection path and the compaction batch path; null = leave untouched. */
function packCandidateAt(messages: readonly unknown[], index: number, sessionRoot: string): PackCandidate | null {
  const msg = messages[index] as ContextMessage | undefined;
  if (!msg || msg.role !== 'toolResult' || msg.isError) return null;
  const content = msg.content;
  if (!Array.isArray(content) || content.length === 0) return null;
  if (!content.every((b) => b && b.type === 'text' && typeof b.text === 'string')) return null;
  const text = (content as Array<{ text: string }>).map((b) => b.text).join('\n');
  const toolName = typeof msg.toolName === 'string' ? msg.toolName : 'tool';
  const toolCallId = typeof msg.toolCallId === 'string' ? msg.toolCallId : `call_${index}`;
  if (placeholderMemo.has(memoKeyFor(sessionRoot, toolCallId, contentCharLength(content)))) return null;
  if (containsReducerReceipt(text)) return null;
  return {
    toolName,
    toolCallId,
    text,
    textBytes: Buffer.byteLength(text, 'utf8'),
    charLength: contentCharLength(content),
  };
}

export async function batchPackObservations(opts: {
  sessionRoot: string;
  sessionId?: string;
  messages: readonly unknown[];
  obsConfig: ObservationPackConfig;
  limits?: { maxItems?: number; maxBytes?: number };
  pickMiddleExcerpt?: PickMiddleExcerpt;
}): Promise<number> {
  const { sessionRoot, sessionId, messages, obsConfig } = opts;
  if (!obsConfig.enabled || !sessionRoot || !Array.isArray(messages)) return 0;

  const maxItems = opts.limits?.maxItems ?? MAX_BATCH_PACK_ITEMS;
  const maxBytes = opts.limits?.maxBytes ?? MAX_BATCH_PACK_BYTES;

  // Pass 1 — select with the deterministic checks (memo, receipt, size, soft byte cap). Selection is
  // optimistic on bytes: a later store failure can only pack fewer items, never more than the caps.
  const candidates: PackCandidate[] = [];
  let selectedBytes = 0;
  for (let i = 0; i < messages.length && candidates.length < maxItems; i++) {
    const candidate = packCandidateAt(messages, i, sessionRoot);
    if (!candidate || candidate.textBytes < obsConfig.thresholdBytes) continue;
    if (selectedBytes + candidate.textBytes > maxBytes && candidates.length > 0) break;
    selectedBytes += candidate.textBytes;
    candidates.push(candidate);
  }
  if (candidates.length === 0) return 0;

  // Pass 2 — prefetch middle excerpts concurrently: every packed output asks jev, so a serial loop
  // would block onBeforeCompact for maxItems × (0.25–0.77s) per compaction.
  const picker = opts.pickMiddleExcerpt;
  const middles = picker
    ? await Promise.all(candidates.map((c) => picker(c.text, obsConfig.excerptBytes)))
    : [];

  // Pass 3 — pack with the prefetched excerpts (store failures pack fewer).
  let packedCount = 0;
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]!;
    const packed = await packOneMessage({
      sessionRoot,
      ...candidate,
      obsConfig,
      log: { logEnabled: obsConfig.logEnabled, event: 'packed-batch', sessionId, extra: { source: 'compaction' } },
      middle: picker ? (middles[i] ?? null) : undefined,
    });
    if (packed) packedCount++;
  }
  return packedCount;
}

/** `obs_recall` body: page through a stored observation, self-healing the memo when storage is gone. */
async function runRecall(
  params: { id?: unknown; offset?: unknown } | undefined,
  ctx: ExtensionContext,
  getConfig?: (ctx: ExtensionContext) => EfficiencyConfig,
): Promise<{ content: Array<{ type: 'text'; text: string }>; details: Record<string, unknown> }> {
  const rawId = params?.id;
  if (typeof rawId !== 'string' || !isObservationId(rawId)) {
    // A1: hard failures throw so pi flags isError for the model.
    return toolError(`invalid observation id format: "${String(rawId)}"`);
  }
  const id = rawId;
  const offset = typeof params?.offset === 'number' ? params.offset : 0;

  const sessionDir = ctx?.sessionManager?.getSessionDir?.();
  const sessionId = ctx?.sessionManager?.getSessionId?.();
  const sessionRoot = resolveSessionRoot(sessionDir, sessionId);
  if (!sessionRoot) return toolError('session storage is unavailable for observation recall.');

  const startMs = Date.now();
  const effConfig = getConfig ? getConfig(ctx) : resolveEfficiencyConfig();
  try {
    const chunk = await readStoredObjectChunk(observationObjectPath(sessionRoot, id), offset, {
      maxBytes: effConfig.observationPack.recallChunkBytes ?? RECALL_MAX_BYTES,
      maxLines: RECALL_MAX_LINES,
    });

    const header = [
      `[obs_recall id=${id} offset=${offset} next_offset=${chunk.nextOffset} eof=${chunk.eof}]`,
      `[chunk_bytes=${chunk.bytes} chunk_lines=${chunk.lines}; use next_offset to continue]`,
    ].join('\n');

    if (effConfig.observationPack.logEnabled) {
      void logObservation(sessionRoot, {
        event: 'recall',
        sessionId: sessionId ?? 'unknown',
        obsId: id,
        offset,
        chunkBytes: chunk.bytes,
        lines: chunk.lines,
        nextOffset: chunk.nextOffset,
        eof: chunk.eof,
        durationMs: Date.now() - startMs,
      });
    }

    return {
      content: [{ type: 'text', text: `${header}\n${chunk.text}` }],
      details: {
        id,
        offset,
        bytes: chunk.bytes,
        lines: chunk.lines,
        nextOffset: chunk.nextOffset,
        eof: chunk.eof,
      },
    };
  } catch (err) {
    // Missing/corrupted object: drop the memo so a later send can repack this observation.
    for (const [k, v] of placeholderMemo.entries()) {
      if (v.obsId === id) placeholderMemo.delete(k);
    }
    return {
      content: [
        {
          type: 'text',
          text: `Error: failed to recall observation ${id}: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      details: {},
    };
  }
}

/** All deps optional: the plugin must work without efficiency config or jev. */
interface ObservationPackDeps {
  getConfig?: (ctx: ExtensionContext) => EfficiencyConfig;
  getRuntimeManifest?: () => RuntimeRoleManifest | null;
  getRemainingHorizon?: () => number;
  pickMiddleExcerpt?: PickMiddleExcerpt;
}

/** `context` interceptor: replace eligible large tool results with their memoized/stored placeholders. */
async function projectPlaceholders(
  event: ContextEvent,
  ctx: ExtensionContext,
  deps: ObservationPackDeps,
): Promise<ContextEventResult | undefined> {
  if (!event || !Array.isArray(event.messages)) return undefined;

  const effConfig = deps.getConfig ? deps.getConfig(ctx) : resolveEfficiencyConfig();
  const obsConfig: ObservationPackConfig = effConfig.observationPack;
  if (!obsConfig.enabled) return undefined;

  // Role visibility gate: a role denied obs_recall would get an unusable handle, so skip entirely.
  const manifest = deps.getRuntimeManifest ? deps.getRuntimeManifest() : null;
  if (manifest && planToolGate(RECALL_TOOL_NAME, manifest).kind === 'deny') return undefined;

  const sessionDir = ctx?.sessionManager?.getSessionDir?.();
  const sessionId = ctx?.sessionManager?.getSessionId?.();
  const sessionRoot = resolveSessionRoot(sessionDir, sessionId);
  if (!sessionRoot) return undefined; // Fail-open if session directory is absent.

  // Only the projection fields are read; AgentMessage is structurally wider than ContextMessage.
  const projected = [...event.messages] as unknown as ContextMessage[];
  const len = projected.length;

  // Assistant responses following each message = its send count.
  const priorAssistantCounts = new Array<number>(len);
  let assistantCount = 0;
  for (let i = len - 1; i >= 0; i--) {
    priorAssistantCounts[i] = assistantCount;
    if (projected[i]?.role === 'assistant') assistantCount++;
  }

  for (let i = 0; i < len; i++) {
    const msg = projected[i];
    if (!msg || msg.role !== 'toolResult' || msg.isError) continue;
    const content = msg.content;
    if (!Array.isArray(content) || content.length === 0) continue;
    if (!content.every((b) => b && b.type === 'text' && typeof b.text === 'string')) continue;

    const toolCallId = typeof msg.toolCallId === 'string' ? msg.toolCallId : `call_${i}`;
    // N1' fast path: the memo is keyed by session+call+content length, so it answers before the text
    // join, the receipt scan, and the byte count — once packed, a message stays packed until eviction.
    const memoKey = memoKeyFor(sessionRoot, toolCallId, contentCharLength(content));
    const memoized = placeholderMemo.get(memoKey);
    if (memoized) {
      placeholderMemo.delete(memoKey); // refresh LRU position
      placeholderMemo.set(memoKey, memoized);
      projected[i] = { ...msg, content: [{ type: 'text', text: memoized.placeholder }] };
      continue;
    }

    // Active use window: leave the full text alone until the message has been sent fullSends times.
    const sendCount = priorAssistantCounts[i] ?? 0;
    if (sendCount < obsConfig.fullSends) continue;

    const candidate = packCandidateAt(projected, i, sessionRoot);
    if (!candidate || candidate.textBytes < obsConfig.thresholdBytes) continue;

    let tailTokensAfter = 0;
    for (let j = i + 1; j < len; j++) {
      const after = projected[j]?.content;
      if (!Array.isArray(after)) continue;
      for (const b of after as Array<{ type?: unknown; text?: unknown }>) {
        if (b && b.type === 'text' && typeof b.text === 'string') tailTokensAfter += estimateTokens(b.text);
      }
    }

    // Projected saving of the legacy placeholder drives the economic decision; packOneMessage
    // recomputes the same placeholder when the answer is yes.
    const originalTokens = estimateTokens(candidate.text);
    const estimate = buildPlaceholder(candidate.toolName, candidate.toolCallId, candidate.text, candidate.textBytes, obsConfig);
    const removedTokens = Math.max(0, originalTokens - estimateTokens(estimate.placeholder));
    // Same resolution as OCC (provider family / token-account fallback): passing a raw 'auto' would
    // let shouldPackForCache fall back on its own hardcoded ratio and diverge from compaction.
    const cacheRatio = resolveCacheRatioFromCost(
      effConfig.onlineContextCompact.cacheWriteReadRatio,
      ctx.model?.cost,
      { provider: ctx.model?.provider, modelId: ctx.model?.id },
    );
    const canPack = shouldPackForCache({
      removedTokens,
      tailTokensAfter,
      expectedRemainingRequests: deps.getRemainingHorizon ? deps.getRemainingHorizon() : 4,
      cacheWriteReadRatio: cacheRatio,
    });
    if (!canPack) continue;

    const packed = await packOneMessage({
      sessionRoot,
      ...candidate,
      obsConfig,
      log: {
        logEnabled: obsConfig.logEnabled,
        event: 'packed',
        sessionId,
        extra: { sendCount, tailTokensAfter },
      },
      pickMiddleExcerpt: deps.pickMiddleExcerpt,
    });
    if (!packed) continue;
    projected[i] = { ...msg, content: [{ type: 'text', text: packed }] };
  }

  // Projection only replaces whole text blocks, so the messages stay valid AgentMessages.
  return { messages: projected as unknown as ContextEvent['messages'] };
}

export function registerObservationPack(deps: ObservationPackDeps & { pi: ExtensionAPI }): void {
  const { pi } = deps;

  pi.registerTool({
    name: RECALL_TOOL_NAME,
    label: 'Recall Observation',
    description:
      'Recall a paged slice of a previously replaced large tool result by observation id and byte offset.',
    promptGuidelines: [
      'Call obs_recall with id and offset to inspect specific parts of large tool outputs.',
      'Check the returned next_offset and eof to page through long logs.',
    ],
    parameters: Type.Object({
      id: Type.String({ description: 'Observation ID from placeholder (e.g. obs_...)' }),
      offset: Type.Optional(
        Type.Integer({ minimum: 0, description: 'Byte offset to recall from (default 0)' }),
      ),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      void toolCallId;
      return runRecall(params, ctx, deps.getConfig);
    },
  });

  pi.on('context', (event, ctx) => projectPlaceholders(event, ctx, deps));
}
