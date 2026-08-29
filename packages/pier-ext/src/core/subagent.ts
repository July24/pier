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
import { appendHistory, applyReportedSessionFile, historyFilePath, inheritOutcome, latestGeneration, readHistory, type HistoryEntry } from '../history-store.ts';
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
import { pingUntilReady, pipeNameFor, pipeRequest } from '../pipe-channel.ts';
import { shouldClosePane, shouldCloseTaskTab } from '../gc-core.ts';
import { composeForRole } from '../manifest-compose.ts';
import { formatSettlementNotice } from '../vocab.ts';
import { TODO_REMINDER_CUSTOM_TYPE, planStopTodoReminder, todoReminderGraceMs } from '../todo-reminder-core.ts';
import type { TerminalStateSlot } from './terminal.ts';

export interface SubagentEnv {
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
  /** B4：每 pane 最近一次机器注入（prompt/follow_up pipe 投递成功）时间——观察窗内的
   * working 若发生在宽限期内，是自己的注入在被处理，不是用户接管。 */
  const lastMachineInjectAt = new Map<string, number>();
  /* 子代理注册表（custom 条目持久化，分支正确；parent 重启后可从分支重建） */
  const subs = new Map<string, SubEntry>();
  /** D98：isolate 创建中分支（worktree add → subs.set 窗口的孤儿扫描护栏）。 */
  const pendingIsolateBranches = new Set<string>();
  const pollers = new Set<string>();
  const subScopes = new Map<string, { dispose: () => Promise<void> }>();
  /** D50：每 pane 最近一次机器请求 id（interrupt 按轮次占位、pollLoop 去重用）。 */
  const lastRequestIdByPane = new Map<string, string>();

  /** O1：上次落盘快照（内容哈希门控——01a03c0d 实证 48% session 行是心跳期重复快照）。 */
  let lastSubsSnapshot = '';

