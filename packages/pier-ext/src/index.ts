/**
 * pi-herdr extension entry point and composition root.
 *
 * Layout: index-runtime.ts picks the process mode (worker / bare pi / herdr master);
 * index-roles.ts the role runtime, index-gates.ts human-gate reporting, index-pipe.ts the
 * pipe protocol handler, index-notices.ts the notice buffer, index-locks.ts write locks;
 * index-master.ts / index-worker.ts are the dynamic master / todo-only mounts.
 *
 * pi contract: onUpdate must have AgentToolResult shape (a string crashes the TUI); tool-result
 * details persist in session JSONL and getBranch() replay implements branch rollback.
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  ASK_PARAMETERS,
  ASK_PROMPT_GUIDELINES,
  ASK_TOOL_DESCRIPTION,
  ASK_TOOL_NAME,
  gateLabel,
  hasAskUi,
  noUiResult,
  prepareAsk,
  runAsk,
} from './ask-user.ts';
import { pipeNameFor, pipeRequest, startPipeServer } from './pipe-channel.ts';
import { TODO_EDIT_CUSTOM_TYPE, currentActivity } from './todo-core.ts';
import { installRenderers } from './renderers.ts';
import { createHerdrClient } from './herdr-client.ts';
import { bareSessionId, lastAssistantText, readSessionFile, resolveSessionFileValue } from './session-tail.ts';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { platformPaths } from './platform-paths.ts';
import { TodosService, type TodoCompletionSource } from './todos-service.ts';
import { reconcileTodos } from './reconcile-core.ts';
import type { TodoUiSlot } from './plugins/todo.ts';
import { estimateEta, formatProgressSuffix, planToolBadge, progressOf } from './progress-core.ts';
import { WRITE_LOCK_ENV } from './lock-core.ts';
import { ABORT_STOP_REASON, planSettleWake } from './settle-wake-core.ts';
import { parseRuntimeManifest } from './tool-gate.ts';
import { formatPaneTitle } from './pane-title.ts';
import { registerSlimFrame, updateSlimFrame } from './slim-frame.ts';
import { planIndexMode } from './index-runtime.ts';
import { emptySubagentPortBox } from './subagent-core.ts';
import { createNoticeBuffer } from './index-notices.ts';
import { handlePipeRequest, type MachineRequest } from './index-pipe.ts';
import { installWriteLocks } from './index-locks.ts';
import { installDashboardCommand } from './dashboard-command.ts';
import { registerObservationPack, createCompactionBatchPackHook, type PickMiddleExcerpt } from './plugins/observation.ts';
import { createJevRuntime } from './jev-client.ts';
import {
  NOTICE_RANK_MIN_CONFIDENCE,
  buildExcerptWindows,
  composeNoticeRanking,
  evaluateExcerptPick,
  excerptAskIsSafe,
  excerptPickRequest,
  noticeRankRequest,
} from './jev-core.ts';
import { completeLineExcerpt } from './observation-core.ts';
import { installConfigCommand } from './config-command.ts';
import { CompactCoordinator } from './compact-coordinator.ts';
import { handleReducerToolResult, type ToolResultEventLike } from './reducer-invoker.ts';
import { appendEfficiencyLog, efficiencyLogPath, pruneSessionObjects, resolveSessionRoot } from './efficiency-store.ts';
import type { RoutingTelemetryRecord, RoutingTelemetryRow } from './routing-telemetry.ts';
import { loadEfficiencyConfigFromDisk, resolveEfficiencyConfig, type EfficiencyConfig } from './efficiency-config-core.ts';
import { resolveDefaultFocusPollMs, parseFocusSample, spawnReflow, startFocusPoller, type FocusPoller } from './focus-poller.ts';
import { composeMasterRuntime, createRoleRuntime } from './index-roles.ts';
import { createGateRuntime } from './index-gates.ts';

/** D-4: PIER_FOCUS_POLL_MS=0 disables the poller; invalid values fall back to the version default. */
function focusPollIntervalMs(env: NodeJS.ProcessEnv = process.env, herdrVersion?: string | null): number {
  const defaultMs = resolveDefaultFocusPollMs(herdrVersion);
  const ms = Number(env.PIER_FOCUS_POLL_MS);
  return env.PIER_FOCUS_POLL_MS !== undefined && env.PIER_FOCUS_POLL_MS.trim() !== '' && Number.isFinite(ms) && ms >= 0
    ? ms
    : defaultMs;
}

