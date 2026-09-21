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
