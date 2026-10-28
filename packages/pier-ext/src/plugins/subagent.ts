/**
 * subagent — master-only plugin entry: tool registration, action dispatch, the resume / send / interrupt /
 * output / role / list actions, and port binding. Inbound deps arrive via `pi-herdr.subagent-deps`; outbound
 * pipe/settle queries bind atomically onto `port.current`. Settlement reconcile stays in index session state
 * and is consumed here.
 */
import { Context } from '@deepseek-ai/cordis';
import { Type } from 'typebox';
import { basename, dirname, join } from 'node:path';
import { cordisGet } from '../cordis-services.ts';
import type { HerdrClientLike } from '../herdr-client.ts';
import {
  Semaphore,
  SUBAGENT_OUTPUT_SCHEMA,
  agoText,
  attachSubagentStructuredContent,
  buildAliveNotice,
  idParam,
  flattenToolParams,
  isAlive,
  newestPerTaskId,
  rekeySub,
  resolveTaskIdPrefix,
  taskIdResolutionError,
  tabNameForTask,
  subRef,
  type AliveProbe,
  type SubEntry,
  type SubagentPort,
  type SubagentPortBox,
} from '../subagent-core.ts';
import {
  appendHistory,
  applyReportedSessionFile,
  inheritOutcome,
  latestGeneration,
  preferredHistoryFile,
  readHistory,
  readHistoryTree,
  type HistoryEntry,
} from '../history-store.ts';
import { platformPaths } from '../platform-paths.ts';
import { toolError, ToolError } from '../tool-error.ts';
import { pipeNameFor, pipeRequestTo, type PipeRequest, type PipeResponse } from '../pipe-channel.ts';
import type { TerminalStateSlot } from './terminal.ts';
import { bareSessionId, resolveSessionFileValue } from '../session-tail.ts';
import { DELEGATION_ENV, type DelegationContext } from '../delegation-core.ts';
import type { JevRuntime } from '../jev-client.ts';
import { createGitIo, createSpawnAction, createSpawner } from '../subagent-spawn.ts';
import { createPoller } from '../subagent-poller.ts';
import { createGcController, createSubagentRegistry } from '../subagent-gc.ts';
import { createSessionIo, executeSubagentOutput, type SubagentOutputCursor } from '../subagent-session.ts';
import type { RoutingTelemetryRecord } from '../routing-telemetry.ts';

type ToolParams = Record<string, unknown> | undefined;

interface SubagentEnv {
  paneId: string;
  tabId: string;
  workspaceId: string;
}

export interface SubagentDeps {
  client: HerdrClientLike;
  env: SubagentEnv | null;
  /** Extension entry (index.ts) path — launchLine `-e`. */
  extPath: string;
  /** Master tree root (scope mount). */
  sessionRoot: Context;
  port: SubagentPortBox;
  getSessionId: () => string;
  reconcileOnSettlement: (description: string, outcome: 'settled' | 'failed') => string[];
  withReconcileNotes: (base: string, notes: readonly string[]) => string;
  claimSettleNotice: (key: string) => boolean;
  /** Settlement notice injector from index: buffer while busy, flush at turn_end. */
  deliverNotice?: (content: string, paneId?: string) => Promise<void>;
  /** Panes whose settlement notice is still buffered (GC exemption). */
  noticePending?: () => ReadonlySet<string>;
  /** Terminal-family GC exemption (live terminal panes are not collected). */
  terminalState: TerminalStateSlot;
  /** Optional jev seam (settle attribution check); absent → fail-open legacy behavior. */
  jev?: { ask: JevRuntime['ask']; getMinConfidence: () => number };
  /** Phase 0 routing telemetry (RFC rfc-jev-role-routing §8): spawn profile append; absent in tests. */
  logRouting?: (row: RoutingTelemetryRecord) => void;
}

/** Sent with every request: what a call needs. Details live in SUBAGENT_MANUAL (`action: "help"`). */
const SUBAGENT_DESCRIPTION = [
  'Delegate a self-contained task to a subagent: an isolated pi session in its own herdr pane (separate context — it does NOT see this conversation; a human can talk to it in that pane).',
  'Actions (default spawn): spawn | send | output | list | interrupt | resume | role | help.',
  'spawn: `prompt` is the COMPLETE task, since only the prompt reaches it; `description` labels the pane and is the todo-reconcile key — when delegating a todo entry, pass its content without the ` <sub>` marker and the entry auto-completes on settle. Several spawns in one message run in parallel (max 4).',
  'A foreground spawn BLOCKS this call for up to ~5 minutes; pass run_in_background: true for long tasks. A background (or timed-out foreground) worker\'s settlement notice arrives automatically at your next tool boundary — no need to sleep or poll.',
  'send: follow-up to a running or settled worker (steered between its tool calls). output: what it printed since your last check, plus its final report once done. resume: revive a collected task by taskId. role: switch a worker\'s role profile mid-session.',
  'help: the full manual (isolate/cwd/tab placement, role profiles, the delegation ledger).',
].join(' ');

