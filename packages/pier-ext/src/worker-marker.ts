/**
 * Worker identity marker: the delegation identity (parent terminal/session, task) is written
 * beside the session transcript so a `/resume` replay of that exact session keeps learning who
 * delegated it, even when the spawn env is gone. Masters never write a marker; a stale marker for a
 * dead session is inert (it is only consulted when pi boots with that exact session file).
 */
import type { DelegationContext } from './delegation-core.ts';
import { delegationFromRecord } from './delegation-core.ts';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { bareSessionId } from './session-tail.ts';
import { isValidSessionId } from './efficiency-store.ts';

export interface WorkerMarker {
  readonly v: 1;
  readonly ts: number;
  readonly delegation?: DelegationContext;
}

/** `<sessionDir>/herdr-pi/<sessionId>/worker.json` — same per-session root as the efficiency store. */
export function workerMarkerPath(sessionFile: string | null | undefined): string | null {
  if (!sessionFile || typeof sessionFile !== 'string') return null;
  const id = bareSessionId(sessionFile);
  if (!isValidSessionId(id)) return null;
  return join(dirname(sessionFile), 'herdr-pi', id, 'worker.json');
}

export function readWorkerMarker(sessionFile: string | null | undefined): WorkerMarker | null {
  const file = workerMarkerPath(sessionFile);
  if (!file) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { v?: unknown; ts?: unknown; delegation?: unknown };
    if (parsed && parsed.v === 1 && typeof parsed.ts === 'number') {
      const delegation = delegationFromRecord(parsed.delegation);
      return {
        v: 1,
        ts: parsed.ts,
        ...(delegation ? { delegation } : {}),
      };
    }
  } catch {
    /* missing or torn write: no marker → boot stays env-driven */
  }
  return null;
}

/** Idempotent; best-effort — a failed write only loses delegation replay on /resume. */
export function writeWorkerMarker(sessionFile: string | null | undefined, delegation?: DelegationContext): void {
  const file = workerMarkerPath(sessionFile);
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({
      v: 1,
      ts: Date.now(),
      ...(delegation ? { delegation } : {}),
    })}\n`);
  } catch {
    /* read-only checkout or full disk: the live session is unaffected */
  }
}
