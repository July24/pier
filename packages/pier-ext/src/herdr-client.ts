/**
 * Minimal herdr socket API client used inside the pi extension.
 *
 * Validated against herdr 0.9.5 (protocol 22; see WIRE.md — unchanged since 0.9.1; 0.9.2 removed only the
 * pane.graphics.* API, which pier never used). The request shapes pier builds are pinned to the
 * 0.9.5 methods snapshot in test/fixtures/herdr-contract.json (recent `api schema` releases no longer
 * emit a methods map) — after a herdr upgrade, re-verify the protocol number and the method set, then
 * regenerate the fixture and bump HERDR_PROTOCOL_EXPECTED when the server moves on:
 *  - Transport is NDJSON: request {id, method, params} → response {id, result} | {id, error:{code,message}};
 *  - **Control requests use one connection per request**; the server closes it after replying;
 *  - Windows targets are named pipes whose name is the complete socket_path with a \\.\pipe\ prefix;
 *  - pane.report_agent reports {pane_id, source, agent, state, message?} where state ∈
 *    idle|working|blocked|unknown ('done' is server-derived and is not reported by the client);
 *  - pane.report_metadata reports {pane_id, source, title?, state_labels?, clear_*, tokens?, ttl_ms?}
 *    (ttl_ms is capped at 24 h by the server; the first report of a session also clears legacy
 *    pi-herdr chunk tokens to null).
 *
 * Reporting failures stay silent and never affect the main pi flow; without herdr the Noop client
 * keeps pi independent (DESIGN.md §4.1).
 */
import { REPORT_AGENT_SOURCE, type TodoItem } from './vocab.ts';
import { BLOCKED_LABEL_KEY, SIDEBAR_ASK_TOKEN, formatBlockedLabel, formatPaneTitle, sidebarTodoTokens, staleTokenClearance } from './pane-title.ts';
import { applyWorkerTag, delegationSidebarTokens, type DelegationContext } from './delegation-core.ts';
import { LOCK_BATCH_LIMIT, LOCK_TTL_MS } from './lock-core.ts';
import * as net from 'node:net';

/* ── Types ──────────────────────────────────────────────────────────── */

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
  /** Herdr 0.9.1: foreground cwd of the process currently controlling the PTY. */
  foregroundCwd?: string | null;
}

export interface PaneListItem {
  paneId: string;
  tabId: string;
  workspaceId: string;
  agentStatus: string;
  foregroundCwd?: string | null;
  terminalTitle?: string | null;
  terminalTitleStripped?: string | null;
}

/** pane.process_info: the processes currently holding the pane's PTY foreground. */
export interface PaneProcessInfo {
  paneId: string;
  shellPid: number | null;
  foreground: ReadonlyArray<{
    name: string | null;
    argv0: string | null;
    pid: number | null;
    cwd: string | null;
  }>;
}

export interface PaneLayoutCell {
  paneId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  focused: boolean;
}

export interface PaneLayoutSnapshot {
  tabId: string | null;
  zoomed: boolean;
  focusedPaneId: string | null;
  panes: PaneLayoutCell[];
}

export interface OpenPluginPaneOptions {
  pluginId: string;
  entrypoint: string;
  placement?: 'popup' | 'overlay' | 'split' | 'tab' | 'zoomed';
  width?: string;
  height?: string;
  focus?: boolean;
  cwd?: string;
  env?: Record<string, string>;
  targetPaneId?: string;
  workspaceId?: string;
}

export type OpenPluginPaneResult =
  | { mode: 'popup'; ok: true }
  /** Another popup/modal owns the session; the caller may switch that panel instead of opening a tab. */
  | { mode: 'busy' }
  | { mode: 'pane'; paneId: string }
  | { mode: 'fallback_tab'; tabId?: string; paneId?: string };

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

export function herdrSocketTarget(socketPath: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return socketPath;
  return socketPath.startsWith('\\\\.\\pipe\\') ? socketPath : `\\\\.\\pipe\\${socketPath}`;
}

/** B5: herdr configured but unreachable (stopped server, stale HERDR_SOCKET_PATH) — tool layers append
 * this sentence because a raw errno tells the model nothing. Null when the failure is not transport. */
