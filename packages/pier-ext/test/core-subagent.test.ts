/**
 * 档1 core/subagent 插件接线：单工具注册 + slots 回填（common pipe 消费者）+
 * list 空态 + 墓碑。重依赖全假件（client/env/sessionRoot）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import subagentPlugin from '../src/plugins/subagent.ts';
import { resolveTaskIdPrefix } from '../src/subagent-resolution.ts';
import { PiSurface } from '../src/pi-surface.ts';
import { DisposeLedger } from '../src/ledger.ts';
import type { HerdrClientLike } from '../src/herdr-client.ts';
import { SUBS_CUSTOM_TYPE } from '../src/subagent-core.ts';
import { emptySubagentPortBox } from '../src/subagent-port.ts';

function fakePi() {
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
    reconcileOnSettlement: () => [],
    withReconcileNotes: (b: string) => b,
    claimSettleNotice: () => true,
    terminalState: { activePaneIds: () => new Set<string>() },
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
  await assert.rejects(
    async () => { await pi.tools.get('subagent')?.execute?.(null, { action: 'explode' }); },
    /unknown action "explode"/,
  );
  await root.fiber.dispose();
  assert.equal(port.current, null, 'port unbound on dispose');
});

test('core/subagent：墓碑（ledger.disposeKey 本文件）→ 工具 inert + 槽置空语义保持', async () => {
  const pi = fakePi();
  const ledger = new DisposeLedger();
  const { root, port } = await mount(pi, ledger);
  const n = ledger.disposeKey(new URL('../src/plugins/subagent.ts', import.meta.url).href);
  assert.equal(n, 1);
  const r = await pi.tools.get('subagent')?.execute?.(null, { action: 'list' }) as { content: Array<{ text: string }> };
  assert.match(r.content[0].text, /disposed/);
  assert.equal(typeof port.current?.reconcileOnReply, 'function');
  await root.fiber.dispose();
});

test('resolveTaskIdPrefix (B1): 唯一前缀 (>=4)、歧义列表、过短 (<4) 与精确匹配', () => {
  const candidates = [
    'c1b5274d-1111-2222-3333-444455556666',
    'c1b5899a-aaaa-bbbb-cccc-ddddeeeeffff',
    'a2f48901-0000-1111-2222-333344445555',
    'p2',
  ];

  // 唯一前缀 (8 字符与 4 字符)
  const r1 = resolveTaskIdPrefix('c1b5274d', candidates);
  assert.equal(r1.kind, 'resolved');
  if (r1.kind === 'resolved') assert.equal(r1.taskId, candidates[0]);

  const r2 = resolveTaskIdPrefix('a2f4', candidates);
  assert.equal(r2.kind, 'resolved');
  if (r2.kind === 'resolved') assert.equal(r2.taskId, candidates[2]);

  // 大小写不敏感
  const rCase = resolveTaskIdPrefix('A2F4', candidates);
  assert.equal(rCase.kind, 'resolved');
  if (rCase.kind === 'resolved') assert.equal(rCase.taskId, candidates[2]);

  // 歧义前缀 (c1b5 匹配 candidates[0] 和 candidates[1])
  const rAmb = resolveTaskIdPrefix('c1b5', candidates);
  assert.equal(rAmb.kind, 'ambiguous');
  if (rAmb.kind === 'ambiguous') {
    assert.deepEqual(rAmb.candidates, [candidates[0], candidates[1]]);
  }

  // 前缀过短 (< 4 字符且非精确匹配)
  const rShort = resolveTaskIdPrefix('c1b', candidates);
  assert.equal(rShort.kind, 'too_short');

  // 未找到
  const rNotFound = resolveTaskIdPrefix('ffff', candidates);
  assert.equal(rNotFound.kind, 'not_found');

  // 空输入
  assert.equal(resolveTaskIdPrefix('  ', candidates).kind, 'not_found');

  // 精确匹配不受长度限制 (例如 'p2' 长度 2 也能精确解析)
  const rExact = resolveTaskIdPrefix('p2', candidates);
  assert.equal(rExact.kind, 'resolved');
  if (rExact.kind === 'resolved') assert.equal(rExact.taskId, 'p2');
});



test('A1 连带修复：tool_result(isError) 钩子被真正触发（存活重写不再死代码）', async () => {
  // A1 之前工具把失败当普通文本返回 → pi 从不置 isError → 这个钩子（core/subagent.ts 的
  // `scoped.on('tool_result')`）永远不会执行，等于死代码。现在失败会 throw，钩子必须被调用。
  //
  // 这里覆盖钩子的「入口 + 死 pane 保真」两段：探活失败时必须原样放行原错误（不能把真死的 agent
  // 说成活着）。存活分支会拉起 poller（观测窗口默认 30s），不适合放进单测——
  // 该分支的判定函数（isAlive / buildAliveNotice）已在 test/subagent-alive.test.ts 覆盖。
  const pi = fakePi();
  const surface = new PiSurface(pi as unknown as object);
  const port = emptySubagentPortBox();
  const root = new Context();
  const deps = {
    client: {
      ...fakeClient(),
      listAgents: async () => [], // pane 不存在 → 探活为死
    } as unknown as HerdrClientLike,
    env: { paneId: 'p0', tabId: 't0', workspaceId: 'w1' },
    extPath: 'F:/repo/pier/packages/pier-ext/src/index.ts',
    sessionRoot: root,
    port,
    getSessionId: () => '',
    reconcileOnSettlement: () => [],
    withReconcileNotes: (b: string) => b,
    claimSettleNotice: () => true,
    terminalState: { activePaneIds: () => new Set<string>() },
  };
  root.provide('pi-herdr.surface', surface);
  root.provide('pi-herdr.subagent-deps', deps);
  await root.plugin(subagentPlugin);

  const branch = [{
    type: 'custom',
    customType: SUBS_CUSTOM_TYPE,
    data: {
      version: 1,
      subs: [{
        taskId: 'task-1', kind: 'task', paneId: 'w1:p2', tabId: 't0', cwd: '/tmp',
        description: '已死的 worker', background: true, status: 'running', createdAt: Date.now(),
      }],
    },
  }];
  for (const h of pi.listeners.get('session_start') ?? []) {
    await h({ reason: 'resume' }, { sessionManager: { getBranch: () => branch } });
  }

  const hook = (pi.listeners.get('tool_result') ?? [])[0];
  assert.ok(hook, 'tool_result 钩子已注册');

  // 死 pane → 钩子保持沉默，原错误原样进入模型上下文（不能把真死的 agent 说成活着）
  assert.equal(
    await hook!({
      toolName: 'subagent',
      toolCallId: 'tc1',
      isError: true,
      content: [{ type: 'text', text: 'Error: failed to reach subagent w1:p2: pipe not ready' }],
    }),
    undefined,
  );
  // 非失败结果 / 别的工具 → 一律不介入
  assert.equal(await hook!({ toolName: 'subagent', toolCallId: 'tc2', isError: false, content: [] }), undefined);
  assert.equal(await hook!({ toolName: 'bash', toolCallId: 'tc3', isError: true, content: [] }), undefined);
  // 错误文本里没有 pane id → 不介入（不猜）
  assert.equal(await hook!({ toolName: 'subagent', toolCallId: 'tc4', isError: true, content: [{ type: 'text', text: 'Error: unknown action' }] }), undefined);
  await root.fiber.dispose();
});

test('B2/B4：subagent 工具自带 prompt 面（snippet + guidelines），且缺省 action 被归一化为 spawn', async () => {
  const pi = fakePi();
  const { root } = await mount(pi);
  const def = pi.tools.get('subagent') as {
    promptSnippet?: string;
    promptGuidelines?: string[];
    prepareArguments?: (args: unknown) => Record<string, unknown>;
  };
  assert.ok(def, 'subagent 已注册');
  // B4：工具选择发生在系统提示里，snippet/guidelines 是模型唯一能看到的使用说明
  assert.match(String(def.promptSnippet ?? ''), /subagent/);
  assert.ok((def.promptGuidelines?.length ?? 0) >= 4, 'guidelines 覆盖 spawn/isolate/background/send');
  const g = (def.promptGuidelines ?? []).join(' ');
  assert.match(g, /run_in_background/);
  assert.match(g, /isolate/);
  assert.match(g, /action: "send"/);

  // B2：23/38 次真实 spawn 省略了 action —— 归一化后 spawn 必须显式出现
  assert.deepEqual(def.prepareArguments?.({ description: 'x', prompt: 'y' }), { description: 'x', prompt: 'y', action: 'spawn' });
  // 显式 action 不被覆盖，非对象入参不炸
  assert.deepEqual(def.prepareArguments?.({ action: 'list' }), { action: 'list' });
  assert.deepEqual(def.prepareArguments?.(undefined), { action: 'spawn' });
  await root.fiber.dispose();
});
