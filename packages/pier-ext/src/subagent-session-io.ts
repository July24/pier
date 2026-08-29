/**
 * Child-session JSONL I/O: path resolution, settlement text, liveness probes.
 *
 * Why: pollLoop, foreground wait, and revive all shared the same candidate
 * order (reported path/id before recent-file fallback, excluding the parent
 * session). Keeping it in one adapter prevents settlement text from crossing sessions.
 */
import { stat as statCb } from 'node:fs';
import { promisify } from 'node:util';
import type { HerdrClientLike } from './herdr-client.ts';
import {
  hasAssistantAfter,
  hasPendingToolCall,
  lastAssistantText,
  listSessionFiles,
  readSessionFile,
  sessionFileById,
} from './session-tail.ts';
import type { AliveProbe } from './subagent-core.ts';

const statAsync = promisify(statCb);

export interface SessionIoHost {
  client: HerdrClientLike;
  getSessionId: () => string;
  sessionsDir: () => string;
}

export interface SessionIo {
  resolveSessionFileCandidates(paneId: string, cwd: string): Promise<string[]>;
  resolveSessionFile(paneId: string, cwd: string): Promise<string | null>;
  collectFinalText(paneId: string, cwd: string, sinceTs: number, attempts?: number): Promise<string | null>;
  readAskFlag(paneId: string): Promise<string | null>;
  probeAlive(paneId: string, cwd: string): Promise<AliveProbe>;
  subSessionState(paneId: string, cwd: string, sinceTs: number): Promise<{ text: string | null; pendingTool: boolean; activity: boolean }>;
}

export function createSessionIo(h: SessionIoHost): SessionIo {
  async function resolveSessionFileCandidates(paneId: string, cwd: string): Promise<string[]> {
    const out: string[] = [];
    try {
      const reported = await h.client.getAgentSessionPath(paneId);
      if (reported) {
        if (/\.jsonl$/.test(reported)) out.push(reported);
        else {
          const byId = sessionFileById(cwd, h.sessionsDir(), reported);
          if (byId) out.push(byId);
        }
      }
    } catch {
      /* Reports may be unavailable during startup. */
    }
    const ownSession = h.getSessionId();
    for (const f of listSessionFiles(cwd, h.sessionsDir(), 4)) {
      if (f !== ownSession && !out.includes(f)) out.push(f);
    }
    return out;
  }

  async function resolveSessionFile(paneId: string, cwd: string): Promise<string | null> {
    for (const file of await resolveSessionFileCandidates(paneId, cwd)) {
      if (readSessionFile(file)) return file;
    }
    return null;
  }

  async function collectFinalText(
    paneId: string,
    cwd: string,
    sinceTs: number,
    attempts = 12,
  ): Promise<string | null> {
    for (let i = 0; i < attempts; i++) {
      for (const file of await resolveSessionFileCandidates(paneId, cwd)) {
        const entries = readSessionFile(file);
        if (!entries) continue;
        const r = lastAssistantText(entries, { sinceTs });
        if (r?.text) return r.text;
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
    try {
      const agents = await h.client.listAgents();
      const a = agents.find((x) => x.paneId === paneId);
      probe.paneExists = a != null;
      probe.agentStatus = a?.status ?? null;
    } catch {
      /* Fall back to session activity when agent.list is unavailable. */
    }
    for (const file of await resolveSessionFileCandidates(paneId, cwd)) {
      try {
        const mtime = (await statAsync(file)).mtimeMs;
        if (probe.lastActivityMs == null || mtime > probe.lastActivityMs) probe.lastActivityMs = mtime;
      } catch {
        /* Session files can disappear during candidate scanning. */
      }
    }
    return probe;
  }

  async function subSessionState(
    paneId: string,
    cwd: string,
    sinceTs: number,
  ): Promise<{ text: string | null; pendingTool: boolean; activity: boolean }> {
    for (const file of await resolveSessionFileCandidates(paneId, cwd)) {
      const entries = readSessionFile(file);
      if (entries.length === 0) continue;
      const r = lastAssistantText(entries, { sinceTs });
      if (r?.text) return { text: r.text, pendingTool: false, activity: true };
      if (hasPendingToolCall(entries, sinceTs)) return { text: null, pendingTool: true, activity: true };
      if (hasAssistantAfter(entries, sinceTs)) return { text: null, pendingTool: false, activity: true };
    }
    return { text: null, pendingTool: false, activity: false };
  }

  return {
    resolveSessionFileCandidates,
    resolveSessionFile,
    collectFinalText,
    readAskFlag,
    probeAlive,
    subSessionState,
  };
}

