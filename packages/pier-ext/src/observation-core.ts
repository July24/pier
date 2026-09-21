/**
 * ObservationPack cores: large-observation detection, deterministic ids, complete-line excerpts,
 * UTF-8-safe chunk slicing, rolling prefix cache economics. Storage I/O is in efficiency-store.ts.
 */
import { createHash } from 'node:crypto';
import { TOKEN_ACCOUNT_CACHE_RATIO } from './compact-economics-core.ts';
import { FAILURE_SIGNAL } from './reducer-core.ts';

// Fallbacks used only when a caller omits a field; DEFAULT_EFFICIENCY_CONFIG.observationPack is the
// canonical set (thresholdBytes lives there alone — every pack decision goes through resolved config).
const DEFAULT_FULL_SENDS = 2;
const DEFAULT_EXCERPT_BYTES = 1024;
const CHARS_PER_TOKEN = 4;

/** Marker from the evidence-preserving reducer, used to avoid double packing. */
export const REDUCER_RECEIPT_PREFIX = 'sol_pi_evidence_receipt_v1';

export function sha256Hex(val: string | Buffer): string {
  return createHash('sha256').update(val).digest('hex');
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function countLines(text: string): number {
  if (text.length === 0) return 0;
  let lines = text.endsWith('\n') ? 0 : 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 0x0a) lines++;
  }
  return lines;
}

export function isObservationId(id: string): boolean {
  return /^obs_[a-f0-9]{24}$/.test(id);
}

export function deriveObservationId(toolName: string, toolCallId: string, contentHash: string): string {
  return `obs_${sha256Hex(`${toolName}\0${toolCallId}\0${contentHash}`).slice(0, 24)}`;
}

/** A receipt must be a line of its own — a mere mention inside a log body is not a receipt. */
export function containsReducerReceipt(text: string): boolean {
  if (!text.includes(REDUCER_RECEIPT_PREFIX)) return false;
  return text.split('\n').some((line) => line.trim() === REDUCER_RECEIPT_PREFIX);
}

/** Whole lines only, from the head or the tail; the scanned window never exceeds budgetBytes * 4 chars. */
export function completeLineExcerpt(text: string, budgetBytes: number, fromEnd: boolean): string {
  if (budgetBytes <= 0 || text.length === 0) return '';

  const window = budgetBytes * 4;
  const start = fromEnd ? Math.max(0, text.length - window) : 0;
  const end = fromEnd ? text.length : Math.min(text.length, window);
  const lines = text.slice(start, end).split(/(?<=\n)/);
  const selected: string[] = [];
  let selectedBytes = 0;
  for (let i = fromEnd ? lines.length - 1 : 0; i >= 0 && i < lines.length; i += fromEnd ? -1 : 1) {
    const line = lines[i]!;
    // The head keeps terminated lines only; the tail also keeps the log's final unterminated line.
    if (!fromEnd && !line.endsWith('\n')) break;
    if (fromEnd && i === 0 && start > 0 && text[start - 1] !== '\n') break;
    const lineBytes = Buffer.byteLength(line, 'utf8');
    if (selectedBytes + lineBytes > budgetBytes) break;
    selectedBytes += lineBytes;
    if (fromEnd) selected.unshift(line);
    else selected.push(line);
  }
  return selected.join('');
}

export interface ObservationPlaceholderInput {
  id: string;
  toolName: string;
  bytes: number;
  lines: number;
  tokens: number;
  text: string;
  fullSends?: number;
  excerptBudget?: number;
  /**
   * P0-3 (RFC docs/rfc-jev-integration.md §3): a selected middle window replacing whichever
   * head/tail half carries fewer failure-signal lines. Absent → byte-identical legacy layout.
   */
  middle?: { text: string; label: string };
}

function signalLineCount(text: string): number {
  if (text.length === 0) return 0;
  let count = 0;
  for (const line of text.split('\n')) {
    if (FAILURE_SIGNAL.test(line)) count++;
  }
  return count;
}

