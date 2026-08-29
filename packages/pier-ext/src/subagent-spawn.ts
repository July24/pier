/**
 * Task-tab pane spawn, launch-line construction, and trust-flag decisions.
 *
 * Why: spawn mixed herdr layout I/O with the subagent tool body. Placement
 * races (D26 mutex) and D86 worktree grouping belong in one adapter.
 */
import type { HerdrClientLike } from './herdr-client.ts';
import { pingUntilReady, pipeNameCandidates } from './pipe-channel.ts';
import { runtimePolicy } from './runtime-policy.ts';
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
import { parseShapeTree, pickGridSplit } from './core/grid-shape.ts';
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
}

export interface Spawner {
  spawnPaneInTaskTab(
    placement: { desiredTab?: string | null; description: string; zone?: WorktreeZone },
    cwd: string,
    envOver: Record<string, string>,
    launch: string,
  ): Promise<{ tabId: string; paneId: string; tabName: string }>;
  launchLine(resumeFile?: string | null, roleModel?: string | null, approve?: boolean): string;
  approveFor(cwd: string, masterCwd: string): Promise<boolean>;
  waitSubReady(cwd: string, paneId: string): Promise<boolean>;
  liveTabs(): Promise<Array<{ tabName: string; tabId: string }>>;
  findExistingPane(sessionFile: string | null): Promise<{ paneId: string; tabId: string } | null>;
}

export function createSpawner(h: SpawnerHost): Spawner {
  const tabMutex = new Semaphore(1);
  const readyTimeoutMs = runtimePolicy.readinessTimeoutMs;

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

  async function waitSubReady(cwd: string, paneId: string): Promise<boolean> {
    return pingUntilReady(pipeNameCandidates(cwd, paneId), readyTimeoutMs);
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
        try {
          const snapshot = await h.client.exportLayout({ tabId: plan.tabId });
          const tree = snapshot?.root ? parseShapeTree(snapshot.root) : null;
          if (tree) pick = pickGridSplit(tree, { exclude });
        } catch { /* layout export failure → legacy anchor split */ }
        const anchorPaneId = pick?.targetPaneId
          ?? allPanes.find((p) => p.tabId === plan.tabId && p.agentStatus !== 'unknown')?.paneId
          ?? allPanes.find((p) => p.tabId === plan.tabId)?.paneId;
        if (anchorPaneId) {
          const paneId = await h.client.splitPane({
            direction: pick?.direction ?? 'down',
            cwd,
            env: envOver,
            targetPaneId: anchorPaneId,
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
