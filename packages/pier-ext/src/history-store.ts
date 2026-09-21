/**
 * Delegation ledger: append-only JSONL partitioned by cwd, mirroring pi's session partitioning
 * (<agentRoot>/herdr-pi/history/--<cwd>--/history.jsonl). Rows are immutable, so GC can drop panes
 * without losing history; recovery keeps both the sessionFile and launchCommand snapshots.
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
  consumedAt?: number | null;
  closedAt?: number | null;
  revivedFrom?: string | null;
  /** Writer marker (spawn / poll-settle / poll-timeout / gc / zombie-sweep …) for auditability. */
  via?: string;
}

/** When a patch omits `outcome`, inherit the latest non-empty value for the taskId: GC
 * bookkeeping must not erase a settlement result under the "latest row is state" rule. */
export function inheritOutcome(lastOutcome: string | null | undefined, patchOutcome: string | null | undefined): string | null {
  if (patchOutcome !== undefined) return patchOutcome;
  return lastOutcome ?? null;
}



const HISTORY_STATUSES: Record<string, true> = {
  running: true,
  settled: true,
  consumed: true,
  closed: true,
};

function coerceHistoryEntry(obj: unknown): HistoryEntry | null {
  if (obj === null || typeof obj !== 'object') return null;
  const rec = obj as Record<string, unknown>;
  if (typeof rec.taskId !== 'string' || rec.taskId.trim() === '') return null;
  if (typeof rec.status !== 'string' || HISTORY_STATUSES[rec.status] !== true) return null;
  if (rec.createdAt !== undefined && !Number.isFinite(rec.createdAt)) return null;
  const raw = rec as unknown as HistoryEntry;
  return { ...raw, kind: normalizeEntryKind(raw.kind) };
}

/** Parse line by line; skip junk JSON and records missing taskId/status. */
export function parseHistoryEntries(text: string): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  for (const line of (text ?? '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const next = coerceHistoryEntry(JSON.parse(t));
      if (next) entries.push(next);
    } catch {
      /* Skip malformed records. */
    }
  }
  return entries;
}

function serializeEntry(entry: HistoryEntry): string {
  return JSON.stringify(entry);
}

export type HistoryReadResult =
  | { status: 'ok'; entries: HistoryEntry[] }
  | { status: 'missing' }
  | { status: 'unreadable'; error: Error };

/** Distinguish missing vs permission/IO failure. readHistory still returns [] for both. */
export function inspectHistory(file: string): HistoryReadResult {
  try {
    if (!fs.existsSync(file)) return { status: 'missing' };
    return { status: 'ok', entries: parseHistoryEntries(fs.readFileSync(file, 'utf8')) };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    return { status: 'unreadable', error: err };
  }
}

/** Read a history file; missing or unreadable yields []. */
export function readHistory(file: string): HistoryEntry[] {
  const r = inspectHistory(file);
  return r.status === 'ok' ? r.entries : [];
}

export type HistoryWriteResult = { ok: true } | { ok: false; error: Error };

/** Append one entry. Failures are logged and returned so the ledger is not silently lost. */
export function appendHistory(file: string, entry: HistoryEntry): HistoryWriteResult {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, serializeEntry(entry) + '\n');
    return { ok: true };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error(`[pi-herdr] history append failed: ${file}: ${err.message}`);
    return { ok: false, error: err };
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
