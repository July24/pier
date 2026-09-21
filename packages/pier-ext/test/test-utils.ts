/**
 * Shared test fixtures: temp/env lifecycle, the pi surface fake, the herdr client fake, and the
 * cordis mount for the subagent plugin family.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import type { HerdrClientLike } from '../src/herdr-client.ts';
import { PiSurface } from '../src/pi-surface.ts';
import type { DisposeLedger } from '../src/ledger.ts';
import subagentPlugin from '../src/plugins/subagent.ts';
import { SUBS_CUSTOM_TYPE, emptySubagentPortBox, type SubEntry, type SubagentPortBox } from '../src/subagent-core.ts';

/* ── temp dirs and env ──────────────────────────────────────────── */

export class TempDir {
  readonly path: string;

  constructor(prefix: string) {
    this.path = mkdtempSync(join(tmpdir(), `pier-test-${prefix}-`));
  }

  dispose(): void {
    rmSync(this.path, { recursive: true, force: true });
  }
}

export class EnvSnapshot {
  private readonly snapshot = new Map<string, string | undefined>();

  set(key: string, value: string): void {
    this.remember(key);
    process.env[key] = value;
  }

  delete(key: string): void {
    this.remember(key);
    delete process.env[key];
  }

  private remember(key: string): void {
    if (!this.snapshot.has(key)) this.snapshot.set(key, process.env[key]);
  }

  dispose(): void {
    for (const [key, original] of this.snapshot) {
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
    this.snapshot.clear();
  }
}

export interface CleanupContext {
  tempDir(prefix: string): TempDir;
  env(): EnvSnapshot;
}

/** Wraps a test body so temp dirs and env mutations are undone even when it throws. */
export function withCleanup<T>(fn: (cleanup: CleanupContext) => T | Promise<T>): () => T | Promise<T> {
  return async () => {
    const tempDirs: TempDir[] = [];
    const envSnapshots: EnvSnapshot[] = [];
    const cleanup: CleanupContext = {
      tempDir: (prefix) => {
        const dir = new TempDir(prefix);
        tempDirs.push(dir);
        return dir;
      },
      env: () => {
        const env = new EnvSnapshot();
        envSnapshots.push(env);
        return env;
      },
    };
    try {
      return await fn(cleanup);
    } finally {
      for (const env of envSnapshots.reverse()) env.dispose();
      for (const dir of tempDirs.reverse()) dir.dispose();
    }
  };
}

export class TempHome {
  readonly path: string;
  private readonly previous: string | undefined;

