/**
 * M14 常驻交互终端纯核心（D71 / T1–T6，2026-08-18）。
 *
 * 六工具的判定逻辑全部在此（无 pi/herdr 依赖 → 可单测）：
 *  - 注册表：terminal_id 稳定（term-<n>）、上限、幂等关闭；
 *  - T6 检测：send 文本校验（拒 ANSI/控制字符）、signal 白名单、
 *    全屏 TUI（alternate screen 序列）识别；
 *  - 读增量：环形缓冲语义（append / reset / none）+ 有界输出；
 *  - T3 readiness：PS1 尾匹配 + 静默期两档（超时兜底在 adapter）；
 *  - 会话汇总：stale pane 检测（跨重启边界注记）；
 *  - 持久化：custom 条目 last-wins（与 subs 注册表同构）。
 *
 * 后端映射（adapter = index.ts + herdr-client）：
 *  open=pane.split 常驻 shell / send=pane.send_text+\r /
 *  read=pane.read(recent, strip_ansi:false)+本地 strip /
 *  signal=pane.send_keys / close=pane.close。
 */
import { basename } from 'node:path';

/* ── 常量（v1 默认；env 可调点在 adapter 读） ───────────────────── */

export const TERMINALS_CUSTOM_TYPE = 'pi-herdr.terminals';
export const MAX_TERMINALS = 8;
export const READ_MAX_CHARS = 8000;
/** 读返回的硬截断长度（含截断标记自身的预算）。 */
export const READ_HARD_CAP_CHARS = 200;
export const READINESS_TIMEOUT_MS = 30_000;
export const SILENCE_IDLE_MS = 2000;
/** T3 PS1 尾匹配：PowerShell `>` / POSIX `$` `#` / Nushell `❯` 结尾（允许尾空白）。 */
export const PROMPT_TAIL_RE = /[$>#❯]\s*$/;
/** T6 signal 白名单（Herdr key-combo 字符串；ctrl+c 中断 / ctrl+d EOF / ctrl+z 挂起 / esc / enter）。 */
export const SIGNAL_KEYS = ['ctrl+c', 'ctrl+d', 'ctrl+z', 'esc', 'enter'] as const;
export type SignalKey = (typeof SIGNAL_KEYS)[number];

const FULLSCREEN_SEQUENCES = [
  '\x1b[?1049h', // 进入 alternate screen（xterm）
  '\x1b[?47h', // 老式进入 alternate screen
  '\x1b[2J\x1b[H', // 清屏 + 光标归位（vim/less 常见模式）
] as const;

export const RESET_MARKER = '…[buffer reset — earlier output scrolled away or cleared]…';
export const TRUNCATE_MARKER = '…[truncated]…';

/* ── 类型 ─────────────────────────────────────────────────────────── */

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
  /** pane.read 游标：revision（展示）+ 稳定区长度 + 尾段锚 + 缓冲尾探测器（增量判定用）。 */
  readRevision: number | null;
  readLen: number;
  readTail: string;
  readEoTail: string;
}

export interface TerminalsRegistry {
  version: 1;
  terminals: TerminalEntry[];
}

/* ── 注册表 ───────────────────────────────────────────────────────── */

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
      error: `terminal limit reached (max ${MAX_TERMINALS} open terminals); close one with terminal_close before opening another`,
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

/** 幂等关闭（closedAt 不被二次覆盖）；不存在的 id 原样返回。 */
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

/** 活跃（open）终端的 paneId 集合——GC 豁免判据（D71）。 */
export function activeTerminalPaneIds(entries: readonly TerminalEntry[]): Set<string> {
  return new Set(entries.filter((e) => e.status === 'open').map((e) => e.paneId));
}

/* ── T6：send 文本校验 / signal 白名单 ───────────────────────────── */

