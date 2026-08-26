/**
 * subagent spawn 行为回归（session 01a03bf0 实证双缺陷）：
 *  1. ecc0bc4 误删 prompt 注入块 → `injectTs is not defined`（spawn-failed）+
 *     台账幽灵 running 条目 + 子 pane 无任务上下文；
 *  2. spawn 中途失败不回收台账/pane → D96 提醒风暴 + send_message 打到空会话。
 * 缝：subagent 工具 execute（真 pipe 服务器 + 全假件 client/env）。
 * 时序关键：子会话定稿文本由 pipe sim 在收到 prompt 后写入（timestamp ≥ injectTs，
 * 过 lastAssistantText 的 sinceTs 过滤）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import { mkdtempSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import subagentPlugin from '../src/core/subagent.ts';
import { PiSurface } from '../src/pi-surface.ts';
import { pipeNameFor, pipePathFor, type PipeRequest } from '../src/pipe-channel.ts';
import { TodosService } from '../src/todos-service.ts';
import type { HerdrClientLike } from '../src/herdr-client.ts';

const SUB_TEXT = 'REPORT: all channel-fee contact points mapped';
const PROMPT = '你在 apnv3-backend 仓库探查渠道费用触点（只读）。输出完整报告。';

interface FakePi {
  tools: Map<string, { execute?: (...a: unknown[]) => unknown }>;
  listeners: Map<string, Array<(...a: unknown[]) => unknown>>;
  entries: Array<[string, unknown]>;
  registerTool(def: { name: string; execute?: (...a: unknown[]) => unknown }): void;
  on(event: string, handler: (...a: unknown[]) => unknown): void;
  appendEntry(customType: string, data: unknown): void;
}

interface Slots {
  listRunningSubs: (() => Array<{ paneId: string; description: string }>) | null;
}

interface Harness {
  closePaneCalls: string[];
  prompts: PipeRequest[];
  /** pipe sim 收到 prompt 时回调（写子会话定稿文本，模拟子代理即时产出）。 */
  onPrompt?: () => void;
}

function fakePi(): FakePi {
  return {
    tools: new Map<string, { execute?: (...a: unknown[]) => unknown }>(),
    listeners: new Map<string, Array<(...a: unknown[]) => unknown>>(),
    entries: [] as Array<[string, unknown]>,
    registerTool(def: { name: string; execute?: (...a: unknown[]) => unknown }) {
      this.tools.set(def.name, def);
    },
    on(event: string, handler: (...a: unknown[]) => unknown) {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), handler]);
    },
    appendEntry(customType: string, data: unknown) {
      this.entries.push([customType, data]);
    },
  };
}

/** 可配置假 client：p0=master（t0）；splitPane → p2。 */
function fakeClient(sessionFile: string, h: Harness): HerdrClientLike {
  return {
    available: true,
    tabList: async () => [{ tabName: 'main', tabId: 't0', workspaceId: 'w1', label: 'main' }],
    listPanes: async () => [
      { paneId: 'p0', tabId: 't0', agentStatus: 'working' },
      { paneId: 'p2', tabId: 't0', agentStatus: 'idle' },
    ],
    listAgents: async () => [],
    waitAgent: async () => 'idle',
    getAgentSessionPath: async () => sessionFile,
    createTab: async () => ({ tabId: 't9', paneId: 'p9' }),
    splitPane: async () => 'p2',
    sendPaneText: async () => undefined,
    exportLayout: async () => {
      throw new Error('layout export unavailable in test');
    },
    tabClose: async () => undefined,
    closePane: async (paneId: string) => {
      h.closePaneCalls.push(paneId);
    },
  } as unknown as HerdrClientLike;
}

/** 真 pipe 服务器（一连接一请求；prompt 可配置 ok/reject，可选 onPrompt 回调）。 */
async function startPipeSim(cwd: string, h: Harness, opts: { rejectPrompt?: boolean }): Promise<net.Server> {
  const sockPath = pipePathFor(pipeNameFor(cwd, 'p2'));
  try {
    if (existsSync(sockPath)) unlinkSync(sockPath);
  } catch { /* 残留清理尽力而为 */ }
  const server = net.createServer((sock) => {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => {
      buf += chunk;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      const req = JSON.parse(buf.slice(0, i)) as PipeRequest;
      buf = '';
      const isPrompt = req.type === 'prompt' || req.type === 'follow_up';
      if (isPrompt) {
        h.prompts.push(req);
        h.onPrompt?.();
      }
      const reject = isPrompt && opts.rejectPrompt;
      const res = reject
        ? { type: 'error' as const, id: req.id, message: 'sim rejected' }
        : { type: 'ok' as const, id: req.id };
      sock.write(JSON.stringify(res) + '\n');
    });
  });
  const { promise, resolve } = Promise.withResolvers<void>();
  server.listen(sockPath, () => resolve());
  await promise;
  return server;
}

