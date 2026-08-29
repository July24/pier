/**
 * Minimal herdr socket API client used inside the pi extension.
 *
 * Validated against herdr 0.8.0-preview (protocol 19, Windows named pipe; see WIRE.md):
 *  - Transport is NDJSON: request {id, method, params} → response {id, result} | {id, error:{code,message}};
 *  - **Control requests use one connection per request**; the server closes it after replying;
 *  - Windows targets are named pipes whose name is the complete socket_path with a \\.\pipe\ prefix;
 *  - pane.report_agent reports {pane_id, source, agent, state, message?, agent_session_id?, agent_session_path?}
 *    where state ∈ idle|working|blocked|unknown ('done' is server-derived and is not reported by the client);
 *  - pane.report_metadata reports {pane_id, source, title?, state_labels?, clear_title?, clear_state_labels?}
 *    M22 reports only the title projection; the first upgrade also clears legacy pi-herdr chunk tokens to null;
 *  - agent.list {} → {type:'agent_list', agents: AgentInfo[]};
 *  - agent.wait {target, until[], timeout_ms?} → the matching agent, or an error on timeout;
 *  - agent.send_keys {target, keys[]} / pane.send_text {pane_id, text}.
 *
 * The v1.1 (DESIGN.md §12) surface reports three projections, lists, spawns, injects
 * text, sends keys, waits via agent.wait, and queries session paths. Removed operations
 * (waitSettled marker polling, readPaneText parsing, onAgentState long-lived subscriptions)
 * are replaced by session JSONL results (session-tail.ts) and server-side agent.wait.
 *
 * Design (DESIGN.md §4.1): without herdr, fall back to Noop so pi remains independent;
 * failures in reporting calls stay silent and never affect the main pi flow.
 */
import { REPORT_AGENT_SOURCE, type TodoItem } from './vocab.ts';
import { BLOCKED_LABEL_KEY, SIDEBAR_ASK_TOKEN, formatBlockedLabel, formatPaneTitle, sidebarTodoTokens, staleTokenClearance } from './pane-title.ts';
import { LOCK_BATCH_LIMIT, LOCK_TTL_MS } from './lock-core.ts';
import * as net from 'node:net';

/* ── Types ──────────────────────────────────────────────────────────── */

/** Herdr agent semantic state; schema has five observed states and 'done' is server-derived. */
export type HerdrAgentState = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

export interface HerdrEnv {
  socketPath: string;
  paneId: string;
  workspaceId: string;
  tabId: string;
}

/** State reportable through report_agent; 'done' is derived by the server. */
export type PaneAgentState = 'idle' | 'working' | 'blocked' | 'unknown';

export interface AgentInfo {
  paneId: string;
  agent: string | null;
  status: HerdrAgentState;
  /** agent_session.value (session ID or path), retained for recovery and navigation. */
  session: string | null;
  stateLabels: Record<string, string>;
  tokens: Record<string, string | null>;
}

/** TabInfo projection; fields mirror the observed tab schema. */
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

/** Resolve herdr socket target (Windows named-pipe prefix vs Unix path). */
export function herdrSocketTarget(socketPath: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return socketPath;
  return socketPath.startsWith('\\\\.\\pipe\\') ? socketPath : `\\\\.\\pipe\\${socketPath}`;
}


