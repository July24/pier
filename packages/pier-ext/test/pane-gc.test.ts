/**
 * pane 级 GC 回归（D98 活体发现的既有缺陷）：
 *  - gcPass pane 级路径的 `statuses` 曾未定义——ReferenceError 被 runGcSafely 静默吞，
 *    pane 级回收长期失效。缝：真插件挂载 + session_start 种子注册表 + turn_start 驱动 gcPass。
 * 断言：① main tab 内 consumed 且过宽限的 pane 被 closePane + 补记 closed；
 *      ② pane 已消失（不在 listPanes）→ 直接补记 closed 不调 closePane。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import subagentPlugin from '../src/core/subagent.ts';
import { PiSurface } from '../src/pi-surface.ts';
import { TodosService } from '../src/todos-service.ts';
import type { HerdrClientLike } from '../src/herdr-client.ts';
import { SUBS_CUSTOM_TYPE, type SubEntry } from '../src/subagent-core.ts';
import { emptySubagentPortBox } from '../src/subagent-port.ts';

interface FakePi {
  tools: Map<string, { execute?: (...a: unknown[]) => unknown }>;
  listeners: Map<string, Array<(...a: unknown[]) => unknown>>;
  entries: Array<[string, unknown]>;
  registerTool(def: { name: string; execute?: (...a: unknown[]) => unknown }): void;
  on(event: string, handler: (...a: unknown[]) => unknown): void;
  appendEntry(customType: string, data: unknown): void;
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

function fakeClient(closePaneCalls: string[], paneIds: string[]): HerdrClientLike {
  return {
    available: true,
    tabList: async () => [],
    listPanes: async () => paneIds.map((id) => ({ paneId: id, tabId: 'tMAIN', agentStatus: 'idle' })),
    listAgents: async () => [],
    waitAgent: async () => 'idle',
    getAgentSessionPath: async () => null,
    createTab: async () => ({ tabId: 't9', paneId: 'p9' }),
    splitPane: async () => 'p2',
    sendPaneText: async () => undefined,
    tabClose: async () => undefined,
    closePane: async (paneId: string) => { closePaneCalls.push(paneId); },
  } as unknown as HerdrClientLike;
}

function makeEntry(paneId: string, cwd: string): SubEntry {
  return {
    taskId: `task-${paneId}`,
    kind: 'task',
    paneId,
    tabId: 'tMAIN', // main tab → 走 pane 级回收（D86 R4：main 永不整关）
    tabName: 'main',
    cwd,
    description: 'pane-gc 回归',
    background: true,
    status: 'consumed', // GC只处理consumed状态的pane
    consumedAt: Date.now() - 120_000, // 远早于测试中的prevTurnStart
    sessionFile: null,
    launchCommand: [],
    revivedFrom: null,
  };
}

async function fire(pi: FakePi, event: string, ...args: unknown[]): Promise<void> {
  for (const h of pi.listeners.get(event) ?? []) await h(...args);
}

test('pane 级 GC：statuses 修复——consumed pane 被 closePane；消失 pane 直接补记 closed', async () => {
  const pi = fakePi();
  const closePaneCalls: string[] = [];
  const cwd = mkdtempSync(join(tmpdir(), 'pane-gc-'));
  const surface = new PiSurface(pi as unknown as object);
  const root = new Context();
  const deps = {
    client: fakeClient(closePaneCalls, ['pAlive']),
    env: { paneId: 'p0', tabId: 'tMAIN', workspaceId: 'w1' },
    extPath: 'F:/repo/pier/packages/pier-ext/src/index.ts',
    sessionRoot: root,
    port: emptySubagentPortBox(),
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
  try {
    const alive = makeEntry('pAlive', cwd);
    const gone = makeEntry('pGone', cwd);
    await fire(pi, 'session_start', {}, { sessionManager: { getBranch: () => [
      { type: 'custom', customType: SUBS_CUSTOM_TYPE, data: { subs: [alive, gone] } },
    ] } });
    await fire(pi, 'turn_start');
    assert.ok(closePaneCalls.includes('pAlive'), `存活 consumed pane 应被关闭，实际 closePane=${JSON.stringify(closePaneCalls)}`);
    // 注册表终态：两条均 closed（appendEntry 落盘快照）
    const snap = pi.entries.filter(([t]) => t === SUBS_CUSTOM_TYPE).at(-1)?.[1] as { subs: SubEntry[] };
    const byId = new Map(snap.subs.map((s) => [s.paneId, s.status]));
    assert.equal(byId.get('pAlive'), 'closed');
    assert.equal(byId.get('pGone'), 'closed');
  } finally {
    await root.fiber.dispose();
  }
});
