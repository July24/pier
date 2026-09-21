/**
 * D101 ObservationPack Plugin & Context Interceptor.
 *
 * Provides:
 *  - `obs_recall` tool for paged retrieval of replaced large tool results.
 *  - `context` lifecycle interception: projects placeholders for large tool results
 *    that have exceeded fullSends, keeping underlying JSONL intact.
 *  - Cache-aware packing decisions and role visibility guards.
 *  - Append-only telemetry auditing.
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import {
  containsReducerReceipt,
  countLines,
  deriveObservationId,
  estimateTokens,
  formatObservationPlaceholder,
  isObservationId,
  sha256Hex,
  shouldPackForCache,
} from '../observation-core.ts';
import {
  appendEfficiencyLog,
  efficiencyLogPath,
  observationObjectPath,
  readStoredObjectChunk,
  resolveSessionRoot,
  storeContentAddressedObject,
} from '../efficiency-store.ts';
import {
  resolveEfficiencyConfig,
  type EfficiencyConfig,
  type ObservationPackConfig,
} from '../efficiency-config-core.ts';
import { resolveCacheRatioFromCost } from '../compact-economics-core.ts';
import { planToolGate, type RuntimeRoleManifest } from '../tool-gate.ts';
import { toolError } from '../tool-error.ts';

export const RECALL_TOOL_NAME = 'obs_recall';
export const RECALL_MAX_BYTES = 16 * 1024;
export const RECALL_MAX_LINES = 400;

const loggedPackedObsIds = new Set<string>();

interface MemoizedPlaceholder {
  placeholder: string;
  obsId: string;
  bytes: number;
}

const placeholderMemo = new Map<string, MemoizedPlaceholder>();
const MAX_MEMO_ENTRIES = 256;

export function contentJoinedLength(content: Array<{ text?: string }>): number {
  if (content.length === 0) return 0;
  let len = content.length - 1; // newline separators between blocks
  for (let i = 0; i < content.length; i++) {
    len += content[i]?.text?.length ?? 0;
  }
  return len;
}

export function memoKeyFor(sessionRoot: string, toolCallId: string, charLength: number): string {
  return `${sessionRoot}:${toolCallId}:${charLength}`;
}

export function invalidateObservationMemo(obsId: string): void {
  for (const [k, v] of placeholderMemo.entries()) {
    if (v.obsId === obsId) {
      placeholderMemo.delete(k);
    }
  }
}

export function clearObservationMemoForTest(): void {
  placeholderMemo.clear();
  loggedPackedObsIds.clear();
}

export const MAX_BATCH_PACK_ITEMS = 20;
export const MAX_BATCH_PACK_BYTES = 10 * 1024 * 1024; // 10MB limit per batch

/**
 * Build the OCC `onBeforeCompact` hook: role-gated, config-gated batch packing of the
 * branch's large tool results before `ctx.compact()` rewrites the prefix.
 * Exported (rather than inlined in index.ts) so the gate behaviour is unit-testable.
 */
export interface ExcerptMiddlePick {
  text: string;
  label: string;
}

/** P0-3 seam: async middle-window picker (jev-backed); null keeps the legacy halves. */
export type PickMiddleExcerpt = (text: string, excerptBudgetBytes: number) => Promise<ExcerptMiddlePick | null>;

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

    const branch = (ctx as { sessionManager?: { getBranch?: () => readonly unknown[] } })?.sessionManager?.getBranch?.() ?? [];
    const messages = branch.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const e = entry as { type?: unknown; message?: unknown };
      return e.type === 'message' && e.message ? [e.message] : [];
    });

    const sessionId = deps.getSessionId?.();
    await batchPackObservations({
      sessionRoot,
      sessionId,
      messages,
      obsConfig,
      pickMiddleExcerpt: deps.pickMiddleExcerpt,
    });
  };
}

export interface PackMessageResult {
  obsId: string;
  placeholder: string;
  originalBytes: number;
  originalTokens: number;
  placeholderTokens: number;
  grossSavedTokens: number;
}

export interface PackLogOptions {
  logEnabled: boolean;
  event: 'packed' | 'packed-batch';
  sessionId?: string;
  /** Extra audit fields (e.g. `source: 'compaction'`, `sendCount`, `tailTokensAfter`). */
  extra?: Record<string, unknown>;
}

/**
 * Shared packing primitive: derive id/placeholder, archive the object, memoize it, and append
 * the `observation.jsonl` record exactly once. Keeping memo + telemetry in one place prevents the
 * "wrote the memo but forgot the log" (or vice versa) divergence between the projection path and
 * the compaction batch path.
 */