export function herdrUnavailableHint(err: unknown): string | null {
  const msg = String((err as { message?: unknown })?.message ?? err);
  if (!/ENOENT|ECONNREFUSED|ECONNRESET|EPIPE|ENOTCONN|not connected|socket|connect |timeout/i.test(msg)) {
    return null;
  }
  return `herdr unreachable (${msg}) — check that the herdr server is running and HERDR_SOCKET_PATH matches its socket`;
}

/** Wire protocol this client is written against (herdr 0.9.5, contract fixture regenerated 2026-10-20). */
export const HERDR_PROTOCOL_EXPECTED = 22;

export type WaitForOutputResult =
  | { matched: true }
  | { matched: false; reason: 'timeout' | 'unavailable' };

/** pane.read / agent.read selection: `recent` keeps ANSI so T6 fullscreen detection still sees it. */
export interface ReadOptions {
  source?: 'visible' | 'recent' | 'recent_unwrapped';
  lines?: number;
  stripAnsi?: boolean;
}

/** Decoded read payload; `revision` is the server's buffer revision (0 when unreadable). */
export interface ReadBuffer {
  text: string;
  revision: number;
  truncated: boolean;
}

export interface HerdrClientLike {
  readonly available: boolean;
  reportAgent(state: PaneAgentState, message: string | null): Promise<void>;
  reportMetadata(meta: { session: string; items: readonly TodoItem[]; progressSuffix?: string | null; lastWriteAt?: number | null; workerTag?: string | null }): Promise<void>;
  reportLockTokens(tokens: Record<string, string | null>): Promise<void>;
  /** D93: sidebar agent display name (display_agent is the role name); null clears it. Persists, no TTL. */
  reportDisplayAgent(name: string | null): Promise<void>;
  /**
   * D95: ask_user_question waiting marker (tokens['pi-ask']; null clears it). The sidebar/heatmap
   * grade blocked + pi-ask as the ask level, distinct from plain block.
   */
  reportAskFlag(text: string | null): Promise<void>;
  /** Delegation identity tokens (pi-parent/pi-task): who delegated this pane and for what task. */
  reportDelegationTokens(d: DelegationContext | null): Promise<void>;
  /**
   * herdr 0.9.2+ self-reported restore: register the command that reopens this exact session after
   * a server restart. Worker panes only; masters stay with herdr's native pi integration.
   * Silently no-ops on older servers and on any error — resume is always best-effort.
   */
  reportAgentSessionResume(sessionId: string, resumeArgv: readonly string[]): Promise<void>;
  listAgents(): Promise<AgentInfo[]>;
  /** Inject text into a pane terminal (pi editor input + Enter); the PTY channel is used only to start launchLine. */
  sendPaneText(paneId: string, text: string): Promise<void>;
  /** Server-side wait; null on timeout, throws on any other error. */
  waitAgent(paneId: string, until: HerdrAgentState[], timeoutMs: number): Promise<HerdrAgentState | null>;
  /** Query the child-agent session path (agent_session.value, kind=path); return null when absent. */
  getAgentSessionPath(paneId: string): Promise<string | null>;
  splitPane(opts: { direction?: 'left' | 'right' | 'up' | 'down'; cwd?: string; env?: Record<string, string>; targetPaneId?: string; focus?: boolean; ratio?: number }): Promise<string>;
  /** Close a pane; herdr kills its process tree and closes an empty tab. */
  closePane(paneId: string): Promise<void>;
  createTab(opts: { workspaceId: string; label?: string; cwd?: string; env?: Record<string, string> }): Promise<{ tabId: string; paneId: string }>;
  listPanes(): Promise<PaneListItem[]>;
  /** Foreground process snapshot; null when the server predates the method or the pane is gone. */
  processInfo(paneId: string): Promise<PaneProcessInfo | null>;
  /** D91: layout tree by paneId or tabId; null on failure. */
  exportLayout(opts?: { paneId?: string; tabId?: string }): Promise<{ tabId: string | null; zoomed: boolean; root: unknown; focusedPaneId: string | null } | null>;
  /** 0.9.1: live pane rects for the tab containing paneId. Best effort returns null. */
  paneLayout(opts?: { paneId?: string }): Promise<PaneLayoutSnapshot | null>;
  tabList(): Promise<TabInfo[]>;
  /** v1.3: tab.close cascades to the tab's panes. */
  tabClose(tabId: string): Promise<void>;
  /** 0.9.1: Launch a manifest pane entrypoint with placement (popup/tab/split/overlay/zoomed). */
  openPluginPane(opts: OpenPluginPaneOptions): Promise<OpenPluginPaneResult>;
  agentExplain(target: string): Promise<Record<string, unknown> | null>;
  /** pane.send_keys; herdr key combos include ctrl+c, enter, and esc. */
  sendPaneKeys(paneId: string, keys: string[]): Promise<void>;
  readPane(paneId: string, opts?: ReadOptions): Promise<ReadBuffer>;
  readAgent(target: string, opts?: ReadOptions): Promise<ReadBuffer>;
  waitForOutput(paneId: string, match: { type: 'substring' | 'regex'; value: string }, timeoutMs: number): Promise<WaitForOutputResult>;
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

/** Stand-in outside a herdr pane: queries answer empty, pane creation throws, reporting is a no-op. */
export class NoopHerdrClient implements HerdrClientLike {
  readonly available = false;
  async reportAgent(): Promise<void> {}
  async reportAgentSessionResume(): Promise<void> {}
  async reportMetadata(): Promise<void> {}
  async reportLockTokens(): Promise<void> {}
  async reportDelegationTokens(): Promise<void> {}
  async reportDisplayAgent(): Promise<void> {}
  async reportAskFlag(): Promise<void> {}
  async sendPaneText(): Promise<void> {}
  async closePane(): Promise<void> {}
  async tabClose(): Promise<void> {}
  async sendPaneKeys(): Promise<void> {}
  close(): void {}
  async listAgents(): Promise<AgentInfo[]> { return []; }
  async listPanes(): Promise<PaneListItem[]> { return []; }
  async processInfo(): Promise<PaneProcessInfo | null> { return null; }
  async tabList(): Promise<TabInfo[]> { return []; }
  async waitAgent(): Promise<null> { return null; }
  async getAgentSessionPath(): Promise<null> { return null; }
  async exportLayout(): Promise<null> { return null; }
  async paneLayout(): Promise<null> { return null; }
  async agentExplain(): Promise<null> { return null; }
  async readPane(): Promise<ReadBuffer> { return { text: '', revision: 0, truncated: false }; }
  async readAgent(): Promise<ReadBuffer> { return { text: '', revision: 0, truncated: false }; }
  async waitForOutput(): Promise<WaitForOutputResult> { return { matched: false, reason: 'unavailable' }; }
  async splitPane(): Promise<string> { throw new Error('subagent requires a herdr-managed pane'); }
  async createTab(): Promise<{ tabId: string; paneId: string }> { throw new Error('subagent requires a herdr-managed pane'); }
  async openPluginPane(): Promise<OpenPluginPaneResult> { throw new Error('plugin pane requires a herdr-managed pane'); }
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

