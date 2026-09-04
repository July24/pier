/**
 * 档1 core/terminal 插件接线：surface 服务注入 + 单工具注册 + GC 槽回填 + ledger 墓碑。
 * 真实 cordis Context + 真 PiSurface（pi/client 为假件）——不活体，只验接线面。
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import terminalPlugin from '../src/core/terminal.ts';
import {
  foldTerminalsRegistry,
  makeTerminalsRegistry,
  planIdleTerminalReminder,
  TERM_REMINDERS_MAX,
} from '../src/terminal-core.ts';
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

function fakeClient(overrides: {
  waitForOutput?: (paneId: string, match: { type: string; value: string }, timeoutMs: number) => Promise<boolean | null>;
} = {}) {
  const calls = {
    waitForOutput: [] as Array<{ paneId: string; match: unknown; timeoutMs: number }>,
    sendPaneText: [] as string[],
  };
  const client = {
    available: true,
    splitPane: async () => 'pane-2',
    waitForOutput: async (paneId: string, match: { type: string; value: string }, timeoutMs: number) => {
      calls.waitForOutput.push({ paneId, match, timeoutMs });
      return true;
    },
    readPane: async () => ({ text: '$ ', revision: 1, truncated: false }),
    sendPaneText: async (paneId: string, text: string) => { calls.sendPaneText.push(text); },
    sendPaneKeys: async () => undefined,
    closePane: async () => undefined,
    listPanes: async () => [{ paneId: 'pane-2', tabId: 't1', agentStatus: 'idle' }],
    ...overrides,
  } as unknown as HerdrClientLike;
  return { client, calls };
}

const TOOL_NAME = 'terminal';

test('core/terminal：surface 挂载 terminal 工具 + GC 槽回填 + open/list 链路', async () => {
  const pi = fakePi();
  const ledger = new DisposeLedger();
  const surface = new PiSurface(pi as unknown as object, ledger);
  const deps = {
    client: fakeClient().client,
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
    client: fakeClient().client,
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
  const client = fakeClient().client;
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

test('core/terminal：agent_settled 催办闲置 terminal——每个 terminal 只催一次（01a06ae3 循环守卫）', async (t) => {
  const prevIdle = process.env.PI_HERDR_TERM_IDLE_MS;
  const prevGrace = process.env.PI_HERDR_TERM_GRACE_MS;
  process.env.PI_HERDR_TERM_IDLE_MS = '1';
  process.env.PI_HERDR_TERM_GRACE_MS = '5';
  // Date 一并假化：tick 精确制造闲置时长，杜绝真实时钟的毫秒竞态
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const client = fakeClient().client;
    let splitSeq = 2;
    client.splitPane = async () => `pane-${splitSeq++}`;
    const { pi, deps, ctx } = await mountTerminal(client);
    const run = (params: Record<string, unknown>) =>
      pi.tools.get(TOOL_NAME)?.execute?.(null, params, undefined, undefined, { cwd: 'F:/w' });
    await run({ action: 'open' });
    await run({ action: 'open' });
    const settled = (pi.listeners.get('agent_settled') ?? [])[0] as (() => Promise<void>) | undefined;
    const settle = async () => {
      t.mock.timers.tick(50); // 制造 ≥ 阈值的闲置时长
      await settled?.(undefined);
      t.mock.timers.tick(5); // grace 到点
      await new Promise<void>((resolve) => setImmediate(resolve)); // 排空异步投递
    };

    await settle();
    assert.equal(pi.sent.length, 1, '首轮：两个闲置 terminal 合并注入一次催办');
    assert.match(pi.sent[0]?.content ?? '', /term-1/);
    assert.match(pi.sent[0]?.content ?? '', /term-2/);

    await settle();
    assert.equal(pi.sent.length, 1, '已催过的 terminal 不再催——告别循环不可能成立');

    await settle();
    assert.equal(pi.sent.length, 1);
    assert.deepEqual([...deps.state.activePaneIds()].sort(), ['pane-2', 'pane-3'], '催办只提醒，不关 pane');
  } finally {
    t.mock.timers.reset();
    if (prevIdle === undefined) delete process.env.PI_HERDR_TERM_IDLE_MS;
    else process.env.PI_HERDR_TERM_IDLE_MS = prevIdle;
    if (prevGrace === undefined) delete process.env.PI_HERDR_TERM_GRACE_MS;
    else process.env.PI_HERDR_TERM_GRACE_MS = prevGrace;
  }
});

test('core/terminal：wait 命中 → matched；超时 → 带尾部输出的 no match', async () => {
  const { client, calls } = fakeClient();
  const { pi, ctx } = await mountTerminal(client);
  await pi.tools.get(TOOL_NAME)?.execute?.(null, { action: 'open' }, undefined, undefined, { cwd: 'F:/w' });

  // open 的就绪探测是第一次 waitForOutput；wait 命中是第二次
  const hit = await pi.tools.get(TOOL_NAME)?.execute?.(null, {
    action: 'wait', terminal_id: 'term-1', pattern: 'TERM_DONE_', timeout_ms: 5000,
  }) as { content: Array<{ text: string }>; details: { matched: boolean } };
  assert.equal(hit.details.matched, true, '命中 → matched');
  assert.equal(calls.waitForOutput[1]?.paneId, 'pane-2');
  assert.deepEqual(calls.waitForOutput[1]?.match, { type: 'substring', value: 'TERM_DONE_' });

  client.waitForOutput = async (paneId: string, match: { type: string; value: string }, timeoutMs: number) => {
    calls.waitForOutput.push({ paneId, match, timeoutMs });
    return false; // 模拟超时无匹配
  };

  const miss = await pi.tools.get(TOOL_NAME)?.execute?.(null, {
    action: 'wait', terminal_id: 'term-1', pattern: 'never-appears', regex: true, timeout_ms: 5000,
  }) as { content: Array<{ text: string }>; details: { matched: boolean } };
  assert.equal(miss.details.matched, false);
  assert.match(miss.content[0].text, /no match within 5000ms/);
  assert.match(miss.content[0].text, /recent output tail/, '超时回带最近输出，免去盲目轮询');
  assert.equal(calls.waitForOutput[2]?.match.type, 'regex');

  const bad = await pi.tools.get(TOOL_NAME)?.execute?.(null, {
    action: 'wait', terminal_id: 'term-1', pattern: '(', regex: true,
  }) as { content: Array<{ text: string }> };
  assert.match(bad.content[0].text, /invalid regex/);
  await ctx.fiber.dispose();
});

test('core/terminal：send(wait_prompt) 就绪才发；busy 拒发不排队', async () => {
  const { client, calls } = fakeClient();
  const { pi, ctx } = await mountTerminal(client);
  await pi.tools.get(TOOL_NAME)?.execute?.(null, { action: 'open' }, undefined, undefined, { cwd: 'F:/w' });

  // waitForOutput=false 且 readPane 非 prompt → busy 拒发
  const busy = client as unknown as {
    waitForOutput: () => Promise<boolean>;
    readPane: () => Promise<{ text: string; revision: number; truncated: boolean }>;
  };
  busy.waitForOutput = async () => false;
  busy.readPane = async () => ({ text: 'compiling src/main.rs...', revision: 2, truncated: false });
  const refused = await pi.tools.get(TOOL_NAME)?.execute?.(null, {
    action: 'send', terminal_id: 'term-1', text: 'echo next', wait_prompt: true,
  }) as { content: Array<{ text: string }> };
  assert.match(refused.content[0].text, /text was NOT sent/);
  assert.match(refused.content[0].text, /busy/);
  assert.equal(calls.sendPaneText.length, 0, 'busy 时文本不入队');

  // 提示符就绪 → 正常发送
  busy.waitForOutput = async () => true;
  const ok = await pi.tools.get(TOOL_NAME)?.execute?.(null, {
    action: 'send', terminal_id: 'term-1', text: 'echo next', wait_prompt: true,
  }) as { content: Array<{ text: string }> };
  assert.match(ok.content[0].text, /sent to term-1/);
  assert.deepEqual(calls.sendPaneText, ['echo next']);
  await ctx.fiber.dispose();
});

test('planIdleTerminalReminder：闲置超阈值且未催过 → due；催过/未闲置/达上限 → 不催', () => {
  const term = (id: string, lastActivityAt: number, nudgedAt: number | null = null) => ({
    terminalId: id, cwd: `/w/${id}`, label: id, lastActivityAt, nudgedAt,
  });
  // 闲置 50ms、阈值 1ms、未催过 → due，ids 只含未催过的
  const p0 = planIdleTerminalReminder({ open: [term('term-1', 0), term('term-2', 5, 40)], now: 2_000_000, reminders: 0 });
  assert.equal(p0.due, true);
  assert.deepEqual(p0.ids, ['term-1'], '已催过的 term-2 不再列入');
  assert.match(p0.content ?? '', /term-1/);
  assert.doesNotMatch(p0.content ?? '', /term-2/);

  // 全部催过 → 不催
  const p1 = planIdleTerminalReminder({ open: [term('term-1', 0, 40)], now: 2_000_000, reminders: 1 });
  assert.equal(p1.due, false);

  // 未到阈值 → 不催（长跑 dev server 被触碰过就不会进催办）
  const p2 = planIdleTerminalReminder({ open: [term('term-1', 1_999_999)], now: 2_000_000, reminders: 0 });
  assert.equal(p2.due, false);

  // 进程级上限兜底
  const p3 = planIdleTerminalReminder({ open: [term('term-1', 0)], now: 2_000_000, reminders: TERM_REMINDERS_MAX });
  assert.equal(p3.due, false);
});

test('foldTerminalsRegistry：nudgedAt 往返持久化，缺省为 null', () => {
  const registry = makeTerminalsRegistry([
    { terminalId: 'term-1', paneId: 'p1', tabId: 't1', cwd: '/w', label: null, createdAt: 1, lastActivityAt: 2, nudgedAt: 40, status: 'open', closedAt: null, readRevision: null, readLen: 0, readTail: '', readEoTail: '' },
    { terminalId: 'term-2', paneId: 'p2', tabId: 't1', cwd: '/w', label: null, createdAt: 1, lastActivityAt: 2, status: 'open', closedAt: null, readRevision: null, readLen: 0, readTail: '', readEoTail: '' },
  ] as never);
  const folded = foldTerminalsRegistry([
    { type: 'custom', customType: 'pi-herdr.terminals', data: registry },
  ]);
  assert.equal(folded[0]?.nudgedAt, 40, '已催时间戳往返保留');
  assert.equal(folded[1]?.nudgedAt, null, '未催过缺省 null');
});
