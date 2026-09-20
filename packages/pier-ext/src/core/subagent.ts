/**
 * core/subagent — master-only loader entry (tools, registry, poller, GC).
 *
 * Inbound deps via `pi-herdr.subagent-deps`. Outbound pipe/settle queries bind
 * atomically onto `port.current` (see subagent-port.ts). Settlement reconcile
 * stays in index session state; this plugin consumes it through the port.
 */
import { Context } from '@deepseek-ai/cordis';
import { Type } from 'typebox';
import { join, dirname } from 'node:path';
import type { PiSurface } from '../pi-surface.ts';
import type { HerdrClientLike } from '../herdr-client.ts';
import { Semaphore, buildAliveNotice, isAlive, tabNameForTask, type SubEntry } from '../subagent-core.ts';
import { applyReportedSessionFile, appendHistory, preferredHistoryFile, inheritOutcome, latestGeneration, readHistory, type HistoryEntry } from '../history-store.ts';
import { platformPaths } from '../platform-paths.ts';
import type { SubagentPort, SubagentPortBox } from '../subagent-port.ts';
import { toolError, ToolError } from '../tool-error.ts'

/** Raw tool arguments: every field is validated inside the action handlers. */
type ToolParams = Record<string, unknown> | undefined;;
import { pipeNameFor, pipeRequestTo } from '../pipe-channel.ts';
import type { TerminalStateSlot } from './terminal.ts';
import { createGitIo } from '../subagent-git-io.ts';
import { createSessionIo } from '../subagent-session-io.ts';
import { bareSessionId, sessionFileById } from '../session-tail.ts';
import { createSpawner } from '../subagent-spawn.ts';
import type { JevRuntime } from '../jev-client.ts';
import { createPoller } from '../subagent-poll-loop.ts';
import { createGcController } from '../subagent-gc.ts';
import { createSubagentRegistry } from '../subagent-registry.ts';
import { createSpawnAction } from '../subagent-execute.ts';
import type { SubagentOutputCursor } from '../subagent-output-core.ts';
import { executeSubagentList } from '../subagent-list-action.ts';
import { executeSubagentOutput } from '../subagent-output-action.ts';
import { resolveTaskIdPrefix } from '../subagent-resolution.ts';
import type { RoutingTelemetryRecord } from '../routing-telemetry.ts';

interface SubagentEnv {
  paneId: string;
  tabId: string;
  workspaceId: string;
}

