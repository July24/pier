/**
 * Subagent `spawn` action (isolate worktree, pane launch, prompt injection, foreground wait).
 *
 * Why: the plugin entry keeps tool registration and lifecycle wiring; the spawn path is the one
 * action with git, placement, injection, and settle branches, so it lives here as a unit.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, stat as statCb } from 'node:fs';
import { basename, dirname, join, resolve as pathResolve } from 'node:path';
import { promisify } from 'node:util';
import type { HerdrClientLike } from './herdr-client.ts';
import { composeForRole } from './manifest-compose.ts';
import { pipeNameFor, pipeRequestTo } from './pipe-channel.ts';
import { planSpawnProfileRow, type RoutingTelemetryRecord } from './routing-telemetry.ts';
import { platformPaths } from './platform-paths.ts';
import { runtimePolicy } from './runtime-policy.ts';
import {
  FOREGROUND_POLL_MS,
  planForegroundTick,
  planIsolateRepoGuard,
  planLaunchValidation,
  planPatienceExpiry,
} from './subagent-launch.ts';
import {
  Semaphore,
  buildAliveNotice,
  buildBlockedGateNotice,
  buildIsolatePreamble,
  classifyWorktreeZone,
  formatSubagentResult,
  isAlive,
  isPathUnder,
  makeProgressUpdate,
  planIsolateWorktree,
  type SubEntry,
} from './subagent-core.ts';
import type { HistoryEntry } from './history-store.ts';
import type { GitIo } from './subagent-git-io.ts';
import { sleep, type Poller } from './subagent-poll-loop.ts';
import type { SessionIo } from './subagent-session-io.ts';
import type { SpawnEnv, Spawner } from './subagent-spawn.ts';
import { toolError } from './tool-error.ts';

const statAsync = promisify(statCb);

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

export type SpawnAction = (
  params: Record<string, unknown> | undefined,
  toolCtx: unknown,
  onUpdate?: (update: unknown) => void,
) => Promise<unknown>;

export function createSpawnAction(h: SpawnActionHost): SpawnAction {
  const { client, env, git, subs } = h;
  const { resolveSessionFile, collectFinalText, readAskFlag, probeAlive, subSessionState } = h.session;
  const { spawnPaneInTaskTab, launchLine, waitSubReady } = h.spawn;
  const { startPoller } = h.poller;

  return async function executeSubagentSpawn(params, toolCtx, onUpdate) {
    const launch = planLaunchValidation(params, client.available);
    if (launch.kind === 'error') {
      return toolError(launch.text);
    }
    const { spec, background, isolate, cwdParam, roleKind: kind, suggested, manifestRole, tab } = launch;
    const masterCwd = (toolCtx as { cwd?: string }).cwd ?? process.cwd();
    // Move taskId generation above the original spawn section because isolate planning needs taskHex; this is behavior-neutral.
    const taskId = randomUUID();
    // D98 2c: Create the isolate through pier's execFile git path (decision 1), not herdr's
    // socket worktree.create, which has bootstrap races, missing root-pane env, worker/master
    // workspace separation, and linked_worktree_source rejection. The model makes the decision; do not infer it.
    let isolateMeta: SubEntry['isolate'] | null = null;
    let cwd = masterCwd;
    if (isolate) {
      const baseSha = await git.runGit(masterCwd, ['rev-parse', 'HEAD']);
      const isoGuard = planIsolateRepoGuard(baseSha);
      if (isoGuard.kind === 'error') {
        return toolError(isoGuard.text);
      }
      const sha = isoGuard.sha.trim();
      const pierBranches = new Set(
        ((await git.runGit(masterCwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/pier/'])) ?? '')
          .split('\n').filter(Boolean),
      );
      const worktrees = await git.listWorktrees(masterCwd);
      const repoName = basename(worktrees[0] ?? masterCwd);
      const plan = planIsolateWorktree({
        description: spec.description,
        taskHex: taskId.slice(0, 6),
        existingPierBranches: pierBranches,
      });
      const wtPath = join(platformPaths.worktreeBaseDir, repoName, plan.worktreeDirName);
      try {
        mkdirSync(dirname(wtPath), { recursive: true }); // git worktree add does not create its parent directory, so a first run would fail.
      } catch { /* Existing directory or permissions failure is handled by worktree add. */ }
      // Keep the branch pending between worktree add and subs.set: the 2–3s readiness wait lets the ticker
      // scan, and without this guard it could reclaim a new clean =HEAD-ancestor worktree as an orphan.
      h.pendingIsolateBranches.add(plan.branch);
      const added = await git.runGit(masterCwd, ['worktree', 'add', '-b', plan.branch, wtPath, sha]);
      if (added === null) {
        h.pendingIsolateBranches.delete(plan.branch);
        return toolError(`Error: failed to create worktree ${wtPath} (branch ${plan.branch}) — run \`git worktree prune\` and retry if it reports stale entries`);
      }
      git.invalidateWorktreesCache(); // Invalidate the 5s cache so the zone classifier sees the new worktree immediately.
      cwd = wtPath;
      isolateMeta = { worktreePath: wtPath, branch: plan.branch, baseSha: sha, releasedAt: null, retainNotified: false };
      spec.prompt = `${buildIsolatePreamble({ worktreePath: wtPath, branch: plan.branch, baseShort: sha.slice(0, 7) })}\n\n${spec.prompt}`;
    } else if (cwdParam) {
      cwd = pathResolve(masterCwd, cwdParam);
      try {
        const st = await statAsync(cwd);
        if (!st.isDirectory()) throw new Error('not a directory');
      } catch {
        return toolError(`Error: \`cwd\` is not an existing directory: ${cwdParam}`);
      }
    }
    // D86 R1: Group by the git worktree containing cwd (main checkout → main tab; other worktree → directory-named tab).
    const zone = classifyWorktreeZone({
      cwd,
      masterCwd,
      worktrees: await git.listWorktrees(masterCwd),
    });
    // D86 trust: pass -a only for the master's checkout/worktrees; external directories remain behind pi's Trust dialog.
    const approve = isPathUnder(cwd, masterCwd) || zone.zone === 'worktree';
    let roleManifestEnv: Record<string, string> = {};
    let roleModel: string | null = null;
    try {
      // planLaunchValidation always names a role ('worker-default' by default); keep the same fallback
      // here for callers that build a launch spec directly.
      const roleName = manifestRole ?? 'worker-default';
      const { role, manifest } = composeForRole(roleName, suggested, { loadRoleOpts: { baseDir: masterCwd } });
      roleManifestEnv = {
        PI_HERDR_ROLE_MANIFEST: JSON.stringify({
          role: role.role,
          version: role.version,
          tools: manifest.tools,
          permissions: manifest.permissions,
          unknownTools: manifest.unknownTools,
          services: role.services ?? {},
          // P0 §4.6: without this the worker's parseRuntimeManifest yields no guidelines and the
          // pier-role prompt section silently no-ops for exactly the spawned workers that matter.
          ...(role.guidelines?.length ? { guidelines: role.guidelines } : {}),
        }),
        // P0: role resolution base — the worker's /pier-role and pipe 'role' switch must resolve
        // workspace .pi-herdr/roles/ against the MASTER's checkout (spawn semantics), not the
        // worker pane's own cwd (which for isolate/worktree workers is a different directory).
        PI_HERDR_ROLE_BASE: masterCwd,
      };
      // WS-D10: Route the model by role; omission intentionally uses the process default.
      if (typeof role.model === 'string' && role.model.trim()) roleModel = role.model.trim();
      // Phase 0 (RFC §8): spawn profile — manual-routing signal (role param / allowed_tools) plus
      // the composed result. taskSha8 correlates spawns without persisting the task text.
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
      // p25 (01a0c282): herdr's per-pane report lags right after spawn, and the mtime fallback
      // then attributes the registry to the newest PRE-EXISTING session in cwd (a cross-repo
      // worker inherited last week's transcript and settlement detection never fired). Only a
      // file written after the pane existed can be this worker's; otherwise leave null and let
      // the poller resolve it once herdr reports.
      entry.sessionFile = await resolveSessionFile(paneId, cwd, undefined, { minMtimeMs: spawnedAt - 2_000 });
      subs.set(paneId, entry);
      h.persistSubs();
      onUpdate?.(makeProgressUpdate(`subagent ready in pane ${paneId}; injecting prompt via pipe…`));
      // M11 (D45/D46): Inject through the extension pipe to the child extension's sendUserMessage(followUp);
      // reserve the PTY keyboard channel entirely for the person, with no soft-lock window or mixed input.
      // Regression evidence (session 01a03bf0): ecc0bc4's foreground-wait rewrite once removed this block,
      // leaving the prompt uninjected and injectTs undefined (ReferenceError → spawn-failed, with a ghost
      // running ledger entry). Keep injection and injectTs together in future refactors.
      const injectTs = Date.now();
      const injected = await pipeRequestTo(cwd, paneId, {
        type: 'prompt',
        id: `prompt-${taskId}`,
        text: spec.prompt,
        // The child pushes its settle reply to this name: it MUST be scoped by the MASTER's
        // cwd (the pipe server binds pipeNameFor(master session cwd, own paneId) — index.ts).
        // The worker's cwd (e.g. a cross-repo delegation) names a pipe nobody listens on and
        // the reply becomes a silent dead letter (01a0c282).
        from: pipeNameFor(masterCwd, env?.paneId ?? ''),
        push: background,
      });
      if (injected.type !== 'ok') {
        throw new Error(`pipe prompt rejected: ${injected.type === 'error' ? injected.message : 'unknown response'}`);
      }
      h.lastMachineInjectAt.set(paneId, injectTs); // B4: attribute working state during the observation window.

      // A7: run_in_background returns immediately after successful injection instead of blocking in foreground wait.
      if (background) {
        entry.background = true;
        h.lastRequestIdByPane.set(paneId, `prompt-${taskId}`);
        void startPoller(paneId, cwd, spawnedAt, injectTs, spec.description, `prompt-${taskId}`);
        h.persistSubs();
        h.writeHistory(entry, undefined, 'to-background');
        return {
          content: [{ type: 'text', text: `started subagent ${paneId} (task ${taskId})` }],
          details: { paneId, taskId, background: true, role: kind },
        };
      }

      // A1+A2 (user-verified fix): foreground waiting uses a content gate plus a patience threshold before backgrounding.
      // Treating idle as settled with a hard 90s window misclassified real 4–6 minute working periods as no-output;
      // three healthy subagents were observed becoming consumed at 101s while producing results four minutes later.
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
          entry.background = true;
          h.lastRequestIdByPane.set(paneId, `prompt-${taskId}`);
          void startPoller(paneId, cwd, spawnedAt, injectTs, spec.description, `prompt-${taskId}`);
          h.persistSubs();
          h.writeHistory(entry, undefined, 'to-background');
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
          continue;
        }
      }
      if (!text) {
        const probe = await probeAlive(paneId, cwd);
        if (planPatienceExpiry(isAlive(probe, Date.now())) === 'move-to-background') {
          entry.background = true;
          h.lastRequestIdByPane.set(paneId, `prompt-${taskId}`);
          void startPoller(paneId, cwd, spawnedAt, injectTs, spec.description, `prompt-${taskId}`);
          h.persistSubs();
          const notice = buildAliveNotice(
            { paneId, description: spec.description, scenario: 'moved-to-bg', probe },
            Date.now(),
          );
          return {
            content: [{ type: 'text', text: notice }],
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
      // Regression fix (session 01a03bf0): a mid-spawn failure must remove the ledger entry and close its pane,
      // otherwise a ghost running entry never settles, causing D96 reminder storms and send_message calls
      // to land in an empty session with no task context. Pane closure is best effort; GC covers board exceptions.
      if (paneId) {
        subs.delete(paneId);
        h.persistSubs();
        void client.closePane(paneId).catch(() => { /* Best effort only. */ });
      }
      // D98 2d: If isolate startup never becomes ready, best-effort remove the new worktree and branch (no work
      // exists to preserve); failure stays silent because the branch is harmless and remains visible to git worktree list.
      if (isolateMeta) {
        const branch = isolateMeta.branch;
        const worktreePath = isolateMeta.worktreePath;
        void git.runGit(masterCwd, ['worktree', 'remove', '--force', worktreePath])
          .then(() => git.runGit(masterCwd, ['branch', '-D', branch]))
          .catch(() => { /* Best effort only. */ });
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
      if (isolateMeta) h.pendingIsolateBranches.delete(isolateMeta.branch); // D98: release the creation-window guard on every success/failure path.
    }
  };
}
