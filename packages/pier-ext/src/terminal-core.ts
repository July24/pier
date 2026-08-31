/** Why: Preserve the established compatibility and safety behavior (D71, M14, T1–T6, T3, T6). */
import { basename } from 'node:path';

/** Why: Preserve the established compatibility and safety behavior. */

export const TERMINALS_CUSTOM_TYPE = 'pi-herdr.terminals';
export const MAX_TERMINALS = 8;
export const READ_MAX_CHARS = 8000;
/** Why: Preserve the established compatibility and safety behavior. */
export const READ_HARD_CAP_CHARS = 200;
export const READINESS_TIMEOUT_MS = 30_000;
export const SILENCE_IDLE_MS = 2000;
/** POSIX / PowerShell / Nushell prompt tail. Why: herdr waitForOutput and local classify must share one pattern. */
export const PROMPT_TAIL_RE = /[$>#❯]\s*$/;

export interface PromptStrategy {
  /** herdr waitForOutput regex source. */
  readonly waitPattern: string;
  readonly tailRe: RegExp;
}

export const POSIX_PROMPT: PromptStrategy = {
  waitPattern: '[$>#❯]\\s*$',
  tailRe: PROMPT_TAIL_RE,
};

/** cmd.exe / PowerShell: `>` still matches POSIX; this also accepts `PS C:\\>` without a trailing `$`. */
export const POWERSHELL_PROMPT: PromptStrategy = {
  waitPattern: '(PS [^\\n>]+|>)\\s*$',
  tailRe: /(PS [^\n>]+|>)\s*$/,
};

/** `PIER_TERMINAL_PROMPT=powershell` selects the Windows strategy; default stays POSIX so existing panes do not flip. */
export function promptStrategyFor(env: NodeJS.ProcessEnv = process.env): PromptStrategy {
  return env.PIER_TERMINAL_PROMPT === 'powershell' ? POWERSHELL_PROMPT : POSIX_PROMPT;
}
/** Why: Preserve the established compatibility and safety behavior (T6). */
export const SIGNAL_KEYS = ['ctrl+c', 'ctrl+d', 'ctrl+z', 'esc', 'enter'] as const;
export type SignalKey = (typeof SIGNAL_KEYS)[number];

const FULLSCREEN_SEQUENCES = [
  '\x1b[?1049h', // Why: Preserve the established compatibility and safety behavior.
  '\x1b[?47h', // Why: Preserve the established compatibility and safety behavior.
  '\x1b[2J\x1b[H', // Why: Preserve the established compatibility and safety behavior.
] as const;

export const RESET_MARKER = '…[buffer reset — earlier output scrolled away or cleared]…';
export const TRUNCATE_MARKER = '…[truncated]…';

/** Why: Preserve the established compatibility and safety behavior. */

export interface TerminalEntry {
  terminalId: string;
  paneId: string;
  tabId: string;
  cwd: string;
  label: string | null;
  createdAt: number;
  lastActivityAt: number;
  status: 'open' | 'closed';
  closedAt: number | null;
  /** Why: Preserve the established compatibility and safety behavior. */
  readRevision: number | null;
  readLen: number;
  readTail: string;
  readEoTail: string;
}

export interface TerminalsRegistry {
  version: 1;
  terminals: TerminalEntry[];
}

/** Why: Preserve the established compatibility and safety behavior. */

export function nextTerminalId(existingIds: readonly string[]): string {
  let max = 0;
  for (const id of existingIds) {
    const m = /^term-(\d+)$/.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `term-${max + 1}`;
}

export function registerTerminal(
  entries: readonly TerminalEntry[],
  opts: {
    paneId: string;
    tabId: string;
    cwd: string;
    label?: string | null;
    createdAt: number;
  },
): { ok: true; entries: TerminalEntry[]; entry: TerminalEntry } | { ok: false; error: string } {
  const openCount = entries.filter((e) => e.status === 'open').length;
  if (openCount >= MAX_TERMINALS) {
    return {
      ok: false,
      error: `terminal limit reached (max ${MAX_TERMINALS} open terminals); close one with terminal(action: "close") before opening another`,
    };
  }
  const entry: TerminalEntry = {
    terminalId: nextTerminalId(entries.map((e) => e.terminalId)),
    paneId: opts.paneId,
    tabId: opts.tabId,
    cwd: opts.cwd,
    label: opts.label ?? (opts.cwd ? basename(opts.cwd.replace(/\\/g, '/')) || opts.cwd : null),
    createdAt: opts.createdAt,
    lastActivityAt: opts.createdAt,
    status: 'open',
    closedAt: null,
    readRevision: null,
    readLen: 0,
    readTail: '',
    readEoTail: '',
  };
  return { ok: true, entries: [...entries, entry], entry };
}

/** Why: Preserve the established compatibility and safety behavior. */
export function closeTerminal(
  entries: readonly TerminalEntry[],
  terminalId: string,
  now: number,
): { entries: TerminalEntry[] } {
  return {
    entries: entries.map((e) =>
      e.terminalId === terminalId && e.status === 'open'
        ? { ...e, status: 'closed' as const, closedAt: now }
        : e,
    ),
  };
}

/** Why: Preserve the established compatibility and safety behavior (D71). */
export function activeTerminalPaneIds(entries: readonly TerminalEntry[]): Set<string> {
  return new Set(entries.filter((e) => e.status === 'open').map((e) => e.paneId));
}

/** Why: Preserve the established compatibility and safety behavior (T6). */

export function validateSendText(text: string): { ok: true; text: string } | { ok: false; error: string } {
  if (text.includes('\x1b')) {
    return {
      ok: false,
      error: 'unsupported input: ANSI escape sequences cannot be sent as text; use terminal(action: "signal") for control keys, or plain commands only',
    };
  }
  // Why: Preserve the established compatibility and safety behavior (C0).
  const stripped = text.replace(/[\r\n]+$/, '');
  const bad = stripped.match(/[\x00-\x08\x0b-\x1f\x7f]/);
  if (bad) {
    return {
      ok: false,
      error: `unsupported input: control character 0x${bad[0].charCodeAt(0).toString(16)}; terminal send accepts plain text commands only (use terminal(action: "signal") for ctrl+c etc.)`,
    };
  }
  return { ok: true, text: stripped };
}

export function validateSignal(key: string): { ok: true; key: SignalKey } | { ok: false; error: string } {
  const k = (SIGNAL_KEYS as readonly string[]).includes(key) ? (key as SignalKey) : null;
  if (!k) {
    return {
      ok: false,
      error: `unsupported signal "${key}"; allowed: ${SIGNAL_KEYS.join(', ')} (complex key sequences are outside the terminal seam — use herdr's native pane for interactive programs)`,
    };
  }
  return { ok: true, key: k };
}

/** Why: Preserve the established compatibility and safety behavior (T6). */

export function detectFullscreenTUI(raw: string): { detected: boolean; sequence: string | null } {
  for (const seq of FULLSCREEN_SEQUENCES) {
    if (raw.includes(seq)) return { detected: true, sequence: seq };
  }
  return { detected: false, sequence: null };
}

export function stripAnsi(raw: string): string {
  return raw
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '') // Why: Preserve the established compatibility and safety behavior.
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '') // Why: Preserve the established compatibility and safety behavior.
    .replace(/\x1b[@-Z\\-_]/g, '') // Why: Preserve the established compatibility and safety behavior.
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ''); // Why: Preserve the established compatibility and safety behavior.
}

