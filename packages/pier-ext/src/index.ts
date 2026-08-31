/**
 * pi-herdr extension entry point (v1.1: closed-loop todos + interactive subagents,
 * DESIGN.md §12 option C).
 *
 * Installation: `pi package` (package.json's pi.extensions) or ~/.pi/agent/extensions/.
 *
 * Capabilities:
 *  - `todo_write`: replace the complete todo list; the current pi session JSONL is authoritative,
 *    and branches automatically roll back in DSH-aligned semantics.
 *  - `subagent`: foreground/background delegation plus resume/list/send/interrupt actions.
 *    Each child pane is an interactive pi TUI with an independent session/context that humans
 *    can enter directly; the controller uses herdr for state-gated injection (idle only),
 *    waiting (agent.wait), and JSONL result reads.
 *  - `/todos`, TUI widget, and herdr title projection with graceful degradation without herdr.
 *
 * pi 0.84.2 contract (validated):
 *  - onUpdate must have AgentToolResult shape; a string causes the TUI to crash and exit pi;
 *  - tool-result details persist in session JSONL, and getBranch() replay implements branch rollback.
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { pipeNameFor, pipeRequest, startPipeServer } from './pipe-channel.ts';
import {
  TODO_EDIT_CUSTOM_TYPE,
  currentActivity,
} from './todo-core.ts';

/** Tier 2: record the synthesized manifest that governed a worker session (D38-compatible and branch-replayable). */
const ROLE_MANIFEST_CUSTOM_TYPE = 'pi-herdr.role-manifest';

import { createHerdrClient } from './herdr-client.ts';
// The subagent family moved to core/subagent.ts (loader entry, D78/D81); its history-store,
// session-tail, and gc-core imports moved with it, leaving index.ts only the common readers.
import { lastAssistantText, readSessionFile } from './session-tail.ts';
import { fileURLToPath } from 'node:url';
import { TodosService } from './todos-service.ts';
import { reconcileTodos } from './reconcile-core.ts';
import {
  estimateEta,
  formatProgressSuffix,
  planToolBadge,
  progressOf,
} from './progress-core.ts';
import { WRITE_LOCK_ENV } from './lock-core.ts';
import { ABORT_STOP_REASON, planSettleWake } from './settle-wake-core.ts';
import { composeForRole } from './manifest-compose.ts';
import { parseRuntimeManifest, planActiveTools, planToolGate, type RuntimeRoleManifest } from './tool-gate.ts';

import { formatPaneTitle } from './pane-title.ts';
import { registerSlimFrame, updateSlimFrame } from './slim-frame.ts';
import { planIndexMode } from './index-runtime.ts';
import { emptySubagentPortBox } from './subagent-port.ts';
import { createNoticeBuffer } from './index-notices.ts';
import { handlePipeRequest } from './index-pipe.ts';
import { installWriteLocks } from './index-locks.ts';

/**
 * WS-D7: apply the master-pane manifest to itself through the same mandatory chain as subagents
 * (gate, visible layer, badge, and session record); the baseline includes our core plus inspect/execute tools.
 * Match only a herdr pane (HERDR_ENV=1) that is not a subagent and has no explicitly supplied manifest.
 * Standalone pi sessions without herdr remain full-featured for backward compatibility.
 * A malformed master.json fails open to no-role state, matching malformed env semantics.
 */
