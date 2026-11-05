/**
 * Minimal herdr-core (`hc`) client used inside the pi extension.
 *
 * Written against hc 0.1.18 (protocol generation 1); the request shapes pier builds are pinned to the
 * OpenRPC snapshot in test/fixtures/hc-contract.json (`hc schema`). After a core upgrade, regenerate
 * the fixture and re-run the contract test.
 *  - Transport is JSON-RPC 2.0, one message per line, plain mode; one connection per request.
 *  - Errors carry a stable `data.kind` (not_found, blocked, status_mismatch, finished, unavailable…);
 *    `CoreError.kind` exposes it so callers branch on kind, never on message text.
 *  - Status is whatever the program reports through OSC 7501; pier never writes status through the API.
 *  - Pier metadata lives in terminal labels under `pier.*`; an empty value removes a label.
 *
 * Terminal addresses (`t7`) take the place of herdr TUI pane ids; the Herdr app shows a terminal that
 * carries `herdr.space`/`herdr.tab` labels as a pane of that tab, so callers keep calling them panes.
 */
import * as net from 'node:net';

/** Core release the request shapes were written and contract-tested against. */
export const CORE_VERSION_PINNED = '0.1.18';

/* ── Types ──────────────────────────────────────────────────────────── */

/** OSC 7501 words as core reports them; `unknown` = the program never reported (or its record was cleared). */
export type CoreStatus = 'idle' | 'working' | 'blocked' | 'done' | 'error' | 'unknown';

export interface CoreEnv {
  socketPath: string;
  /** This process's own terminal address (`HC_TERMINAL_ID`). */
  terminalId: string;
}

export interface TerminalForeground {
  pid: number;
  name: string;
  argv: string[];
  cwd: string;
}

export interface TerminalInfo {
  id: string;
  name: string | null;
  state: 'live' | 'finished';
  status: CoreStatus;
  /** permission | question | auth while blocked, when the program said. */
  statusKind: string | null;
  statusMsg: string | null;
  statusApp: string | null;
  labels: Record<string, string>;
  parent: string | null;
  cwd: string;
  foreground: TerminalForeground | null;
  exitCode: number | null;
  reason: string | null;
  turn: number;
  title: string;
}

export interface RunOptions {
  /** Program and arguments; omit both argv and line for the machine's shell. */
  argv?: readonly string[];
  /** A shell line run by the machine's shell (`sh -c`). */
  line?: string;
  cwd?: string;
  /** Set on top of the CORE's environment (not the caller's): pass everything the program needs. */
  env?: Record<string, string>;
  labels?: Record<string, string>;
  name?: string;
  /** Default: this terminal is the parent; `null` = no parent. */
  parent?: string | null;
  /** Keep core's `<hc from=…>` notes out of the parent's PTY (D45: PTY input is for humans). */
  noNotify?: boolean;
}

export type WaitFailureReason = 'timeout' | 'unavailable';

export type WaitForOutputResult =
  | { matched: true }
  | { matched: false; reason: WaitFailureReason };

export interface ReadBuffer {
  text: string;
  /** False when part of what was asked for may be missing (a full-screen app read while working). */
  complete: boolean;
}

export type InterruptOutcome = 'stopped' | 'exited' | 'still_working' | 'unknown';

export class CoreError extends Error {
  readonly kind: string;
  readonly hint: string | null;
  constructor(method: string, kind: string, message: string, hint: string | null) {
    super(`${kind}: ${message}${hint ? ` (${hint})` : ''}`);
    this.name = 'CoreError';
    this.kind = kind;
    this.hint = hint;
    void method;
  }
}

export function isCoreErrorKind(err: unknown, kind: string): boolean {
  return err instanceof CoreError && err.kind === kind;
}

/* ── Environment ─────────────────────────────────────────────────────── */

export function detectCoreEnv(env: NodeJS.ProcessEnv = process.env): CoreEnv | null {
  const socketPath = env.HC_TERMINAL_SOCKET;
  const terminalId = env.HC_TERMINAL_ID;
  if (!socketPath || !terminalId) return null;
  return { socketPath, terminalId };
}