/** Why: Preserve the established compatibility and safety behavior. */

export interface ReadCursor {
  revision: number;
  /** Why: Preserve the established compatibility and safety behavior. */
  len: number;
  /** Why: Preserve the established compatibility and safety behavior. */
  tail: string;
  /** Why: Preserve the established compatibility and safety behavior. */
  eoTail: string;
}

export interface ReadIncrement {
  mode: 'none' | 'append' | 'reset';
  text: string;
  cursor: ReadCursor;
  /** Why: Preserve the established compatibility and safety behavior. */
  hardCapped: boolean;
}

/** Why: Preserve the established compatibility and safety behavior. */
const CURSOR_TAIL_CHARS = 64;

/** Why: Preserve the established compatibility and safety behavior (M14). */
export function computeIncrement(
  prev: ReadCursor | null,
  next: { text: string; revision: number },
  maxChars: number,
): ReadIncrement {
  const stableLen = next.text.lastIndexOf('\n') + 1;
  const cursor: ReadCursor = {
    revision: next.revision,
    len: stableLen,
    tail: next.text.slice(Math.max(0, stableLen - CURSOR_TAIL_CHARS), stableLen),
    eoTail: next.text.slice(-CURSOR_TAIL_CHARS).trimEnd(),
  };
  if (prev && next.text.slice(-CURSOR_TAIL_CHARS).trimEnd() === prev.eoTail) {
    return { mode: 'none', text: '', cursor: prev, hardCapped: false };
  }
  if (
    prev &&
    next.text.length >= prev.len &&
    next.text.slice(Math.max(0, prev.len - prev.tail.length), prev.len).trimEnd() === prev.tail.trimEnd()
  ) {
    const suffix = next.text.slice(prev.len);
    const bounded = boundText(suffix, maxChars);
    return { mode: 'append', text: bounded.text, cursor, hardCapped: bounded.capped };
  }
  // Why: Preserve the established compatibility and safety behavior.
  const bounded = boundText(next.text, maxChars);
  const text = prev ? `${RESET_MARKER}\n${bounded.text}` : bounded.text;
  return { mode: 'reset', text, cursor, hardCapped: bounded.capped };
}

