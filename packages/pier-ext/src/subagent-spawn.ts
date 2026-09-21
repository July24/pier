/**
 * Subagent spawn domain: git/worktree I/O, task-tab pane placement, launch line, readiness wait,
 * and the `spawn` action (isolate creation, prompt injection, foreground wait).
 *
 * Placement is serialized by a mutex (concurrent spawns raced on tab lookup) and readiness
 * failures explain themselves instead of collapsing into a bare timeout.
 */
import { execFile as nodeExecFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, stat as statCb } from 'node:fs';
import { basename, dirname, join, resolve as pathResolve } from 'node:path';
import { promisify } from 'node:util';
import type { HerdrClientLike } from './herdr-client.ts';
import { pipeNameCandidates, pipeNameFor, pipeRequest, pipeRequestTo } from './pipe-channel.ts';
import { composeForRole } from './manifest-compose.ts';
import { platformPaths } from './platform-paths.ts';
import { planSpawnProfileRow, type RoutingTelemetryRecord } from './routing-telemetry.ts';
import { runtimePolicy } from './runtime-policy.ts';
import { toolError } from './tool-error.ts';
import type { HistoryEntry } from './history-store.ts';
import {
  FOREGROUND_POLL_MS,
  Semaphore,
  buildAliveNotice,
  buildBlockedGateNotice,
  buildIsolatePreamble,
  buildLaunchLine,
  buildLaunchParts,
  classifyWorktreeZone,
  formatSubagentResult,
  formatWorktreeStat,
  isAlive,
  isPathUnder,
  makeProgressUpdate,
  planForegroundTick,
  planIsolateWorktree,
  planLaunchValidation,
  planTabPlacement,
  type SubEntry,
  type TabPlacementPlan,
  type WorktreeZone,
} from './subagent-core.ts';
import { parseShapeTree, pickGridSplit, type PaneCell } from './plugins/grid-shape.ts';
import { fromShapeTree, planSpawnSplitRatio, type LayoutNode } from './plugins/heat-plan.ts';
import type { Poller } from './subagent-poller.ts';
import type { SessionIo } from './subagent-session.ts';

const statAsync = promisify(statCb);

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/* ── git adapter ────────────────────────────────────────────────── */

export interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitError extends Error {
  readonly code?: string | number;
  readonly stdout?: string;
  readonly stderr?: string;
}