/** Environment a child terminal should start with: core sets env on top of ITS OWN environment, so
 *  the caller's (provider keys, PATH from the user's shell, TERM identity) must be passed explicitly.
 *  Core's per-terminal identity (`HC_*`) is never forwarded — the child gets its own. */
export function childEnvironment(
  base: NodeJS.ProcessEnv,
  overrides: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || k.startsWith('HC_')) continue;
    out[k] = v;
  }
  return { ...out, ...overrides };
}

/** Transport failure (core stopped, stale socket) → one sentence the model can act on; null otherwise. */
export function coreUnavailableHint(err: unknown): string | null {
  if (err instanceof CoreError) return null;
  const msg = String((err as { message?: unknown })?.message ?? err);
  if (!/ENOENT|ECONNREFUSED|ECONNRESET|EPIPE|ENOTCONN|not connected|socket|connect |timeout|connection closed/i.test(msg)) {
    return null;
  }
  return `herdr-core unreachable (${msg}) — check that the core is running (\`hc server status\`) and HC_TERMINAL_SOCKET matches its socket`;
}

/* ── Interface ───────────────────────────────────────────────────────── */

export interface CoreClientLike {
  readonly available: boolean;
  /** Set (non-empty) or remove (null/empty) labels on this terminal. Best effort, never throws. */
  setLabels(labels: Record<string, string | null>): Promise<void>;
  /** `herdr.space`/`herdr.tab` of this terminal, so children land in the same tab of the app. */
  placementLabels(): Promise<Record<string, string>>;
  getTerminal(id: string): Promise<TerminalInfo | null>;
  listTerminals(opts?: { labels?: Record<string, string>; all?: boolean }): Promise<TerminalInfo[]>;
  run(opts: RunOptions): Promise<TerminalInfo>;
  /** Paste text and press Enter (core waits for ~3 s of human quiet). */
  send(id: string, text: string, opts?: { force?: boolean }): Promise<void>;
  keys(id: string, keys: readonly string[]): Promise<void>;
  interrupt(id: string): Promise<InterruptOutcome>;
  read(id: string, opts?: { lines?: number }): Promise<ReadBuffer>;
  /** This terminal's children (workers, shells it started), kept live by one event subscription. */
  watchChildren(): WorkerWatch;
  waitForOutput(id: string, text: string, timeoutMs: number): Promise<WaitForOutputResult>;
  kill(id: string): Promise<void>;
  /** Remove a finished terminal; a missing one is not an error. */
  remove(id: string): Promise<void>;
  serverVersion(): Promise<string | null>;
}

/**
 * Live view of this terminal's children: one `events.subscribe {children_of}` connection, a snapshot
 * patched by events, and a per-terminal change counter consumers wait on instead of polling.
 * Opens lazily on first use, reconnects with backoff, and re-snapshots after `missed` or a reconnect;
 * a snapshot rebuild or a disconnect counts as a change for every terminal so waiters re-evaluate.
 * While disconnected the snapshot is stale: callers must check `connected` before trusting it.
 */
export interface WorkerWatch {
  readonly connected: boolean;
  /** First snapshot in → true; the first connection attempt failed → false (retries continue). */
  ready(): Promise<boolean>;
  get(id: string): TerminalInfo | undefined;
  list(): TerminalInfo[];
  /** Change counter for one terminal; compare with `changed`. */
  version(id: string): number;
  /** Resolves true once `version(id)` passes `since`, false after `timeoutMs` (or on close). */
  changed(id: string, since: number, timeoutMs: number): Promise<boolean>;
  close(): void;
}

/* ── Decoding ────────────────────────────────────────────────────────── */

const STATUS_WORDS: Record<string, true> = { idle: true, working: true, blocked: true, done: true, error: true };

