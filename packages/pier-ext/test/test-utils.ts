/** Shared fixtures: temp/env lifecycle, the pi surface and client fakes, the subagent plugin mount. */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { cordisProvide } from '../src/cordis-services.ts';
import type { CoreClientLike, CoreEnv, TerminalInfo, WorkerWatch } from '../src/core-client.ts';
import { PiSurface } from '../src/pi-surface.ts';
import type { DisposeLedger } from '../src/ledger.ts';
import subagentPlugin from '../src/plugins/subagent.ts';
import type { SubagentDeps } from '../src/plugins/subagent.ts';
import { SUBS_CUSTOM_TYPE, emptySubagentPortBox, type SubEntry, type SubagentPortBox } from '../src/subagent-core.ts';

export interface CleanupContext {
  /** Temp dir removed when the test body settles. */
  tempDir(prefix: string): { readonly path: string; dispose(): void };
  env(): { set(key: string, value: string): void; delete(key: string): void };
}

/** Wraps a test body so temp dirs and env mutations are undone even when it throws. */
export function withCleanup<T>(fn: (cleanup: CleanupContext) => T | Promise<T>): () => T | Promise<T> {
  return async () => {
    const dirs: Array<{ path: string; dispose(): void }> = [];
    const envs: Array<Map<string, string | undefined>> = [];
    const cleanup: CleanupContext = {
      tempDir: (prefix) => {
        const path = mkdtempSync(join(tmpdir(), `pier-test-${prefix}-`));
        const dir = { path, dispose: () => rmSync(path, { recursive: true, force: true }) };
        dirs.push(dir);
        return dir;
      },
      env: () => {
        const orig = new Map<string, string | undefined>();
        const remember = (key: string): void => {
          if (!orig.has(key)) orig.set(key, process.env[key]);
        };
        envs.push(orig);
        return {
          set: (key, value) => {
            remember(key);
            process.env[key] = value;
          },
          delete: (key) => {
            remember(key);
            delete process.env[key];
          },
        };
      },
    };
    try {
      return await fn(cleanup);
    } finally {
      for (const orig of envs.reverse()) {
        for (const [key, value] of orig) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
      for (const dir of dirs.reverse()) dir.dispose();
    }
  };
}

export class TempHome {
  readonly path: string;
  private readonly previous: string | undefined;

  constructor(prefix: string) {
    this.path = mkdtempSync(join(tmpdir(), `pier-test-${prefix}-`));
    this.previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = this.path;
  }

  /** Creates (and returns) a directory under the temp home, e.g. `sessions/<flattened-cwd>`. */
  dir(...segments: string[]): string {
    const dir = join(this.path, ...segments);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  dispose(): void {
    if (this.previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = this.previous;
    rmSync(this.path, { recursive: true, force: true });
  }
}

export type PiHandler = (...a: unknown[]) => unknown;
type ToolDef = {
  name: string;
  execute?: PiHandler;
  promptSnippet?: string;
  promptGuidelines?: string[];
  prepareArguments?: (args: unknown) => Record<string, unknown>;
  [key: string]: unknown;
};
type CommandDef = { handler?: PiHandler; [key: string]: unknown };
type SentMessage = { msg: { customType?: string; content?: unknown; display?: boolean }; opts?: Record<string, unknown> };

/** Superset fake of the pi ExtensionAPI surface. */
export interface FakePi {
  tools: Map<string, ToolDef>;
  commands: Map<string, CommandDef>;
  listeners: Map<string, PiHandler[]>;
  entries: Array<[string, unknown]>;
  sent: SentMessage[];
  userSent: Array<{ content: string; opts?: unknown }>;
  events: {
    emitted: Array<{ channel: string; data: unknown }>;
    on(channel: string, handler: PiHandler): () => void;
    emit(channel: string, data: unknown): void;
  };
  registerTool(def: ToolDef): void;
  registerCommand(name: string, def: CommandDef): void;
  on(event: string, handler: PiHandler): void;
  appendEntry(customType: string, data: unknown): void;
  /** pi's API is fire-and-forget: both return void, so a `.then`/`await` on them is a bug, not a no-op. */
  sendMessage(msg: SentMessage['msg'], opts?: Record<string, unknown>): void;
  sendUserMessage(content: unknown, opts?: unknown): void;
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
  /** Registration surface consumed by the role runtime's switch path (`planSwitchActiveTools`). */
  getAllTools(): Array<{ name: string }>;
  /** Current session thinking level (default `high`); `thinkingSets` records each `setThinkingLevel`. */
  thinkingLevel: string;
  thinkingSets: string[];
  getThinkingLevel(): string;
  setThinkingLevel(level: string): void;
}

/**
 * `sendMessage` closes over its record array because plugins call it unbound
 * (`const send = pi.sendMessage`).
 */
export function fakePi(): FakePi {
  const tools = new Map<string, ToolDef>();
  const listeners = new Map<string, PiHandler[]>();
  const commands = new Map<string, CommandDef>();
  const bus = new Map<string, PiHandler[]>();
  const sent: SentMessage[] = [];
  const userSent: Array<{ content: string; opts?: unknown }> = [];
  const entries: Array<[string, unknown]> = [];
  const emitted: Array<{ channel: string; data: unknown }> = [];
  const thinkingSets: string[] = [];
  return {
    tools,
    commands,
    listeners,
    entries,
    sent,
    userSent,
    events: {
      emitted,
      on(channel, handler) {
        bus.set(channel, [...(bus.get(channel) ?? []), handler]);
        return () => {
          bus.set(channel, (bus.get(channel) ?? []).filter((h) => h !== handler));
        };
      },
      emit(channel, data) {
        emitted.push({ channel, data });
        for (const handler of bus.get(channel) ?? []) handler(data);
      },
    },
    registerTool(def) {
      tools.set(def.name, def);
    },
    registerCommand(name, def) {
      commands.set(name, def);
    },
    on(event, handler) {
      listeners.set(event, [...(listeners.get(event) ?? []), handler]);
    },
    appendEntry(customType, data) {
      entries.push([customType, data]);
    },
    sendMessage(msg, opts) {
      sent.push({ msg, opts });
    },
    sendUserMessage(content, opts) {
      userSent.push({ content: String(content ?? ''), opts });
    },
    getActiveTools: () => [...tools.keys()],
    setActiveTools: () => undefined,
    getAllTools: () => [...tools.keys()].map((name) => ({ name })),
    thinkingLevel: 'high',
    thinkingSets,
    getThinkingLevel() {
      return this.thinkingLevel;
    },
    setThinkingLevel(level) {
      this.thinkingLevel = level;
      thinkingSets.push(level);
    },
  };
}

/** Invokes every handler registered for `event`, awaiting each in turn. */
export async function fire(pi: FakePi, event: string, ...args: unknown[]): Promise<void> {
  for (const handler of pi.listeners.get(event) ?? []) await handler(...args);
}

/** A TerminalInfo record with inert defaults. */
export function terminalInfo(over: Partial<TerminalInfo> = {}): TerminalInfo {
  return {
    id: 't2',
    name: null,
    state: 'live',
    status: 'unknown',
    statusKind: null,
    statusMsg: null,
    statusApp: null,
    labels: {},
    parent: null,
    cwd: '/test/cwd',
    foreground: null,
    exitCode: null,
    reason: null,
    turn: 0,
    title: '',
    ...over,
  };
}

/**
 * WorkerWatch over test-controlled terminals. `park(ms)` stands in for waiting on an event: it decides
 * whether the wait ends by a change (true) or by its timeout (false); the default is a timeout, so a
 * loop under test advances only as far as the test's own clock does.
 */
export function fakeWatch(opts: {
  terminals?: () => readonly TerminalInfo[];
  connected?: boolean;
  park?: (ms: number) => boolean | Promise<boolean>;
} = {}): WorkerWatch & { parks: number[] } {
  const parks: number[] = [];
  let version = 0;
  return {
    parks,
    connected: opts.connected ?? true,
    ready: async () => opts.connected ?? true,
    get: (id) => opts.terminals?.().find((t) => t.id === id),
    list: () => [...(opts.terminals?.() ?? [])],
    version: () => version,
    changed: async (_id, _since, ms) => {
      parks.push(ms);
      const woke = await (opts.park?.(ms) ?? false);
      version += 1;
      return woke;
    },
    close: () => {},
  };
}

/** CoreClientLike with inert defaults; pass only the methods a test cares about. */
export function fakeCore(over: Partial<CoreClientLike> = {}): CoreClientLike {
  const noop = async () => undefined;
  return {
    available: true,
    setLabels: noop,
    placementLabels: async () => ({ 'herdr.space': 'sp0', 'herdr.tab': 'tb0' }),
    getTerminal: async () => null,
    listTerminals: async () => [],
    run: async (opts) => terminalInfo({ id: 't2', cwd: opts.cwd ?? '/test/cwd', labels: { ...opts.labels } }),
    send: noop,
    keys: noop,
    interrupt: async () => 'unknown',
    read: async () => ({ text: '', complete: true }),
    watchChildren: () => fakeWatch(),
    waitForOutput: async () => ({ matched: false, reason: 'timeout' }),
    kill: noop,
    remove: noop,
    serverVersion: async () => '0.1.16',
    ...over,
  };
}

export function subEntry(over: Partial<SubEntry> = {}): SubEntry {
  return {
    taskId: 'task-1',
    kind: 'task',
    paneId: 't2',
    tabId: 'tb0',
    tabName: 'main',
    cwd: '/test/cwd',
    description: 'test worker subagent',
    background: true,
    status: 'running',
    consumedAt: null,
    sessionFile: null,
    launchCommand: [],
    createdAt: Date.now(),
    revivedFrom: null,
    ...over,
  };
}

/** Custom-branch snapshot the plugin folds the registry from. */
function subsBranch(subs: SubEntry[]): never {
  return [{ type: 'custom', customType: SUBS_CUSTOM_TYPE, data: { version: 2, subs } }] as never;
}

/** The registry snapshot the plugin most recently appended. */
export function subsSnapshot(pi: FakePi): { subs: SubEntry[] } | undefined {
  return pi.entries.filter(([type]) => type === SUBS_CUSTOM_TYPE).at(-1)?.[1] as { subs: SubEntry[] } | undefined;
}

export interface SubagentMountOptions {
  pi?: FakePi;
  client?: Partial<CoreClientLike>;
  ledger?: DisposeLedger;
  /** Seeds the registry through a session_start branch lookup. */
  subs?: SubEntry[];
  env?: Partial<CoreEnv>;
  extPath?: string;
  deps?: Partial<SubagentDeps>;
}

export type SubagentMount = { root: Context; pi: FakePi; port: SubagentPortBox; client: CoreClientLike };

/** Mounts the subagent plugin against fakes, wiring the same deps index.ts provides. */
export async function mountSubagent(opts: SubagentMountOptions = {}): Promise<SubagentMount> {
  const pi = opts.pi ?? fakePi();
  const client = fakeCore(opts.client);
  const port = emptySubagentPortBox();
  const root = new Context();
  cordisProvide(root, 'pi-herdr.surface', new PiSurface(pi as unknown as object, opts.ledger));
  cordisProvide(root, 'pi-herdr.subagent-deps', {
    client,
    env: { socketPath: '/tmp/hc-test.sock', terminalId: 't0', ...opts.env },
    extPath: opts.extPath ?? new URL('../src/index.ts', import.meta.url).pathname,
    sessionRoot: root,
    port,
    getSessionId: () => '',
    reconcileOnSettlement: () => [],
    withReconcileNotes: (base: string) => base,
    claimSettleNotice: () => true,
    terminalState: { activePaneIds: () => new Set<string>() },
    ...opts.deps,
  });
  await root.plugin(subagentPlugin);
  if (opts.subs?.length) {
    await fire(pi, 'session_start', {}, { sessionManager: { getBranch: () => subsBranch(opts.subs!) } });
  }
  return { root, pi, port, client };
}

/** Runs the subagent tool with a call id and an optional cwd context. */
export function runSubagent(
  pi: FakePi,
  params: Record<string, unknown>,
  cwd?: string,
): Promise<{ content: Array<{ text: string }>; details?: Record<string, unknown> }> {
  const execute = pi.tools.get('subagent')!.execute!;
  return execute('tc', params, undefined, undefined, cwd === undefined ? undefined : { cwd }) as Promise<{
    content: Array<{ text: string }>;
    details?: Record<string, unknown>;
  }>;
}

export async function runSubagentRejects(pi: FakePi, params: Record<string, unknown>, cwd?: string): Promise<string> {
  try {
    await runSubagent(pi, params, cwd);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('expected the subagent tool to fail');
}

/** JSONL body for pi session transcripts. */
export function jsonl(...lines: unknown[]): string {
  return lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
}

/** One pi session transcript message. */
export function transcriptMessage(role: string, text: string, timestamp: number, stopReason = 'stop'): unknown {
  return { type: 'message', message: { role, content: [{ type: 'text', text }], timestamp, stopReason } };
}
