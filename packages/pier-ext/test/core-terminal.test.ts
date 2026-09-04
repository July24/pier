/**
 * 档1 core/terminal 插件接线：surface 服务注入 + 单工具注册 + GC 槽回填 + ledger 墓碑。
 * 真实 cordis Context + 真 PiSurface（pi/client 为假件）——不活体，只验接线面。
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import terminalPlugin from '../src/core/terminal.ts';
import { PiSurface } from '../src/pi-surface.ts';
import { DisposeLedger } from '../src/ledger.ts';
import type { HerdrClientLike } from '../src/herdr-client.ts';

function fakePi() {
  // sent 走闭包而非 this：插件裸调用 sendMessage（const send = pi.sendMessage），this 会丢
  const sent = [] as Array<{ customType: string; content: string; display?: boolean }>;
  const entries = [] as Array<[string, unknown]>;
  return {
    sent,
    entries,
    tools: new Map<string, { execute?: (...a: unknown[]) => unknown }>(),
    listeners: new Map<string, Array<(...a: unknown[]) => unknown>>(),
    registerTool(def: { name: string; execute?: (...a: unknown[]) => unknown }) {
      this.tools.set(def.name, def);
    },
    on(event: string, handler: (...a: unknown[]) => unknown) {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), handler]);
    },
    appendEntry(customType: string, data: unknown) {
      entries.push([customType, data]);
    },
    sendMessage(message: { customType: string; content: string; display?: boolean }) {
      sent.push(message);
      return Promise.resolve();
    },
  };
}

function fakeClient(): HerdrClientLike {
  return {
    available: true,
    splitPane: async () => 'pane-2',
    waitForOutput: async () => true,
    readPane: async () => ({ text: '$ ', revision: 1, truncated: false }),
    sendPaneText: async () => undefined,
    sendPaneKeys: async () => undefined,
    closePane: async () => undefined,
    listPanes: async () => [{ paneId: 'pane-2', tabId: 't1', agentStatus: 'idle' }],
  } as unknown as HerdrClientLike;
}

const TOOL_NAME = 'terminal';

test('core/terminal：surface 挂载 terminal 工具 + GC 槽回填 + open/list 链路', async () => {
  const pi = fakePi();
  const ledger = new DisposeLedger();
  const surface = new PiSurface(pi as unknown as object, ledger);
  const deps = {
    client: fakeClient(),
    env: { paneId: 'p1', tabId: 't1' },
    state: { activePaneIds: (): Set<string> => new Set() },
  };
  const ctx = new Context();
  ctx.provide('pi-herdr.surface', surface);
  ctx.provide('pi-herdr.terminal-deps', deps);
  await ctx.plugin(terminalPlugin);

  assert.ok(pi.tools.has(TOOL_NAME), 'terminal 应注册');
  assert.ok(!pi.tools.has('terminal_open'), '旧分工具名不应再注册');
  assert.equal(deps.state.activePaneIds().size, 0, '初始无终端');

  const open = await pi.tools.get(TOOL_NAME)?.execute?.(null, { action: 'open' }, undefined, undefined, { cwd: 'F:/w' }) as {
    content: Array<{ text: string }>;
    details: { terminal_id: string; pane_id: string; readiness: string };
  };
  assert.match(open.content[0].text, /terminal term-1 open \(pane pane-2\)/);
  assert.equal(open.details.readiness, 'prompt');
  assert.ok(deps.state.activePaneIds().has('pane-2'), 'GC 槽回填：活跃终端 pane 可查');
  assert.ok(pi.entries.some(([t]) => t === 'pi-herdr.terminals'), '注册表持久化条目已 append');

  const list = await pi.tools.get(TOOL_NAME)?.execute?.(null, { action: 'list' }) as { content: Array<{ text: string }> };
  assert.match(list.content[0].text, /term-1 \[open\] pane=pane-2/);

  const bad = await pi.tools.get(TOOL_NAME)?.execute?.(null, { action: 'explode' }) as { content: Array<{ text: string }> };
  assert.match(bad.content[0].text, /unknown action "explode"/);
  await ctx.fiber.dispose();
});

test('core/terminal：ledger.disposeKey(本文件) → 工具墓碑 inert（hmr 补偿路径）', async () => {
  const pi = fakePi();
  const ledger = new DisposeLedger();
  const surface = new PiSurface(pi as unknown as object, ledger);
  const deps = {
    client: fakeClient(),
    env: { paneId: 'p1', tabId: 't1' },
    state: { activePaneIds: (): Set<string> => new Set() },
  };
  const ctx = new Context();
  ctx.provide('pi-herdr.surface', surface);
  ctx.provide('pi-herdr.terminal-deps', deps);
  await ctx.plugin(terminalPlugin);

  // hmr/reload 会报插件文件路径——账本规范化后命中模块 key
  const n = ledger.disposeKey(new URL('../src/core/terminal.ts', import.meta.url).href);
  assert.equal(n, 1, '账本命中 terminal 模块登记');
  const r = await pi.tools.get(TOOL_NAME)?.execute?.(null, { action: 'list' }) as { content: Array<{ text: string }> };
  assert.match(r.content[0].text, /disposed/, '墓碑后工具 inert');
  await ctx.fiber.dispose();
});

async function mountTerminal(client: HerdrClientLike) {
  const pi = fakePi();
  const ledger = new DisposeLedger();
  const surface = new PiSurface(pi as unknown as object, ledger);
  const deps = {
    client,
    env: { paneId: 'p1', tabId: 't1' },
    state: { activePaneIds: (): Set<string> => new Set() },
  };
  const ctx = new Context();
  ctx.provide('pi-herdr.surface', surface);
  ctx.provide('pi-herdr.terminal-deps', deps);
  await ctx.plugin(terminalPlugin);
  return { pi, deps, ctx };
}

test('core/terminal：session_shutdown 关停全部 open terminal（防泄漏）', async () => {
  const closeCalls: string[] = [];
  const client = fakeClient();
  client.closePane = async (paneId: string) => { closeCalls.push(paneId); };
  const { pi, deps, ctx } = await mountTerminal(client);

  await pi.tools.get(TOOL_NAME)?.execute?.(null, { action: 'open' }, undefined, undefined, { cwd: 'F:/w' });
  assert.ok(deps.state.activePaneIds().has('pane-2'), '前置：open 已登记');

  const shutdown = pi.listeners.get('session_shutdown') ?? [];
  assert.ok(shutdown.length >= 1, 'shutdown 处理器已注册');
  await shutdown[0]?.(undefined);

  assert.deepEqual(closeCalls, ['pane-2'], '驻留 shell 被 closePane 回收');
  assert.equal(deps.state.activePaneIds().size, 0, 'GC 槽不再保护已关 pane');
  const registry = [...pi.entries].reverse().find(([t]) => t === 'pi-herdr.terminals')?.[1] as {
    terminals: Array<{ status: string; closedAt: number | null }>;
  };
  assert.equal(registry.terminals[0].status, 'closed', '台账落 closed');
  assert.ok(registry.terminals[0].closedAt != null);
  await ctx.fiber.dispose();
});

test('core/terminal：agent_settled 催办闲置 terminal，进程级上限生效', async () => {
  const prevIdle = process.env.PI_HERDR_TERM_IDLE_MS;
  const prevGrace = process.env.PI_HERDR_TERM_GRACE_MS;
  process.env.PI_HERDR_TERM_IDLE_MS = '1';
  process.env.PI_HERDR_TERM_GRACE_MS = '5';
  // Date 一并假化：tick 精确制造闲置时长，杜绝真实时钟的毫秒竞态
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const { pi, ctx } = await mountTerminal(fakeClient());
    await pi.tools.get(TOOL_NAME)?.execute?.(null, { action: 'open' }, undefined, undefined, { cwd: 'F:/w' });
    const settled = (pi.listeners.get('agent_settled') ?? [])[0] as (() => Promise<void>) | undefined;
    const settle = async () => {
      mock.timers.tick(50); // 制造 ≥ 阈值的闲置时长
      await settled?.(undefined);
      mock.timers.tick(5); // grace 到点
      await new Promise<void>((resolve) => setImmediate(resolve)); // 排空异步投递
    };

    await settle();
    assert.equal(pi.sent.length, 1, '首次闲置催办注入');
    assert.equal(pi.sent[0]?.customType, 'pi-herdr.term-reminder');
    assert.match(pi.sent[0]?.content ?? '', /term-1/);

    await settle();
    assert.equal(pi.sent.length, 2, '第二次催办（上限内）');

    await settle();
    assert.equal(pi.sent.length, 2, '达到 TERM_REMINDERS_MAX 后不再催办');
  } finally {
    mock.timers.reset();
    if (prevIdle === undefined) delete process.env.PI_HERDR_TERM_IDLE_MS;
    else process.env.PI_HERDR_TERM_IDLE_MS = prevIdle;
    if (prevGrace === undefined) delete process.env.PI_HERDR_TERM_GRACE_MS;
    else process.env.PI_HERDR_TERM_GRACE_MS = prevGrace;
  }
});
