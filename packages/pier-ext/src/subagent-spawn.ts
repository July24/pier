/**
 * Subagent spawn domain: git/worktree I/O, optional app tab placement, launch argv, readiness wait, and
 * the `spawn` action. Children are created by herdr-core (`terminal.run`) with the full argv and this
 * terminal as `parent`, so no shell prompt probe or pasted launch line is involved. Without an explicit
 * tab the app shows the child as a sub-agent of its parent (peekable, killed with it), not a pane.
 */
import { execFile as nodeExecFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, stat as statCb } from 'node:fs';
import { basename, dirname, join, resolve as pathResolve } from 'node:path';
import { promisify } from 'node:util';
import { childEnvironment, type CoreClientLike, type CoreEnv } from './core-client.ts';
import { delegationEnv } from './delegation-core.ts';
import { bareSessionId } from './session-tail.ts';
import { pipeNameCandidates, pipeNameFor, pipeRequest, pipeRequestTo } from './pipe-channel.ts';
import { platformPaths } from './platform-paths.ts';
import { runtimePolicy } from './runtime-policy.ts';
import { toolError } from './tool-error.ts';
import type { HistoryEntry } from './history-store.ts';
import {
  FOREGROUND_POLL_MS,
  Semaphore,
  allocateSubSlug,
  buildAliveNotice,
  buildBlockedGateNotice,
  buildIsolatePreamble,
  buildLaunchLine,
  buildLaunchParts,
  classifyWorktreeZone,
  formatIsolateLocation,
  formatSubagentResult,
  formatWorktreeStat,
  isAlive,
  isPathUnder,
  makeProgressUpdate,
  planForegroundTick,
  planIsolateWorktree,
  planLaunchValidation,
  planTabPlacement,
  sleep,
  subRef,
  type SubEntry,
} from './subagent-core.ts';
import type { Poller } from './subagent-poller.ts';
import type { SessionIo } from './subagent-session.ts';

const statAsync = promisify(statCb);

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