export async function packOneMessage(opts: {
  sessionRoot: string;
  toolName: string;
  toolCallId: string;
  text: string;
  textBytes: number;
  charLength: number;
  obsConfig: ObservationPackConfig;
  log?: PackLogOptions;
  pickMiddleExcerpt?: PickMiddleExcerpt;
  /** Precomputed middle excerpt (the batch path prefetches concurrently); null = none. */
  middle?: ExcerptMiddlePick | null;
}): Promise<PackMessageResult | null> {
  const { sessionRoot, toolName, toolCallId, text, textBytes, charLength, obsConfig, log, pickMiddleExcerpt } = opts;
  const contentHash = sha256Hex(text);
  const obsId = deriveObservationId(toolName, toolCallId, contentHash);
  const originalTokens = estimateTokens(text);
  const lines = countLines(text);
  const middle = opts.middle !== undefined
    ? (opts.middle ?? undefined)
    : pickMiddleExcerpt
      ? (await pickMiddleExcerpt(text, obsConfig.excerptBytes)) ?? undefined
      : undefined;
  const placeholder = formatObservationPlaceholder({
    id: obsId,
    toolName,
    bytes: textBytes,
    lines,
    tokens: originalTokens,
    text,
    fullSends: obsConfig.fullSends,
    excerptBudget: obsConfig.excerptBytes,
    middle,
  });
  const placeholderTokens = estimateTokens(placeholder);
  const removedTokens = Math.max(0, originalTokens - placeholderTokens);

  const objPath = observationObjectPath(sessionRoot, obsId);
  try {
    await storeContentAddressedObject(objPath, text, {
      bytes: textBytes,
      hash: contentHash,
      lines,
    });
  } catch {
    return null;
  }

  const memoKey = memoKeyFor(sessionRoot, toolCallId, charLength);
  if (placeholderMemo.size >= MAX_MEMO_ENTRIES) {
    const oldest = placeholderMemo.keys().next().value;
    if (oldest) placeholderMemo.delete(oldest);
  }
  placeholderMemo.set(memoKey, {
    placeholder,
    obsId,
    bytes: textBytes,
  });

  if (log?.logEnabled && !loggedPackedObsIds.has(obsId)) {
    loggedPackedObsIds.add(obsId);
    try {
      await appendEfficiencyLog(efficiencyLogPath(sessionRoot, 'observation'), {
        schema: 'pier-efficiency/1',
        mechanism: 'observationPack',
        event: log.event,
        ts: new Date().toISOString(),
        sessionId: log.sessionId ?? 'unknown',
        obsId,
        toolName,
        originalBytes: textBytes,
        originalTokens,
        placeholderTokens,
        grossSavedTokens: removedTokens,
        ...(log.extra ?? {}),
      });
    } catch {
      /* telemetry is best-effort */
    }
  }

  return {
    obsId,
    placeholder,
    originalBytes: textBytes,
    originalTokens,
    placeholderTokens,
    grossSavedTokens: removedTokens,
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

  // Pass 1 — select candidates with the deterministic checks (memo, receipt,
  // size, soft byte cap). Selection is optimistic on bytes: a later store
  // failure can only pack fewer items, never more than the caps allow.
  interface BatchCandidate {
    toolName: string;
    toolCallId: string;
    text: string;
    textBytes: number;
    charLength: number;
  }
  const candidates: BatchCandidate[] = [];
  let selectedBytes = 0;
  for (let i = 0; i < messages.length; i++) {
    if (candidates.length >= maxItems) break;
    const msg = messages[i];
    if (!msg || msg.role !== 'toolResult' || (msg as { isError?: boolean }).isError) continue;
    const content = (msg as { content?: Array<{ type: string; text?: string }> }).content;
    if (!Array.isArray(content) || content.length === 0) continue;
    if (!content.every((b) => b && b.type === 'text' && typeof b.text === 'string')) continue;

    const toolName = (msg as { toolName?: string }).toolName ?? 'tool';
    const toolCallId = (msg as { toolCallId?: string }).toolCallId ?? `call_${i}`;
    const charLength = contentJoinedLength(content);

    const memoKey = memoKeyFor(sessionRoot, toolCallId, charLength);
    if (placeholderMemo.has(memoKey)) continue;

    const text = content.map((b) => b.text ?? '').join('\n');
    if (containsReducerReceipt(text)) continue;

    const textBytes = Buffer.byteLength(text, 'utf8');
    if (textBytes < obsConfig.thresholdBytes) continue;

    // Check soft maxBytes limit before packing
    if (selectedBytes + textBytes > maxBytes && candidates.length > 0) break;
    selectedBytes += textBytes;
    candidates.push({ toolName, toolCallId, text, textBytes, charLength });
  }
  if (candidates.length === 0) return 0;

  // Pass 2 — prefetch middle excerpts CONCURRENTLY. Since the 2026-09-19
  // jev-first flip every packed output asks jev; a serial loop would block
  // onBeforeCompact for up to maxItems × (0.25–0.77s) per compaction.
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
      toolName: candidate.toolName,
      toolCallId: candidate.toolCallId,
      text: candidate.text,
      textBytes: candidate.textBytes,
      charLength: candidate.charLength,
      obsConfig,
      log: { logEnabled: obsConfig.logEnabled, event: 'packed-batch', sessionId, extra: { source: 'compaction' } },
      middle: picker ? (middles[i] ?? null) : undefined,
    });
    if (packed) packedCount++;
  }
  return packedCount;
}

