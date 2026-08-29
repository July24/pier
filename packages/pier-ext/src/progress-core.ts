/**
 * M16 pure core for progress visibility (development plan §M16; prioritize conservative output, with no new D3 protocol).
 *
 * Channels in the post-M22 world:
 *  - Progress badge (N/M plus optional ETA) is embedded in the pane title (state_labels has only five keys, so it cannot fit there);
 *  - Tool badge (🔧 tool) is sent through report_agent.message;
 *  - Rate estimates follow kimi estimator semantics: rate window, unfinished cap, and confidence gate.
 *
 * Conservative principle (risk ⑥ decision): when an estimate is not trustworthy, fall back to plain `N/M` and
 * never display a misleading ETA.
 */

import { countTodos, type TodoItem } from './vocab.ts';

/** Minimum completed points needed for an ETA (<2 cannot establish a rate). */
export const ETA_MIN_SAMPLES = 2;
/** Rate sample window (kimi rate-window semantics; use the most recent K completion points). */
export const RATE_WINDOW_MS = 45_000;
/** Cap for displayed unfinished progress (kimi unfinished-cap semantics; prevent a false "almost done" impression). */
export const UNFINISHED_CAP = 0.85;
/** Completion freshness gate: if the most recent completion is older than this, data is stale and no ETA is estimated. */
export const PROGRESS_STALE_MS = 5 * 60_000;
/** Number of recent completion points used for rate fitting. */
const RATE_SAMPLE_POINTS = 5;

export interface EtaEstimate {
  /** Remaining steps. */
  remaining: number;
  /** Estimated remaining time (milliseconds). */
  etaMs: number;
  confidence: 'ok';
}

/**
 * Estimate ETA from completion timestamps and remaining steps.
 *  - Fewer than 2 completion points → null (no rate can be inferred);
 *  - Most recent completion older than PROGRESS_STALE_MS → null (stale after a burst followed by a pause or manual hold);
 *  - Rate = use the latest K(≤5) points, (k-1) / (t_k - t_1); eta = remaining / rate.
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
  const ratePerMs = steps / span;
  return { remaining, etaMs: Math.round(remaining / ratePerMs), confidence: 'ok' };
}

/** Title progress suffix: conservative `3/7`; trusted ETA gives `3/7 ~4m`; total=0 → empty; all complete → `5/5 ✓`. */
export function formatProgressSuffix(opts: {
  completed: number;
  total: number;
  eta: EtaEstimate | null;
}): string {
  const { completed, total, eta } = opts;
  if (total <= 0) return '';
  const base = completed >= total ? `${completed}/${total} ✓` : `${completed}/${total}`;
  if (!eta || eta.etaMs <= 0) return base;
  const human = eta.etaMs < 60_000 ? '<1m'
    : (() => {
      const mins = Math.ceil(eta.etaMs / 60_000);
      return mins < 60 ? `~${mins}m` : `~${Math.round((mins / 60) * 10) / 10}h`;
    })();
  return `${base} ${human}`;
}

/** Tool badge (report_agent.message): one tool name; multiple use the first plus a count; empty → null (do not overwrite). */
export function planToolBadge(runningToolNames: readonly string[]): string | null {
  if (runningToolNames.length === 0) return null;
  const first = runningToolNames[0];
  return runningToolNames.length === 1 ? `🔧 ${first}` : `🔧 ${first} +${runningToolNames.length - 1}`;
}

/** Derive progress input from a list (completed count / total open-work count). */
export function progressOf(items: readonly TodoItem[]): { completed: number; total: number } {
  const c = countTodos(items);
  const blockedCount = items.filter((it) => it.status === 'blocked').length;
  return { completed: c.completed, total: c.completed + c.pending + c.inProgress + blockedCount };
}

/** Hide the progress badge after it has been marked for the full lifecycle (avoid persistent completed-state noise; callers compare this). */
export const PROGRESS_HIDE_MS = 60_000;

/**
 * Count completed transitions between two lists (match by content; an item completed in the new list whose old status
 * was not completed, including items newly added as completed). M16 ETA estimation uses this as input: every edit path
 * (todo_write / human edit / M17 reconciliation) passes through TodosService, so the diff is centralized here.
 */
export function countCompletedTransitions(
  before: readonly TodoItem[],
  after: readonly TodoItem[],
): number {
  const oldStatus = new Map(before.map((it) => [it.content, it.status]));
  let n = 0;
  for (const it of after) {
    if (it.status === 'completed' && oldStatus.get(it.content) !== 'completed') n += 1;
  }
  return n;
}
