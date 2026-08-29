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
import { sessionDirCandidates, sessionDirName } from './storage-layout.ts';

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



/** Newest `limit` session files under cwd's session dir (new encoding, then legacy). */
export function listSessionFiles(cwd: string, agentDir: string, limit = 4): string[] {
  const files: Array<{ file: string; mtime: number }> = [];
  for (const name of sessionDirCandidates(cwd)) {
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
 * Searches the new encoding dir first, then the legacy flattened dir.
 */
export function sessionFileById(cwd: string, agentDir: string, id: string): string | null {
  const suffix = `_${id}.jsonl`;
  for (const name of sessionDirCandidates(cwd)) {
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

export function readSessionFile(file: string): SessionEntryLike[] | null {
  try {
    return parseSessionEntries(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}