  /** One connection per control request: the reply is a single {id,result}|{id,error} line. */
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

  /**
   * D-2 (verified 2026-10-20): herdr's native `herdr:pi` integration owns `agent_status`
   * (`screen_detection_skip_reason: full_lifecycle_hook_authority`), but it never reports the
   * activity text. `pane.report_agent` is still the only carrier for the tool badge, so pier keeps
   * sending state with the message; removing it requires migrating the badge to
   * `report_metadata.state_labels` first.
   */
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
    }
  }

  /**
   * Master panes stay with herdr's native pi integration (it owns the session path); workers
   * self-report so a restart replays pier's own launch line — extension loaded, role model, approve,
   * fullscreen frame — instead of a bare `pi --resume` without `-e`. herdr requires the source to
   * hold the pane before accepting a resume command (resume_not_accepted), so an idle state report
   * goes first, with one retry to tolerate a lost race with the session_start gate report.
   */
  async reportAgentSessionResume(sessionId: string, resumeArgv: readonly string[]): Promise<void> {
    if (!this.env) return;
    try {
      await this.reportAgent('idle', null);
      const params = {
        pane_id: this.env.paneId,
        source: REPORT_AGENT_SOURCE,
        agent: 'pi',
        agent_session_id: sessionId,
        resume_argv: [...resumeArgv],
      };
      try {
        await this.request('pane.report_agent_session', params);
      } catch {
        const { promise: retryDelay, resolve: retryNow } = Promise.withResolvers<void>();
        setTimeout(retryNow, 250);
        await retryDelay;
        await this.request('pane.report_agent_session', params);
      }
    } catch {
      /* best effort: live sessions never depend on restore metadata */
    }
  }

  async reportMetadata(meta: { session: string; items: readonly TodoItem[]; progressSuffix?: string | null; lastWriteAt?: number | null; workerTag?: string | null }): Promise<void> {
    try {
      void meta.session;
      const title = applyWorkerTag(
        formatPaneTitle(meta.items, null, {
          progressSuffix: meta.progressSuffix,
          lastWriteAt: meta.lastWriteAt,
        }),
        meta.workerTag ?? null,
      );
      const blocked = formatBlockedLabel(meta.items);
      // D96: stale cleanup needs its own batch — stale(16) + pi-todo(1) exceeds herdr's 16-token
      // limit, and the rejected request would drop both the title and the tokens.
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
        // D93: the todo summary is a custom token; an empty string clears the key instead of leaving a stale summary.
        tokens: sidebarTodoTokens(title),
        ttl_ms: 86400000,
      });
    } catch {
    }
  }

  /** RFC rfc-delegation-identity §2.3: separate batch — tokens patches never merge with the stale
   * cleanup or the todo title (D96 discipline); an unknown parent pane skips the report. */
  async reportDelegationTokens(d: DelegationContext | null): Promise<void> {
    const tokens = d ? delegationSidebarTokens(d) : {};
    if (Object.keys(tokens).length === 0) return;
    try {
      await this.request('pane.report_metadata', {
        pane_id: this.env.paneId,
        source: REPORT_AGENT_SOURCE,
        tokens,
        ttl_ms: 86400000,
      });
    } catch {
    }
  }

  async reportLockTokens(tokens: Record<string, string | null>): Promise<void> {
    const keys = Object.keys(tokens);
    if (keys.length === 0) return;
    try {
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
        ...(a.foreground_cwd ? { foregroundCwd: String(a.foreground_cwd) } : {}),
      };
    });
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
      // A14: herdr reports agent_not_found while a freshly spawned pane's agent is still registering;
      // callers poll, so map it to the same "nothing yet" result as a timeout.
      if (/agent_not_found|agent target .* not found/i.test(msg)) return null;
      throw err;
    }
  }

  async getAgentSessionPath(paneId: string): Promise<string | null> {
    const agents = await this.listAgents();
    const a = agents.find((x) => x.paneId === paneId);
    return a?.session ?? null;
  }

  async splitPane(opts: { direction?: 'left' | 'right' | 'up' | 'down'; cwd?: string; env?: Record<string, string>; targetPaneId?: string; focus?: boolean; ratio?: number } = {}): Promise<string> {
    const params: Record<string, unknown> = {
      direction: opts.direction ?? 'right',
      ...(opts.targetPaneId ? { target_pane_id: opts.targetPaneId } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.focus !== undefined ? { focus: opts.focus } : {}),
      ...(opts.ratio !== undefined ? { ratio: opts.ratio } : {}),
    };
    try {
      return await this.splitPaneRequest(params);
    } catch (err) {
      if (opts.ratio === undefined) throw err;
      const msg = String((err as Error)?.message ?? err);
      if (!/unknown|invalid_params|unexpected/i.test(msg)) throw err;
      const { ratio: _ratio, ...rest } = params;
      return await this.splitPaneRequest(rest);
    }
  }

  private async splitPaneRequest(params: Record<string, unknown>): Promise<string> {
    const result = (await this.request('pane.split', params)) as Record<string, unknown>;
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

  async listPanes(): Promise<PaneListItem[]> {
    const result = (await this.request('pane.list', {})) as { panes?: Array<Record<string, unknown>> } | null;
    return (result?.panes ?? []).map((p) => ({
      paneId: String(p.pane_id ?? ''),
      tabId: String(p.tab_id ?? ''),
      workspaceId: String(p.workspace_id ?? ''),
      agentStatus: String(p.agent_status ?? 'unknown'),
      ...(p.foreground_cwd ? { foregroundCwd: String(p.foreground_cwd) } : {}),
      ...(p.terminal_title ? { terminalTitle: String(p.terminal_title) } : {}),
      ...(p.terminal_title_stripped ? { terminalTitleStripped: String(p.terminal_title_stripped) } : {}),
    }));
  }

  async processInfo(paneId: string): Promise<PaneProcessInfo | null> {
    try {
      const result = (await this.request('pane.process_info', { pane_id: paneId })) as Record<string, unknown> | null;
      const info = (result?.process_info ?? result) as Record<string, unknown> | null | undefined;
      if (!info || typeof info !== 'object') return null;
      const raw = Array.isArray(info.foreground_processes) ? info.foreground_processes : [];
      return {
        paneId: typeof info.pane_id === 'string' ? info.pane_id : paneId,
        shellPid: typeof info.shell_pid === 'number' ? info.shell_pid : null,
        foreground: raw
          .filter((p): p is Record<string, unknown> => p !== null && typeof p === 'object')
          .map((p) => ({
            name: typeof p.name === 'string' ? p.name : null,
            argv0: typeof p.argv0 === 'string' ? p.argv0 : null,
            pid: typeof p.pid === 'number' ? p.pid : null,
            cwd: typeof p.cwd === 'string' ? p.cwd : null,
          })),
      };
    } catch {
      return null;
    }
  }

  async exportLayout(opts: { paneId?: string; tabId?: string } = {}): Promise<{ tabId: string | null; zoomed: boolean; root: unknown; focusedPaneId: string | null } | null> {
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
        // D-4: focus heat needs to know which pane the human is on; layout.export reports it.
        focusedPaneId: typeof layout.focused_pane_id === 'string' ? layout.focused_pane_id : null,
      };
    } catch {
      return null;
    }
  }

  async paneLayout(opts: { paneId?: string } = {}): Promise<PaneLayoutSnapshot | null> {
    try {
      const result = (await this.request('pane.layout', {
        ...(opts.paneId ? { pane_id: opts.paneId } : {}),
      })) as Record<string, unknown> | null;
      const layout = (result?.layout ?? result) as Record<string, unknown> | null | undefined;
      if (!layout || typeof layout !== 'object' || !Array.isArray(layout.panes)) return null;
      const panes: PaneLayoutCell[] = [];
      for (const raw of layout.panes) {
        if (!raw || typeof raw !== 'object') continue;
        const p = raw as Record<string, unknown>;
        const rect = (p.rect && typeof p.rect === 'object') ? p.rect as Record<string, unknown> : p;
        const paneId = typeof p.pane_id === 'string' ? p.pane_id : null;
        if (!paneId) continue;
        panes.push({
          paneId,
          x: Number(rect.x) || 0,
          y: Number(rect.y) || 0,
          w: Number(rect.width ?? rect.w) || 0,
          h: Number(rect.height ?? rect.h) || 0,
          focused: p.focused === true,
        });
      }
      return {
        tabId: typeof layout.tab_id === 'string' ? layout.tab_id : null,
        zoomed: Boolean(layout.zoomed),
        focusedPaneId: typeof layout.focused_pane_id === 'string' ? layout.focused_pane_id : null,
        panes,
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

  async tabClose(tabId: string): Promise<void> {
    await this.request('tab.close', { tab_id: tabId });
  }

  async openPluginPane(opts: OpenPluginPaneOptions): Promise<OpenPluginPaneResult> {
    const params: Record<string, unknown> = {
      plugin_id: opts.pluginId,
      entrypoint: opts.entrypoint,
      ...(opts.placement ? { placement: opts.placement } : {}),
      ...(opts.width ? { width: opts.width } : {}),
      ...(opts.height ? { height: opts.height } : {}),
      ...(opts.focus !== undefined ? { focus: opts.focus } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.targetPaneId ? { target_pane_id: opts.targetPaneId } : {}),
      ...(opts.workspaceId ? { workspace_id: opts.workspaceId } : {}),
    };
    try {
      const result = (await this.request('plugin.pane.open', params)) as Record<string, unknown> | null;
      if (opts.placement === 'popup') {
        return { mode: 'popup', ok: true };
      }
      return { mode: 'pane', paneId: findIdIn(result, 'pane_id') ?? '' };
    } catch (err) {
      // A live popup/modal is a transient state, not an old server: opening a tab would orphan a
      // second dashboard and silently change the surface. Callers decide whether to switch panels.
      const message = err instanceof Error ? err.message : String(err);
      if (opts.placement === 'popup' && /ui_busy|popup pane is already open/i.test(message)) {
        return { mode: 'busy' };
      }
      // 0.9.0 serde rejects unknown `popup` as "unknown variant" / invalid_params — not a dedicated
      // invalid_placement code. Any other popup failure retries as tab; tab failure surfaces to Level 3.
      if (opts.placement !== 'popup') throw err;
      const { width: _width, height: _height, target_pane_id: _target, ...base } = params;
      const fallbackRes = (await this.request('plugin.pane.open', { ...base, placement: 'tab' })) as Record<string, unknown> | null;
      return {
        mode: 'fallback_tab',
        paneId: findIdIn(fallbackRes, 'pane_id') ?? undefined,
        tabId: findIdIn(fallbackRes, 'tab_id') ?? undefined,
      };
    }
  }

  async agentExplain(target: string): Promise<Record<string, unknown> | null> {
    try {
      const result = (await this.request('agent.explain', { target })) as Record<string, unknown> | null;
      if (!result || typeof result !== 'object') return null;
      const nested = result.explain;
      if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
        return nested as Record<string, unknown>;
      }
      return result;
    } catch {
      return null;
    }
  }

  async sendPaneKeys(paneId: string, keys: string[]): Promise<void> {
    await this.request('pane.send_keys', { pane_id: paneId, keys });
  }

  /** Shared pane.read/agent.read decode: payload nested under `read` (older servers answer it flat). */
  private async readBuffer(
    method: 'pane.read' | 'agent.read',
    target: { pane_id: string } | { target: string },
    opts: ReadOptions,
    stripAnsiDefault: boolean,
  ): Promise<ReadBuffer> {
    const result = (await this.request(method, {
      ...target,
      source: opts.source ?? 'recent',
      format: 'text',
      strip_ansi: opts.stripAnsi ?? stripAnsiDefault,
      ...(opts.lines != null ? { lines: opts.lines } : {}),
    })) as {
      read?: { text?: unknown; revision?: unknown; truncated?: unknown };
      text?: unknown; revision?: unknown; truncated?: unknown;
    } | null;
    const payload = result?.read ?? result ?? {};
    return {
      text: typeof payload.text === 'string' ? payload.text : '',
      revision: typeof payload.revision === 'number' ? payload.revision : 0,
      truncated: payload.truncated === true,
    };
  }

  async readPane(paneId: string, opts: ReadOptions = {}): Promise<ReadBuffer> {
    return this.readBuffer('pane.read', { pane_id: paneId }, opts, false);
  }

  async readAgent(target: string, opts: ReadOptions = {}): Promise<ReadBuffer> {
    return this.readBuffer('agent.read', { target }, opts, true);
  }

  async waitForOutput(paneId: string, match: { type: 'substring' | 'regex'; value: string }, timeoutMs: number): Promise<WaitForOutputResult> {
    try {
      await this.request('pane.wait_for_output', {
        pane_id: paneId,
        source: 'recent',
        match,
        timeout_ms: timeoutMs,
      }, timeoutMs + 5000);
      return { matched: true };
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if (/timeout/i.test(msg)) return { matched: false, reason: 'timeout' };
      if (/not supported|not implemented|unknown method|unavailable|method not found/i.test(msg)) {
        return { matched: false, reason: 'unavailable' };
      }
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