interface SubagentDeps {
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
  /**
   * Settlement notice injector from index: buffer while busy, flush at turn_end.
   * Tests may omit it and fall back to pi.sendUserMessage(followUp).
   */
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

/** Subagent concurrency limit (max parallel delegations) */
const SUBAGENT_CONCURRENCY = 4;

function defaultAgentSessionsDir(): string {
  const base = process.env.PI_CODING_AGENT_DIR || platformPaths.agentDataDir;
  return join(base, 'sessions');
}

function agentRootDir(): string {
  return dirname(defaultAgentSessionsDir());
}



export default function subagentPlugin(ctx: Context): void {
  const surface = ctx.get('pi-herdr.surface') as PiSurface<object>;
  const d = ctx.get('pi-herdr.subagent-deps') as SubagentDeps;
  const { client, env, sessionRoot, port, terminalState } = d;
  const pi = surface.raw as {
    appendEntry?: (customType: string, data: unknown) => void;
    sendUserMessage?: (content: string, opts?: { deliverAs?: string }) => Promise<void>;
  };
  const scoped = surface.forModule(import.meta.url);

  const runtime = {
    nodePath: process.execPath,
    cliPath: process.argv[1] ?? '',
    extPath: d.extPath,
  };
  const subSemaphore = new Semaphore(SUBAGENT_CONCURRENCY);
  /** B4 timestamps machine injection so grace-period working events are not mistaken for takeover. */
  const lastMachineInjectAt = new Map<string, number>();
  /* Persist the subagent registry as custom branch state so parent restarts can rebuild it. */
  const subs = new Map<string, SubEntry>();
  /** In-memory cursor for incremental subagent output observation. */
  const outputCursors = new Map<string, SubagentOutputCursor>();
  /** D98 excludes branches during worktree-add-to-registry races from orphan collection. */
  const pendingIsolateBranches = new Set<string>();
  /** D50 tracks the latest machine request per pane for interrupt claims and poll deduplication. */
  const lastRequestIdByPane = new Map<string, string>();

  const registry = createSubagentRegistry({ pi, client, subs, writeHistory });
  const { persist: persistSubs } = registry;
  /** E2 deduplicates gate notices while blocked but permits a later, distinct human question. */
  const blockedGateNotified = new Set<string>();
  const git = createGitIo();

  const boundPort: SubagentPort = {
    applyReplySession(paneId, sessionFile) {
      const entry = subs.get(paneId);
      if (!entry) return;
      // p24-class (01a0bd3c): workers self-report a BARE session id over the pipe; the
      // .jsonl-only guard in applyReportedSessionFile used to discard it, freezing a
      // mis-attributed sessionFile forever. Map the id to its transcript path first so
      // the authoritative self-report corrects the ledger.
      const reported = typeof sessionFile === 'string' && !/\.jsonl$/i.test(sessionFile)
        ? sessionFileById(entry.cwd, defaultAgentSessionsDir(), sessionFile)
        : sessionFile;
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

  /** P0-2 (01a0bd3a aftermath): a restarted master used to lose every running subagent's
   * poller — settle notices stopped arriving and ledger rows stayed 'running' until a
   * manual send re-armed one by accident. Re-arm pollers for live running panes; the
   * 'recover-*' requestId is never echoed by a worker, so this poller's settle claim wins. */
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
        await startPoller(entry.paneId, entry.cwd, entry.createdAt, entry.createdAt, entry.description, `recover-${via}-${entry.paneId}`);
        recovered.push(`${entry.paneId} (${entry.description})`);
      } catch {
        /* one failure must not block the rest */
      }
    }
    if (recovered.length > 0) {
      try {
        await injectNotice(
          `Session recovery (${via}): ${recovered.length} background subagent(s) still running — settlement watch re-armed for: ${recovered.join('; ')}.`,
        );
      } catch {
        /* non-fatal */
      }
    }
  }