export type GitExecFile = (
  file: string,
  args: readonly string[],
  options: { timeout: number; encoding: 'utf8'; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string }>;

/** Output ceiling for one git call: a large checkout blows past execFile's 1MB default (ENOBUFS). */
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

interface ReadyFailure {
  readonly paneId: string;
  readonly reason: 'pane-gone' | 'timeout';
  readonly elapsedMs: number;
  readonly timeoutMs: number;
  readonly lastStatus?: string | null;
  readonly tail?: string | null;
  readonly hint?: string | null;
}

type ReadyAttemptPlan =
  | { readonly kind: 'ready' }
  | { readonly kind: 'retry'; readonly delayMs: number }
  | { readonly kind: 'give-up'; readonly reason: 'pane-gone' | 'timeout' };

/** Decide one readiness attempt. `alive` is tri-state on purpose: an unavailable liveness probe
 * (`null`) must not be read as death, or a slow herdr socket fails spawns that are merely slow. */
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

/** Failure text for the model; the three cases stay distinguishable: pane died (the tail carries the
 * reason), pane alive but never opened its pipe, pane alive and just slower than the timeout. */
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

interface SpawnerHost {
  client: CoreClientLike;
  env: CoreEnv | null;
  runtime: { nodePath: string; cliPath: string; extPath: string };
  git: GitIo;
  /** Test override. Production reads `runtimePolicy.readinessTimeoutMs`. */
  readinessTimeoutMs?: number;
}

type ReadyOutcome = { ok: true } | { ok: false; message: string };

export interface Spawner {
  spawnWorker(
    placement: { desiredTab?: string | null },
    cwd: string,
    envOver: Record<string, string>,
    argv: readonly string[],
  ): Promise<{ tabId: string; paneId: string; tabName: string }>;
  launchParts(resumeFile?: string | null, model?: string | null, approve?: boolean): string[];
  approveFor(cwd: string, masterCwd: string): Promise<boolean>;
  waitSubReady(cwd: string, paneId: string): Promise<ReadyOutcome>;
  findExistingPane(sessionFile: string | null): Promise<{ paneId: string; tabId: string } | null>;
}

export function createSpawner(h: SpawnerHost): Spawner {
  const readyTimeoutMs = h.readinessTimeoutMs ?? runtimePolicy.readinessTimeoutMs;

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
        const hint = plan.reason === 'timeout' && lastStatus === 'working'
          ? 'Tip: pass run_in_background to avoid blocking the master turn while the worker boots.'
          : null;
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
      // A terminal that core marks finished is gone; a live one may still be booting its pipe.
      const terminal = await h.client.getTerminal(paneId);
      alive = terminal != null && terminal.state !== 'finished';
      status = terminal?.status ?? null;
    } catch {
      /* core unreachable: liveness stays unknown, never "dead" */
    }
    let tail: string | null = null;
    try {
      const read = await h.client.read(paneId, { lines: 40 });
      if (read.text) tail = read.text.slice(-READY_TAIL_CHARS);
    } catch {
      /* reaped terminal or socket blip — caller keeps the last cached tail */
    }
    return { alive, status, tail };
  }

  /** Create the worker terminal (parent = this terminal). D140: only an explicit tab adds the
   *  `herdr.space`/`herdr.tab` labels that make the app adopt it as an unfocused pane (a new
   *  `herdr.tab` id makes the app create that tab). Core ends the worker with its parent either way. */
  async function spawnWorker(
    placement: { desiredTab?: string | null },
    cwd: string,
    envOver: Record<string, string>,
    argv: readonly string[],
  ): Promise<{ tabId: string; paneId: string; tabName: string }> {
    const plan = planTabPlacement({ desiredTab: placement.desiredTab });
    const placementLabels = plan.tabName ? await h.client.placementLabels() : {};
    const terminal = await h.client.run({
      argv: [...argv],
      cwd,
      env: childEnvironment(process.env, envOver),
      labels: plan.tabId ? { ...placementLabels, 'herdr.tab': plan.tabId } : placementLabels,
      noNotify: true,
    });
    return {
      tabId: plan.tabId ?? placementLabels['herdr.tab'] ?? '',
      paneId: terminal.id,
      tabName: plan.tabName,
    };
  }

  /** D94: reuse a terminal that already runs the same session instead of competing on one transcript.
   *  Workers self-report their session file in the `pier.session` label. */
  async function findExistingPane(sessionFile: string | null): Promise<{ paneId: string; tabId: string } | null> {
    if (!sessionFile) return null;
    const wanted = bareSessionId(sessionFile);
    try {
      const terminals = await h.client.listTerminals();
      const match = terminals.find((t) => {
        const reported = t.labels['pier.session'];
        return reported != null && bareSessionId(reported) === wanted;
      });
      if (!match) return null;
      return { paneId: match.id, tabId: match.labels['herdr.tab'] ?? '' };
    } catch {
      return null;
    }
  }

  return {
    spawnWorker,
    launchParts: (resumeFile, model, approve) => buildLaunchParts(h.runtime, { resumeFile, model, approve: approve ?? false }),
    approveFor,
    waitSubReady,
    findExistingPane,
  };
}

/* ── spawn action ───────────────────────────────────────────────── */

interface SpawnActionHost {
  client: CoreClientLike;
  env: CoreEnv | null;
  subSemaphore: Semaphore;
  subs: Map<string, SubEntry>;
  persistSubs(): void;
  writeHistory(entry: SubEntry, patch?: Partial<HistoryEntry>, via?: string): void;
  pendingIsolateBranches: Set<string>;
  lastRequestIdByPane: Map<string, number | string>;
  git: GitIo;
  session: SessionIo;
  spawn: Spawner;
  poller: Poller;
  /** Master session id for the delegation identity handed to the worker. */
  getSessionId: () => string;
}

