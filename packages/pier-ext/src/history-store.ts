/**
 * Workspace history (v1.2, DESIGN.md §13.4).
 *
 * Task history is append-only JSONL partitioned by cwd, mirroring pi session partitioning:
 *   <agentRoot>/herdr-pi/history/--<cwd>--/history.jsonl
 * Records are immutable so GC can remove panes without deleting history. Recovery keeps
 * both the sessionFile and launchCommand snapshots as fallbacks.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { historyFilePath, preferredHistoryFile } from './storage-layout.ts';

export { historyFilePath, preferredHistoryFile };

/** Legacy short/resident entries normalize to task; missing values do too, while role names pass through unchanged. */
export function normalizeEntryKind(kind: string | null | undefined): string {
  if (!kind || kind === 'short' || kind === 'resident') return 'task';
  return kind;
}

/** O6: only a .jsonl path is accepted during settlement, so invalid reports cannot overwrite a valid path. */
export function applyReportedSessionFile(
  current: string | null,
  reported: string | null | undefined,
): string | null {
  if (typeof reported === 'string' && /\.jsonl$/i.test(reported)) return reported;
  return current;
}

export interface HistoryEntry {
  taskId: string;
  /** 'task' or a role name; disk reads normalize short/resident to task for compatibility. */
  kind: string;
  paneId: string;
  tabId: string;
  /** v1.3: task tab name retained for history review and revival; omitted by older entries. */
  tabName?: string;
  workspaceId: string;
  cwd: string;
  description: string;
  /** Child-agent session file, preferred when resuming. */
  sessionFile: string | null;
  /** Launch command snapshot, used to rebuild an empty continuation when sessionFile is missing. */
  launchCommand: string[];
  status: 'running' | 'settled' | 'consumed' | 'closed';
  outcome?: string | null;
  createdAt: number;
  /** M13c: durable consumption time, which provides the GC TTL basis. */
  consumedAt?: number | null;
  closedAt?: number | null;
  /** Previous-generation pane ID, retained when work is redone or revived. */
  revivedFrom?: string | null;
  /** B5: writer marker (spawn / poll-settle / poll-timeout / gc / zombie-sweep …), so
   * multiple entries in one second remain auditable (ledger row#23/24 proves both writes). */
  via?: string;
}

/** B5: inherit outcome for a closed row—when patch omits it, use the latest non-empty value
 * for that taskId, preventing GC bookkeeping from erasing settlement results under the
 * “latest row is state” rule. */
export function inheritOutcome(lastOutcome: string | null | undefined, patchOutcome: string | null | undefined): string | null {
  if (patchOutcome !== undefined) return patchOutcome;
  return lastOutcome ?? null;
}



/** Parse line by line tolerantly, skipping malformed records. */
export function parseHistoryEntries(text: string): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  for (const line of (text ?? '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t);
      if (obj && typeof obj === 'object' && typeof obj.taskId === 'string') {
        const raw = obj as HistoryEntry;
        entries.push({ ...raw, kind: normalizeEntryKind(raw.kind) });
      }
    } catch {
      /* Skip malformed records. */
    }
  }
  return entries;
}

function serializeEntry(entry: HistoryEntry): string {
  return JSON.stringify(entry);
}

/** Read a history file; a missing or unreadable file yields []. */
export function readHistory(file: string): HistoryEntry[] {
  try {
    return parseHistoryEntries(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

/** Append one entry, creating its parent directory first. */
export function appendHistory(file: string, entry: HistoryEntry): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, serializeEntry(entry) + '\n');
  } catch {
    /* Best effort: history-write failures must not disrupt the main flow. */
  }
}

/** Group all generations of each taskId in ascending createdAt order for review. */
export function generationsByTask(entries: readonly HistoryEntry[]): Map<string, HistoryEntry[]> {
  const map = new Map<string, HistoryEntry[]>();
  for (const e of entries) {
    const arr = map.get(e.taskId) ?? [];
    arr.push(e);
    map.set(e.taskId, arr);
  }
  for (const arr of map.values()) arr.sort((a, b) => a.createdAt - b.createdAt);
  return map;
}

/** Return the newest generation for taskId, which is the one used for resume. */
export function latestGeneration(entries: readonly HistoryEntry[], taskId: string): HistoryEntry | null {
  const gens = generationsByTask(entries).get(taskId);
  if (!gens || gens.length === 0) return null;
  return gens[gens.length - 1];
}
