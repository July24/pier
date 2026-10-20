/**
 * Worker identity marker: a herdr 0.9.2 server restart reopens a worker pane by running pier's
 * self-reported resume_argv — WITHOUT the spawn env (`PI_HERDR_SUBAGENT`, role manifest env). The
 * marker file lets the restored boot re-derive worker mode from the session itself, so it mounts
 * todo-only instead of the master composition (no subagent pipe, no stop reminders) and replays its
 * role from the transcript as usual. Masters never write a marker; a stale marker for a dead session
 * is inert (it is only consulted when pi boots with that exact session file).
 */
import type { DelegationContext } from './delegation-core.ts';
import { delegationFromRecord } from './delegation-core.ts';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { bareSessionId } from './session-tail.ts';
import { isValidSessionId } from './efficiency-store.ts';

export interface WorkerMarker {
  readonly v: 1;
  readonly ts: number;
  readonly role?: string;
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
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { v?: unknown; ts?: unknown; role?: unknown; delegation?: unknown };
    if (parsed && parsed.v === 1 && typeof parsed.ts === 'number') {
      const delegation = delegationFromRecord(parsed.delegation);
      return {
        v: 1,
        ts: parsed.ts,
        ...(typeof parsed.role === 'string' ? { role: parsed.role } : {}),
        ...(delegation ? { delegation } : {}),
      };
    }
  } catch {
    /* missing or torn write: no marker → boot stays env-driven */
  }
  return null;
}

/** Idempotent; best-effort — a failed write only loses server-restart worker detection. */
export function writeWorkerMarker(
  sessionFile: string | null | undefined,
  role?: string,
  delegation?: DelegationContext,
): void {
  const file = workerMarkerPath(sessionFile);
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({
      v: 1,
      ts: Date.now(),
      ...(role ? { role } : {}),
      ...(delegation ? { delegation } : {}),
    })}\n`);
  } catch {
    /* read-only checkout or full disk: the live session is unaffected */
  }
}

/** Boot-time probe over env.PI_SESSION_FILE; false negatives simply keep today's behavior. */
export function hasWorkerMarker(sessionFile: string | null | undefined): boolean {
  const file = workerMarkerPath(sessionFile);
  return file !== null && existsSync(file);
}
