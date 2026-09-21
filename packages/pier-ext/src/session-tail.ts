/**
 * Tail parsing for pi session JSONL (pure library, v1.1 result channel).
 *
 * Since v1.1 (DESIGN.md §12), child-agent results come from the child session file
 * rather than pane text, keeping the authoritative machine-readable source free of
 * echo contamination and scrollback blind spots. This module depends only on the
 * empirically observed pi session format (session-format documentation):
 *   line = {type, id, parentId, message:{role, content:[{type:'text',text}...], timestamp, stopReason}}
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { piSessionDirCandidates, sessionDirName } from './storage-layout.ts';
import { isValidSessionId } from './efficiency-store.ts';
import { COMPACTION_INFLIGHT_TYPE, COMPACTION_SETTLED_TYPE } from './compact-coordinator.ts';

export { sessionDirName };

export interface SessionMessageLike {
  role?: string;
  content?: Array<{ type?: string; text?: string } | unknown> | unknown;
  timestamp?: number;
  stopReason?: string;
}

export interface SessionEntryLike {
  type?: string;
  message?: SessionMessageLike | unknown;
  [k: string]: unknown;
}
/** Parse line by line tolerantly, skipping malformed or non-JSON records. */
export function parseSessionEntries(text: string): SessionEntryLike[] {
  const entries: SessionEntryLike[] = [];
  for (const line of (text ?? '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t);
      if (obj && typeof obj === 'object') entries.push(obj as SessionEntryLike);
    } catch {
      /* Skip truncated or malformed records. */
    }
  }
  return entries;
}

function messageOf(entry: SessionEntryLike): SessionMessageLike | null {
  if (entry.type !== 'message') return null;
  const m = entry.message;
  if (typeof m !== 'object' || m === null) return null;
  return m as SessionMessageLike;
}

function textOf(m: SessionMessageLike): string {
  const content = m.content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => {
      if (typeof c === 'object' && c !== null && (c as { type?: string }).type === 'text') {
        return (c as { text?: string }).text ?? '';
      }
      return '';
    })
    .join('\n')
    .trim();
}
/**
 * Return the latest finalized assistant text (stopReason === 'stop'), excluding toolUse intermediates.
 * sinceTs filters out messages that predate the injection point.
 */
export function lastAssistantText(
  entries: readonly SessionEntryLike[],
  opts: { sinceTs?: number } = {},
): { text: string; timestamp: number } | null {
  let best: { text: string; timestamp: number } | null = null;
  for (const entry of entries) {
    const m = messageOf(entry);
    if (!m || m.role !== 'assistant') continue;
    if (m.stopReason !== 'stop') continue;
    const ts = typeof m.timestamp === 'number' ? m.timestamp : 0;
    if (opts.sinceTs !== undefined && ts < opts.sinceTs) continue;
    if (!best || ts >= best.timestamp) best = { text: textOf(m), timestamp: ts };
  }
  return best;
}
/** Return whether any assistant message occurs after the injection point, regardless of stopReason. */
export function hasAssistantAfter(
  entries: readonly SessionEntryLike[],
  sinceTs: number,
): boolean {
  return entries.some((e) => {
    const m = messageOf(e);
    return !!m && m.role === 'assistant' && (typeof m.timestamp === 'number' ? m.timestamp : 0) >= sinceTs;
  });
}
/**
 * Return whether the NEWEST assistant message after `sinceTs` ended its turn.
 *
 * Why (A16): a worker sitting between tool calls (tool result already written, next assistant
 * message still streaming) has "an assistant message" but has NOT finished. Treating any assistant
 * message as activity made the poller announce such workers as finished — three real workers were
 * declared settled while still working on 2026-09-13 and one was later closed mid-task by GC.
 *
 * `stopReason === 'toolUse'` means the model requested tools, so the turn continues; a non-string
 * stopReason (message still streaming / older shapes) is treated as "not ended" on purpose — the
 * cost of waiting is small, the cost of a false settlement is losing supervision of live work.
 */
export function lastAssistantTurnEnded(
  entries: readonly SessionEntryLike[],
  sinceTs: number,
): boolean {
  let newest: { ts: number; stopReason: unknown } | null = null;
  for (const entry of entries) {
    const m = messageOf(entry);
    if (!m || m.role !== 'assistant') continue;
    const ts = typeof m.timestamp === 'number' ? m.timestamp : 0;
    if (ts < sinceTs) continue;
    if (!newest || ts >= newest.ts) newest = { ts, stopReason: m.stopReason };
  }
  if (!newest) return false;
  const sr = newest.stopReason;
  return typeof sr === 'string' && sr !== 'toolUse' && sr !== 'pending';
}
/**
 * Return whether an initiated toolCall still lacks a result after injection (for example,
 * ask_user_question waiting on human input), meaning settlement has not actually completed
 * (v1.3 M8 settlement-race fix). Parallel calls are tracked by depth.
 */
