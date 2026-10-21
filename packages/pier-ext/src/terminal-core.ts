import { pierOption } from './pier-options.ts';
import { basename } from 'node:path';

export const TERMINALS_CUSTOM_TYPE = 'pi-herdr.terminals';
export const MAX_TERMINALS = 8;
export const READ_MAX_CHARS = 8000;
export const READINESS_TIMEOUT_MS = 30_000;
export const SILENCE_IDLE_MS = 2000;
/** POSIX / PowerShell / Nushell / Zsh prompt tail.
 * sh/bash end with `$` (root `#`), macOS zsh with `%`, nushell/starship with `❯`; anchoring to the
 * line tail (\s*$) avoids matching percentage values in ordinary output (`downloaded 50%`), since
 * interactive prompts end at the prompt symbol with no trailing text.
 */
export const PROMPT_TAIL_RE = /[$>#❯%]\s*$/;

export interface PromptStrategy {
  /** herdr waitForOutput regex source. */
  readonly waitPattern: string;
  readonly tailRe: RegExp;
}

export const POSIX_PROMPT: PromptStrategy = {
  waitPattern: '[$>#❯%]\\s*$',
  tailRe: PROMPT_TAIL_RE,
};

/** cmd.exe / PowerShell: `>` still matches POSIX; this also accepts `PS C:\\>` without a trailing `$`. */
export const POWERSHELL_PROMPT: PromptStrategy = {
  waitPattern: '(PS [^\\n>]+|>)\\s*$',
  tailRe: /(PS [^\n>]+|>)\s*$/,
};

/** Shell name (lowercased basename from $SHELL, or a PIER_TERMINAL_PROMPT value) → strategy. */
const PROMPT_STRATEGIES: Record<string, PromptStrategy> = {
  bash: POSIX_PROMPT,
  zsh: POSIX_PROMPT,
  pwsh: POWERSHELL_PROMPT,
  'pwsh.exe': POWERSHELL_PROMPT,
  powershell: POWERSHELL_PROMPT,
  'powershell.exe': POWERSHELL_PROMPT,
};

/** Explicit `PIER_TERMINAL_PROMPT` wins over `$SHELL`; the default stays POSIX so unconfigured panes
 *  never flip strategy. */
export function promptStrategyFor(env: NodeJS.ProcessEnv = process.env): PromptStrategy {
  // B10: canonical PIER_TERMINAL_PROMPT, legacy PI_HERDR_TERMINAL_PROMPT alias.
  const prompt = pierOption('PIER_TERMINAL_PROMPT', env)?.trim().toLowerCase();
  const shell = prompt || basename((env.SHELL ?? '').replace(/\\/g, '/')).toLowerCase();
  return PROMPT_STRATEGIES[shell] ?? POSIX_PROMPT;
}

export const SIGNAL_KEYS = ['ctrl+c', 'ctrl+d', 'ctrl+z', 'esc', 'enter'] as const;
export type SignalKey = (typeof SIGNAL_KEYS)[number];

const FULLSCREEN_SEQUENCES = [
  '\x1b[?1049h',
  '\x1b[?47h',
  '\x1b[2J\x1b[H',
] as const;

export const RESET_MARKER = '…[buffer reset — earlier output scrolled away or cleared]…';
export const TRUNCATE_MARKER = '…[truncated]…';

export interface TerminalEntry {
  terminalId: string;
  paneId: string;
  tabId: string;
  cwd: string;
  label: string | null;
  createdAt: number;
  lastActivityAt: number;
  /** Nudges delivered for this terminal (0..TERM_REMINDERS_MAX), persisted. */
  nudges: number;
  /** Timestamp of the last nudge; kept alongside `nudges` for legacy records and debugging. */
  nudgedAt: number | null;
  status: 'open' | 'closed';
  closedAt: number | null;
  readRevision?: number | null;
  readLen?: number;
  readTail?: string;
  readEoTail?: string;
  initialized?: boolean;
}

export interface TerminalsRegistry {
  version: 1;
  terminals: TerminalEntry[];
}

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
    /** Caller-requested id; when omitted (or unusable per validateTerminalId) a term-N id is assigned. */
    terminalId?: string | null;
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
  const requested = validateTerminalId(opts.terminalId, entries.map((e) => e.terminalId));
  if (requested != null && !requested.ok) return { ok: false, error: requested.error };
  const entry: TerminalEntry = {
    terminalId: requested != null && requested.ok ? requested.id : nextTerminalId(entries.map((e) => e.terminalId)),
    paneId: opts.paneId,
    tabId: opts.tabId,
    cwd: opts.cwd,
    label: opts.label ?? (opts.cwd ? basename(opts.cwd.replace(/\\/g, '/')) || opts.cwd : null),
    createdAt: opts.createdAt,
    lastActivityAt: opts.createdAt,
    nudges: 0,
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

/** A requested terminal id must be a short single-token string that no existing terminal (open or
 *  closed) already uses — ids stay addressable after close for `close`/`list`, so reuse would
 *  retarget actions at the wrong pane. Returns null when no id was requested. */
export function validateTerminalId(
  id: string | null | undefined,
  existingIds: readonly string[],
): { ok: true; id: string } | { ok: false; error: string } | null {
  const trimmed = (id ?? '').trim();
  if (trimmed.length === 0) return null; // blank means "not provided" → auto-assigned term-N
  if (trimmed.length > 64 || /\s/.test(trimmed)) {
    return { ok: false, error: `invalid terminal_id "${trimmed.slice(0, 40)}": use 1-64 characters without whitespace, or omit it to get an auto-assigned term-N id` };
  }
  if (existingIds.includes(trimmed)) {
    return { ok: false, error: `terminal_id "${trimmed}" is already used (open or closed); ids stay reserved for addressing — pick another or omit it` };
  }
  return { ok: true, id: trimmed };
}

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

export function activeTerminalPaneIds(entries: readonly TerminalEntry[]): Set<string> {
  return new Set(entries.filter((e) => e.status === 'open').map((e) => e.paneId));
}

export function validateSendText(text: string): { ok: true; text: string } | { ok: false; error: string } {
  if (text.includes('\x1b')) {
    return {
      ok: false,
      error: 'unsupported input: ANSI escape sequences cannot be sent as text; use terminal(action: "signal") for control keys, or plain commands only',
    };
  }

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

/**
 * Whether a wait pattern would match the terminal's own echoed input: the shell echoes typed
 * commands into the pane, so a pattern contained in the last sent text (`…; echo TERM_DONE_$?`
 * waited on as literal `TERM_DONE_`) matches its own echo and returns "matched" before the job
 * has produced anything. Detection is per terminal and best-effort: no send in this process
 * lifetime → no hazard known → the wait proceeds unchanged.
 */
export function sentinelEchoHazard(opts: {
  pattern: string;
  regex?: boolean;
  lastSentText?: string | null;
}): boolean {
  const sent = opts.lastSentText;
  if (!sent) return false;
  if (opts.regex) {
    try {
      return new RegExp(opts.pattern).test(sent);
    } catch {
      return false; // invalid regex is rejected by the caller before this runs
    }
  }
  return sent.includes(opts.pattern);
}

export function detectFullscreenTUI(raw: string): { detected: boolean; sequence: string | null } {
  for (const seq of FULLSCREEN_SEQUENCES) {
    if (raw.includes(seq)) return { detected: true, sequence: seq };
  }
  return { detected: false, sequence: null };
}

export function stripAnsi(raw: string): string {
  return raw
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

export interface ReadCursor {
  revision: number;
  len: number;
  tail: string;
  eoTail: string;
}

export interface ReadIncrement {
  mode: 'none' | 'append' | 'reset';
  text: string;
  cursor: ReadCursor;
  hardCapped: boolean;
}

const CURSOR_TAIL_CHARS = 64;

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

  const bounded = boundText(next.text, maxChars);
  const text = prev ? `${RESET_MARKER}\n${bounded.text}` : bounded.text;
  return { mode: 'reset', text, cursor, hardCapped: bounded.capped };
}

/** Window around the first hit so a later capped read cannot hide the match behind earlier lines. */
export function excerptAroundMatch(text: string, pattern: string, regex: boolean, radius = 1500): string {
  let index = -1;
  let hitLen = pattern.length;
  if (regex) {
    const found = new RegExp(pattern).exec(text);
    index = found?.index ?? -1;
    hitLen = found?.[0].length ?? pattern.length;
  } else {
    index = text.indexOf(pattern);
  }
  if (index < 0) return text.slice(-radius);
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + hitLen + radius);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

/**
 * herdr waitForOutput matches the whole pane, including text a prior read already returned.
 * A hit is fresh only when it sits in the unread increment; a hit only in consumed text is stale.
 */
export function classifyWaitMatch(
  prev: ReadCursor | null,
  paneText: string,
  pattern: string,
  regex: boolean,
): { kind: 'fresh'; excerpt: string } | { kind: 'stale' } | { kind: 'absent' } {
  const match = (text: string) => regex ? new RegExp(pattern).test(text) : text.includes(pattern);
  const inc = computeIncrement(prev, { text: paneText, revision: prev?.revision ?? 0 }, paneText.length + 1);
  const unread = inc.mode === 'append' ? inc.text : inc.mode === 'reset' ? paneText : '';
  if (match(unread)) return { kind: 'fresh', excerpt: excerptAroundMatch(unread, pattern, regex) };
  if (inc.mode !== 'reset' && match(paneText)) return { kind: 'stale' };
  return { kind: 'absent' };
}

function boundText(text: string, maxChars: number): { text: string; capped: boolean } {
  if (text.length <= maxChars) return { text, capped: false };
  return { text: `${text.slice(text.length - maxChars)}\n${TRUNCATE_MARKER}`, capped: true };
}

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

export function makeTerminalsRegistry(terminals: TerminalEntry[] = []): TerminalsRegistry {
  return { version: 1, terminals };
}

export interface ShellInitPlan {
  readonly shouldInit: boolean;
  readonly command: string | null;
}

/**
 * Plan the shell init command: `set +H` disables history expansion in managed bash/zsh shells, where `!`
 * in ordinary commands (`!|`, `if [ ! -f ... ]`, `!$`) otherwise triggers `zsh: event not found: \|` and
 * wedges the shell. PowerShell rejects the syntax and has no `!` history expansion, so it is skipped.
 * Limit: the top-level shell only — a nested `bash -i` re-enables its own defaults; init is only worth
 * sending once the shell is at its prompt and has not been initialized yet.
 */
export function planShellInit(opts: {
  strategy?: PromptStrategy;
  readiness?: ReadinessTier;
  initialized?: boolean;
}): ShellInitPlan {
  if (opts.initialized) return { shouldInit: false, command: null };
  if ((opts.strategy ?? POSIX_PROMPT) === POWERSHELL_PROMPT) return { shouldInit: false, command: null };
  if (opts.readiness !== undefined && opts.readiness !== 'prompt') {
    return { shouldInit: false, command: null };
  }
  return { shouldInit: true, command: 'set +H' };
}

export function foldTerminalsRegistry(
  entries: readonly { type?: string; customType?: string; data?: unknown }[],
): TerminalEntry[] {
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
        nudges: typeof t.nudges === 'number'
          ? Math.max(0, Math.min(TERM_REMINDERS_MAX, Math.floor(t.nudges)))
          : (typeof t.nudgedAt === 'number' ? 1 : 0),
        nudgedAt: typeof t.nudgedAt === 'number' ? t.nudgedAt : null,
        status: t.status === 'closed' ? ('closed' as const) : ('open' as const),
        closedAt: typeof t.closedAt === 'number' ? t.closedAt : null,
        readRevision: typeof t.readRevision === 'number' ? t.readRevision : null,
        readLen: typeof t.readLen === 'number' ? t.readLen : 0,
        readTail: typeof t.readTail === 'string' ? t.readTail : '',
        readEoTail: typeof t.readEoTail === 'string' ? t.readEoTail : '',
        initialized: t.initialized === true,
      }));
  }
  return found;
}