/** Injectable execFile (tests drive git without a real process). */
export type GitExecFile = (
  file: string,
  args: readonly string[],
  options: { timeout: number; encoding: 'utf8'; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string }>;

/**
 * Output ceiling for one git call. execFile defaults to 1MB, which a large checkout exceeds
 * (`status --porcelain` with tens of thousands of untracked files): the call then fails with
 * ENOBUFS, callers normalize it to null, and the user sees a silently missing stat line.
 */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

export interface GitAdapter {
  listWorktrees(cwd: string): Promise<GitResult>;
  status(cwd: string): Promise<GitResult>;
  /** Throws a GitError on failure/timeout; callers wanting "null on error" catch at the call site. */
  run(cwd: string, args: readonly string[]): Promise<GitResult>;
}

const execFile = promisify(nodeExecFile);

export class NodeGitAdapter implements GitAdapter {
  private readonly gitExecutable: string;
  private readonly timeoutMs: number;
  private readonly exec: GitExecFile;

  constructor(
    gitExecutable: string = 'git',
    timeoutMs: number = runtimePolicy.gitTimeoutMs,
    exec: GitExecFile = execFile as unknown as GitExecFile,
  ) {
    this.gitExecutable = gitExecutable;
    this.timeoutMs = timeoutMs;
    this.exec = exec;
  }

  listWorktrees(cwd: string): Promise<GitResult> {
    return this.run(cwd, ['worktree', 'list', '--porcelain']);
  }

  status(cwd: string): Promise<GitResult> {
    return this.run(cwd, ['status', '--short']);
  }

  async run(cwd: string, args: readonly string[]): Promise<GitResult> {
    try {
      const { stdout, stderr } = await this.exec(
        this.gitExecutable,
        ['-C', cwd, ...args],
        { timeout: this.timeoutMs, encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER },
      );
      return { stdout, stderr };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw Object.assign(err instanceof Error ? err : new Error(), {
        message: `Git ${args[0] ?? 'command'} failed: ${message}`,
      }) as GitError;
    }
  }
}

export const defaultGitAdapter = new NodeGitAdapter();

/* ── git I/O used by spawn, isolate, GC and settlement stat lines ── */

const WORKTREES_CACHE_MS = 5000;

export interface GitIo {
  listWorktrees(cwd: string): Promise<string[]>;
  runGit(cwd: string, args: string[]): Promise<string | null>;
  worktreeStatLine(entry: SubEntry): Promise<string | null>;
  invalidateWorktreesCache(): void;
}

export function createGitIo(git: GitAdapter = defaultGitAdapter): GitIo {
  let worktreesCache: { at: number; list: string[] } | null = null;

  async function listWorktrees(cwd: string): Promise<string[]> {
    if (worktreesCache && Date.now() - worktreesCache.at < WORKTREES_CACHE_MS) return worktreesCache.list;
    let list: string[] = [];
    try {
      const { stdout } = await git.listWorktrees(cwd);
      for (const line of String(stdout).split('\n')) {
        const m = /^worktree (.+)$/.exec(line.trim());
        if (m) list.push(m[1]!);
      }
    } catch {
      list = [];
    }
    worktreesCache = { at: Date.now(), list };
    return list;
  }

  async function runGit(cwd: string, args: string[]): Promise<string | null> {
    try {
      const { stdout } = await git.run(cwd, args);
      return stdout == null ? null : String(stdout);
    } catch {
      return null;
    }
  }

  function lastStatLine(out: string | null): string | null {
    if (!out) return null;
    const lines = out.replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
    return lines.length ? lines[lines.length - 1]! : null;
  }

  async function worktreeStatLine(entry: SubEntry): Promise<string | null> {
    const porcelain = await runGit(entry.cwd, ['status', '--porcelain']);
    if (porcelain === null) return null;
    const dirtyCount = porcelain.split('\n').filter((l) => l.trim() !== '').length;
    if (entry.isolate) {
      const statOut = await runGit(entry.cwd, ['diff', '--stat', `${entry.isolate.baseSha}...HEAD`]);
      const commitsOut = await runGit(entry.cwd, ['rev-list', '--count', `${entry.isolate.baseSha}..HEAD`]);
      const commits = commitsOut != null && /^\d+$/.test(commitsOut.trim()) ? Number(commitsOut.trim()) : null;
      return formatWorktreeStat({ branch: entry.isolate.branch, commits, statLine: lastStatLine(statOut), dirtyCount });
    }
    return formatWorktreeStat({
      branch: null,
      commits: null,
      statLine: lastStatLine(await runGit(entry.cwd, ['diff', '--stat', 'HEAD'])),
      dirtyCount,
    });
  }

  return {
    listWorktrees,
    runGit,
    worktreeStatLine,
    invalidateWorktreesCache: () => { worktreesCache = null; },
  };
}

/* ── readiness wait (pure planners) ─────────────────────────────── */

const READY_BASE_INTERVAL_MS = 500;
const READY_MAX_INTERVAL_MS = 4000;
/** Liveness/agent sampling is far more expensive than a ping, so it runs on its own cadence. */
const READY_LIVENESS_SAMPLE_MS = 2500;
/** Enough of the pane tail to carry a stack trace head into the failure text. */
const READY_TAIL_CHARS = 1200;

export interface ReadyFailure {
  readonly paneId: string;
  readonly reason: 'pane-gone' | 'timeout';
  readonly elapsedMs: number;
  readonly timeoutMs: number;
  /** Some agent states the wait observed (working/idle/…), for the "agent never reported" case. */
  readonly lastStatus?: string | null;
  readonly tail?: string | null;
  readonly hint?: string | null;
}

type ReadyAttemptPlan =
  | { readonly kind: 'ready' }
  | { readonly kind: 'retry'; readonly delayMs: number }
  | { readonly kind: 'give-up'; readonly reason: 'pane-gone' | 'timeout' };

/**
 * Decide one readiness attempt. `alive` is tri-state on purpose: an unavailable liveness probe
 * (`null`) must not be read as death, or a slow herdr socket fails spawns that are merely slow.
 */
export function planReadyAttempt(opts: {
  elapsedMs: number;
  attempt: number;
  timeoutMs: number;
  alive: boolean | null;
  ready: boolean;
}): ReadyAttemptPlan {
  if (opts.ready) return { kind: 'ready' };
  if (opts.alive === false) return { kind: 'give-up', reason: 'pane-gone' };
  if (opts.elapsedMs >= opts.timeoutMs) return { kind: 'give-up', reason: 'timeout' };
  return { kind: 'retry', delayMs: readyBackoffMs(opts.attempt) };
}

/** Exponential backoff with a cap: 500ms, 1s, 2s, 4s, 4s, … */
export function readyBackoffMs(attempt: number, baseMs = READY_BASE_INTERVAL_MS, capMs = READY_MAX_INTERVAL_MS): number {
  const n = Math.max(0, Math.floor(attempt));
  return Math.min(capMs, baseMs * 2 ** n);
}

/**
 * Failure text for the model. Three cases must stay distinguishable: the pane died (usually a
 * crash — the tail carries the reason), the pane is alive but never opened its pipe (extension
 * failed to load / wrong pane env), and the pane is alive and working, just slower than timeout.
 */
export function readyFailureText(failure: ReadyFailure): string {
  const seconds = Math.round(failure.elapsedMs / 1000);
  const head = failure.reason === 'pane-gone'
    ? `subagent pane ${failure.paneId} exited before its pipe became ready (waited ${seconds}s)`
    : `subagent pane ${failure.paneId} pipe not ready within ${seconds}s (limit ${Math.round(failure.timeoutMs / 1000)}s)`;
  const why = failure.reason === 'pane-gone'
    ? 'The child process is gone — its last output below usually carries the reason.'
    : failure.lastStatus === 'working'
      ? 'The pane is alive and working, so the prompt may simply be slow to boot; retrying the same call is safe.'
      : 'The pane is alive but never registered its pipe — the child pi process may still be starting, or it failed to load the pier extension.';
  const tail = failure.tail ? `\nlast output of ${failure.paneId}:\n${failure.tail}` : '';
  const hint = failure.hint ? `\n${failure.hint}` : '';
  return `${head}\n${why}${hint}${tail}`;
}

/* ── spawner ────────────────────────────────────────────────────── */

export interface SpawnEnv {
  paneId: string;
  tabId: string;
  workspaceId: string;
}

interface SpawnerHost {
  client: HerdrClientLike;
  env: SpawnEnv | null;
  runtime: { nodePath: string; cliPath: string; extPath: string };
  git: GitIo;
  /** Test override. Production reads `runtimePolicy.readinessTimeoutMs`. */
  readinessTimeoutMs?: number;
}

export type ReadyOutcome = { ok: true } | { ok: false; message: string };

export interface Spawner {
  spawnPaneInTaskTab(
    placement: { desiredTab?: string | null; description: string; zone?: WorktreeZone },
    cwd: string,
    envOver: Record<string, string>,
    launch: string,
  ): Promise<{ tabId: string; paneId: string; tabName: string }>;
  launchLine(resumeFile?: string | null, roleModel?: string | null, approve?: boolean): string;
  approveFor(cwd: string, masterCwd: string): Promise<boolean>;
  waitSubReady(cwd: string, paneId: string): Promise<ReadyOutcome>;
  findExistingPane(sessionFile: string | null): Promise<{ paneId: string; tabId: string } | null>;
}

export function createSpawner(h: SpawnerHost): Spawner {
  const tabMutex = new Semaphore(1);
  const readyTimeoutMs = h.readinessTimeoutMs ?? runtimePolicy.readinessTimeoutMs;

  async function liveTabs(): Promise<Array<{ tabName: string; tabId: string }>> {
    try {
      const ws = h.env?.workspaceId ?? '';
      return (await h.client.tabList())
        .filter((t) => !ws || t.workspaceId === ws)
        .map((t) => ({ tabName: t.label, tabId: t.tabId }));
    } catch {
      return [];
    }
  }

  function launchLine(resumeFile?: string | null, roleModel?: string | null, approve = false): string {
    return buildLaunchLine(buildLaunchParts(h.runtime, { resumeFile, roleModel, approve }));
  }

  async function approveFor(cwd: string, masterCwd: string): Promise<boolean> {
    if (isPathUnder(cwd, masterCwd)) return true;
    const zone = classifyWorktreeZone({ cwd, masterCwd, worktrees: await h.git.listWorktrees(masterCwd) });
    return zone.zone === 'worktree';
  }

  /** Wait for the child's pipe with backoff; give up early when the pane is gone. The screen tail
   * is sampled while the pane exists so a crash that leaves a shell still explains itself. */
  async function waitSubReady(cwd: string, paneId: string): Promise<ReadyOutcome> {
    const names = pipeNameCandidates(cwd, paneId);
    const startedAt = Date.now();
    let attempt = 0;
    let lastProbeAt = 0;
    let alive: boolean | null = null;
    let lastStatus: string | null = null;
    let tail: string | null = null;

    while (true) {
      const now = Date.now();
      const elapsedMs = now - startedAt;
      if (now - lastProbeAt >= READY_LIVENESS_SAMPLE_MS || attempt === 0) {
        lastProbeAt = now;
        const probe = await probeChildPane(paneId);
        alive = probe.alive;
        lastStatus = probe.status;
        if (probe.tail) tail = probe.tail;
      }
      const pinged = await pingAnyName(names);
      const plan = planReadyAttempt({ elapsedMs, attempt, timeoutMs: readyTimeoutMs, alive, ready: pinged });
      if (plan.kind === 'ready') return { ok: true };
      if (plan.kind === 'give-up') {
        let explainHint: string | null = null;
        if (h.client.available) {
          try {
            const diag = await h.client.agentExplain(paneId);
            if (diag && typeof diag === 'object') {
              const explainObj = ((diag.explain ?? diag) as Record<string, unknown>);
              const parts: string[] = [];
              if (explainObj.skip_state_reason) parts.push(`skip reason: ${String(explainObj.skip_state_reason)}`);
              if (explainObj.screen_detection_skip_reason) parts.push(`screen rule bypassed: ${String(explainObj.screen_detection_skip_reason)}`);
              if (explainObj.matched_rule) parts.push(`matched rule: ${String(explainObj.matched_rule)}`);
              if (explainObj.idle_fallback_reason) parts.push(`idle fallback: ${String(explainObj.idle_fallback_reason)}`);
              if (parts.length > 0) explainHint = `Herdr detection diagnosis: ${parts.join('; ')}`;
            }
          } catch {
            /* diagnostics never mask the root error */
          }
        }
        const defaultHint = plan.reason === 'timeout' && lastStatus === 'working'
          ? 'Tip: pass run_in_background to avoid blocking the master turn while the worker boots.'
          : null;
        const hint = [explainHint, defaultHint].filter(Boolean).join('\n') || null;
        const failure: ReadyFailure = {
          paneId,
          reason: plan.reason,
          elapsedMs: Math.max(elapsedMs, 1),
          timeoutMs: readyTimeoutMs,
          lastStatus,
          tail,
          hint,
        };
        return { ok: false, message: readyFailureText(failure) };
      }
      attempt += 1;
      await sleep(plan.delayMs);
    }
  }

  /** One ping round over every candidate pipe name (mixed-version peers register different names). */
  async function pingAnyName(names: readonly string[]): Promise<boolean> {
    for (const name of names) {
      try {
        const res = await pipeRequest(name, { type: 'ping', id: `ping-${Date.now()}` }, 3000);
        if (res.type === 'ok') return true;
      } catch { /* not ready on this name */ }
    }
    return false;
  }

  /** Pane liveness + last visible output; socket failures degrade to "unknown", never "dead". */
  async function probeChildPane(paneId: string): Promise<{ alive: boolean | null; status: string | null; tail: string | null }> {
    let alive: boolean | null = null;
    let status: string | null = null;
    try {
      // pane.list includes unknown shells; agent.list does not. A fresh split is absent from
      // agent.list until pi is identified — that is boot, not death.
      const pane = (await h.client.listPanes()).find((p) => p.paneId === paneId);
      alive = pane != null;
      status = pane?.agentStatus ?? null;
    } catch {
      /* keep null: an unreachable socket must not be read as a dead child */
    }
    let tail: string | null = null;
    try {
      const read = await h.client.readPane(paneId, { stripAnsi: true });
      if (read.text) tail = read.text.slice(-READY_TAIL_CHARS);
    } catch {
      /* recycled pane or socket blip — caller keeps the last cached tail */
    }
    return { alive, status, tail };
  }

  async function spawnPaneInTaskTab(
    placement: { desiredTab?: string | null; description: string; zone?: WorktreeZone },
    cwd: string,
    envOver: Record<string, string>,
    launch: string,
  ): Promise<{ tabId: string; paneId: string; tabName: string }> {
    const release = await tabMutex.acquire();
    try {
      const allPanes = await h.client.listPanes();
      const mainTabId = allPanes.find((p) => p.paneId === h.env?.paneId)?.tabId ?? (h.env?.tabId ? h.env.tabId : null);
      let plan: TabPlacementPlan = planTabPlacement({
        desiredTab: placement.desiredTab,
        description: placement.description,
        knownTabs: await liveTabs(),
        zone: placement.zone,
        mainTabId,
      });
      if (plan.mode === 'append' && plan.tabId) {
        const exclude = new Set(
          allPanes.filter((p) => p.tabId === plan.tabId && p.agentStatus === 'unknown').map((p) => p.paneId),
        );
        let pick: { targetPaneId: string; direction: 'right' | 'down' } | null = null;
        let heatRoot: LayoutNode | null = null;
        let focusPaneId: string | null = null;
        let zoomed = false;
        try {
          const snapshot = await h.client.exportLayout({ tabId: plan.tabId });
          const tree = snapshot?.root ? parseShapeTree(snapshot.root) : null;
          if (tree) {
            heatRoot = fromShapeTree(tree);
            focusPaneId = snapshot?.focusedPaneId ?? null;
            zoomed = snapshot?.zoomed === true;
            let cells: PaneCell[] | undefined;
            try {
              const live = await h.client.paneLayout({ paneId: allPanes.find((p) => p.tabId === plan.tabId)?.paneId });
              if (live?.panes.length) {
                cells = live.panes.map((p) => ({ id: p.paneId, x: p.x, y: p.y, w: p.w, h: p.h }));
              }
            } catch { /* pane.layout missing → 200×50 model */ }
            pick = pickGridSplit(tree, { exclude, cells });
          }
        } catch { /* layout export failure → legacy anchor split */ }
        const anchorPaneId = pick?.targetPaneId
          ?? allPanes.find((p) => p.tabId === plan.tabId && p.agentStatus !== 'unknown')?.paneId
          ?? allPanes.find((p) => p.tabId === plan.tabId)?.paneId;
        if (anchorPaneId) {
          const direction = pick?.direction ?? 'down';
          const statuses: Record<string, string> = {};
          for (const p of allPanes) {
            if (p.tabId === plan.tabId) statuses[p.paneId] = p.agentStatus;
          }
          const ratio = heatRoot && !zoomed
            ? planSpawnSplitRatio({
              root: heatRoot,
              targetPaneId: anchorPaneId,
              focusPaneId: focusPaneId ?? anchorPaneId,
              direction,
              statuses,
            })
            : null;
          const paneId = await h.client.splitPane({
            direction,
            cwd,
            env: envOver,
            targetPaneId: anchorPaneId,
            focus: false,
            ...(ratio != null ? { ratio } : {}),
          });
          await h.client.sendPaneText(paneId, launch);
          return { tabId: plan.tabId, paneId, tabName: plan.tabName };
        }
        plan = { mode: 'new', tabName: plan.tabName, tabId: null };
      }
      const created = await h.client.createTab({
        workspaceId: h.env?.workspaceId ?? '',
        label: plan.tabName,
        cwd,
        env: envOver,
      });
      await h.client.sendPaneText(created.paneId, launch);
      return { tabId: created.tabId, paneId: created.paneId, tabName: plan.tabName };
    } finally {
      release();
    }
  }

  /** D94: reuse a pane that already runs the same session instead of competing on one transcript. */
  async function findExistingPane(sessionFile: string | null): Promise<{ paneId: string; tabId: string } | null> {
    if (!sessionFile) return null;
    try {
      const agents = await h.client.listAgents();
      const match = agents.find((a) => a.session === sessionFile && a.status !== 'unknown');
      if (!match) return null;
      const pane = (await h.client.listPanes()).find((p) => p.paneId === match.paneId);
      return pane ? { paneId: match.paneId, tabId: pane.tabId } : null;
    } catch {
      return null;
    }
  }

  return { spawnPaneInTaskTab, launchLine, approveFor, waitSubReady, findExistingPane };
}

/* ── spawn action ───────────────────────────────────────────────── */

export interface SpawnActionHost {
  client: HerdrClientLike;
  env: SpawnEnv | null;
  subSemaphore: Semaphore;
  subs: Map<string, SubEntry>;
  persistSubs(): void;
  writeHistory(entry: SubEntry, patch?: Partial<HistoryEntry>, via?: string): void;
  pendingIsolateBranches: Set<string>;
  lastMachineInjectAt: Map<string, number>;
  lastRequestIdByPane: Map<string, string>;
  git: GitIo;
  session: SessionIo;
  spawn: Spawner;
  poller: Poller;
  /** Phase 0 routing telemetry (RFC rfc-jev-role-routing §8): best-effort spawn profile; absent in tests. */
  logRouting?: (row: RoutingTelemetryRecord) => void;
}

export function createSpawnAction(h: SpawnActionHost) {
  const { client, env, git, subs } = h;
  const { resolveSessionFile, collectFinalText, readAskFlag, probeAlive, subSessionState } = h.session;
  const { spawnPaneInTaskTab, launchLine, waitSubReady } = h.spawn;
  const { startPoller } = h.poller;

  return async function executeSubagentSpawn(
    params: Record<string, unknown> | undefined,
    toolCtx: unknown,
    onUpdate?: (update: unknown) => void,
  ): Promise<unknown> {
    const launch = planLaunchValidation(params, client.available);
    if (launch.kind === 'error') return toolError(launch.text);
    const { spec, background, isolate, cwdParam, roleKind: kind, suggested, manifestRole, tab } = launch;
    const masterCwd = (toolCtx as { cwd?: string })?.cwd ?? process.cwd();
    const taskId = randomUUID();
    // D98: create the isolate through pier's execFile git path, not herdr's socket worktree.create
    // (bootstrap races, missing root-pane env, linked_worktree_source rejection).
    let isolateMeta: SubEntry['isolate'] | null = null;
    let cwd = masterCwd;
    if (isolate) {
      const baseSha = await git.runGit(masterCwd, ['rev-parse', 'HEAD']);
      if (baseSha == null) return toolError('Error: isolate requires a git repository with at least one commit');
      const sha = baseSha.trim();
      const pierBranches = new Set(
        ((await git.runGit(masterCwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/pier/'])) ?? '')
          .split('\n').filter(Boolean),
      );
      const repoName = basename((await git.listWorktrees(masterCwd))[0] ?? masterCwd);
      const plan = planIsolateWorktree({
        description: spec.description,
        taskHex: taskId.slice(0, 6),
        existingPierBranches: pierBranches,
      });
      const wtPath = join(platformPaths.worktreeBaseDir, repoName, plan.worktreeDirName);
      try {
        // git worktree add does not create its parent directory, so a first run would fail.
        mkdirSync(dirname(wtPath), { recursive: true });
      } catch { /* existing directory or permissions failure is handled by worktree add */ }
      // Keep the branch pending between worktree add and subs.set: the readiness wait lets the
      // ticker scan, which could otherwise reclaim a new clean =HEAD-ancestor worktree as an orphan.
      h.pendingIsolateBranches.add(plan.branch);
      const added = await git.runGit(masterCwd, ['worktree', 'add', '-b', plan.branch, wtPath, sha]);
      if (added === null) {
        h.pendingIsolateBranches.delete(plan.branch);
        return toolError(`Error: failed to create worktree ${wtPath} (branch ${plan.branch}) — run \`git worktree prune\` and retry if it reports stale entries`);
      }
      git.invalidateWorktreesCache(); // so the zone classifier sees the new worktree immediately
      cwd = wtPath;
      isolateMeta = { worktreePath: wtPath, branch: plan.branch, baseSha: sha, releasedAt: null, retainNotified: false };
      spec.prompt = `${buildIsolatePreamble({ worktreePath: wtPath, branch: plan.branch, baseShort: sha.slice(0, 7) })}\n\n${spec.prompt}`;
    } else if (cwdParam) {
      cwd = pathResolve(masterCwd, cwdParam);
      try {
        if (!(await statAsync(cwd)).isDirectory()) throw new Error('not a directory');
      } catch {
        return toolError(`Error: \`cwd\` is not an existing directory: ${cwdParam}`);
      }
    }
    // D86 R1: group by the git worktree containing cwd (main checkout → main tab; other → its tab).
    const zone = classifyWorktreeZone({ cwd, masterCwd, worktrees: await git.listWorktrees(masterCwd) });
    // D86 trust: pass -a only for the master's checkout/worktrees; external dirs stay behind pi's Trust dialog.
    const approve = isPathUnder(cwd, masterCwd) || zone.zone === 'worktree';
    let roleManifestEnv: Record<string, string> = {};
    let roleModel: string | null = null;
    try {
      const { role, manifest } = composeForRole(manifestRole ?? 'worker-default', suggested, { loadRoleOpts: { baseDir: masterCwd } });
      roleManifestEnv = {
        PI_HERDR_ROLE_MANIFEST: JSON.stringify({
          role: role.role,
          version: role.version,
          tools: manifest.tools,
          permissions: manifest.permissions,
          unknownTools: manifest.unknownTools,
          services: role.services ?? {},
          // Without guidelines the worker's parseRuntimeManifest yields none and the pier-role
          // prompt section silently no-ops for exactly the spawned workers that matter.
          ...(role.guidelines?.length ? { guidelines: role.guidelines } : {}),
        }),
        // Role resolution base: the worker's /pier-role and pipe switch must resolve workspace
        // .pi-herdr/roles/ against the MASTER's checkout, not the worker pane's own cwd.
        PI_HERDR_ROLE_BASE: masterCwd,
      };
      if (typeof role.model === 'string' && role.model.trim()) roleModel = role.model.trim();
      h.logRouting?.(
        planSpawnProfileRow({
          now: Date.now(),
          roleExplicit: typeof manifestRole === 'string' && manifestRole.trim() !== '',
          role: role.role,
          allowedTools: suggested,
          manifestTools: manifest.tools,
          task: spec.prompt,
        }),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return toolError(`Error: role "${manifestRole}" manifest invalid — ${msg}`);
    }

    const release = await h.subSemaphore.acquire();
    let paneId = '';
    try {
      const spawnedAt = Date.now();
      const spawned = await spawnPaneInTaskTab(
        { desiredTab: tab, description: spec.description, zone },
        cwd,
        { PI_HERDR_SUBAGENT: '1', ...roleManifestEnv },
        launchLine(null, roleModel, approve),
      );
      paneId = spawned.paneId;
      const entry: SubEntry = {
        taskId,
        kind,
        paneId,
        tabId: spawned.tabId,
        tabName: spawned.tabName,
        cwd,
        description: spec.description,
        background,
        status: 'running',
        sessionFile: null,
        launchCommand: [launchLine(null, roleModel, approve)],
        createdAt: Date.now(),
        revivedFrom: null,
        ...(isolateMeta ? { isolate: isolateMeta } : {}),
      };
      const ready = await waitSubReady(cwd, paneId);
      if (!ready.ok) throw new Error(ready.message);
      // herdr's per-pane report lags right after spawn, and the mtime fallback would then
      // attribute the registry to the newest PRE-EXISTING session in cwd. Only a file written
      // after the pane existed can be this worker's; otherwise leave null for the poller.
      entry.sessionFile = await resolveSessionFile(paneId, cwd, undefined, { minMtimeMs: spawnedAt - 2_000 });
      subs.set(paneId, entry);
      h.persistSubs();
      onUpdate?.(makeProgressUpdate(`subagent ready in pane ${paneId}; injecting prompt via pipe…`));
      // M11: inject through the extension pipe, reserving the PTY keyboard channel for the human.
      // Injection and injectTs must stay together: without them a spawn leaves a ghost running
      // ledger entry and a worker with no task context.
      const injectTs = Date.now();
      const injected = await pipeRequestTo(cwd, paneId, {
        type: 'prompt',
        id: `prompt-${taskId}`,
        text: spec.prompt,
        // The pipe name MUST be scoped by the MASTER's cwd: the pipe server binds
        // pipeNameFor(master session cwd, own paneId). The worker's cwd (e.g. a cross-repo
        // delegation) names a pipe nobody listens on and the reply becomes a dead letter.
        from: pipeNameFor(masterCwd, env?.paneId ?? ''),
        push: background,
      });
      if (injected.type !== 'ok') {
        throw new Error(`pipe prompt rejected: ${injected.type === 'error' ? injected.message : 'unknown response'}`);
      }
      h.lastMachineInjectAt.set(paneId, injectTs); // attribute working state during the observation window
      /** Hand supervision to the poller: the caller gets a settle notice instead of a blocking wait. */
      const handToPoller = (requestId: string): void => {
        entry.background = true;
        h.lastRequestIdByPane.set(paneId, requestId);
        void startPoller(paneId, cwd, injectTs, spec.description, requestId);
        h.persistSubs();
        h.writeHistory(entry, undefined, 'to-background');
      };

      if (background) {
        handToPoller(`prompt-${taskId}`);
        return {
          content: [{ type: 'text', text: `started subagent ${paneId} (task ${taskId})` }],
          details: { paneId, taskId, background: true, role: kind },
        };
      }

      // Foreground waiting uses a content gate plus a patience threshold before backgrounding:
      // treating idle as settled with a hard window misclassified real multi-minute working
      // periods as "no output" and consumed healthy subagents that produced results right after.
      const patienceDeadline = Date.now() + runtimePolicy.foregroundPatienceMs;
      let text: string | null = null;
      let settledKind: 'settled' | 'timeout' = 'timeout';
      while (Date.now() < Math.min(patienceDeadline, spawnedAt + runtimePolicy.subagentTimeoutMs)) {
        const state = await client.waitAgent(paneId, ['idle', 'done', 'blocked'], 30_000);
        const session = (state === 'idle' || state === 'done')
          ? await subSessionState(paneId, cwd, injectTs)
          : { text: null, pendingTool: false, activity: false };
        const tick = planForegroundTick({ state, session });
        if (tick.kind === 'blocked') {
          const question = await readAskFlag(paneId);
          handToPoller(`prompt-${taskId}`);
          return {
            content: [{ type: 'text', text: buildBlockedGateNotice({ paneId, description: spec.description, question }) }],
            details: { paneId, taskId, background: true, blocked: true, role: kind },
          };
        }
        if (tick.kind === 'settled') {
          text = tick.text;
          settledKind = 'settled';
          break;
        }
        if (tick.kind === 'wait') {
          await sleep(tick.delayMs);
          continue;
        }
        if (tick.kind === 'collect-final') {
          text = await collectFinalText(paneId, cwd, injectTs, 6);
          if (text) { settledKind = 'settled'; break; }
          await sleep(FOREGROUND_POLL_MS);
        }
      }
      if (!text) {
        const probe = await probeAlive(paneId, cwd);
        if (isAlive(probe, Date.now())) {
          handToPoller(`prompt-${taskId}`);
          return {
            content: [{ type: 'text', text: buildAliveNotice({ paneId, description: spec.description, scenario: 'moved-to-bg', probe }, Date.now()) }],
            details: { paneId, taskId, background: true, movedToBackground: true, role: kind },
          };
        }
        settledKind = 'timeout';
      }
      const outcome =
        settledKind === 'timeout' ? { kind: 'timeout' as const, text: text ?? '' }
          : text ? { kind: 'completed' as const, text }
            : { kind: 'no-output' as const, text: '' };
      entry.status = 'consumed';
      entry.consumedAt = Date.now();
      h.persistSubs();
      h.writeHistory(entry, { outcome: outcome.kind === 'completed' ? text : null }, 'fg-settle');
      return {
        content: [{ type: 'text', text: formatSubagentResult(outcome, spec.description) }],
        details: { paneId, taskId, background, role: kind },
      };
    } catch (err) {
      // A mid-spawn failure must remove the ledger entry and close its pane, or a ghost running
      // entry never settles (D96 reminder storms, sends landing in an empty session).
      if (paneId) {
        subs.delete(paneId);
        h.persistSubs();
        void client.closePane(paneId).catch(() => { /* GC covers board exceptions */ });
      }
      // D98: if isolate startup never becomes ready there is no work to preserve — best-effort
      // removal of the worktree and branch; failure stays silent (harmless, still visible to git).
      if (isolateMeta) {
        const { branch, worktreePath } = isolateMeta;
        void git.runGit(masterCwd, ['worktree', 'remove', '--force', worktreePath])
          .then(() => git.runGit(masterCwd, ['branch', '-D', branch]))
          .catch(() => { /* best effort only */ });
      }
      return {
        content: [{
          type: 'text',
          text: formatSubagentResult(
            { kind: 'spawn-failed', text: String((err as Error)?.message ?? err) },
            spec.description,
          ),
        }],
        details: {},
      };
    } finally {
      release();
      if (isolateMeta) h.pendingIsolateBranches.delete(isolateMeta.branch);
    }
  };
}