function boundText(text: string, maxChars: number): { text: string; capped: boolean } {
  if (text.length <= maxChars) return { text, capped: false };
  return { text: `${text.slice(text.length - maxChars)}\n${TRUNCATE_MARKER}`, capped: true };
}

/** Why: Preserve the established compatibility and safety behavior (T3). */

export type ReadinessTier = 'prompt' | 'silent' | 'busy';

export function classifyReadiness(
  rawOrStripped: string,
  opts: { silentMs: number; silenceThresholdMs?: number; prompt?: PromptStrategy },
): ReadinessTier {
  const tail = rawOrStripped.trimEnd();
  const re = opts.prompt?.tailRe ?? PROMPT_TAIL_RE;
  if (tail.length > 0 && re.test(tail)) return 'prompt';
  if (opts.silentMs >= (opts.silenceThresholdMs ?? SILENCE_IDLE_MS)) return 'silent';
  return 'busy';
}

/** Why: Preserve the established compatibility and safety behavior (T6). */

export interface TerminalSummary {
  terminalId: string;
  paneId: string;
  cwd: string;
  label: string | null;
  status: 'open' | 'closed';
  live: boolean;
  lastActivityAt: number;
}

export function summarizeSessions(
  entries: readonly TerminalEntry[],
  livePaneIds: readonly string[],
): { terminals: TerminalSummary[]; stalePaneIds: string[] } {
  const live = new Set(livePaneIds);
  const terminals: TerminalSummary[] = entries.map((e) => ({
    terminalId: e.terminalId,
    paneId: e.paneId,
    cwd: e.cwd,
    label: e.label,
    status: e.status,
    live: e.status === 'open' && live.has(e.paneId),
    lastActivityAt: e.lastActivityAt,
  }));
  const stalePaneIds = terminals.filter((t) => t.status === 'open' && !t.live).map((t) => t.paneId);
  return { terminals, stalePaneIds };
}

/** Why: Preserve the established compatibility and safety behavior. */

export interface BranchEntryLike3 {
  type?: string;
  customType?: string;
  data?: unknown;
}

export function makeTerminalsRegistry(terminals: TerminalEntry[] = []): TerminalsRegistry {
  return { version: 1, terminals };
}

export function foldTerminalsRegistry(entries: readonly BranchEntryLike3[]): TerminalEntry[] {
  let found: TerminalEntry[] = [];
  for (const entry of entries) {
    if (entry.type !== 'custom' || entry.customType !== TERMINALS_CUSTOM_TYPE) continue;
    const data = entry.data as { terminals?: Array<Partial<TerminalEntry> & { paneId: string }> } | undefined;
    if (!data || !Array.isArray(data.terminals)) continue;
    found = data.terminals
      .filter((t) => typeof t?.paneId === 'string')
      .map((t) => ({
        terminalId: typeof t.terminalId === 'string' ? t.terminalId : `term-${t.paneId}`,
        paneId: t.paneId,
        tabId: typeof t.tabId === 'string' ? t.tabId : '',
        cwd: typeof t.cwd === 'string' ? t.cwd : '',
        label: typeof t.label === 'string' ? t.label : null,
        createdAt: typeof t.createdAt === 'number' ? t.createdAt : 0,
        lastActivityAt: typeof t.lastActivityAt === 'number' ? t.lastActivityAt : 0,
        status: t.status === 'closed' ? ('closed' as const) : ('open' as const),
        closedAt: typeof t.closedAt === 'number' ? t.closedAt : null,
        readRevision: typeof t.readRevision === 'number' ? t.readRevision : null,
        readLen: typeof t.readLen === 'number' ? t.readLen : 0,
        readTail: typeof t.readTail === 'string' ? t.readTail : '',
        readEoTail: typeof t.readEoTail === 'string' ? t.readEoTail : '',
      }));
  }
  return found;
}