/* ── Terminal nudge: turn-end self-cleanup for shells the model forgot to close ──
 * Terminals persist by design, so a finished shell lingers as a dead split. Two notices per terminal:
 *   1. at the end of the turn that used it ("used this turn") — or the first turn that finds it idle
 *      past the threshold, for a shell nobody touched recently;
 *   2. on a later settle once it has been idle past PIER_TERM_IDLE_MS.
 * Delivery wiring mirrors the todo stop-reminder in plugins/terminal. */

/** Per-terminal nudge cap: one after use, one after the idle threshold (goodbye-loop guard). */
export const TERM_REMINDERS_MAX = 2;

/** Idle threshold for the second nudge; the env var is read per call so tests can use small values. */
export function terminalIdleMs(): number {
  // B10: canonical PIER_TERM_IDLE_MS, legacy PI_HERDR_TERM_IDLE_MS.
  return Number(pierOption('PIER_TERM_IDLE_MS') ?? 5 * 60_000) || 5 * 60_000;
}

/** Grace from agent_settled to injection, letting the user read the answer and intervene; cancel on agent_start. */
export function terminalReminderGraceMs(): number {
  return Number(pierOption('PIER_TERM_GRACE_MS') ?? 30_000) || 30_000;
}

export const TERM_REMINDER_CUSTOM_TYPE = 'pi-herdr.term-reminder';

