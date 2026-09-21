/**
 * Subagent board hygiene: durable registry projection + startup/zombie recovery, tab and pane
 * collection, and the isolate-worktree sweep. Predicates live in gc-core.ts; this adapter owns
 * herdr close I/O, isolate git commands, and the ticker.
 */
import { appendFileSync, existsSync, rmSync } from 'node:fs';
import type { Context } from '@deepseek-ai/cordis';
import type { HerdrClientLike } from './herdr-client.ts';
import { isPathInside, planIsolateSweep, shouldClosePane, shouldCloseTaskTab } from './gc-core.ts';
import { runtimePolicy } from './runtime-policy.ts';
import { swallow } from './swallow.ts';
import { evaluateRelease, foldSubsRegistry, makeRegistry, parseWorktreePorcelain, sleep, SUBS_CUSTOM_TYPE, type SubEntry } from './subagent-core.ts';
import type { GitIo } from './subagent-spawn.ts';
import type { TerminalStateSlot } from './plugins/terminal.ts';

/* ── registry projection + recovery ─────────────────────────────── */

interface SubagentRegistryHost {
  pi: { appendEntry?: (customType: string, data: unknown) => void };
  client: HerdrClientLike;
  subs: Map<string, SubEntry>;
  writeHistory: (entry: SubEntry, patch?: { status?: SubEntry['status']; closedAt?: number }, via?: string) => void;
}

interface SubagentRegistry {
  /** Append the registry snapshot to the session branch; duplicate snapshots are skipped. */
  persist(): void;
  /** Replay `pi-herdr.subs` entries from the session branch into the live map. */
  rebuild(eventCtx: unknown): void;
  /** Close running rows whose pane herdr no longer lists. */
  sweepZombieRunning(): Promise<void>;
}

/** Durable registry projection and startup recovery, separate from tool actions. */
export function createSubagentRegistry(host: SubagentRegistryHost): SubagentRegistry {
  let lastSnapshot = '';

  function persist(): void {
    try {
      const registry = makeRegistry([...host.subs.values()]);
      const snapshot = JSON.stringify(registry);
      if (snapshot === lastSnapshot) return;
      lastSnapshot = snapshot;
      host.pi.appendEntry?.(SUBS_CUSTOM_TYPE, registry);
    } catch (err) {
      // Session logging must not break delegation, but a ghost running subagent is the symptom of
      // a silent failure here, so keep the reason queryable.
      swallow('subagent.persist-subs', err);
    }
  }

  function rebuild(eventCtx: unknown): void {
    try {
      const entries = (eventCtx as { sessionManager?: { getBranch?: () => readonly unknown[] } })
        ?.sessionManager?.getBranch?.() ?? [];
      const registry = foldSubsRegistry(entries as Parameters<typeof foldSubsRegistry>[0]);
      for (const entry of registry.subs) host.subs.set(entry.paneId, entry);
      lastSnapshot = ''; // branch replay replaced live state; force the next persist
    } catch {
      /* registry recovery failure must not block the live session */
    }
  }

  async function sweepZombieRunning(): Promise<void> {
    if (!host.client.available || host.subs.size === 0) return;
    let livePaneIds: ReadonlySet<string>;
    try {
      livePaneIds = new Set((await host.client.listPanes()).map((pane) => pane.paneId));
    } catch {
      return; // do not close agents when the liveness lookup itself failed
    }
    let changed = false;
    for (const [paneId, entry] of host.subs) {
      if (entry.status !== 'running' || livePaneIds.has(paneId)) continue;
      entry.status = 'closed';
      host.writeHistory(entry, { status: 'closed', closedAt: Date.now() }, 'zombie-sweep');
      changed = true;
    }
    if (changed) persist();
  }

  return { persist, rebuild, sweepZombieRunning };
}

/* ── GC ─────────────────────────────────────────────────────────── */

interface GcHost {
  client: HerdrClientLike;
  env: { tabId: string; paneId?: string } | null;
  subs: Map<string, SubEntry>;
  persistSubs(): void;
  writeHistory(e: SubEntry, patch?: { outcome?: string | null; status?: SubEntry['status']; closedAt?: number }, via?: string): void;
  terminalState: TerminalStateSlot;
  noticePending?: () => ReadonlySet<string>;
  pendingIsolateBranches: Set<string>;
  git: GitIo;
  injectNotice(content: string): Promise<void>;
}

interface GcController {
  runGcSafely(): Promise<void>;
  onTurnStart(): Promise<void>;
  startTicker(ctx: Context): void;
}