export interface ObservationPackDeps {
  pi: ExtensionAPI;
  getConfig?: (ctx: ExtensionContext) => EfficiencyConfig;
  getRuntimeManifest?: () => RuntimeRoleManifest | null;
  getRemainingHorizon?: () => number;
  pickMiddleExcerpt?: PickMiddleExcerpt;
}

export function registerObservationPack(deps: ObservationPackDeps): void {
  const { pi, getConfig, getRuntimeManifest, pickMiddleExcerpt } = deps;

  // 1. Register obs_recall tool
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
      const id = params?.id;
      const offset = params?.offset ?? 0;

      if (!isObservationId(id)) {
        // A1: hard failures throw so pi flags isError for the model.
        return toolError(`invalid observation id format: "${id}"`);
      }

      const sessionDir = ctx?.sessionManager?.getSessionDir?.();
      const sessionId = ctx?.sessionManager?.getSessionId?.();
      const sessionRoot = resolveSessionRoot(sessionDir, sessionId);

      if (!sessionRoot) {
        return toolError('session storage is unavailable for observation recall.');
      }

      const filePath = observationObjectPath(sessionRoot, id);
      const startMs = Date.now();
      const effConfig = getConfig ? getConfig(ctx) : resolveEfficiencyConfig();
      const recallMaxBytes = effConfig.observationPack.recallChunkBytes ?? RECALL_MAX_BYTES;
      try {
        const chunk = await readStoredObjectChunk(filePath, offset, {
          maxBytes: recallMaxBytes,
          maxLines: RECALL_MAX_LINES,
        });

        const header = [
          `[obs_recall id=${id} offset=${offset} next_offset=${chunk.nextOffset} eof=${chunk.eof}]`,
          `[chunk_bytes=${chunk.bytes} chunk_lines=${chunk.lines}; use next_offset to continue]`,
        ].join('\n');

        if (effConfig.observationPack.logEnabled) {
          const logPath = efficiencyLogPath(
            sessionRoot,
            'observation',
            undefined,
          );
          void appendEfficiencyLog(logPath, {
            schema: 'pier-efficiency/1',
            mechanism: 'observationPack',
            event: 'recall',
            ts: new Date().toISOString(),
            sessionId: sessionId ?? 'unknown',
            obsId: id,
            offset,
            chunkBytes: chunk.bytes,
            lines: chunk.lines,
            nextOffset: chunk.nextOffset,
            eof: chunk.eof,
            durationMs: Date.now() - startMs,
          }).catch(() => {});
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
        // Self-healing: if disk file is missing or corrupted, invalidate memo to repack if needed
        invalidateObservationMemo(id);
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
    },
  });

  // 2. Intercept context event to project placeholders
  pi.on('context', async (event, ctx: ExtensionContext) => {
    if (!event || !Array.isArray(event.messages)) return;

    const effConfig = getConfig ? getConfig(ctx) : resolveEfficiencyConfig();
    const obsConfig: ObservationPackConfig = effConfig.observationPack;
    if (!obsConfig.enabled) return;

    // Role visibility gate check: if current role denies obs_recall, skip packing completely!
    const manifest = getRuntimeManifest ? getRuntimeManifest() : null;
    if (manifest) {
      const gate = planToolGate(RECALL_TOOL_NAME, manifest);
      if (gate.kind === 'deny') {
        return; // Skip packing: agent would not be permitted to call obs_recall
      }
    }

    const sessionDir = ctx?.sessionManager?.getSessionDir?.();
    const sessionId = ctx?.sessionManager?.getSessionId?.();
    const sessionRoot = resolveSessionRoot(sessionDir, sessionId);
    if (!sessionRoot) return; // Fail-open if session directory is absent

    const projected = [...event.messages];
    const len = projected.length;

    // Calculate how many assistant responses followed each message
    const priorAssistantCounts = new Array<number>(len);
    let assistantCount = 0;
    for (let i = len - 1; i >= 0; i--) {
      priorAssistantCounts[i] = assistantCount;
      if (projected[i]?.role === 'assistant') {
        assistantCount++;
      }
    }

    for (let i = 0; i < len; i++) {
      const msg = projected[i];
      if (!msg || msg.role !== 'toolResult' || (msg as { isError?: boolean }).isError) continue;
      const content = (msg as { content?: Array<{ type: string; text?: string }> }).content;
      if (!Array.isArray(content) || content.length === 0) continue;
      if (!content.every((b) => b && b.type === 'text' && typeof b.text === 'string')) continue;

      const toolName = (msg as { toolName?: string }).toolName ?? 'tool';
      const toolCallId = (msg as { toolCallId?: string }).toolCallId ?? `call_${i}`;
      const charLength = contentJoinedLength(content);

      // N1' Fast Path: check memo BEFORE text join, containsReducerReceipt, and byteLength!
      // Once packed, observation remains sticky until memo eviction.
      const memoKey = memoKeyFor(sessionRoot, toolCallId, charLength);
      const memoized = placeholderMemo.get(memoKey);
      if (memoized) {
        // Refresh LRU position
        placeholderMemo.delete(memoKey);
        placeholderMemo.set(memoKey, memoized);
        projected[i] = {
          ...msg,
          content: [{ type: 'text', text: memoized.placeholder }],
        };
        continue;
      }

      const sendCount = priorAssistantCounts[i] ?? 0;
      // Active use window: do not touch and do not store to disk prematurely!
      if (sendCount < obsConfig.fullSends) {
        continue;
      }

      const text = content.map((b) => b.text ?? '').join('\n');
      if (containsReducerReceipt(text)) continue;

      const textBytes = Buffer.byteLength(text, 'utf8');
      if (textBytes < obsConfig.thresholdBytes) continue;

      // Calculate tail tokens after this message
      let tailTokensAfter = 0;
      for (let j = i + 1; j < len; j++) {
        const afterMsg = projected[j];
        if (afterMsg && Array.isArray((afterMsg as { content?: unknown[] }).content)) {
          for (const b of (afterMsg as { content: Array<{ type: string; text?: string }> }).content) {
            if (b && b.type === 'text' && typeof b.text === 'string') {
              tailTokensAfter += estimateTokens(b.text);
            }
          }
        }
      }

      const contentHash = sha256Hex(text);
      const obsId = deriveObservationId(toolName, toolCallId, contentHash);
      const originalTokens = estimateTokens(text);
      const lines = countLines(text);
      const placeholder = formatObservationPlaceholder({
        id: obsId,
        toolName,
        bytes: textBytes,
        lines,
        tokens: originalTokens,
        text,
        fullSends: obsConfig.fullSends,
        excerptBudget: obsConfig.excerptBytes,
      });
      const placeholderTokens = estimateTokens(placeholder);
      const removedTokens = Math.max(0, originalTokens - placeholderTokens);

      const remainingHorizon = deps.getRemainingHorizon ? deps.getRemainingHorizon() : 4;
      // Same resolution as OCC (provider family / token-account fallback); the old
      // raw pass-through of 'auto' let shouldPackForCache hardcode 12.5 internally.
      const cacheRatio = resolveCacheRatioFromCost(
        effConfig.onlineContextCompact.cacheWriteReadRatio,
        ctx.model?.cost,
        { provider: ctx.model?.provider, modelId: ctx.model?.id },
      );
      const canPack = shouldPackForCache({
        removedTokens,
        tailTokensAfter,
        expectedRemainingRequests: remainingHorizon,
        cacheWriteReadRatio: cacheRatio,
      });
      if (canPack) {
        const packed = await packOneMessage({
          sessionRoot,
          toolName,
          toolCallId,
          text,
          textBytes,
          charLength,
          obsConfig,
          log: {
            logEnabled: obsConfig.logEnabled,
            event: 'packed',
            sessionId,
            extra: { sendCount, tailTokensAfter },
          },
          pickMiddleExcerpt,
        });
        if (!packed) continue;

        projected[i] = {
          ...msg,
          content: [{ type: 'text', text: packed.placeholder }],
        };
      }
    }

    return { messages: projected };
  });
}
