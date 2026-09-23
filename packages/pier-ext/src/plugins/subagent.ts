/**
 * subagent — master-only plugin entry: tool registration, action dispatch, the resume / send / interrupt /
 * output / role / list actions, and port binding. Inbound deps arrive via `pi-herdr.subagent-deps`; outbound
 * pipe/settle queries bind atomically onto `port.current`. Settlement reconcile stays in index session state
 * and is consumed here.
 */
import { Context } from '@deepseek-ai/cordis';
import { Type } from 'typebox';
import { basename, dirname, join } from 'node:path';
import type { PiSurface } from '../pi-surface.ts';
import type { HerdrClientLike } from '../herdr-client.ts';
import {
  Semaphore,
  agoText,
  ambiguousIdError,
  buildAliveNotice,
  idParam,
  isAlive,
  newestPerTaskId,
  rekeySub,
  resolveTaskIdPrefix,
  tabNameForTask,
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
  type HistoryEntry,
} from '../history-store.ts';
import { platformPaths } from '../platform-paths.ts';
import { toolError, ToolError } from '../tool-error.ts';
import { pipeNameFor, pipeRequestTo, type PipeRequest, type PipeResponse } from '../pipe-channel.ts';
import type { TerminalStateSlot } from './terminal.ts';
import { bareSessionId, resolveSessionFileValue } from '../session-tail.ts';
import { createGitIo, createSpawnAction, createSpawner } from '../subagent-spawn.ts';
import type { JevRuntime } from '../jev-client.ts';
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

const SUBAGENT_DESCRIPTION = [
  'Delegate a self-contained subtask to an isolated subagent that runs in its own herdr pane as an interactive pi session (separate context window; it does NOT see this conversation). A human can also open that pane and talk to the subagent directly.',
  '`action` (optional, default "spawn"): spawn | resume | list | send | interrupt | output | role.',
  '[spawn] `description`: short display label for the pane; `prompt`: the COMPLETE task — include all needed context, since only the prompt reaches the subagent. The description also doubles as the todo-reconcile key: when delegating a todo entry, use the entry content WITHOUT its ` <sub>` marker as the description, and the entry is auto-completed when this subagent settles.',
  '[spawn] The subagent shares this workspace and works independently; the result is its final text answer.',
  '[spawn] Concurrent delegation is supported: several spawn calls in one message run in parallel (at most 4 at once). Use this for well-scoped, independent subtasks; do not delegate the current step itself.',
  '[spawn] `run_in_background` (default false): when true, the call returns immediately with an agentId; the subagent keeps running in its pane. Use action list to see its state, action send to give it follow-up work, action interrupt to stop it. When it settles, you receive a notification message with its closing output.',
  '[spawn] `tab` (optional): name of a task tab to place the subagent into (join if a tab with this name exists, otherwise create it). Overrides the default placement. Default placement groups by git worktree: a subagent working in your checkout shares your tab; one working in a separate worktree (pass its path via `cwd`; create worktrees with `git worktree add`) gets its own tab named after the worktree directory.',
  '[spawn] `role` + `allowed_tools`: when role matches a profile (searched: workspace .pi-herdr/roles/ → user-global ~/.pi/agent/herdr-pi/roles/ → builtin), the worker toolset becomes the composed manifest — baseline ∪ allowed_tools minus role-deny tools (deny always wins). Custom roles: drop a JSON profile into .pi-herdr/roles/ (master/worker-default reserved). Unknown role names remain display labels only.',
  '[spawn] `isolate` (default false): creates a FRESH git worktree for this subagent and runs it there (branch pier/<slug> from your HEAD under ~/.herdr/worktrees/<repo>/). Three-way choice: heavy independent writing in parallel with your own edits or other workers, or work needing its own clean reviewable diff → isolate; read-mostly or sequential helper work → omit (shared checkout, writes guarded by the write-lock); targeting an existing directory/worktree → cwd. In isolate mode the subagent\'s writes cannot conflict with your checkout; its panes group into a tab named after the worktree; its prompt is prefixed with commit discipline (commit to its own branch, NEVER push); when it settles you get a diff summary (commits since base, files changed, uncommitted count). Review with git log/diff HEAD..<branch>, merge with git merge --no-ff <branch>; once merged and clean the worktree auto-removes (branch kept). Mutually exclusive with cwd.',
  '[resume] `taskId`: revive a finished (collected) subagent from the delegation ledger — opens its saved conversation in a new pane (pi --session), then use action send to give it new work. The ledger is an append-only JSONL file, one row per status change (same taskId rows = generations, latest row is current): fields taskId, description, status (running|settled|consumed|closed), outcome (closing text), paneId, sessionFile, launchCommand, createdAt. It is per-checkout at ~/.pi/agent/herdr-pi/history/<flattened-cwd>/history.jsonl. Use action list for live panes from this session; for earlier sessions or closed panes, grep the ledger for the taskId.',
  '[list] no extra parameters: list background subagents with live state (running / idle), pane ids, last activity, role, and descriptions. Foreground one-shot panes are not listed.',
  '[output] `agentId` (required, the subagent pane id): view incremental output of a running or background subagent since the last output call. Text returned to the model is bounded (default 6000 chars) with status metadata (running/idle/blocked/settled), revision, and a truncated flag. When the delta cannot be computed the full text is returned with a "buffer scrolled or reset" note — that is normal for fullscreen TUI panes, not a crash indicator. Use this to observe subagent progress before settlement.',
  '[interrupt] `agentId`: abort the current turn (fire-and-return). The pane stays; you can send again.',
  '[role] `agentId` + `role`: switch that worker\'s role profile mid-session (pi 0.86 transcript tool delta — the new toolset applies on its next request and survives resume). Same role resolution as spawn; the reply reports the tool diff. Use when a task outgrew its delegation (needs more tools) or should be narrowed.',
  '[send] `agentId` + `message`: follow-up to a background subagent. If working, delivered at next tool-call gap (steer, seconds); if idle, wakes a new turn. After settle, send to wake it; do not spawn a duplicate.',
].join(' ');

