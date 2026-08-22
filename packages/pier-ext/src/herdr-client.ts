/**
 * herdr socket API 最小客户端（pi 扩展内使用）。
 *
 * 已对 herdr 0.8.0-preview（protocol 19, Windows named pipe）逐项实测（见 WIRE.md）：
 *  - 传输：NDJSON；请求 {id, method, params} → 响应 {id, result} | {id, error:{code,message}}；
 *  - **控制请求 = 一连接一请求**（server 应答后即关连接）；
 *  - Windows 目标 = named pipe，名称为完整 socket_path 字符串，连接时前缀 \\.\pipe\；
 *  - pane.report_agent {pane_id, source, agent, state, message?, agent_session_id?, agent_session_path?}
 *    其中 state ∈ idle|working|blocked|unknown（'done' 是 server 派生状态，客户端不报）；
 *  - pane.report_metadata {pane_id, source, title?, state_labels?, clear_title?, clear_state_labels?}
 *    M22 起只报标题投影；升级首次附带把旧 pi-herdr 分块 token 写成 null；
 *  - agent.list {} → {type:'agent_list', agents: AgentInfo[]}；
 *  - agent.wait {target, until[], timeout_ms?} → 状态命中返回 agent，超时为错误（timeout 语义）；
 *  - agent.send_keys {target, keys[]} / pane.send_text {pane_id, text}。
 *
 * v1.1（DESIGN.md §12）接口面：
 *  报告 ×3、目录、spawn、注入（send_text）、按键（send_keys）、等待（agent.wait）、会话路径查询。
 *  已删除：waitSettled（标记版）、readPaneText（pane 文本解析）、onAgentState（订阅长连接）
 *  —— 结果通道改会话 JSONL（session-tail.ts），状态等待改 server 端 agent.wait。
 *
 * 设计（DESIGN.md §4.1）：无 herdr 环境 → Noop 降级，pi 独立可用；
 * 上报类调用失败静默，绝不影响 pi 主流程。
 */
import { REPORT_AGENT_SOURCE, type TodoItem } from './vocab.ts';
import { BLOCKED_LABEL_KEY, SIDEBAR_ASK_TOKEN, formatBlockedLabel, formatPaneTitle, sidebarTodoTokens, staleTokenClearance } from './pane-title.ts';
import { LOCK_BATCH_LIMIT, LOCK_TTL_MS } from './lock-core.ts';
import * as net from 'node:net';

/* ── 类型 ──────────────────────────────────────────────────────────── */

/** herdr agent 语义状态（schema 实测五态；'done' 为 server 派生）。 */
export type HerdrAgentState = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

export interface HerdrEnv {
  socketPath: string;
  paneId: string;
  workspaceId: string;
  tabId: string;
}

/** report_agent 可上报的状态（'done' 由 server 派生）。 */
export type PaneAgentState = 'idle' | 'working' | 'blocked' | 'unknown';

export interface AgentInfo {
  paneId: string;
  agent: string | null;
  status: HerdrAgentState;
  /** agent_session.value（session id 或路径），供恢复/跳转。 */
  session: string | null;
  stateLabels: Record<string, string>;
  tokens: Record<string, string | null>;
}

/** TabInfo 投影（schema 实测：tab_id/workspace_id/number/label/focused/pane_count/agent_status）。 */
export interface TabInfo {
  tabId: string;
  workspaceId: string;
  label: string;
  paneCount: number;
  agentStatus: string;
}

export function detectHerdrEnv(env: NodeJS.ProcessEnv = process.env): HerdrEnv | null {
  if (env.HERDR_ENV !== '1') return null;
  const socketPath = env.HERDR_SOCKET_PATH;
  const paneId = env.HERDR_PANE_ID;
  if (!socketPath || !paneId) return null;
  return {
    socketPath,
    paneId,
    workspaceId: env.HERDR_WORKSPACE_ID ?? '',
    tabId: env.HERDR_TAB_ID ?? '',
  };
}