  constructor(prefix: string) {
    this.path = new TempDir(prefix).path;
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

/* ── pi surface fake ────────────────────────────────────────────── */

export interface ToolDef {
  name: string;
  execute?: (...a: unknown[]) => unknown;
  promptSnippet?: string;
  promptGuidelines?: string[];
  prepareArguments?: (args: unknown) => Record<string, unknown>;
  [key: string]: unknown;
}

export interface CommandDef {
  handler?: (...a: unknown[]) => unknown;
  [key: string]: unknown;
}

export type PiHandler = (...a: unknown[]) => unknown;
export interface SentMessage {
  msg: { customType?: string; content?: unknown; display?: boolean };
  opts?: { deliverAs?: string; triggerTurn?: boolean };
}
export interface FakeEventBus {
  emitted: Array<{ channel: string; data: unknown }>;
  on(channel: string, handler: PiHandler): () => void;
  emit(channel: string, data: unknown): void;
}

export interface FakePi {
  tools: Map<string, ToolDef>;
  commands: Map<string, CommandDef>;
  listeners: Map<string, PiHandler[]>;
  entries: Array<[string, unknown]>;
  sent: SentMessage[];
  userSent: Array<{ content: string; opts?: unknown }>;
  events: FakeEventBus;
  registerTool(def: ToolDef): void;
  registerCommand(name: string, def: CommandDef): void;
  on(event: string, handler: PiHandler): void;
  appendEntry(customType: string, data: unknown): void;
  sendMessage(msg: SentMessage['msg'], opts?: SentMessage['opts']): Promise<void>;
  sendUserMessage(content: unknown, opts?: unknown): Promise<void>;
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
}

/**
 * Superset fake of the pi ExtensionAPI surface. Every plugin reaches the host through a few
 * methods only, so one permissive object serves all of them; `sendMessage` records into the
 * closure because plugins call it unbound (`const send = pi.sendMessage`).
 */
export function fakePi(): FakePi {
  const tools = new Map<string, ToolDef>();
  const listeners = new Map<string, PiHandler[]>();
  const bus = new Map<string, PiHandler[]>();
  const sent: SentMessage[] = [];
  const userSent: Array<{ content: string; opts?: unknown }> = [];
  const entries: Array<[string, unknown]> = [];
  return {
    tools,
    commands: new Map<string, CommandDef>(),
    listeners,
    entries,
    sent,
    userSent,
    events: {
      emitted: [],
      on(channel, handler) {
        bus.set(channel, [...(bus.get(channel) ?? []), handler]);
        return () => {
          bus.set(channel, (bus.get(channel) ?? []).filter((h) => h !== handler));
        };
      },
      emit(channel, data) {
        this.emitted.push({ channel, data });
        for (const h of bus.get(channel) ?? []) h(data);
      },
    },
    registerTool(def) {
      tools.set(def.name, def);
    },
    registerCommand(name, def) {
      this.commands.set(name, def);
    },
    on(event, handler) {
      listeners.set(event, [...(listeners.get(event) ?? []), handler]);
    },
    appendEntry(customType, data) {
      entries.push([customType, data]);
    },
    sendMessage(msg, opts) {
      sent.push({ msg, opts });
      return Promise.resolve();
    },
    sendUserMessage(content, opts) {
      userSent.push({ content: String(content ?? ''), opts });
      return Promise.resolve();
    },
    getActiveTools() {
      return [...tools.keys()];
    },
    setActiveTools() {},
  };
}

/** Invokes every handler registered for `event`, awaiting each in turn. */
export async function fire(pi: FakePi, event: string, ...args: unknown[]): Promise<void> {
  for (const handler of pi.listeners.get(event) ?? []) await handler(...args);
}

/* ── herdr client fake ──────────────────────────────────────────── */

/**
 * HerdrClientLike with inert defaults; pass only the methods a test cares about. `available`
 * defaults to true.
 */
export function fakeHerdr(over: Partial<HerdrClientLike> = {}): HerdrClientLike {
  return {
    available: true,
    reportAgent: async () => undefined,
    reportMetadata: async () => undefined,
    reportLockTokens: async () => undefined,
    reportDisplayAgent: async () => undefined,
    reportAskFlag: async () => undefined,
    listAgents: async () => [],
    sendPaneText: async () => undefined,
    waitAgent: async () => null,
    getAgentSessionPath: async () => null,
    splitPane: async () => 'p2',
    closePane: async () => undefined,
    createTab: async () => ({ tabId: 't9', paneId: 'p9' }),
    listPanes: async () => [],
    exportLayout: async () => null,
    paneLayout: async () => null,
    tabList: async () => [],
    tabClose: async () => undefined,
    openPluginPane: async () => ({ mode: 'popup', ok: true }),
    agentExplain: async () => null,
    getServerVersion: async () => null,
    sendPaneKeys: async () => undefined,
    readPane: async () => ({ text: '', revision: 0, truncated: false }),
    readAgent: async () => ({ text: '', revision: 0, truncated: false }),
    waitForOutput: async () => ({ matched: false, reason: 'timeout' }),
    close: () => undefined,
    ...over,
  };
}

/* ── subagent registry + mount ──────────────────────────────────── */

export function subEntry(over: Partial<SubEntry> = {}): SubEntry {
  return {
    taskId: 'task-1',
    kind: 'task',
    paneId: 'w1:p2',
    tabId: 't0',
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
export function subsBranch(subs: SubEntry[]): never {
  return [{ type: 'custom', customType: SUBS_CUSTOM_TYPE, data: { version: 2, subs } }] as never;
}

/** The registry snapshot the plugin most recently appended. */
export function subsSnapshot(pi: FakePi): { subs: SubEntry[] } | undefined {
  return pi.entries.filter(([type]) => type === SUBS_CUSTOM_TYPE).at(-1)?.[1] as { subs: SubEntry[] } | undefined;
}

export interface SubagentMount {
  root: Context;
  pi: FakePi;
  port: SubagentPortBox;
  client: HerdrClientLike;
}

export interface SubagentMountOptions {
  pi?: FakePi;
  client?: Partial<HerdrClientLike>;
  ledger?: DisposeLedger;
  /** Seeds the registry through a session_start branch lookup. */
  subs?: SubEntry[];
  env?: { paneId?: string; tabId?: string; workspaceId?: string };
  extPath?: string;
  deps?: Record<string, unknown>;
}

/** Mounts the subagent plugin against fakes, wiring the same deps index.ts provides. */
export async function mountSubagent(opts: SubagentMountOptions = {}): Promise<SubagentMount> {
  const pi = opts.pi ?? fakePi();
  const client = fakeHerdr(opts.client);
  const port = emptySubagentPortBox();
  const root = new Context();
  root.provide('pi-herdr.surface', new PiSurface(pi as unknown as object, opts.ledger));
  root.provide('pi-herdr.subagent-deps', {
    client,
    env: { paneId: 'p0', tabId: 't0', workspaceId: 'w1', ...opts.env },
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

/* ── session transcripts ────────────────────────────────────────── */

/** JSONL body for pi session transcripts. */
export function jsonl(...lines: unknown[]): string {
  return lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
}

/** One pi session transcript message. */
export function transcriptMessage(role: string, text: string, timestamp: number, stopReason = 'stop'): unknown {
  return { type: 'message', message: { role, content: [{ type: 'text', text }], timestamp, stopReason } };
}