  function persistSubs(): void {
    try {
      const reg = makeRegistry([...subs.values()]);
      const snap = JSON.stringify(reg);
      if (snap === lastSubsSnapshot) return; // 内容未变不落（1s 观察窗/5s 接管循环的重复心跳）
      lastSubsSnapshot = snap;
      pi.appendEntry?.(SUBS_CUSTOM_TYPE, reg);
    } catch {
      /* 持久化尽力而为 */
    }
  }
  /** E2：已发过闸门通知的 pane（blocked 期间去重；解除后移除，二次 ask 可再通知）。 */
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
      lastSubsSnapshot = ''; // 分支回放改变了状态 → 下次 persistSubs 强制落盘
    } catch {
      /* 重建失败不影响主流程 */
    }
  }

  /** B6：master 崩溃遗留的 running 行——按 herdr 实况补 closed（pane 没了才关，
   * pane 还在的真在跑则保留）。01a03c0d 台账实证：p6/p7 永久 running 无回收。 */
  async function sweepZombieRunning(): Promise<void> {
    if (!client.available || subs.size === 0) return;
    let livePaneIds: ReadonlySet<string>;
    try {
      livePaneIds = new Set((await client.listPanes()).map((p) => p.paneId));
    } catch {
      return; // 查询失败不误关
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

  /* ── B1（用户实证修复）：subagent isError 结果的探活改写 ──────────────
   * 实测事故：前台误判 no-output → 模型读裸错误文案 → "failed, 我自己干" 抢活。
   * pi 的 tool_result 事件官方语义 "Can modify result"——在文本进模型上下文前，
   * 当场探活（agent.list + 会话 mtime）；判活则改写为统一存活通知（buildAliveNotice
   * 与 A2 转后台同一出口）。hook 层硬保障，纯 prompt 防不住的自作主张在此物理拦截。 */
  scoped.on('tool_result', async (event: { toolName?: string; toolCallId?: string; isError?: boolean; content?: Array<{ type: string; text?: string }> }) => {
    if (event?.toolName !== 'subagent' || !event.isError) return;
    // 从错误文本里取 pane id（我们自己的错误文案都带 pane）；取不到则不改写
    const errText = (event.content ?? []).map((c) => c.text ?? '').join(' ');
    const paneId = [...subs.keys()].find((id) => errText.includes(id))
      ?? (errText.match(/\bw[A-Za-z0-9]+:p\d+\b/) ?? [])[0];
    if (!paneId) return;
    const entry = subs.get(paneId);
    if (!entry || entry.status === 'settled' || entry.status === 'consumed') return;
    const probe = await probeAlive(paneId, entry.cwd);
    if (!isAlive(probe, Date.now())) return; // 真死了 → 保留原错误，模型可重做
    // 活着 → 转 poller（若尚未在跑）并改写结果文本
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

  /* ── D41：stop 未完成提醒（仅主控；子代理不注册本块）── 二修（01a040cc 实证）
   * 事故：旧版在 settled 后 116ms 以 user-role sendUserMessage 注入
   * 「Continue working on them before stopping」——通道权威压过模型收尾判断，
   * 「待 push（留给用户决定）」12s 内被执行。三修：
   *  - 通道：sendMessage(custom)（非 user 角色，来源可辨，不冒充用户）；
   *  - 措辞：对账请求（继续已授权 / 等人工项标 blocked+blocker / 问用户一等出口）；
   *  - 宽限：settled 后等 grace 再注入，期间任何 agent 启动即取消——
   *    用户反制窗口（决策纯核心 todo-reminder-core）。
   * 反唤醒风暴守卫保留：ESC 中止后的 settled 不催（01a03bf0 实证）。 */

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
    const msg = (event as { message: unknown }).message; // 'message' in 已守卫
    if (msg === null || typeof msg !== 'object') return;
    const { role, stopReason } = msg as { role?: unknown; stopReason?: unknown };
    if (role === 'assistant' && typeof stopReason === 'string') {
      lastAssistantStopReason = stopReason;
    }
  });

  // B3：宽限窗内 agent 被任何来源唤醒（用户输入 / 其他扩展）→ 本次提醒取消
  scoped.on('agent_start', () => cancelTodoReminder());
  scoped.on('session_shutdown', () => cancelTodoReminder());

  scoped.on('agent_settled', async () => {
    cancelTodoReminder(); // 上一 settle 遗留、尚未走完宽限的定时器
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
        // 无 sendMessage 的 pi：宁可不提醒，也不回退 user 通道冒充用户
        const send = pi.sendMessage;
        if (typeof send !== 'function') return;
        try {
          await send(
            { customType: TODO_REMINDER_CUSTOM_TYPE, content, display: true },
            { deliverAs: 'followUp', triggerTurn: true },
          );
          todoReminders += 1; // 仅实际送达才计数（取消/失败不消耗封顶）
        } catch {
          /* 静默 */
        }
      })();
    }, todoReminderGraceMs());
    todoReminderTimer.unref?.(); // 不悬住进程（测试 / headless 场景）
  });

  /* ── 通道助手（M11：就绪 = 管道握手） ── */

  /** 就绪等待：管道 ping（子扩展 session_start 起 server 即就绪；D47）。 */
  async function waitSubReady(cwd: string, paneId: string): Promise<boolean> {
    return pingUntilReady(pipeNameFor(cwd, paneId), SUB_READY_TIMEOUT_MS);
  }

  /**
   * 子代理会话文件候选（v1.3 M7 修复结算文本串线，实测）：
   *  1. 上报路径（本扩展 report_agent_session 的 .jsonl path）；
   *  2. 上报 session id → 按 id 还原；
   *  3. 目录内最新 4 个（排除主控自己的会话——父在写盘时其 mtime 常最新，
   *     曾实测致结算文本取到父的回复）。
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
      /* 走目录扫描 */
    }
    const ownSession = d.getSessionId();
    for (const f of listSessionFiles(cwd, defaultAgentSessionsDir(), 4)) {
      if (f !== ownSession && !out.includes(f)) out.push(f);
    }
    return out;
  }

  /** 定位可解析的子代理会话文件（spawn/结算登记用）。 */
  async function resolveSessionFile(paneId: string, cwd: string): Promise<string | null> {
    for (const file of await resolveSessionFileCandidates(paneId, cwd)) {
      if (readSessionFile(file)) return file;
    }
    return null;
  }

  /** 结算后（带重试）取注入时间点之后的最终回答。 */
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

  /** E1/E2：读子 pane 的人类闸门问题（tokens['pi-ask']；子扩展 reportAskFlag 上报）。 */
  async function readAskFlag(paneId: string): Promise<string | null> {
    try {
      const a = (await client.listAgents()).find((x) => x.paneId === paneId);
      const v = a?.tokens?.['pi-ask'];
      return typeof v === 'string' && v ? v : null;
    } catch {
      return null;
    }
  }

  /** A2/B1 探活：pane 实时状态 + 会话候选最新 mtime（毫秒级，失败字段为 null）。 */
  async function probeAlive(paneId: string, cwd: string): Promise<AliveProbe> {
    const probe: AliveProbe = { paneExists: false, agentStatus: null, lastActivityMs: null };
    try {
      const agents = await client.listAgents();
      const a = agents.find((x) => x.paneId === paneId);
      probe.paneExists = a != null;
      probe.agentStatus = a?.status ?? null;
    } catch {
      /* agent.list 失败 → 状态未知，靠会话活动判定 */
    }
    for (const file of await resolveSessionFileCandidates(paneId, cwd)) {
      try {
        const mtime = (await statAsync(file)).mtimeMs;
        if (probe.lastActivityMs == null || mtime > probe.lastActivityMs) probe.lastActivityMs = mtime;
      } catch {
        /* 文件消失跳过 */
      }
    }
    return probe;
  }

  /**
   * 子会话结算状态（v1.3 M8 结算竞态修复）：
   *  herdr 的 idle/done 在"注入瞬间"也是真，不能当结算信号；
   *  以会话内容为准——定稿文本 = 已结算；挂起 toolCall = 未结算；
   *  有 assistant 活动但无文本 = 真·无输出；无活动 = 还没开始。
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

  /** D92：结算通知统一出口——经 deps 缓冲（忙时 turn_end 折叠注入），缺省回退旧 followUp 直投。 */
  const injectNotice = (content: string): Promise<void> =>
    d.deliverNotice ? d.deliverNotice(content)
      : (pi.sendUserMessage?.(content, { deliverAs: 'followUp' }) ?? Promise.resolve());

  /** 后台子代理轮询器：结算→取文→followUp 通知；blocked 让位给人类；D94：用户接管检测。 */
  async function pollLoop(
    paneId: string,
    cwd: string,
    spawnedAt: number,
    injectTs: number,
    description: string,
    requestId: string,
  ): Promise<void> {
    void spawnedAt;
    // B1：无活动预算锚点——working 切片（waitAgent 超时 null）即心跳（O3）：每次续命；
    // 只有「不 working 也无结算进展」的真空期才消耗预算（01a03c0d：27min 健康长任务
    // 被旧总墙钟 10min 误杀两次）。startedAt 保留供通知文案诊断。
    const startedAt = Date.now();
    let lastActivityAt = Date.now();
    const pollTrace = process.env.PI_HERDR_TRACE
      ? (msg: string) => { try { appendFileSync(process.env.PI_HERDR_TRACE!, `d98poll ${Date.now()} ${paneId} ${msg}\n`); } catch { /* 尽力 */ } }
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
            // listAgents 失败静默
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
              /* 注入失败静默（下次 turn 可 list_agents 自查） */
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
              // listAgents 失败静默
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
            // 正常结算逻辑
            // O6：reply 已写的 sessionFile 是权威；poll 只在缺失时用扫描补，绝不反向覆盖
            if (!entry.sessionFile) {
              entry.sessionFile = applyReportedSessionFile(
                entry.sessionFile,
                await resolveSessionFile(paneId, cwd),
              );
            }
            entry.status = 'consumed';
            entry.consumedAt = Date.now();
            writeHistory(entry, { outcome: closing }, 'poll-settle');
            // M17：结算自动对账（先于通知；与 reply 快路径幂等双跑）
            const notes = d.reconcileOnSettlement(description, 'settled');
            // D98：结算附 worktree/git stat 行（isolate 带基线 diff；非 isolate 小件轻量行）
            const statLine = await worktreeStatLine(entry);
            const notice = d.withReconcileNotes(
              formatSettlementNotice(`${paneId} (${description})`, closing) + (statLine ? `\n${statLine}` : ''),
              notes,
            );
            if (d.claimSettleNotice(`${paneId}:${requestId}`)) {
              try {
                await injectNotice(notice);
              } catch {
                /* 注入失败静默（下次 turn 可 list_agents 自查） */
              }
            }
            return;
          }
          // 挂起 toolCall（等人类输入）或还没开工 → 继续等
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
            /* 静默 */
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
            /* 静默 */
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
        // 回归加固（D98 活体实证）：mount/pollLoop 抛错若无此兜底，paneId 永留
        // pollers（后续 startPoller 全 no-op）且无轮询在跑 → running 幽灵。
        pollers.delete(paneId);
        console.error(`pier: subagent poller ${paneId} crashed: ${(err as Error)?.message ?? err}`);
      }
    })();
  }

  /* ── 工具：subagent（v1.3：任务 tab 放置 + 短/长 pane + 历史 + GC） ── */

  /** 串行化 tab 创建/追加（同消息并行委派的读改写互斥；D26 放置决策在锁内做）。 */
  const tabMutex = new Semaphore(1);

  function histFile(cwd: string): string {
    return historyFilePath(agentRootDir(), cwd);
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

  /** B5：每 taskId 最近非空 outcome（closed 补记行继承——latestGeneration 取最新行，
   * 旧实现 closed 行恒 outcome:null → 结算成果在「最新行」语义下丢失）。 */
  const lastOutcomeByTask = new Map<string, string>();

  function writeHistory(e: SubEntry, patch?: Partial<HistoryEntry>, via?: string): void {
    const outcome = inheritOutcome(lastOutcomeByTask.get(e.taskId), patch?.outcome);
    if (typeof outcome === 'string' && outcome.length > 0) lastOutcomeByTask.set(e.taskId, outcome);
    appendHistory(histFile(e.cwd), { ...toHistory(e, outcome), ...(patch ?? {}), ...(via ? { via } : {}) });
  }

  /** 存活任务 tab（本 workspace；herdr 为权威，tab.rename/自动关后自动纠正）。 */
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

  /* ── D86：git worktree 分组键 ─────────────────────────────────── */

  /** worktree 列表缓存（spawn 时一次查询；TTL 短——放置只需近似新鲜度）。 */
  let worktreesCache: { at: number; list: string[] } | null = null;
  const WORKTREES_CACHE_MS = 5000;

  /**
   * 列出 repo 的全部 git worktree（`git worktree list --porcelain`，主检出在前）。
   * 非 git 目录 / git 不可用 → 空数组（分类器自然全兜底 main，规则退化不炸）。
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
   * D98：git 执行助手（git-adapter，timeout 由 runtimePolicy.gitTimeoutMs；出错/超时 → null，与
   * listWorktrees 同模式）。isolate 全部 git 操作的唯一出口——基础设施行为，
   * 与 herdr 内部 git 调用同构，不属模型面 bash 生态。
   */
  async function runGit(cwd: string, args: string[]): Promise<string | null> {
    try {
      const { stdout } = await defaultGitAdapter.run(cwd, args);
      return stdout == null ? null : String(stdout);
    } catch {
      return null;
    }
  }

  /** `git diff --stat` 末行（"N files changed, +A/-B"）；空输出 → null。 */
  function lastStatLine(out: string | null): string | null {
    if (!out) return null;
    const lines = out.replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
    return lines.length ? lines[lines.length - 1]! : null;
  }

  /**
   * D98：结算通知附行（两条结算路径共用）。非 git cwd → null（静默省略）；
   * isolate → 基线 diff stat + commit 计数；非 isolate → 对全部 git worker 的
   * 轻量「小件」：working-tree diff stat + 未提交计数。
   */
  async function worktreeStatLine(entry: SubEntry): Promise<string | null> {
    const porcelain = await runGit(entry.cwd, ['status', '--porcelain']);
    if (porcelain === null) return null; // 非 git / git 不可用
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
   * 按放置计划在任务 tab 内新建子 pane（v1.3 D25/D26 + D86 worktree 分组）：
   *  - new：tab.create{label}（focus 默认 false 不抢焦点）+ 根 pane 注入启动命令；
   *  - append：校验既有 tab 存活 → split 追加（进程不重启）；
   *    tab 已消失 → 降级为同名的 new。放置决策在互斥锁内做（同名竞态）。
   * D86：placement.zone 由调用方算好传入（main → master 所在 tab；worktree → 目录名 tab）。
   */
  async function spawnPaneInTaskTab(
    placement: { desiredTab?: string | null; description: string; zone?: WorktreeZone },
    cwd: string,
    envOver: Record<string, string>,
    launch: string,
  ): Promise<{ tabId: string; paneId: string; tabName: string }> {
    const release = await tabMutex.acquire();
    try {
      // D86：main tab = master pane 所在 tab（paneId 反查；HERDR_TAB_ID 注入不可依赖，实测可为空）
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
        // D97 网格形态：目标格 = tab 内面积最大的格子，一律 down（全宽横条，title 静帧横读）；
        // board 等无 agent 常驻 shell（agentStatus=unknown）不入候选，避免被 worker 蚕食。
        const exclude = new Set(
          allPanes.filter((p) => p.tabId === plan.tabId && p.agentStatus === 'unknown').map((p) => p.paneId),
        );
        let pick: { targetPaneId: string; direction: 'right' | 'down' } | null = null;
        try {
          const snapshot = await client.exportLayout({ tabId: plan.tabId });
          const tree = snapshot?.root ? parseShapeTree(snapshot.root) : null;
          if (tree) pick = pickGridSplit(tree, { exclude });
        } catch { /* 布局导出失败 → 回退锚分裂（旧行为） */ }
        // 锚兜底：agent 已知状态的工作 pane 优先（避开 board pane）
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
        // 锚 pane 缺失（tab 已空/已关）→ 同名新 tab；main tab 消失（罕见）→ 兜底新 tab
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
    // 裸 argv → 平台 shell 语法（win32=PowerShell `&`，POSIX=sh）；引号转义在 buildLaunchLine
    // argv 构造在 buildLaunchParts（D97：默认 --tui-mode fullscreen，PI_HERDR_TUI=regular 逃生）
    return buildLaunchLine(buildLaunchParts(runtime, { resumeFile, roleModel, approve }));
  }

  /**
   * D86 信任旗标：委派即信任，但仅限 master 自己的检出与其 worktree（同 git 仓库 =
   * 同一批项目文件，master 本就载着它们跑）。外来目录不加 -a —— pi 的 Trust 对话框
   * 成为天然闸门（spawn 会在握手超时处失败，人不点头不执行未知项目扩展）。
   */
  async function approveFor(cwd: string, masterCwd: string): Promise<boolean> {
    if (isPathUnder(cwd, masterCwd)) return true;
    const zone = classifyWorktreeZone({ cwd, masterCwd, worktrees: await listWorktrees(masterCwd) });
    return zone.zone === 'worktree';
  }

  /* ── GC：turn_start 回收（v1.3 M8：tab 级为主 + pane 级兼容/孤儿路径） ── */

  let prevTurnStart = Date.now();

  async function gcPass(): Promise<void> {
    if (subs.size === 0) return;
    // D44：唯一用户可见开关——TTL 秒（默认 600）；0 = 不自动关（只由人关）
    const ttlMs = runtimePolicy.sessionTtlSeconds * 1000;
    const autoCloseTabs = ttlMs > 0;
    let panesList: Array<{ paneId: string; tabId: string; agentStatus: string }>;
    try {
      panesList = await client.listPanes();
    } catch {
      return;
    }
    // pane→herdr agentStatus 快照（pane 级回收判定用；缺项 = pane 已消失 → 补记 closed。
    // 回归修复：statuses 原本未定义——ReferenceError 被 runGcSafely 静默吞，pane 级 GC 长期失效）
    const statuses = new Map(panesList.map((p) => [p.paneId, p.agentStatus]));
    const termPaneIds = terminalState.activePaneIds();
    // B2：结算通知未送达的 pane 豁免（先送达再回收）——pD/pC 实证被 GC 抢关。
    const pendingNoticeIds = d.noticePending?.() ?? new Set<string>();

    // 任务 tab 分组（含 closed 条目：closed 工作 pane 也算完成）
    const byTab = new Map<string, SubEntry[]>();
    for (const e of subs.values()) {
      if (!e.tabId) continue;
      const arr = byTab.get(e.tabId) ?? [];
      arr.push(e);
      byTab.set(e.tabId, arr);
    }
    const taskTabIds = new Set(byTab.keys());
    // D86 R4：main tab（master 所在）永不整关——它的 consumed 子代理走 pane 级回收
    const mainTabId = env?.tabId ?? '';

    // 1) tab 级（判定规则在 gc-core.shouldCloseTaskTab，纯函数单测覆盖）
    for (const [tabId, entries] of byTab) {
      if (tabId === mainTabId) continue; // D86 R4：main tab 豁免（防 master 连坐）
      const tabPanes = panesList.filter((p) => p.tabId === tabId);
      if (tabPanes.length === 0) {
        // tab 已消失（人关/自动关）→ 补记 closed
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
      // B2：结算通知未送达的 pane 豁免（先送达再回收）
      if (tabPanes.some((p) => termPaneIds.has(p.paneId) || pendingNoticeIds.has(p.paneId))) continue;
      try {
        await client.tabClose(tabId);
      } catch {
        /* tab 已消失 */
      }
      for (const e of entries) {
        if (e.status !== 'closed') {
          e.status = 'closed';
          writeHistory(e, { status: 'closed', closedAt: Date.now() }, 'gc');
        }
      }
      await new Promise((r) => setTimeout(r, 300)); // 串行关闭（#1358 同类风险护栏）
    }

    // 2) pane 级（v1.2 兼容路径 + 孤儿 + D86 main tab 回收）：
    //    不属于任何「可整关任务 tab」的 consumed 短 pane（main tab 也算——R4）
    const closableTaskTabIds = new Set([...taskTabIds].filter((t) => t !== mainTabId));
    const candidates = [...subs.values()].filter(
      (e) => e.status === 'consumed' && !(e.tabId && closableTaskTabIds.has(e.tabId)),
    );
    for (const e of candidates) {
      if (termPaneIds.has(e.paneId) || pendingNoticeIds.has(e.paneId)) continue; // 活跃终端（D71）/未送达通知（B2）豁免
      if (!shouldClosePane({
        consumedAt: e.consumedAt ?? null,
        herdrStatus: statuses.get(e.paneId),
        prevTurnStart,
      })) continue;
      if (statuses.get(e.paneId) === undefined) {
        // pane 已消失（随 tab 被关）→ 补记 closed
        e.status = 'closed';
        writeHistory(e, { status: 'closed', closedAt: Date.now() }, 'gc');
        continue;
      }
      try {
        await client.closePane(e.paneId);
      } catch {
        /* pane 已消失 */
      }
      e.status = 'closed';
      writeHistory(e, { status: 'closed', closedAt: Date.now() }, 'gc');
      await new Promise((r) => setTimeout(r, 300));
    }
    persistSubs();
  }

  /* ── D98：isolate worktree 条件自动回收（gcPass 尾挂；master-only 已由挂载门保证） ── */

  /**
   * 候选 = ① subs 中 isolate && !releasedAt && status!=='running' 的 entry
   *      + ② 孤儿：refs/heads/pier/* 分支在 `git worktree list --porcelain`
   *        中仍有对应 wt（master 重启后注册表不含旧 entry，靠 ② 兜崩溃残留）。
   * 判定：merged = merge-base --is-ancestor；dirty = wt 下 status --porcelain。
   * release：不带 --force（git 自带 dirty 拒绝，双保险）；失败 2s 重试一次，
   * 再失败保留待下轮 ticker（无通知轰炸）。retain：注册 entry 一次性通知，
   * 孤儿静默（git worktree list 可见）。分支永不自动删除。
   */
  async function isolateSweep(): Promise<void> {
    const trace = process.env.PI_HERDR_TRACE
      ? (msg: string) => { try { appendFileSync(process.env.PI_HERDR_TRACE!, `d98sweep ${Date.now()} ${msg}\n`); } catch { /* 尽力 */ } }
      : null;
    const masterCwd = process.cwd();
    // 候选键：分支短名。注册分支全集先行（含 running/released——孤儿扫描要排除它们，
    // 否则新建未结算的 isolate 分支（=HEAD 祖先 + 干净）会被孤儿路径误回收）。
    const registeredBranches = new Set<string>();
    for (const e of subs.values()) {
      if (e.isolate) registeredBranches.add(e.isolate.branch);
    }
    // ② 孤儿候选：pier/* 分支 ↔ porcelain worktree 配对（master 重启后注册表
    // 不含旧 entry 的崩溃残留兜底）；注册分支一律走 ① 语义。
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
    // ① 注册候选（running/released 除外；同分支多代 → 取最新 entry）
    for (const e of subs.values()) {
      if (!e.isolate || e.isolate.releasedAt != null || e.status === 'running') continue;
      const prev = byBranch.get(e.isolate.branch);
      byBranch.set(e.isolate.branch, { branch: e.isolate.branch, wtPath: prev?.wtPath ?? e.isolate.worktreePath, entry: e });
    }
    trace?.(`cands=${[...byBranch.keys()].join(',') || 'none'} subs=${[...subs.values()].map((s) => `${s.status}${s.isolate ? '/iso' : ''}`).join(',') || 'none'}`);
    let persisted = false;
    for (const cand of byBranch.values()) {
      const { branch, wtPath, entry } = cand;
      // 注册 entry 的 wt 已不在 git 登记中（人工 remove/prune，或 worktree remove 被
      // Windows 文件锁半途打断——git 先注销、目录残留）→ 物理清除残留后才闭账
      //（分支照旧保留；rm 失败（锁未释放）→ 不闭账，下轮 ticker 再试）。
      if (entry && !wtByBranch.has(branch)) {
        if (existsSync(wtPath)) {
          try { rmSync(wtPath, { recursive: true, force: true }); } catch { continue; /* 锁未释放 → 下轮 */ }
          if (existsSync(wtPath)) continue;
        }
        entry.isolate!.releasedAt = Date.now();
        persisted = true;
        continue;
      }
      const mergedOut = await runGit(masterCwd, ['merge-base', '--is-ancestor', branch, 'HEAD']);
      const merged = mergedOut !== null ? true : null; // is-ancestor：exit 0=是，非 0/null=否/未知
      // 精确区分「确证非祖先」与「命令失败」：失败时 merged=null（retain-unknown）
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
          ok = (await runGit(masterCwd, ['worktree', 'remove', wtPath])) !== null; // 重试一次
        }
        if (ok) {
          worktreesCache = null; // 让放置分类立即看到 wt 消失
          if (entry) { entry.isolate!.releasedAt = Date.now(); persisted = true; }
        } // 仍失败 → 保留，下轮 ticker 重试（无通知轰炸）
      } else if (entry && !entry.isolate!.retainNotified) {
        entry.isolate!.retainNotified = true;
        persisted = true;
        try {
          await injectNotice(`worktree ${branch} retained (${decision.reason}) — merge it (git merge --no-ff ${branch}) or remove manually (git worktree remove --force ${wtPath})`);
        } catch {
          /* 注入失败静默（retainNotified 已置，避免轰炸；下轮 list_agents/台账可见） */
        }
      } // 孤儿 retain → 静默
    }
    if (persisted) persistSubs();
  }

  /** GC 互斥 + 双驱动：turn_start 与周期 ticker。 */
  let gcRunning = false;
  async function runGcSafely(): Promise<void> {
    if (gcRunning) return;
    gcRunning = true;
    try {
      await gcPass();
    } catch {
      /* GC 失败静默，下轮/tick 重试 */
    }
    // D98：isolate 回收不进 gcPass（其 subs 空 early-return 会吞掉孤儿扫描）；
    // 独立 try——tab/pane GC 失败不阻断 worktree 回收，反之亦然。
    try {
      await isolateSweep();
    } catch {
      /* sweep 失败静默，下轮/tick 重试 */
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
  // GC ticker 经 effect 拆（hmr 重载本模块 = 旧 ticker 拆、新 ticker 起，D80⑤ 语义）。
  // 注意：pipe server 的关闭 effect **不在这里**——server 由 index common 段创建持有，
  // 挂进本插件会被 hmr 重载误杀（跨属资源，d87 修）。
  ctx.effect(() => () => {
    if (gcTicker) clearInterval(gcTicker);
  }, 'gc-ticker');

  /**
   * D94：查找已存在的同 session pane（resume 复用而非重复 spawn）。
   * 返回 paneId + tabId，若无匹配或 agent 已死则 null。
   */
  async function findExistingPaneWithSession(sessionFile: string | null): Promise<{ paneId: string; tabId: string } | null> {
    if (!sessionFile) return null;
    try {
      const agents = await client.listAgents();
      const match = agents.find((a) => a.session === sessionFile && a.status !== 'unknown');
      if (!match) return null;
      // listAgents 不带 tabId，需要 pane.list 补
      const panes = await client.listPanes();
      const pane = panes.find((p) => p.paneId === match.paneId);
      return pane ? { paneId: match.paneId, tabId: pane.tabId } : null;
    } catch {
      return null;
    }
  }

  /** 复活已关闭任务（resume 工具与 send_message 自动复活共用）。 */
  async function reviveEntry(entry: SubEntry): Promise<SubEntry> {
    // D98：已回收的 isolate worktree 不复活（目录已删，cwd 无效）
    if (entry.isolate?.releasedAt != null) {
      throw new Error(`isolate worktree ${entry.isolate.branch} was released (merged) — delegate a new subagent instead`);
    }
    const latest = latestGeneration(readHistory(histFile(entry.cwd)), entry.taskId) ?? entry;
    const resumeFile = latest.sessionFile && /\.jsonl$/.test(latest.sessionFile) ? latest.sessionFile : null;
    // D86 信任旗标同 spawn：master 检出/worktree 才 -a（revive 无 toolCtx，用进程 cwd 代 master 检出）
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
      // taskId 上移（原 spawn 段）：isolate 规划需要 taskHex；纯移动，无行为耦合。
      const taskId = randomUUID();
      // D98 2c：isolate 创建块——pier execFile git 创建托管 worktree（决策 1，非 herdr
      // socket worktree.create：bootstrap 竞态 / root_pane 无 env / worker 散离 master
      // workspace / linked_worktree_source 拒绝四因）。判定归模型（不自动推断）。
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
          mkdirSync(dirname(wtPath), { recursive: true }); // git worktree add 不建父目录（首跑 worktree 基目录不存在即失败）
        } catch { /* 目录已存在/无权限 → worktree add 的报错兜底 */ }
        // 竞态护栏：worktree add → subs.set 之间（就绪等待 2-3s）ticker 的孤儿扫描
        // 会把「=HEAD 祖先 + 干净」的新 wt 当孤儿回收——pending 集先行排除（活体实证）。
        pendingIsolateBranches.add(plan.branch);
        const added = await runGit(masterCwd, ['worktree', 'add', '-b', plan.branch, wtPath, sha]);
        if (added === null) {
          pendingIsolateBranches.delete(plan.branch);
          return {
            content: [{ type: 'text', text: `Error: failed to create worktree ${wtPath} (branch ${plan.branch}) — run \`git worktree prune\` and retry if it reports stale entries` }],
            details: {},
          };
        }
        worktreesCache = null; // 失效 5s 缓存，让下方 zone 分类立即看到新 wt
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
      // D86 R1：分组键 = cwd 所属 git worktree（主检出 → main tab；其他 worktree → 目录名 tab）
      const zone = classifyWorktreeZone({
        cwd,
        masterCwd,
        worktrees: await listWorktrees(masterCwd),
      });
      // D86 信任旗标：master 自己的检出/worktree 才 -a；外来目录留 Trust 对话框作闸门
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
        // WS-D10：按角色路由模型；省略 = 进程默认
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
        // M11（D45/D46）：注入走扩展管道 → 子扩展 sendUserMessage(followUp)；
        // PTY 键盘通道 100% 归人（无软锁窗口、无混行）。
        // 回归修复（session 01a03bf0 实证）：ecc0bc4 重写前台等待时误删本块——
        // prompt 永不注入 + injectTs 未定义（ReferenceError → spawn-failed，
        // 台账留幽灵 running 条目）。任何后续重构不得把注入与 injectTs 拆开。
        const injectTs = Date.now();
        const injected = await pipeRequest(pipeNameFor(cwd, paneId), {
          type: 'prompt',
          id: `prompt-${taskId}`,
          text: spec.prompt,
          from: pipeNameFor(cwd, env?.paneId ?? ''),
          push: background,
        });
        if (injected.type !== 'ok') {
          throw new Error(`pipe prompt rejected: ${injected.type === 'error' ? injected.message : 'unknown response'}`);
        }
        lastMachineInjectAt.set(paneId, injectTs); // B4：观察窗内 working 归因判据
        // A1+A2（用户实证修复）：前台等待 = 内容闸 + 耐心阈值转后台。
        // 旧实现的 idle 即结算 + 90s 硬窗口在真实任务（working 期 4-6 分钟）上必然误判
        // no-output（实测：3 个健康子代理 101s 时被同时 consumed，成果 4 分钟后才产出）。
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
        // 回归修复（session 01a03bf0）：spawn 中途失败必须回收台账 + 关 pane——
        // 否则幽灵 running 条目永不结算 → D96 提醒风暴 + send_message 打到
        // 无任务上下文的空会话。pane 关闭尽力而为（board pane 例外场景由 GC 兜底）。
        if (paneId) {
          subs.delete(paneId);
          persistSubs();
          void client.closePane(paneId).catch(() => { /* 尽力而为 */ });
        }
        // D98 2d：isolate 从未就绪 → 尽力回收刚建的 worktree + 新分支（无工作成果，
        // 可删；失败静默——分支留着无害，git worktree list 可见）。
        if (isolateMeta) {
          void runGit(masterCwd, ['worktree', 'remove', '--force', isolateMeta.worktreePath])
            .then(() => runGit(masterCwd, ['branch', '-D', isolateMeta!.branch]))
            .catch(() => { /* 尽力而为 */ });
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
        if (isolateMeta) pendingIsolateBranches.delete(isolateMeta.branch); // D98：创建窗护栏解除（成功/失败全路径）
      }
    },
  });

  /* ── 工具：resume_subagent（历史复活，v1.2） ── */

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
        // D94：复用已存在的同 session pane（避免双 pi 冲突）
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
        // 无现成 pane，才创建新的
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

  /* ── 工具：list_agents（仅后台/常驻子代理；前台短 pane 是瞬态 UI） ── */

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
      // 按 taskId 去重：只显示每任务的最新代（复活后旧 paneId 不重复出现）
      const byTask = new Map<string, SubEntry>();
      for (const sub of listed) {
        const prev = byTask.get(sub.taskId);
        if (!prev || sub.createdAt >= prev.createdAt) byTask.set(sub.taskId, sub);
      }
      // C1：实时探活（pane 状态 + 会话活动时间）——master 能区分"在干活"vs"真卡死"
      const probes = new Map<string, AliveProbe>();
      await Promise.all([...byTask.values()].map(async (sub) => {
        if (sub.status === 'closed') return;
        try { probes.set(sub.paneId, await probeAlive(sub.paneId, sub.cwd)); } catch { /* 显示层尽力 */ }
      }));
      const lines: string[] = [];
      for (const sub of byTask.values()) {
        const tabTag = sub.tabName ? ` [tab: ${sub.tabName}]` : '';
        // D98：isolate 条目附 worktree 分支（closed 同样带；不现算 merged——结算 stat 行已覆盖）
        const wtTag = sub.isolate ? ` [wt: ${sub.isolate.branch}]` : '';
        if (sub.status === 'closed') {
          lines.push(`${sub.taskId.slice(0, 8)} [idle] (${sub.kind}, closed; send_message revives)${tabTag}${wtTag} ${sub.description}`);
          continue;
        }
        // 注册表状态即权威：settled = idle，其余 = running（含 blocked 人类闸门，对齐 DSH 映射）
        const state = sub.status === 'settled' ? 'idle' : 'running';
        // D94：用户接管标记
        const takeoverMark = sub.userTakeover ? ', user-controlled' : '';
        const probe = probes.get(sub.paneId);
        const statusTag = probe?.agentStatus ? ` ${probe.agentStatus}` : '';
        const activityTag = probe?.lastActivityMs != null ? `, active ${agoText(probe.lastActivityMs, Date.now())}` : '';
        // E：blocked 时附上闸门问题摘要（提示 master 该叫用户去 pane，不是自己接手）
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

  /* ── 工具：send_message（steer 间隙投递） ── */

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
        // 已关闭 → 自动复活（任务级可继续：pane 是临时宿主）
        if (entry.status === 'closed') {
          await reviveEntry(entry);
          subs.set(entry.paneId, entry);
          persistSubs();
        }
        // M11（D46）：follow_up 走扩展管道。B3：带 steer——worker 长跑中途的补充
        // 指令在 tool-call 间隙秒级到达（旧 followUp 队列语义 = 整个 run 结束才投，
        // 01a03c0d 实证 20min 延迟致 worker 按旧契约返工）。
        const ready = await waitSubReady(entry.cwd, entry.paneId);
        if (!ready) throw new Error(`subagent pane ${entry.paneId} pipe not ready`);
        const fuId = `fu-${Date.now()}`;
        const res = await pipeRequest(pipeNameFor(entry.cwd, entry.paneId), {
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
        lastMachineInjectAt.set(entry.paneId, Date.now()); // B4：观察窗内 working 归因判据
        // 回归加固（D98 活体实证）：status='running' 与 startPoller 之间任何抛错都会
        // 留下「running 且无 poller」的幽灵条目（永不结算、GC 跳过）——失败回滚原状态。
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

  /* ── 工具：interrupt_agent（D48：管道 → 子扩展 ctx.abort() 进程内中止） ── */

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
        // DSH 对齐：空闲/已结束目标是幂等 no-op
        return { content: [{ type: 'text', text: `Interrupt accepted for subagent ${entry.paneId} (already idle/closed; no-op).` }], details: {} };
      }
      try {
        const res = await pipeRequest(pipeNameFor(entry.cwd, entry.paneId), {
          type: 'interrupt',
          id: `int-${Date.now()}`,
        });
        if (res.type !== 'ok') {
          throw new Error(`pipe interrupt rejected: ${res.type === 'error' ? res.message : 'unknown response'}`);
        }
        // 被中断的轮次不结算通知（请求方已知情）
        const lastId = lastRequestIdByPane.get(entry.paneId);
        if (lastId) d.claimSettleNotice(`${entry.paneId}:${lastId}`);
        return { content: [{ type: 'text', text: `Interrupt accepted for subagent ${entry.paneId} (fire-and-return).` }], details: { paneId: entry.paneId } };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: failed to reach subagent ${entry.paneId}: ${(err as Error).message}` }], details: {} };
      }
    },
  });
}
