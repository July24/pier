/**
 * 档1 core/terminal 插件接线：surface 服务注入 + 单工具注册 + GC 槽回填 + ledger 墓碑。
 * 真实 cordis Context + 真 PiSurface（pi/client 为假件）——不活体，只验接线面。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import terminalPlugin from '../src/core/terminal.ts';
import { PiSurface } from '../src/pi-surface.ts';
import { DisposeLedger } from '../src/ledger.ts';
import type { HerdrClientLike } from '../src/herdr-client.ts';

function fakePi() {
  return {
    tools: new Map<string, { execute?: (...a: unknown[]) => unknown }>(),
    entries: [] as Array<[string, unknown]>,
    registerTool(def: { name: string; execute?: (...a: unknown[]) => unknown }) {
      this.tools.set(def.name, def);
    },
    on() { /* 不用 */ },
    appendEntry(customType: string, data: unknown) {
      this.entries.push([customType, data]);
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