function asStatus(word: unknown): CoreStatus {
  return typeof word === 'string' && STATUS_WORDS[word] ? (word as CoreStatus) : 'unknown';
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

export function decodeTerminal(raw: unknown): TerminalInfo {
  const t = (raw ?? {}) as Record<string, unknown>;
  const status = (t.status ?? null) as Record<string, unknown> | null;
  const fg = (t.foreground ?? null) as Record<string, unknown> | null;
  const labels: Record<string, string> = {};
  for (const [k, v] of Object.entries((t.labels ?? {}) as Record<string, unknown>)) {
    if (typeof v === 'string') labels[k] = v;
  }
  return {
    id: String(t.address ?? ''),
    name: str(t.name),
    state: t.state === 'finished' ? 'finished' : 'live',
    status: asStatus(status?.state),
    statusKind: str(status?.kind),
    statusMsg: str(status?.msg),
    statusApp: str(status?.app),
    labels,
    parent: str(t.parent),
    cwd: String(t.cwd ?? ''),
    foreground: fg && typeof fg === 'object'
      ? {
        pid: Number(fg.pid) || 0,
        name: String(fg.name ?? ''),
        argv: Array.isArray(fg.argv) ? fg.argv.map(String) : [],
        cwd: String(fg.cwd ?? ''),
      }
      : null,
    exitCode: typeof t.exit_code === 'number' ? t.exit_code : null,
    reason: str(t.reason),
    turn: typeof t.turn === 'number' ? t.turn : 0,
    title: String(t.title ?? ''),
  };
}

/* ── Noop ────────────────────────────────────────────────────────────── */

/** Stand-in outside an hc terminal: queries answer empty, creation throws, labels are a no-op. */
export class NoopCoreClient implements CoreClientLike {
  readonly available = false;
  async setLabels(): Promise<void> {}
  async placementLabels(): Promise<Record<string, string>> { return {}; }
  async getTerminal(): Promise<null> { return null; }
  async listTerminals(): Promise<TerminalInfo[]> { return []; }
  async run(): Promise<TerminalInfo> { throw new Error('subagents and terminals require running inside a herdr-core terminal'); }
  async send(): Promise<void> {}
  async keys(): Promise<void> {}
  async interrupt(): Promise<InterruptOutcome> { return 'unknown'; }
  async read(): Promise<ReadBuffer> { return { text: '', complete: false }; }
  watchChildren(): WorkerWatch { return NOOP_WATCH; }
  async waitForOutput(): Promise<WaitForOutputResult> { return { matched: false, reason: 'unavailable' }; }
  async kill(): Promise<void> {}
  async remove(): Promise<void> {}
  async serverVersion(): Promise<null> { return null; }
}

const NOOP_WATCH: WorkerWatch = {
  connected: false,
  ready: async () => false,
  get: () => undefined,
  list: () => [],
  version: () => 0,
  changed: (_id, _since, timeoutMs) => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setTimeout(() => resolve(false), timeoutMs).unref?.();
    return promise;
  },
  close: () => {},
};

/** core heartbeats an idle subscription every 15 s; three missed beats means the line is dead. */
const WATCH_IDLE_MS = 45_000;
const WATCH_BACKOFF_MS = [500, 1_000, 2_000, 5_000, 10_000] as const;

/** Patch one snapshot record with an event (schema/README.md "Events"); null drops it. */
export function applyTerminalEvent(rec: TerminalInfo | undefined, type: string, data: unknown): TerminalInfo | null | undefined {
  const d = (data ?? {}) as Record<string, unknown>;
  if (type === 'created' || type === 'restarted') return decodeTerminal(data);
  if (type === 'removed') return null;
  if (!rec) return undefined;
  switch (type) {
    case 'status': {
      const s = (d.status ?? null) as Record<string, unknown> | null;
      return { ...rec, status: asStatus(s?.state), statusKind: str(s?.kind), statusMsg: str(s?.msg), statusApp: str(s?.app) };
    }
    case 'turn':
      return { ...rec, turn: typeof d.turn === 'number' ? d.turn : rec.turn };
    case 'finished':
      return { ...rec, state: 'finished', exitCode: typeof d.exit_code === 'number' ? d.exit_code : null, reason: str(d.reason), foreground: null };
    case 'lost':
      return { ...rec, exitCode: typeof d.exit_code === 'number' ? d.exit_code : null, reason: str(d.reason), foreground: null };
    case 'title':
      return { ...rec, title: String(d.title ?? '') };
    case 'labels': {
      if (d.record) return decodeTerminal(d.record);
      return { ...rec, labels: decodeTerminal({ labels: d.labels }).labels };
    }
    case 'foreground':
      return { ...rec, foreground: data ? decodeTerminal({ foreground: data }).foreground : null };
    default:
      return rec;
  }
}

