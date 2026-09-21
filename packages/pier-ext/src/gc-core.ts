/**
 * Task-tab GC decisions (D29 rules as a pure function; M22 dropped resident exemption).
 * No I/O, no pi/herdr — unit-testable.
 */
export type GcEntryKind = string;
export type GcEntryStatus = 'running' | 'settled' | 'consumed' | 'closed';

export interface GcEntryLike {
  /** 'task' or a role name; legacy short/resident is a label only. */
  kind: GcEntryKind;
  status: GcEntryStatus;
  /** Consume timestamp (GC grace); closed rows keep the original value. */
  consumedAt?: number | null;
}

function isFinished(status: GcEntryStatus): boolean {
  return status === 'consumed' || status === 'closed' || status === 'settled';
}

/**
 * Close a task tab only when every condition holds:
 *  - ≥1 work pane (the main tab with no delegated entries never closes);
 *  - every work pane is settled/consumed/closed (kind is not an exemption);
 *  - grace TTL elapsed (`ttlMs=0` means never auto-close);
 *  - no blocked pane (human-gate exemption);
 *  - remaining panes are idle/done/unknown (non-work panes may be unknown).
 */
export function shouldCloseTaskTab(opts: {
  entries: readonly GcEntryLike[];
  paneStatuses: readonly string[];
  ttlMs: number;
  now: number;
}): boolean {
  if (opts.entries.length === 0) return false;
  if (!opts.entries.every((e) => isFinished(e.status))) return false;
  if (!opts.entries.every((e) => (e.consumedAt ?? 0) > 0 && (e.consumedAt ?? 0) < opts.now - opts.ttlMs)) return false;
  if (opts.paneStatuses.some((s) => s === 'blocked')) return false;
  if (!opts.paneStatuses.every((s) => s === 'idle' || s === 'done' || s === 'unknown')) return false;
  return true;
}

/**
 * Pane-level collection (orphan / compat path):
 *  - consumed before the previous turn (grace so the settlement notice is still visible);
 *  - herdr status idle/done (unknown/working/blocked retry next turn);
 *  - missing pane (status undefined) → record closed (caller handles the write).
 */
export function shouldClosePane(opts: {
  consumedAt: number | null;
  herdrStatus: string | undefined;
  prevTurnStart: number;
}): boolean {
  if (opts.herdrStatus === undefined) return true; // pane gone → record closed
  if (opts.herdrStatus !== 'idle' && opts.herdrStatus !== 'done') return false;
  return (opts.consumedAt ?? 0) > 0 && opts.consumedAt! < opts.prevTurnStart;
}

/* ── Isolate worktree collection (why the rules are this narrow) ──────
 * `refs/heads/pier/*` is NOT proof of pier ownership: a worker session lives in such a
 * worktree, its branch is trivially an ancestor of its own HEAD and clean once it commits,
 * so a namespace-wide sweep deletes the worktree its own process is running in.
 * Only branches registered in THIS session's registry are candidates, cwd is never a
 * candidate, and untracked `pier/*` branches need an explicit opt-in.
 */

/** True when `path` is `parent` or lives inside it (both resolved, no I/O). */
export function isPathInside(path: string, parent: string): boolean {
  const norm = (p: string): string => p.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
  const child = norm(path);
  const base = norm(parent);
  if (!child || !base) return false;
  return child === base || child.startsWith(`${base}/`);
}

export interface IsolateSweepCandidate {
  branch: string;
  worktreePath: string;
}

export interface IsolateSweepSkip {
  branch: string;
  reason: 'unregistered' | 'pending' | 'self' | 'no-worktree';
}

export interface IsolateSweepPlan {
  candidates: IsolateSweepCandidate[];
  skipped: IsolateSweepSkip[];
}

/**
 * Decide which isolate worktrees this session may collect.
 * Pure: callers pass git output, the subagent registry and the process cwd.
 */
export function planIsolateSweep(input: {
  /** Every `refs/heads/pier/*` branch name. */
  branches: readonly string[];
  /** branch → worktree path, from `git worktree list --porcelain`. */
  worktreesByBranch: ReadonlyMap<string, string>;
  /** Branches of isolate entries in this session's registry. */
  registeredBranches: ReadonlySet<string>;
  /** Branches created but not yet registered (worktree add → subs.set window). */
  pendingBranches: ReadonlySet<string>;
  /** Session-owned isolates that may be collected, with their recorded path. */
  sessionOwned: ReadonlyArray<{ branch: string; worktreePath: string }>;
  /** Path to protect (normally process.cwd()). */
  cwd: string;
  /** Explicit opt-in for branches this session never registered. */
  sweepOrphans: boolean;
}): IsolateSweepPlan {
  const candidates = new Map<string, IsolateSweepCandidate>();
  const skipped: IsolateSweepSkip[] = [];
  const add = (branch: string, worktreePath: string): void => {
    if (isPathInside(input.cwd, worktreePath)) {
      skipped.push({ branch, reason: 'self' });
      return;
    }
    candidates.set(branch, { branch, worktreePath });
  };

  if (input.sweepOrphans) {
    for (const branch of input.branches) {
      if (input.registeredBranches.has(branch)) continue;
      if (input.pendingBranches.has(branch)) {
        skipped.push({ branch, reason: 'pending' });
        continue;
      }
      const wtPath = input.worktreesByBranch.get(branch);
      if (wtPath) add(branch, wtPath);
    }
  }

  for (const entry of input.sessionOwned) {
    const wtPath = input.worktreesByBranch.get(entry.branch) ?? entry.worktreePath;
    add(entry.branch, wtPath);
  }

  return { candidates: [...candidates.values()], skipped };
}
