/**
 * 档1 core/subagent 插件接线：五工具注册 + slots 回填（common pipe 消费者）+
 * list_agents 空态 + 墓碑。重依赖全假件（client/env/sessionRoot）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import subagentPlugin from '../src/core/subagent.ts';
import { PiSurface } from '../src/pi-surface.ts';
import { DisposeLedger } from '../src/ledger.ts';
import { TodosService } from '../src/todos-service.ts';
import type { HerdrClientLike } from '../src/herdr-client.ts';

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

const TOOLS = ['subagent', 'resume_subagent', 'list_agents', 'send_message', 'interrupt_agent'];

async function mount(pi: ReturnType<typeof fakePi>, ledger?: DisposeLedger) {
  const surface = new PiSurface(pi as unknown as object, ledger);
  const slots = { applyReplySession: null, reconcileOnReply: null, listRunningSubs: null };
  const root = new Context();
  const deps = {
    client: fakeClient(),
    env: { paneId: 'p0', tabId: 't0', workspaceId: 'w1' },
    extPath: 'F:/repo/pier/packages/pier-ext/src/index.ts',
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
  return { root, slots, deps };
}

test('core/subagent：五工具注册 + 生命周期钩子 + 槽回填', async () => {
  const pi = fakePi();
  const { root, slots } = await mount(pi);
  for (const n of TOOLS) assert.ok(pi.tools.has(n), `${n} 应注册`);
  assert.ok((pi.listeners.get('session_start') ?? []).length >= 1);
  assert.ok((pi.listeners.get('turn_start') ?? []).length >= 1, 'GC turn_start 钩子在');
  assert.equal(typeof slots.applyReplySession, 'function', 'O6 槽回填');
  assert.equal(typeof slots.reconcileOnReply, 'function', 'M17 槽回填');
  assert.equal(typeof slots.listRunningSubs, 'function', 'D96 槽回填');
  // 槽语义：未知 pane no-op / 对账走 reconcileOnSettlement
  slots.applyReplySession?.('unknown', null);
  assert.deepEqual(slots.reconcileOnReply?.('unknown') ?? [], []);
  // D96：无 subagent 时 listRunningSubs 空
  assert.deepEqual(slots.listRunningSubs?.() ?? [], []);

  const r = await pi.tools.get('list_agents')?.execute?.() as { content: Array<{ text: string }> };
  assert.match(r.content[0].text, /No background subagents/);
  await root.fiber.dispose();
});

test('core/subagent：墓碑（ledger.disposeKey 本文件）→ 工具 inert + 槽置空语义保持', async () => {
  const pi = fakePi();
  const ledger = new DisposeLedger();
  const { root, slots } = await mount(pi, ledger);
  const n = ledger.disposeKey(new URL('../src/core/subagent.ts', import.meta.url).href);
  assert.equal(n, 1);
  const r = await pi.tools.get('list_agents')?.execute?.() as { content: Array<{ text: string }> };
  assert.match(r.content[0].text, /disposed/);
  // 槽仍指向旧闭包（subs 注册表随插件实例）——tombstone 后 reconcileOnReply 仍安全（纯读）
  assert.equal(typeof slots.reconcileOnReply, 'function');
  await root.fiber.dispose();
});