/** Returned by `action: "help"`: the reference text that used to ride every request. */
const SUBAGENT_MANUAL = [
  'subagent manual',
  '',
  'spawn — the subagent shares this workspace and works independently; its result is its final text answer. Do not delegate the current step itself. Placement: by default panes group by git worktree — a subagent in your checkout shares your tab, one in a separate worktree gets its own tab named after the worktree directory. `tab` joins or creates a named task tab instead. `cwd` targets an existing directory or worktree (create worktrees with git worktree add).',
  '',
  'isolate (default false) — creates a FRESH git worktree (branch pier/<slug> from your HEAD under ~/.herdr/worktrees/<repo>/). Choose it for heavy independent writing in parallel with your own edits or other workers, or work needing its own clean reviewable diff; omit it for read-mostly or sequential helper work (shared checkout, writes guarded by the write-lock); use cwd for an existing directory/worktree. Its writes cannot conflict with your checkout, its prompt is prefixed with commit discipline (commit to its own branch, never push), and on settle you get a diff summary (commits since base, files changed, uncommitted count). Review with git log/diff HEAD..<branch>, merge with git merge --no-ff <branch>; once merged and clean the worktree auto-removes (branch kept). Mutually exclusive with cwd.',
  '',
  'role + allowed_tools — when role matches a profile (searched: workspace .pi-herdr/roles/ → user-global ~/.pi/agent/herdr-pi/roles/ → builtin), the worker toolset becomes baseline ∪ allowed_tools minus role-deny tools (deny always wins). Custom roles: drop a JSON profile into .pi-herdr/roles/ (master/worker-default reserved). Unknown role names stay display labels. action role switches a live worker (pi transcript tool delta: applies on its next request, survives resume); the reply reports the tool diff.',
  '',
  'list — background subagents with live state (running / idle), pane ids, last activity, role and description; foreground one-shot panes are not listed.',
  '',
  'output — `agentId` required; returns the delta since your last output call (default 6000 chars, max_chars 100-16000) with status (running/idle/blocked/settled), revision and a truncated flag. TUI chrome is stripped; once the worker has finished, the complete transcript report is attached. A "buffer scrolled or reset" note means the full text was returned — normal for fullscreen TUI panes.',
  '',
  'send — `agentId` + `message`: if working, delivered at its next tool-call gap (seconds); if idle or settled, wakes a new turn. Do not spawn a duplicate for the same task. interrupt — aborts its current turn; the pane stays and you can send again.',
  '',
  'resume — `taskId`: revives a collected subagent from the delegation ledger in a new pane (pi --session); then use send. The ledger is append-only JSONL, one row per status change (taskId, description, status running|settled|consumed|closed, outcome, paneId, sessionFile, launchCommand, createdAt), per checkout at ~/.pi/agent/herdr-pi/history/<flattened-cwd>/history.jsonl; resume searches every checkout this master spawned into. A still-running task is not resumed — use send or output.',
].join('\n');

const SUBAGENT_CONCURRENCY = 4;

function defaultAgentSessionsDir(): string {
  const base = process.env.PI_CODING_AGENT_DIR || platformPaths.agentDataDir;
  return join(base, 'sessions');
}

