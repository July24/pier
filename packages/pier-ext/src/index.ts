/**
 * pi-herdr extension entry point (v1.1: closed-loop todos + interactive subagents,
 * DESIGN.md §12 option C).
 *
 * Installation: `pi package` (package.json's pi.extensions) or ~/.pi/agent/extensions/.
 *
 * Capabilities:
 *  - `todo_write`: replace the complete todo list; the current pi session JSONL is authoritative,
 *    and branches automatically roll back in DSH-aligned semantics.
 *  - `subagent` / `terminal`: herdr-master only. Bare pi does not register them.
 *  - `/todos`, TUI widget, and herdr title projection with graceful degradation without herdr.
 *
 * pi 0.84.2 contract (validated):
 *  - onUpdate must have AgentToolResult shape; a string causes the TUI to crash and exit pi;
 *  - tool-result details persist in session JSONL, and getBranch() replay implements branch rollback.
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
import {
  TODO_EDIT_CUSTOM_TYPE,
  currentActivity,
} from './todo-core.ts';

import { APPROVAL_NEEDED_CUSTOM_TYPE, ROLE_MANIFEST_CUSTOM_TYPE, installRenderers } from './renderers.ts';
import { createHerdrClient } from './herdr-client.ts';
// The subagent family moved to plugins/subagent.ts (loader entry, D78/D81); its history-store,
// session-tail, and gc-core imports moved with it, leaving index.ts only the common readers.
import { bareSessionId, lastAssistantText, readSessionFile, sessionFileById } from './session-tail.ts';
import { join } from 'node:path';
import { platformPaths } from './platform-paths.ts';
import { fileURLToPath } from 'node:url';
import { TodosService } from './todos-service.ts';
import { reconcileTodos } from './reconcile-core.ts';
import type { TodoUiSlot } from './plugins/todo.ts';
import {
  estimateEta,
  formatProgressSuffix,
  planToolBadge,
  progressOf,
} from './progress-core.ts';
import { WRITE_LOCK_ENV } from './lock-core.ts';
import { ABORT_STOP_REASON, planSettleWake } from './settle-wake-core.ts';
import { composeForRole } from './manifest-compose.ts';
import type { ComposedForRole } from './manifest-compose.ts';
import { parseRuntimeManifest, planActiveTools, planToolGate, type RuntimeRoleManifest } from './tool-gate.ts';
import {
  initialRoleState,
  latestRoleManifestRecord,
  manifestFromRecord,
  planRoleSwitch,
  planSwitchActiveTools,
  roleRecordDiffers,
} from './role-state.ts';
import { readdirSync, readFileSync } from 'node:fs';
import { RESERVED_ROLE_NAMES, roleLayers } from './role-loader.ts';

import { formatPaneTitle } from './pane-title.ts';
import { registerSlimFrame, updateSlimFrame } from './slim-frame.ts';
import { planIndexMode } from './index-runtime.ts';
import { emptySubagentPortBox } from './subagent-core.ts';
import { createNoticeBuffer } from './index-notices.ts';
import { handlePipeRequest } from './index-pipe.ts';
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
import {
  appendEfficiencyLog,
  efficiencyLogPath,
  pruneSessionObjects,
  resolveSessionRoot,
} from './efficiency-store.ts';
import {
  planDenyHitRow,
  scanRoleAxisUsage,
  type RoutingTelemetryRecord,
  type RoutingTelemetryRow,
} from './routing-telemetry.ts';
import {
  loadEfficiencyConfigFromDisk,
  resolveEfficiencyConfig,
  type EfficiencyConfig,
} from './efficiency-config-core.ts';
import {
  resolveDefaultFocusPollMs,
  parseFocusSample,
  spawnReflow,
  startFocusPoller,
  type FocusPoller,
} from './focus-poller.ts';

/**
 * D-4: focus sampling cadence. `PIER_FOCUS_POLL_MS=0` disables the poller (heat layout then only
 * reacts to herdr events). Invalid values fall back to the version default: 1500ms on Herdr <0.9.1,
 * 0 (event-first) on 0.9.1+ where native pane.focused is authoritative.
 */