export class CoreWatch implements WorkerWatch {
  connected = false;
  private readonly socketPath: string;
  private readonly parent: string;
  private sock: net.Socket | null = null;
  private started = false;
  private closed = false;
  private attempt = 0;
  private seq = 0;
  private terminals = new Map<string, TerminalInfo>();
  private tick = 0;
  private epochAt = 0;
  private touchedAt = new Map<string, number>();
  private waiters = new Set<{ id: string; since: number; resolve: (v: boolean) => void; timer: NodeJS.Timeout }>();
  private idleTimer: NodeJS.Timeout | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private readonly firstReady = Promise.withResolvers<boolean>();
  private readySettled = false;

  constructor(env: CoreEnv) {
    this.socketPath = env.socketPath;
    this.parent = env.terminalId;
  }

  ready(): Promise<boolean> {
    this.start();
    return this.firstReady.promise;
  }

  get(id: string): TerminalInfo | undefined {
    this.start();
    return this.terminals.get(id);
  }

  list(): TerminalInfo[] {
    this.start();
    return [...this.terminals.values()];
  }

  version(id: string): number {
    this.start();
    return Math.max(this.touchedAt.get(id) ?? 0, this.epochAt);
  }

  changed(id: string, since: number, timeoutMs: number): Promise<boolean> {
    if (this.version(id) > since) return Promise.resolve(true);
    if (this.closed) return Promise.resolve(false);
    const { promise, resolve } = Promise.withResolvers<boolean>();
    const waiter = {
      id,
      since,
      resolve,
      timer: setTimeout(() => {
        this.waiters.delete(waiter);
        resolve(false);
      }, Math.max(0, timeoutMs)),
    };
    waiter.timer.unref?.();
    this.waiters.add(waiter);
    return promise;
  }

  close(): void {
    this.closed = true;
    this.connected = false;
    clearTimeout(this.idleTimer);
    clearTimeout(this.retryTimer);
    this.sock?.destroy();
    this.sock = null;
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.resolve(false);
    }
    this.waiters.clear();
    this.settleReady(false);
  }

  private start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    this.connect();
  }

  private settleReady(ok: boolean): void {
    if (this.readySettled) return;
    this.readySettled = true;
    this.firstReady.resolve(ok);
  }

  private wake(): void {
    for (const w of this.waiters) {
      if (this.version(w.id) <= w.since) continue;
      this.waiters.delete(w);
      clearTimeout(w.timer);
      w.resolve(true);
    }
  }

  private touch(id: string): void {
    this.touchedAt.set(id, ++this.tick);
    this.wake();
  }

  private touchAll(): void {
    this.epochAt = ++this.tick;
    this.wake();
  }

  private snapshot(raw: unknown, seq: unknown): void {
    this.terminals = new Map((Array.isArray(raw) ? raw : []).map((t) => {
      const rec = decodeTerminal(t);
      return [rec.id, rec] as const;
    }));
    this.seq = typeof seq === 'number' ? seq : 0;
    this.touchAll();
  }

  private armIdle(sock: net.Socket): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => sock.destroy(new Error('hc events: heartbeat lost')), WATCH_IDLE_MS);
    this.idleTimer.unref?.();
  }

  private connect(): void {
    if (this.closed) return;
    const sock = net.createConnection(this.socketPath);
    this.sock = sock;
    sock.setEncoding('utf8');
    let buf = '';
    sock.on('connect', () => {
      this.armIdle(sock);
      sock.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'events.subscribe', params: { children_of: this.parent } }) + '\n');
    });
    sock.on('data', (chunk) => {
      this.armIdle(sock);
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) this.handle(sock, line);
      }
    });
    const drop = (): void => {
      if (this.sock !== sock) return;
      this.sock = null;
      clearTimeout(this.idleTimer);
      const wasConnected = this.connected;
      this.connected = false;
      this.settleReady(false);
      if (wasConnected) this.touchAll();
      if (this.closed) return;
      const delay = WATCH_BACKOFF_MS[Math.min(this.attempt, WATCH_BACKOFF_MS.length - 1)];
      this.attempt += 1;
      this.retryTimer = setTimeout(() => this.connect(), delay);
      this.retryTimer.unref?.();
    };
    sock.on('error', drop);
    sock.on('close', drop);
  }

  private handle(sock: net.Socket, line: string): void {
    let msg: { id?: unknown; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: unknown };
    try {
      msg = JSON.parse(line);
    } catch {
      sock.destroy();
      return;
    }
    if (msg.id === 1) {
      if (msg.error || !msg.result) {
        sock.destroy();
        return;
      }
      this.connected = true;
      this.attempt = 0;
      this.snapshot(msg.result.terminals, msg.result.seq);
      this.settleReady(true);
      return;
    }
    const p = msg.params ?? {};
    if (msg.method === 'missed') {
      this.snapshot(p.terminals, p.seq);
      return;
    }
    if (msg.method !== 'event') return;
    if (typeof p.seq === 'number') {
      if (p.seq <= this.seq) return; // already covered by the snapshot
      this.seq = p.seq;
    }
    const id = typeof p.terminal === 'string' ? p.terminal : null;
    if (!id || typeof p.type !== 'string') return;
    const next = applyTerminalEvent(this.terminals.get(id), p.type, p.data);
    if (next === undefined) return;
    if (next === null) this.terminals.delete(id);
    else this.terminals.set(id, next);
    this.touch(id);
  }
}

