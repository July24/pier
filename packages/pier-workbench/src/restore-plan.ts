/** Pure helpers behind the restore-layout hook, so the restore decision stays testable without a live
 * herdr socket (the script remains a thin socket wrapper). */

export interface BootRecord {
  workspace_id: string;
  tab_id?: string;
  pane_id?: string;
  cwd?: string;
  [key: string]: unknown;
}

/** Parse boot.jsonl, dropping blank/corrupt lines and records without a workspace id. */
export function parseBootRecords(text: string): BootRecord[] {
  const out: BootRecord[] = [];
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // A half-written tail line must not break the restore.
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const rec = parsed as Record<string, unknown>;
    if (typeof rec.workspace_id !== 'string' || rec.workspace_id === '') continue;
    out.push(rec as BootRecord);
  }
  return out;
}

/**
 * F05: boot.jsonl is append-only: a reopened workspace has several records, so keep the newest per
 * workspace — replaying older ones rebuilds the same main tab repeatedly (duplicate master panes).
 */
export function latestBootRecordPerWorkspace(records: readonly BootRecord[]): BootRecord[] {
  const byWorkspace = new Map<string, BootRecord>();
  for (const rec of records) byWorkspace.set(rec.workspace_id, rec);
  return [...byWorkspace.values()];
}

/** The pane fields the master check reads from herdr's pane.list. */
export interface PaneLike {
  pane_id: string;
  agent?: unknown;
  title?: unknown;
}

/** D91 icon transition: ▶ prefixes new sessions, ⏳ legacy ones — both mark a live pi master. */
export function isMasterPane(pane: PaneLike): boolean {
  return pane.agent === 'pi' || (typeof pane.title === 'string' && /⏳|▶/.test(pane.title));
}

/**
 * The record to append after restore rebuilt (or found) the main pane: the newest record must name
 * the live ids, or the next startup finds the dead ones again and rebuilds another master. Null when
 * herdr's reply carried no pane id — there is nothing trustworthy to record.
 */
export function rebuiltBootRecord(
  rec: BootRecord,
  ids: { tabId?: string | null; paneId?: string | null },
  ts: number,
): BootRecord | null {
  if (!ids.paneId) return null;
  return { ...rec, tab_id: ids.tabId || rec.tab_id, pane_id: ids.paneId, ts };
}
