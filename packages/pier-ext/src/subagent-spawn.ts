/**
 * Task-tab pane spawn, launch-line construction, and trust-flag decisions.
 *
 * Why: spawn mixed herdr layout I/O with the subagent tool body. Placement
 * races (D26 mutex) and D86 worktree grouping belong in one adapter.
 */
import type { HerdrClientLike } from './herdr-client.ts';
import { pipeNameCandidates, pipeRequest } from './pipe-channel.ts';
import { runtimePolicy } from './runtime-policy.ts';
import {
  READY_LIVENESS_SAMPLE_MS,
  READY_TAIL_CHARS,
  planReadyAttempt,
  readyFailureText,
  type ReadyFailure,
} from './subagent-ready.ts';
import {
  Semaphore,
  buildLaunchLine,
  buildLaunchParts,
  classifyWorktreeZone,
  isPathUnder,
  planTabPlacement,
  type TabPlacementPlan,
  type WorktreeZone,
} from './subagent-core.ts';
import { parseShapeTree, pickGridSplit, type PaneCell } from './plugins/grid-shape.ts';
import { fromShapeTree, planSpawnSplitRatio, type LayoutNode } from './plugins/heat-plan.ts';
import type { GitIo } from './subagent-git-io.ts';

export interface SpawnEnv {
  paneId: string;
  tabId: string;
  workspaceId: string;
}

export interface SpawnRuntime {
  nodePath: string;
  cliPath: string;
  extPath: string;
}

export interface SpawnerHost {
  client: HerdrClientLike;
  env: SpawnEnv | null;
  runtime: SpawnRuntime;
  git: GitIo;
  /** Test override. Production reads `runtimePolicy.readinessTimeoutMs`. */
  readinessTimeoutMs?: number;
}

/** A14: readiness outcome — failures explain themselves instead of collapsing into `false`. */
export type ReadyOutcome =
  | { ok: true }
  | { ok: false; failure: ReadyFailure; message: string };

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
  liveTabs(): Promise<Array<{ tabName: string; tabId: string }>>;
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

  /**
   * A14: wait for the child's pipe with backoff, and give up early when the pane
   * itself is gone from pane.list. Screen tail is sampled while the pane exists
   * so a crash that leaves a shell still explains itself on timeout.
   */
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
      // Liveness/agent sampling is much more expensive than a ping, so it runs on its own cadence.
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
            /* Best effort diagnostics; failures never mask the root error. */
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
        return { ok: false, failure, message: readyFailureText(failure) };
      }
      attempt += 1;
      await new Promise((r) => setTimeout(r, plan.delayMs));
    }
  }

  /** One ping round over every candidate pipe name (mixed-version peers register different names). */
  async function pingAnyName(names: readonly string[]): Promise<boolean> {
    for (const name of names) {
      try {
        const res = await pipeRequest(name, { type: 'ping', id: `ping-${Date.now()}` }, 3000);
        if (res.type === 'ok') return true;
      } catch {
        /* not ready on this name */
      }
    }
    return false;
  }

  /** Pane liveness + last visible output; socket failures degrade to "unknown" rather than "dead". */
  async function probeChildPane(paneId: string): Promise<{ alive: boolean | null; status: string | null; tail: string | null }> {
    let alive: boolean | null = null;
    let status: string | null = null;
    try {
      // pane.list includes unknown shells; agent.list does not (herdr 0.9.1 live probe).
      // A fresh split is absent from agent.list until pi is identified — that is boot, not death.
      const panes = await h.client.listPanes();
      const pane = panes.find((p) => p.paneId === paneId);
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
      const mainTabId = allPanes.find((p) => p.paneId === h.env?.paneId)?.tabId
        ?? (h.env?.tabId ? h.env.tabId : null);
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

  async function findExistingPane(sessionFile: string | null): Promise<{ paneId: string; tabId: string } | null> {
    if (!sessionFile) return null;
    try {
      const agents = await h.client.listAgents();
      const match = agents.find((a) => a.session === sessionFile && a.status !== 'unknown');
      if (!match) return null;
      const panes = await h.client.listPanes();
      const pane = panes.find((p) => p.paneId === match.paneId);
      return pane ? { paneId: match.paneId, tabId: pane.tabId } : null;
    } catch {
      return null;
    }
  }

  return { spawnPaneInTaskTab, launchLine, approveFor, waitSubReady, liveTabs, findExistingPane };
}
