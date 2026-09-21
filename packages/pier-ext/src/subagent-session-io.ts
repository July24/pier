/**
 * Child-session JSONL I/O: path resolution, settlement text, liveness probes.
 *
 * Why: pollLoop, foreground wait, and revive all shared the same candidate
 * order (reported path/id before recent-file fallback, excluding the parent
 * session and sessions claimed by other live panes). Keeping it in one
 * adapter prevents settlement text from crossing sessions.
 */
import { accessSync, constants, statSync } from 'node:fs';
import type { HerdrClientLike } from './herdr-client.ts';
import {
  bareSessionId,
  deriveSubSessionState,
  lastAssistantText,
  listSessionFiles,
  readSessionFile,
  sessionFileById,
  type SessionEntryLike,
  type SubSessionState,
} from './session-tail.ts';
import type { AliveProbe } from './subagent-core.ts';

export interface SessionIoHost {
  client: HerdrClientLike;
  getSessionId: () => string;
  sessionsDir: () => string;
}

export interface ResolveSessionFileOpts {
  /** Reject candidates whose last write predates this timestamp (epoch ms). Used to avoid
   * attributing a request to a session file that was never written after the request was
   * injected — the spawn-race mis-attribution observed in session 01a0c282. */
  minMtimeMs?: number;
}

export interface SessionIo {
  resolveSessionFileCandidates(paneId: string, cwd: string, preferred?: string | null): Promise<string[]>;
  resolveSessionFile(paneId: string, cwd: string, preferred?: string | null, opts?: ResolveSessionFileOpts): Promise<string | null>;
  collectFinalText(paneId: string, cwd: string, sinceTs: number, attempts?: number, preferred?: string | null): Promise<string | null>;
  readAskFlag(paneId: string): Promise<string | null>;
  probeAlive(paneId: string, cwd: string): Promise<AliveProbe>;
  subSessionState(paneId: string, cwd: string, sinceTs: number, preferred?: string | null): Promise<SubSessionState>;
  readSettleTail(paneId: string, cwd: string, preferred?: string | null, maxChars?: number): Promise<string | null>;
  /** Re-attribute a registry sessionFile that has no writes since `sinceTs`: keep `preferred`
   * when it is fresh; otherwise accept herdr's per-pane report when that file is fresh.
   * Never falls back to mtime heuristics, so an existing value is only ever replaced by
   * the authoritative report. Returns null when nothing fresh is known (keep the old value). */
  reattributeStaleSessionFile(paneId: string, cwd: string, sinceTs: number, preferred: string | null): Promise<string | null>;
}

/** Cheap change fingerprint of a session file; null when it does not exist. */
interface FileStamp {
  size: number;
  mtimeMs: number;
}

function stampOf(file: string): FileStamp | null {
  try {
    const s = statSync(file);
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return null;
  }
}

/** Readable regular file check: parsing the file would read it in full (up to MBs). */
function isReadableFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Memo of values derived from a session file, keyed by path and invalidated by (size, mtime).
 *
 * Why: worker sessions grow to tens of MB, and the poll loop re-derives the same idle state every
 * tick (collectFinalText re-derives up to `attempts` times). Measured on a 31.6MB session:
 * file read + JSON.parse + derive ≈ 227ms, so an unchanged file must not be parsed twice.
 * An append-only JSONL changes size on every write, so (size, mtime) is a sound fingerprint.
 */
class DerivedCache<T> {
  private readonly entries = new Map<string, { stamp: FileStamp; sinceTs: number; value: T }>();
  private readonly limit: number;

  constructor(limit = 32) {
    this.limit = limit;
  }

  get(file: string, stamp: FileStamp, sinceTs: number): T | undefined {
    const hit = this.entries.get(file);
    if (!hit || hit.stamp.size !== stamp.size || hit.stamp.mtimeMs !== stamp.mtimeMs || hit.sinceTs !== sinceTs) {
      return undefined;
    }
    return hit.value;
  }