export default function subagentPlugin(ctx: Context): void {
  const surface = cordisGet(ctx, 'pi-herdr.surface');
  const d = cordisGet(ctx, 'pi-herdr.subagent-deps');
  const { client, env, sessionRoot, port, terminalState } = d;
  const pi = surface.raw as {
    appendEntry?: (customType: string, data: unknown) => void;
    /** Fire-and-forget in pi: the method returns void, not a promise. */
    sendUserMessage?: (content: string, opts?: { deliverAs?: string }) => void;
  };
  const scoped = surface.forModule(import.meta.url);

  const runtime = { nodePath: process.execPath, cliPath: process.argv[1] ?? '', extPath: d.extPath };
  const subSemaphore = new Semaphore(SUBAGENT_CONCURRENCY);
  /** B4: timestamps machine injection so grace-period working events are not mistaken for takeover. */
  const lastMachineInjectAt = new Map<string, number>();
  /* Registry persisted as custom branch state so a parent restart can rebuild it. */
  const subs = new Map<string, SubEntry>();
  const outputCursors = new Map<string, SubagentOutputCursor>();
  /** D98: excludes branches during the worktree-add-to-registry race from orphan collection. */
  const pendingIsolateBranches = new Set<string>();
  const lastRequestIdByPane = new Map<string, string>();
  /** Deduplicates gate notices while blocked but permits a later, distinct human question. */
  const blockedGateNotified = new Set<string>();

  /** B5: latest non-empty outcome per task, so closed generations do not hide settled results. */
  const lastOutcomeByTask = new Map<string, string>();

  function histFile(cwd: string): string {
    return preferredHistoryFile(dirname(defaultAgentSessionsDir()), cwd);
  }

  function toHistory(e: SubEntry, outcome: string | null): HistoryEntry {
    return {
      taskId: e.taskId,
      kind: e.kind,
      paneId: e.paneId,
      ...(e.slug ? { slug: e.slug } : {}),
      tabId: e.tabId,
      tabName: e.tabName,
      workspaceId: env?.workspaceId ?? '',
      cwd: e.cwd,
      description: e.description,
      sessionFile: e.sessionFile,
      launchCommand: e.launchCommand,
      status: e.status,
      outcome,
      createdAt: e.createdAt,
      consumedAt: e.consumedAt ?? null,
      closedAt: null,
      revivedFrom: e.revivedFrom ?? null,
    };
  }

  function writeHistory(e: SubEntry, patch?: Partial<HistoryEntry>, via?: string): void {
    const outcome = inheritOutcome(lastOutcomeByTask.get(e.taskId), patch?.outcome);
    if (typeof outcome === 'string' && outcome.length > 0) lastOutcomeByTask.set(e.taskId, outcome);
    appendHistory(histFile(e.cwd), { ...toHistory(e, outcome), ...(patch ?? {}), ...(via ? { via } : {}) });
  }

  const registry = createSubagentRegistry({ pi, client, subs, writeHistory });
  const { persist: persistSubs } = registry;
  const git = createGitIo();

  const boundPort: SubagentPort = {
    applyReplySession(paneId, sessionFile) {
      const entry = subs.get(paneId);
      if (!entry) return;
      // Workers self-report a BARE session id over the pipe; the .jsonl-only guard in applyReportedSessionFile
      // would discard it and freeze a mis-attributed sessionFile forever, so map the id to its transcript path.
      const reported = resolveSessionFileValue(entry.cwd, defaultAgentSessionsDir(), sessionFile);
      const next = applyReportedSessionFile(entry.sessionFile, reported);
      if (next === entry.sessionFile) return;
      entry.sessionFile = next;
      persistSubs();
      writeHistory(entry, undefined, 'session-report');
    },
    reconcileOnReply(paneId) {
      const entry = subs.get(paneId);
      return entry ? d.reconcileOnSettlement(entry.description, 'settled') : [];
    },
    listRunningSubs() {
      return [...subs.values()]
        .filter((s) => s.background && s.status === 'running')
        .map((s) => ({ paneId: s.paneId, slug: s.slug, description: s.description, kind: s.kind }));
    },
    listRows() {
      return [...subs.values()]
        .filter((s) => s.status !== 'closed')
        .map((s) => ({
          paneId: s.paneId,
          slug: s.slug,
          description: s.description,
          kind: s.kind,
          status: s.status,
          settledAt: s.consumedAt ?? null,
        }));
    },
    async settleStatLine(paneId) {
      const entry = subs.get(paneId);
      return entry ? await git.worktreeStatLine(entry) : null;
    },
    consumeReply(paneId, outcome) {
      const entry = subs.get(paneId);
      if (!entry || entry.status === 'consumed' || entry.status === 'closed') return;
      entry.status = 'consumed';
      entry.consumedAt = Date.now();
      persistSubs();
      writeHistory(entry, { outcome: outcome ?? null, status: 'consumed' }, 'pipe-reply');
    },
  };
  port.current = boundPort;
  ctx.effect(() => () => {
    if (port.current === boundPort) port.current = null;
  }, 'subagent-port');

  const injectNotice = (content: string, paneId?: string): Promise<void> => {
    if (d.deliverNotice) return d.deliverNotice(content, paneId);
    pi.sendUserMessage?.(content, { deliverAs: 'followUp' });
    return Promise.resolve();
  };

  const session = createSessionIo({ client, getSessionId: d.getSessionId, sessionsDir: defaultAgentSessionsDir });
  const spawn = createSpawner({ client, env, runtime, git });
  const poller = createPoller({
    client,
    sessionRoot,
    subs,
    persistSubs,
    writeHistory,
    blockedGateNotified,
    lastMachineInjectAt,
    session,
    git,
    injectNotice,
    reconcileOnSettlement: d.reconcileOnSettlement,
    withReconcileNotes: d.withReconcileNotes,
    claimSettleNotice: d.claimSettleNotice,
    ...(d.jev ? { jev: d.jev } : {}),
  });
  const { startPoller, pollers } = poller;
  const gc = createGcController({
    client,
    env,
    subs,
    persistSubs,
    writeHistory,
    terminalState,
    noticePending: d.noticePending,
    pendingIsolateBranches,
    git,
    injectNotice,
  });
  gc.startTicker(ctx);
  scoped.on('turn_start', () => gc.onTurnStart());
  const { readAskFlag, probeAlive } = session;
  const { spawnPaneInTaskTab, launchLine, approveFor, waitSubReady, findExistingPane } = spawn;

  /** P0-2: re-arm pollers for live running panes after a master restart, or settle notices stop arriving
   * and ledger rows stay 'running'. The `recover-*` requestId is never echoed by a worker, so this claim wins. */
  async function recoverRunningPollers(via: string): Promise<void> {
    if (!client.available) return;
    const running = [...subs.values()].filter((s) => s.background && s.status === 'running' && !pollers.has(s.paneId));
    if (running.length === 0) return;
    let livePaneIds: ReadonlySet<string>;
    try {
      livePaneIds = new Set((await client.listPanes()).map((p) => p.paneId));
    } catch {
      return; // liveness lookup failed → do not guess
    }
    const recovered: string[] = [];
    for (const entry of running) {
      if (!livePaneIds.has(entry.paneId)) continue; // zombie sweep already closed those
      try {
        await startPoller(entry.paneId, entry.cwd, entry.createdAt, entry.description, `recover-${via}-${entry.paneId}`);
        recovered.push(`${entry.paneId} (${entry.description})`);
      } catch {
      }
    }
    if (recovered.length > 0) {
      try {
        await injectNotice(
          `Session recovery (${via}): ${recovered.length} background subagent(s) still running — settlement watch re-armed for: ${recovered.join('; ')}.`,
        );
      } catch { /* non-fatal */ }
    }
  }

  scoped.on('session_start', async (_event: unknown, eventCtx: unknown) => {
    registry.rebuild(eventCtx);
    await registry.sweepZombieRunning();
    await recoverRunningPollers('session_start');
  });
  scoped.on('session_tree', async (_event: unknown, eventCtx: unknown) => {
    registry.rebuild(eventCtx);
    await registry.sweepZombieRunning();
    await recoverRunningPollers('session_tree');
  });

  /** B1: probe liveness before a "no output" subagent error enters model context, so the model
   * stops seizing work from a healthy subagent. */
  scoped.on('tool_result', async (rawEvent: unknown) => {
    const event = (rawEvent ?? {}) as { toolName?: string; isError?: boolean; content?: Array<{ type: string; text?: string }> };
    if (event.toolName !== 'subagent' || !event.isError) return;
    // Extract only pane ids carried by our own errors; leave unrelated errors untouched.
    const errText = (event.content ?? []).map((c) => c.text ?? '').join(' ');
    const paneId = [...subs.keys()].find((id) => errText.includes(id))
      ?? (errText.match(/\bw[A-Za-z0-9]+:p\d+\b/) ?? [])[0];
    if (!paneId) return;
    const entry = subs.get(paneId);
    if (!entry || entry.status === 'settled' || entry.status === 'consumed') return;
    const probe = await probeAlive(paneId, entry.cwd);
    if (!isAlive(probe, Date.now())) return; // keep the original error only when the agent is truly dead
    // Move a live agent to the poller so its eventual result replaces the false error.
    if (!pollers.has(paneId)) {
      entry.background = true;
      startPoller(paneId, entry.cwd, entry.createdAt, entry.description, lastRequestIdByPane.get(paneId) ?? `probe-${paneId}`);
      persistSubs();
    }
    return {
      content: [{ type: 'text', text: buildAliveNotice({ paneId, description: entry.description, scenario: 'error-alive', probe }, Date.now()) }],
    };
  });

  async function reviveEntry(entry: SubEntry): Promise<SubEntry> {
    // D98: never revive a released isolate worktree — its directory is gone and cwd is invalid.
    if (entry.isolate?.releasedAt != null) {
      throw new Error(`isolate worktree ${entry.isolate.branch} was released (merged) — delegate a new subagent instead`);
    }
    const latest = latestGeneration(readHistory(histFile(entry.cwd)), entry.taskId) ?? entry;
    // Never relaunch the master's own transcript in a worker pane (two pi processes competing on
    // one jsonl): a mis-attributed ledger entry degrades to a fresh conversation instead.
    const resumeFile = latest.sessionFile && /\.jsonl$/.test(latest.sessionFile)
      && bareSessionId(latest.sessionFile) !== bareSessionId(d.getSessionId())
      ? latest.sessionFile : null;
    // D86 trust matches spawn; revive has no tool context, so use the process cwd.
    const approve = await approveFor(entry.cwd, process.cwd());
    const spawned = await spawnPaneInTaskTab(
      { desiredTab: entry.tabName || latest.tabName || null, description: entry.description },
      entry.cwd,
      {
        PI_HERDR_SUBAGENT: '1',
        [DELEGATION_ENV]: JSON.stringify({
          parentPaneId: env?.paneId ?? '',
          parentSessionId: bareSessionId(d.getSessionId()),
          // todo_sync needs the master's pipe; kind 'task' maps to the composed default.
          parentPipe: pipeNameFor(process.cwd(), env?.paneId ?? ''),
          taskId: entry.taskId,
          description: entry.description,
          role: entry.kind === 'task' ? 'worker-default' : entry.kind,
        } satisfies DelegationContext),
      },
      launchLine(resumeFile, null, approve),
    );
    const ready = await waitSubReady(entry.cwd, spawned.paneId);
    if (!ready.ok) throw new Error(ready.message);
    Object.assign(entry, {
      paneId: spawned.paneId,
      tabId: spawned.tabId,
      tabName: spawned.tabName,
      sessionFile: resumeFile,
      status: 'running' as const,
      consumedAt: null,
      revivedFrom: latest.paneId,
      launchCommand: [launchLine(resumeFile, null, approve)],
      createdAt: Date.now(),
    });
    writeHistory(entry, undefined, 'revive');
    return entry;
  }

  /** Rebuild a registry row from its latest ledger row; `over` carries the caller's own fields
   *  (status, pane identity, timestamps) so the ledger projection cannot drift between callers. */
  function entryFromHistory(h: HistoryEntry, over: Partial<SubEntry>): SubEntry {
    return {
      taskId: h.taskId,
      kind: h.kind,
      paneId: h.paneId,
      ...(h.slug ? { slug: h.slug } : {}),
      tabId: h.tabId,
      tabName: h.tabName ?? '',
      cwd: h.cwd,
      description: h.description,
      background: true,
      status: 'closed',
      sessionFile: h.sessionFile,
      launchCommand: h.launchCommand,
      createdAt: h.createdAt,
      consumedAt: h.consumedAt ?? null,
      revivedFrom: h.paneId,
      ...over,
    };
  }

  function resolveSubEntry(rawId: string, cwd?: string): { entry: SubEntry } | { error: string } {
    if (!rawId) return { error: 'Error: unknown subagent id "" (see action list)' };
    const direct = subs.get(rawId);
    if (direct) return { entry: direct };
    // Phase 2 slug reference: exact match against live rows (paneId stays first for back-compat).
    // `slug@paneId` accepts both parts; a revived row changed its paneId, so the slug part wins then.
    const at = rawId.indexOf('@');
    const slugPart = at > 0 ? rawId.slice(0, at) : rawId;
    const panePart = at > 0 ? rawId.slice(at + 1) : null;
    const combined = panePart !== null
      ? (subs.get(panePart) ?? [...subs.values()].find((s) => s.slug === slugPart && s.paneId === panePart) ?? null)
      : null;
    if (combined) return { entry: combined };
    const bySlug = [...subs.values()].find((s) => s.slug === slugPart);
    if (bySlug) return { entry: bySlug };

    const byTaskId = newestPerTaskId(subs.values());
    const res = resolveTaskIdPrefix(rawId, byTaskId.keys());
    if (res.kind === 'resolved') return { entry: byTaskId.get(res.taskId)! };
    const resError = taskIdResolutionError(res, 'subagent id', rawId);
    if (resError) return { error: resError };

    if (cwd) {
      const hist = readHistory(histFile(cwd));
      const histRes = resolveTaskIdPrefix(rawId, Array.from(new Set(hist.map((e) => e.taskId))));
      if (histRes.kind === 'resolved') {
        const latest = latestGeneration(hist, histRes.taskId);
        if (latest) {
          const entry = entryFromHistory(latest, {});
          subs.set(entry.paneId, entry);
          return { entry };
        }
      }
      const histError = taskIdResolutionError(histRes, 'subagent id', rawId);
      if (histError) return { error: histError };
    }
    return { error: `Error: unknown subagent id "${rawId}" (see action list)` };
  }

  function targetOf(params: ToolParams, toolCtx: unknown): { entry: SubEntry; cwd: string } {
    const cwd = (toolCtx as { cwd?: string })?.cwd ?? process.cwd();
    const resolved = resolveSubEntry(idParam(params, 'agentId', 'taskId'), cwd);
    if ('error' in resolved) toolError(resolved.error);
    return { entry: resolved.entry, cwd };
  }

  async function ensureLive(entry: SubEntry): Promise<void> {
    if (entry.status !== 'closed') return;
    const previousPaneId = entry.paneId;
    await reviveEntry(entry);
    rekeySub(subs, previousPaneId, entry);
    persistSubs();
  }

  async function executeSubagentResume(params: ToolParams) {
    if (!client.available) return toolError('requires a herdr-managed pane.');
    const rawTaskId = idParam(params, 'taskId', 'agentId');
    if (!rawTaskId) return toolError('missing taskId for resume (see action list or delegation ledger).');
    const running = newestPerTaskId([...subs.values()].filter((s) => s.background && s.status === 'running'));
    const live = resolveTaskIdPrefix(rawTaskId, running.keys());
    const liveError = taskIdResolutionError(live, 'task id', rawTaskId);
    if (liveError) return toolError(liveError);
    if (live.kind === 'resolved') {
      const entry = running.get(live.taskId)!;
      return {
        content: [{ type: 'text', text: `task ${entry.taskId} is already running as pane ${entry.paneId}. Use action send or output; resume is only for a collected task whose pane is gone.` }],
        details: { paneId: entry.paneId, taskId: entry.taskId, alreadyRunning: true },
      };
    }
    const history = readHistoryTree(dirname(defaultAgentSessionsDir()));
    const resolution = resolveTaskIdPrefix(rawTaskId, history.map((e) => e.taskId));
    if (resolution.kind !== 'resolved') {
      return toolError(taskIdResolutionError(resolution, 'task id', rawTaskId)
        ?? `Error: no history for task "${rawTaskId}" in this workspace or its spawned checkouts.`);
    }
    const taskId = resolution.taskId;
    const latest = latestGeneration(history, taskId);
    if (!latest) return toolError(`Error: no history for task "${taskId}" in this workspace or its spawned checkouts.`);

    const release = await subSemaphore.acquire();
    try {
      // D94: reuse an existing pane for the same session to avoid competing pi processes.
      const existing = await findExistingPane(latest.sessionFile);
      // A ledger sessionFile mis-attributed to the master's own transcript would match the MASTER pane here,
      // registering the master as its own subagent (later consumed, then closed by GC mid-run) — never adopt self.
      if (existing?.paneId === env?.paneId) {
        return toolError(
          `Error: task ${taskId} is attributed to the master's own session (mis-recorded sessionFile in the ledger); it cannot be resumed here — spawn a fresh subagent for this work instead.`,
        );
      }
      const entry = entryFromHistory(latest, {
        paneId: existing?.paneId ?? '',
        tabId: existing?.tabId ?? '',
        tabName: latest.tabName ?? tabNameForTask(latest.description),
        status: 'running',
        createdAt: Date.now(),
        consumedAt: null,
      });
      if (existing) {
        subs.set(entry.paneId, entry);
        persistSubs();
        writeHistory(entry, undefined, 'resume');
      } else {
        await reviveEntry(entry);
        subs.set(entry.paneId, entry);
        persistSubs();
      }
      const how = existing
        ? 'reused existing pane with same session; pi still running there'
        : entry.sessionFile ? 'session restored' : 'session file missing; fresh conversation';
      return {
        content: [{ type: 'text', text: `resumed subagent ${subRef(entry)} from task ${taskId} (${how}).` }],
        details: { paneId: entry.paneId, taskId },
      };
    } catch (err) {
      if (err instanceof ToolError) throw err;
      return toolError(`Error: failed to resume task "${taskId}": ${(err as Error).message}`);
    } finally {
      release();
    }
  }

  /** The shared spine of every id-carrying action: revive a closed row, wait for its pipe, send one request,
   *  fold failures into the error wording. `interrupt` passes `ready: false` (a closed target is a no-op). */
  async function pipeAction(
    entry: SubEntry,
    opts: {
      /** One request from the closed pipe protocol; its `type`/`id` drive the reply and settle keys. */
      build(): PipeRequest;
      ok(res: Extract<PipeResponse, { type: 'ok' }>, reqId: string): unknown;
      fail?(paneId: string): string;
      ready?: false;
    },
  ): Promise<unknown> {
    try {
      if (opts.ready !== false) {
        await ensureLive(entry);
        const ready = await waitSubReady(entry.cwd, entry.paneId);
        if (!ready.ok) throw new Error(ready.message);
      }
      const payload = opts.build();
      const res = await pipeRequestTo(entry.cwd, entry.paneId, payload);
      if (res.type !== 'ok') {
        throw new Error(`pipe ${payload.type} rejected: ${res.type === 'error' ? res.message : 'unknown response'}`);
      }
      return opts.ok(res, payload.id);
    } catch (err) {
      const what = opts.fail?.(entry.paneId) ?? `failed to reach subagent ${entry.paneId}`;
      return toolError(`Error: ${what}: ${(err as Error).message}`);
    }
  }

  /** Follow_up goes through the extension pipe with steering so supplemental instructions reach a
   * long-running worker within seconds during a tool-call gap; a plain queue waits for the run. */
  function executeSubagentSend(params: ToolParams, toolCtx: unknown) {
    const { entry, cwd } = targetOf(params, toolCtx);
    return pipeAction(entry, {
      build: () => ({
        type: 'follow_up',
        id: `fu-${Date.now()}`,
        text: String(params?.message ?? ''),
        // The reply pipe is the MASTER's (bound at session_start with this session's cwd);
        // entry.cwd would name a dead pipe for cross-repo workers.
        from: pipeNameFor(cwd, env?.paneId ?? ''),
        push: true,
        steer: true,
      }),
      ok: (_res, reqId) => {
        lastMachineInjectAt.set(entry.paneId, Date.now()); // B4: attribute working state during the observation window
        // An exception between status='running' and startPoller would leave a ghost running entry
        // with no poller (never settles, skipped by GC): roll back the status on failure.
        const prevStatus = entry.status;
        entry.status = 'running';
        persistSubs();
        try {
          lastRequestIdByPane.set(entry.paneId, reqId);
          startPoller(entry.paneId, entry.cwd, Date.now(), entry.description, reqId);
        } catch (inner) {
          entry.status = prevStatus;
          persistSubs();
          throw inner;
        }
        return { content: [{ type: 'text', text: `Message sent to subagent ${subRef(entry)}.` }], details: { paneId: entry.paneId } };
      },
    });
  }

  async function executeSubagentInterrupt(params: ToolParams, toolCtx: unknown) {
    const { entry } = targetOf(params, toolCtx);
    if (entry.status === 'closed') {
      return { content: [{ type: 'text', text: `Interrupt accepted for subagent ${subRef(entry)} (already idle/closed; no-op).` }], details: {} };
    }
    return pipeAction(entry, {
      ready: false,
      build: () => ({ type: 'interrupt', id: `int-${Date.now()}` }),
      ok: () => {
        // No settlement notice for an interrupted turn: the requester already knows.
        const lastId = lastRequestIdByPane.get(entry.paneId);
        if (lastId) d.claimSettleNotice(`${entry.paneId}:${lastId}`);
        return { content: [{ type: 'text', text: `Interrupt accepted for subagent ${subRef(entry)} (fire-and-return).` }], details: { paneId: entry.paneId } };
      },
    });
  }

  async function executeSubagentRole(params: ToolParams, toolCtx: unknown) {
    const roleName = String(params?.role ?? '').trim();
    if (!roleName) return toolError('Error: action "role" requires a target profile in `role` (same resolution as spawn)');
    const { entry } = targetOf(params, toolCtx);
    return pipeAction(entry, {
      fail: (id) => `failed to switch subagent ${id} to role ${roleName}`,
      build: () => ({ type: 'role', id: `role-${Date.now()}`, role: roleName }),
      ok: (res) => ({
        content: [{ type: 'text', text: `Subagent ${entry.paneId}: ${res.detail ?? `switched to ${roleName}`}` }],
        details: { paneId: entry.paneId, role: roleName },
      }),
    });
  }

  /** Live background registry, newest row per task; closed rows stay visible so send can revive them. */
  async function executeSubagentList() {
    const listed = [...subs.values()].filter((sub) => sub.background);
    if (listed.length === 0) {
      return { content: [{ type: 'text', text: 'No background subagents started (from this session branch).' }], details: {} };
    }
    const byTask = newestPerTaskId(listed);
    const probes = new Map<string, AliveProbe>();
    await Promise.all([...byTask.values()].map(async (sub) => {
      if (sub.status === 'closed') return;
      try {
        probes.set(sub.paneId, await probeAlive(sub.paneId, sub.cwd));
      } catch { /* best effort for display */ }
    }));
    const now = Date.now();
    const lines: string[] = [];
    for (const sub of byTask.values()) {
      const tabTag = sub.tabName ? ` [tab: ${sub.tabName}]` : '';
      // The branch (`pier/<slug>`) is not a directory; printing it made masters cd into
      // `<repo>/pier/<slug>`. Always print the absolute worktree path they can actually enter.
      const wtTag = sub.isolate ? ` [wt: ${sub.isolate.worktreePath}]` : '';
      if (sub.status === 'closed') {
        lines.push(`${sub.taskId.slice(0, 8)} [idle] (${sub.kind}, closed; action send revives)${tabTag}${wtTag} ${sub.description}`);
        continue;
      }
      if (sub.status === 'consumed' || sub.status === 'settled') {
        lines.push(`${subRef(sub)} [idle] (${sub.kind}, settled; action send revives)${tabTag}${wtTag} ${sub.description}`);
        continue;
      }
      const state = 'running';
      const takeoverMark = sub.userTakeover ? ', user-controlled' : '';
      const probe = probes.get(sub.paneId);
      const statusTag = probe?.agentStatus ? ` ${probe.agentStatus}` : '';
      const activityTag = probe?.lastActivityMs != null ? `, active ${agoText(probe.lastActivityMs, now)}` : '';
      let gateTag = '';
      if (probe?.agentStatus === 'blocked') {
        const question = await readAskFlag(sub.paneId);
        gateTag = question ? ` — AWAITING HUMAN: "${question}"` : ' — AWAITING HUMAN decision';
      }
      const cwdTag = probe?.foregroundCwd && probe.foregroundCwd !== sub.cwd
        ? ` [cwd: ${basename(probe.foregroundCwd) || probe.foregroundCwd}]`
        : '';
      lines.push(`${subRef(sub)} [${state}${takeoverMark}${statusTag}${activityTag}${gateTag}] (${sub.kind})${tabTag}${wtTag}${cwdTag} ${sub.description}`);
    }
    return { content: [{ type: 'text', text: lines.join('\n') }], details: {} };
  }

  const executeSubagentSpawn = createSpawnAction({
    client,
    env,
    subSemaphore,
    subs,
    persistSubs,
    writeHistory,
    pendingIsolateBranches,
    lastMachineInjectAt,
    lastRequestIdByPane,
    git,
    session,
    spawn,
    poller,
    getSessionId: d.getSessionId,
    ...(d.logRouting ? { logRouting: d.logRouting } : {}),
  });

  const outputActionDeps = {
    client,
    resolveEntry: (rawId: string, cwd: string) => resolveSubEntry(rawId, cwd),
    outputCursors,
    getCwd: (toolCtx: unknown): string => (toolCtx as { cwd?: string })?.cwd ?? process.cwd(),
    // Transcript fallback: small worker panes show only the opaque status overlay, so the pane delta can never
    // carry the final report. No preferred file — start from herdr's per-pane report, not a stale registry value.
    readFinalReport: async (paneId: string, entryCwd: string) =>
      (await session.subSessionState(paneId, entryCwd, 0)).text,
    persistSubs,
  };

  const ACTIONS: Record<string, (params: ToolParams, toolCtx: unknown, onUpdate?: (u: unknown) => void) => Promise<unknown>> = {
    spawn: (params, toolCtx, onUpdate) => executeSubagentSpawn(params, toolCtx, onUpdate),
    resume: (params) => executeSubagentResume(params),
    list: () => executeSubagentList(),
    send: (params, toolCtx) => executeSubagentSend(params, toolCtx),
    interrupt: (params, toolCtx) => executeSubagentInterrupt(params, toolCtx),
    output: (params, toolCtx) => executeSubagentOutput(params, toolCtx, outputActionDeps),
    role: (params, toolCtx) => executeSubagentRole(params, toolCtx),
    help: async () => ({ content: [{ type: 'text', text: SUBAGENT_MANUAL }], details: {} }),
  };

  scoped.registerTool({
    name: 'subagent',
    label: 'Subagent',
    // B4: the model picks tools from the system prompt's snippet/guideline surface; delegation
    // decisions are made here, so state them rather than hoping for recall.
    promptSnippet: 'subagent: delegate a self-contained task to a pi worker pane (spawn/isolate/background/send/output/interrupt/resume/list/role/help).',
    promptGuidelines: [
      'Use subagent for self-contained work whose result is what matters: output that would flood this context, long builds/test runs, or independent parts of a bigger change that can run in parallel.',
      'The worker does not see this conversation: put paths, acceptance criteria, the test command and what to report back into the prompt.',
      'Use isolate: true when the worker writes files you or another worker edit at the same time, or when its work needs its own reviewable branch.',
      'Pass agentId, taskId, message and max_chars as top-level arguments, not inside a parameters object.',
    ],
    description: SUBAGENT_DESCRIPTION,
    parameters: Type.Object({
      action: Type.Optional(Type.Union([
        Type.Literal('spawn'),
        Type.Literal('resume'),
        Type.Literal('list'),
        Type.Literal('send'),
        Type.Literal('interrupt'),
        Type.Literal('output'),
        Type.Literal('role'),
        Type.Literal('help'),
      ], { description: 'Default spawn' })),
      description: Type.Optional(Type.String({ description: '[spawn] Pane label; also the todo-reconcile key' })),
      prompt: Type.Optional(Type.String({ description: '[spawn] The complete self-contained task' })),
      run_in_background: Type.Optional(Type.Boolean({ description: '[spawn] Return at once; the settlement notice arrives later (default false)' })),
      cwd: Type.Optional(Type.String({ description: '[spawn] Existing directory or worktree to run in (absolute or workspace-relative); exclusive with isolate' })),
      isolate: Type.Optional(Type.Boolean({ description: '[spawn] Run in a fresh git worktree (branch pier/<slug>) for heavy parallel writes or a reviewable diff; settle reports a diff summary (see help)' })),
      role: Type.Optional(Type.String({ description: '[spawn|role] Role profile name; unknown names are display labels only' })),
      tab: Type.Optional(Type.String({ description: '[spawn] Task tab to join or create (default: grouped by worktree)' })),
      allowed_tools: Type.Optional(Type.Array(Type.String(), { description: '[spawn] Extra tools on top of the role baseline' })),
      taskId: Type.Optional(Type.String({ description: '[resume] Task id from the delegation ledger' })),
      agentId: Type.Optional(Type.String({ description: '[send|interrupt|output|role] Slug, pane id, or slug@paneId as printed by spawn/list' })),
      message: Type.Optional(Type.String({ description: '[send] Follow-up message' })),
      max_chars: Type.Optional(Type.Integer({ description: '[output] Output cap (default 6000, 100-16000)' })),
    }),
    outputSchema: SUBAGENT_OUTPUT_SCHEMA,
    // B2: `action` is optional in the schema; normalize it so the validated arguments and the
    // code path never disagree and `spawn` is explicit in logs.
    prepareArguments: (args: unknown) => {
      const rec = flattenToolParams(args && typeof args === 'object' ? args as Record<string, unknown> : {}) ?? {};
      const hasAction = typeof rec.action === 'string' && rec.action.trim() !== '';
      return hasAction ? rec : { ...rec, action: 'spawn' };
    },
    async execute(toolCallId: string, params: ToolParams, signal: AbortSignal | undefined, onUpdate: ((update: unknown) => void) | undefined, toolCtx: unknown) {
      void toolCallId;
      void signal;
      const flat = flattenToolParams(params);
      const action = typeof flat?.action === 'string' && flat.action.trim() ? flat.action.trim() : 'spawn';
      const handler = ACTIONS[action];
      if (!handler) {
        return toolError(`Error: unknown action "${action}" (valid: ${Object.keys(ACTIONS).join(', ')})`);
      }
      return attachSubagentStructuredContent(action, await handler(flat, toolCtx, onUpdate));
    },
  });
}