export interface HerdrClientLike {
  readonly available: boolean;
  reportAgent(state: PaneAgentState, message: string | null): Promise<void>;
  reportAgentSession(sessionPath: string | null): Promise<void>;
  reportMetadata(meta: { session: string; items: TodoItem[]; progressSuffix?: string | null }): Promise<void>;
  /** M18：写锁 token 上报（键 lock-<hash>，值 paneId|path；null = 释放；≤16 键/批自动分批）。 */
  reportLockTokens(tokens: Record<string, string | null>): Promise<void>;
  /**
   * D93：侧边栏 agent 显示名（display_agent = role 名）。
   * 一次上报持续生效（无 TTL）；null = 清除回检测值。尽力而为。
   */
  reportDisplayAgent(name: string | null): Promise<void>;
  /**
   * D95：ask_user_question 等待标志（tokens['pi-ask']；null 清空）。
   * 侧边栏/热力分级用：blocked + pi-ask = 人类闸门（ask 级），纯 blocked = block 级。
   */
  reportAskFlag(text: string | null): Promise<void>;
  listAgents(): Promise<AgentInfo[]>;
  /** 在新 tab 里以 argv 启动子 pane（layout.apply），返回 pane/tab id。 */
  spawnSubPane(opts: { label: string; command: string[]; cwd: string; env?: Record<string, string> }): Promise<{ tabId: string; paneId: string }>;
  /** 向 pane 终端注入文本（pi 编辑器输入 + Enter；send_text+CR 实测可直达；仅用于 launchLine 起进程）。 */
  sendPaneText(paneId: string, text: string): Promise<void>;
  /** server 端等待 agent 状态；命中返回状态，超时返回 null，错误抛出。 */
  waitAgent(paneId: string, until: HerdrAgentState[], timeoutMs: number): Promise<HerdrAgentState | null>;
  /** 查询子代理上报的会话路径（agent_session.value，kind=path）；无则 null。 */
  getAgentSessionPath(paneId: string): Promise<string | null>;
  /** v1.2：聚焦 pane（组 tab 追加的前置）。 */
  focusPane(paneId: string): Promise<void>;
  /** v1.2：在当前 tab 拆分出新 shell pane（focus 后调用，落组 tab）。返回新 paneId。 */
  splitPane(opts: { direction?: 'left' | 'right' | 'up' | 'down'; cwd?: string; env?: Record<string, string>; targetPaneId?: string }): Promise<string>;
  /** v1.2：关闭 pane（实测杀进程树；空 tab 由 herdr 自动关）。 */
  closePane(paneId: string): Promise<void>;
  /** v1.2：创建 tab（含根 shell pane），返回 tabId/paneId（组 tab 基础设施）。 */
  createTab(opts: { workspaceId: string; label?: string; cwd?: string; env?: Record<string, string> }): Promise<{ tabId: string; paneId: string }>;
  /** v1.2：列出全部 pane（含 tab 归属；组 tab 追加用）。 */
  listPanes(): Promise<Array<{ paneId: string; tabId: string; workspaceId: string; agentStatus: string }>>;
  /** D91：导出 tab 布局树（layout.export；paneId/tabId 二选一定位）。尽力而为：失败返回 null。 */
  exportLayout(opts: { paneId?: string; tabId?: string }): Promise<{ tabId: string | null; zoomed: boolean; root: unknown } | null>;
  /** v1.3：列出 tab（tab.list → {type:'tab_list', tabs:[TabInfo]}，schema 实测）。 */
  tabList(): Promise<TabInfo[]>;
  /** v1.3：查 tab 详情（tab.get → {type:'tab_info', tab}）；不存在返回 null。 */
  tabGet(tabId: string): Promise<TabInfo | null>;
  /** v1.3：关闭 tab（tab.close → {type:'tab_closed', ...}；级联关闭其 pane）。 */
  tabClose(tabId: string): Promise<void>;
  /** M14：发送按键组合（pane.send_keys；Herdr key-combo：ctrl+c / enter / esc …）。 */
  sendPaneKeys(paneId: string, keys: string[]): Promise<void>;
  /** M14：读 pane 输出缓冲（pane.read；source=recent 近期缓冲，strip_ansi=false 保留 T6 检测原料）。 */
  readPane(paneId: string, opts?: {
    source?: 'visible' | 'recent' | 'recent_unwrapped';
    lines?: number;
    stripAnsi?: boolean;
  }): Promise<{ text: string; revision: number; truncated: boolean }>;
  /** M14：等输出匹配（pane.wait_for_output；substring/regex）。超时返回 null，错误抛出。 */
  waitForOutput(paneId: string, match: { type: 'substring' | 'regex'; value: string }, timeoutMs: number): Promise<boolean | null>;
  close(): void;
}

