/**
 * Child-session transcript I/O + pane-output observation for subagents. Path resolution, settlement
 * text and liveness probes share one candidate order (reported path/id before recent-file fallback,
 * excluding the master's own session and sessions claimed by other live panes), so settlement text
 * can never cross sessions.
 */
import { accessSync, constants, statSync } from 'node:fs';
import type { HerdrAgentState, HerdrClientLike } from './herdr-client.ts';
import {
  bareSessionId,
  deriveSubSessionState,
  lastAssistantText,
  listSessionFiles,
  readSessionFile,
  resolveSessionFileValue,
  type SessionEntryLike,
  type SubSessionState,
} from './session-tail.ts';
import { idParam, sleep, type AliveProbe, type SubEntry } from './subagent-core.ts';
import { toolError } from './tool-error.ts';

/* ── subagent output delta (pure) ───────────────────────────────── */

export const OUTPUT_DEFAULT_MAX_CHARS = 6000;
export const OUTPUT_HARD_CAP_CHARS = 16000;
const OUTPUT_MIN_OVERLAP = 16;
const OUTPUT_TAIL_CHARS = 500;

export type SubagentStatus = 'running' | 'idle' | 'blocked' | 'settled';

export interface SubagentOutputCursor {
  tail: string;
  fullLength: number;
  /** Fingerprint of the last transcript report delivered to this pane; deduplicates the fallback across polls. */
  reportTail?: string;
}

function boundText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(text.length - maxChars), truncated: true };
}

function extractTail(text: string, tailChars = OUTPUT_TAIL_CHARS): string {
  return text.length <= tailChars ? text : text.slice(text.length - tailChars);
}

/**
 * Incremental delta between the previous cursor and the current full buffer: an initial read returns
 * bounded full text, an append the text after the previous tail; ambiguous repeats and scrolled-off
 * boundaries degrade to full text with `restart: true`.
 */
export function computeSubagentOutputDelta(
  prevCursor: SubagentOutputCursor | null | undefined,
  currText: string,
  options?: { maxChars?: number; minOverlap?: number; tailChars?: number },
): { delta: string; restart: boolean; truncated: boolean; nextCursor: SubagentOutputCursor } {
  const maxChars = Math.max(1, Math.min(options?.maxChars ?? OUTPUT_DEFAULT_MAX_CHARS, OUTPUT_HARD_CAP_CHARS));
  const minOverlap = options?.minOverlap ?? OUTPUT_MIN_OVERLAP;
  const tailChars = options?.tailChars ?? OUTPUT_TAIL_CHARS;
  const nextCursor = (): SubagentOutputCursor => ({
    tail: extractTail(currText, tailChars),
    fullLength: currText.length,
  });
  const carry = (text: string, restart: boolean) => {
    const bounded = boundText(text, maxChars);
    return { delta: bounded.text, restart, truncated: bounded.truncated, nextCursor: nextCursor() };
  };

  if (!prevCursor || !prevCursor.tail) return carry(currText, false);

  const prevTail = prevCursor.tail;
  // Same length and suffix → nothing new; keep the cursor (and its report fingerprint) as-is.
  if (currText.length === prevCursor.fullLength && currText.endsWith(prevTail)) {
    return { delta: '', restart: false, truncated: false, nextCursor: prevCursor };
  }

  const firstIdx = currText.indexOf(prevTail);
  if (firstIdx !== -1) {
    // Repeats of the tail make the boundary ambiguous; fall back to the whole buffer.
    if (firstIdx !== currText.lastIndexOf(prevTail)) return carry(currText, true);
    const rawDelta = currText.slice(firstIdx + prevTail.length);
    if (rawDelta.length === 0) return { delta: '', restart: false, truncated: false, nextCursor: prevCursor };
    return carry(rawDelta, false);
  }

  // Tail scrolled off the top: the longest suffix of prevTail matching a prefix of currText is the boundary.
  const maxPossibleOverlap = Math.min(prevTail.length - 1, currText.length);
  const effectiveMinOverlap = Math.min(minOverlap, prevTail.length);
  for (let k = maxPossibleOverlap; k >= effectiveMinOverlap; k--) {
    if (currText.startsWith(prevTail.slice(prevTail.length - k))) return carry(currText.slice(k), false);
  }
  return carry(currText, true);
}

