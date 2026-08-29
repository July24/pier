/**
 * core/subagent — master-only loader entry (tools, registry, poller, GC).
 *
 * Inbound deps via `pi-herdr.subagent-deps`. Outbound pipe/settle queries bind
 * atomically onto `port.current` (see subagent-port.ts). Settlement reconcile
 * stays in index session state; this plugin consumes it through the port.
 */
import { Context } from '@deepseek-ai/cordis';
import { Type } from 'typebox';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { basename, join, dirname } from 'node:path';
import type { PiSurface } from '../pi-surface.ts';
import type { HerdrClientLike, HerdrAgentState } from '../herdr-client.ts';
import type { TodosService } from '../todos-service.ts';
import { mountSubagentScope } from '../subagent-scope.ts';
import { Semaphore, SUBS_CUSTOM_TYPE, agoText, buildAliveNotice, buildBlockedGateNotice, buildIsolatePreamble, buildLaunchLine, buildLaunchParts, classifyWorktreeZone, evaluateRelease, foldSubsRegistry, formatSubagentResult, formatWorktreeStat, isAlive, isPathUnder, makeProgressUpdate, makeRegistry, parseWorktreePorcelain, planIsolateWorktree, planTabPlacement, psQuote, tabNameForTask, type AliveProbe, type SubEntry, type SubagentSpec, type TabPlacementPlan, type WorktreeZone } from '../subagent-core.ts';
import { hasAssistantAfter, hasPendingToolCall, lastAssistantText, listSessionFiles, readSessionFile, sessionFileById } from '../session-tail.ts';
import { appendHistory, applyReportedSessionFile, preferredHistoryFile, inheritOutcome, latestGeneration, readHistory, type HistoryEntry } from '../history-store.ts';
import { runtimePolicy } from '../runtime-policy.ts';
import { platformPaths } from '../platform-paths.ts';
import { defaultGitAdapter } from '../git-adapter.ts';
import {
  OBSERVATION_TICK_MS,
  TAKEOVER_RECHECK_MS,
  planBlockedGate,
  planObservationTick,
  planTakeoverTick,
  planVacuumTick,
} from '../subagent-poller.ts';
import type { SubagentPort, SubagentPortBox } from '../subagent-port.ts';
import {
  FOREGROUND_POLL_MS,
  planForegroundTick,
  planIsolateRepoGuard,
  planLaunchValidation,
  planPatienceExpiry,
} from '../subagent-launch.ts';
import { appendFileSync, existsSync, mkdirSync, rmSync, stat as statCb } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import { promisify } from 'node:util';
const statAsync = promisify(statCb);
import { pingUntilReady, pipeNameCandidates, pipeNameFor, pipeRequestTo } from '../pipe-channel.ts';
import { shouldClosePane, shouldCloseTaskTab } from '../gc-core.ts';
import { composeForRole } from '../manifest-compose.ts';
import { formatSettlementNotice } from '../vocab.ts';
import { TODO_REMINDER_CUSTOM_TYPE, planStopTodoReminder, todoReminderGraceMs } from '../todo-reminder-core.ts';
import type { TerminalStateSlot } from './terminal.ts';

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
  getBlockedDepth: () => number;
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
  todos: TodosService;
}

const SUBAGENT_DESCRIPTION = [
  'Delegate a self-contained subtask to an isolated subagent that runs in its own herdr pane as an interactive pi session (separate context window; it does NOT see this conversation). A human can also open that pane and talk to the subagent directly.',
  '`description`: short display label for the pane; `prompt`: the COMPLETE task — include all needed context, since only the prompt reaches the subagent. The description also doubles as the todo-reconcile key: when delegating a todo entry, use the entry content WITHOUT its ` <sub>` marker as the description, and the entry is auto-completed when this subagent settles.',
  'The subagent shares this workspace and works independently; the result is its final text answer.',
  'Concurrent delegation is supported: several subagent calls in one message run in parallel (at most 4 at once). Use this for well-scoped, independent subtasks; do not delegate the current step itself.',
  '`run_in_background` (default false): when true, the call returns immediately with an agentId; the subagent keeps running in its pane. Use list_agents to see its state, send_message to give it follow-up work, interrupt_agent to stop it. When it settles, you receive a notification message with its closing output.',
  '`tab` (optional): name of a task tab to place the subagent into (join if a tab with this name exists, otherwise create it). Overrides the default placement. Default placement groups by git worktree: a subagent working in your checkout shares your tab; one working in a separate worktree (pass its path via `cwd`; create worktrees with `git worktree add`) gets its own tab named after the worktree directory.',
  '`role` + `allowed_tools`: when role matches a profile (searched: workspace .pi-herdr/roles/ → user-global ~/.pi/agent/herdr-pi/roles/ → builtin), the worker toolset becomes the composed manifest — baseline ∪ allowed_tools minus role-deny tools (deny always wins). Custom roles: drop a JSON profile into .pi-herdr/roles/ (master/worker-default reserved). Unknown role names remain display labels only.',
  '`isolate` (default false): creates a FRESH git worktree for this subagent and runs it there (branch pier/<slug> from your HEAD under ~/.herdr/worktrees/<repo>/). Three-way choice: heavy independent writing in parallel with your own edits or other workers, or work needing its own clean reviewable diff → isolate; read-mostly or sequential helper work → omit (shared checkout, writes guarded by the write-lock); targeting an existing directory/worktree → cwd. In isolate mode the subagent\'s writes cannot conflict with your checkout; its panes group into a tab named after the worktree; its prompt is prefixed with commit discipline (commit to its own branch, NEVER push); when it settles you get a diff summary (commits since base, files changed, uncommitted count). Review with git log/diff HEAD..<branch>, merge with git merge --no-ff <branch>; once merged and clean, the worktree auto-removes (the branch is kept for audit). Mutually exclusive with cwd.',
].join(' ');

/** Subagent concurrency limit (max parallel delegations) */
const SUBAGENT_CONCURRENCY = 4;
/**
 * Observation timeout (inactivity budget, not wall-clock total).
 * Why: Working slice continues to refresh; healthy long tasks >10min no longer killed by mistake.
 */
const SUBAGENT_TIMEOUT_MS = runtimePolicy.subagentTimeoutMs;
const SUB_READY_TIMEOUT_MS = runtimePolicy.readinessTimeoutMs;
/** Settlement observation window (within this period, working defaults to user takeover) */
const OBSERVE_WINDOW_MS = runtimePolicy.observationWindowMs;
/**
 * Machine injection grace period.
 * Why: Working within observation window is not considered takeover if triggered by own prompt/follow_up.
 */