export function validateSendText(text: string): { ok: true; text: string } | { ok: false; error: string } {
  if (text.includes('\x1b')) {
    return {
      ok: false,
      error: 'unsupported input: ANSI escape sequences cannot be sent as text; use terminal_signal for control keys, or plain commands only',
    };
  }
  // 允许 \t；拒绝其余 C0 控制字符（\r\n 由发送方统一补 Enter，先剥尾部）
  const stripped = text.replace(/[\r\n]+$/, '');
  const bad = stripped.match(/[\x00-\x08\x0b-\x1f\x7f]/);
  if (bad) {
    return {
      ok: false,
      error: `unsupported input: control character 0x${bad[0].charCodeAt(0).toString(16)}; terminal_send accepts plain text commands only (use terminal_signal for ctrl+c etc.)`,
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

/* ── T6：全屏 TUI 检测 + ANSI 剥离 ───────────────────────────────── */

export function detectFullscreenTUI(raw: string): { detected: boolean; sequence: string | null } {
  for (const seq of FULLSCREEN_SEQUENCES) {
    if (raw.includes(seq)) return { detected: true, sequence: seq };
  }
  return { detected: false, sequence: null };
}

export function stripAnsi(raw: string): string {
  return raw
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '') // CSI 序列
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '') // OSC 序列
    .replace(/\x1b[@-Z\\-_]/g, '') // 其余两字符转义
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ''); // 残余控制字符
}

/* ── 读增量（环形缓冲语义） ───────────────────────────────────────── */

export interface ReadCursor {
  revision: number;
  /** 已消费长度（落在最后完整行边界：lastIndexOf('\n')+1；活动行不占）。 */
  len: number;
  /** 连续性锚：稳定区尾段（≤64 字符；与下次读按 trimEnd 比较——活动行行尾 \n 会变空格，实测）。 */
  tail: string;
  /** 无变化探测器：上次整个缓冲的尾段（trimEnd；相同 → none）。 */
  eoTail: string;
}

export interface ReadIncrement {
  mode: 'none' | 'append' | 'reset';
  text: string;
  cursor: ReadCursor;
  /** 达到硬上限被截断（调用方应提示分页）。 */
  hardCapped: boolean;
}

/** 游标指纹长度（tail 采样上限）。 */
const CURSOR_TAIL_CHARS = 64;

/**
 * 实测（M14 live）两条屏幕缓冲语义，决定了本实现：
 *  1) pane.read 的 revision 不随输出增长（恒 0）→ 变化探测用 eoTail，不用 revision；
 *  2) `recent` 是屏幕重建而非追加日志：活动行行尾 \n 在续写时变空格
 *     （"PS>x\n" → "PS>x echo"）→ 连续性锚按 trimEnd 比较，len 落在最后完整行边界。
 */
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
  // 首读（prev=null）= 有界全量；缓冲回卷/清屏 = 有界全量 + reset 标记
  const bounded = boundText(next.text, maxChars);
  const text = prev ? `${RESET_MARKER}\n${bounded.text}` : bounded.text;
  return { mode: 'reset', text, cursor, hardCapped: bounded.capped };
}

function boundText(text: string, maxChars: number): { text: string; capped: boolean } {
  if (text.length <= maxChars) return { text, capped: false };
  return { text: `${text.slice(text.length - maxChars)}\n${TRUNCATE_MARKER}`, capped: true };
}

/* ── T3 readiness（两档 + busy；超时兜底在 adapter） ─────────────── */

export type ReadinessTier = 'prompt' | 'silent' | 'busy';

export function classifyReadiness(
  rawOrStripped: string,
  opts: { silentMs: number; silenceThresholdMs?: number },
): ReadinessTier {
  const tail = rawOrStripped.trimEnd();
  if (tail.length > 0 && PROMPT_TAIL_RE.test(tail)) return 'prompt';
  if (opts.silentMs >= (opts.silenceThresholdMs ?? SILENCE_IDLE_MS)) return 'silent';
  return 'busy';
}

/* ── 会话汇总（T6 跨重启边界） ───────────────────────────────────── */

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

/* ── 持久化（custom 条目 last-wins，与 subs 同构） ────────────────── */

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