export function createGcController(h: GcHost): GcController {
  let prevTurnStart = Date.now();
  let gcRunning = false;

  async function gcPass(): Promise<void> {
    if (h.subs.size === 0) return;
    const ttlMs = runtimePolicy.sessionTtlSeconds * 1000;
    const autoCloseTabs = ttlMs > 0;
    let panesList: Array<{ paneId: string; tabId: string; agentStatus: string }>;
    try {
      panesList = await h.client.listPanes();
    } catch {
      return;
    }
    const statuses = new Map(panesList.map((p) => [p.paneId, p.agentStatus]));
    const termPaneIds = h.terminalState.activePaneIds();
    const pendingNoticeIds = h.noticePending?.() ?? new Set<string>();

    const byTab = new Map<string, SubEntry[]>();
    for (const e of h.subs.values()) {
      if (!e.tabId) continue;
      const arr = byTab.get(e.tabId) ?? [];
      arr.push(e);
      byTab.set(e.tabId, arr);
    }
    const mainTabId = h.env?.tabId ?? '';

    const closeRow = (e: SubEntry): void => {
      if (e.status === 'closed') return;
      e.status = 'closed';
      h.writeHistory(e, { status: 'closed', closedAt: Date.now() }, 'gc');
    };

    for (const [tabId, entries] of byTab) {
      if (tabId === mainTabId) continue;
      const tabPanes = panesList.filter((p) => p.tabId === tabId);
      if (tabPanes.length === 0) {
        for (const e of entries) closeRow(e);
        continue;
      }
      if (!autoCloseTabs) continue;
      if (!shouldCloseTaskTab({
        entries,
        paneStatuses: tabPanes.map((p) => p.agentStatus),
        ttlMs,
        now: Date.now(),
      })) continue;
      // Live terminal panes and not-yet-delivered settlement notices keep the tab alive.
      if (tabPanes.some((p) => termPaneIds.has(p.paneId) || pendingNoticeIds.has(p.paneId))) continue;
      try {
        await h.client.tabClose(tabId);
      } catch { /* tab may already be gone */ }
      for (const e of entries) closeRow(e);
      await sleep(300);
    }

    const closableTaskTabIds = new Set([...byTab.keys()].filter((t) => t !== mainTabId));
    const candidates = [...h.subs.values()].filter(
      (e) => e.status === 'consumed' && !(e.tabId && closableTaskTabIds.has(e.tabId)),
    );
    for (const e of candidates) {
      if (termPaneIds.has(e.paneId) || pendingNoticeIds.has(e.paneId)) continue;
      // A poisoned registry entry once let GC close the master's own pane while its workers were
      // still running. Never collect self, whatever the registry says.
      if (h.env?.paneId && e.paneId === h.env.paneId) continue;
      if (!shouldClosePane({
        consumedAt: e.consumedAt ?? null,
        herdrStatus: statuses.get(e.paneId),
        prevTurnStart,
      })) continue;
      if (statuses.get(e.paneId) === undefined) {
        closeRow(e);
        continue;
      }
      try {
        await h.client.closePane(e.paneId);
      } catch { /* pane may already be gone */ }
      closeRow(e);
      await sleep(300);
    }
    h.persistSubs();
  }

  async function isolateSweep(): Promise<void> {
    const trace = process.env.PI_HERDR_TRACE
      ? (msg: string) => { try { appendFileSync(process.env.PI_HERDR_TRACE!, `d98sweep ${Date.now()} ${msg}\n`); } catch { /* best-effort */ } }
      : null;
    const masterCwd = process.cwd();
    const registeredBranches = new Set<string>();
    for (const e of h.subs.values()) {
      if (e.isolate) registeredBranches.add(e.isolate.branch);
    }
    const wtPorcelain = await h.git.runGit(masterCwd, ['worktree', 'list', '--porcelain']);
    if (wtPorcelain === null) return;
    const wtByBranch = parseWorktreePorcelain(wtPorcelain);
    // Session-owned isolates: settled or consumed entries whose worktree was not released yet.
    const sessionOwned = [...h.subs.values()]
      .filter((e) => e.isolate && e.isolate.releasedAt == null && e.status !== 'running')
      .map((e) => ({ branch: e.isolate!.branch, worktreePath: e.isolate!.worktreePath }));
    // Untracked `pier/*` branches are only swept on explicit request: they may belong to another
    // session whose process is even running inside them.
    const sweepOrphans = process.env.PIER_ISOLATE_SWEEP_ORPHANS === '1';
    const branches = sweepOrphans
      ? (await h.git.runGit(masterCwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/pier/']))
        ?.split('\n').map((l) => l.trim()).filter(Boolean) ?? []
      : [];
    const plan = planIsolateSweep({
      branches,
      worktreesByBranch: wtByBranch,
      registeredBranches,
      pendingBranches: h.pendingIsolateBranches,
      sessionOwned,
      cwd: masterCwd,
      sweepOrphans,
    });
    const entryByBranch = new Map<string, SubEntry>();
    for (const e of h.subs.values()) {
      if (e.isolate && e.isolate.releasedAt == null && e.status !== 'running') entryByBranch.set(e.isolate.branch, e);
    }
    trace?.(`cands=${plan.candidates.map((c) => c.branch).join(',') || 'none'} skipped=${plan.skipped.map((s) => `${s.branch}:${s.reason}`).join(',') || 'none'} subs=${[...h.subs.values()].map((s) => `${s.status}${s.isolate ? '/iso' : ''}`).join(',') || 'none'}`);
    let persisted = false;
    for (const cand of plan.candidates) {
      const { branch, worktreePath: wtPath } = cand;
      const entry = entryByBranch.get(branch) ?? null;
      // The worktree is already gone (removed by hand or by a previous pass) → only release the row.
      if (entry && !wtByBranch.has(branch)) {
        if (existsSync(wtPath)) {
          try { rmSync(wtPath, { recursive: true, force: true }); } catch { continue; }
          if (existsSync(wtPath)) continue;
        }
        entry.isolate!.releasedAt = Date.now();
        persisted = true;
        continue;
      }
      const mergedOut = await h.git.runGit(masterCwd, ['merge-base', '--is-ancestor', branch, 'HEAD']);
      let mergedFinal: boolean | null = mergedOut !== null ? true : null;
      if (mergedFinal === null) {
        // A non-zero exit means "not an ancestor" OR "unknown branch": only a resolving ref
        // makes it unmerged; otherwise the decision stays 'unknown' and the worktree is retained.
        const sha = await h.git.runGit(masterCwd, ['rev-parse', branch]);
        const headSha = await h.git.runGit(masterCwd, ['rev-parse', 'HEAD']);
        if (sha != null && headSha != null) mergedFinal = false;
      }
      const dirtyOut = await h.git.runGit(wtPath, ['status', '--porcelain']);
      const dirtyCount = dirtyOut === null ? null : dirtyOut.split('\n').filter((l) => l.trim() !== '').length;
      const decision = evaluateRelease({ merged: mergedFinal, dirtyCount });
      if (decision.action === 'release') {
        // Defense in depth: the planner already refuses the current worktree, but a removal here
        // must never delete the directory this process is running in.
        if (isPathInside(masterCwd, wtPath)) continue;
        let ok = (await h.git.runGit(masterCwd, ['worktree', 'remove', wtPath])) !== null;
        if (!ok) {
          await sleep(2000);
          ok = (await h.git.runGit(masterCwd, ['worktree', 'remove', wtPath])) !== null;
        }
        if (ok) {
          h.git.invalidateWorktreesCache();
          if (entry) { entry.isolate!.releasedAt = Date.now(); persisted = true; }
        }
      } else if (entry && !entry.isolate!.retainNotified) {
        entry.isolate!.retainNotified = true;
        persisted = true;
        try {
          await h.injectNotice(`worktree ${branch} retained (${decision.reason}) — merge it (git merge --no-ff ${branch}) or remove manually (git worktree remove --force ${wtPath})`);
        } catch {
          /* retainNotified prevents repeated alerts */
        }
      }
    }
    if (persisted) h.persistSubs();
  }

  async function runGcSafely(): Promise<void> {
    if (gcRunning) return;
    gcRunning = true;
    try {
      await gcPass();
    } catch { /* next turn/tick retries */ }
    try {
      await isolateSweep();
    } catch { /* next turn/tick retries */ } finally {
      gcRunning = false;
    }
  }

  return {
    runGcSafely,
    async onTurnStart(): Promise<void> {
      const now = Date.now();
      await runGcSafely();
      prevTurnStart = now;
    },
    startTicker(ctx: Context): void {
      const gcTickMs = runtimePolicy.gcTickMs;
      const gcTicker = gcTickMs > 0 ? setInterval(() => { void runGcSafely(); }, gcTickMs) : null;
      ctx.effect(() => () => {
        clearInterval(gcTicker ?? undefined);
      }, 'gc-ticker');
    },
  };
}