/** 深度优先在响应对象里找第一个字符串字段（herdr 信封形状多样，id 位置不一）。 */
function findIdIn(obj: unknown, key: string, depth = 0): string | null {
  if (!obj || depth > 6) return null;
  if (typeof obj === 'object') {
    const v = (obj as Record<string, unknown>)[key];
    if (typeof v === 'string') return v;
    for (const child of Object.values(obj as Record<string, unknown>)) {
      const r = findIdIn(child, key, depth + 1);
      if (r) return r;
    }
  }
  return null;
}

/* ── Noop ──────────────────────────────────────────────────────────── */

export class NoopHerdrClient implements HerdrClientLike {
  readonly available = false;
  async reportAgent(): Promise<void> {}
  async reportAgentSession(): Promise<void> {}
  async reportMetadata(): Promise<void> {}
  async reportLockTokens(): Promise<void> {}
  async reportDisplayAgent(): Promise<void> {}
  async reportAskFlag(): Promise<void> {}
  async listAgents(): Promise<AgentInfo[]> {
    return [];
  }
  async spawnSubPane(): Promise<{ tabId: string; paneId: string }> {
    throw new Error('subagent requires a herdr-managed pane');
  }
  async sendPaneText(): Promise<void> {}
  async waitAgent(): Promise<null> {
    return null;
  }
  async getAgentSessionPath(): Promise<null> {
    return null;
  }
  async focusPane(): Promise<void> {}
  async splitPane(): Promise<string> {
    throw new Error('subagent requires a herdr-managed pane');
  }
  async closePane(): Promise<void> {}
  async createTab(): Promise<{ tabId: string; paneId: string }> {
    throw new Error('subagent requires a herdr-managed pane');
  }
  async listPanes(): Promise<Array<{ paneId: string; tabId: string; workspaceId: string; agentStatus: string }>> {
    return [];
  }
  async exportLayout(): Promise<null> {
    return null;
  }
  async tabList(): Promise<TabInfo[]> {
    return [];
  }
  async tabGet(): Promise<TabInfo | null> {
    return null;
  }
  async tabClose(): Promise<void> {}
  async sendPaneKeys(): Promise<void> {}
  async readPane(): Promise<{ text: string; revision: number; truncated: boolean }> {
    return { text: '', revision: 0, truncated: false };
  }
  async waitForOutput(): Promise<boolean | null> {
    return null;
  }
  close(): void {}
}

/* ── 实现 ──────────────────────────────────────────────────────────── */

export class HerdrClient implements HerdrClientLike {
  readonly available = true;
  private clearedStaleTokens = false;

  constructor(private readonly env: HerdrEnv) {}

  private target(): string {
    const p = this.env.socketPath;
    if (process.platform !== 'win32') return p;
    return p.startsWith('\\\\.\\pipe\\') ? p : `\\\\.\\pipe\\${p}`;
  }

