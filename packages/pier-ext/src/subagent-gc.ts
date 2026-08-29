/**
 * Tab/pane collection and isolate-worktree sweep.
 *
 * Why: GC mixed herdr close I/O with the plugin body. Predicates stay in
 * gc-core.ts; this adapter owns list/close, isolate git, and the ticker.
 */
import { appendFileSync, existsSync, rmSync } from 'node:fs';
import type { Context } from '@deepseek-ai/cordis';
import type { HerdrClientLike } from './herdr-client.ts';
import { shouldClosePane, shouldCloseTaskTab } from './gc-core.ts';
import { runtimePolicy } from './runtime-policy.ts';
import { evaluateRelease, parseWorktreePorcelain, type SubEntry } from './subagent-core.ts';
import type { GitIo } from './subagent-git-io.ts';
import type { TerminalStateSlot } from './core/terminal.ts';

function sleep(ms: number): Promise<void> {
  const wait = Promise.withResolvers<void>();
  setTimeout(wait.resolve, ms);
  return wait.promise;
}

export interface GcHost {
  client: HerdrClientLike;
  env: { tabId: string } | null;
  subs: Map<string, SubEntry>;
  persistSubs(): void;
  writeHistory(e: SubEntry, patch?: { outcome?: string | null; status?: SubEntry['status']; closedAt?: number }, via?: string): void;
  terminalState: TerminalStateSlot;
  noticePending?: () => ReadonlySet<string>;
  pendingIsolateBranches: Set<string>;
  git: GitIo;
  injectNotice(content: string): Promise<void>;
}

export interface GcController {
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
    const taskTabIds = new Set(byTab.keys());
    const mainTabId = h.env?.tabId ?? '';

    for (const [tabId, entries] of byTab) {
      if (tabId === mainTabId) continue;
      const tabPanes = panesList.filter((p) => p.tabId === tabId);
      if (tabPanes.length === 0) {
        for (const e of entries) {
          if (e.status !== 'closed') {
            e.status = 'closed';
            h.writeHistory(e, { status: 'closed', closedAt: Date.now() }, 'gc');
          }
        }
        continue;
      }
      const should = shouldCloseTaskTab({
        entries,
        paneStatuses: tabPanes.map((p) => p.agentStatus),
        ttlMs,
        now: Date.now(),
      });
      if (!autoCloseTabs || !should) continue;
      if (tabPanes.some((p) => termPaneIds.has(p.paneId) || pendingNoticeIds.has(p.paneId))) continue;
      try {
        await h.client.tabClose(tabId);
      } catch {
        /* tab may already be gone */
      }
      for (const e of entries) {
        if (e.status !== 'closed') {
          e.status = 'closed';
          h.writeHistory(e, { status: 'closed', closedAt: Date.now() }, 'gc');
        }
      }
      await sleep(300);
    }

    const closableTaskTabIds = new Set([...taskTabIds].filter((t) => t !== mainTabId));
    const candidates = [...h.subs.values()].filter(
      (e) => e.status === 'consumed' && !(e.tabId && closableTaskTabIds.has(e.tabId)),
    );
    for (const e of candidates) {
      if (termPaneIds.has(e.paneId) || pendingNoticeIds.has(e.paneId)) continue;
      if (!shouldClosePane({
        consumedAt: e.consumedAt ?? null,
        herdrStatus: statuses.get(e.paneId),
        prevTurnStart,
      })) continue;
      if (statuses.get(e.paneId) === undefined) {
        e.status = 'closed';
        h.writeHistory(e, { status: 'closed', closedAt: Date.now() }, 'gc');
        continue;
      }
      try {
        await h.client.closePane(e.paneId);
      } catch {
        /* pane may already be gone */
      }
      e.status = 'closed';
      h.writeHistory(e, { status: 'closed', closedAt: Date.now() }, 'gc');
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
    const pierBranchOut = await h.git.runGit(masterCwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/pier/']);
    const pierBranches = (pierBranchOut ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
    type Cand = { branch: string; wtPath: string; entry: SubEntry | null };
    const byBranch = new Map<string, Cand>();
    for (const branch of pierBranches) {
      if (registeredBranches.has(branch) || h.pendingIsolateBranches.has(branch)) continue;
      const wtPath = wtByBranch.get(branch);
      if (wtPath) byBranch.set(branch, { branch, wtPath, entry: null });
    }
    for (const e of h.subs.values()) {
      if (!e.isolate || e.isolate.releasedAt != null || e.status === 'running') continue;
      const prev = byBranch.get(e.isolate.branch);
      byBranch.set(e.isolate.branch, { branch: e.isolate.branch, wtPath: prev?.wtPath ?? e.isolate.worktreePath, entry: e });
    }
    trace?.(`cands=${[...byBranch.keys()].join(',') || 'none'} subs=${[...h.subs.values()].map((s) => `${s.status}${s.isolate ? '/iso' : ''}`).join(',') || 'none'}`);
    let persisted = false;
    for (const cand of byBranch.values()) {
      const { branch, wtPath, entry } = cand;
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
      const merged = mergedOut !== null ? true : null;
      let mergedFinal = merged;
      if (merged === null) {
        const sha = await h.git.runGit(masterCwd, ['rev-parse', branch]);
        const headSha = await h.git.runGit(masterCwd, ['rev-parse', 'HEAD']);
        if (sha != null && headSha != null) mergedFinal = false;
      }
      const dirtyOut = await h.git.runGit(wtPath, ['status', '--porcelain']);
      const dirtyCount = dirtyOut === null ? null : dirtyOut.split('\n').filter((l) => l.trim() !== '').length;
      const decision = evaluateRelease({ merged: mergedFinal, dirtyCount });
      if (decision.action === 'release') {
        const removed = await h.git.runGit(masterCwd, ['worktree', 'remove', wtPath]);
        let ok = removed !== null;
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
    } catch {
      /* next turn/tick retries */
    }
    try {
      await isolateSweep();
    } catch {
      /* next turn/tick retries */
    } finally {
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