function composeMasterRuntime(): RuntimeRoleManifest | null {
  try {
    // v1.1: read the built-in name directly so a workspace master.json decoy cannot affect self-application; the reserved-name check remains for loud spawn errors.
    const { role, manifest } = composeForRole('master', [], { loadRoleOpts: { builtinDirect: true } });
    return {
      role: role.role,
      version: role.version,
      tools: manifest.tools,
      permissions: manifest.permissions,
      unknownTools: manifest.unknownTools,
      services: role.services ?? {},
    };
  } catch (err) {
    console.error(`[pi-herdr] master manifest invalid (fail-open): ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
// C3: cordis belongs only in the master process; subagent-scope includes @deepseek-ai/cordis.
// Dynamically import it on the master branch so worker processes never load the module.
// Subagent constants/helpers moved with the family to core/subagent.ts.

export default async function (pi: ExtensionAPI) {
  const mode = planIndexMode();
  const isSubagent = mode.isSubagent;
  const runtimeManifest =
    parseRuntimeManifest(process.env.PI_HERDR_ROLE_MANIFEST) ??
    (mode.composeMaster ? composeMasterRuntime() : null);
  const todos = new TodosService(TodosService.configFromRuntime(runtimeManifest, isSubagent));
  const { client, env } = createHerdrClient();

  let sessionId: string = process.env.PI_SESSION_FILE ?? process.env.PI_SESSION_ID ?? '';
  /** M16: completion timestamps used as rate-estimation input, appended with todo.completed events. */
  const completedStamps: number[] = [];

  /* ── State reconstruction (branch correctness comes from the last todo_write snapshot on the branch) ── */

  function rebuildFromBranch(ctx: unknown): void {
    try {
      const entries = (ctx as { sessionManager?: { getBranch?: () => readonly unknown[] } })
        ?.sessionManager?.getBranch?.() ?? [];
      todos.rebuild(entries);
    } catch {
      // A reconstruction failure must not disrupt the main flow; the next todo_write re-anchors state.
    }
  }

  /* ── herdr reporting (zero cost for Noop; silent failures never affect pi's main flow) ── */

  /** Tier 2: worker role badge parsed from the env manifest and kept visible while idle. */
  let roleBadge: string | null = null;
  /** Human-gate depth; ask_user_question and external herdr:blocked events share it. */
  let blockedDepth = 0;

  function reportAgent(state: 'working' | 'idle' | 'blocked', activity: string | null): void {
    if (!client.available) return;
    // While a human gate is open, never let tool-badge / turn_start / settle overwrite blocked.
    // Needed when herdr:pi is absent (pi-herdr is the authority); no-op under full-lifecycle herdr:pi.
    if (blockedDepth > 0 && state !== 'blocked') return;
    const message = activity ?? (state === 'idle' ? roleBadge : null);
    client.reportAgent(state, message).catch(() => {});
  }

  function reportSession(path: string): void {
    if (!client.available) return;
    client.reportAgentSession(path).catch(() => {});
  }

  /** Session identity: sessionManager is authoritative (env may be unset in print/RPC mode), with env as fallback. */
  function resolveSessionId(ctx: unknown): string {
    try {
      const sm = (ctx as {
        sessionManager?: {
          getSessionFile?: () => string | undefined;
          getSessionId?: () => string;
        };
      }).sessionManager;
      return (
        sm?.getSessionFile?.() ??
        sm?.getSessionId?.() ??
        process.env.PI_SESSION_FILE ??
        process.env.PI_SESSION_ID ??
        ''
      );
    } catch {
      return process.env.PI_SESSION_FILE ?? '';
    }
  }

  function mirrorTodos(): void {
    if (!client.available) return;
    const label = sessionId || (env ? `pane:${env.paneId}` : '');
    // M16: progress badge (conservative N/M plus confidence ETA; fall back to a plain count when estimates are unreliable).
    const p = progressOf(todos.items);
    const eta = estimateEta({ completedAt: completedStamps, total: p.total, now: Date.now() });
    const suffix = formatProgressSuffix({ completed: p.completed, total: p.total, eta });
    // Unfreeze by carrying lastWriteAt into the title-side archived check (pane-title).
    const title = formatPaneTitle(todos.items, null, {
      progressSuffix: suffix,
      lastWriteAt: todos.lastWriteAt,
    });
    // D97: overlay content shares the todo snapshot; thinking tokens cannot reach it.
    updateSlimFrame({ title, items: todos.items, lastWriteAt: todos.lastWriteAt });
    client.reportMetadata({
      session: label,
      items: todos.items,
      progressSuffix: suffix,
      lastWriteAt: todos.lastWriteAt,
    }).catch(() => {});
  }

  /* ── M17: automatic settlement reconciliation (pure planner + D38 authority; idempotent and safe to run through both paths) ── */

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
          /* Best effort persistence; in-memory state still advances. */
        }
        todos.applyEdits(plan.edits);
        mirrorTodos();
      }
      return plan.noteLines;
    } catch {
      return [];
    }
  }

  /** M17: append reconciliation note lines to settlement notices; an empty list returns the original text. */
  function withReconcileNotes(base: string, notes: readonly string[]): string {
    return notes.length ? `${base}\n${notes.join('\n')}` : base;
  }

  /* ── M16: progress and tool badges (title suffix + report_agent.message; no new protocol) ── */

  todos.on('todo.completed', (e: { count: number; at: number }) => {
    for (let i = 0; i < e.count; i++) completedStamps.push(e.at);
    mirrorTodos();
  });

  // Tool badge: parallel mode starts in source order and ends in completion order (pi docs contract); track in-flight calls in a Map.
  const runningTools = new Map<string, string>(); // toolCallId → toolName
  let lastToolBadge: string | null = null;
  function reportToolBadge(): void {
    const badge = planToolBadge([...new Set(runningTools.values())]);
    if (badge === lastToolBadge) return; // Idempotent: report only changes (M13 rendering discipline).
    lastToolBadge = badge;
    if (badge) reportAgent('working', badge);
    else reportAgent(agentActive ? 'working' : 'idle', agentActive ? currentActivity(todos.items) : null);
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

  installWriteLocks(pi, {
    client,
    env,
    hard: process.env[WRITE_LOCK_ENV] === '1',
  });

  /* ── todo family slot (core/todo.ts fills the plugin hook; widget rendering moved with the family) ── */
  const todoUi: { renderWidget: (ctx: unknown) => void } = {
    renderWidget: () => { /* No-op before plugin mounting; filled after mounting. */ },
  };

  /* ── Lifecycle ────────────────────────────────────────────────────── */

  pi.on('session_start', async (event, ctx) => {
    sessionId = resolveSessionId(ctx);
    rebuildFromBranch(ctx);
    // v1.3 M9 fix (observed): on resume pi restores widget state from the session;
    // calling setWidget again breaks the TUI '/' command-panel route ('/' would be sent to the model as message text).
    const reason = (event as { reason?: string } | undefined)?.reason;
    if (reason !== 'resume') todoUi.renderWidget(ctx);
    // D97: narrow-frame overlay is meaningful only inside herdr; covering an interactive narrow terminal is unsafe,
    // and the heatmap amplification provides the exit path. Re-register on resume because session switching resets the overlay.
    if (env) registerSlimFrame(ctx);
    mirrorTodos();
    reportSession(sessionId);
    // D93: sidebar identity is the role name (display_agent takes precedence over detected agent, actions.rs:563 in 0.8.2).
    // master → 'master'; worker → manifest.role (prettify worker-default as worker).
    // A bare pi without a manifest does not report, so ordinary pi sessions remain undisturbed.
    if (runtimeManifest) {
      const roleDisplay = runtimeManifest.role === 'worker-default' ? 'worker' : runtimeManifest.role;
      void client.reportDisplayAgent(roleDisplay);
    }
    // Tier 2: worker role manifest parsed at process start supplies the badge and authoritative session record.
    // The custom entry mirrors D38 todo-edit and anchors execution-time replay.
    if (runtimeManifest) {
      roleBadge = `role ${runtimeManifest.role} v${runtimeManifest.version ?? '?'} (${runtimeManifest.tools.length} tools)`;
      try {
        (pi as { appendEntry?: (customType: string, data: unknown) => void }).appendEntry?.(
          ROLE_MANIFEST_CUSTOM_TYPE,
          { version: 1, role: runtimeManifest.role, manifestVersion: runtimeManifest.version, tools: runtimeManifest.tools, permissions: runtimeManifest.permissions, unknownTools: runtimeManifest.unknownTools ?? 'deny', ts: Date.now() },
        );
      } catch {
        /* Best effort recording. */
      }
      // D77 visible layer: remove tools outside the manifest from the model's view after all plugins load at session_start.
      // Intersection semantics prevent clearing everything; master without a manifest stays full. Missing APIs are skipped for old pi compatibility.
      const piTools = pi as { getActiveTools?: () => string[]; setActiveTools?: (names: string[]) => void };
      if (typeof piTools.getActiveTools === 'function' && typeof piTools.setActiveTools === 'function') {
        try {
          const active = piTools.getActiveTools();
          const vis = planActiveTools(runtimeManifest.tools, active, {
            unknownTools: runtimeManifest.unknownTools,
            permissions: runtimeManifest.permissions,
          });
          if (vis?.changed) {
            piTools.setActiveTools?.(vis.next);
            console.error(`[pi-herdr] D77 visible-layer: role ${runtimeManifest.role} tools ${active.length} → ${vis.next.length}`);
          }
        } catch {
          /* Best effort visible layer; the mandatory layer remains active. */
        }
      }
    }
    reportAgent('idle', null);
  });

  /* ── Tier 2 Weeks 4–5: worker execution enforcement (the manifest's final gate) ──
   * deny / outside manifest → block (reason is given to the model); ask → v1 allows with stderr logging
   * (V56 acceptance anchor). Master and label-only workers without a manifest remain open.
   * Rate limiting was removed (WS-D6): we own the permission boundary; plugin integrators own resource quotas. */
  pi.on('tool_call', async (event: { toolName?: string }) => {
    if (!runtimeManifest) return;
    const tool = typeof event?.toolName === 'string' ? event.toolName : '';
    const gate = planToolGate(tool, runtimeManifest);
    if (gate.kind === 'deny') {
      return { block: true, reason: gate.reason };
    }
    if (gate.kind === 'ask') {
      console.error(`${gate.notice} (v1 soft-approval: allowed, hard gate lands in v2)`);
      // Durable trace (V56 anchor): TUI redraw erases stderr, so the session custom entry is authoritative.
      try {
        (pi as { appendEntry?: (customType: string, data: unknown) => void }).appendEntry?.(
          'pi-herdr.approval-needed',
          { role: runtimeManifest.role, tool, ts: Date.now() },
        );
      } catch {
        /* Best effort. */
      }
    }
  });


  // Session-tree navigation (/tree, /fork): reconstruction preserves branch correctness.
  pi.on('session_tree', async (_event, ctx) => {
    sessionId = resolveSessionId(ctx);
    rebuildFromBranch(ctx);
    todoUi.renderWidget(ctx);
    mirrorTodos();
  });

  let agentActive = false;
  const subagentPort = emptySubagentPortBox();
  // D96 state, anchoring settle-wake-core deduplication and cooldown.
  let d96NoticeKey: string | null = null;
  let d96NoticeAt = 0;
  // Prevent wake-up storms by tracking the last assistant turn's stopReason;
  // 'aborted' means the user explicitly pressed ESC, so settlement must inject no wake-up message.
  let lastStopReason: string | null = null;
  pi.on('turn_start', async () => {
    agentActive = true;
    reportAgent('working', currentActivity(todos.items));
  });
  pi.on('turn_end', async (event: unknown) => {
    if (event === null || typeof event !== 'object' || !('message' in event)) return;
    const msg = (event as { message: unknown }).message; // 'message' in has been guarded.
    if (msg === null || typeof msg !== 'object') return;
    const { role, stopReason } = msg as { role?: unknown; stopReason?: unknown };
    if (role === 'assistant' && typeof stopReason === 'string') {
      lastStopReason = stopReason;
    }
  });

  pi.on('agent_settled', async () => {
    agentActive = false;
    reportAgent('idle', null);
    const plan = planSettleWake({
      lastStopReason,
      running: subagentPort.current?.listRunningSubs() ?? [],
      lastNoticeKey: d96NoticeKey,
      lastNoticeAt: d96NoticeAt,
      now: Date.now(),
    });
    d96NoticeKey = plan.noticeKey;
    d96NoticeAt = plan.noticeAt;
    if (!plan.wake) {
      // Stay silent after a user abort while retaining the settlement buffer (do not clear pendingSettleNotices);
      // deliver it on the next natural run's turn_end steer or natural settlement.
      return;
    }
    // D96: master settled while background subagents still run → remind (worker port is unbound).
    if (plan.notice && !isSubagent) {
      const running = subagentPort.current?.listRunningSubs() ?? [];
      const brief = running.map((s) => `${s.paneId} (${s.description})`).join('、');
      const notice = `注意：仍有 ${running.length} 个后台 subagent 在运行：${brief}。若你的任务依赖它们，请等待其结算（subagent list 查看状态）；若不等待，请说明放弃原因。`;
      void sendUserMessageIn(notice);
    }
  });

  // Official herdr:pi is full-lifecycle authority when installed: it reports blocked
  // only on the herdr:blocked event (pi core never emits it). Custom source=pi-herdr
  // pane.report_agent is ignored while that authority is live
  // (screen_detection_skip_reason=full_lifecycle_hook_authority). Emit the event so
  // herdr:pi publishes blocked; keep report_agent as fallback when it is absent.
  function enterBlocked(label: string | null): void {
    blockedDepth += 1;
    reportAgent('blocked', label);
    // D95: human-gate marker lets the workbench heatmap distinguish ask from block.
    if (label) void client.reportAskFlag(label).catch(() => {});
  }
  function exitBlocked(): void {
    blockedDepth = Math.max(0, blockedDepth - 1);
    if (blockedDepth === 0) {
      reportAgent(agentActive ? 'working' : 'idle', agentActive ? currentActivity(todos.items) : null);
      // D95: gate released → clear marker.
      void client.reportAskFlag(null).catch(() => {});
    }
  }

  // emit() is synchronous; this flag stops our own listener from double-counting depth.
  let publishingHerdrBlocked = false;
  function publishHerdrBlocked(active: boolean, label: string | null): void {
    publishingHerdrBlocked = true;
    try {
      if (active) enterBlocked(label);
      else exitBlocked();
      pi.events.emit(
        'herdr:blocked',
        active ? { active: true, ...(label ? { label } : {}) } : { active: false },
      );
    } finally {
      publishingHerdrBlocked = false;
    }
  }
  pi.events.on('herdr:blocked', (data) => {
    if (publishingHerdrBlocked) return;
    if (!data || typeof data !== 'object') {
      exitBlocked();
      return;
    }
    if (!('active' in data) || data.active !== true) {
      exitBlocked();
      return;
    }
    enterBlocked('label' in data && typeof data.label === 'string' ? data.label : null);
  });

  /* ── Tool: ask_user_question (v1.3 M8 human gate, available to master and subagents) ── */

  pi.registerTool({
    name: 'ask_user_question',
    label: 'Ask User',
    description: [
      'Ask the human a question and wait for their typed answer.',
      'Use this when you genuinely need a human decision (approval, direction, trade-off choice) — not for information you can find yourself.',
      'While waiting, the pane shows as blocked in herdr (the human sees it and can step in).',
      'The answer comes back as the tool result; then continue your work.',
    ].join(' '),
    parameters: Type.Object({
      question: Type.String({ description: 'The question to ask the human' }),
    }),
    async execute(_tc, params, _sig, _upd, ctx) {
      const question = String(params?.question ?? '').trim();
      if (!question) {
        return { content: [{ type: 'text', text: 'Error: `question` must be a non-empty string' }], details: {} };
      }
      const ui = (ctx as {
        ui?: { input?: (title: string, placeholder?: string) => Promise<string | undefined> };
      }).ui;
      publishHerdrBlocked(true, question);
      // Fallback when herdr:pi is absent: a one-shot pi-herdr blocked report can lose
      // to later working reports; refresh while the gate is open. Do not re-emit
      // herdr:blocked here — official blockedCount is edge-triggered.
      const hb = setInterval(() => { reportAgent('blocked', question); }, 5000);
      try {
        const answer = await ui?.input?.(question, 'your answer');
        return {
          content: [{ type: 'text', text: `The human answered: ${answer ?? '(no answer given)'}` }],
          details: { question, answer: answer ?? null },
        };
      } finally {
        clearInterval(hb);
        publishHerdrBlocked(false, null);
      }
    },
  });

  pi.on('session_shutdown', async () => {
    client.close();
  });

  /* ── M12: bidirectional message channel (D49/D50/D48; every pane listens on its own name, with no controller/child assumption) ── */

  const settleNoticeLatch = new Set<string>();
  /** Deduplicate settlement notices: choose push fast path or pollLoop fallback; one notice per paneId+request ID per round. */
  function claimSettleNotice(key: string): boolean {
    if (settleNoticeLatch.has(key)) return false;
    settleNoticeLatch.add(key);
    return true;
  }
  const pipeServerBox: { current: ReturnType<typeof startPipeServer> | null } = { current: null };
  let pendingMachineRequest: { id: string; from: string | null; push: boolean; sinceTs: number } | null = null;
  let latestCtx: { abort?: () => void } | null = null;

  // triggerTurn:true — idle followUp must start a new turn or settlement is lost.
  const sendUserMessageIn = (content: string): Promise<void> =>
    (pi as { sendUserMessage?: (content: string, opts?: { deliverAs?: string; triggerTurn?: boolean }) => Promise<void> })
      .sendUserMessage?.(content, { deliverAs: 'followUp', triggerTurn: true }) ?? Promise.resolve();
  const sendUserMessageAs = (content: string, mode: 'steer' | 'followUp'): Promise<void> =>
    (pi as { sendUserMessage?: (content: string, opts?: { deliverAs?: string; triggerTurn?: boolean }) => Promise<void> })
      .sendUserMessage?.(content, { deliverAs: mode, triggerTurn: true }) ?? Promise.resolve();

  const notices = createNoticeBuffer({
    isBusy: () => agentActive || lastStopReason === ABORT_STOP_REASON,
    send: sendUserMessageAs,
  });
  const deliverNotice = notices.deliverNotice;
  pi.on('turn_end', () => {
    void notices.flush('steer');
  });
  pi.on('agent_settled', () => {
    if (lastStopReason === ABORT_STOP_REASON) return;
    void notices.flush('followUp');
  });

  pi.on('session_start', async (_event, ctx) => {
    latestCtx = ctx as { abort?: () => void } | null;
    const cwd = (ctx as { cwd?: string }).cwd ?? process.cwd();
    const paneId = env?.paneId ?? '';
    if (!paneId) return;
    const name = pipeNameFor(cwd, paneId);
    if (pipeServerBox.current) {
      try { pipeServerBox.current.close(); } catch { /* Previous instance. */ }
      pipeServerBox.current = null;
    }
    try {
      pipeServerBox.current = startPipeServer(name, async (req) => handlePipeRequest(req, {
        paneId,
        port: subagentPort,
        claimSettleNotice,
        deliverNotice,
        sendUserMessageIn,
        sendUserMessageAs,
        abort: () => { latestCtx?.abort?.(); },
        setPendingMachineRequest: (next) => { pendingMachineRequest = next; },
      }));
    } catch {
      /* Pipe name collision (rare): this session has no channel; callers report an error after ping times out. */
    }
  });
  pi.on('session_shutdown', () => {
    if (pipeServerBox.current) {
      try { pipeServerBox.current.close(); } catch { /* Already closed. */ }
      pipeServerBox.current = null;
    }
  });

  // D50: when this pane settles, push a summary and session path to any machine request awaiting a reply.
  pi.on('agent_settled', async () => {
    const req = pendingMachineRequest;
    if (!req || !req.push || !req.from) return;
    pendingMachineRequest = null;
    try {
      let text: string | null = null;
      if (sessionId && /\.jsonl$/.test(sessionId)) {
        const entries = readSessionFile(sessionId);
        if (entries) text = lastAssistantText(entries, { sinceTs: req.sinceTs })?.text ?? null;
      }
      await pipeRequest(req.from, {
        type: 'reply',
        id: req.id,
        paneId: env?.paneId ?? '',
        text,
        sessionFile: sessionId || null,
      }, 5000);
    } catch {
      /* Push failed silently; the requester's pollLoop is the fallback. */
    }
  });

  /* subagent tools are master-only (depth 1). C3: worker never loads bootstrap. */
  if (!isSubagent) {
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
      getBlockedDepth: () => blockedDepth,
      reconcileOnSettlement,
      withReconcileNotes,
      claimSettleNotice,
    });
  } else {
    const { mountWorkerTodo } = await import('./index-worker.ts');
    await mountWorkerTodo({ pi, todos, todoUi, mirrorTodos });
  }
}