function agentSessionsDir(): string {
  return process.env.PI_CODING_AGENT_DIR ? join(process.env.PI_CODING_AGENT_DIR, 'sessions') : platformPaths.sessionsDir;
}

export default async function (pi: ExtensionAPI) {
  const mode = planIndexMode();
  const isSubagent = mode.isSubagent;
  const roleBase = process.env.PI_HERDR_ROLE_BASE || process.cwd();

  let sessionId: string = process.env.PI_SESSION_FILE ?? process.env.PI_SESSION_ID ?? '';
  let sessionRoot: string | null = null;
  let effConfig: EfficiencyConfig = resolveEfficiencyConfig();
  const coordinator = new CompactCoordinator();
  const { client, env } = createHerdrClient();

  const initialManifest =
    parseRuntimeManifest(process.env.PI_HERDR_ROLE_MANIFEST) ??
    (mode.composeMaster ? composeMasterRuntime() : null);
  const todos = new TodosService(TodosService.configFromRuntime(initialManifest, isSubagent));

  /** Phase 0 routing telemetry (RFC docs/rfc-jev-role-routing.md §8): best-effort append; never gates anything. */
  const appendRoutingLog = (row: RoutingTelemetryRecord): void => {
    const root = sessionRoot;
    if (!root) return;
    const stamped: RoutingTelemetryRow = { ...row, sessionId: sessionId || 'unknown' };
    void appendEfficiencyLog(efficiencyLogPath(root, 'routing'), stamped).catch(() => {});
  };

  const roles = createRoleRuntime({ pi, client, roleBase, initialManifest, isSubagent, todos, appendRoutingLog });

  /* ── Jev decision layer (RFC docs/rfc-jev-integration.md): direct HTTP, total-budget
   * abort, fail-open at every site. Disabled or keyless → behavior identical to before. ── */
  const jevRuntime = createJevRuntime(() => effConfig.jev, { getSessionRoot: () => sessionRoot });
  /** P0-3: candidate windows are generated in code; jev only picks (rerank pattern). */
  const pickMiddleExcerpt: PickMiddleExcerpt = async (text, excerptBudgetBytes) => {
    if (!jevRuntime.available) return null;
    const halfBudget = Math.floor(excerptBudgetBytes / 2);
    const windows = buildExcerptWindows(text, halfBudget);
    if (windows.length === 0) return null; // degenerate budget only
    const headExcerpt = completeLineExcerpt(text, halfBudget, false);
    const tailExcerpt = completeLineExcerpt(text, excerptBudgetBytes - halfBudget, true);
    // Credential-shaped text never leaves the process (§8 privacy boundary).
    if (!excerptAskIsSafe(windows, headExcerpt, tailExcerpt)) return null;
    const request = excerptPickRequest(windows, headExcerpt, tailExcerpt);
    if (!request) return null;
    const result = await jevRuntime.ask(request, {
      questionId: 'obs-excerpt-window',
      extra: { site: 'obs-excerpt', candidates: windows.map((w) => w.id) },
      enrich: ({ answers }) => {
        if (!answers || answers.window === undefined || answers.window.type !== 'choice') return {};
        return { picked: answers.window.choice, confidence: answers.window.confidence };
      },
    });
    if (!result.ok) return null;
    const picked = evaluateExcerptPick(result.answers, effConfig.jev.minConfidence);
    const window = picked === null ? undefined : windows.find((w) => w.id === picked);
    return window ? { text: window.text, label: window.label } : null;
  };

  const rendererTypes = installRenderers(pi);
  if (process.env.PI_HERDR_TRACE) {
    console.error(`[pi-herdr] transcript renderers: ${rendererTypes.length ? rendererTypes.join(', ') : 'none'}`);
  }

  let agentActive = false;
  let lastStopReason: string | null = null;
  let latestCtx: { abort?: () => void } | null = null;
  const completedStamps: number[] = [];
  const subagentPort = emptySubagentPortBox();
  let d96NoticeKey: string | null = null;
  let d96NoticeAt = 0;

  const todoUi: TodoUiSlot = { renderWidget: () => { /* filled after plugin mounting */ } };
  const gates = createGateRuntime({
    pi,
    client,
    rerenderWidget: () => todoUi.rerenderWidget?.(),
    isAgentActive: () => agentActive,
    idleMessage: () => roles.idleBadge(),
    workingMessage: () => currentActivity(todos.items),
  });

  /** Session identity: sessionManager is authoritative (env may be unset in print/RPC mode). */
  function resolveSessionId(ctx: unknown): string {
    try {
      const sm = (ctx as {
        sessionManager?: { getSessionFile?: () => string | undefined; getSessionId?: () => string };
      }).sessionManager;
      return bareSessionId(
        sm?.getSessionFile?.() ?? sm?.getSessionId?.() ?? process.env.PI_SESSION_FILE ?? process.env.PI_SESSION_ID ?? '',
      );
    } catch {
      return bareSessionId(process.env.PI_SESSION_FILE ?? '');
    }
  }

  /** Branch reconstruction: todos + OCC debt state (branch correctness from the last snapshot on the branch). */
  function rebuildFromBranch(ctx: unknown): void {
    try {
      const entries = (ctx as { sessionManager?: { getBranch?: () => readonly unknown[] } })
        ?.sessionManager?.getBranch?.() ?? [];
      todos.rebuild(entries);
      coordinator.rebuildFromBranch(entries);
    } catch {
      /* A reconstruction failure must not disrupt the main flow; the next todo_write re-anchors. */
    }
  }

  function mirrorTodos(): void {
    if (!client.available) return;
    const label = sessionId || (env ? `pane:${env.paneId}` : '');
    const p = progressOf(todos.items);
    const eta = estimateEta({ completedAt: completedStamps, total: p.total, now: Date.now() });
    const suffix = formatProgressSuffix({ completed: p.completed, total: p.total, eta });
    const title = formatPaneTitle(todos.items, null, { progressSuffix: suffix, lastWriteAt: todos.lastWriteAt });
    updateSlimFrame({ title, items: todos.items, lastWriteAt: todos.lastWriteAt });
    client.reportMetadata({
      session: label,
      items: todos.items,
      progressSuffix: suffix,
      lastWriteAt: todos.lastWriteAt,
    }).catch(() => {});
  }

  /** M17 settlement reconciliation: auto-complete settled todos / unblock on failure notes (idempotent). */
  function reconcileOnSettlement(description: string, outcome: 'settled' | 'failed'): string[] {
    if (!description) return [];
    try {
      const plan = reconcileTodos(todos.items, { description, outcome });
      if (plan.edits.length > 0) {
        try {
          (pi as { appendEntry?: (customType: string, data: unknown) => void }).appendEntry?.(
            TODO_EDIT_CUSTOM_TYPE,
            { version: 1, edits: plan.edits, ts: Date.now() },
          );
        } catch {
        }
        todos.applyEdits(plan.edits, { source: 'reconcile' });
        mirrorTodos();
      }
      return plan.noteLines;
    } catch {
      return [];
    }
  }

  const withReconcileNotes = (base: string, notes: readonly string[]): string =>
    notes.length ? `${base}\n${notes.join('\n')}` : base;

  todos.on('todo.completed', (e: { count: number; at: number; source?: TodoCompletionSource }) => {
    for (let i = 0; i < e.count; i++) completedStamps.push(e.at);
    coordinator.recordBoundaryCompleted(e.count, e.source);
    mirrorTodos();
  });

  /* ── tool badges: parallel calls start in source order, end in completion order ── */
  const runningTools = new Map<string, string>(); // toolCallId → toolName
  let lastToolBadge: string | null = null;
  function reportToolBadge(): void {
    const badge = planToolBadge([...new Set(runningTools.values())]);
    if (badge === lastToolBadge) return; // report only changes (M13 rendering discipline)
    lastToolBadge = badge;
    if (badge) gates.report('working', badge);
    else gates.report(agentActive ? 'working' : 'idle', agentActive ? currentActivity(todos.items) : null);
  }
  pi.on('tool_execution_start', async (event: { toolCallId?: string; toolName?: string }) => {
    if (typeof event?.toolCallId === 'string' && typeof event?.toolName === 'string') {
      runningTools.set(event.toolCallId, event.toolName);
      reportToolBadge();
    }
  });
  pi.on('tool_execution_end', async (event: { toolCallId?: string }) => {
    if (typeof event?.toolCallId === 'string') {
      runningTools.delete(event.toolCallId);
      reportToolBadge();
    }
  });

  /* ── D102 evidence-preserving reducer (registered before append-handlers like write-locks) ── */
  pi.on('tool_result', async (event, ctx) => {
    if (!effConfig.evidencePreservingReducer.enabled) return;
    if (!event || typeof event !== 'object') return;
    return handleReducerToolResult(event as unknown as ToolResultEventLike, ctx, effConfig.evidencePreservingReducer, {
      epoch: coordinator.state.epoch,
      jev: { ask: jevRuntime.ask, getMinConfidence: () => effConfig.jev.minConfidence },
    });
  });

  let locksHandle = { getHeldLocks: () => [] as readonly string[] };
  if (env) {
    locksHandle = installWriteLocks(pi, { client, env, hard: process.env[WRITE_LOCK_ENV] === '1' });
  }

  /** pi's sendUserMessage is fire-and-forget (void); callers of this wrapper still get a promise. */
  const sendUserMessageAs = (content: string, mode: 'steer' | 'followUp'): Promise<void> => {
    (pi as unknown as { sendUserMessage?: (content: string, opts?: { deliverAs?: string; triggerTurn?: boolean }) => void })
      .sendUserMessage?.(content, { deliverAs: mode, triggerTurn: true });
    return Promise.resolve();
  };
  const notices = createNoticeBuffer({
    isBusy: () => agentActive || lastStopReason === ABORT_STOP_REASON,
    send: sendUserMessageAs,
    // P0-2: rank collapsed batches by relevance to the master's in-progress work.
    rank: async (contents) => {
      if (!jevRuntime.available) return null;
      const inProgressTodos = todos.items.filter((item) => item.status === 'in_progress').map((item) => item.content);
      let rankedOrder: number[] | null | undefined;
      const result = await jevRuntime.ask(
        noticeRankRequest({ inProgressTodos, notices: [...contents] }),
        {
          questionId: 'notice-rank',
          sessionId,
          extra: { site: 'notice-rank', noticeCount: contents.length },
          enrich: ({ answers }) => {
            if (!answers) return {};
            rankedOrder = composeNoticeRanking(
              contents.length,
              answers,
              Math.max(effConfig.jev.minConfidence, NOTICE_RANK_MIN_CONFIDENCE),
            );
            const values = Array.from({ length: contents.length }, (_, i) => {
              const rank = answers[`notice_${i}_rank`];
              const fail = answers[`notice_${i}_fail`];
              return rank !== undefined && fail !== undefined && rank.type === 'score' && fail.type === 'noul'
                ? `${rank.score.toFixed(2)}:${rank.confidence.toFixed(2)}:${fail.noul.toFixed(2)}`
                : '?';
            });
            return { order: rankedOrder === null ? 'fallback' : rankedOrder.join(','), values };
          },
        },
      );
      if (!result.ok) return null;
      return rankedOrder === undefined || rankedOrder === null ? null : rankedOrder.map((index) => contents[index]!);
    },
  });
  const deliverNotice = notices.deliverNotice;

  /* ── pipe channel: this pane's NDJSON server + the settle fast-path push (D48/D49/D50) ── */
  const pipeServerBox: { current: ReturnType<typeof startPipeServer> | null } = { current: null };
  let pendingMachineRequest: MachineRequest | null = null;
  /** Dedup latch for settle notices: one per paneId+request id per round. */
  const settleNoticeLatch = new Set<string>();
  function claimSettleNotice(key: string): boolean {
    if (settleNoticeLatch.has(key)) return false;
    settleNoticeLatch.add(key);
    return true;
  }

  function startPipeServerFor(cwd: string): void {
    const paneId = env?.paneId ?? '';
    if (!paneId) return;
    if (pipeServerBox.current) {
      try { pipeServerBox.current.close(); } catch { /* Previous instance. */ }
      pipeServerBox.current = null;
    }
    try {
      pipeServerBox.current = startPipeServer(pipeNameFor(cwd, paneId), async (req) => handlePipeRequest(req, {
        paneId,
        port: subagentPort,
        claimSettleNotice,
        deliverNotice,
        sendUserMessageIn: (content) => sendUserMessageAs(content, 'followUp'),
        sendUserMessageAs,
        abort: () => { latestCtx?.abort?.(); },
        setPendingMachineRequest: (next) => { pendingMachineRequest = next; },
        applyRoleSwitch: roles.applyRoleSwitch,
      }));
    } catch {
      /* Pipe name collision (rare): this session has no channel; callers report after ping timeout. */
    }
  }

  async function pushSettleReply(): Promise<void> {
    const req = pendingMachineRequest;
    if (!req || !req.push || !req.from) return;
    pendingMachineRequest = null;
    try {
      const ownFile = sessionId ? resolveSessionFileValue(process.cwd(), agentSessionsDir(), sessionId) : null;
      let text: string | null = null;
      if (ownFile) {
        const entries = readSessionFile(ownFile);
        if (entries) text = lastAssistantText(entries, { sinceTs: req.sinceTs })?.text ?? null;
      }
      await pipeRequest(req.from, {
        type: 'reply',
        id: req.id,
        paneId: env?.paneId ?? '',
        text,
        // Push the resolved PATH when readable; fall back to the bare id for the master-side mapping.
        sessionFile: ownFile ?? (sessionId || null),
      }, 5000);
    } catch (err) {
      /* The requester's pollLoop is the fallback; surface the dead letter for triage. */
      console.error(`pier: settle reply push to ${req.from} failed: ${(err as Error)?.message ?? err}`);
    }
  }

  const sessionFocusPoller: { current: FocusPoller | null } = { current: null };

  pi.on('session_start', async (event, ctx) => {
    sessionId = resolveSessionId(ctx);
    latestCtx = ctx as { abort?: () => void } | null;
    const cwd = (ctx as { cwd?: string }).cwd ?? process.cwd();
    const isTrusted =
      typeof (ctx as { isProjectTrusted?: () => boolean }).isProjectTrusted === 'function'
        ? (ctx as { isProjectTrusted: () => boolean }).isProjectTrusted()
        : false;
    effConfig = loadEfficiencyConfigFromDisk({ cwd, isProjectTrusted: isTrusted });
    sessionRoot = resolveSessionRoot(
      (ctx as { sessionManager?: { getSessionDir?: () => string | undefined } })?.sessionManager?.getSessionDir?.(),
      sessionId,
    );
    // On resume pi restores widget state from the session; calling setWidget again
    // breaks the TUI '/' command-panel route (v1.3 M9).
    if ((event as { reason?: string } | undefined)?.reason !== 'resume') todoUi.renderWidget(ctx);
    // D97: narrow-frame overlay is meaningful only inside herdr; re-register (session switching resets it).
    if (env) registerSlimFrame(ctx);
    // P2-5: resume folds todos/compaction state from the branch like session_tree; a fresh session folds nothing.
    rebuildFromBranch(ctx);
    mirrorTodos();
    roles.syncFromBranch(ctx);
    if (mode.composeMaster && sessionRoot) roles.scanRoleUsage();
    gates.report('idle', null);
    // Self-healing: the ask marker lives in herdr with a 24h TTL; a session killed
    // while a dialog was open must not keep the pane looking blocked forever.
    void client.reportAskFlag(null).catch(() => {});

    // D-4 focus sampling: herdr <0.9.1 never delivered pane.focused to plugins;
    // 0.9.1+ is event-first (pollMs 0). One poller per pane, self-scoped.
    if (sessionFocusPoller.current) sessionFocusPoller.current.stop();
    sessionFocusPoller.current = null;
    const paneId = env?.paneId ?? '';
    const serverVer = await client.getServerVersion();
    const pollMs = focusPollIntervalMs(process.env, serverVer);
    if (paneId && client.available && pollMs > 0) {
      sessionFocusPoller.current = startFocusPoller({
        myPaneId: paneId,
        intervalMs: pollMs,
        sample: async () => {
          // layout.export reports the focused pane of our own tab; without the
          // field (older herdr) the tick stays silent instead of guessing.
          const layout = await client.exportLayout({ paneId });
          const sample = parseFocusSample(layout);
          return sample && sample.focusedPaneId !== null ? sample : null;
        },
        fire: (focusedPaneId, cause) => spawnReflow({ paneId: focusedPaneId, cause }),
      });
    }
    startPipeServerFor(cwd);
  });

  pi.on('session_tree', async (_event, ctx) => {
    sessionId = resolveSessionId(ctx);
    rebuildFromBranch(ctx);
    // pi reverts the transcript loadout at the navigated branch point; the role
    // runtime follows the same point (same-origin, RFC §4.3).
    roles.syncFromBranch(ctx);
    todoUi.renderWidget(ctx);
    mirrorTodos();
  });

  pi.on('turn_start', async () => {
    agentActive = true;
    // A11: reset so a previous turn's abort cannot taint this one.
    lastStopReason = null;
    // Safety fallback: pi core prohibits prompts while compaction is active.
    coordinator.compactionInFlight = false;
    coordinator.intentionalAbort = false;
    gates.report('working', currentActivity(todos.items));
  });

  pi.on('before_provider_request', (_event: unknown, ctx: unknown) => {
    const usage = (ctx as { getContextUsage?: () => { tokens?: number | null } })?.getContextUsage?.();
    if (typeof usage?.tokens === 'number') {
      coordinator.onBeforeProviderRequest(usage.tokens);
    }
  });

  pi.on('input', (event: unknown) => {
    if (event && typeof event === 'object') {
      coordinator.onInput(event as { text?: string; source?: string; streamingBehavior?: string });
    }
  });

  pi.on('session_before_tree', () => (coordinator.compactionInFlight ? { cancel: true } : undefined));

  pi.on('turn_end', async (event: unknown, ctx) => {
    // Master registered this twice: the lifecycle handler skipped malformed events, the notice
    // flush ran regardless. The merged handler keeps both semantics.
    const msg = event !== null && typeof event === 'object' && 'message' in event ? (event as { message: unknown }).message : null;
    if (msg !== null && typeof msg === 'object') {
      const { role, stopReason } = msg as { role?: unknown; stopReason?: unknown };
      if (role === 'assistant' && typeof stopReason === 'string') {
        lastStopReason = stopReason;
      }
      if (ctx && typeof ctx === 'object') {
        coordinator.onTurnEnd({
          ctx,
          todos: todos.items,
          config: effConfig.onlineContextCompact,
          cancelReminder: todoUi.cancelReminder,
        });
      }
    }
    void notices.flush('steer');
  });

  pi.on('agent_settled', async (_event: unknown, ctx) => {
    agentActive = false;
    gates.report('idle', null);
    const plan = planSettleWake({
      lastStopReason,
      intentionalAbort: coordinator.intentionalAbort,
      running: subagentPort.current?.listRunningSubs() ?? [],
      lastNoticeKey: d96NoticeKey,
      lastNoticeAt: d96NoticeAt,
      now: Date.now(),
    });
    d96NoticeKey = plan.noticeKey;
    d96NoticeAt = plan.noticeAt;
    // D96: master settled while background subagents still run → remind (worker port is unbound).
    if (plan.wake && plan.notice && !isSubagent) {
      const running = subagentPort.current?.listRunningSubs() ?? [];
      const brief = running.map((s) => `${s.paneId} (${s.description})`).join('、');
      const notice = `注意：仍有 ${running.length} 个后台 subagent 在运行：${brief}。若你的任务依赖它们，请等待其结算（subagent list 查看状态）；若不等待，请说明放弃原因。`;
      void sendUserMessageAs(notice, 'followUp');
    }
    if (plan.wake && ctx && typeof ctx === 'object') {
      void coordinator.onAgentSettled({
        ctx,
        todos: todos.items,
        pi,
        config: effConfig.onlineContextCompact,
        cancelReminder: todoUi.cancelReminder,
        onBeforeCompact: createCompactionBatchPackHook({
          getObsConfig: () => effConfig.observationPack,
          getManifest: () => roles.state.manifest,
          getSessionId: () => sessionId,
          pickMiddleExcerpt,
        }),
      });
    }
    if (lastStopReason !== ABORT_STOP_REASON) void notices.flush('followUp');
    void pushSettleReply();
  });

  /* ── D101 ObservationPack (obs_recall tool & context projector) ── */
  registerObservationPack({
    pi,
    getConfig: () => effConfig,
    getRuntimeManifest: () => roles.state.manifest,
    pickMiddleExcerpt,
    getRemainingHorizon: () => {
      const usage = (latestCtx as { getContextUsage?: () => { contextWindow?: number } })?.getContextUsage?.();
      return coordinator.getRemainingHorizon(3, usage?.contextWindow ?? null);
    },
  });

  installConfigCommand({ pi });
  installDashboardCommand({
    pi,
    client,
    env,
    getTodoItems: () => todos.items,
    getHeldLocks: () => locksHandle.getHeldLocks(),
  });

  /* ── ask_user_question (v1.3 M8 human gate; master and subagents) ── */
  pi.registerTool({
    name: ASK_TOOL_NAME,
    label: 'Ask User',
    description: ASK_TOOL_DESCRIPTION,
    promptGuidelines: ASK_PROMPT_GUIDELINES,
    parameters: ASK_PARAMETERS,
    async execute(_tc, params, signal, _upd, ctx) {
      const prepared = prepareAsk(params);
      if (!prepared.ok) return prepared.result;
      const ui = ctx && typeof ctx === 'object' && 'ui' in ctx ? ctx.ui : undefined;
      if (!hasAskUi(ui)) return noUiResult();
      gates.publish(true, gateLabel(prepared.spec));
      // The gate stays reported for the whole wait: gates.report drops
      // working/idle while blocked, and pi's ui_prompt events keep the depth honest.
      try {
        return await runAsk(prepared.spec, ui, signal instanceof AbortSignal ? signal : undefined);
      } finally {
        gates.publish(false, null);
      }
    },
  });

  pi.on('session_shutdown', async () => {
    coordinator.compactionInFlight = false;
    coordinator.intentionalAbort = false;
    sessionFocusPoller.current?.stop();
    sessionFocusPoller.current = null;
    if (pipeServerBox.current) {
      try { pipeServerBox.current.close(); } catch { /* Already closed. */ }
      pipeServerBox.current = null;
    }
    if (sessionRoot) {
      try {
        await pruneSessionObjects(sessionRoot);
      } catch {
      }
    }
    client.close();
  });

  /* ── master vs worker mount (dynamic: workers never load the cordis tree, C3) ── */
  if (mode.composeMaster) {
    const { mountMasterPlugins } = await import('./index-master.ts');
    await mountMasterPlugins({
      pi,
      client,
      env,
      todos,
      todoUi,
      mirrorTodos,
      extPath: fileURLToPath(import.meta.url),
      port: subagentPort,
      pipeServerBox,
      deliverNotice,
      noticePending: notices.noticePending,
      getSessionId: () => sessionId,
      getBlockedDepth: () => gates.depth(),
      reconcileOnSettlement,
      withReconcileNotes,
      claimSettleNotice,
      isCompactionInFlight: () => coordinator.compactionInFlight,
      isIntentionalAbort: () => coordinator.intentionalAbort,
      jev: { ask: (request, meta) => jevRuntime.ask(request, meta), getMinConfidence: () => effConfig.jev.minConfidence },
      appendRoutingLog,
    });
  } else {
    const { mountTodoOnly } = await import('./index-worker.ts');
    await mountTodoOnly({
      pi,
      todos,
      todoUi,
      mirrorTodos,
      getBlockedDepth: () => gates.depth(),
      ...(isSubagent
        ? {}
        : {
            stopReminder: {
              getBlockedDepth: () => gates.depth(),
              getRunningSubs: () => subagentPort.current?.listRunningSubs().length ?? 0,
              isCompactionInFlight: () => coordinator.compactionInFlight,
              isIntentionalAbort: () => coordinator.intentionalAbort,
            },
          }),
    });
  }
}