export function createSpawnAction(h: SpawnActionHost) {
  const { client, env, git, subs } = h;
  const { resolveSessionFile, collectFinalText, readAskFlag, probeAlive, subSessionState } = h.session;
  const { spawnWorker, launchParts, waitSubReady } = h.spawn;
  const { startPoller } = h.poller;

  return async function executeSubagentSpawn(
    params: Record<string, unknown> | undefined,
    toolCtx: unknown,
    onUpdate?: (update: unknown) => void,
  ): Promise<unknown> {
    const launch = planLaunchValidation(params, client.available);
    if (launch.kind === 'error') return toolError(launch.text);
    const { spec, background, isolate, cwdParam, tab } = launch;
    const masterCwd = (toolCtx as { cwd?: string })?.cwd ?? process.cwd();
    const taskId = randomUUID();
    const kind = 'task';
    // Workers run the master's current model (a /model switch included); null = pi's default.
    let masterModel: string | null = null;
    if (toolCtx && typeof toolCtx === 'object' && 'model' in toolCtx) {
      const model = toolCtx.model;
      if (model && typeof model === 'object' && 'id' in model && typeof model.id === 'string' && model.id) {
        const provider = 'provider' in model && typeof model.provider === 'string' ? model.provider : '';
        masterModel = provider ? `${provider}/${model.id}` : model.id;
      }
    }
    // Delegation identity (RFC rfc-delegation-identity §2.1): the worker learns who delegated it.
    const delegationEnvPatch = delegationEnv({
      parentPaneId: env?.terminalId ?? '',
      parentSessionId: bareSessionId(h.getSessionId()),
      // The master's own pipe so the worker's todo_sync push can dial home (D49).
      parentPipe: pipeNameFor(masterCwd, env?.terminalId ?? ''),
      taskId,
      description: spec.description,
    });
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
    // Worktree zone only decides trust now; placement is opt-in via `tab` (D140).
    const zone = classifyWorktreeZone({ cwd, masterCwd, worktrees: await git.listWorktrees(masterCwd) });
    // D86 trust: pass -a only for the master's checkout/worktrees; external dirs stay behind pi's Trust dialog.
    const approve = isPathUnder(cwd, masterCwd) || zone.zone === 'worktree';

    const release = await h.subSemaphore.acquire();
    let paneId = '';
    try {
      const spawnedAt = Date.now();
      const argv = launchParts(null, masterModel, approve);
      const spawned = await spawnWorker(
        { desiredTab: tab },
        cwd,
        // Status comes ONLY from pi's native OSC 7501 reporter; pier no longer writes it.
        { PI_HERDR_SUBAGENT: '1', ...delegationEnvPatch },
        argv,
      );
      paneId = spawned.paneId;
      // Phase 2: allocate once per spawn; revives/history keep the row's slug (stability beats beauty).
      const slug = allocateSubSlug(
        spec.description,
        taskId,
        new Set([...subs.values()].map((s) => s.slug ?? '').filter(Boolean)),
      );
      const entry: SubEntry = {
        taskId,
        kind,
        paneId,
        slug,
        tabId: spawned.tabId,
        tabName: spawned.tabName,
        cwd,
        description: spec.description,
        background,
        status: 'running',
        sessionFile: null,
        launchCommand: [buildLaunchLine(argv)],
        createdAt: Date.now(),
        revivedFrom: null,
        ...(isolateMeta ? { isolate: isolateMeta } : {}),
      };
      const ready = await waitSubReady(cwd, paneId);
      if (!ready.ok) throw new Error(ready.message);
      // The `pier.session` label lags right after spawn, so the mtime fallback would otherwise adopt
      // the newest PRE-EXISTING session in cwd; only a file written after the terminal existed counts.
      entry.sessionFile = await resolveSessionFile(paneId, cwd, undefined, { minMtimeMs: spawnedAt - 2_000 });
      subs.set(paneId, entry);
      h.persistSubs();
      onUpdate?.(makeProgressUpdate(`subagent ready in pane ${paneId}; injecting prompt via pipe…`));
      // M11: inject through the extension pipe, reserving the PTY keyboard channel for the human;
      // injection and injectTs must stay together or the spawn leaves a ghost running ledger entry.
      const injectTs = Date.now();
      const injected = await pipeRequestTo(cwd, paneId, {
        type: 'prompt',
        id: `prompt-${taskId}`,
        text: spec.prompt,
        // The pipe name MUST be scoped by the MASTER's cwd: the server binds pipeNameFor(master
        // session cwd, own terminal); the worker's cwd names a pipe nobody listens on.
        from: pipeNameFor(masterCwd, env?.terminalId ?? ''),
        push: background,
      });
      if (injected.type !== 'ok') {
        throw new Error(`pipe prompt rejected: ${injected.type === 'error' ? injected.message : 'unknown response'}`);
      }
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
          content: [{ type: 'text', text: `started subagent ${subRef(entry)} (task ${taskId})${formatIsolateLocation(isolateMeta)}` }],
          details: { paneId, taskId, background: true, role: kind, slug },
        };
      }

      // Foreground waiting: content gate + patience threshold before backgrounding an idle pane.
      // The worker is read from the children watch and the loop parks on its change counter.
      const watch = client.watchChildren();
      await watch.ready();
      const patienceDeadline = Date.now() + runtimePolicy.foregroundPatienceMs;
      let text: string | null = null;
      let settledKind: 'settled' | 'timeout' = 'timeout';
      let workerError: string | null = null;
      while (Date.now() < Math.min(patienceDeadline, spawnedAt + runtimePolicy.subagentTimeoutMs)) {
        const seen = watch.version(paneId);
        const park = (ms: number): Promise<boolean> => watch.changed(paneId, seen, ms);
        const info = watch.connected
          ? watch.get(paneId) ?? await client.getTerminal(paneId).catch(() => undefined)
          : undefined;
        // Same words the old blocking wait returned: null = still working (or unknown), else the status.
        const state = info === null || info?.state === 'finished' ? 'exited'
          : info === undefined || info.status === 'working' || info.status === 'unknown' ? null
            : info.status;
        if (state === 'exited') break; // the post-loop probe reports the dead worker
        if (state === 'error') workerError = info?.statusMsg ?? workerError;
        const session = (state === 'idle' || state === 'done' || state === 'error')
          ? await subSessionState(paneId, cwd, injectTs)
          : { text: null, pendingTool: false, activity: false };
        const tick = planForegroundTick({ state, session });
        if (tick.kind === 'blocked') {
          const question = await readAskFlag(paneId);
          handToPoller(`prompt-${taskId}`);
          return {
            content: [{ type: 'text', text: `${buildBlockedGateNotice({ paneId, description: spec.description, question })}${formatIsolateLocation(isolateMeta)}` }],
            details: { paneId, taskId, background: true, blocked: true, role: kind },
          };
        }
        if (tick.kind === 'settled') {
          text = tick.text;
          settledKind = 'settled';
          break;
        }
        if (state === 'error' && workerError !== null) {
          // The program failed without leaving transcript text: surface it now instead of blocking
          // the master for the whole patience window.
          handToPoller(`prompt-${taskId}`);
          return {
            content: [{ type: 'text', text: `Subagent "${spec.description}" reported an error (${workerError}). It stays backgrounded — check subagent(action: "output"), and its settlement notice will arrive automatically.${formatIsolateLocation(isolateMeta)}` }],
            details: { paneId, taskId, background: true, role: kind, workerError },
          };
        }
        if (tick.kind === 'wait') {
          await park(tick.delayMs);
          continue;
        }
        if (tick.kind === 'collect-final') {
          text = await collectFinalText(paneId, cwd, injectTs, 6);
          if (text) { settledKind = 'settled'; break; }
          await park(FOREGROUND_POLL_MS);
          continue;
        }
        // Still working: park until the worker's state changes.
        await park(30_000);
      }
      if (!text) {
        const probe = await probeAlive(paneId, cwd);
        if (isAlive(probe, Date.now())) {
          handToPoller(`prompt-${taskId}`);
          return {
            content: [{ type: 'text', text: `${buildAliveNotice({ paneId, description: spec.description, scenario: 'moved-to-bg', probe }, Date.now())}${formatIsolateLocation(isolateMeta)}` }],
            details: { paneId, taskId, background: true, movedToBackground: true, role: kind },
          };
        }
        settledKind = 'timeout';
      }
      // A worker that reported `error` and left no closing text still explains itself to the master.
      const partial = text ?? (workerError ? `(worker reported error: ${workerError})` : '');
      const outcome =
        settledKind === 'timeout' ? { kind: 'timeout' as const, text: partial }
          : text ? { kind: 'completed' as const, text }
            : { kind: 'no-output' as const, text: '' };
      entry.status = 'consumed';
      entry.consumedAt = Date.now();
      h.persistSubs();
      h.writeHistory(entry, { outcome: outcome.kind === 'completed' ? text : null }, 'fg-settle');
      return {
        content: [{ type: 'text', text: `${formatSubagentResult(outcome, spec.description)}${formatIsolateLocation(isolateMeta)}` }],
        details: { paneId, taskId, background, role: kind },
      };
    } catch (err) {
      // A mid-spawn failure must remove the ledger entry and retire its terminal, or a ghost entry never settles.
      if (paneId) {
        subs.delete(paneId);
        h.persistSubs();
        void (async () => {
          try { await client.kill(paneId); } catch { /* already gone */ }
          try { await client.remove(paneId); } catch { /* core reaps finished terminals */ }
        })();
      }
      // D98: an isolate whose startup never became ready has no work to preserve.
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
