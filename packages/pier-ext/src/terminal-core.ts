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
  /** Idle-nudge bookkeeping: set when this terminal has been nudged once (per-entry, persisted). */
  nudgedAt: number | null;
  status: 'open' | 'closed';
  closedAt: number | null;
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
    nudgedAt: null,
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
        lastActivityAt: typeof t.lastActivityAt === 'number' ? t.lastActivityAt : 0,
        nudgedAt: typeof t.nudgedAt === 'number' ? t.nudgedAt : null,
        status: t.status === 'closed' ? ('closed' as const) : ('open' as const),
      }));
  }
  return found;
}

/* ── Idle-terminal nudge: turn-end self-cleanup for shells the model forgot to close ──
 * Observed (wF:p7 orphan): a master opened a resident terminal for a one-shot background
 * compile, the job finished, and nothing ever closed the pane — terminals are persistent by
 * design, so the shell lingered as a dead split in the main tab. Decision core mirrors the
 * todo stop-reminder: pure plan here, delivery wiring in core/terminal. */

/** Cap idle-terminal nudges for the lifetime of the process (same shape as TODO_REMINDERS_MAX). */
export const TERM_REMINDERS_MAX = 2;

/** Idle threshold before a nudge is due; PI_HERDR_TERM_IDLE_MS is read per call so tests can use small values. */
export function terminalIdleMs(): number {
  return Number(process.env.PI_HERDR_TERM_IDLE_MS ?? 30 * 60_000) || 30 * 60_000;
}

/** Grace from agent_settled to injection, letting the user read the answer and intervene; cancel on agent_start. */
export function terminalReminderGraceMs(): number {
  return Number(process.env.PI_HERDR_TERM_GRACE_MS ?? 30_000) || 30_000;
}

/** Custom message type for the idle-terminal nudge (registerMessageRenderer may restyle it). */
export const TERM_REMINDER_CUSTOM_TYPE = 'pi-herdr.term-reminder';

export interface IdleTerminalInput {
  terminalId: string;
  cwd: string;
  label: string | null;
  lastActivityAt: number;
  /** Set once this terminal has been nudged; a nudged terminal is never nudged again (01a06ae3 goodbye-loop guard). */
  nudgedAt?: number | null;
}

export interface IdleTerminalReminderPlan {
  /** Whether a nudge should be injected. */
  due: boolean;
  /** Complete injected content, or null when due is false. */
  content: string | null;
  /** Nudge count after successful injection, or the original count when due is false. */
  nextReminders: number;
  /** Terminal ids this nudge covers; the caller marks them nudged at schedule time. */
  ids: string[];
}

function noIdleInject(reminders: number): IdleTerminalReminderPlan {
  return { due: false, content: null, nextReminders: reminders, ids: [] };
}

/**
 * Due only when an OPEN terminal is idle past the threshold AND has never been nudged
 * (01a06ae3: a per-process counter alone let nudges resume after restarts and looped a
 * farewell exchange 52 times — a nudged terminal must stay nudged, persisted in the ledger).
 * Shells still hosting long-running work were touched recently, so the idle filter is what
 * keeps legitimate dev-server terminals out of the nudge.
 */
export function planIdleTerminalReminder(
  input: { open: readonly IdleTerminalInput[]; now: number; reminders: number },
): IdleTerminalReminderPlan {
  const idleMs = terminalIdleMs();
  const idle = input.open.filter(
    (t) => !t.nudgedAt && input.now - t.lastActivityAt >= idleMs,
  );
  if (idle.length === 0 || input.reminders >= TERM_REMINDERS_MAX) {
    return noIdleInject(input.reminders);
  }
  const list = idle.map((t) => `- ${t.terminalId} (${t.label ?? t.cwd})`).join('\n');
  const content = [
    `<system-reminder>Open terminal(s) idle for a while (nudge ${input.reminders + 1}/${TERM_REMINDERS_MAX}):`,
    list,
    'This is an internal housekeeping notice — do NOT reply to the user and do NOT send any farewell on this notice.',
    'If the work in them is done, close them now with terminal(action: "close", terminal_id: "…").',
    'Keep a terminal only if a long-running process still needs that shell.',
    '</system-reminder>',
  ].join('\n');
  return {
    due: true,
    content,
    nextReminders: input.reminders + 1,
    ids: idle.map((t) => t.terminalId),
  };
}
