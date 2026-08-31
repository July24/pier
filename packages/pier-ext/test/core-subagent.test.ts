/**
 * 档1 core/subagent 插件接线：单工具注册 + slots 回填（common pipe 消费者）+
 * list 空态 + 墓碑。重依赖全假件（client/env/sessionRoot）。
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import subagentPlugin from '../src/core/subagent.ts';
import { PiSurface } from '../src/pi-surface.ts';
import { DisposeLedger } from '../src/ledger.ts';
import { TodosService } from '../src/todos-service.ts';
import type { HerdrClientLike } from '../src/herdr-client.ts';
import { emptySubagentPortBox } from '../src/subagent-port.ts';

function fakePi() {
  /** D41 二修：custom 通道（sendMessage）与 user 通道（sendUserMessage）分别记录。
   * 生产代码会提取函数后无绑定调用（const send = pi.sendMessage）——记录器
   * 必须闭包引用，不能依赖 this。 */
  const sent: Array<{ msg: { customType?: string; content?: string; display?: boolean }; opts?: { deliverAs?: string; triggerTurn?: boolean } }> = [];
  const userSent: string[] = [];
  return {
    tools: new Map<string, { execute?: (...a: unknown[]) => unknown }>(),
    listeners: new Map<string, Array<(...a: unknown[]) => unknown>>(),
    entries: [] as Array<[string, unknown]>,
    sent,
    userSent,
    registerTool(def: { name: string; execute?: (...a: unknown[]) => unknown }) {
      this.tools.set(def.name, def);
    },
    on(event: string, handler: (...a: unknown[]) => unknown) {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), handler]);
    },
    appendEntry(customType: string, data: unknown) {
      this.entries.push([customType, data]);
    },
    sendMessage(
      msg: { customType?: string; content?: string; display?: boolean },
      opts?: { deliverAs?: string; triggerTurn?: boolean },
    ) {
      sent.push({ msg, opts });
      return Promise.resolve();
    },
    sendUserMessage(content: string) {
      userSent.push(content);
      return Promise.resolve();
    },
  };
}

function fakeClient(): HerdrClientLike {
  return {
    available: true,
    tabList: async () => [],
    listPanes: async () => [],
    listAgents: async () => [],
    waitAgent: async () => null,
    getAgentSessionPath: async () => null,
    createTab: async () => ({ tabId: 't1', paneId: 'p1' }),
    splitPane: async () => 'p2',
    sendPaneText: async () => undefined,
    tabClose: async () => undefined,
    closePane: async () => undefined,
  } as unknown as HerdrClientLike;
}

const TOOLS = ['subagent'];