export interface HerdrClientLike {
  readonly available: boolean;
  reportAgent(state: PaneAgentState, message: string | null): Promise<void>;
  reportAgentSession(sessionPath: string | null): Promise<void>;
  reportMetadata(meta: { session: string; items: TodoItem[]; progressSuffix?: string | null; lastWriteAt?: number | null }): Promise<void>;
  /** M18: report write-lock tokens (lock-<hash> → paneId|path); null releases, and batches stay within 16 keys. */
  reportLockTokens(tokens: Record<string, string | null>): Promise<void>;
  /**
   * D93: sidebar agent display name (display_agent is the role name).
   * The report persists without a TTL; null clears it back to the detected value. Best effort.
   */
  reportDisplayAgent(name: string | null): Promise<void>;
  /**
   * D95: ask_user_question waiting marker (tokens['pi-ask']; null clears it).
   * Sidebar/heatmap grading distinguishes blocked + pi-ask (ask level) from plain blocked (block level).
   */
  reportAskFlag(text: string | null): Promise<void>;
  listAgents(): Promise<AgentInfo[]>;
  /** Start a child pane with argv in a new tab (layout.apply), returning pane/tab IDs. */
  spawnSubPane(opts: { label: string; command: string[]; cwd: string; env?: Record<string, string> }): Promise<{ tabId: string; paneId: string }>;
  /** Inject text into a pane terminal (pi editor input + Enter); send_text+CR reaches it directly and is used only to start launchLine. */
  sendPaneText(paneId: string, text: string): Promise<void>;
  /** Wait for an agent state server-side; return the matched state, null on timeout, and throw on error. */
  waitAgent(paneId: string, until: HerdrAgentState[], timeoutMs: number): Promise<HerdrAgentState | null>;
  /** Query the child-agent session path (agent_session.value, kind=path); return null when absent. */
  getAgentSessionPath(paneId: string): Promise<string | null>;
  /** v1.2: Focus a pane before adding it to a group tab. */
  focusPane(paneId: string): Promise<void>;
  /** v1.2: Split a new shell pane in the current tab after focus, placing it in the group tab; return its pane ID. */
  splitPane(opts: { direction?: 'left' | 'right' | 'up' | 'down'; cwd?: string; env?: Record<string, string>; targetPaneId?: string }): Promise<string>;
  /** v1.2: Close a pane; observed behavior kills its process tree and herdr closes an empty tab. */
  closePane(paneId: string): Promise<void>;
  /** v1.2: Create a tab with a root shell pane, returning tabId/paneId for group-tab infrastructure. */
  createTab(opts: { workspaceId: string; label?: string; cwd?: string; env?: Record<string, string> }): Promise<{ tabId: string; paneId: string }>;
  /** v1.2: List all panes with tab ownership for group-tab additions. */
  listPanes(): Promise<Array<{ paneId: string; tabId: string; workspaceId: string; agentStatus: string }>>;
  /** D91: Export the tab layout tree, locating it by paneId or tabId; best effort returns null on failure. */
  exportLayout(opts: { paneId?: string; tabId?: string }): Promise<{ tabId: string | null; zoomed: boolean; root: unknown } | null>;
  /** v1.3: List tabs (tab.list); fields follow the observed schema. */
  tabList(): Promise<TabInfo[]>;
  /** v1.3: Get tab details (tab.get); return null when absent. */
  tabGet(tabId: string): Promise<TabInfo | null>;
  /** v1.3: Close a tab (tab.close), cascading to its panes. */
  tabClose(tabId: string): Promise<void>;
  /** M14: Send a key combination (pane.send_keys; Herdr key combos include ctrl+c, enter, and esc). */
  sendPaneKeys(paneId: string, keys: string[]): Promise<void>;
  /** M14: Read the pane output buffer; recent preserves ANSI data for T6 detection by default. */
  readPane(paneId: string, opts?: {
    source?: 'visible' | 'recent' | 'recent_unwrapped';
    lines?: number;
    stripAnsi?: boolean;
  }): Promise<{ text: string; revision: number; truncated: boolean }>;
  /** M14: Wait for output to match a substring or regex; return null on timeout and throw on error. */
  waitForOutput(paneId: string, match: { type: 'substring' | 'regex'; value: string }, timeoutMs: number): Promise<boolean | null>;
  close(): void;
}

/** Find the first string field named key by depth-first search; herdr envelopes place IDs inconsistently. */
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

/* ── Implementation ────────────────────────────────────────────────── */

export class HerdrClient implements HerdrClientLike {
  readonly available = true;
  private clearedStaleTokens = false;
  private readonly env: HerdrEnv;

  constructor(env: HerdrEnv) {
    this.env = env;
  }

  private target(): string {
    return herdrSocketTarget(this.env.socketPath);
  }

  /**
   * Control requests use one connection per request; the server closes it after replying, as observed in the protocol.
   * Reading a complete response line finishes the request; responses are {id, result} or {id, error}.
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

  /* ── Reporting (silent best effort: the workbench mirror must never affect pi's main flow) ── */

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
      /* Silent best effort. */
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
      /* Silent best effort. */
    }
  }

  async reportMetadata(meta: { session: string; items: TodoItem[]; progressSuffix?: string | null; lastWriteAt?: number | null }): Promise<void> {
    try {
      void meta.session;
      const title = formatPaneTitle(meta.items, null, {
        progressSuffix: meta.progressSuffix,
        lastWriteAt: meta.lastWriteAt,
      });
      const blocked = formatBlockedLabel(meta.items);
      // D96: separate stale cleanup from the daily report—stale(16) + pi-todo(1) exceeds herdr's 16-token limit,
      // so one rejected request would lose both title and tokens (the D93 regression root cause). Set stale in its own batch first.
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
        // D93: put the todo summary in a custom token; an empty string clears the key so stale summaries do not remain.
        tokens: sidebarTodoTokens(title),
        ttl_ms: 86400000,
      });
    } catch {
      /* Silent best effort: the title projection must never affect pi's main flow. */
    }
  }

  async reportLockTokens(tokens: Record<string, string | null>): Promise<void> {
    const keys = Object.keys(tokens);
    if (keys.length === 0) return;
    try {
      // schema maxProperties=16, so split into independent best-effort requests.
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
      /* Lock registration is best effort; under soft veto, failure only loses a warning and does not block. */
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
      /* Silent best effort: sidebar identity is supplementary. */
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
      /* Silent best effort: the human-gate marker is supplementary. */
    }
  }

  /* ── Queries and control ─────────────────────────────────────────── */

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
    // A trailing \r acts as Enter; observed behavior sends text to the pi editor and submits it.
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
      // Observed envelope: {layout:{tab_id,zoomed,root}}; accept root directly at the top level for compatibility.
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
    // Observed envelope: {type:'pane_read', read:{text, revision, truncated, ...}}; the payload is nested under read.
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
    /* v1.1 has no long-lived connection; retain the interface semantics as a no-op. */
  }
}

export function createHerdrClient(
  env: NodeJS.ProcessEnv = process.env,
): { client: HerdrClientLike; env: HerdrEnv | null } {
  const detected = detectHerdrEnv(env);
  if (!detected) return { client: new NoopHerdrClient(), env: null };
  return { client: new HerdrClient(detected), env: detected };
}