export function hasPendingToolCall(entries: readonly SessionEntryLike[], sinceTs: number): boolean {
  let depth = 0;
  for (const entry of entries) {
    const m = messageOf(entry);
    if (!m) continue;
    const ts = typeof m.timestamp === 'number' ? m.timestamp : 0;
    if (ts < sinceTs) continue;
    if (m.role === 'assistant') {
      const content = m.content;
      if (Array.isArray(content)) {
        depth += content.filter((c) => typeof c === 'object' && c !== null && (c as { type?: string }).type === 'toolCall').length;
      }
    }
    if (m.role === 'toolResult') depth -= 1;
  }
  return depth > 0;
}



/** Derived settlement state of one child session, from the inject point onward. */
export interface SubSessionState {
  text: string | null;
  pendingTool: boolean;
  activity: boolean;
  turnEnded: boolean;
  /**
   * True while the child is inside an OCC compaction cycle: from the inflight marker
   * until the settled marker is followed by an assistant message (the continuation turn).
   * OCC's intentional abort lands as stopReason 'error' in this transcript, which the
   * turnEnded check alone would misread as a finished worker (01a0be1f / wA:p2M).
   */
  compacting: boolean;
}

/**
 * Whether the transcript currently sits inside an OCC compaction cycle.
 *
 * Last marker wins: inflight as the final marker means the summary request is running;
 * a settled marker means the cycle is over — unless no assistant message follows it yet,
 * in which case the continuation turn has not produced output and the worker is still
 * machine-paused (must not settle, and must not be mistaken for a user takeover either).
 */
export function compactionBusy(entries: readonly SessionEntryLike[]): boolean {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry || entry.type !== 'custom') continue;
    const customType = entry.customType;
    if (customType === COMPACTION_INFLIGHT_TYPE) return true;
    if (customType === COMPACTION_SETTLED_TYPE) {
      for (let j = i + 1; j < entries.length; j++) {
        if (messageOf(entries[j])?.role === 'assistant') return false;
      }
      return true;
    }
  }
  return false;
}

/**
 * Derive the settlement state from already-parsed entries.
 *
 * Closing text is by construction terminal (lastAssistantText requires stopReason 'stop').
 * A16: an assistant message alone is not a settlement; the turn must have ENDED.
 */
export function deriveSubSessionState(
  entries: readonly SessionEntryLike[],
  sinceTs: number,
): SubSessionState {
  const compacting = compactionBusy(entries);
  const r = lastAssistantText(entries, { sinceTs });
  if (r?.text) return { text: r.text, pendingTool: false, activity: true, turnEnded: true, compacting };
  if (hasPendingToolCall(entries, sinceTs)) return { text: null, pendingTool: true, activity: true, turnEnded: false, compacting };
  if (hasAssistantAfter(entries, sinceTs)) {
    return { text: null, pendingTool: false, activity: true, turnEnded: lastAssistantTurnEnded(entries, sinceTs), compacting };
  }
  return { text: null, pendingTool: false, activity: false, turnEnded: false, compacting };
}

/** Newest `limit` session files under cwd's session dir (pi core's name first, then pier's old encodings). */
export function listSessionFiles(cwd: string, agentDir: string, limit = 4): string[] {
  const files: Array<{ file: string; mtime: number }> = [];
  for (const name of piSessionDirCandidates(cwd)) {
    const dir = path.join(agentDir, name);
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const fileName of names) {
      if (!fileName.endsWith('.jsonl')) continue;
      const full = path.join(dir, fileName);
      try {
        files.push({ file: full, mtime: fs.statSync(full).mtimeMs });
      } catch {
        /* vanished between readdir and stat */
      }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return files.slice(0, limit).map((f) => f.file);
}

/**
 * Locate a session file by id (`<ts>_<id>.jsonl`).
 * Searches pi core's own directory name first, then pier's legacy flattened dirs.
 */
export function sessionFileById(cwd: string, agentDir: string, id: string): string | null {
  const suffix = `_${id}.jsonl`;
  for (const name of piSessionDirCandidates(cwd)) {
    const dir = path.join(agentDir, name);
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const fileName of names) {
      if (fileName.endsWith(suffix)) return path.join(dir, fileName);
    }
  }
  return null;
}

/**
 * Normalize a session path or id to the bare id used across herdr-pi state
 * (`<timestamp>_<uuid>.jsonl` → `<uuid>`; `sub-session.jsonl` stays whole).
 * Only pi's real transcript prefix is stripped, so arbitrary ids like
 * PI_SESSION_FILE=sess_idx_prune survive untouched. Same-normalization
 * comparisons (own session vs candidate paths) must go through here.
 */
export function bareSessionId(raw: string): string {
  const base = raw.replaceAll('\\', '/').split('/').pop()!.replace(/\.jsonl$/, '');
  const stripped = base.replace(/^\d{4}-\d{2}-\d{2}T[\d-]+Z_/, '');
  return isValidSessionId(stripped) ? stripped : base;
}

export function readSessionFile(file: string): SessionEntryLike[] | null {
  try {
    return parseSessionEntries(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}
