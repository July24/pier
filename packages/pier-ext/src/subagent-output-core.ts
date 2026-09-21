/**
 * subagent-output-core.ts
 *
 * Pure functions for subagent incremental output extraction:
 *  - Cursor management (in-memory per-pane tail tracking)
 *  - Longest common suffix/prefix delta computation
 *  - Boundary handling for scrolling, clear-screen, repeated text (graceful degradation with restart: true)
 *  - Bounded character budgeting and metadata formatting
 */
import type { HerdrAgentState } from './herdr-client.ts';
import type { SubEntry } from './subagent-core.ts';

export const OUTPUT_DEFAULT_MAX_CHARS = 6000;
export const OUTPUT_HARD_CAP_CHARS = 16000;
export const OUTPUT_MIN_OVERLAP = 16;
export const OUTPUT_TAIL_CHARS = 500;

export type SubagentStatus = 'running' | 'idle' | 'blocked' | 'settled';

export interface SubagentOutputCursor {
  /** Suffix of previous full text used for boundary matching */
  tail: string;
  /** Length of previous full text */
  fullLength: number;
  /** Fingerprint of the last session-transcript report already delivered for this pane;
   * deduplicates the transcript fallback across polls (present only after such a delivery). */
  reportTail?: string;
}

export interface SubagentOutputDeltaOptions {
  /** Max characters of delta to return (default: 6000) */
  maxChars?: number;
  /** Minimum overlap length required for partial scroll matching (default: 16) */
  minOverlap?: number;
  /** Length of tail to retain in cursor (default: 500) */
  tailChars?: number;
}

export interface SubagentOutputDeltaResult {
  /** The new output text (or full bounded text on initial/restart) */
  delta: string;
  /** Whether the increment could not be determined reliably (scrolled away, cleared, ambiguous repeat) */
  restart: boolean;
  /** Whether delta was truncated to maxChars */
  truncated: boolean;
  /** New cursor to save for next call */
  nextCursor: SubagentOutputCursor;
}

/**
 * Extract tail characters from a text buffer for cursor matching.
 */
export function extractTail(text: string, tailChars = OUTPUT_TAIL_CHARS): string {
  if (text.length <= tailChars) return text;
  return text.slice(text.length - tailChars);
}

/**
 * Bound text to a maximum character budget, retaining the tail (most recent output).
 */
export function boundText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  return {
    text: text.slice(text.length - maxChars),
    truncated: true,
  };
}

/**
 * Pure function: Given previous cursor (tail + fullLength) and current full buffer text,
 * compute the incremental delta since last read.
 *
 * Boundary handling:
 *  1. Initial read (prevCursor is null/empty): returns full bounded text, restart=false.
 *  2. No change: fullLength and tail match, delta is empty, restart=false.
 *  3. Normal append: prevTail appears uniquely in currText -> delta is text after prevTail.
 *  4. Repeated text: prevTail appears multiple times -> ambiguous, returns full bounded text with restart=true.
 *  5. Partial buffer scroll: prevTail partially scrolled off top -> longest suffix of prevTail
 *     matching prefix of currText (>= minOverlap) identifies boundary.
 *  6. Full scroll / clear screen: no valid overlap found -> returns full bounded text with restart=true.
 */
