/**
 * 档1 core/subagent 插件接线：单工具注册 + slots 回填（common pipe 消费者）+
 * list 空态 + 墓碑。重依赖全假件（client/env/sessionRoot）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import subagentPlugin from '../src/core/subagent.ts';
import { PiSurface } from '../src/pi-surface.ts';
import { DisposeLedger } from '../src/ledger.ts';
import type { HerdrClientLike } from '../src/herdr-client.ts';
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