async function mount(pi: ReturnType<typeof fakePi>, ledger?: DisposeLedger) {
  const surface = new PiSurface(pi as unknown as object, ledger);
  const port = emptySubagentPortBox();
  const root = new Context();
  const deps = {
    client: fakeClient(),
    env: { paneId: 'p0', tabId: 't0', workspaceId: 'w1' },
    extPath: 'F:/repo/pier/packages/pier-ext/src/index.ts',
    sessionRoot: root,
    port,
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
  return { root, port, deps };
}

test('core/subagent：单工具注册 + 生命周期钩子 + 槽回填', async () => {
  const pi = fakePi();
  const { root, port } = await mount(pi);
  for (const n of TOOLS) assert.ok(pi.tools.has(n), `${n} 应注册`);
  assert.ok(!pi.tools.has('list_agents'));
  assert.ok(!pi.tools.has('resume_subagent'));
  assert.ok((pi.listeners.get('session_start') ?? []).length >= 1);
  assert.ok((pi.listeners.get('turn_start') ?? []).length >= 1, 'GC turn_start 钩子在');
  assert.ok(port.current, 'port bound at mount');
  assert.equal(typeof port.current.applyReplySession, 'function', 'O6 port bind');
  assert.equal(typeof port.current.reconcileOnReply, 'function', 'M17 port bind');
  assert.equal(typeof port.current.listRunningSubs, 'function', 'D96 port bind');
  assert.equal(typeof port.current.settleStatLine, 'function', 'D98 port bind');
  port.current.applyReplySession('unknown', null);
  assert.deepEqual(port.current.reconcileOnReply('unknown'), []);
  const r = await pi.tools.get('subagent')?.execute?.(null, { action: 'list' }) as { content: Array<{ text: string }> };
  assert.match(r.content[0].text, /No background subagents/);
  const bad = await pi.tools.get('subagent')?.execute?.(null, { action: 'explode' }) as { content: Array<{ text: string }> };
  assert.match(bad.content[0].text, /unknown action "explode"/);
  await root.fiber.dispose();
  assert.equal(port.current, null, 'port unbound on dispose');
});

test('core/subagent：墓碑（ledger.disposeKey 本文件）→ 工具 inert + 槽置空语义保持', async () => {
  const pi = fakePi();
  const ledger = new DisposeLedger();
  const { root, port } = await mount(pi, ledger);
  const n = ledger.disposeKey(new URL('../src/core/subagent.ts', import.meta.url).href);
  assert.equal(n, 1);
  const r = await pi.tools.get('subagent')?.execute?.(null, { action: 'list' }) as { content: Array<{ text: string }> };
  assert.match(r.content[0].text, /disposed/);
  assert.equal(typeof port.current?.reconcileOnReply, 'function');
  await root.fiber.dispose();
});

test('D41 stop 提醒：custom 通道 + 宽限窗 + 唤醒取消 + 封顶（01a040cc 修复）', async () => {
  const pi = fakePi();
  const { root, deps } = await mount(pi);
  const emit = async (ev: string, arg?: unknown) => {
    for (const h of pi.listeners.get(ev) ?? []) await h(arg);
  };
  const settle = () => emit('agent_settled');
  /** 定时器回调里的 async 注入链落定（微任务冲刷，无墙钟等待）。 */
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  };
  // 事故形态：收尾 prose 留给用户决定，列表却残留 pending + in_progress
  deps.todos.replace([
    { content: 'push special- fix to repo', status: 'pending' },
    { content: 'restart CRM user-service', status: 'in_progress' },
  ]);
  await emit('turn_end', { message: { role: 'assistant', stopReason: 'end_turn' } });

  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    // 1) settled 后不立即注入——宽限窗持有（旧版 116ms 内即注入，正是事故）
    await settle();
    mock.timers.tick(29_999);
    await flush();
    assert.equal(pi.sent.length, 0, '宽限窗内不注入');
    assert.equal(pi.userSent.length, 0, 'user 通道零调用');

    // 2) 宽限窗内 agent 被唤醒（用户输入）→ 本次提醒取消
    await emit('agent_start');
    mock.timers.tick(60_000);
    await flush();
    assert.equal(pi.sent.length, 0, '用户已接管，提醒取消');

    // 3) 再次 settle、宽限走满 → custom 通道注入（非 user 角色）
    await settle();
    mock.timers.tick(30_001);
    await flush();
    assert.equal(pi.sent.length, 1);
    assert.equal(pi.userSent.length, 0, '不再走 sendUserMessage 用户通道');
    const { msg, opts } = pi.sent[0]!;
    assert.equal(msg.customType, 'pi-herdr.todo-reminder');
    assert.equal(msg.display, true);
    assert.equal(opts?.deliverAs, 'followUp');
    assert.equal(opts?.triggerTurn, true);
    assert.match(msg.content ?? '', /Reconcile the list instead of blindly continuing/);
    assert.match(msg.content ?? '', /never execute it yourself/);
    assert.doesNotMatch(msg.content ?? '', /Continue working on them before stopping/);

    // 4) 封顶 3 次（计数仅实际送达才递增）
    await settle();
    mock.timers.tick(30_001);
    await flush();
    await settle();
    mock.timers.tick(30_001);
    await flush();
    assert.equal(pi.sent.length, 3, '第 2、3 次提醒正常注入');
    await settle();
    mock.timers.tick(30_001);
    await flush();
    assert.equal(pi.sent.length, 3, '封顶后不再注入');

    // 5) 等人工条目正确建模（blocked+blocker）后：不再催
    deps.todos.replace([{ content: 'wait for ops restart', status: 'blocked', blocker: 'staging pod restart' }]);
    await settle();
    mock.timers.tick(60_000);
    await flush();
    assert.equal(pi.sent.length, 3, 'blocked 建模后不触发');
  } finally {
    mock.timers.reset();
    await root.fiber.dispose();
  }
});

test('D41 stop 提醒：ESC 中止（aborted）不催——反唤醒风暴守卫保留', async () => {
  const pi = fakePi();
  const { root, deps } = await mount(pi);
  const emit = async (ev: string, arg?: unknown) => {
    for (const h of pi.listeners.get(ev) ?? []) await h(arg);
  };
  deps.todos.replace([{ content: 'push fix', status: 'pending' }]);
  await emit('turn_end', { message: { role: 'assistant', stopReason: 'aborted' } });
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await emit('agent_settled');
    mock.timers.tick(60_000);
    for (let i = 0; i < 4; i++) await Promise.resolve();
    assert.equal(pi.sent.length, 0, 'abort 后的 settled 不做任何唤醒注入');
    assert.equal(pi.userSent.length, 0);
  } finally {
    mock.timers.reset();
    await root.fiber.dispose();
  }
});
