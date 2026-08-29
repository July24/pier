/**
 * pi-herdr 扩展入口（v1.1：todo 闭环 + 交互式子代理，DESIGN.md §12 方案 C）。
 *
 * 安装：pi package（package.json 的 pi.extensions）或 ~/.pi/agent/extensions/。
 *
 * 能力：
 *  - 工具 `todo_write`：全量替换式 todo 列表（权威 = 本 pi 会话 JSONL，
 *    分支自动回滚；语义对齐 DSH）。
 *  - 工具 `subagent`：前台/后台委派。子 pane = 交互式 pi TUI（独立会话、
 *    独立上下文），人类可随时进入直接对话；主控经 herdr 通道派活
 *    （状态门：仅 idle 注入）、等待（agent.wait）、取结果（子会话 JSONL）。
 *  - 工具 `list_agents` / `send_message`（followUp 队列语义）/ `interrupt_agent`（esc）。
 *  - 命令 `/todos`、TUI widget、herdr 标题投影（无 herdr 环境优雅降级）。
 *
 * ⚠️ pi 0.84.2 契约（实测）：
 *  - onUpdate 必须是 AgentToolResult 形状（字符串会让 TUI 崩溃退出 pi）；
 *  - 工具结果 details 随会话 JSONL 持久化、getBranch() 重放实现分支回滚。
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { pipeNameFor, pipeRequest, startPipeServer } from './pipe-channel.ts';
import {
  TODO_EDIT_CUSTOM_TYPE,
  currentActivity,
} from './todo-core.ts';

/** 档2：worker 会话内记录运行所依据的合成 manifest（D38 同构，分支可回放）。 */
const ROLE_MANIFEST_CUSTOM_TYPE = 'pi-herdr.role-manifest';

import { createHerdrClient } from './herdr-client.ts';
// subagent 族已迁 core/subagent.ts（loader entry，D78/D81）；subagent-core/history-store/
// session-tail/gc-core 导入随迁（index 仅留 common 面用到的 lastAssistantText/readSessionFile）。
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
 * WS-D7：master pane 自应用 manifest——与 subagent 同一条强制链
 * （闸门 + 可见层 + 徽标 + 会话记录），档案基线 = 自研核心 + 检视/执行工具。
 * 判别：herdr pane（HERDR_ENV=1）且非 subagent 且未被显式下发 manifest。
 * 独立 pi 会话（无 herdr env）不命中 → 保持全量（向后兼容）。
 * master.json 畸形 → fail-open 到无角色态（与 env 畸形同语义）。
 */
