/**
 * subagent 纯逻辑：子 pane 命令构造、并发信号量、注册表、进度回调。
 * 无副作用、无 pi/herdr API 依赖 → 可单测。
 *
 * v1.1（DESIGN.md §12，方案 C）：子 pane 统一为交互式 pi TUI。
 *  - 启动：常驻 shell 里 `node cli.js -e <本扩展>`（Windows 经 powershell 包裹、
 *    POSIX 直启；无 prompt 参数，prompt 经扩展管道注入），herdr 自动检测 +
 *    本扩展上报状态；
 *  - 并发上限 4（D10）：信号量压制并行 spawn；
 *  - 结果通道 = 子会话 JSONL（session-tail.ts），不再解析 pane 文本；
 *  - 软锁：仅在 herdr agent_status ∈ {idle} 时注入（index.ts 的状态门）。
 */
import { normalizeEntryKind } from './history-store.ts';

export interface SubagentSpec {
  description: string;
  prompt: string;
}

/** PowerShell 单引号转义（''）。 */
export function psQuote(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/** POSIX sh 单引号转义（'\''）。 */
export function shQuote(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * 子代理启动命令行（注入子 pane 的 shell，经 pane.send_text + CR 提交）。
 * 片段 = 裸 argv 词（如 ['pi', '--session', '<file>']）；win32 输出 PowerShell
 * 调用语法（`&` 引导 + `''` 转义），其余输出 POSIX sh 语法（单引号 + `'\''` 转义）。
 */
export function buildLaunchLine(parts: readonly string[], platform: NodeJS.Platform = process.platform): string {
  const quoted = platform === 'win32'
    ? parts.map((s) => psQuote(s))
    : parts.map((s) => shQuote(s));
  return (platform === 'win32' ? '& ' : '') + quoted.join(' ');
}

/** 计数信号量：并发上限内的 acquire 立即执行，超出排队（FIFO）。 */
export class Semaphore {
  private active = 0;
  private queue: Array<() => void> = [];
  private readonly cap: number;

  constructor(cap: number) {
    if (cap < 1) throw new Error('semaphore cap must be >= 1');
    this.cap = cap;
  }

  get activeCount(): number {
    return this.active;
  }

  acquire(): Promise<() => void> {
    if (this.active < this.cap) {
      this.active++;
      return Promise.resolve(this.release.bind(this));
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.active++;
        resolve(this.release.bind(this));
      });
    });
  }

  private release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

export interface SubagentOutcome {
  kind: 'completed' | 'timeout' | 'no-output' | 'blocked' | 'spawn-failed';
  /** 最终文本（completed 时为子代理最终回答；timeout/blocked 时为部分输出）。 */
  text: string;
}

/** 把提取结果规范为工具返回文本。 */
export function formatSubagentResult(outcome: SubagentOutcome, description: string): string {
  switch (outcome.kind) {
    case 'completed': {
      const text = outcome.text;
      return text ? text : 'Subagent finished but produced no output.';
    }
    case 'timeout':
      return `Error: subagent "${description}" timed out. Partial output:\n${outcome.text || '(none)'}`;
    case 'blocked':
      return `Subagent "${description}" is blocked in its pane and needs a human decision. Partial output:\n${outcome.text || '(none)'}`;
    case 'no-output':
      return `Error: subagent "${description}" produced no readable output.`;
    case 'spawn-failed':
      return `Error: failed to spawn subagent "${description}": ${outcome.text}`;
  }
}

/* ── 探活 + 存活通知（A2/B1 统一出口；纯逻辑，IO 在 adapter） ────── */

/** 探活快照：pane 实时状态 + 会话活动时间（毫秒 epoch；null = 未知）。 */
export interface AliveProbe {
  paneExists: boolean;
  agentStatus: string | null;
  /** 会话文件 mtime（最新候选）；无文件/不可读 = null。 */
  lastActivityMs: number | null;
}

/** 探活判活：pane 在 +（working/blocked 或近期有会话活动）→ 视为还在干活。 */
export function isAlive(probe: AliveProbe, nowMs: number, staleAfterMs = 120_000): boolean {
  if (!probe.paneExists) return false;
  if (probe.agentStatus === 'working' || probe.agentStatus === 'blocked') return true;
  // idle/unknown：会话 2 分钟内有活动仍算活（写作间隙/刚结算未采集）
  return probe.lastActivityMs != null && nowMs - probe.lastActivityMs < staleAfterMs;
}