async function mountSpawn(pi: FakePi, sessionFile: string, h: Harness): Promise<{ root: Context; slots: Slots }> {
  const surface = new PiSurface(pi as unknown as object);
  const slots: Slots = { listRunningSubs: null };
  const root = new Context();
  const deps = {
    client: fakeClient(sessionFile, h),
    env: { paneId: 'p0', tabId: 't0', workspaceId: 'w1' },
    extPath: new URL('../src/index.ts', import.meta.url).pathname,
    sessionRoot: root,
    slots,
    getSessionId: () => '',
    getBlockedDepth: () => 0,
    reconcileOnSettlement: () => [],
    withReconcileNotes: (b: string) => b,
    claimSettleNotice: () => true,
    terminalState: { activePaneIds: () => new Set<string>() },
    todos: new TodosService({ strict: false, allowParallelInProgress: true }),
  };
  root.provide('pi-herdr.surface', surface);
  root.provide('pi-herdr.subagent-deps', deps);
  await root.plugin(subagentPlugin);
  return { root, slots };
}

interface SpawnCtx {
  pi: FakePi;
  slots: Slots;
  h: Harness;
  cwd: string;
}

async function withSpawnEnv(fn: (ctx: SpawnCtx) => Promise<void>, opts: { rejectPrompt?: boolean } = {}): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'pier-spawn-home-'));
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = home; // 台账/会话扫描根重定向（不污染 ~/.pi）
  const cwd = mkdtempSync(join(tmpdir(), 'pier-spawn-cwd-'));
  const sessionFile = join(cwd, 'sub-session.jsonl');
  const h: Harness = {
    closePaneCalls: [],
    prompts: [],
    // 子代理产出模拟：prompt 注入后写定稿文本（ts ≥ injectTs）
    onPrompt: opts.rejectPrompt ? undefined : () => writeFileSync(sessionFile, JSON.stringify({
      type: 'message',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: SUB_TEXT }],
        timestamp: Date.now(),
        stopReason: 'stop',
      },
    }) + '\n'),
  };
  const server = await startPipeSim(cwd, h, opts);
  const pi = fakePi();
  const mounted = await mountSpawn(pi, sessionFile, h);
  try {
    await fn({ pi, slots: mounted.slots, h, cwd });
  } finally {
    await mounted.root.fiber.dispose();
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    await closed.promise;
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
  }
}

test('spawn 回归（01a03bf0 缺陷 1）：prompt 必须注入 + 无 ReferenceError + 正常结算', async () => {
  await withSpawnEnv(async ({ pi, slots, h, cwd }) => {
    const tool = pi.tools.get('subagent');
    assert.ok(tool?.execute, 'subagent 工具已注册');
    const r = await tool.execute!('tc1', { description: '探查', prompt: PROMPT }, undefined, undefined, { cwd }) as {
      content: Array<{ text: string }>;
    };
    const text = r.content[0].text;
    assert.ok(!/injectTs is not defined/.test(text), `不出现 ReferenceError：${text}`);
    assert.ok(!/failed to spawn/.test(text), `不出现 spawn-failed：${text}`);
    assert.match(text, /REPORT: all channel-fee contact points mapped/);
    assert.equal(h.prompts.length, 1, 'prompt 恰好注入一次');
    assert.equal((h.prompts[0] as { text?: string }).text, PROMPT, 'prompt 全文注入');
    assert.equal((h.prompts[0] as { push?: boolean }).push, false, '前台 push=false');
    assert.deepEqual(slots.listRunningSubs?.() ?? [], [], '无幽灵 running 条目');
  });
});

test('spawn 回归（01a03bf0 缺陷 2）：pipe 拒绝 → 台账回收 + 关 pane + spawn-failed 文案', async () => {
  await withSpawnEnv(async ({ pi, slots, h, cwd }) => {
    const tool = pi.tools.get('subagent');
    assert.ok(tool?.execute);
    const r = await tool.execute!('tc2', { description: '探查', prompt: PROMPT }, undefined, undefined, { cwd }) as {
      content: Array<{ text: string }>;
    };
    const text = r.content[0].text;
    assert.match(text, /failed to spawn/);
    assert.match(text, /sim rejected/);
    assert.deepEqual(h.closePaneCalls, ['p2'], '失败 pane 必须关闭');
    assert.deepEqual(slots.listRunningSubs?.() ?? [], [], '台账无幽灵条目');
    const subsEntries = pi.entries.filter(([t]) => t === 'pi-herdr.subs');
    assert.ok(subsEntries.length > 0, '台账有写入');
    const last = subsEntries[subsEntries.length - 1][1] as { subs?: Array<{ paneId: string; status: string }> };
    assert.ok(!last.subs?.some((s) => s.paneId === 'p2'), '最后的台账快照已回收 p2');
  }, { rejectPrompt: true });
});