function composeMasterRuntime(): RuntimeRoleManifest | null {
  try {
    // v1.1：内置名直读——workspace 放 master.json 诱饵不影响自应用（保留名检查只对 spawn 响亮报错）
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
// C3：cordis 只进 master 进程——subagent-scope（内含 @deepseek-ai/cordis）
// 在 master 分支内动态 import，worker 进程永不加载该模块。
// subagent 族常量/助手已随迁 core/subagent.ts。

export default async function (pi: ExtensionAPI) {
  const mode = planIndexMode();
  const isSubagent = mode.isSubagent;
  const runtimeManifest =
    parseRuntimeManifest(process.env.PI_HERDR_ROLE_MANIFEST) ??
    (mode.composeMaster ? composeMasterRuntime() : null);
  const todos = new TodosService(TodosService.configFromRuntime(runtimeManifest, isSubagent));
  const { client, env } = createHerdrClient();

  let sessionId: string = process.env.PI_SESSION_FILE ?? process.env.PI_SESSION_ID ?? '';
  /** M16：todo 完成时间戳序列（速率估算原料；随 todo.completed 事件追加）。 */
  const completedStamps: number[] = [];

  /* ── 状态重建（分支正确性：取分支路径上最后一次 todo_write 快照）── */

  function rebuildFromBranch(ctx: unknown): void {
    try {
      const entries = (ctx as { sessionManager?: { getBranch?: () => readonly unknown[] } })
        ?.sessionManager?.getBranch?.() ?? [];
      todos.rebuild(entries);
    } catch {
      // 重建失败不影响主流程；下次 todo_write 会重新锚定。
    }
  }

  /* ── herdr 上报（Noop 时零成本；失败静默，绝不影响 pi 主流程） ── */

  /** 档2：worker 的 role 徽标（env 下发 manifest 解析出；idle 态粘性显示）。 */
  let roleBadge: string | null = null;

  function reportAgent(state: 'working' | 'idle' | 'blocked', activity: string | null): void {
    if (!client.available) return;
    const message = activity ?? (state === 'idle' ? roleBadge : null);
    client.reportAgent(state, message).catch(() => {});
  }

  function reportSession(path: string): void {
    if (!client.available) return;
    client.reportAgentSession(path).catch(() => {});
  }

  /** session 标识：sessionManager 权威（print/rpc 模式下 env 可能未设），env 兜底。 */
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
    // M16：进度徽标（保守 N/M + 置信 ETA；估算不可信回退纯计数）
    const p = progressOf(todos.items);
    const eta = estimateEta({ completedAt: completedStamps, total: p.total, now: Date.now() });
    const suffix = formatProgressSuffix({ completed: p.completed, total: p.total, eta });
    // 反冻结：lastWriteAt 随行 → 标题侧 archived 判定（pane-title）
    const title = formatPaneTitle(todos.items, null, {
      progressSuffix: suffix,
      lastWriteAt: todos.lastWriteAt,
    });
    // D97：窄格静帧与 pane 标题同参同源（thinking token 碰不到 → 静帧即冻结）
    updateSlimFrame(title);
    client.reportMetadata({
      session: label,
      items: todos.items,
      progressSuffix: suffix,
      lastWriteAt: todos.lastWriteAt,
    }).catch(() => {});
  }

  /* ── M17：结算自动对账（纯规划器 + D38 权威路径；幂等，双路径双跑无害） ── */

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
          /* 持久化尽力而为（内存态仍推进） */
        }
        todos.applyEdits(plan.edits);
        mirrorTodos();
      }
      return plan.noteLines;
    } catch {
      return [];
    }
  }

  /** M17：对账提示行拼进结算通知（空数组 = 原文返回）。 */
  function withReconcileNotes(base: string, notes: readonly string[]): string {
    return notes.length ? `${base}\n${notes.join('\n')}` : base;
  }

  /* ── M16：进度徽标 + 工具徽标（title 后缀 + report_agent.message；无新协议） ── */

  todos.on('todo.completed', (e: { count: number; at: number }) => {
    for (let i = 0; i < e.count; i++) completedStamps.push(e.at);
    mirrorTodos();
  });

  // 工具徽标：并行模式 start 源序 / end 完成序（pi docs 实测契约）→ Map 跟踪在途
  const runningTools = new Map<string, string>(); // toolCallId → toolName
  let lastToolBadge: string | null = null;
  function reportToolBadge(): void {
    const badge = planToolBadge([...new Set(runningTools.values())]);
    if (badge === lastToolBadge) return; // 幂等：变化才报（M13 渲染纪律）
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

  /* ── todo 族槽（core/todo.ts 插件回填；widget 渲染已随族迁移） ── */
  const todoUi: { renderWidget: (ctx: unknown) => void } = {
    renderWidget: () => { /* 插件挂载前 no-op（挂载后回填） */ },
  };

  /* ── 生命周期 ────────────────────────────────────────────────────── */

  pi.on('session_start', async (event, ctx) => {
    sessionId = resolveSessionId(ctx);
    rebuildFromBranch(ctx);
    // v1.3 M9 修复（实测）：resume 时 pi 会从会话恢复 widget 状态；
    // 此时再 setWidget 会破坏 TUI 的 '/' 命令面板输入路由（'/' 被当消息文本送给模型）。
    const reason = (event as { reason?: string } | undefined)?.reason;
    if (reason !== 'resume') todoUi.renderWidget(ctx);
    // D97：窄格静帧 overlay（幂等注册；herdr pane 内才有意义——普通终端窄窗
    // 盖住交互面是事故，且热力放大才提供退出路径。resume 也重注册：pi 会话
    // 切换会 resetExtensionUI 拆掉 overlay）。
    if (env) registerSlimFrame(ctx);
    mirrorTodos();
    reportSession(sessionId);
    // D93：侧边栏身份 = role 名（display_agent 优先于 agent 检测值，0.8.2 actions.rs:563）。
    // master → 'master'；worker → manifest.role（worker-default 美化为 worker）。
    // 无 manifest 的裸 pi（独立会话）不上报——不打扰普通 pi 使用。
    if (runtimeManifest) {
      const roleDisplay = runtimeManifest.role === 'worker-default' ? 'worker' : runtimeManifest.role;
      void client.reportDisplayAgent(roleDisplay);
    }
    // 档2：worker role manifest（env，进程启动时已解析）→ 徽标 + 会话权威记录
    // （custom 条目与 D38 todo-edit 同构：执行期强化的回放锚点）
    if (runtimeManifest) {
      roleBadge = `role ${runtimeManifest.role} v${runtimeManifest.version ?? '?'} (${runtimeManifest.tools.length} tools)`;
      try {
        (pi as { appendEntry?: (customType: string, data: unknown) => void }).appendEntry?.(
          ROLE_MANIFEST_CUSTOM_TYPE,
          { version: 1, role: runtimeManifest.role, manifestVersion: runtimeManifest.version, tools: runtimeManifest.tools, permissions: runtimeManifest.permissions, unknownTools: runtimeManifest.unknownTools ?? 'deny', ts: Date.now() },
        );
      } catch {
        /* 记录尽力而为 */
      }
      // D77 可见层：manifest 外的工具从模型视野移除（session_start = 所有插件已加载完）。
      // 交集语义防清空；master 无 manifest 不动（全量）。底层 API 缺失则静默跳过（旧 pi 兼容）。
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
          /* 可见层尽力而为（强制层仍在） */
        }
      }
    }
    reportAgent('idle', null);
  });

  /* ── 档2 Week4-5：worker 执行期强制（manifest 最后一道闸） ──
   * deny / 不在 manifest → block（reason 给模型）；ask → v1 退化放行 + stderr 日志
   * （V56 验收锚点）。master / 纯标签 worker 无 manifest = open。
   * 限速已移除（WS-D6）：权限边界归我们，资源配额归插件引入者。 */
  pi.on('tool_call', async (event: { toolName?: string }) => {
    if (!runtimeManifest) return;
    const tool = typeof event?.toolName === 'string' ? event.toolName : '';
    const gate = planToolGate(tool, runtimeManifest);
    if (gate.kind === 'deny') {
      return { block: true, reason: gate.reason };
    }
    if (gate.kind === 'ask') {
      console.error(`${gate.notice} (v1 soft-approval: allowed, hard gate lands in v2)`);
      // 持久留痕（V56 锚点）：stderr 会被 TUI 重绘刷掉，会话 custom 条目才是权威
      try {
        (pi as { appendEntry?: (customType: string, data: unknown) => void }).appendEntry?.(
          'pi-herdr.approval-needed',
          { role: runtimeManifest.role, tool, ts: Date.now() },
        );
      } catch {
        /* 尽力而为 */
      }
    }
  });


  // 会话树跳转（/tree、/fork 后）：分支正确性靠重建。
  pi.on('session_tree', async (_event, ctx) => {
    sessionId = resolveSessionId(ctx);
    rebuildFromBranch(ctx);
    todoUi.renderWidget(ctx);
    mirrorTodos();
  });

  let agentActive = false;
  const subagentPort = emptySubagentPortBox();
  // D96 状态（settle-wake-core 去重/冷却的锚点）。
  let d96NoticeKey: string | null = null;
  let d96NoticeAt = 0;
  // 反唤醒风暴（settle-wake-core）：追踪最后一次 assistant turn 的 stopReason，
  // 'aborted' = 用户 ESC 显式叫停 → settled 时不得注入任何唤醒型消息。
  let lastStopReason: string | null = null;
  pi.on('turn_start', async () => {
    agentActive = true;
    reportAgent('working', currentActivity(todos.items));
  });
  pi.on('turn_end', async (event: unknown) => {
    if (event === null || typeof event !== 'object' || !('message' in event)) return;
    const msg = (event as { message: unknown }).message; // 'message' in 已守卫
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
      // 用户 abort 后静默：结算缓冲保留（pendingSettleNotices 不清空），
      // 待下次自然 run 的 turn_end steer / 自然 settled 再投。
      return;
    }
    // D96: master settled while background subagents still run → remind (worker port is unbound).
    if (plan.notice && !isSubagent) {
      const running = subagentPort.current?.listRunningSubs() ?? [];
      const brief = running.map((s) => `${s.paneId} (${s.description})`).join('、');
      const notice = `注意：仍有 ${running.length} 个后台 subagent 在运行：${brief}。若你的任务依赖它们，请等待其结算（list_agents 查看状态）；若不等待，请说明放弃原因。`;
      void sendUserMessageIn(notice);
    }
  });

  // v1.3 M8：blocked 自上报（D29 豁免依赖 blocked 可见）。
  // 实测：pi 0.84.2 核心不发 "herdr:blocked"（官方集成的监听是死代码）→
  // 本扩展自行管理：等待人类回答（ask_user_question）期间 enterBlocked/exitBlocked。
  let blockedDepth = 0;
  function enterBlocked(label: string | null): void {
    blockedDepth += 1;
    reportAgent('blocked', label);
    // D95：人类闸门标志（workbench 热力分级区分 ask vs block）
    if (label) void client.reportAskFlag(label).catch(() => {});
  }
  function exitBlocked(): void {
    blockedDepth = Math.max(0, blockedDepth - 1);
    if (blockedDepth === 0) {
      reportAgent(agentActive ? 'working' : 'idle', agentActive ? currentActivity(todos.items) : null);
      // D95：闸门解除 → 清标志
      void client.reportAskFlag(null).catch(() => {});
    }
  }
  (pi as { events?: { on?: (ev: string, cb: (data: unknown) => void) => void } }).events?.on?.(
    'herdr:blocked',
    (data) => {
      const d = data as { active?: boolean; label?: string } | undefined;
      if (d?.active) enterBlocked(typeof d.label === 'string' ? d.label : null);
      else exitBlocked();
    },
  );

  /* ── 工具：ask_user_question（v1.3 M8 人类闸门，主控与子代理都有） ── */

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
      enterBlocked(question);
      // v1.3 M8 实测：等待人类期间 herdr 检测持续显示 working，会覆盖单次 blocked 上报
      // → 5s 心跳重报，保证 pane 在 herdr 里呈 blocked（人类可见 + GC 豁免）。
      const hb = setInterval(() => { reportAgent('blocked', question); }, 5000);
      try {
        const answer = await ui?.input?.(question, 'your answer');
        return {
          content: [{ type: 'text', text: `The human answered: ${answer ?? '(no answer given)'}` }],
          details: { question, answer: answer ?? null },
        };
      } finally {
        clearInterval(hb);
        exitBlocked();
      }
    },
  });

  pi.on('session_shutdown', async () => {
    client.close();
  });

  /* ── M12：双向消息通道（D49/D50/D48；每个 pane 都在自己名字上监听，无主从） ── */

  const settleNoticeLatch = new Set<string>();
  /** 结算通知去重（push 快路径与 pollLoop 兜底二选一；按 paneId+请求id 记轮次，每轮各一条）。 */
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
      try { pipeServerBox.current.close(); } catch { /* 旧实例 */ }
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
      /* 管道名占用（罕见）：本次会话不提供通道，调用方 ping 超时后报错 */
    }
  });
  pi.on('session_shutdown', () => {
    if (pipeServerBox.current) {
      try { pipeServerBox.current.close(); } catch { /* 已关 */ }
      pipeServerBox.current = null;
    }
  });

  // D50：本 pane 自己的结算 → 若有待回信的机器请求，push 摘要+会话路径给请求方
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
      /* push 失败静默：请求方的 pollLoop 兜底 */
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