  /**
   * 控制请求：一连接一请求（server 应答后关连接，实测协议行为）。
   * 读满一行响应即完成；响应是 {id, result} | {id, error}。
   */
  private request(method: string, params: Record<string, unknown>, timeoutMs = 15000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(this.target());
      sock.setEncoding('utf8');
      let buf = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          sock.destroy();
          reject(new Error(`herdr ${method}: timeout`));
        }
      }, timeoutMs);
      sock.on('connect', () => {
        sock.write(JSON.stringify({ id: '1', method, params }) + '\n', (err) => {
          if (err && !settled) {
            settled = true;
            clearTimeout(timer);
            reject(err);
          }
        });
      });
      sock.on('data', (chunk) => {
        buf += chunk;
        const idx = buf.indexOf('\n');
        if (idx < 0) return;
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        sock.destroy();
        let msg: { id?: string; result?: unknown; error?: { code?: string; message?: string } };
        try {
          msg = JSON.parse(buf.slice(0, idx).trim());
        } catch {
          reject(new Error(`herdr ${method}: bad frame`));
          return;
        }
        if (msg.error) reject(new Error(`${msg.error.code ?? 'error'}: ${msg.error.message ?? ''}`));
        else resolve(msg.result);
      });
      sock.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
      sock.on('close', () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`herdr ${method}: connection closed`));
        }
      });
    });
  }

  /* ── 上报类（失败静默：工作台镜像尽力而为，绝不影响 pi 主流程） ── */

  async reportAgent(state: PaneAgentState, message: string | null): Promise<void> {
    try {
      await this.request('pane.report_agent', {
        pane_id: this.env.paneId,
        source: REPORT_AGENT_SOURCE,
        agent: 'pi',
        state,
        ...(message ? { message } : {}),
      });
    } catch {
      /* 静默 */
    }
  }

  async reportAgentSession(sessionPath: string | null): Promise<void> {
    if (!sessionPath) return;
    try {
      await this.request('pane.report_agent_session', {
        pane_id: this.env.paneId,
        source: REPORT_AGENT_SOURCE,
        agent: 'pi',
        agent_session_path: sessionPath,
      });
    } catch {
      /* 静默 */
    }
  }

  async reportMetadata(meta: { session: string; items: TodoItem[]; progressSuffix?: string | null }): Promise<void> {
    try {
      void meta.session;
      const title = formatPaneTitle(meta.items, null, { progressSuffix: meta.progressSuffix });
      const blocked = formatBlockedLabel(meta.items);
      // D96：stale 清理与日常上报分离——stale(16) + pi-todo(1) = 17 > herdr tokens max=16
      // → 整个请求被拒 → title/tokens 全丢（D93 回归根因）。stale 单独批次，成功后才置位。
      if (!this.clearedStaleTokens) {
        await this.request('pane.report_metadata', {
          pane_id: this.env.paneId,
          source: REPORT_AGENT_SOURCE,
          tokens: staleTokenClearance(),
          ttl_ms: 86400000,
        });
        this.clearedStaleTokens = true;
      }
      await this.request('pane.report_metadata', {
        pane_id: this.env.paneId,
        source: REPORT_AGENT_SOURCE,
        ...(title ? { title } : { clear_title: true }),
        ...(blocked
          ? { state_labels: { [BLOCKED_LABEL_KEY]: blocked } }
          : { clear_state_labels: true }),
        // D93：todo 摘要进 custom token（空串 = 清键，无 todo 不留旧摘要）
        tokens: sidebarTodoTokens(title),
        ttl_ms: 86400000,
      });
    } catch {
      /* 静默：标题投影尽力而为，绝不影响 pi 主流程 */
    }
  }

  async reportLockTokens(tokens: Record<string, string | null>): Promise<void> {
    const keys = Object.keys(tokens);
    if (keys.length === 0) return;
    try {
      // schema maxProperties=16 → 分批（每批独立请求，全部尽力而为）
      for (let i = 0; i < keys.length; i += LOCK_BATCH_LIMIT) {
        const batch: Record<string, string | null> = {};
        for (const k of keys.slice(i, i + LOCK_BATCH_LIMIT)) batch[k] = tokens[k];
        await this.request('pane.report_metadata', {
          pane_id: this.env.paneId,
          source: REPORT_AGENT_SOURCE,
          tokens: batch,
          ttl_ms: LOCK_TTL_MS,
        });
      }
    } catch {
      /* 锁登记尽力而为（软 veto 下失败 = 少一次警告，不阻断） */
    }
  }

  async reportDisplayAgent(name: string | null): Promise<void> {
    try {
      await this.request('pane.report_metadata', {
        pane_id: this.env.paneId,
        source: REPORT_AGENT_SOURCE,
        ...(name ? { display_agent: name } : { clear_display_agent: true }),
      });
    } catch {
      /* 静默：侧边栏标识尽力而为 */
    }
  }

  async reportAskFlag(text: string | null): Promise<void> {
    try {
      await this.request('pane.report_metadata', {
        pane_id: this.env.paneId,
        source: REPORT_AGENT_SOURCE,
        tokens: { [SIDEBAR_ASK_TOKEN]: text ?? '' },
        ttl_ms: 86400000,
      });
    } catch {
      /* 静默：人类闸门标志尽力而为 */
    }
  }

  /* ── 查询与控制 ───────────────────────────────────────────────────── */

  async listAgents(): Promise<AgentInfo[]> {
    const result = (await this.request('agent.list', {})) as {
      type?: string;
      agents?: Array<Record<string, unknown>>;
    } | null;
    const arr = result?.agents ?? [];
    return arr.map((a) => {
      const session = a.agent_session as { value?: unknown; kind?: unknown } | null | undefined;
      return {
        paneId: String(a.pane_id ?? ''),
        agent: a.agent ? String(a.agent) : null,
        status: String(a.agent_status ?? 'unknown') as HerdrAgentState,
        session: session?.value != null ? String(session.value) : null,
        stateLabels: (a.state_labels ?? {}) as Record<string, string>,
        tokens: (a.tokens ?? {}) as Record<string, string | null>,
      };
    });
  }

  async spawnSubPane(opts: { label: string; command: string[]; cwd: string; env?: Record<string, string> }): Promise<{ tabId: string; paneId: string }> {
    const result = (await this.request('layout.apply', {
      tab_label: opts.label,
      root: { type: 'pane', command: opts.command, cwd: opts.cwd, ...(opts.env ? { env: opts.env } : {}) },
    })) as Record<string, unknown>;
    const paneId = findIdIn(result, 'pane_id');
    if (!paneId) throw new Error('layout.apply: no pane_id in response');
    return { tabId: findIdIn(result, 'tab_id') ?? '', paneId };
  }

  async sendPaneText(paneId: string, text: string): Promise<void> {
    // 尾部 \r 即 Enter（实测：文本进入 pi 编辑器并提交）
    await this.request('pane.send_text', { pane_id: paneId, text: text + '\r' });
  }

  async waitAgent(paneId: string, until: HerdrAgentState[], timeoutMs: number): Promise<HerdrAgentState | null> {
    try {
      const result = (await this.request('agent.wait', {
        target: paneId,
        until,
        timeout_ms: timeoutMs,
      }, timeoutMs + 5000)) as { agent?: { agent_status?: string } } | { type?: string; agent?: { agent_status?: string } } | null;
      const status = result?.agent?.agent_status ?? (result as { agent_status?: string })?.agent_status;
      return (typeof status === 'string' ? status : 'unknown') as HerdrAgentState;
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if (/timeout/i.test(msg)) return null;
      throw err;
    }
  }

  async getAgentSessionPath(paneId: string): Promise<string | null> {
    const agents = await this.listAgents();
    const a = agents.find((x) => x.paneId === paneId);
    return a?.session ?? null;
  }

  async focusPane(paneId: string): Promise<void> {
    await this.request('pane.focus', { pane_id: paneId });
  }

  async splitPane(opts: { direction?: 'left' | 'right' | 'up' | 'down'; cwd?: string; env?: Record<string, string>; targetPaneId?: string } = {}): Promise<string> {
    const result = (await this.request('pane.split', {
      direction: opts.direction ?? 'right',
      ...(opts.targetPaneId ? { target_pane_id: opts.targetPaneId } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.env ? { env: opts.env } : {}),
    })) as Record<string, unknown>;
    const paneId = findIdIn(result, 'pane_id');
    if (!paneId) throw new Error('pane.split: no pane_id in response');
    return paneId;
  }

  async closePane(paneId: string): Promise<void> {
    await this.request('pane.close', { pane_id: paneId });
  }

  async createTab(opts: { workspaceId: string; label?: string; cwd?: string; env?: Record<string, string> }): Promise<{ tabId: string; paneId: string }> {
    const result = (await this.request('tab.create', {
      workspace_id: opts.workspaceId,
      ...(opts.label ? { label: opts.label } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.env ? { env: opts.env } : {}),
    })) as Record<string, unknown>;
    const paneId = findIdIn(result, 'pane_id');
    const tabId = findIdIn(result, 'tab_id');
    if (!tabId) throw new Error('tab.create: no tab_id in response');
    return { tabId, paneId: paneId ?? '' };
  }

  async listPanes(): Promise<Array<{ paneId: string; tabId: string; workspaceId: string; agentStatus: string }>> {
    const result = (await this.request('pane.list', {})) as { panes?: Array<Record<string, unknown>> } | null;
    return (result?.panes ?? []).map((p) => ({
      paneId: String(p.pane_id ?? ''),
      tabId: String(p.tab_id ?? ''),
      workspaceId: String(p.workspace_id ?? ''),
      agentStatus: String(p.agent_status ?? 'unknown'),
    }));
  }

  async exportLayout(opts: { paneId?: string; tabId?: string }): Promise<{ tabId: string | null; zoomed: boolean; root: unknown } | null> {
    try {
      const result = (await this.request('layout.export', {
        ...(opts.paneId ? { pane_id: opts.paneId } : {}),
        ...(opts.tabId ? { tab_id: opts.tabId } : {}),
      })) as Record<string, unknown> | null;
      // 响应信封：{layout:{tab_id,zoomed,root}}；兼容 root 直接在顶层
      const layout = (result?.layout ?? result) as Record<string, unknown> | null | undefined;
      if (!layout || typeof layout !== 'object' || !('root' in layout)) return null;
      return {
        tabId: typeof layout.tab_id === 'string' ? layout.tab_id : null,
        zoomed: Boolean(layout.zoomed),
        root: layout.root ?? null,
      };
    } catch {
      return null;
    }
  }

  private mapTabInfo(raw: Record<string, unknown> | null | undefined): TabInfo | null {
    if (!raw || typeof raw.tab_id !== 'string') return null;
    return {
      tabId: raw.tab_id,
      workspaceId: String(raw.workspace_id ?? ''),
      label: String(raw.label ?? ''),
      paneCount: Number(raw.pane_count ?? 0),
      agentStatus: String(raw.agent_status ?? 'unknown'),
    };
  }

  async tabList(): Promise<TabInfo[]> {
    const result = (await this.request('tab.list', {})) as { tabs?: Array<Record<string, unknown>> } | null;
    return (result?.tabs ?? []).map((t) => this.mapTabInfo(t)).filter((t): t is TabInfo => t !== null);
  }

  async tabGet(tabId: string): Promise<TabInfo | null> {
    const result = (await this.request('tab.get', { tab_id: tabId })) as { tab?: Record<string, unknown> | null } | null;
    return this.mapTabInfo(result?.tab ?? null);
  }

  async tabClose(tabId: string): Promise<void> {
    await this.request('tab.close', { tab_id: tabId });
  }

  async sendPaneKeys(paneId: string, keys: string[]): Promise<void> {
    await this.request('pane.send_keys', { pane_id: paneId, keys });
  }

  async readPane(paneId: string, opts: {
    source?: 'visible' | 'recent' | 'recent_unwrapped';
    lines?: number;
    stripAnsi?: boolean;
  } = {}): Promise<{ text: string; revision: number; truncated: boolean }> {
    // 信封实测：{type:'pane_read', read:{text, revision, truncated, ...}}（payload 套在 read 下）
    const result = (await this.request('pane.read', {
      pane_id: paneId,
      source: opts.source ?? 'recent',
      format: 'text',
      strip_ansi: opts.stripAnsi ?? false,
      ...(opts.lines != null ? { lines: opts.lines } : {}),
    })) as { read?: { text?: unknown; revision?: unknown; truncated?: unknown }; text?: unknown; revision?: unknown; truncated?: unknown } | null;
    const payload = result?.read ?? result ?? {};
    return {
      text: typeof payload.text === 'string' ? payload.text : '',
      revision: typeof payload.revision === 'number' ? payload.revision : 0,
      truncated: payload.truncated === true,
    };
  }

  async waitForOutput(paneId: string, match: { type: 'substring' | 'regex'; value: string }, timeoutMs: number): Promise<boolean | null> {
    try {
      await this.request('pane.wait_for_output', {
        pane_id: paneId,
        source: 'recent',
        match,
        timeout_ms: timeoutMs,
      }, timeoutMs + 5000);
      return true;
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if (/timeout/i.test(msg)) return null;
      throw err;
    }
  }

  close(): void {
    /* v1.1 无长驻连接；保留接口语义（Noop） */
  }
}

export function createHerdrClient(
  env: NodeJS.ProcessEnv = process.env,
): { client: HerdrClientLike; env: HerdrEnv | null } {
  const detected = detectHerdrEnv(env);
  if (!detected) return { client: new NoopHerdrClient(), env: null };
  return { client: new HerdrClient(detected), env: detected };
}