export function computeSubagentOutputDelta(
  prevCursor: SubagentOutputCursor | null | undefined,
  currText: string,
  options?: SubagentOutputDeltaOptions,
): SubagentOutputDeltaResult {
  const rawMaxChars = options?.maxChars ?? OUTPUT_DEFAULT_MAX_CHARS;
  const maxChars = Math.max(1, Math.min(rawMaxChars, OUTPUT_HARD_CAP_CHARS));
  const minOverlap = options?.minOverlap ?? OUTPUT_MIN_OVERLAP;
  const tailChars = options?.tailChars ?? OUTPUT_TAIL_CHARS;

  // Case 1: First call (no previous cursor)
  if (!prevCursor || !prevCursor.tail) {
    const bounded = boundText(currText, maxChars);
    return {
      delta: bounded.text,
      restart: false,
      truncated: bounded.truncated,
      nextCursor: {
        tail: extractTail(currText, tailChars),
        fullLength: currText.length,
      },
    };
  }

  const prevTail = prevCursor.tail;

  // Case 2: Exact same content (no new output)
  if (currText.length === prevCursor.fullLength && currText.endsWith(prevTail)) {
    return {
      delta: '',
      restart: false,
      truncated: false,
      nextCursor: prevCursor,
    };
  }

  // Case 3: prevTail appears in currText
  const firstIdx = currText.indexOf(prevTail);
  const lastIdx = currText.lastIndexOf(prevTail);

  if (firstIdx !== -1) {
    // 3a: Ambiguous duplicate occurrences in current text
    if (firstIdx !== lastIdx) {
      const bounded = boundText(currText, maxChars);
      return {
        delta: bounded.text,
        restart: true,
        truncated: bounded.truncated,
        nextCursor: {
          tail: extractTail(currText, tailChars),
          fullLength: currText.length,
        },
      };
    }

    // 3b: Unique match
    const rawDelta = currText.slice(firstIdx + prevTail.length);
    if (rawDelta.length === 0) {
      return {
        delta: '',
        restart: false,
        truncated: false,
        nextCursor: prevCursor,
      };
    }

    const bounded = boundText(rawDelta, maxChars);
    return {
      delta: bounded.text,
      restart: false,
      truncated: bounded.truncated,
      nextCursor: {
        tail: extractTail(currText, tailChars),
        fullLength: currText.length,
      },
    };
  }

  // Case 4: prevTail is not found in full. Check if a suffix of prevTail matches a prefix of currText
  // (terminal buffer scrolled lines off the top).
  let longestOverlap = 0;
  const maxPossibleOverlap = Math.min(prevTail.length - 1, currText.length);
  const effectiveMinOverlap = Math.min(minOverlap, prevTail.length);

  for (let k = maxPossibleOverlap; k >= effectiveMinOverlap; k--) {
    const suffix = prevTail.slice(prevTail.length - k);
    if (currText.startsWith(suffix)) {
      longestOverlap = k;
      break;
    }
  }

  if (longestOverlap >= effectiveMinOverlap) {
    const rawDelta = currText.slice(longestOverlap);
    const bounded = boundText(rawDelta, maxChars);
    return {
      delta: bounded.text,
      restart: false,
      truncated: bounded.truncated,
      nextCursor: {
        tail: extractTail(currText, tailChars),
        fullLength: currText.length,
      },
    };
  }

  // Case 5: Clear screen or full scroll out -> degraded reset
  const bounded = boundText(currText, maxChars);
  return {
    delta: bounded.text,
    restart: true,
    truncated: bounded.truncated,
    nextCursor: {
      tail: extractTail(currText, tailChars),
      fullLength: currText.length,
    },
  };
}

/**
 * Resolve subagent semantic status from local subs registry and herdr agent state.
 */
export function resolveSubagentStatus(opts: {
  localStatus: SubEntry['status'];
  herdrStatus?: HerdrAgentState | null;
  hasAskFlag?: boolean;
}): SubagentStatus {
  if (opts.hasAskFlag || opts.herdrStatus === 'blocked') {
    return 'blocked';
  }
  if (opts.herdrStatus === 'working') {
    return 'running';
  }
  if (opts.localStatus === 'settled' || opts.localStatus === 'closed' || opts.herdrStatus === 'done') {
    return 'settled';
  }
  if (opts.herdrStatus === 'idle') {
    return 'idle';
  }
  if (opts.localStatus === 'running') {
    return 'running';
  }
  return 'running';
}

export interface FormatSubagentOutputOpts {
  paneId: string;
  status: SubagentStatus;
  revision: number;
  bufferTruncated: boolean;
  deltaResult: SubagentOutputDeltaResult;
  askQuestion?: string | null;
}

/**
 * Format subagent output for display to the master model.
 */
export function formatSubagentOutput(opts: FormatSubagentOutputOpts): string {
  const parts: string[] = [];
  const metaItems: string[] = [
    `pane: ${opts.paneId}`,
    `status: ${opts.status}${opts.status === 'blocked' && opts.askQuestion ? ` (question: "${opts.askQuestion}")` : ''}`,
    `revision: ${opts.revision}`,
  ];

  if (opts.deltaResult.restart) {
    // P2-4: fullscreen TUI redraws make this the CONSTANT state, not a crash signal —
    // the old "restart: true" wording repeatedly misled incident triage (01a0bd3a).
    metaItems.push('buffer scrolled or reset — full text returned (not a process restart)');
  }
  if (opts.bufferTruncated || opts.deltaResult.truncated) {
    metaItems.push('truncated: true');
  }

  const header = `[Subagent Output | ${metaItems.join(' | ')}]`;
  parts.push(header);

  if (opts.deltaResult.delta.length === 0) {
    parts.push('(no new output since last read)');
  } else {
    parts.push(opts.deltaResult.delta);
  }

  return parts.join('\n');
}