type StatusInput = { localStatus: SubEntry['status']; herdrStatus?: HerdrAgentState | null; hasAskFlag?: boolean };

/** First matching rule wins; a worker with no other signal is running. */
const STATUS_RULES: ReadonlyArray<{ status: SubagentStatus; match: (i: StatusInput) => boolean }> = [
  { status: 'blocked', match: (i) => i.hasAskFlag === true || i.herdrStatus === 'blocked' },
  { status: 'running', match: (i) => i.herdrStatus === 'working' },
  { status: 'settled', match: (i) => i.localStatus === 'settled' || i.localStatus === 'closed' || i.herdrStatus === 'done' },
  { status: 'idle', match: (i) => i.herdrStatus === 'idle' },
];

export function resolveSubagentStatus(input: StatusInput): SubagentStatus {
  return STATUS_RULES.find((rule) => rule.match(input))?.status ?? 'running';
}

export interface FormatSubagentOutputOpts {
  paneId: string;
  status: SubagentStatus;
  revision: number;
  bufferTruncated: boolean;
  deltaResult: { delta: string; restart: boolean; truncated: boolean };
  askQuestion?: string | null;
}

export function formatSubagentOutput(opts: FormatSubagentOutputOpts): string {
  const parts: string[] = [];
  const metaItems: string[] = [
    `pane: ${opts.paneId}`,
    `status: ${opts.status}${opts.status === 'blocked' && opts.askQuestion ? ` (question: "${opts.askQuestion}")` : ''}`,
    `revision: ${opts.revision}`,
  ];
  if (opts.deltaResult.restart) {
    metaItems.push('buffer scrolled or reset — full text returned (not a process restart)');
  }
  if (opts.bufferTruncated || opts.deltaResult.truncated) metaItems.push('truncated: true');
  parts.push(`[Subagent Output | ${metaItems.join(' | ')}]`);
  parts.push(opts.deltaResult.delta.length === 0 ? '(no new output since last read)' : opts.deltaResult.delta);
  return parts.join('\n');
}

/* ── session file resolution + liveness probes ──────────────────── */

export interface SessionIoHost {
  client: HerdrClientLike;
  getSessionId: () => string;
  sessionsDir: () => string;
}

export interface ResolveSessionFileOpts {
  /** Reject candidates last written before this timestamp, so a request is never attributed to a
   * session file that was not written after the request was injected (spawn-race mis-attribution). */
  minMtimeMs?: number;
}

export interface SessionIo {
  resolveSessionFile(paneId: string, cwd: string, preferred?: string | null, opts?: ResolveSessionFileOpts): Promise<string | null>;
  collectFinalText(paneId: string, cwd: string, sinceTs: number, attempts?: number, preferred?: string | null): Promise<string | null>;
  readAskFlag(paneId: string): Promise<string | null>;
  probeAlive(paneId: string, cwd: string): Promise<AliveProbe>;
  subSessionState(paneId: string, cwd: string, sinceTs: number, preferred?: string | null): Promise<SubSessionState>;
  readSettleTail(paneId: string, cwd: string, preferred?: string | null, maxChars?: number): Promise<string | null>;
  /** Re-attribute a registry sessionFile with no writes since `sinceTs`: keep `preferred` when fresh,
   * else accept herdr's per-pane report when fresh. An existing value is only replaced by the
   * authoritative report; null means "keep the old one" (never an mtime guess). */
  reattributeStaleSessionFile(paneId: string, cwd: string, sinceTs: number, preferred: string | null): Promise<string | null>;
}

interface FileStamp {
  size: number;
  mtimeMs: number;
}

function stampOf(file: string): FileStamp | null {
  try {
    const s = statSync(file);
    if (!s.isFile()) return null;
    accessSync(file, constants.R_OK);
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return null;
  }
}

/** Memo of values derived from a session file, invalidated by (size, mtime, sinceTs): worker
 * sessions reach tens of MB, and the poll loop re-derives the same state every tick. */
class DerivedCache<T> {
  private readonly entries = new Map<string, { key: string; value: T }>();
  private readonly limit: number;

  constructor(limit = 32) {
    this.limit = limit;
  }

  get(file: string, stamp: FileStamp, sinceTs: number): T | undefined {
    const hit = this.entries.get(file);
    return hit && hit.key === `${stamp.size}:${stamp.mtimeMs}:${sinceTs}` ? hit.value : undefined;
  }

