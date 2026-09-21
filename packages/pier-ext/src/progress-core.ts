/**
 * M16 progress visibility: conservative output only, no new D3 protocol. The progress badge
 * (N/M plus optional ETA) rides in the pane title, the tool badge (🔧 tool) goes through
 * report_agent.message, and an untrustworthy estimate falls back to plain `N/M` — never a
 * misleading ETA.
 */

import { countTodos, type TodoItem } from './vocab.ts';

/** Minimum completed points needed for an ETA (<2 cannot establish a rate). */
export const ETA_MIN_SAMPLES = 2;
/** An older latest completion means the data is stale and no ETA is estimated. */
export const PROGRESS_STALE_MS = 5 * 60_000;
const RATE_SAMPLE_POINTS = 5;

export interface EtaEstimate {
  remaining: number;
  etaMs: number;
  confidence: 'ok';
}

/**
 * Fewer than 2 points, or a stale latest point, → null.
 * Rate = latest K(≤5) points, (k-1) / (t_k - t_1); eta = remaining / rate.
 */
export function estimateEta(opts: {
  completedAt: readonly number[];
  total: number;
  now: number;
}): EtaEstimate | null {
  const { completedAt, total, now } = opts;
  if (total <= 0) return null;
  const pts = [...completedAt].filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
  const completed = pts.length;
  if (completed < ETA_MIN_SAMPLES) return null;
  if (now - pts[pts.length - 1] > PROGRESS_STALE_MS) return null;
  const remaining = total - completed;
  if (remaining <= 0) return { remaining: 0, etaMs: 0, confidence: 'ok' };
  const sample = pts.slice(-RATE_SAMPLE_POINTS);
  const span = sample[sample.length - 1] - sample[0];
  const steps = sample.length - 1;
  if (steps < 1 || span <= 0) return null;
  return { remaining, etaMs: Math.round(remaining / (steps / span)), confidence: 'ok' };
}

/** Title suffix: `3/7`; trusted ETA gives `3/7 ~4m`; total=0 → empty; all complete → `5/5 ✓`. */
export function formatProgressSuffix(opts: {
  completed: number;
  total: number;
  eta: EtaEstimate | null;
}): string {
  const { completed, total, eta } = opts;
  if (total <= 0) return '';
  const base = completed >= total ? `${completed}/${total} ✓` : `${completed}/${total}`;
  if (!eta || eta.etaMs <= 0) return base;
  const human = eta.etaMs < 60_000 ? '<1m' : (() => {
    const mins = Math.ceil(eta.etaMs / 60_000);
    return mins < 60 ? `~${mins}m` : `~${Math.round((mins / 60) * 10) / 10}h`;
  })();
  return `${base} ${human}`;
}

/** Tool badge for report_agent.message: one name, or the first plus a count; empty → null (do not overwrite). */
export function planToolBadge(runningToolNames: readonly string[]): string | null {
  if (runningToolNames.length === 0) return null;
  const first = runningToolNames[0];
  return runningToolNames.length === 1 ? `🔧 ${first}` : `🔧 ${first} +${runningToolNames.length - 1}`;
}

/** Completed count over all tracked work (abandoned excluded). */
export function progressOf(items: readonly TodoItem[]): { completed: number; total: number } {
  const c = countTodos(items);
  return { completed: c.completed, total: c.completed + c.pending + c.inProgress + c.blocked };
}