  set(file: string, stamp: FileStamp, sinceTs: number, value: T): void {
    this.entries.delete(file);
    this.entries.set(file, { stamp, sinceTs, value });
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

export function createSessionIo(h: SessionIoHost): SessionIo {
  const stateCache = new DerivedCache<SubSessionState>();
  const finalTextCache = new DerivedCache<string | null>();
  async function resolveSessionFileCandidates(paneId: string, cwd: string, preferred?: string | null): Promise<string[]> {
    const out: string[] = [];
    // 01a0bd3a: a sub's sessionFile must never resolve to the master's own transcript.
    // herdr's report for a just-spawned pane can lag (or briefly point elsewhere) and the
    // mtime fallback otherwise picks the hottest file — the master's own jsonl. A poisoned
    // entry later made `resume` adopt the master pane as its own subagent and GC close it
    // while two real workers were still running. Compare via bareSessionId: herdr reports
    // ids and paths interchangeably, and the old full-path vs bare-id check never matched.
    const own = bareSessionId(h.getSessionId());
    // One agent.list serves both the per-pane report and the claimed-elsewhere set —
    // getAgentSessionPath hides a second identical RPC, and this resolver sits on poll
    // hot paths (collectFinalText retries, subSessionState ticks).
    let reported: string | null = null;
    const taken = new Set<string>();
    try {
      for (const a of await h.client.listAgents()) {
        if (!a.session) continue;
        if (a.paneId === paneId) reported = a.session;
        else taken.add(bareSessionId(a.session));
      }
      if (!reported) {
        // agent.list is authoritative in production, but a pane may be absent during
        // report lag (fresh spawn) — and stub clients expose only the per-pane report.
        reported = await h.client.getAgentSessionPath(paneId);
      }
    } catch {
      /* agent list unavailable (startup) → per-pane report fallback, own exclusion still holds */
      try {
        reported = await h.client.getAgentSessionPath(paneId);
      } catch {
        /* both unavailable */
      }
    }
    const push = (file: string | null): void => {
      if (!file || out.includes(file)) return;
      const id = bareSessionId(file);
      if (own && id === own) return;
      if (taken.has(id)) return;
      out.push(file);
    };
    // p24-class: the pipe self-report (entry.sessionFile) is authoritative for this pane —
    // try it before the herdr report and the mtime fallback (same own/taken filters apply).
    if (preferred && /\.jsonl$/i.test(preferred)) push(preferred);
    if (reported) {
      if (/\.jsonl$/.test(reported)) push(reported);
      else push(sessionFileById(cwd, h.sessionsDir(), reported));
    }
    for (const f of listSessionFiles(cwd, h.sessionsDir(), 4)) push(f);
    return out;
  }
  async function resolveSessionFile(
    paneId: string,
    cwd: string,
    preferred?: string | null,
    opts?: ResolveSessionFileOpts,
  ): Promise<string | null> {
    for (const file of await resolveSessionFileCandidates(paneId, cwd, preferred)) {
      if (opts?.minMtimeMs != null) {
        const stamp = stampOf(file);
        // No fresh write since the request → this candidate cannot hold the run's transcript.
        if (!stamp || stamp.mtimeMs < opts.minMtimeMs) continue;
      }
      if (isReadableFile(file)) return file;
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
    // Own/taken exclusions apply to `preferred` too (01a0bd3a): a registry value pointing at
    // the master's own transcript is always "fresh" — the master rewrites it continuously
    // during its own turn — so the freshness gate can never veto it. A poisoned preferred
    // FALLS THROUGH to herdr's per-pane report instead of returning null: the caller repairs
    // only on a different value, and null means "keep the old one" — i.e. preserve the poison.
    const own = bareSessionId(h.getSessionId());
    const taken = new Set<string>();
    let reported: string | null = null;
    try {
      for (const a of await h.client.listAgents()) {
        if (!a.session) continue;
        if (a.paneId === paneId) reported = a.session;
        else taken.add(bareSessionId(a.session));
      }
      if (!reported) reported = await h.client.getAgentSessionPath(paneId);
    } catch {
      return null;
    }
    const preferredId = preferred ? bareSessionId(preferred) : null;
    const preferredHeld = preferredId != null
      && ((own != null && preferredId === own) || taken.has(preferredId));
    const preferredStamp = preferred ? stampOf(preferred) : null;
    if (preferred && !preferredHeld && preferredStamp && preferredStamp.mtimeMs >= minMtimeMs) return preferred;
    if (!reported) return null;
    const file = /\.jsonl$/.test(reported) ? reported : sessionFileById(cwd, h.sessionsDir(), reported);
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
      for (const file of await resolveSessionFileCandidates(paneId, cwd, preferred)) {
        const stamp = stampOf(file);
        if (!stamp) continue;
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
      const wait = Promise.withResolvers<void>();
      setTimeout(wait.resolve, 500);
      await wait.promise;
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
      /* agent.list is status-only; absence is not death */
    }
    for (const file of await resolveSessionFileCandidates(paneId, cwd)) {
      const stamp = stampOf(file);
      // Session files can disappear during candidate scanning; a vanished file has no activity.
      if (!stamp) continue;
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
    for (const file of await resolveSessionFileCandidates(paneId, cwd, preferred)) {
      const stamp = stampOf(file);
      // A missing or vanished path is skipped: herdr often reports a .jsonl path before the worker
      // creates the file, and waitAgent(idle) returns immediately, which used to throw
      // `Cannot read properties of null (reading 'length')` (session 01a055c5).
      if (!stamp) continue;
      const cached = stateCache.get(file, stamp, sinceTs);
      if (cached) return cached;
      const entries = readSessionFile(file);
      // An empty/unparsable file has no state to cache; the next candidate may still have one.
      if (!entries?.length) continue;
      const state = deriveSubSessionState(entries, sinceTs);
      stateCache.set(file, stamp, sinceTs, state);
      return state;
    }
    return { text: null, pendingTool: false, activity: false, turnEnded: false };
  }

  /** Last assistant text (any stopReason) tail of the best candidate — state for the
   * settle attribution judgment when closing text came back null. Unlike
   * collectFinalText this ignores stopReason and sinceTs: the question is "what does
   * the tail we READ look like", not "is there a finalized report". */
  async function readSettleTail(
    paneId: string,
    cwd: string,
    preferred?: string | null,
    maxChars = 1200,
  ): Promise<string | null> {
    for (const file of await resolveSessionFileCandidates(paneId, cwd, preferred)) {
      if (!isReadableFile(file)) continue;
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
    resolveSessionFileCandidates,
    resolveSessionFile,
    collectFinalText,
    readAskFlag,
    probeAlive,
    subSessionState,
    readSettleTail,
    reattributeStaleSessionFile,
  };
}