function focusPollIntervalMs(env: NodeJS.ProcessEnv = process.env, herdrVersion?: string | null): number {
  const defaultMs = resolveDefaultFocusPollMs(herdrVersion);
  const raw = env.PIER_FOCUS_POLL_MS;
  if (raw === undefined || raw.trim() === '') return defaultMs;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms >= 0 ? ms : defaultMs;
}

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
      ...(role.guidelines?.length ? { guidelines: role.guidelines } : {}),
    };
  } catch (err) {
    console.error(`[pi-herdr] master manifest invalid (fail-open): ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
// C3: cordis belongs only in the master process; subagent-scope includes @deepseek-ai/cordis.
// Dynamically import it on the master branch so worker processes never load the module.
// Subagent constants/helpers moved with the family to plugins/subagent.ts.

export default async function (pi: ExtensionAPI) {
  const mode = planIndexMode();
  const isSubagent = mode.isSubagent;
  const initialManifest =
    parseRuntimeManifest(process.env.PI_HERDR_ROLE_MANIFEST) ??
    (mode.composeMaster ? composeMasterRuntime() : null);
  // P0: role-resolution base dir carried by the master at spawn (spawn composes against ITS
  // checkout; an isolate/worktree worker's own cwd would resolve a different or absent
  // .pi-herdr/roles/). Falls back to this pane's cwd for masters and bare pi.
  const roleBase = process.env.PI_HERDR_ROLE_BASE || process.cwd();
  // P0 (RFC docs/rfc-pi-0.86-dynamic-tools.md §4.2): mutable role state. The manifest parsed at
  // process start is only the INITIAL value — mid-session switches replace it whole, and resume
  // replays the last `pi-herdr.role-manifest` entry (session_start). All read sites go through
  // roleState.manifest so the visible layer and the mandatory gate never drift apart.
  const roleState = initialRoleState(initialManifest);
  const todos = new TodosService(TodosService.configFromRuntime(initialManifest, isSubagent));
  const { client, env } = createHerdrClient();
  let effConfig: EfficiencyConfig = resolveEfficiencyConfig();
  const coordinator = new CompactCoordinator();
  let sessionRoot: string | null = null;

  /* ── Jev decision layer (RFC docs/rfc-jev-integration.md): direct HTTP, total-budget abort,
   * fail-open at every site. Disabled or keyless => behavior is byte-identical to before. ── */
  const jevRuntime = createJevRuntime(() => effConfig.jev, {
    getSessionRoot: () => sessionRoot,
  });
  const jevMinConfidence = (): number => effConfig.jev.minConfidence;
  /** P0-3: candidate windows are generated in code; jev only picks (rerank pattern). */
  const pickMiddleExcerpt: PickMiddleExcerpt = async (text, excerptBudgetBytes) => {
    if (!jevRuntime.available) return null;
    const halfBudget = Math.floor(excerptBudgetBytes / 2);
    const windows = buildExcerptWindows(text, halfBudget);
    if (windows.length === 0) return null; // degenerate budget only — the always-on mid window keeps candidates non-empty
    const headExcerpt = completeLineExcerpt(text, halfBudget, false);
    const tailExcerpt = completeLineExcerpt(text, excerptBudgetBytes - halfBudget, true);
    // Since the 2026-09-19 flip every packed output reaches here; credential-
    // shaped text in the request state never leaves the process (§8 privacy
    // boundary) — keep the legacy halves instead.
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
    const picked = evaluateExcerptPick(result.answers, jevMinConfidence());
    const window = picked === null ? undefined : windows.find((w) => w.id === picked);
    return window ? { text: window.text, label: window.label } : null;
  };
  // Transcript polish for pier's own custom entries and reminder messages; display-only and
  // best-effort (older pi builds without the renderer API simply keep the raw rows).
  const rendererTypes = installRenderers(pi);
  if (process.env.PI_HERDR_TRACE) {
    console.error(`[pi-herdr] transcript renderers: ${rendererTypes.length ? rendererTypes.join(', ') : 'none'}`);
  }

  let sessionId: string = process.env.PI_SESSION_FILE ?? process.env.PI_SESSION_ID ?? '';
  /** M16: completion timestamps used as rate-estimation input, appended with todo.completed events. */
  const completedStamps: number[] = [];

  /* ── State reconstruction (branch correctness comes from the last todo_write snapshot on the branch) ── */

  function rebuildFromBranch(ctx: unknown): void {
    try {
      const entries = (ctx as { sessionManager?: { getBranch?: () => readonly unknown[] } })
        ?.sessionManager?.getBranch?.() ?? [];
      todos.rebuild(entries);
      coordinator.rebuildFromBranch(entries);
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

  /** Session identity: sessionManager is authoritative (env may be unset in print/RPC mode), with env as fallback. */
  function resolveSessionId(ctx: unknown): string {
    try {
      const sm = (ctx as {
        sessionManager?: {
          getSessionFile?: () => string | undefined;
          getSessionId?: () => string;
        };
      }).sessionManager;
      return bareSessionId(
        sm?.getSessionFile?.()
          ?? sm?.getSessionId?.()
          ?? process.env.PI_SESSION_FILE
          ?? process.env.PI_SESSION_ID
          ?? '',
      );
    } catch {
      return bareSessionId(process.env.PI_SESSION_FILE ?? '');
    }
  }

  /**
   * Phase 0 routing telemetry (RFC docs/rfc-jev-role-routing.md §8): best-effort append to
   * efficiency-logs/routing.jsonl. Observation only — a failure here must never touch the
   * gate, the spawn path, or the session. sessionId is stamped centrally so every threaded
   * call site stays session-id-free.
   */
  function appendRoutingLog(row: RoutingTelemetryRecord): void {
    const root = sessionRoot;
    if (!root) return;
    const stamped: RoutingTelemetryRow = { ...row, sessionId: sessionId || 'unknown' };
    void appendEfficiencyLog(efficiencyLogPath(root, 'routing'), stamped).catch(() => {});
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
        todos.applyEdits(plan.edits, { source: 'reconcile' });
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

  todos.on('todo.completed', (e: { count: number; at: number; source?: import('./todos-service.ts').TodoCompletionSource }) => {
    for (let i = 0; i < e.count; i++) completedStamps.push(e.at);
    coordinator.recordBoundaryCompleted(e.count, e.source);
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

  /* ── D102: Evidence-Preserving Reducer (runs before append-handlers like write-locks) ── */
  pi.on('tool_result', async (event, ctx) => {
    if (!effConfig.evidencePreservingReducer.enabled) return;
    if (!event || typeof event !== 'object') return;
    return handleReducerToolResult(event as unknown as ToolResultEventLike, ctx, effConfig.evidencePreservingReducer, {
      epoch: coordinator.state.epoch,
      jev: { ask: jevRuntime.ask, getMinConfidence: jevMinConfidence },
    });
  });

  let locksHandle = { getHeldLocks: () => [] as readonly string[] };
  if (env) {
    locksHandle = installWriteLocks(pi, {
      client,
      env,
      hard: process.env[WRITE_LOCK_ENV] === '1',
    });
  }

  /* ── todo family slot (plugins/todo.ts fills the plugin hook; widget rendering moved with the family) ── */
  const todoUi: TodoUiSlot = {
    renderWidget: () => { /* No-op before plugin mounting; filled after mounting. */ },
  };

  /* ── Lifecycle ────────────────────────────────────────────────────── */

  /**
   * P0 same-origin sync (RFC §4.3): reconcile roleState against the CURRENT branch point and
   * re-anchor side effects. Runs on session_start (resume) AND session_tree (/tree, /fork) —
   * pi's tool deltas are transcript entries, so navigating to a point before a switch reverts
   * the loadout there; without the same replay here the gate/guidelines would keep the
   * post-switch manifest while the visible layer shows the pre-switch one.
   * Idempotent: replay only when the last role-manifest entry is a switch to a different role;
   * the anchor write happens only on change; the D77 prune is a no-op when already pruned.
   */
  function syncRoleFromBranch(ctx: unknown): void {
    if (!roleState.manifest) return;
    try {
      const branchEntries =
        (ctx as { sessionManager?: { getBranch?: () => readonly unknown[] } }).sessionManager?.getBranch?.() ?? [];
      const record = latestRoleManifestRecord(branchEntries);
      // Restore whenever the branch point's LAST record names a different role — switch records
      // AND plain anchors both carry the full manifest. The anchor case is the /tree path back to
      // a pre-switch point: pi has already reverted the loadout there, so roleState must follow
      // or the D77 prune below would intersect A∩B and silently drop the tools the switch added.
      // Name equality alone (tools drift tolerated) keeps the env value authoritative on plain
      // resume; role files may have changed on disk since the record, so replay is verbatim.
      if (record && record.role !== roleState.manifest.role) {
        roleState.manifest = manifestFromRecord(record);
        roleState.origin = record.origin === 'switch' ? 'switch' : 'env';
        roleState.switchedBy = record.switchedBy ?? null;
        roleState.switchedAt = record.ts ?? null;
        console.error(`[pi-herdr] role replay: ${record.role} (origin ${record.origin ?? 'env'}, switchedBy ${record.switchedBy ?? '?'})`);
      }
      // Change-only write: appending on every session_start would overwrite "last entry" with
      // the env value and break the replay above for resumed switched sessions.
      if (roleRecordDiffers(record, roleState)) {
        const m = roleState.manifest;
        pi.appendEntry(ROLE_MANIFEST_CUSTOM_TYPE, {
          version: 1,
          role: m.role,
          manifestVersion: m.version,
          tools: m.tools,
          permissions: m.permissions,
          unknownTools: m.unknownTools ?? 'deny',
          ...(m.guidelines?.length ? { guidelines: m.guidelines } : {}),
          ...(roleState.origin === 'switch'
            ? { origin: 'switch' as const, switchedBy: roleState.switchedBy ?? undefined }
            : {}),
          ts: Date.now(),
        });
      }
    } catch {
      /* Best effort recording; the mandatory layer does not depend on the session log. */
    }
    // D93: sidebar identity is the role name (display_agent takes precedence over detected agent).
    // master → 'master'; worker → manifest.role (prettify worker-default as worker).
    const roleDisplay = roleState.manifest.role === 'worker-default' ? 'worker' : roleState.manifest.role;
    void client.reportDisplayAgent(roleDisplay);
    // Tier 2: badge from the effective manifest (post-replay), kept visible while idle.
    roleBadge = `role ${roleState.manifest.role} v${roleState.manifest.version ?? '?'} (${roleState.manifest.tools.length} tools)`;
    // D77 visible layer: remove tools outside the manifest from the model's view after all plugins load.
    // Intersection semantics prevent clearing everything; master without a manifest stays full.
    // pi 0.86: setActiveTools is recorded in the transcript as a tool delta, so the pruned loadout
    // survives resume and branch navigation natively (RFC docs/rfc-pi-0.86-dynamic-tools.md §4.3).
    try {
      const active = pi.getActiveTools();
      const vis = planActiveTools(roleState.manifest.tools, active, {
        unknownTools: roleState.manifest.unknownTools,
        permissions: roleState.manifest.permissions,
      });
      if (vis?.changed) {
        pi.setActiveTools(vis.next);
        console.error(`[pi-herdr] D77 visible-layer: role ${roleState.manifest.role} tools ${active.length} → ${vis.next.length}`);
      }
    } catch {
      /* Best effort visible layer; the mandatory layer remains active. */
    }
  }

  pi.on('session_start', async (event, ctx) => {
    sessionId = resolveSessionId(ctx);
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
    // v1.3 M9 fix (observed): on resume pi restores widget state from the session;
    // calling setWidget again breaks the TUI '/' command-panel route ('/' would be sent to the model as message text).
    const reason = (event as { reason?: string } | undefined)?.reason;
    if (reason !== 'resume') todoUi.renderWidget(ctx);
    // D97: narrow-frame overlay is meaningful only inside herdr; covering an interactive narrow terminal is unsafe,
    // and the heatmap amplification provides the exit path. Re-register on resume because session switching resets the overlay.
    if (env) registerSlimFrame(ctx);
    // P2-5 (01a0bd3a): resume used to skip branch reconstruction entirely — the master
    // came back to an EMPTY todo list (and zeroed OCC debt state) after a kill+resume,
    // rebuilding 11 items from memory. Fold todos/compaction state from the branch like
    // session_tree does; a fresh session folds nothing and stays untouched.
    rebuildFromBranch(ctx);
    mirrorTodos();
    // D-2: the session path is NOT reported here. herdr's own pi integration publishes it
    // (agent.list/agent.pane show `session_source: "herdr:pi"` on every pi pane, incl. pier subagents),
    // so pier's pane.report_agent_session was a pure duplicate write of the same field by a second source.
    // D93: sidebar identity is the role name (display_agent takes precedence over detected agent, actions.rs:563 in 0.8.2).
    // master → 'master'; worker → manifest.role (prettify worker-default as worker).
    // A bare pi without a manifest does not report, so ordinary pi sessions remain undisturbed.
    syncRoleFromBranch(ctx);
    if (mode.composeMaster && sessionRoot) {
      try {
        const files: Array<{ name: string; text: string }> = [];
        for (const layer of roleLayers({ baseDir: roleBase }).slice(0, 2)) {
          // Each layer's readdir is individually guarded: the workspace layer is commonly
          // absent (no .pi-herdr/roles), and one missing directory must not skip the user
          // layer where the interesting custom roles live — same pattern as /pier-role listing.
          let names: string[];
          try {
            names = readdirSync(layer.dir);
          } catch {
            continue;
          }
          for (const f of names) {
            if (!f.endsWith('.json')) continue;
            try {
              files.push({ name: f, text: readFileSync(join(layer.dir, f), 'utf8') });
            } catch {
              /* Unreadable file counts neither as parsed nor invalid; the scan stays robust. */
            }
          }
        }
        appendRoutingLog(scanRoleAxisUsage({ now: Date.now(), files }));
      } catch {
        /* The scan is best-effort. */
      }
    }
    reportAgent('idle', null);
    // Self-healing: a gate does not survive a process restart, but the ask marker lives in herdr
    // with a 24h TTL, so a session killed while a dialog was open would otherwise keep the pane
    // looking blocked forever. Depth is 0 on session_start, so this cannot race a live gate.
    void client.reportAskFlag(null).catch(() => {});
  });

  /* ── Tier 2 Weeks 4–5: worker execution enforcement (the manifest's final gate) ──
   * deny / outside manifest → block (reason is given to the model); ask → v1 allows with stderr logging
   * (V56 acceptance anchor). Master and label-only workers without a manifest remain open.
   * Rate limiting was removed (WS-D6): we own the permission boundary; plugin integrators own resource quotas. */
  pi.on('tool_call', async (event: { toolName?: string }) => {
    const manifest = roleState.manifest;
    if (!manifest) return;
    const tool = typeof event?.toolName === 'string' ? event.toolName : '';
    const gate = planToolGate(tool, manifest);
    if (gate.kind === 'deny') {
      // terminate (pi 0.84.1+) stops a batch whose results are all terminating without another
      // model call, so a blocked worker tool no longer costs an extra round trip.
      appendRoutingLog(planDenyHitRow({ now: Date.now(), role: manifest.role, tool }));
      return { block: true, reason: gate.reason, terminate: true };
    }
    if (gate.kind === 'ask') {
      console.error(`${gate.notice} (v1 soft-approval: allowed, hard gate lands in v2)`);
      // Durable trace (V56 anchor): TUI redraw erases stderr, so the session custom entry is authoritative.
      try {
        pi.appendEntry(APPROVAL_NEEDED_CUSTOM_TYPE, { role: manifest.role, tool, ts: Date.now() });
      } catch {
        /* Best effort. */
      }
    }
  });

  /* ── P0: mid-session role switching (RFC docs/rfc-pi-0.86-dynamic-tools.md §4) ──
   * pi 0.86 records setActiveTools changes as transcript tool deltas (toolsRemoved/toolsAdded
   * before the next request), so a switch survives resume/branch. The gate reads
   * roleState.manifest, so mandatory and visible layers swap atomically. Callers: /pier-role
   * (human; widening asks confirm) and the pipe 'role' request (master; free). */
  async function applyRoleSwitch(
    roleName: string,
    switchedBy: string,
  ): Promise<{ ok: boolean; message: string }> {
    const current = roleState.manifest;
    if (!current) {
      return { ok: false, message: 'Error: role system not armed (no manifest; bare pi sessions cannot switch roles)' };
    }
    const name = roleName.trim();
    if (name === '') return { ok: false, message: 'Error: role name is required (see /pier-role with no argument)' };
    if (name === current.role) return { ok: true, message: `role is already ${name}` };
    let composed: ComposedForRole;
    try {
      // Resolve against the spawn-inherited base (the master's checkout), matching how the
      // initial manifest was composed — an isolate/worktree worker's own cwd is the wrong base.
      composed = composeForRole(name, [], { loadRoleOpts: { baseDir: roleBase } });
    } catch (err) {
      return { ok: false, message: `Error: role "${name}" unavailable: ${(err as Error).message}` };
    }
    const next: RuntimeRoleManifest = {
      role: composed.role.role,
      version: composed.role.version,
      tools: composed.manifest.tools,
      permissions: composed.manifest.permissions,
      unknownTools: composed.manifest.unknownTools,
      services: composed.role.services ?? {},
      ...(composed.role.guidelines?.length ? { guidelines: composed.role.guidelines } : {}),
    };
    const plan = planRoleSwitch(current.tools, next.tools);
    // Universe = ALL registered tools, not the current active set: a switch may re-admit tools
    // that an earlier session_start prune removed, which intersection semantics would lose.
    // Stance opts mirror planActiveTools so an allow-stance role keeps unlisted registered tools.
    const registered = pi.getAllTools().map((t) => t.name);
    const nextActive = planSwitchActiveTools(next.tools, registered, {
      unknownTools: next.unknownTools,
      permissions: next.permissions,
    });
    pi.setActiveTools(nextActive);
    // Re-derive construction-time consumers of the manifest: TodosService captured
    // services.todos.mode at startup, so a switch to a different mode must reach it or the old
    // serial/parallel behavior silently persists.
    todos.config.allowParallelInProgress = TodosService.configFromRuntime(next, isSubagent).allowParallelInProgress;
    roleState.manifest = next;
    roleState.origin = 'switch';
    roleState.switchedBy = switchedBy;
    roleState.switchedAt = Date.now();
    roleBadge = `role ${next.role} v${next.version ?? '?'} (${next.tools.length} tools)`;
    try {
      pi.appendEntry(ROLE_MANIFEST_CUSTOM_TYPE, {
        version: 1,
        role: next.role,
        manifestVersion: next.version,
        tools: next.tools,
        permissions: next.permissions,
        unknownTools: next.unknownTools ?? 'deny',
        ...(next.guidelines?.length ? { guidelines: next.guidelines } : {}),
        origin: 'switch' as const,
        switchedBy,
        ts: Date.now(),
      });
    } catch {
      /* Best effort recording; the switch itself is already effective. */
    }
    void client
      .reportDisplayAgent(next.role === 'worker-default' ? 'worker' : next.role)
      .catch(() => {});
    const diff = [
      plan.added.length ? `+${plan.added.join(', ')}` : null,
      plan.removed.length ? `-${plan.removed.join(', ')}` : null,
    ]
      .filter(Boolean)
      .join(' ');
    return {
      ok: true,
      message: `role ${current.role} → ${next.role}${diff ? ` (${diff})` : ''}; active tools: ${nextActive.length}`,
    };
  }

  pi.registerCommand('pier-role', {
    description:
      'Show the current role + available role names, or switch: /pier-role <name> (widening beyond the current toolset asks for confirmation)',
    handler: async (args: unknown, ctx: unknown) => {
      const ui = (ctx as { ui?: { notify?: (t: string, l?: string) => void; confirm?: (t: string, m: string) => Promise<boolean> } }).ui;
      const notify = (text: string, level: 'info' | 'error') => ui?.notify?.(text, level) ?? console.error(text);
      const current = roleState.manifest;
      if (!current) {
        notify('Role system not armed (no manifest).', 'error');
        return;
      }
      const name = typeof args === 'string' ? args.trim() : '';
      if (name === '') {
        const names = new Set<string>(RESERVED_ROLE_NAMES);
        for (const layer of roleLayers({ baseDir: roleBase })) {
          try {
            for (const f of readdirSync(layer.dir)) {
              if (f.endsWith('.json')) names.add(f.slice(0, -'.json'.length));
            }
          } catch {
            /* Layer directory absent; later layers still apply. */
          }
        }
        notify(
          `Current role: ${current.role} (origin: ${roleState.origin}). Available: ${[...names].sort().join(', ')}`,
          'info',
        );
        return;
      }
      try {
        const preview = composeForRole(name, [], { loadRoleOpts: { baseDir: roleBase } });
        const plan = planRoleSwitch(current.tools, preview.manifest.tools);
        // Q2: humans may widen (after confirm) — the human is the final authority in the pane.
        if (plan.widening && ui?.confirm) {
          const okToWiden = await ui.confirm(
            'Widen role toolset',
            `Role "${name}" adds tools beyond the current set (${plan.added.join(', ')}). Switch anyway?`,
          );
          if (!okToWiden) {
            notify('Role switch cancelled.', 'info');
            return;
          }
        }
      } catch (err) {
        notify(`Error: role "${name}" unavailable: ${(err as Error).message}`, 'error');
        return;
      }
      const res = await applyRoleSwitch(name, 'human');
      notify(res.message, res.ok ? 'info' : 'error');
    },
  });

  /* P0 §4.6: per-role guidelines ride the before_agent_start prompt-section diff. Writing the
   * same string each turn is a no-op delta (pi diffs sections); removal happens when the current
   * role has no guidelines, so a switch away cleans the section on the next turn. */
  pi.on('before_agent_start', async (event) => {
    const sections = event.systemPromptOptions?.sections;
    if (!sections) return;
    const m = roleState.manifest;
    if (m?.guidelines?.length) {
      const text = `Role "${m.role}" operating constraints:\n${m.guidelines.map((g) => `- ${g}`).join('\n')}`;
      if (sections['pier-role'] !== text) sections['pier-role'] = text;
    } else {
      delete sections['pier-role'];
    }
  });

  // Session-tree navigation (/tree, /fork): reconstruction preserves branch correctness.
  pi.on('session_tree', async (_event, ctx) => {
    sessionId = resolveSessionId(ctx);
    rebuildFromBranch(ctx);
    // P0: pi reverts the transcript loadout at the navigated branch point; the gate manifest,
    // guidelines, badge and sidebar identity must follow the same point (same-origin, RFC §4.3).
    syncRoleFromBranch(ctx);
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
    // Why (A11): Reset lastStopReason on turn_start so a previous turn's abort
    // does not taint subsequent turns or suppress settlement wake / notice flush.
    lastStopReason = null;
    // Safety fallback: if previous compaction finished without clean callback settlement,
    // ensure flags are reset. Pi core prohibits prompts while compaction is active, so this is safe.
    coordinator.compactionInFlight = false;
    coordinator.intentionalAbort = false;
    reportAgent('working', currentActivity(todos.items));
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
    if (event === null || typeof event !== 'object' || !('message' in event)) return;
    const msg = (event as { message: unknown }).message; // 'message' in has been guarded.
    if (msg === null || typeof msg !== 'object') return;
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
  });

  pi.on('agent_settled', async (_event: unknown, ctx) => {
    agentActive = false;
    reportAgent('idle', null);
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
    if (ctx && typeof ctx === 'object') {
      void coordinator.onAgentSettled({
        ctx,
        todos: todos.items,
        pi,
        config: effConfig.onlineContextCompact,
        cancelReminder: todoUi.cancelReminder,
        onBeforeCompact: createCompactionBatchPackHook({
          getObsConfig: () => effConfig.observationPack,
          getManifest: () => roleState.manifest,
          getSessionId: () => sessionId,
          pickMiddleExcerpt,
        }),
      });
    }
  });

  // Official herdr:pi is full-lifecycle authority when installed: it reports blocked
  // only on the herdr:blocked event (pi core never emits it). Custom source=pi-herdr
  // pane.report_agent is ignored while that authority is live
  // (screen_detection_skip_reason=full_lifecycle_hook_authority). Emit the event so
  // herdr:pi publishes blocked; keep report_agent as fallback when it is absent.
  /**
   * Open one human gate. Nested gates (pier's ask tool plus pi's own ctx.ui prompt, or an
   * external herdr:blocked producer) are coalesced: only the 0→1 transition reports blocked,
   * marks the ask flag and folds the widget. Returns true when this call opened the outer gate.
   */
  function enterBlocked(label: string | null): boolean {
    blockedDepth += 1;
    if (blockedDepth > 1) return false;
    reportAgent('blocked', label);
    // D95: human-gate marker lets the workbench heatmap distinguish ask from block.
    if (label) void client.reportAskFlag(label).catch(() => {});
    // Gate open collapses the todo widget to one line — the question owns the fixed area.
    todoUi.rerenderWidget?.();
    return true;
  }
  /** Close one gate; only the 1→0 transition restores the pre-gate state. Returns true when closed.
   *  An unmatched release (no gate open) is ignored rather than reported, so a stray
   *  ui_prompt_end cannot emit a false "no longer blocked" edge. */
  function exitBlocked(): boolean {
    if (blockedDepth === 0) return false;
    blockedDepth -= 1;
    // Gate closed → restore the full widget window.
    todoUi.rerenderWidget?.();
    if (blockedDepth > 0) return false;
    reportAgent(agentActive ? 'working' : 'idle', agentActive ? currentActivity(todos.items) : null);
    // D95: gate released → clear marker.
    void client.reportAskFlag(null).catch(() => {});
    return true;
  }

  // emit() is synchronous; this flag stops our own listener from double-counting depth.
  let publishingHerdrBlocked = false;
  /** Publish the herdr:blocked edge for pi-herdr's own gates; no-op re-entry is prevented by the flag. */
  function emitHerdrBlocked(active: boolean, label: string | null): void {
    publishingHerdrBlocked = true;
    try {
      pi.events.emit(
        'herdr:blocked',
        active ? { active: true, ...(label ? { label } : {}) } : { active: false },
      );
    } finally {
      publishingHerdrBlocked = false;
    }
  }
  function publishHerdrBlocked(active: boolean, label: string | null): void {
    if (active) enterBlocked(label);
    else exitBlocked();
    emitHerdrBlocked(active, label);
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

  /* ── Generic human-gate reporting (pi 0.84.4+) ─────────────────────────
   * Why: `ui_prompt_start` / `ui_prompt_end` fire around blocking ctx.ui dialogs.
   * Scope: only the inherently human-blocking kinds (select / confirm / input / editor).
   * `custom` is deliberately excluded: pi routes both modals and *persistent overlays*
   * through ctx.ui.custom, and pier itself registers a resident slim-frame overlay that
   * never calls done() — treating it as a gate left the pane blocked (and the ask marker
   * set) for the entire session while the agent kept working. Note that a resident overlay
   * also holds pi's own prompt span open, so these events generally stop firing in herdr
   * panes anyway; pier's ask tool opens its gate explicitly and is the reliable path there.
   * Probed through a structural type because the events postdate our pinned pi devDependency. */
  const uiPromptEvents = pi as unknown as {
    on?: (name: 'ui_prompt_start' | 'ui_prompt_end', handler: (event: unknown) => void) => void;
  };
  const GATING_PROMPT_KINDS = new Set(['select', 'confirm', 'input', 'editor']);
  uiPromptEvents.on?.('ui_prompt_start', (event) => {
    const rec = (event ?? {}) as { kind?: unknown; title?: unknown };
    const title = typeof rec.title === 'string' && rec.title.trim() ? rec.title.trim() : null;
    const kind = typeof rec.kind === 'string' ? rec.kind : 'prompt';
    if (!GATING_PROMPT_KINDS.has(kind)) return;
    // Normalize once so the gate report and the published edge carry the same label.
    const label = title ?? kind;
    // The ask tool opens its own gate first, so this is usually a nested (no-op) transition;
    // prompts from other extensions or pi core open the gate here.
    if (enterBlocked(label)) emitHerdrBlocked(true, label);
  });
  uiPromptEvents.on?.('ui_prompt_end', () => {
    if (exitBlocked()) emitHerdrBlocked(false, null);
  });

  /* ── Tool: ask_user_question (v1.3 M8 human gate, available to master and subagents) ── */

  /* ── D101: ObservationPack (obs_recall tool & context projector) ── */
  registerObservationPack({
    pi,
    getConfig: () => effConfig,
    getRuntimeManifest: () => roleState.manifest,
    pickMiddleExcerpt,
    getRemainingHorizon: () => {
      const usage = (latestCtx as { getContextUsage?: () => { contextWindow?: number } })?.getContextUsage?.();
      return coordinator.getRemainingHorizon(3, usage?.contextWindow ?? null);
    },
  });

  /* ── D104: /pier-config (read-only config guide + guided-change handoff) ──
   * Supersedes the former /efficiency command: the index line reports OCC/OBS/EPR state and
   * `show efficiency` lists every D100-D103 knob with its effective value and source. */

  installConfigCommand({ pi });
  installDashboardCommand({
    pi,
    client,
    env,
    getTodoItems: () => todos.items,
    getHeldLocks: () => locksHandle.getHeldLocks(),
  });

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
      const label = gateLabel(prepared.spec);
      publishHerdrBlocked(true, label);
      // The gate stays reported for the whole wait: reportAgent() drops working/idle reports while
      // blockedDepth > 0, and pi's ui_prompt_start/end events keep the depth honest for prompts
      // that do not come from this tool. (The old 5s refresh interval is obsolete.)
      try {
        return await runAsk(prepared.spec, ui, signal instanceof AbortSignal ? signal : undefined);
      } finally {
        publishHerdrBlocked(false, null);
      }
    },
  });

  pi.on('session_shutdown', async () => {
    coordinator.compactionInFlight = false;
    coordinator.intentionalAbort = false;
    if (sessionRoot) {
      try {
        await pruneSessionObjects(sessionRoot);
      } catch {
        /* ignore shutdown pruning errors */
      }
    }
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
  /** D-4: focus sampler for this pane (started on session_start, stopped on session_shutdown). */
  const sessionFocusPoller: { current: FocusPoller | null } = { current: null };
  let pendingMachineRequest: { id: string; from: string | null; push: boolean; sinceTs: number } | null = null;
  let latestCtx: { abort?: () => void } | null = null;

  // triggerTurn:true — idle followUp must start a new turn or settlement is lost.
  const sendUserMessageIn = (content: string): Promise<void> =>
    (pi as unknown as { sendUserMessage?: (content: string, opts?: { deliverAs?: string; triggerTurn?: boolean }) => Promise<void> })
      .sendUserMessage?.(content, { deliverAs: 'followUp', triggerTurn: true }) ?? Promise.resolve();
  const sendUserMessageAs = (content: string, mode: 'steer' | 'followUp'): Promise<void> =>
    (pi as unknown as { sendUserMessage?: (content: string, opts?: { deliverAs?: string; triggerTurn?: boolean }) => Promise<void> })
      .sendUserMessage?.(content, { deliverAs: mode, triggerTurn: true }) ?? Promise.resolve();

  const notices = createNoticeBuffer({
    isBusy: () => agentActive || lastStopReason === ABORT_STOP_REASON,
    send: sendUserMessageAs,
    // P0-2: rank collapsed batches by relevance to the master's in-progress work
    rank: async (contents) => {
      if (!jevRuntime.available) return null;
      const inProgressTodos = todos.items
        .filter((item) => item.status === 'in_progress')
        .map((item) => item.content);
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
    // D-4: herdr 0.9.0 never delivered pane.focused to plugins; 0.9.1+ does. Poller is a
    // fallback for old servers (see resolveDefaultFocusPollMs). One poller per pane, self-scoped.
    if (sessionFocusPoller.current) {
      sessionFocusPoller.current.stop();
      sessionFocusPoller.current = null;
    }
    const serverVer = await client.getServerVersion();
    const pollMs = focusPollIntervalMs(process.env, serverVer);
    if (paneId && client.available && pollMs > 0) {
      sessionFocusPoller.current = startFocusPoller({
        myPaneId: paneId,
        intervalMs: pollMs,
        sample: async () => {
          // layout.export reports the focused pane of our own tab. Without that field (older herdr)
          // the tick stays silent instead of guessing focus from the tree.
          const layout = await client.exportLayout({ paneId });
          const sample = parseFocusSample(layout);
          return sample && sample.focusedPaneId !== null ? sample : null;
        },
        fire: (focusedPaneId, cause) => spawnReflow({ paneId: focusedPaneId, cause }),
      });
    }
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
        applyRoleSwitch,
      }));
    } catch {
      /* Pipe name collision (rare): this session has no channel; callers report an error after ping times out. */
    }
  });
  pi.on('session_shutdown', () => {
    sessionFocusPoller.current?.stop();
    sessionFocusPoller.current = null;
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
      // p24-class: sessionId is a BARE id — the .jsonl-only read guard below meant every
      // settle reply carried text: null, so closing text depended solely on the master's
      const ownFile = sessionId
        ? (/\.jsonl$/.test(sessionId)
          ? sessionId
          : sessionFileById(
            process.cwd(),
            process.env.PI_CODING_AGENT_DIR
              ? join(process.env.PI_CODING_AGENT_DIR, 'sessions')
              : platformPaths.sessionsDir,
            sessionId,
          ))
        : null;
      if (ownFile) {
        const entries = readSessionFile(ownFile);
        if (entries) text = lastAssistantText(entries, { sinceTs: req.sinceTs })?.text ?? null;
      }
      await pipeRequest(req.from, {
        type: 'reply',
        id: req.id,
        paneId: env?.paneId ?? '',
        text,
        // Push the resolved PATH when we could read it (older/newer masters accept it
        // directly); fall back to the bare id for a master-side mapping.
        sessionFile: ownFile ?? (sessionId || null),
      }, 5000);
    } catch (err) {
      /* The requester's pollLoop is the fallback, but a dead letter here was invisible in
       * 01a0c282 (cross-workspace pipe name) — surface it for triage. */
      console.error(`pier: settle reply push to ${req.from} failed: ${(err as Error)?.message ?? err}`);
    }
  });

  /* Workbench plugins (subagent/terminal + cordis) are herdr-master only.
   * Bare pi and worker panes mount todo only so unused tools never appear.
   * Dynamic import: worker/bare-pi must never load bootstrap/subagent-poller (C3). */
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
      getBlockedDepth: () => blockedDepth,
      reconcileOnSettlement,
      withReconcileNotes,
      claimSettleNotice,
      isCompactionInFlight: () => coordinator.compactionInFlight,
      isIntentionalAbort: () => coordinator.intentionalAbort,
      jev: { ask: (request, meta) => jevRuntime.ask(request, meta), getMinConfidence: jevMinConfidence },
      appendRoutingLog,
    });
  } else {
    const { mountTodoOnly } = await import('./index-worker.ts');
    await mountTodoOnly({
      pi,
      todos,
      todoUi,
      mirrorTodos,
      getBlockedDepth: () => blockedDepth,
      ...(isSubagent
        ? {}
        : {
            stopReminder: {
              getBlockedDepth: () => blockedDepth,
              getRunningSubs: () => subagentPort.current?.listRunningSubs().length ?? 0,
              isCompactionInFlight: () => coordinator.compactionInFlight,
              isIntentionalAbort: () => coordinator.intentionalAbort,
            },
          }),
    });
  }
}