  /* ── B1 liveness rewrite for subagent errors ─────────────────────
   * A false no-output result caused the model to seize work from a healthy subagent. Probe
   * agent.list and session mtime before the tool result enters model context; if alive, emit the
   * same notice as A2 backgrounding. This hook enforces what prompting alone could not. */
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
    if (!isAlive(probe, Date.now())) return; // Preserve the original error only when the agent is truly dead.
    // Move a live agent to the poller so its eventual result can replace the false error.
    if (!pollers.has(paneId)) {
      entry.background = true;
      startPoller(paneId, entry.cwd, entry.createdAt, entry.createdAt, entry.description, lastRequestIdByPane.get(paneId) ?? `probe-${paneId}`);
      persistSubs();
    }
    const notice = buildAliveNotice(
      { paneId, description: entry.description, scenario: 'error-alive', probe },
      Date.now(),
    );
    return { content: [{ type: 'text', text: notice }] };
  });

  function histFile(cwd: string): string {
    return preferredHistoryFile(agentRootDir(), cwd);
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

  /** B5 retains the latest non-empty outcome because closed generations otherwise hid settled
   * results behind outcome:null in latest-generation views. */
  const lastOutcomeByTask = new Map<string, string>();

  function writeHistory(e: SubEntry, patch?: Partial<HistoryEntry>, via?: string): void {
    const outcome = inheritOutcome(lastOutcomeByTask.get(e.taskId), patch?.outcome);
    if (typeof outcome === 'string' && outcome.length > 0) lastOutcomeByTask.set(e.taskId, outcome);
    appendHistory(histFile(e.cwd), { ...toHistory(e, outcome), ...(patch ?? {}), ...(via ? { via } : {}) });
  }

  const injectNotice = (content: string): Promise<void> =>
    d.deliverNotice ? d.deliverNotice(content)
      : (pi.sendUserMessage?.(content, { deliverAs: 'followUp' }) ?? Promise.resolve());

  const session = createSessionIo({
    client,
    getSessionId: d.getSessionId,
    sessionsDir: defaultAgentSessionsDir,
  });
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
  const { startPoller, pollers } = poller;

  /** Revive a closed task; resume and automatic send_message revival share this path. */
  async function reviveEntry(entry: SubEntry): Promise<SubEntry> {
    // D98: Do not revive a released isolate worktree because its directory is gone and cwd is invalid.
    if (entry.isolate?.releasedAt != null) {
      throw new Error(`isolate worktree ${entry.isolate.branch} was released (merged) — delegate a new subagent instead`);
    }
    const latest = latestGeneration(readHistory(histFile(entry.cwd)), entry.taskId) ?? entry;
    // 01a0bd3a: never relaunch the master's own transcript in a worker pane (two pi
    // processes competing on one jsonl). A mis-attributed ledger entry degrades to a
    // fresh conversation instead.
    const ownId = bareSessionId(d.getSessionId());
    const resumeFile = latest.sessionFile && /\.jsonl$/.test(latest.sessionFile)
      && bareSessionId(latest.sessionFile) !== ownId
      ? latest.sessionFile : null;
    // D86 trust matches spawn: pass -a only for the master's checkout/worktrees; revive has no tool context, so use process cwd.
    const approve = await approveFor(entry.cwd, process.cwd());
    const spawned = await spawnPaneInTaskTab(
      { desiredTab: entry.tabName || latest.tabName || null, description: entry.description },
      entry.cwd,
      { PI_HERDR_SUBAGENT: '1' },
      launchLine(resumeFile, null, approve),
    );
    const ready = await waitSubReady(entry.cwd, spawned.paneId);
    if (!ready.ok) throw new Error(ready.message);
    entry.paneId = spawned.paneId;
    entry.tabId = spawned.tabId;
    entry.tabName = spawned.tabName;
    entry.sessionFile = resumeFile;
    entry.status = 'running';
    entry.consumedAt = null;
    entry.revivedFrom = latest.paneId;
    entry.launchCommand = [launchLine(resumeFile, null, approve)];
    entry.createdAt = Date.now();
    writeHistory(entry, undefined, 'revive');
    return entry;
  }


  async function executeSubagentResume(params: Record<string, unknown> | undefined, toolCtx: unknown) {
      if (!client.available) {
        return toolError('requires a herdr-managed pane.');
      }
      const cwd = (toolCtx as { cwd?: string }).cwd ?? process.cwd();
      const rawTaskId = String(params?.taskId ?? params?.agentId ?? '').trim();
      if (!rawTaskId) {
        return toolError('missing taskId for resume (see action list or delegation ledger).');
      }
      const history = readHistory(histFile(cwd));
      const resolution = resolveTaskIdPrefix(rawTaskId, history.map((e) => e.taskId));
      if (resolution.kind === 'too_short') {
        return toolError(`Error: task id prefix "${rawTaskId}" is too short (minimum 4 characters).`);
      }
      if (resolution.kind === 'ambiguous') {
        const list = resolution.candidates.slice(0, 5).join(', ');
        const more = resolution.candidates.length > 5 ? `, ... (+${resolution.candidates.length - 5} more)` : '';
        return toolError(`Error: ambiguous task id "${rawTaskId}" matches ${resolution.candidates.length} tasks: ${list}${more}`);
      }
      if (resolution.kind === 'not_found') {
        return toolError(`Error: no history for task "${rawTaskId}" in this workspace.`);
      }
      const taskId = resolution.taskId;
      const latest = latestGeneration(history, taskId);
      if (!latest) {
        return toolError(`Error: no history for task "${taskId}" in this workspace.`);
      }
      const release = await subSemaphore.acquire();
      try {
        // D94: Reuse an existing pane for the same session to avoid competing pi processes.
        const existing = await findExistingPane(latest.sessionFile);
        // 01a0bd3a: when the ledger's sessionFile was mis-attributed to the master's own
        // transcript, this lookup matched the MASTER pane ("reused existing pane with same
        // session"), registering the master as its own subagent; the poller later consumed
        // it and GC closed the pane mid-run. Never adopt self — refuse instead, because
        // falling through to revive would relaunch the master transcript in a new pane.
        if (existing?.paneId === env?.paneId) {
          return toolError(
            `Error: task ${taskId} is attributed to the master's own session (mis-recorded sessionFile in the ledger); it cannot be resumed here — spawn a fresh subagent for this work instead.`,
          );
        }
        if (existing) {
          const entry: SubEntry = {
            taskId,
            kind: latest.kind,
            paneId: existing.paneId,
            tabId: existing.tabId,
            tabName: latest.tabName ?? tabNameForTask(latest.description),
            cwd,
            description: latest.description,
            background: true,
            status: 'running',
            sessionFile: latest.sessionFile ?? null,
            launchCommand: latest.launchCommand,
            createdAt: Date.now(),
            revivedFrom: latest.paneId,
            consumedAt: null,
          };
          subs.set(entry.paneId, entry);
          persistSubs();
          writeHistory(entry, undefined, 'resume');
          return {
            content: [{
              type: 'text',
              text: `resumed subagent ${entry.paneId} from task ${taskId} (reused existing pane with same session; pi still running there).`,
            }],
            details: { paneId: entry.paneId, taskId },
          };
        }
        // Create a new pane only when no existing one can be reused.
        const entry: SubEntry = {
          taskId,
          kind: latest.kind,
          paneId: '',
          tabId: '',
          tabName: latest.tabName ?? tabNameForTask(latest.description),
          cwd,
          description: latest.description,
          background: true,
          status: 'running',
          sessionFile: latest.sessionFile,
          launchCommand: latest.launchCommand,
          createdAt: Date.now(),
          revivedFrom: latest.paneId,
          consumedAt: null,
        };
        await reviveEntry(entry);
        subs.set(entry.paneId, entry);
        persistSubs();
        return {
          content: [{
            type: 'text',
            text: entry.sessionFile
              ? `resumed subagent ${entry.paneId} from task ${taskId} (session restored).`
              : `resumed subagent ${entry.paneId} from task ${taskId} (session file missing; fresh conversation).`,
          }],
          details: { paneId: entry.paneId, taskId },
        };
      } catch (err) {
        if (err instanceof ToolError) throw err;
        return toolError(`Error: failed to resume task "${taskId}": ${(err as Error).message}`);
      } finally {
        release();
      }
  }

  const listActionDeps = {
    subs: () => subs.values(),
    probeAlive,
    readAskFlag,
  };
  function resolveSubEntry(
    rawId: string,
    cwd?: string,
  ): { entry: SubEntry } | { error: string } {
    if (!rawId) {
      return { error: 'Error: unknown subagent id "" (see action list)' };
    }
    const direct = subs.get(rawId);
    if (direct) return { entry: direct };

    const byTaskId = new Map<string, SubEntry>();
    for (const sub of subs.values()) {
      const prev = byTaskId.get(sub.taskId);
      if (!prev || sub.createdAt >= prev.createdAt) byTaskId.set(sub.taskId, sub);
    }
    const res = resolveTaskIdPrefix(rawId, byTaskId.keys());
    if (res.kind === 'resolved') {
      return { entry: byTaskId.get(res.taskId)! };
    }
    if (res.kind === 'ambiguous') {
      const list = res.candidates.slice(0, 5).join(', ');
      const more = res.candidates.length > 5 ? `, ... (+${res.candidates.length - 5} more)` : '';
      return { error: `Error: ambiguous subagent id "${rawId}" matches ${res.candidates.length} tasks: ${list}${more}` };
    }
    if (res.kind === 'too_short') {
      return { error: `Error: subagent id prefix "${rawId}" is too short (minimum 4 characters).` };
    }

    if (cwd) {
      const hist = readHistory(histFile(cwd));
      const histTaskIds = Array.from(new Set(hist.map((e) => e.taskId)));
      const histRes = resolveTaskIdPrefix(rawId, histTaskIds);
      if (histRes.kind === 'resolved') {
        const latest = latestGeneration(hist, histRes.taskId);
        if (latest) {
          const entry: SubEntry = {
            taskId: latest.taskId,
            kind: latest.kind,
            paneId: latest.paneId,
            tabId: latest.tabId,
            tabName: latest.tabName ?? '',
            cwd: latest.cwd,
            description: latest.description,
            background: true,
            status: 'closed',
            sessionFile: latest.sessionFile,
            launchCommand: latest.launchCommand,
            createdAt: latest.createdAt,
            consumedAt: latest.consumedAt ?? null,
            revivedFrom: latest.paneId,
          };
          subs.set(entry.paneId, entry);
          return { entry };
        }
      }
      if (histRes.kind === 'ambiguous') {
        const list = histRes.candidates.slice(0, 5).join(', ');
        const more = histRes.candidates.length > 5 ? `, ... (+${histRes.candidates.length - 5} more)` : '';
        return { error: `Error: ambiguous subagent id "${rawId}" matches ${histRes.candidates.length} tasks: ${list}${more}` };
      }
    }

    return { error: `Error: unknown subagent id "${rawId}" (see action list)` };
  }

  async function executeSubagentSend(params: Record<string, unknown> | undefined, toolCtx?: unknown) {
      const rawId = String(params?.agentId ?? params?.taskId ?? '').trim();
      const cwd = (toolCtx as { cwd?: string })?.cwd ?? process.cwd();
      const resolved = resolveSubEntry(rawId, cwd);
      if ('error' in resolved) {
        return toolError(resolved.error);
      }
      const entry = resolved.entry;
      const spawnedAt = Date.now();
      try {
        // A closed task is revived automatically because the pane is only a temporary host.
        if (entry.status === 'closed') {
          await reviveEntry(entry);
          subs.set(entry.paneId, entry);
          persistSubs();
        }
        // M11 (D46): follow_up uses the extension pipe. B3 adds steering so supplemental instructions reach a long-running worker
        // within seconds during a tool-call gap; the old followUp queue waited for the entire run and caused 20-minute rework (01a03c0d).
        const ready = await waitSubReady(entry.cwd, entry.paneId);
        if (!ready.ok) throw new Error(ready.message);
        const fuId = `fu-${Date.now()}`;
        const res = await pipeRequestTo(entry.cwd, entry.paneId, {
          type: 'follow_up',
          id: fuId,
          text: String(params?.message ?? ''),
          from: pipeNameFor(entry.cwd, env?.paneId ?? ''),
          push: true,
          steer: true,
        });
        if (res.type !== 'ok') {
          throw new Error(`pipe follow_up rejected: ${res.type === 'error' ? res.message : 'unknown response'}`);
        }
        lastMachineInjectAt.set(entry.paneId, Date.now()); // B4: attribute working state during the observation window.
        // Regression hardening (D98 liveness evidence): an exception between status='running' and startPoller could leave a ghost
        // running entry without a poller, never settling and skipped by GC; roll back to the previous status on failure.
        const prevStatus = entry.status;
        entry.status = 'running';
        persistSubs();
        try {
          lastRequestIdByPane.set(entry.paneId, fuId);
          startPoller(entry.paneId, entry.cwd, spawnedAt, Date.now(), entry.description, fuId);
        } catch (inner) {
          entry.status = prevStatus;
          persistSubs();
          throw inner;
        }
        return { content: [{ type: 'text', text: `Message sent to subagent ${entry.paneId}.` }], details: { paneId: entry.paneId } };
      } catch (err) {
        return toolError(`Error: failed to reach subagent ${entry.paneId}: ${(err as Error).message}`);
      }
  }

  async function executeSubagentInterrupt(params: Record<string, unknown> | undefined, toolCtx?: unknown) {
      const rawId = String(params?.agentId ?? params?.taskId ?? '').trim();
      const cwd = (toolCtx as { cwd?: string })?.cwd ?? process.cwd();
      const resolved = resolveSubEntry(rawId, cwd);
      if ('error' in resolved) {
        return toolError(resolved.error);
      }
      const entry = resolved.entry;
      if (entry.status === 'closed') {
        // DSH alignment: an idle or finished target is an idempotent no-op.
        return { content: [{ type: 'text', text: `Interrupt accepted for subagent ${entry.paneId} (already idle/closed; no-op).` }], details: {} };
      }
      try {
        const res = await pipeRequestTo(entry.cwd, entry.paneId, {
          type: 'interrupt',
          id: `int-${Date.now()}`,
        });
        if (res.type !== 'ok') {
          throw new Error(`pipe interrupt rejected: ${res.type === 'error' ? res.message : 'unknown response'}`);
        }
        // Do not send a settlement notice for an interrupted turn because the requester already knows.
        const lastId = lastRequestIdByPane.get(entry.paneId);
        if (lastId) d.claimSettleNotice(`${entry.paneId}:${lastId}`);
        return { content: [{ type: 'text', text: `Interrupt accepted for subagent ${entry.paneId} (fire-and-return).` }], details: { paneId: entry.paneId } };
      } catch (err) {
        return toolError(`Error: failed to reach subagent ${entry.paneId}: ${(err as Error).message}`);
      }
  }
  async function executeSubagentRole(params: Record<string, unknown> | undefined, toolCtx?: unknown) {
      const rawId = String(params?.agentId ?? params?.taskId ?? '').trim();
      const cwd = (toolCtx as { cwd?: string })?.cwd ?? process.cwd();
      const roleName = String(params?.role ?? '').trim();
      if (!roleName) {
        return toolError('Error: action "role" requires a target profile in `role` (same resolution as spawn)');
      }
      const resolved = resolveSubEntry(rawId, cwd);
      if ('error' in resolved) {
        return toolError(resolved.error);
      }
      const entry = resolved.entry;
      try {
        // Same revival semantics as send: the pane is only a host, so a closed task comes back first.
        if (entry.status === 'closed') {
          await reviveEntry(entry);
          subs.set(entry.paneId, entry);
          persistSubs();
        }
        const ready = await waitSubReady(entry.cwd, entry.paneId);
        if (!ready.ok) throw new Error(ready.message);
        const res = await pipeRequestTo(entry.cwd, entry.paneId, {
          type: 'role',
          id: `role-${Date.now()}`,
          role: roleName,
        });
        if (res.type !== 'ok') {
          throw new Error(`pipe role rejected: ${res.type === 'error' ? res.message : 'unknown response'}`);
        }
        return {
          content: [{ type: 'text', text: `Subagent ${entry.paneId}: ${res.detail ?? `switched to ${roleName}`}` }],
          details: { paneId: entry.paneId, role: roleName },
        };
      } catch (err) {
        return toolError(`Error: failed to switch subagent ${entry.paneId} to role ${roleName}: ${(err as Error).message}`);
      }
  }
  const outputActionDeps = {
    client,
    resolveEntry: (rawId: string, cwd: string) => resolveSubEntry(rawId, cwd),
    readAskFlag,
    outputCursors,
    getCwd: (toolCtx: unknown): string => (toolCtx as { cwd?: string })?.cwd ?? process.cwd(),
  };
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


  scoped.registerTool({
    name: 'subagent',
    label: 'Subagent',
    // B4: the model picks tools from the system prompt's snippet/guideline surface; this tool is the
    // one place where delegation decisions are made, so state them here rather than hoping for recall.
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
    // B2: 23/38 real spawns omitted `action` even though it is optional; normalize so the schema the
    // model is validated against and the code path never disagree, and so `spawn` is explicit in logs.
    prepareArguments: (args: unknown) => {
      const rec = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
      const hasAction = typeof rec.action === 'string' && rec.action.trim() !== '';
      return hasAction ? rec : { ...rec, action: 'spawn' };
    },
    async execute(toolCallId: string, params: ToolParams, signal: AbortSignal | undefined, onUpdate: ((update: unknown) => void) | undefined, toolCtx: unknown) {
      void toolCallId;
      void signal;
      const action = typeof params?.action === 'string' && params.action.trim() ? params.action.trim() : 'spawn';
      if (action === 'resume') return executeSubagentResume(params, toolCtx);
      if (action === 'list') return executeSubagentList(listActionDeps);
      if (action === 'send') return executeSubagentSend(params, toolCtx);
      if (action === 'interrupt') return executeSubagentInterrupt(params, toolCtx);
      if (action === 'output') return executeSubagentOutput(params, toolCtx, outputActionDeps);
      if (action === 'role') return executeSubagentRole(params, toolCtx);
      if (action !== 'spawn') {
        return toolError(`Error: unknown action "${action}" (valid: spawn, resume, list, send, interrupt, output, role)`);
      }
      return executeSubagentSpawn(params, toolCtx, onUpdate);
    },
  });
}