  set(file: string, stamp: FileStamp, sinceTs: number, value: T): void {
    this.entries.delete(file);
    this.entries.set(file, { key: `${stamp.size}:${stamp.mtimeMs}:${sinceTs}`, value });
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.limit) break;
      this.entries.delete(oldest);
    }
  }
}

export function createSessionIo(h: SessionIoHost): SessionIo {
  const stateCache = new DerivedCache<SubSessionState>();
  const finalTextCache = new DerivedCache<string | null>();

  /** herdr's report for this pane plus the sessions claimed by other panes; one `agent.list`
   *  serves both, so the poll hot paths pay a single RPC. */
  async function reportedAndTaken(paneId: string): Promise<{ reported: string | null; taken: Set<string> }> {
    const taken = new Set<string>();
    let reported: string | null = null;
    try {
      for (const a of await h.client.listAgents()) {
        if (!a.session) continue;
        if (a.paneId === paneId) reported = a.session;
        else taken.add(bareSessionId(a.session));
      }
      // agent.list is authoritative, but a fresh pane can be absent during report lag while
      // stub clients expose only the per-pane report.
      if (!reported) reported = await h.client.getAgentSessionPath(paneId);
    } catch {
      try {
        reported = await h.client.getAgentSessionPath(paneId);
      } catch {
        /* both unavailable → no report, own/taken exclusions still hold */
      }
    }
    return { reported, taken };
  }

  /** Ordered candidates: pipe self-report (authoritative), herdr's report, then the newest session files. */
  async function resolveSessionFileCandidates(paneId: string, cwd: string, preferred?: string | null): Promise<string[]> {
    // A sub's sessionFile must never resolve to the master's own transcript (compare via
    // bareSessionId: herdr reports ids and paths interchangeably).
    const own = bareSessionId(h.getSessionId());
    const { reported, taken } = await reportedAndTaken(paneId);
    const out: string[] = [];
    const push = (file: string | null): void => {
      if (!file || out.includes(file)) return;
      const id = bareSessionId(file);
      if (own && id === own) return;
      if (taken.has(id)) return;
      out.push(file);
    };
    push(resolveSessionFileValue(cwd, h.sessionsDir(), preferred));
    push(resolveSessionFileValue(cwd, h.sessionsDir(), reported));
    for (const f of listSessionFiles(cwd, h.sessionsDir(), 4)) push(f);
    return out;
  }

  async function* readableCandidates(paneId: string, cwd: string, preferred?: string | null): AsyncGenerator<{ file: string; stamp: FileStamp }> {
    for (const file of await resolveSessionFileCandidates(paneId, cwd, preferred)) {
      // herdr reports .jsonl paths before the file exists; vanished paths are skipped, never surfaced.
      const stamp = stampOf(file);
      if (stamp) yield { file, stamp };
    }
  }

  async function resolveSessionFile(
    paneId: string,
    cwd: string,
    preferred?: string | null,
    opts?: ResolveSessionFileOpts,
  ): Promise<string | null> {
    for await (const { file, stamp } of readableCandidates(paneId, cwd, preferred)) {
      if (opts?.minMtimeMs != null && stamp.mtimeMs < opts.minMtimeMs) continue;
      return file;
    }
    return null;
  }

  async function reattributeStaleSessionFile(
    paneId: string,
    cwd: string,
    sinceTs: number,
    preferred: string | null,
  ): Promise<string | null> {
    // Tolerate fs timestamp granularity against the pre-injection injectTs capture.
    const minMtimeMs = sinceTs - 2_000;
    const own = bareSessionId(h.getSessionId());
    const { reported, taken } = await reportedAndTaken(paneId);
    // Own/taken exclusions apply to `preferred` too: a registry value pointing at the master's own
    // transcript is always "fresh", so the gate cannot veto it and herdr's report takes over.
    const preferredId = preferred ? bareSessionId(preferred) : null;
    const preferredHeld = preferredId != null && ((own != null && preferredId === own) || taken.has(preferredId));
    const preferredStamp = preferred ? stampOf(preferred) : null;
    if (preferred && !preferredHeld && preferredStamp && preferredStamp.mtimeMs >= minMtimeMs) return preferred;
    const file = resolveSessionFileValue(cwd, h.sessionsDir(), reported);
    if (!file) return null;
    const id = bareSessionId(file);
    if (own && id === own) return null;
    if (taken.has(id)) return null;
    const stamp = stampOf(file);
    return stamp && stamp.mtimeMs >= minMtimeMs ? file : null;
  }

  async function collectFinalText(
    paneId: string,
    cwd: string,
    sinceTs: number,
    attempts = 12,
    preferred?: string | null,
  ): Promise<string | null> {
    for (let i = 0; i < attempts; i++) {
      for await (const { file, stamp } of readableCandidates(paneId, cwd, preferred)) {
        const cached = finalTextCache.get(file, stamp, sinceTs);
        if (cached !== undefined) {
          if (cached) return cached;
          continue;
        }
        const entries: SessionEntryLike[] | null = readSessionFile(file);
        if (!entries) continue;
        const text = lastAssistantText(entries, { sinceTs })?.text ?? null;
        finalTextCache.set(file, stamp, sinceTs, text);
        if (text) return text;
      }
      await sleep(500);
    }
    return null;
  }

  async function readAskFlag(paneId: string): Promise<string | null> {
    try {
      const a = (await h.client.listAgents()).find((x) => x.paneId === paneId);
      const v = a?.tokens?.['pi-ask'];
      return typeof v === 'string' && v ? v : null;
    } catch {
      return null;
    }
  }

  async function probeAlive(paneId: string, cwd: string): Promise<AliveProbe> {
    const probe: AliveProbe = { paneExists: false, agentStatus: null, lastActivityMs: null };
    let listed = false;
    try {
      const pane = (await h.client.listPanes()).find((p) => p.paneId === paneId);
      listed = true;
      probe.paneExists = pane != null;
      probe.agentStatus = pane?.agentStatus ?? null;
      if (pane?.foregroundCwd) probe.foregroundCwd = pane.foregroundCwd;
    } catch {
      /* pane.list unavailable — agent.list is a degraded fallback, not a death signal */
    }
    try {
      const a = (await h.client.listAgents()).find((x) => x.paneId === paneId);
      if (a) {
        if (!listed) probe.paneExists = true;
        probe.agentStatus = a.status ?? probe.agentStatus;
        if (a.foregroundCwd) probe.foregroundCwd = a.foregroundCwd;
      }
    } catch {
    }
    for await (const { stamp } of readableCandidates(paneId, cwd)) {
      if (probe.lastActivityMs == null || stamp.mtimeMs > probe.lastActivityMs) probe.lastActivityMs = stamp.mtimeMs;
    }
    return probe;
  }

  async function subSessionState(
    paneId: string,
    cwd: string,
    sinceTs: number,
    preferred?: string | null,
  ): Promise<SubSessionState> {
    for await (const { file, stamp } of readableCandidates(paneId, cwd, preferred)) {
      const cached = stateCache.get(file, stamp, sinceTs);
      if (cached) return cached;
      const entries = readSessionFile(file);
      if (!entries?.length) continue;
      const state = deriveSubSessionState(entries, sinceTs);
      stateCache.set(file, stamp, sinceTs, state);
      return state;
    }
    return { text: null, pendingTool: false, activity: false, turnEnded: false, compacting: false };
  }

  /** Last assistant text of the best candidate regardless of stopReason: the settle attribution
   *  judgment asks what the tail we READ looks like, not whether it is final. */
  async function readSettleTail(
    paneId: string,
    cwd: string,
    preferred?: string | null,
    maxChars = 1200,
  ): Promise<string | null> {
    for await (const { file } of readableCandidates(paneId, cwd, preferred)) {
      const entries = readSessionFile(file);
      if (!entries?.length) continue;
      for (let i = entries.length - 1; i >= 0; i--) {
        const m = entries[i]?.message as { role?: string; content?: Array<{ type?: string; text?: string }> } | undefined;
        if (!m || m.role !== 'assistant' || !Array.isArray(m.content)) continue;
        const text = m.content
          .filter((c) => c && c.type === 'text' && c.text)
          .map((c) => c.text as string)
          .join('\n')
          .trim();
        if (text) return text.slice(-maxChars);
      }
      return null;
    }
    return null;
  }

  return {
    resolveSessionFile,
    collectFinalText,
    readAskFlag,
    probeAlive,
    subSessionState,
    readSettleTail,
    reattributeStaleSessionFile,
  };
}