const SUBAGENT_CONCURRENCY = 4;

function defaultAgentSessionsDir(): string {
  const base = process.env.PI_CODING_AGENT_DIR || platformPaths.agentDataDir;
  return join(base, 'sessions');
}

export default function subagentPlugin(ctx: Context): void {
  const surface = ctx.get('pi-herdr.surface') as PiSurface<object>;
  const d = ctx.get('pi-herdr.subagent-deps') as SubagentDeps;
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
        .map((s) => ({ paneId: s.paneId, description: s.description }));
    },
    async settleStatLine(paneId) {
      const entry = subs.get(paneId);
      return entry ? await git.worktreeStatLine(entry) : null;
    },
  };
  port.current = boundPort;
  ctx.effect(() => () => {
    if (port.current === boundPort) port.current = null;
  }, 'subagent-port');

  const injectNotice = (content: string): Promise<void> => {
    if (d.deliverNotice) return d.deliverNotice(content);
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
      { PI_HERDR_SUBAGENT: '1' },
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

    const byTaskId = newestPerTaskId(subs.values());
    const res = resolveTaskIdPrefix(rawId, byTaskId.keys());
    if (res.kind === 'resolved') return { entry: byTaskId.get(res.taskId)! };
    if (res.kind === 'ambiguous') return { error: ambiguousIdError('subagent id', rawId, res.candidates) };
    if (res.kind === 'too_short') return { error: `Error: subagent id prefix "${rawId}" is too short (minimum 4 characters).` };

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
      if (histRes.kind === 'ambiguous') return { error: ambiguousIdError('subagent id', rawId, histRes.candidates) };
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

  async function executeSubagentResume(params: ToolParams, toolCtx: unknown) {
    if (!client.available) return toolError('requires a herdr-managed pane.');
    const cwd = (toolCtx as { cwd?: string })?.cwd ?? process.cwd();
    const rawTaskId = idParam(params, 'taskId', 'agentId');
    if (!rawTaskId) return toolError('missing taskId for resume (see action list or delegation ledger).');
    const history = readHistory(histFile(cwd));
    const resolution = resolveTaskIdPrefix(rawTaskId, history.map((e) => e.taskId));
    if (resolution.kind === 'too_short') {
      return toolError(`Error: task id prefix "${rawTaskId}" is too short (minimum 4 characters).`);
    }
    if (resolution.kind === 'ambiguous') return toolError(ambiguousIdError('task id', rawTaskId, resolution.candidates));
    if (resolution.kind === 'not_found') return toolError(`Error: no history for task "${rawTaskId}" in this workspace.`);
    const taskId = resolution.taskId;
    const latest = latestGeneration(history, taskId);
    if (!latest) return toolError(`Error: no history for task "${taskId}" in this workspace.`);

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
        cwd,
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
        content: [{ type: 'text', text: `resumed subagent ${entry.paneId} from task ${taskId} (${how}).` }],
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
        return { content: [{ type: 'text', text: `Message sent to subagent ${entry.paneId}.` }], details: { paneId: entry.paneId } };
      },
    });
  }

  async function executeSubagentInterrupt(params: ToolParams, toolCtx: unknown) {
    const { entry } = targetOf(params, toolCtx);
    if (entry.status === 'closed') {
      return { content: [{ type: 'text', text: `Interrupt accepted for subagent ${entry.paneId} (already idle/closed; no-op).` }], details: {} };
    }
    return pipeAction(entry, {
      ready: false,
      build: () => ({ type: 'interrupt', id: `int-${Date.now()}` }),
      ok: () => {
        // No settlement notice for an interrupted turn: the requester already knows.
        const lastId = lastRequestIdByPane.get(entry.paneId);
        if (lastId) d.claimSettleNotice(`${entry.paneId}:${lastId}`);
        return { content: [{ type: 'text', text: `Interrupt accepted for subagent ${entry.paneId} (fire-and-return).` }], details: { paneId: entry.paneId } };
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
      const wtTag = sub.isolate ? ` [wt: ${sub.isolate.branch}]` : '';
      if (sub.status === 'closed') {
        lines.push(`${sub.taskId.slice(0, 8)} [idle] (${sub.kind}, closed; action send revives)${tabTag}${wtTag} ${sub.description}`);
        continue;
      }
      const state = sub.status === 'settled' ? 'idle' : 'running';
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
      lines.push(`${sub.paneId} [${state}${takeoverMark}${statusTag}${activityTag}${gateTag}] (${sub.kind})${tabTag}${wtTag}${cwdTag} ${sub.description}`);
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
  };

  const ACTIONS: Record<string, (params: ToolParams, toolCtx: unknown, onUpdate?: (u: unknown) => void) => Promise<unknown>> = {
    spawn: (params, toolCtx, onUpdate) => executeSubagentSpawn(params, toolCtx, onUpdate),
    resume: (params, toolCtx) => executeSubagentResume(params, toolCtx),
    list: () => executeSubagentList(),
    send: (params, toolCtx) => executeSubagentSend(params, toolCtx),
    interrupt: (params, toolCtx) => executeSubagentInterrupt(params, toolCtx),
    output: (params, toolCtx) => executeSubagentOutput(params, toolCtx, outputActionDeps),
    role: (params, toolCtx) => executeSubagentRole(params, toolCtx),
  };

  scoped.registerTool({
    name: 'subagent',
    label: 'Subagent',
    // B4: the model picks tools from the system prompt's snippet/guideline surface; delegation
    // decisions are made here, so state them rather than hoping for recall.
    promptSnippet: 'subagent: delegate a self-contained task to a pi worker pane (spawn/isolate/background/send/output/interrupt/resume/list/role).',
    promptGuidelines: [
      'Use subagent when the work is self-contained and the result is what matters: pipelines that would flood this context, long builds/test runs, or independent parts of a bigger change that can proceed in parallel.',
      'Prefer run_in_background: true for work that will not finish in a few tool calls, then collect with action: "output" — a foreground subagent blocks this turn.',
      'Use isolate: true when the worker will write files for a task you (or another worker) are editing at the same time, or when you want its own reviewable branch; use cwd to send work into an existing worktree (create it with git worktree add first).',
      'Keep the prompt complete and self-contained: the worker does not see this conversation, so include paths, acceptance criteria, the test command, and what to report back.',
      'Do not poll with action: "output" in a tight loop: the pane pushes a settlement notice when it finishes. Check once, then continue other work.',
      'Send follow-up instructions with action: "send" (delivered as a steer between tool calls) instead of spawning a second worker for the same task.',
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
      ], { description: 'Operation to perform (default: spawn)' })),
      description: Type.Optional(Type.String({ description: '[spawn] Short label for this subtask (pane title)' })),
      prompt: Type.Optional(Type.String({ description: '[spawn] The complete self-contained task for the subagent' })),
      run_in_background: Type.Optional(Type.Boolean({ description: '[spawn] Return immediately with an agentId; the subagent keeps running in its own pane (default false)' })),
      cwd: Type.Optional(Type.String({ description: '[spawn] Working directory for the subagent (absolute, or relative to this workspace). Use it to delegate into a git worktree: panes group by worktree — same checkout as you share your tab; a separate worktree gets its own tab named after the worktree directory. Create worktrees yourself with git worktree add. Use isolate:true instead when you want a FRESH worktree created for this task rather than targeting an existing one' })),
      isolate: Type.Optional(Type.Boolean({ description: '[spawn] Create a fresh git worktree and run the subagent there. Use when the task writes files heavily and independently — in parallel with your own edits or other workers\' — or needs its own clean, reviewable diff. For read-mostly or sequential helper work omit it (shared checkout, writes guarded by the write-lock); use `cwd` only to target an existing directory/worktree (e.g. a retained pier worktree). Mechanics: branch pier/<slug> from your HEAD under ~/.herdr/worktrees/<repo>/; its writes cannot conflict with your checkout; panes group into a tab named after the worktree; the prompt is prefixed with commit discipline (commit to its branch, never push); on settle you get a diff summary. Review with git log/diff HEAD..<branch>, merge with git merge --no-ff <branch>; once merged and clean the worktree auto-removes (branch kept). Mutually exclusive with cwd' })),
      role: Type.Optional(Type.String({ description: '[spawn|role] Role label or profile name. [spawn] When role matches a profile (searched: workspace .pi-herdr/roles/ → user-global ~/.pi/agent/herdr-pi/roles/ → builtin), the worker toolset becomes the composed manifest. Unknown role names remain display labels only. [role] Target profile for the mid-session switch' })),
      tab: Type.Optional(Type.String({ description: '[spawn] Name of a task tab to place the subagent into (join if exists, otherwise create). Default placement groups by git worktree.' })),
      allowed_tools: Type.Optional(Type.Array(Type.String(), { description: '[spawn] Additional tools for role composition (union with role baseline)' })),
      taskId: Type.Optional(Type.String({ description: '[resume] The task id to revive from the delegation ledger' })),
      agentId: Type.Optional(Type.String({ description: '[send|interrupt|output|role] The subagent id (herdr pane id)' })),
      message: Type.Optional(Type.String({ description: '[send] The follow-up message' })),
      max_chars: Type.Optional(Type.Integer({ description: '[output] Maximum characters of output delta to return (default 6000, 100-16000)' })),
    }),
    // B2: `action` is optional in the schema; normalize it so the validated arguments and the
    // code path never disagree and `spawn` is explicit in logs.
    prepareArguments: (args: unknown) => {
      const rec = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
      const hasAction = typeof rec.action === 'string' && rec.action.trim() !== '';
      return hasAction ? rec : { ...rec, action: 'spawn' };
    },
    async execute(toolCallId: string, params: ToolParams, signal: AbortSignal | undefined, onUpdate: ((update: unknown) => void) | undefined, toolCtx: unknown) {
      void toolCallId;
      void signal;
      const action = typeof params?.action === 'string' && params.action.trim() ? params.action.trim() : 'spawn';
      const handler = ACTIONS[action];
      if (!handler) {
        return toolError(`Error: unknown action "${action}" (valid: ${Object.keys(ACTIONS).join(', ')})`);
      }
      return handler(params, toolCtx, onUpdate);
    },
  });
}