const MACHINE_INJECT_GRACE_MS = runtimePolicy.settlementWindowMs;
/** Takeover return threshold (sustained idle returns control) */
const TAKEOVER_IDLE_MS = runtimePolicy.settlementWindowMs;

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
  const { client, env, sessionRoot, port, terminalState, todos } = d;
  const pi = surface.raw as {
    appendEntry?: (customType: string, data: unknown) => void;
    sendUserMessage?: (content: string, opts?: { deliverAs?: string }) => Promise<void>;
    sendMessage?: (
      message: { customType: string; content: string; display?: boolean; details?: Record<string, unknown> },
      opts?: { deliverAs?: string; triggerTurn?: boolean },
    ) => Promise<void>;
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
  /** D98 excludes branches during worktree-add-to-registry races from orphan collection. */
  const pendingIsolateBranches = new Set<string>();
  const pollers = new Set<string>();
  const subScopes = new Map<string, { dispose: () => Promise<void> }>();
  /** D50 tracks the latest machine request per pane for interrupt claims and poll deduplication. */
  const lastRequestIdByPane = new Map<string, string>();

  /** O1 suppresses duplicate snapshots because 01a03c0d found 48% of session rows were heartbeat repeats. */
  let lastSubsSnapshot = '';

  function persistSubs(): void {
    try {
      const reg = makeRegistry([...subs.values()]);
      const snap = JSON.stringify(reg);
      if (snap === lastSubsSnapshot) return; // Avoid duplicate writes from the 1s/5s observation loops.
      lastSubsSnapshot = snap;
      pi.appendEntry?.(SUBS_CUSTOM_TYPE, reg);
    } catch {
      /* Persistence is best-effort so session logging cannot break delegation. */
    }
  }
  /** E2 deduplicates gate notices while blocked but permits a later, distinct human question. */
  const blockedGateNotified = new Set<string>();

  const boundPort: SubagentPort = {
    applyReplySession(paneId, sessionFile) {
      const entry = subs.get(paneId);
      if (!entry) return;
      const next = applyReportedSessionFile(entry.sessionFile, sessionFile);
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
      return entry ? await worktreeStatLine(entry) : null;
    },
  };
  port.current = boundPort;
  ctx.effect(() => () => {
    if (port.current === boundPort) port.current = null;
  }, 'subagent-port');
  function rebuildSubs(eventCtx: unknown): void {
    try {
      const entries = (eventCtx as { sessionManager?: { getBranch?: () => readonly unknown[] } })
        ?.sessionManager?.getBranch?.() ?? [];
      const reg = foldSubsRegistry(entries as Parameters<typeof foldSubsRegistry>[0]);
      for (const sub of reg.subs) subs.set(sub.paneId, sub);
      lastSubsSnapshot = ''; // Force persistence because branch replay replaced live state.
    } catch {
      /* Registry recovery failure must not block the live session. */
    }
  }

  /** B6 closes crash-stale running rows only after herdr confirms their pane is gone; 01a03c0d
   * showed p6/p7 otherwise remained permanently running. */
  async function sweepZombieRunning(): Promise<void> {
    if (!client.available || subs.size === 0) return;
    let livePaneIds: ReadonlySet<string>;
    try {
      livePaneIds = new Set((await client.listPanes()).map((p) => p.paneId));
    } catch {
      return; // Do not close agents when liveness lookup itself failed.
    }
    let changed = false;
    for (const [paneId, e] of subs) {
      if (e.status !== 'running' || livePaneIds.has(paneId)) continue;
      e.status = 'closed';
      writeHistory(e, { status: 'closed', closedAt: Date.now() }, 'zombie-sweep');
      changed = true;
    }
    if (changed) persistSubs();
  }

  scoped.on('session_start', async (_event: unknown, eventCtx: unknown) => {
    rebuildSubs(eventCtx);
    await sweepZombieRunning();
  });
  scoped.on('session_tree', async (_event: unknown, eventCtx: unknown) => {
    rebuildSubs(eventCtx);
    await sweepZombieRunning();
  });

  /* ── B1 liveness rewrite for subagent errors ─────────────────────
   * A false no-output result caused the model to seize work from a healthy subagent. Probe
   * agent.list and session mtime before the tool result enters model context; if alive, emit the
   * same notice as A2 backgrounding. This hook enforces what prompting alone could not. */
  scoped.on('tool_result', async (event: { toolName?: string; toolCallId?: string; isError?: boolean; content?: Array<{ type: string; text?: string }> }) => {
    if (event?.toolName !== 'subagent' || !event.isError) return;
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

  /* ── D41 safe reminders for unfinished todos ─────────────────────
   * 01a040cc showed that a user-role reminder overrode model judgment and executed work reserved
   * for the user. Use a distinguishable custom message, request reconciliation rather than action,
   * and delay delivery so any new agent start cancels it. Preserve the ESC guard from 01a03bf0 to
   * avoid wake-up storms after explicit interruption. */

  let todoReminders = 0;
  let lastAssistantStopReason: string | null = null;
  let todoReminderTimer: NodeJS.Timeout | null = null;

  function cancelTodoReminder(): void {
    if (todoReminderTimer !== null) {
      clearTimeout(todoReminderTimer);
      todoReminderTimer = null;
    }
  }

  scoped.on('turn_end', async (event: unknown) => {
    if (event === null || typeof event !== 'object' || !('message' in event)) return;
    const msg = (event as { message: unknown }).message; // Safe after the property guard above.
    if (msg === null || typeof msg !== 'object') return;
    const { role, stopReason } = msg as { role?: unknown; stopReason?: unknown };
    if (role === 'assistant' && typeof stopReason === 'string') {
      lastAssistantStopReason = stopReason;
    }
  });

  // B3 cancels the reminder when any source resumes work during the grace window.
  scoped.on('agent_start', () => cancelTodoReminder());
  scoped.on('session_shutdown', () => cancelTodoReminder());

  scoped.on('agent_settled', async () => {
    cancelTodoReminder(); // Cancel any timer left from the previous settlement.
    const plan = planStopTodoReminder({
      lastStopReason: lastAssistantStopReason,
      reminders: todoReminders,
      runningSubs: pollers.size,
      blockedDepth: d.getBlockedDepth(),
      items: todos.items,
    });
    if (!plan.due || plan.content == null) return;
    const content = plan.content;
    todoReminderTimer = setTimeout(() => {
      todoReminderTimer = null;
      void (async () => {
        // Without sendMessage, skip the reminder rather than impersonating the user channel.
        const send = pi.sendMessage;
        if (typeof send !== 'function') return;
        try {
          await send(
            { customType: TODO_REMINDER_CUSTOM_TYPE, content, display: true },
            { deliverAs: 'followUp', triggerTurn: true },
          );
          todoReminders += 1; // Count only delivered reminders so cancellation and failure do not consume the cap.
        } catch {
          /* Delivery failure is non-fatal. */
        }
      })();
    }, todoReminderGraceMs());
    todoReminderTimer.unref?.(); // Do not keep tests or headless processes alive for a reminder.
  });

  /* ── Pipe helpers: M11 readiness requires a handshake ──────────── */

  /** D47 waits for the child extension's session-start pipe server before sending work. */
  async function waitSubReady(cwd: string, paneId: string): Promise<boolean> {
    return pingUntilReady(pipeNameCandidates(cwd, paneId), SUB_READY_TIMEOUT_MS);
  }

  /**
   * M7 orders reported paths and ids before recent-file fallback to prevent settlement text from
   * crossing sessions. The fallback excludes the parent's frequently newest file, which caused
   * observed parent replies to be collected as child results.
   */
  async function resolveSessionFileCandidates(paneId: string, cwd: string): Promise<string[]> {
    const out: string[] = [];
    try {
      const reported = await client.getAgentSessionPath(paneId);
      if (reported) {
        if (/\.jsonl$/.test(reported)) out.push(reported);
        else {
          const byId = sessionFileById(cwd, defaultAgentSessionsDir(), reported);
          if (byId) out.push(byId);
        }
      }
    } catch {
      /* Fall back to scanning because reports may be unavailable during startup. */
    }
    const ownSession = d.getSessionId();
    for (const f of listSessionFiles(cwd, defaultAgentSessionsDir(), 4)) {
      if (f !== ownSession && !out.includes(f)) out.push(f);
    }
    return out;
  }

  /** Resolve a parseable child session file so spawn and settlement share the same source. */
  async function resolveSessionFile(paneId: string, cwd: string): Promise<string | null> {
    for (const file of await resolveSessionFileCandidates(paneId, cwd)) {
      if (readSessionFile(file)) return file;
    }
    return null;
  }

  /** Retry final-text collection because session persistence can lag settlement. */
  async function collectFinalText(
    paneId: string,
    cwd: string,
    sinceTs: number,
    attempts = 12,
  ): Promise<string | null> {
    for (let i = 0; i < attempts; i++) {
      for (const file of await resolveSessionFileCandidates(paneId, cwd)) {
        const entries = readSessionFile(file);
        if (!entries) continue;
        const r = lastAssistantText(entries, { sinceTs });
        if (r?.text) return r.text;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  }

  /** E1/E2 reads the reported pi-ask token so blocked work remains with the human. */
  async function readAskFlag(paneId: string): Promise<string | null> {
    try {
      const a = (await client.listAgents()).find((x) => x.paneId === paneId);
      const v = a?.tokens?.['pi-ask'];
      return typeof v === 'string' && v ? v : null;
    } catch {
      return null;
    }
  }

  /** A2/B1 combines pane status with newest session mtime because either signal alone can be stale. */
  async function probeAlive(paneId: string, cwd: string): Promise<AliveProbe> {
    const probe: AliveProbe = { paneExists: false, agentStatus: null, lastActivityMs: null };
    try {
      const agents = await client.listAgents();
      const a = agents.find((x) => x.paneId === paneId);
      probe.paneExists = a != null;
      probe.agentStatus = a?.status ?? null;
    } catch {
      /* Fall back to session activity when agent.list is unavailable. */
    }
    for (const file of await resolveSessionFileCandidates(paneId, cwd)) {
      try {
        const mtime = (await statAsync(file)).mtimeMs;
        if (probe.lastActivityMs == null || mtime > probe.lastActivityMs) probe.lastActivityMs = mtime;
      } catch {
        /* Session files can disappear during candidate scanning. */
      }
    }
    return probe;
  }

  /**
   * M8 treats session content as authoritative because herdr idle/done is also true at injection.
   * Final text means settled, a pending tool call means active, assistant activity without text is
   * genuine no-output, and no activity means the run has not started.
   */
  async function subSessionState(
    paneId: string,
    cwd: string,
    sinceTs: number,
  ): Promise<{ text: string | null; pendingTool: boolean; activity: boolean }> {
    for (const file of await resolveSessionFileCandidates(paneId, cwd)) {
      const entries = readSessionFile(file);
      if (entries.length === 0) continue;
      const r = lastAssistantText(entries, sinceTs);
      if (r?.text) return { text: r.text, pendingTool: false, activity: true };
      if (hasPendingToolCall(entries, sinceTs)) return { text: null, pendingTool: true, activity: true };
      if (hasAssistantAfter(entries, sinceTs)) return { text: null, pendingTool: false, activity: true };
    }
    return { text: null, pendingTool: false, activity: false };
  }

  /** D92 buffers settlement notices until turn_end, falling back to legacy followUp delivery. */
  const injectNotice = (content: string): Promise<void> =>
    d.deliverNotice ? d.deliverNotice(content)
      : (pi.sendUserMessage?.(content, { deliverAs: 'followUp' }) ?? Promise.resolve());

  /** Polls background settlement while yielding blocked panes to humans and detecting D94 takeover. */
  async function pollLoop(
    paneId: string,
    cwd: string,
    spawnedAt: number,
    injectTs: number,
    description: string,
    requestId: string,
  ): Promise<void> {
    void spawnedAt;
    // B1/O3 refreshes inactivity on every working heartbeat; only periods with neither working nor
    // settlement progress consume the budget. This avoids the 10-minute wall-clock false kills seen
    // on healthy 27-minute jobs in 01a03c0d while retaining startedAt for diagnostics.
    const startedAt = Date.now();
    let lastActivityAt = Date.now();
    const pollTrace = process.env.PI_HERDR_TRACE
      ? (msg: string) => { try { appendFileSync(process.env.PI_HERDR_TRACE!, `d98poll ${Date.now()} ${paneId} ${msg}\n`); } catch { /* Tracing is best-effort. */ } }
      : null;
    try {
      while (true) {
        const entry = subs.get(paneId);
        if (!entry || entry.status === 'settled') return;

        if (entry.userTakeover) {
          try {
            const agents = await client.listAgents();
            const agent = agents.find((a) => a.paneId === paneId);
            const tick = planTakeoverTick({
              currentStatus: agent?.status ?? null,
              previousStatus: entry.lastAgentStatus,
              idleStartedAt: entry.observationStartedAt,
              now: Date.now(),
              idleMs: TAKEOVER_IDLE_MS,
            });
            if (tick.kind === 'start-idle') {
              entry.observationStartedAt = Date.now();
              entry.lastAgentStatus = 'idle';
              persistSubs();
            } else if (tick.kind === 'return-control') {
              entry.userTakeover = false;
              entry.observationStartedAt = null;
              entry.lastAgentStatus = null;
              persistSubs();
            } else if (tick.kind === 'hold' && tick.clearIdleTimer) {
              entry.lastAgentStatus = tick.lastAgentStatus;
              entry.observationStartedAt = null;
              persistSubs();
            }
          } catch {
            // A failed status probe should not stop the poller.
          }
          if (entry.userTakeover) {
            await new Promise((resolve) => setTimeout(resolve, TAKEOVER_RECHECK_MS));
            continue;
          }
        }

        let state: HerdrAgentState | null;
        try {
          state = await client.waitAgent(paneId, ['idle', 'done', 'blocked'], runtimePolicy.pollIntervalMs);
        } catch {
          state = null;
        }
        const gate = planBlockedGate(state, blockedGateNotified.has(paneId));
        if (gate.kind === 'stay-blocked') {
          if (gate.notify) {
            blockedGateNotified.add(paneId);
            const question = await readAskFlag(paneId);
            try {
              await injectNotice(buildBlockedGateNotice({ paneId, description, question }));
            } catch {
              /* A later turn can recover a missed notice through list_agents. */
            }
          }
          continue;
        }
        if (gate.kind === 'clear-gate') blockedGateNotified.delete(paneId);
        if (state === 'idle' || state === 'done') {
          const s = await subSessionState(paneId, cwd, injectTs);
          pollTrace?.(`state=${state} text=${s.text ? s.text.length : 'null'} pend=${s.pendingTool} act=${s.activity} obs=${String(entry.observationStartedAt ?? null)} takeover=${String(entry.userTakeover === true)}`);
          if (s.text || (!s.pendingTool && s.activity)) {
            // Settled
            const closing = s.text;

            const obs = planObservationTick({
              observationStartedAt: entry.observationStartedAt,
              now: Date.now(),
              windowMs: OBSERVE_WINDOW_MS,
              agentStatus: null,
              machineInjectAgoMs: Date.now() - (lastMachineInjectAt.get(paneId) ?? 0),
              machineInjectGraceMs: MACHINE_INJECT_GRACE_MS,
            });
            if (obs.kind === 'start-observation') {
              entry.observationStartedAt = Date.now();
              entry.lastAgentStatus = 'idle';
              persistSubs();
              await new Promise((resolve) => setTimeout(resolve, OBSERVATION_TICK_MS));
              continue;
            }
            let agentStatus: string | null = null;
            try {
              const agents = await client.listAgents();
              agentStatus = agents.find((a) => a.paneId === paneId)?.status ?? null;
            } catch {
              // A failed status probe should not stop observation.
            }
            const obs2 = planObservationTick({
              observationStartedAt: entry.observationStartedAt,
              now: Date.now(),
              windowMs: OBSERVE_WINDOW_MS,
              agentStatus,
              machineInjectAgoMs: Date.now() - (lastMachineInjectAt.get(paneId) ?? 0),
              machineInjectGraceMs: MACHINE_INJECT_GRACE_MS,
            });
            if (obs2.kind === 'user-takeover') {
              entry.userTakeover = true;
              entry.observationStartedAt = Date.now();
              entry.lastAgentStatus = 'working';
              persistSubs();
              continue;
            }
            if (obs2.kind === 'machine-inject-reset') {
              entry.observationStartedAt = Date.now();
              persistSubs();
              await new Promise((resolve) => setTimeout(resolve, OBSERVATION_TICK_MS));
              continue;
            }
            if (obs2.kind === 'wait') {
              await new Promise((resolve) => setTimeout(resolve, OBSERVATION_TICK_MS));
              continue;
            }
            entry.observationStartedAt = null;
            // Settle only after the observation path has confirmed completion.
            // O6 preserves a reply-reported sessionFile; scanning only fills a missing value.
            if (!entry.sessionFile) {
              entry.sessionFile = applyReportedSessionFile(
                entry.sessionFile,
                await resolveSessionFile(paneId, cwd),
              );
            }
            entry.status = 'consumed';
            entry.consumedAt = Date.now();
            writeHistory(entry, { outcome: closing }, 'poll-settle');
            // M17 reconciles before notice and remains idempotent with the reply fast path.
            const notes = d.reconcileOnSettlement(description, 'settled');
            // D98 adds git context so isolate and small-task results expose their actual change scope.
            const statLine = await worktreeStatLine(entry);
            const notice = d.withReconcileNotes(
              formatSettlementNotice(`${paneId} (${description})`, closing) + (statLine ? `\n${statLine}` : ''),
              notes,
            );
            if (d.claimSettleNotice(`${paneId}:${requestId}`)) {
              try {
                await injectNotice(notice);
              } catch {
                /* A later turn can recover a missed notice through list_agents. */
              }
            }
            return;
          }
          // Pending human tool calls and not-yet-started sessions must continue waiting.
        }
        let alive = false;
        try {
          alive = (await client.listAgents()).some((a) => a.paneId === paneId);
        } catch {
          alive = true;
        }
        const vacuum = planVacuumTick({
          waitState: state,
          paneAlive: alive,
          now: Date.now(),
          lastActivityAt,
          timeoutMs: SUBAGENT_TIMEOUT_MS,
        });
        if (vacuum.refreshActivity) lastActivityAt = Date.now();
        if (vacuum.action === 'pane-closed') {
          entry.status = 'consumed';
          entry.consumedAt = Date.now();
          persistSubs();
          writeHistory(entry, { outcome: 'pane closed before settling' }, 'poll-pane-closed');
          const notes = d.reconcileOnSettlement(description, 'failed');
          const notice = d.withReconcileNotes(
            `Background subagent ${paneId} (${description}) stopped before settling (its pane closed).`,
            notes,
          );
          try {
            await injectNotice(notice);
          } catch {
            /* Notice delivery failure is non-fatal. */
          }
          return;
        }
        if (vacuum.action === 'timeout') {
          entry.status = 'consumed';
          entry.consumedAt = Date.now();
          persistSubs();
          writeHistory(entry, { outcome: 'observation timeout' }, 'poll-timeout');
          const notes = d.reconcileOnSettlement(description, 'failed');
          const notice = d.withReconcileNotes(
            `Background subagent ${paneId} (${description}) has shown no progress for ${Math.round((Date.now() - lastActivityAt) / 1000)}s (observed since ${new Date(startedAt).toISOString()}). Run list_agents to check its live state; if it is working, let it run — its settlement notice will arrive automatically. Do not sleep-wait.`,
            notes,
          );
          try {
            await injectNotice(notice);
          } catch {
            /* Notice delivery failure is non-fatal. */
          }
          return;
        }
      }
    } finally {
      pollers.delete(paneId);
    }
  }

  function startPoller(paneId: string, cwd: string, spawnedAt: number, injectTs: number, description: string, requestId: string): void {
    if (pollers.has(paneId)) return;
    pollers.add(paneId);
    void (async () => {
      try {
        if (!subScopes.has(paneId)) {
          const fiber = await mountSubagentScope(sessionRoot, paneId, {
            onDispose: () => { pollers.delete(paneId); },
          });
          subScopes.set(paneId, fiber);
        }
        await pollLoop(paneId, cwd, spawnedAt, injectTs, description, requestId);
        const fiber = subScopes.get(paneId);
        subScopes.delete(paneId);
        try { await fiber?.dispose(); } catch { /* already gone */ }
      } catch (err) {
        // D98 removes crashed pollers so their pane ids can be restarted instead of remaining
        // running ghosts with no active loop.
        pollers.delete(paneId);
        console.error(`pier: subagent poller ${paneId} crashed: ${(err as Error)?.message ?? err}`);
      }
    })();
  }

  /* ── subagent tool: task-tab placement, history, and GC ────────── */

  /** D26 serializes tab placement so concurrent delegates cannot race the same read-modify-write. */
  const tabMutex = new Semaphore(1);

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

  /** Trust herdr for live task tabs so renames and automatic closure correct cached registry data. */
  async function liveTabs(): Promise<Array<{ tabName: string; tabId: string }>> {
    try {
      const ws = env?.workspaceId ?? '';
      return (await client.tabList())
        .filter((t) => !ws || t.workspaceId === ws)
        .map((t) => ({ tabName: t.label, tabId: t.tabId }));
    } catch {
      return [];
    }
  }

  /* ── D86 git-worktree grouping key ─────────────────────────────── */

  /** Cache briefly because placement needs only approximate worktree freshness. */
  let worktreesCache: { at: number; list: string[] } | null = null;
  const WORKTREES_CACHE_MS = 5000;

  /**
   * Return every repository worktree with the main checkout first. Non-git directories and missing
   * git degrade to an empty list so placement naturally falls back to main.
   */
  async function listWorktrees(cwd: string): Promise<string[]> {
    if (worktreesCache && Date.now() - worktreesCache.at < WORKTREES_CACHE_MS) return worktreesCache.list;
    let list: string[] = [];
    try {
      const { stdout } = await defaultGitAdapter.listWorktrees(cwd);
      for (const line of String(stdout).split('\n')) {
        const m = /^worktree (.+)$/.exec(line.trim());
        if (m) list.push(m[1]);
      }
    } catch {
      list = [];
    }
    worktreesCache = { at: Date.now(), list };
    return list;
  }

  /**
   * D98 centralizes isolate git calls behind the adapter and runtime timeout. Returning null on
   * failure matches worktree discovery and keeps infrastructure git outside the model bash surface.
   */
  async function runGit(cwd: string, args: string[]): Promise<string | null> {
    try {
      const { stdout } = await defaultGitAdapter.run(cwd, args);
      return stdout == null ? null : String(stdout);
    } catch {
      return null;
    }
  }

  /** Return only the summary line needed by notices; empty diffs have no useful annotation. */
  function lastStatLine(out: string | null): string | null {
    if (!out) return null;
    const lines = out.replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
    return lines.length ? lines[lines.length - 1]! : null;
  }

  /**
   * D98 gives both settlement paths a compact change summary: baseline diff and commits for isolates,
   * or working-tree diff and dirty count for ordinary git workers. Non-git work omits the line.
   */
  async function worktreeStatLine(entry: SubEntry): Promise<string | null> {
    const porcelain = await runGit(entry.cwd, ['status', '--porcelain']);
    if (porcelain === null) return null; // Omit stats when git or the repository is unavailable.
    const dirtyCount = porcelain.split('\n').filter((l) => l.trim() !== '').length;
    if (entry.isolate) {
      const statOut = await runGit(entry.cwd, ['diff', '--stat', `${entry.isolate.baseSha}...HEAD`]);
      const commitsOut = await runGit(entry.cwd, ['rev-list', '--count', `${entry.isolate.baseSha}..HEAD`]);
      const commits = commitsOut != null && /^\d+$/.test(commitsOut.trim()) ? Number(commitsOut.trim()) : null;
      return formatWorktreeStat({ branch: entry.isolate.branch, commits, statLine: lastStatLine(statOut), dirtyCount });
    }
    return formatWorktreeStat({ branch: null, commits: null, statLine: lastStatLine(await runGit(entry.cwd, ['diff', '--stat', 'HEAD'])), dirtyCount });
  }

  /**
   * Create a child pane in the task tab according to placement (v1.3 D25/D26 + D86 worktree grouping):
   *  - new: create a tab without stealing focus, then inject the startup command into its root pane;
   *  - append: verify the existing tab is alive, then split into it without restarting the process;
   *    if the tab vanished, fall back to a same-named new tab. The mutex protects placement from name races.
   * D86: callers compute placement.zone (main → the master's tab; worktree → a directory-named tab).
   */
  async function spawnPaneInTaskTab(
    placement: { desiredTab?: string | null; description: string; zone?: WorktreeZone },
    cwd: string,
    envOver: Record<string, string>,
    launch: string,
  ): Promise<{ tabId: string; paneId: string; tabName: string }> {
    const release = await tabMutex.acquire();
    try {
      // D86: Resolve the main tab from the master's pane because HERDR_TAB_ID injection may be absent.
      const allPanes = await client.listPanes();
      const mainTabId = allPanes.find((p) => p.paneId === env?.paneId)?.tabId
        ?? (env?.tabId ? env.tabId : null);
      let plan: TabPlacementPlan = planTabPlacement({
        desiredTab: placement.desiredTab,
        description: placement.description,
        knownTabs: await liveTabs(),
        zone: placement.zone,
        mainTabId,
      });
      if (plan.mode === 'append' && plan.tabId) {
        // D97 grid layout: choose the largest target cell and always split down, yielding a full-width
        // strip whose title remains readable; exclude board panes with unknown agent status so workers cannot consume them.
        const exclude = new Set(
          allPanes.filter((p) => p.tabId === plan.tabId && p.agentStatus === 'unknown').map((p) => p.paneId),
        );
        let pick: { targetPaneId: string; direction: 'right' | 'down' } | null = null;
        try {
          const snapshot = await client.exportLayout({ tabId: plan.tabId });
          const tree = snapshot?.root ? parseShapeTree(snapshot.root) : null;
          if (tree) pick = pickGridSplit(tree, { exclude });
        } catch { /* A layout export failure falls back to the legacy anchor split. */ }
        // Anchor fallback: prefer a work pane with known agent status so the board pane is avoided.
        const anchorPaneId = pick?.targetPaneId
          ?? allPanes.find((p) => p.tabId === plan.tabId && p.agentStatus !== 'unknown')?.paneId
          ?? allPanes.find((p) => p.tabId === plan.tabId)?.paneId;
        if (anchorPaneId) {
          const paneId = await client.splitPane({
            direction: pick?.direction ?? 'down',
            cwd,
            env: envOver,
            targetPaneId: anchorPaneId,
          });
          await client.sendPaneText(paneId, launch);
          return { tabId: plan.tabId!, paneId, tabName: plan.tabName };
        }
        // A missing anchor (empty or closed tab) or a vanished main tab falls back to a same-named new tab.
        plan = { mode: 'new', tabName: plan.tabName, tabId: null };
      }
      const created = await client.createTab({
        workspaceId: env?.workspaceId ?? '',
        label: plan.tabName,
        cwd,
        env: envOver,
      });
      await client.sendPaneText(created.paneId, launch);
      return { tabId: created.tabId, paneId: created.paneId, tabName: plan.tabName };
    } finally {
      release();
    }
  }

  function launchLine(resumeFile?: string | null, roleModel?: string | null, approve = false): string {
    // Convert raw argv to platform shell syntax (PowerShell '&' on win32, sh on POSIX); buildLaunchLine handles escaping.
    // buildLaunchParts constructs argv and applies D97's fullscreen default, with PI_HERDR_TUI=regular as the escape hatch.
    return buildLaunchLine(buildLaunchParts(runtime, { resumeFile, roleModel, approve }));
  }

  /**
   * D86 trust: delegation is trusted only for the master's checkout and its worktrees (one git
   * repository means the same project files); external directories omit -a so pi's Trust dialog
   * remains a gate and a spawn fails at handshake timeout until a person approves the unknown extension.
   */
  async function approveFor(cwd: string, masterCwd: string): Promise<boolean> {
    if (isPathUnder(cwd, masterCwd)) return true;
    const zone = classifyWorktreeZone({ cwd, masterCwd, worktrees: await listWorktrees(masterCwd) });
    return zone.zone === 'worktree';
  }

  /* ── GC: turn_start collection (v1.3 M8: tab-first, with pane compatibility/orphan paths) ── */

  let prevTurnStart = Date.now();

  async function gcPass(): Promise<void> {
    if (subs.size === 0) return;
    // D44: The only user-visible switch is the TTL in seconds (default 600); 0 disables automatic closure.
    const ttlMs = runtimePolicy.sessionTtlSeconds * 1000;
    const autoCloseTabs = ttlMs > 0;
    let panesList: Array<{ paneId: string; tabId: string; agentStatus: string }>;
    try {
      panesList = await client.listPanes();
    } catch {
      return;
    }
    // Snapshot herdr agent status per pane for collection decisions; a missing pane is recorded as closed.
    // This also fixes the regression where an undefined statuses map was swallowed by runGcSafely, disabling pane GC.
    const statuses = new Map(panesList.map((p) => [p.paneId, p.agentStatus]));
    const termPaneIds = terminalState.activePaneIds();
    // B2: Exempt panes whose settlement notice is undelivered so notification is attempted before collection.
    const pendingNoticeIds = d.noticePending?.() ?? new Set<string>();

    // Group task tabs, counting closed work panes as completed.
    const byTab = new Map<string, SubEntry[]>();
    for (const e of subs.values()) {
      if (!e.tabId) continue;
      const arr = byTab.get(e.tabId) ?? [];
      arr.push(e);
      byTab.set(e.tabId, arr);
    }
    const taskTabIds = new Set(byTab.keys());
    // D86 R4: Never close the main tab wholesale; consumed children there use pane-level collection.
    const mainTabId = env?.tabId ?? '';

    // 1) Tab-level collection; gc-core.shouldCloseTaskTab contains the pure, unit-tested predicate.
    for (const [tabId, entries] of byTab) {
      if (tabId === mainTabId) continue; // D86 R4: exempt the main tab to prevent taking down the master.
      const tabPanes = panesList.filter((p) => p.tabId === tabId);
      if (tabPanes.length === 0) {
        // A vanished tab (closed manually or automatically) is recorded as closed.
        for (const e of entries) {
          if (e.status !== 'closed') {
            e.status = 'closed';
            writeHistory(e, { status: 'closed', closedAt: Date.now() }, 'gc');
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
      // B2: Exempt panes whose settlement notice is undelivered so notification is attempted first.
      if (tabPanes.some((p) => termPaneIds.has(p.paneId) || pendingNoticeIds.has(p.paneId))) continue;
      try {
        await client.tabClose(tabId);
      } catch {
        /* The tab may already be gone. */
      }
      for (const e of entries) {
        if (e.status !== 'closed') {
          e.status = 'closed';
          writeHistory(e, { status: 'closed', closedAt: Date.now() }, 'gc');
        }
      }
      await new Promise((r) => setTimeout(r, 300)); // Serialize closure to guard against #1358-style races.
    }

    // 2) Pane-level collection (v1.2 compatibility, orphan handling, and D86 main-tab collection):
    //    consumed short-lived panes outside a closeable task tab, including panes in the main tab (R4).
    const closableTaskTabIds = new Set([...taskTabIds].filter((t) => t !== mainTabId));
    const candidates = [...subs.values()].filter(
      (e) => e.status === 'consumed' && !(e.tabId && closableTaskTabIds.has(e.tabId)),
    );
    for (const e of candidates) {
      if (termPaneIds.has(e.paneId) || pendingNoticeIds.has(e.paneId)) continue; // Exempt active terminals (D71) and undelivered notices (B2).
      if (!shouldClosePane({
        consumedAt: e.consumedAt ?? null,
        herdrStatus: statuses.get(e.paneId),
        prevTurnStart,
      })) continue;
      if (statuses.get(e.paneId) === undefined) {
        // A vanished pane (because its tab closed) is recorded as closed.
        e.status = 'closed';
        writeHistory(e, { status: 'closed', closedAt: Date.now() }, 'gc');
        continue;
      }
      try {
        await client.closePane(e.paneId);
      } catch {
        /* The pane may already be gone. */
      }
      e.status = 'closed';
      writeHistory(e, { status: 'closed', closedAt: Date.now() }, 'gc');
      await new Promise((r) => setTimeout(r, 300));
    }
    persistSubs();
  }

  /* ── D98: Automatically collect isolate worktrees when conditions permit (appended to gcPass; mount gate already enforces master-only) ── */

  /**
   * Candidates: ① registered isolate entries that are not released and no longer running;
   *            ② orphan refs/heads/pier/* branches whose worktree still appears in `git worktree list --porcelain`.
   * The master may restart without the old registry, so ② recovers crash leftovers.
   * Decide merged with merge-base --is-ancestor and dirty with status --porcelain in the worktree.
   * Release without --force (git rejects dirty worktrees as a second guard), retry once after 2s,
   * then leave it for the next ticker without notification spam. Notify registered retains once;
   * keep orphan retains silent. Never delete branches automatically.
   */
  async function isolateSweep(): Promise<void> {
    const trace = process.env.PI_HERDR_TRACE
      ? (msg: string) => { try { appendFileSync(process.env.PI_HERDR_TRACE!, `d98sweep ${Date.now()} ${msg}\n`); } catch { /* Best effort only. */ } }
      : null;
    const masterCwd = process.cwd();
    // Candidate key is the short branch name. Register every branch first, including running/released
    // entries, so orphan scanning cannot reclaim a new clean isolate before it settles.
    const registeredBranches = new Set<string>();
    for (const e of subs.values()) {
      if (e.isolate) registeredBranches.add(e.isolate.branch);
    }
    // ② Orphan candidates pair pier/* branches with porcelain worktrees; this covers crash leftovers
    // absent from the registry after a master restart, while registered branches use ① semantics.
    const wtPorcelain = await runGit(masterCwd, ['worktree', 'list', '--porcelain']);
    if (wtPorcelain === null) return;
    const wtByBranch = parseWorktreePorcelain(wtPorcelain);
    const pierBranchOut = await runGit(masterCwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/pier/']);
    const pierBranches = (pierBranchOut ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
    type Cand = { branch: string; wtPath: string; entry: SubEntry | null };
    const byBranch = new Map<string, Cand>();
    for (const branch of pierBranches) {
      if (registeredBranches.has(branch) || pendingIsolateBranches.has(branch)) continue;
      const wtPath = wtByBranch.get(branch);
      if (wtPath) byBranch.set(branch, { branch, wtPath, entry: null });
    }
    // ① Registered candidates, excluding running/released entries; for duplicate generations, keep the newest.
    for (const e of subs.values()) {
      if (!e.isolate || e.isolate.releasedAt != null || e.status === 'running') continue;
      const prev = byBranch.get(e.isolate.branch);
      byBranch.set(e.isolate.branch, { branch: e.isolate.branch, wtPath: prev?.wtPath ?? e.isolate.worktreePath, entry: e });
    }
    trace?.(`cands=${[...byBranch.keys()].join(',') || 'none'} subs=${[...subs.values()].map((s) => `${s.status}${s.isolate ? '/iso' : ''}`).join(',') || 'none'}`);
    let persisted = false;
    for (const cand of byBranch.values()) {
      const { branch, wtPath, entry } = cand;
      // A registered worktree missing from git's records may have been manually removed/pruned, or git
      // may have unregistered it after a Windows file-lock interruption while leaving the directory behind.
      // Remove that residue before closing the ledger; keep the branch, and retry next ticker if removal fails.
      if (entry && !wtByBranch.has(branch)) {
        if (existsSync(wtPath)) {
          try { rmSync(wtPath, { recursive: true, force: true }); } catch { continue; /* Lock remains; retry next round. */ }
          if (existsSync(wtPath)) continue;
        }
        entry.isolate!.releasedAt = Date.now();
        persisted = true;
        continue;
      }
      const mergedOut = await runGit(masterCwd, ['merge-base', '--is-ancestor', branch, 'HEAD']);
      const merged = mergedOut !== null ? true : null; // is-ancestor: exit 0 means yes; nonzero/null means no/unknown.
      // Distinguish a confirmed non-ancestor from command failure: failure yields merged=null for retain-unknown.
      let mergedFinal = merged;
      if (merged === null) {
        const sha = await runGit(masterCwd, ['rev-parse', branch]);
        const headSha = await runGit(masterCwd, ['rev-parse', 'HEAD']);
        if (sha != null && headSha != null) mergedFinal = false;
      }
      const dirtyOut = await runGit(wtPath, ['status', '--porcelain']);
      const dirtyCount = dirtyOut === null ? null : dirtyOut.split('\n').filter((l) => l.trim() !== '').length;
      const decision = evaluateRelease({ merged: mergedFinal, dirtyCount });
      if (decision.action === 'release') {
        const removed = await runGit(masterCwd, ['worktree', 'remove', wtPath]);
        let ok = removed !== null;
        if (!ok) {
          const { promise: retryDelay, resolve: retryNow } = Promise.withResolvers<void>();
          setTimeout(retryNow, 2000);
          await retryDelay;
          ok = (await runGit(masterCwd, ['worktree', 'remove', wtPath])) !== null; // Retry once.
        }
        if (ok) {
          worktreesCache = null; // Invalidate the 5s cache so placement sees the removed worktree immediately.
          if (entry) { entry.isolate!.releasedAt = Date.now(); persisted = true; }
        } // A failed removal remains for the next ticker, without notification spam.
      } else if (entry && !entry.isolate!.retainNotified) {
        entry.isolate!.retainNotified = true;
        persisted = true;
        try {
          await injectNotice(`worktree ${branch} retained (${decision.reason}) — merge it (git merge --no-ff ${branch}) or remove manually (git worktree remove --force ${wtPath})`);
        } catch {
          /* Injection failure stays silent; retainNotified prevents repeated alerts, while list_agents/ledger still expose it. */
        }
      } // Orphan retains remain silent.
    }
    if (persisted) persistSubs();
  }

  /** Serialize GC and drive it from both turn_start and the periodic ticker. */
  let gcRunning = false;
  async function runGcSafely(): Promise<void> {
    if (gcRunning) return;
    gcRunning = true;
    try {
      await gcPass();
    } catch {
      /* GC failure stays silent so the next turn/tick can retry. */
    }
    // D98: Isolate collection is separate from gcPass because gcPass's empty-subs early return would
    // swallow orphan scans; independent try blocks keep tab/pane GC from blocking worktree collection.
    try {
      await isolateSweep();
    } catch {
      /* Sweep failure stays silent so the next turn/tick can retry. */
    } finally {
      gcRunning = false;
    }
  }

  scoped.on('turn_start', async () => {
    const now = Date.now();
    await runGcSafely();
    prevTurnStart = now;
  });

  const gcTickMs = runtimePolicy.gcTickMs;
  const gcTicker = gcTickMs > 0 ? setInterval(() => { void runGcSafely(); }, gcTickMs) : null;
  // The ticker is disposed through an effect so HMR removes the old ticker before starting a new one (D80⑤).
  // The pipe server is intentionally not disposed here: index's common section owns it, and this plugin's
  // HMR reload must not kill a cross-module resource (d87).
  ctx.effect(() => () => {
    if (gcTicker) clearInterval(gcTicker);
  }, 'gc-ticker');

  /**
   * D94: Find an existing pane for the same session so resume reuses it instead of spawning a duplicate.
   * Return paneId + tabId, or null when no match exists or the agent has died.
   */
  async function findExistingPaneWithSession(sessionFile: string | null): Promise<{ paneId: string; tabId: string } | null> {
    if (!sessionFile) return null;
    try {
      const agents = await client.listAgents();
      const match = agents.find((a) => a.session === sessionFile && a.status !== 'unknown');
      if (!match) return null;
      // listAgents omits tabId, so fetch it from pane.list.
      const panes = await client.listPanes();
      const pane = panes.find((p) => p.paneId === match.paneId);
      return pane ? { paneId: match.paneId, tabId: pane.tabId } : null;
    } catch {
      return null;
    }
  }

  /** Revive a closed task; resume and automatic send_message revival share this path. */
  async function reviveEntry(entry: SubEntry): Promise<SubEntry> {
    // D98: Do not revive a released isolate worktree because its directory is gone and cwd is invalid.
    if (entry.isolate?.releasedAt != null) {
      throw new Error(`isolate worktree ${entry.isolate.branch} was released (merged) — delegate a new subagent instead`);
    }
    const latest = latestGeneration(readHistory(histFile(entry.cwd)), entry.taskId) ?? entry;
    const resumeFile = latest.sessionFile && /\.jsonl$/.test(latest.sessionFile) ? latest.sessionFile : null;
    // D86 trust matches spawn: pass -a only for the master's checkout/worktrees; revive has no tool context, so use process cwd.
    const approve = await approveFor(entry.cwd, process.cwd());
    const spawned = await spawnPaneInTaskTab(
      { desiredTab: entry.tabName || latest.tabName || null, description: entry.description },
      entry.cwd,
      { PI_HERDR_SUBAGENT: '1' },
      launchLine(resumeFile, null, approve),
    );
    const ready = await waitSubReady(entry.cwd, spawned.paneId);
    if (!ready) throw new Error(`revived pane ${spawned.paneId} pipe not ready`);
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

  scoped.registerTool({
    name: 'subagent',
    label: 'Subagent',
    description: SUBAGENT_DESCRIPTION,
    parameters: Type.Object({
      description: Type.String({ description: 'Short label for this subtask (pane title)' }),
      prompt: Type.String({ description: 'The complete self-contained task for the subagent' }),
      run_in_background: Type.Optional(Type.Boolean({ description: 'Return immediately with an agentId; the subagent keeps running in its own pane (default false)' })),
      cwd: Type.Optional(Type.String({ description: 'Working directory for the subagent (absolute, or relative to this workspace). Use it to delegate into a git worktree: panes group by worktree — same checkout as you share your tab; a separate worktree gets its own tab named after the worktree directory. Create worktrees yourself with git worktree add. Use isolate:true instead when you want a FRESH worktree created for this task rather than targeting an existing one' })),
      isolate: Type.Optional(Type.Boolean({ description: 'Create a fresh git worktree and run the subagent there. Use when the task writes files heavily and independently — in parallel with your own edits or other workers\' — or needs its own clean, reviewable diff. For read-mostly or sequential helper work omit it (shared checkout, writes guarded by the write-lock); use `cwd` only to target an existing directory/worktree (e.g. a retained pier worktree). Mechanics: branch pier/<slug> from your HEAD under ~/.herdr/worktrees/<repo>/; its writes cannot conflict with your checkout; panes group into a tab named after the worktree; the prompt is prefixed with commit discipline (commit to its branch, never push); on settle you get a diff summary. Review with git log/diff HEAD..<branch>, merge with git merge --no-ff <branch>; once merged and clean the worktree auto-removes (branch kept). Mutually exclusive with cwd' })),
    }),
    async execute(toolCallId, params, signal, onUpdate, toolCtx) {
      void toolCallId;
      void signal;
      const launch = planLaunchValidation(params, client.available);
      if (launch.kind === 'error') {
        return { content: [{ type: 'text', text: launch.text }], details: {} };
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
        const baseSha = await runGit(masterCwd, ['rev-parse', 'HEAD']);
        const isoGuard = planIsolateRepoGuard(baseSha);
        if (isoGuard.kind === 'error') {
          return { content: [{ type: 'text', text: isoGuard.text }], details: {} };
        }
        const sha = isoGuard.sha.trim();
        const pierBranches = new Set(
          ((await runGit(masterCwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/pier/'])) ?? '')
            .split('\n').filter(Boolean),
        );
        const worktrees = await listWorktrees(masterCwd);
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
        pendingIsolateBranches.add(plan.branch);
        const added = await runGit(masterCwd, ['worktree', 'add', '-b', plan.branch, wtPath, sha]);
        if (added === null) {
          pendingIsolateBranches.delete(plan.branch);
          return {
            content: [{ type: 'text', text: `Error: failed to create worktree ${wtPath} (branch ${plan.branch}) — run \`git worktree prune\` and retry if it reports stale entries` }],
            details: {},
          };
        }
        worktreesCache = null; // Invalidate the 5s cache so the zone classifier sees the new worktree immediately.
        cwd = wtPath;
        isolateMeta = { worktreePath: wtPath, branch: plan.branch, baseSha: sha, releasedAt: null, retainNotified: false };
        spec.prompt = `${buildIsolatePreamble({ worktreePath: wtPath, branch: plan.branch, baseShort: sha.slice(0, 7) })}\n\n${spec.prompt}`;
      } else if (cwdParam) {
        cwd = pathResolve(masterCwd, cwdParam);
        try {
          const st = await statAsync(cwd);
          if (!st.isDirectory()) throw new Error('not a directory');
        } catch {
          return {
            content: [{ type: 'text', text: `Error: \`cwd\` is not an existing directory: ${cwdParam}` }],
            details: {},
          };
        }
      }
      // D86 R1: Group by the git worktree containing cwd (main checkout → main tab; other worktree → directory-named tab).
      const zone = classifyWorktreeZone({
        cwd,
        masterCwd,
        worktrees: await listWorktrees(masterCwd),
      });
      // D86 trust: pass -a only for the master's checkout/worktrees; external directories remain behind pi's Trust dialog.
      const approve = isPathUnder(cwd, masterCwd) || zone.zone === 'worktree';
      let roleManifestEnv: Record<string, string> = {};
      let roleModel: string | null = null;
      try {
        const { role, manifest } = composeForRole(manifestRole, suggested, { loadRoleOpts: { baseDir: masterCwd } });
        roleManifestEnv = {
          PI_HERDR_ROLE_MANIFEST: JSON.stringify({
            role: role.role,
            version: role.version,
            tools: manifest.tools,
            permissions: manifest.permissions,
            unknownTools: manifest.unknownTools,
            services: role.services ?? {},
          }),
        };
        // WS-D10: Route the model by role; omission intentionally uses the process default.
        if (typeof role.model === 'string' && role.model.trim()) roleModel = role.model.trim();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `Error: role "${manifestRole}" manifest invalid — ${msg}` }],
          details: {},
        };
      }
      const release = await subSemaphore.acquire();
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
        if (!ready) throw new Error(`subagent pane ${paneId} pipe not ready within ${SUB_READY_TIMEOUT_MS}ms`);
        entry.sessionFile = await resolveSessionFile(paneId, cwd);
        subs.set(paneId, entry);
        persistSubs();
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
          from: pipeNameFor(cwd, env?.paneId ?? ''),
          push: background,
        });
        if (injected.type !== 'ok') {
          throw new Error(`pipe prompt rejected: ${injected.type === 'error' ? injected.message : 'unknown response'}`);
        }
        lastMachineInjectAt.set(paneId, injectTs); // B4: attribute working state during the observation window.
        // A1+A2 (user-verified fix): foreground waiting uses a content gate plus a patience threshold before backgrounding.
        // Treating idle as settled with a hard 90s window misclassified real 4–6 minute working periods as no-output;
        // three healthy subagents were observed becoming consumed at 101s while producing results four minutes later.
        const PATIENCE_MS = runtimePolicy.foregroundPatienceMs;
        const patienceDeadline = Date.now() + PATIENCE_MS;
        let text: string | null = null;
        let settledKind: 'settled' | 'timeout' = 'timeout';
        while (Date.now() < Math.min(patienceDeadline, spawnedAt + SUBAGENT_TIMEOUT_MS)) {
          const state = await client.waitAgent(paneId, ['idle', 'done', 'blocked'], 30_000);
          const session = (state === 'idle' || state === 'done')
            ? await subSessionState(paneId, cwd, injectTs)
            : { text: null, pendingTool: false, activity: false };
          const tick = planForegroundTick({ state, session });
          if (tick.kind === 'blocked') {
            const question = await readAskFlag(paneId);
            entry.background = true;
            lastRequestIdByPane.set(paneId, `prompt-${taskId}`);
            startPoller(paneId, cwd, spawnedAt, injectTs, spec.description, `prompt-${taskId}`);
            persistSubs();
            writeHistory(entry, undefined, 'to-background');
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
            await new Promise((r) => setTimeout(r, tick.delayMs));
            continue;
          }
          if (tick.kind === 'collect-final') {
            text = await collectFinalText(paneId, cwd, injectTs, 6);
            if (text) { settledKind = 'settled'; break; }
            await new Promise((r) => setTimeout(r, FOREGROUND_POLL_MS));
            continue;
          }
        }
        if (!text && settledKind !== 'blocked') {
          const probe = await probeAlive(paneId, cwd);
          if (planPatienceExpiry(isAlive(probe, Date.now())) === 'move-to-background') {
            entry.background = true;
            lastRequestIdByPane.set(paneId, `prompt-${taskId}`);
            startPoller(paneId, cwd, spawnedAt, injectTs, spec.description, `prompt-${taskId}`);
            persistSubs();
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
        persistSubs();
        writeHistory(entry, { outcome: outcome.kind === 'completed' ? text : null }, 'fg-settle');
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
          persistSubs();
          void client.closePane(paneId).catch(() => { /* Best effort only. */ });
        }
        // D98 2d: If isolate startup never becomes ready, best-effort remove the new worktree and branch (no work
        // exists to preserve); failure stays silent because the branch is harmless and remains visible to git worktree list.
        if (isolateMeta) {
          void runGit(masterCwd, ['worktree', 'remove', '--force', isolateMeta.worktreePath])
            .then(() => runGit(masterCwd, ['branch', '-D', isolateMeta!.branch]))
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
        if (isolateMeta) pendingIsolateBranches.delete(isolateMeta.branch); // D98: release the creation-window guard on every success/failure path.
      }
    },
  });

  /* ── Tool: resume_subagent (historical revival, v1.2) ── */

  scoped.registerTool({
    name: 'resume_subagent',
    label: 'Resume Subagent',
    description:
      'Revive a finished (collected) subagent from the delegation ledger: opens its saved conversation in a new pane (pi --session), then use send_message to give it new work. The ledger is an append-only JSONL file, one row per status change (same taskId rows = generations, latest row is current): fields taskId, description, status (running|settled|consumed|closed), outcome (closing text), paneId, sessionFile, launchCommand, createdAt. It is per-checkout at ~/.pi/agent/herdr-pi/history/<flattened-cwd>/history.jsonl (e.g. checkout F:\\repo -> --F--repo--), so each git worktree has its own volume. Use list_agents for live panes from this session; for tasks from earlier sessions or closed panes, read/grep the ledger file for the taskId, then pass it here.',
    parameters: Type.Object({
      taskId: Type.String({ description: 'The task id to revive' }),
    }),
    async execute(_tc, params, _sig, _upd, toolCtx) {
      if (!client.available) {
        return {
          content: [{ type: 'text', text: 'Error: requires a herdr-managed pane.' }],
          details: {},
        };
      }
      const cwd = (toolCtx as { cwd?: string }).cwd ?? process.cwd();
      const taskId = String(params?.taskId ?? '');
      const latest = latestGeneration(readHistory(histFile(cwd)), taskId);
      if (!latest) {
        return {
          content: [{ type: 'text', text: `Error: no history for task "${taskId}" in this workspace.` }],
          details: {},
        };
      }
      const release = await subSemaphore.acquire();
      try {
        // D94: Reuse an existing pane for the same session to avoid competing pi processes.
        const existing = await findExistingPaneWithSession(latest.sessionFile);
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
            sessionFile: latest.sessionFile,
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
        return {
          content: [{ type: 'text', text: `Error: failed to resume task "${taskId}": ${(err as Error).message}` }],
          details: {},
        };
      } finally {
        release();
      }
    },
  });

  /* ── Tool: list_agents (background/long-lived subagents only; foreground short panes are transient UI) ── */

  scoped.registerTool({
    name: 'list_agents',
    label: 'List Subagents',
    description:
      'List the background subagents you started, with their live state: running (working or blocked), idle (settled), plus pane ids, live agent status, last session activity time, role (task or a role label), and descriptions. Foreground one-shot panes are transient and not listed. Covers only this session branch — for tasks from earlier sessions or collected panes, read the delegation ledger (path and format in resume_subagent) and resume by taskId.',
    parameters: Type.Object({}),
    async execute() {
      const listed = [...subs.values()].filter((s) => s.background);
      if (listed.length === 0) {
        return { content: [{ type: 'text', text: 'No background subagents started (from this session branch).' }], details: {} };
      }
      // Deduplicate by taskId so only the newest generation appears after revival; old paneIds do not repeat.
      const byTask = new Map<string, SubEntry>();
      for (const sub of listed) {
        const prev = byTask.get(sub.taskId);
        if (!prev || sub.createdAt >= prev.createdAt) byTask.set(sub.taskId, sub);
      }
      // C1: Probe liveness in real time (pane status and session activity) so the master can distinguish work from a true hang.
      const probes = new Map<string, AliveProbe>();
      await Promise.all([...byTask.values()].map(async (sub) => {
        if (sub.status === 'closed') return;
        try { probes.set(sub.paneId, await probeAlive(sub.paneId, sub.cwd)); } catch { /* Best effort for display. */ }
      }));
      const lines: string[] = [];
      for (const sub of byTask.values()) {
        const tabTag = sub.tabName ? ` [tab: ${sub.tabName}]` : '';
        // D98: Include the worktree branch on isolate entries, including closed ones; settlement stats already report merge state.
        const wtTag = sub.isolate ? ` [wt: ${sub.isolate.branch}]` : '';
        if (sub.status === 'closed') {
          lines.push(`${sub.taskId.slice(0, 8)} [idle] (${sub.kind}, closed; send_message revives)${tabTag}${wtTag} ${sub.description}`);
          continue;
        }
        // The registry is authoritative: settled is idle, everything else is running, including blocked human gates (DSH mapping).
        const state = sub.status === 'settled' ? 'idle' : 'running';
        // D94: Mark when the user has taken over.
        const takeoverMark = sub.userTakeover ? ', user-controlled' : '';
        const probe = probes.get(sub.paneId);
        const statusTag = probe?.agentStatus ? ` ${probe.agentStatus}` : '';
        const activityTag = probe?.lastActivityMs != null ? `, active ${agoText(probe.lastActivityMs, Date.now())}` : '';
        // E: For blocked agents, include the gate-question summary so the master sends the user to that pane instead of taking over.
        let gateTag = '';
        if (probe?.agentStatus === 'blocked') {
          const q = await readAskFlag(sub.paneId);
          gateTag = q ? ` — AWAITING HUMAN: "${q}"` : ' — AWAITING HUMAN decision';
        }
        lines.push(`${sub.paneId} [${state}${takeoverMark}${statusTag}${activityTag}${gateTag}] (${sub.kind})${tabTag}${wtTag} ${sub.description}`);
      }
      return { content: [{ type: 'text', text: lines.join('\n') }], details: {} };
    },
  });

  /* ── Tool: send_message (delivery during steer gaps) ── */

  scoped.registerTool({
    name: 'send_message',
    label: 'Send to Subagent',
    description:
      'Send a follow-up message to a background subagent. If it is working, the message is delivered at its next tool-call gap (steer, seconds); if it is idle, it wakes the subagent for a new turn. `agentId` is the id returned by the subagent tool or shown by list_agents.',
    parameters: Type.Object({
      agentId: Type.String({ description: 'The subagent id (herdr pane id)' }),
      message: Type.String({ description: 'The follow-up message' }),
    }),
    async execute(_tc, params) {
      const entry = subs.get(String(params?.agentId ?? ''));
      if (!entry) {
        return { content: [{ type: 'text', text: `Error: unknown subagent id "${params?.agentId}" (see list_agents)` }], details: {} };
      }
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
        if (!ready) throw new Error(`subagent pane ${entry.paneId} pipe not ready`);
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
        return { content: [{ type: 'text', text: `Error: failed to reach subagent ${entry.paneId}: ${(err as Error).message}` }], details: {} };
      }
    },
  });

  /* ── Tool: interrupt_agent (D48: pipe → child extension ctx.abort(), in-process cancellation) ── */

  scoped.registerTool({
    name: 'interrupt_agent',
    label: 'Interrupt Subagent',
    description:
      'Interrupt a background subagent (stops its current turn; fire-and-return). The subagent stays alive and can receive further send_message work.',
    parameters: Type.Object({
      agentId: Type.String({ description: 'The subagent id (herdr pane id)' }),
    }),
    async execute(_tc, params) {
      const entry = subs.get(String(params?.agentId ?? ''));
      if (!entry) {
        return { content: [{ type: 'text', text: `Error: unknown subagent id "${params?.agentId}" (see list_agents)` }], details: {} };
      }
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
        return { content: [{ type: 'text', text: `Error: failed to reach subagent ${entry.paneId}: ${(err as Error).message}` }], details: {} };
      }
    },
  });
}