/* ── Implementation ──────────────────────────────────────────────────── */

/** Slack over a server-side wait before the client gives up on the socket. */
const WAIT_SLACK_MS = 10_000;

export class CoreClient implements CoreClientLike {
  readonly available = true;
  private readonly env: CoreEnv;
  private placement: Promise<Record<string, string>> | null = null;
  private nextId = 1;
  private watch: CoreWatch | null = null;

  constructor(env: CoreEnv) {
    this.env = env;
  }

  /** One connection per request: write one line, read the first reply line, close. */
  request(method: string, params: Record<string, unknown>, timeoutMs = 15_000): Promise<unknown> {
    const id = this.nextId++;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const sock = net.createConnection(this.env.socketPath);
    sock.setEncoding('utf8');
    let buf = '';
    let settled = false;
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      settle();
    };
    const timer = setTimeout(() => finish(() => reject(new Error(`hc ${method}: timeout`))), timeoutMs);
    sock.on('connect', () => {
      sock.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', (err) => {
        if (err) finish(() => reject(err));
      });
    });
    sock.on('data', (chunk) => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg: { id?: unknown; result?: unknown; error?: { message?: string; data?: { kind?: string; hint?: string } } };
        try {
          msg = JSON.parse(line);
        } catch {
          finish(() => reject(new Error(`hc ${method}: bad frame`)));
          return;
        }
        if (msg.id !== id) continue;
        const error = msg.error;
        if (error) {
          finish(() => reject(new CoreError(method, error.data?.kind ?? 'error', error.message ?? '', error.data?.hint ?? null)));
        } else {
          finish(() => resolve(msg.result));
        }
        return;
      }
    });
    sock.on('error', (err) => finish(() => reject(err)));
    sock.on('close', () => finish(() => reject(new Error(`hc ${method}: connection closed`))));
    return promise;
  }

  async setLabels(labels: Record<string, string | null>): Promise<void> {
    const wire: Record<string, string> = {};
    for (const [k, v] of Object.entries(labels)) wire[k] = v ?? '';
    if (Object.keys(wire).length === 0) return;
    try {
      await this.request('terminal.label', { terminal: this.env.terminalId, labels: wire });
    } catch {
      /* best effort: metadata never affects the pi flow */
    }
  }

  placementLabels(): Promise<Record<string, string>> {
    this.placement ??= this.getTerminal(this.env.terminalId)
      .then((self) => {
        const out: Record<string, string> = {};
        for (const key of ['herdr.space', 'herdr.tab']) {
          const v = self?.labels[key];
          if (v) out[key] = v;
        }
        return out;
      })
      .catch(() => {
        this.placement = null;
        return {};
      });
    return this.placement;
  }

  async getTerminal(id: string): Promise<TerminalInfo | null> {
    try {
      return decodeTerminal(await this.request('terminal.get', { terminal: id, caller: this.env.terminalId }));
    } catch (err) {
      if (isCoreErrorKind(err, 'not_found')) return null;
      throw err;
    }
  }

  async listTerminals(opts: { labels?: Record<string, string>; all?: boolean } = {}): Promise<TerminalInfo[]> {
    const result = (await this.request('terminal.list', {
      ...(opts.all ? { all: true } : {}),
      ...(opts.labels ? { labels: opts.labels } : {}),
    })) as { terminals?: unknown[] } | null;
    return (result?.terminals ?? []).map(decodeTerminal);
  }

  async run(opts: RunOptions): Promise<TerminalInfo> {
    const params: Record<string, unknown> = {
      caller: this.env.terminalId,
      ...(opts.argv ? { argv: [...opts.argv] } : {}),
      ...(opts.line ? { line: opts.line } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.labels ? { labels: opts.labels } : {}),
      ...(opts.name ? { name: opts.name } : {}),
      ...(opts.noNotify ? { no_notify: true } : {}),
    };
    if (opts.parent === null) params.no_parent = true;
    else params.parent = opts.parent ?? this.env.terminalId;
    return decodeTerminal(await this.request('terminal.run', params));
  }

  async send(id: string, text: string, opts: { force?: boolean } = {}): Promise<void> {
    await this.request('terminal.send', {
      terminal: id,
      text,
      caller: this.env.terminalId,
      ...(opts.force ? { force: true } : {}),
    }, 30_000);
  }

  async keys(id: string, keys: readonly string[]): Promise<void> {
    await this.request('terminal.keys', { terminal: id, keys: [...keys], caller: this.env.terminalId }, 30_000);
  }

  async interrupt(id: string): Promise<InterruptOutcome> {
    const result = (await this.request('terminal.interrupt', { terminal: id }, 30_000)) as { outcome?: string } | null;
    const o = result?.outcome;
    return o === 'stopped' || o === 'exited' || o === 'still_working' ? o : 'unknown';
  }

  async read(id: string, opts: { lines?: number } = {}): Promise<ReadBuffer> {
    const result = (await this.request('terminal.read', {
      terminal: id,
      caller: this.env.terminalId,
      lines: Math.max(0, Math.floor(opts.lines ?? 0)),
    })) as { text?: unknown; complete?: unknown } | null;
    return { text: typeof result?.text === 'string' ? result.text : '', complete: result?.complete !== false };
  }

  watchChildren(): WorkerWatch {
    this.watch ??= new CoreWatch(this.env);
    return this.watch;
  }

  async waitForOutput(id: string, text: string, timeoutMs: number): Promise<WaitForOutputResult> {
    try {
      const result = (await this.request('terminal.wait', {
        terminal: id,
        caller: this.env.terminalId,
        output: text,
        timeout: Math.max(1, timeoutMs) / 1000,
      }, timeoutMs + WAIT_SLACK_MS)) as { ended?: boolean; reason?: string } | null;
      if (result?.reason === 'output') return { matched: true };
      if (!result || result.ended === false || result.reason === 'timeout') return { matched: false, reason: 'timeout' };
      return { matched: false, reason: 'unavailable' };
    } catch (err) {
      if (err instanceof CoreError) return { matched: false, reason: 'unavailable' };
      throw err;
    }
  }

  async kill(id: string): Promise<void> {
    try {
      await this.request('terminal.kill', { terminal: id, caller: this.env.terminalId }, 30_000);
    } catch (err) {
      if (isCoreErrorKind(err, 'not_found') || isCoreErrorKind(err, 'finished')) return;
      throw err;
    }
  }

  async remove(id: string): Promise<void> {
    try {
      await this.request('terminal.rm', { terminal: id, caller: this.env.terminalId });
    } catch (err) {
      if (isCoreErrorKind(err, 'not_found')) return;
      throw err;
    }
  }

  async serverVersion(): Promise<string | null> {
    try {
      const result = (await this.request('server.status', {})) as { version?: unknown } | null;
      return typeof result?.version === 'string' ? result.version : null;
    } catch {
      return null;
    }
  }
}

export function createCoreClient(
  env: NodeJS.ProcessEnv = process.env,
): { client: CoreClientLike; env: CoreEnv | null } {
  const detected = detectCoreEnv(env);
  if (!detected) return { client: new NoopCoreClient(), env: null };
  return { client: new CoreClient(detected), env: detected };
}