/** 人话相对时间（"12s ago" / "3m ago"）。 */
export function agoText(ms: number, nowMs: number): string {
  const s = Math.max(0, Math.round((nowMs - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

/**
 * 存活通知（A2 转后台返回值 与 B1 tool_result 改写 的统一构造出口）：
 * 两场景同一话术——"它在干活 / 别重做 / 转后台了 / 结算会通知 / list_agents 可查"。
 * scenario: 'moved-to-bg'（耐心阈值转后台）| 'error-alive'（工具报错但探活判活，兜底改写）。
 */
export function buildAliveNotice(
  opts: { paneId: string; description: string; scenario: 'moved-to-bg' | 'error-alive'; probe: AliveProbe },
  nowMs: number,
): string {
  const { paneId, description, scenario, probe } = opts;
  const status = probe.agentStatus ?? 'unknown';
  const activity = probe.lastActivityMs != null ? `, last session activity ${agoText(probe.lastActivityMs, nowMs)}` : '';
  if (scenario === 'moved-to-bg') {
    return [
      `Subagent "${description}" is still running in pane ${paneId} (agent_status=${status}${activity}).`,
      'The foreground wait has moved it to background so this call returns now.',
      'Do NOT redo its work. When it settles you will receive a notification with its closing output.',
      'Use list_agents to check its live state; send_message to give it follow-up work.',
    ].join(' ');
  }
  return [
    `The subagent "${description}" is ALIVE in pane ${paneId} (agent_status=${status}${activity}) — this "no readable output" result only means its final answer could not be read yet, NOT that the task failed.`,
    'Do NOT redo its work. It is being moved to background; you will be notified when it settles.',
    'Use list_agents to check its live state.',
  ].join(' ');
}

/**
 * 人类闸门通知（E1/E2 统一出口）：subagent blocked（ask_user_question 等人类）时
 * 给 master 的话术——不揽活、引导用户去 pane、授权例外经 send_message 转达。
 * question 来自 herdr tokens['pi-ask']（子扩展 reportAskFlag 上报）。
 */
export function buildBlockedGateNotice(opts: { paneId: string; description: string; question: string | null }): string {
  const { paneId, description, question } = opts;
  const q = question ? ` (question: "${question}")` : '';
  return [
    `Subagent "${description}" is BLOCKED waiting for a HUMAN decision in pane ${paneId}${q}.`,
    'It keeps running in background; once the human answers it resumes, and you will be notified when it settles.',
    'Do NOT take over its work and do NOT answer on the human\'s behalf.',
    'Tell the user to open that pane in herdr and answer directly.',
    'Only if the user explicitly authorizes you: relay their decision to the subagent via send_message — do not redo the work yourself.',
  ].join(' ');
}

/* ── 子代理注册表（custom 条目持久化） ────────────────────────────── */

export const SUBS_CUSTOM_TYPE = 'pi-herdr.subs';

export interface SubEntry {
  taskId: string;
  /** 'task' 或 role 名；旧 short/resident 读盘归一为 task，不参与 GC。 */
  kind: string;
  paneId: string;
  tabId: string;
  /** v1.3：任务 tab 名（D25/D26；tab.rename 后可能漂移，仅为显示/复活参考）。 */
  tabName: string;
  cwd: string;
  description: string;
  background: boolean;
  status: 'running' | 'settled' | 'consumed' | 'closed';
  /** 消费时间（GC 宽限期判据）。 */
  consumedAt?: number | null;
  sessionFile: string | null;
  launchCommand: string[];
  createdAt: number;
  revivedFrom?: string | null;
  /** D94：用户是否接管控制（暂停 master 管理）。 */
  userTakeover?: boolean;
  /** D94：接管检测时间（ms）；settled 后进入观察期开始计时。 */
  observationStartedAt?: number | null;
  /** D94：上次 agent 状态（用于检测 idle→working 的用户介入）。 */
  lastAgentStatus?: string | null;
}

export interface SubsRegistry {
  version: 2;
  subs: SubEntry[];
}

export function makeRegistry(subs: SubEntry[] = []): SubsRegistry {
  return { version: 2, subs };
}

/**
 * 从会话分支条目折叠注册表（last-wins，与 todo 折叠同构）。
 * custom 条目形状（session-format 实测）：{type:'custom', customType, data}。
 * 兼容 v1 条目（缺字段按默认补齐：taskId=paneId、kind=task、tabId=''、launchCommand=[]）。
 */
export function foldSubsRegistry(entries: readonly BranchEntryLike2[]): SubsRegistry {
  let found = makeRegistry();
  for (const entry of entries) {
    if (entry.type !== 'custom' || entry.customType !== SUBS_CUSTOM_TYPE) continue;
    const data = entry.data as {
      subs?: Array<Partial<SubEntry> & { paneId: string }>;
    } | undefined;
    if (!data || !Array.isArray(data.subs)) continue;
    const subs: SubEntry[] = data.subs
      .filter((s) => typeof s?.paneId === 'string')
      .map((s) => ({
        taskId: typeof s.taskId === 'string' ? s.taskId : s.paneId,
        kind: normalizeEntryKind(typeof s.kind === 'string' ? s.kind : undefined),
        paneId: s.paneId,
        tabId: typeof s.tabId === 'string' ? s.tabId : '',
        tabName: typeof s.tabName === 'string' ? s.tabName : '',
        cwd: typeof s.cwd === 'string' ? s.cwd : '',
        description: typeof s.description === 'string' ? s.description : '',
        background: s.background === true,
        status: s.status === 'closed' ? 'closed' : s.status === 'consumed' ? 'consumed' : s.status === 'settled' ? 'settled' : 'running',
        consumedAt: typeof s.consumedAt === 'number' ? s.consumedAt : null,
        sessionFile: typeof s.sessionFile === 'string' ? s.sessionFile : null,
        launchCommand: Array.isArray(s.launchCommand) ? s.launchCommand : [],
        createdAt: typeof s.createdAt === 'number' ? s.createdAt : 0,
        revivedFrom: typeof s.revivedFrom === 'string' ? s.revivedFrom : null,
        userTakeover: s.userTakeover === true ? true : undefined,
        observationStartedAt: typeof s.observationStartedAt === 'number' ? s.observationStartedAt : null,
        lastAgentStatus: typeof s.lastAgentStatus === 'string' ? s.lastAgentStatus : null,
      }));
    found = { version: 2, subs };
  }
  return found;
}

export interface BranchEntryLike2 {
  type?: string;
  customType?: string;
  data?: unknown;
}

/* ── 工具进度回调 ─────────────────────────────────────────────────── */

export interface ProgressUpdate {
  content: Array<{ type: 'text'; text: string }>;
  details: Record<string, never>;
}

/**
 * 构造 onUpdate 的合法负载。
 *
 * ⚠️ pi 0.84.2 实测：AgentToolUpdateCallback 期待 AgentToolResult（{content, details}），
 * 传字符串会让交互式 TUI 在 getTextOutput 处崩溃（undefined.filter）并整个退出 pi。
 * 所有进度回调必须经本助手构造。
 */
export function makeProgressUpdate(msg: string): ProgressUpdate {
  return { content: [{ type: 'text', text: msg }], details: {} };
}

/* ── v1.3 任务 tab 放置（D25/D26 纯逻辑，可单测） ─────────────────── */

export const TAB_NAME_MAX = 20;

/** tab 名规范化：折叠空白、截断 ≤20 字符；空 → 'task'。 */
export function tabNameForTask(description: string): string {
  const cleaned = String(description ?? '').replace(/\s+/g, ' ').trim();
  const truncated = cleaned.slice(0, TAB_NAME_MAX).trim();
  return truncated || 'task';
}

/** 缺省放置撞名加序号后缀（-2、-3…），并保持总长 ≤20（D26：缺省永远开新 tab）。 */
export function nextTaskTabName(base: string, existingNames: ReadonlySet<string>): string {
  let name = base;
  let n = 2;
  while (existingNames.has(name)) {
    const suffix = `-${n}`;
    name = base.slice(0, TAB_NAME_MAX - suffix.length) + suffix;
    n++;
  }
  return name;
}

export interface TabPlacementPlan {
  /** append = 追加进既有 tab（锚 pane split）；new = 新命名 tab。 */
  mode: 'append' | 'new';
  tabName: string;
  /** append 时的既有 tabId（须调用方再校验存活）；new 时为 null。 */
  tabId: string | null;
}

/* ── D86：worktree 分组键（纯逻辑） ─────────────────────────────── */

/** 路径包含判定（大小写不敏感 + 斜杠统一；cwd === wt 或 cwd 在 wt 之下）。D86 信任旗标也用它。 */
export function isPathUnder(cwd: string, wt: string): boolean {
  const n = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const a = n(cwd);
  const b = n(wt);
  return a === b || a.startsWith(`${b}/`);
}

export interface WorktreeZone {
  /** main = 主检出（split 进 main tab）；worktree = 命名 worktree tab；非 git/无关目录也兜底 main。 */
  zone: 'main' | 'worktree';
  /** zone=worktree 时的 tab 名（目录名原样，撞名后缀由 nextTaskTabName 处理）。 */
  tabName: string | null;
}

/**
 * D86 分类器：cwd 落在哪个 worktree 分组。
 * `worktrees` = git porcelain 顺序（主检出在前，仅用于列表本身；归属判定按包含）；
 * 非 git / 不属任何 worktree → main（「无新 worktree → 同 tab」的兜底）。
 */
export function classifyWorktreeZone(opts: {
  cwd: string;
  masterCwd: string;
  worktrees: readonly string[];
}): WorktreeZone {
  for (const wt of opts.worktrees) {
    if (!isPathUnder(opts.cwd, wt)) continue;
    if (isPathUnder(opts.masterCwd, wt)) return { zone: 'main', tabName: null }; // 主检出 → main tab
    const base = wt.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? 'worktree';
    return { zone: 'worktree', tabName: base };
  }
  return { zone: 'main', tabName: null };
}

/**
 * 放置决策（D26 显式层 + D86 缺省层）：
 *  - 显式 `tab` 参数：规范名 → 已知 tab 同名则 append（用其 tabId），否则 new；
 *  - 缺省（D86）：`zone` 给出分组——main → append 进 mainTabId；worktree →
 *    join-or-create 该目录名 tab（已知同名 append，否则 new）。
 * `knownTabs` = 调用时刻的存活 tab（label, id）。
 */
export function planTabPlacement(opts: {
  desiredTab?: string | null;
  description: string;
  knownTabs: ReadonlyArray<{ tabName: string; tabId: string }>;
  /** D86 缺省分组（classifyWorktreeZone 输出；不传 = 旧 description 派生路径，兼容用）。 */
  zone?: WorktreeZone;
  /** D86 main 分组的目标 tab（master 所在 tab）。 */
  mainTabId?: string | null;
}): TabPlacementPlan {
  const known = new Map<string, string>();
  for (const t of opts.knownTabs) if (t?.tabName && t?.tabId) known.set(t.tabName, t.tabId);
  if (opts.desiredTab != null && String(opts.desiredTab).trim() !== '') {
    const tabName = tabNameForTask(String(opts.desiredTab));
    const tabId = known.get(tabName) ?? null;
    return tabId ? { mode: 'append', tabName, tabId } : { mode: 'new', tabName, tabId: null };
  }
  const zone = opts.zone;
  if (zone?.zone === 'main' && opts.mainTabId) {
    // D86 R1：主检出 → split 进 main tab（锚 pane 由调用方选）
    return { mode: 'append', tabName: 'main', tabId: opts.mainTabId };
  }
  if (zone?.zone === 'worktree' && zone.tabName) {
    // D86 R1：worktree → join-or-create 目录名 tab（原样 label，大小写不敏感撞名 join）
    const base = zone.tabName;
    const existing = [...known.keys()].find((k) => k.toLowerCase() === base.toLowerCase());
    if (existing) return { mode: 'append', tabName: existing, tabId: known.get(existing)! };
    const tabName = nextTaskTabName(base, new Set(known.keys()));
    return { mode: 'new', tabName, tabId: null };
  }
  // 兜底（无 zone 信息）：由 description 派生名 + 撞名加序号后缀 → 永远 new。
  const base = tabNameForTask(opts.description);
  const tabName = nextTaskTabName(base, new Set(known.keys()));
  return { mode: 'new', tabName, tabId: null };
}