/* ── output observation action ──────────────────────────────────── */

interface SubagentOutputRead {
  text: string;
  revision: number;
  truncated: boolean;
}

/** Newer herdr exposes agent.read; older only pane.read. Prefer the semantic endpoint. */
async function readSubagentOutput(client: HerdrClientLike, paneId: string): Promise<SubagentOutputRead> {
  if (typeof client.readAgent === 'function') {
    try {
      return await client.readAgent(paneId, { source: 'recent', stripAnsi: true });
    } catch {
    }
  }
  return await client.readPane(paneId, { source: 'recent', stripAnsi: true });
}

export async function executeSubagentOutput(
  params: Record<string, unknown> | undefined,
  toolCtx: unknown,
  deps: {
    client: HerdrClientLike;
    resolveEntry: (rawId: string, cwd: string) => { entry: SubEntry } | { error: string };
    outputCursors: Map<string, SubagentOutputCursor>;
    getCwd: (toolCtx: unknown) => string;
    /** Last finalized assistant text from the worker's transcript: the pane read alone cannot
     * recover it when the fullscreen TUI shows only the status overlay. Optional for tests. */
    readFinalReport?: (paneId: string, entryCwd: string) => Promise<string | null>;
  },
) {
  const rawId = idParam(params, 'agentId', 'taskId');
  if (!rawId) return toolError('Error: missing agentId for output (see action list)');

  const cwd = deps.getCwd(toolCtx);
  const resolved = deps.resolveEntry(rawId, cwd);
  if ('error' in resolved) return toolError(resolved.error);

  const entry = resolved.entry;
  let agentState: HerdrAgentState | null = null;
  let askFlag: string | null = null;
  try {
    const agent = (await deps.client.listAgents()).find((candidate) => candidate.paneId === entry.paneId);
    agentState = agent?.status ?? null;
    askFlag = agent?.tokens?.['pi-ask'] ?? null;
  } catch {
  }

  const status = resolveSubagentStatus({ localStatus: entry.status, herdrStatus: agentState, hasAskFlag: Boolean(askFlag) });

  let rawRead: SubagentOutputRead;
  try {
    rawRead = await readSubagentOutput(deps.client, entry.paneId);
  } catch (err) {
    return toolError(`Error: failed to read output for subagent ${entry.paneId}: ${(err as Error).message}`);
  }

  const prevCursor = deps.outputCursors.get(entry.paneId);
  const maxChars = typeof params?.max_chars === 'number'
    ? params.max_chars
    : typeof params?.maxChars === 'number' ? params.maxChars : undefined;
  const deltaResult = computeSubagentOutputDelta(prevCursor, rawRead.text, { maxChars });
  deltaResult.nextCursor.reportTail ??= prevCursor?.reportTail;

  // Transcript fallback: the terminal delta can be empty (or footer-only) while the finished
  // report exists only in the session file. Surface it once per distinct report.
  let reportSection: string | null = null;
  if ((status === 'settled' || status === 'idle') && deps.readFinalReport) {
    try {
      const report = await deps.readFinalReport(entry.paneId, entry.cwd);
      const fingerprint = report ? report.slice(-64) : '';
      if (report && fingerprint && fingerprint !== deltaResult.nextCursor.reportTail) {
        const bounded = boundText(report, Math.max(1, Math.min(maxChars ?? OUTPUT_DEFAULT_MAX_CHARS, OUTPUT_HARD_CAP_CHARS)));
        reportSection = `[Subagent Report | latest finalized message from session transcript${bounded.truncated ? ' | truncated' : ''}]\n${bounded.text}`;
        deltaResult.nextCursor.reportTail = fingerprint;
      }
    } catch {
    }
  }
  deps.outputCursors.set(entry.paneId, deltaResult.nextCursor);

  const formatted = formatSubagentOutput({
    paneId: entry.paneId,
    status,
    revision: rawRead.revision,
    bufferTruncated: rawRead.truncated,
    deltaResult,
    askQuestion: askFlag,
  });

  return {
    content: [{ type: 'text' as const, text: reportSection ? `${formatted}\n${reportSection}` : formatted }],
    details: {
      paneId: entry.paneId,
      status,
      revision: rawRead.revision,
      truncated: rawRead.truncated || deltaResult.truncated,
      restart: deltaResult.restart,
      deltaLength: deltaResult.delta.length,
      reportDelivered: Boolean(reportSection),
    },
  };
}