export interface TerminalNudgeInput {
  terminalId: string;
  cwd: string;
  label: string | null;
  lastActivityAt: number;
  /** Nudges already delivered; when absent, legacy `nudgedAt` counts as one. */
  nudges?: number;
  nudgedAt?: number | null;
  /** A non-shell foreground process owns the pane (dev server / running job); never nudge it. */
  busy?: boolean;
}

export interface TerminalReminderPlan {
  due: boolean;
  content: string | null;
  /** Terminals covered by this notice; the caller bumps each one's `nudges` at schedule time. */
  ids: string[];
}

function noTerminalInject(): TerminalReminderPlan {
  return { due: false, content: null, ids: [] };
}

function nudgesOf(t: TerminalNudgeInput): number {
  return t.nudges ?? (t.nudgedAt != null ? 1 : 0);
}

/** `72m` / `3h12m`: the reason column reads at a glance without a timestamp. */
function formatIdleAge(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
}

/**
 * First notice: the terminal was used by the agent run that just settled, or it is already idle past
 * the threshold. Second notice: a terminal with one nudge is idle past the threshold again. A shell
 * touched recently is never nudged, so a dev server in active use stays out.
 */
export function planTerminalReminder(
  input: { open: readonly TerminalNudgeInput[]; now: number; turnStartedAt?: number | null },
): TerminalReminderPlan {
  const idleMs = terminalIdleMs();
  const rows: string[] = [];
  const ids: string[] = [];
  for (const t of input.open) {
    if (t.busy) continue;
    const nudges = nudgesOf(t);
    if (nudges >= TERM_REMINDERS_MAX) continue;
    const idleFor = input.now - t.lastActivityAt;
    const sinceNudge = t.nudgedAt != null ? input.now - t.nudgedAt : Number.POSITIVE_INFINITY;
    const usedThisTurn = input.turnStartedAt != null && t.lastActivityAt >= input.turnStartedAt;
    // Second notice waits another full idle window after the first one, so a pane that was already
    // idle for an hour at nudge 1 is not nudged twice back-to-back on the next settle.
    const reason = nudges === 0 && usedThisTurn
      ? 'used this turn'
      : nudges === 0 && idleFor >= idleMs
        ? `idle ${formatIdleAge(idleFor)}`
        : nudges === 1 && idleFor >= idleMs && sinceNudge >= idleMs
          ? `still idle ${formatIdleAge(idleFor)}`
          : null;
    if (reason == null) continue;
    rows.push(`- ${t.terminalId} (${t.label ?? t.cwd}) — ${reason} · nudge ${nudges + 1}/${TERM_REMINDERS_MAX}`);
    ids.push(t.terminalId);
  }
  if (ids.length === 0) return noTerminalInject();
  const content = [
    '<system-reminder>Open terminal(s) that may be finished:',
    ...rows,
    'This is an internal housekeeping notice — do NOT reply to the user and do NOT send any farewell on this notice.',
    'If the work in them is done, close them now with terminal(action: "close", terminal_id: "…").',
    'Keep a terminal only if a long-running process still needs that shell.',
    '</system-reminder>',
  ].join('\n');
  return { due: true, content, ids };
}