export function formatObservationPlaceholder(input: ObservationPlaceholderInput): string {
  const fullSends = input.fullSends ?? DEFAULT_FULL_SENDS;
  const excerptBudget = input.excerptBudget ?? DEFAULT_EXCERPT_BYTES;
  const headBudget = Math.floor(excerptBudget / 2);
  const tailBudget = excerptBudget - headBudget;

  let head = completeLineExcerpt(input.text, headBudget, false);
  let tail = completeLineExcerpt(input.text, tailBudget, true);
  let headLabel = `[first complete lines, up to ${headBudget} bytes]`;
  let tailLabel = `[middle omitted; last complete lines, up to ${tailBudget} bytes]`;

  if (input.middle) {
    // Fewer signal lines loses its slot; ties replace head because the tail half usually carries
    // the log's final summary.
    if (signalLineCount(tail) < signalLineCount(head)) {
      tail = completeLineExcerpt(input.middle.text, tailBudget, false);
      tailLabel = `[middle omitted; selected excerpt — ${input.middle.label}, up to ${tailBudget} bytes]`;
    } else {
      head = completeLineExcerpt(input.middle.text, headBudget, false);
      headLabel = `[selected excerpt — ${input.middle.label}, up to ${headBudget} bytes]`;
    }
  }

  return [
    `[large tool result replaced after its first ${fullSends} provider requests]`,
    `id: ${input.id}`,
    `tool: ${input.toolName}`,
    `original_bytes: ${input.bytes}`,
    `original_lines: ${input.lines}`,
    `estimated_tokens: ${input.tokens}`,
    `retrieve: call obs_recall with {"id":"${input.id}","offset":0}; continue with returned next_offset`,
    headLabel,
    head,
    tailLabel,
    tail,
    `[${input.bytes} original bytes omitted; recall via obs_recall]`,
  ].join('\n');
}

export interface RecallSliceResult {
  text: string;
  bytes: number;
  lines: number;
  nextOffset: number;
  eof: boolean;
}

function trimUtf8End(buffer: Buffer, limit: number): number {
  let end = limit;
  while (end > 0 && end < buffer.length && ((buffer[end] ?? 0) & 0xc0) === 0x80) {
    end -= 1;
  }
  return end;
}

/** Byte offsets, never cutting a UTF-8 character. */
export function sliceBufferChunk(
  buf: Buffer,
  offset: number,
  limits: { maxBytes: number; maxLines: number },
): RecallSliceResult {
  if (offset >= buf.length) {
    return { text: '', bytes: 0, lines: 0, nextOffset: buf.length, eof: true };
  }

  let end = Math.min(buf.length - offset, limits.maxBytes);
  let newlineCount = 0;
  for (let i = 0; i < end; i++) {
    if (buf[offset + i] === 0x0a && ++newlineCount === limits.maxLines) {
      end = i + 1;
      break;
    }
  }

  const chunkBuf = buf.subarray(offset, offset + trimUtf8End(buf.subarray(offset), end));
  const text = chunkBuf.toString('utf8');
  const nextOffset = offset + chunkBuf.length;
  return {
    text,
    bytes: chunkBuf.length,
    lines: countLines(text),
    nextOffset,
    eof: nextOffset >= buf.length,
  };
}

/**
 * `cacheWriteReadRatio` must already be resolved by the caller via `resolveCacheRatioFromCost` (the
 * same value OCC uses); a raw `'auto'` would silently diverge from OCC's resolution.
 */
export function shouldPackForCache(opts: {
  removedTokens: number;
  tailTokensAfter: number;
  expectedRemainingRequests: number;
  cacheWriteReadRatio: number | null;
}): boolean {
  if (opts.removedTokens <= 0) return false;
  const ratio = opts.cacheWriteReadRatio ?? TOKEN_ACCOUNT_CACHE_RATIO;
  if (ratio <= 1.0) return true; // No incremental write cost over reads.

  const remaining = Math.max(1, opts.expectedRemainingRequests);
  return opts.removedTokens * remaining > opts.tailTokensAfter * (ratio - 1.0);
}
