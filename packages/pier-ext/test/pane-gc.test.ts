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
import subagentPlugin from '../src/plugins/subagent.ts';
import { PiSurface } from '../src/pi-surface.ts';
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
    tabId: 'tMAIN',
    tabName: 'main',
    cwd,
    description: 'pane-gc 回归',
    background: true,
    status: 'consumed',
    consumedAt: Date.now() - 120_000,
    sessionFile: null,
    launchCommand: [],
    createdAt: Date.now() - 150_000,
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
    reconcileOnSettlement: () => [],
    withReconcileNotes: (b: string) => b,
    claimSettleNotice: () => true,
    terminalState: { activePaneIds: () => new Set<string>() },
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

test('pane 级 GC（01a0bd3a）：master 自己的 pane 绝不被回收——即使注册表里存在指向它的 consumed 条目', async () => {
  const pi = fakePi();
  const closePaneCalls: string[] = [];
  const cwd = mkdtempSync(join(tmpdir(), 'pane-gc-self-'));
  const surface = new PiSurface(pi as unknown as object);
  const root = new Context();
  const deps = {
    client: fakeClient(closePaneCalls, ['p0']), // p0 = env.paneId，master 自己
    env: { paneId: 'p0', tabId: 'tMAIN', workspaceId: 'w1' },
    extPath: 'F:/repo/pier/packages/pier-ext/src/index.ts',
    sessionRoot: root,
    port: emptySubagentPortBox(),
    getSessionId: () => '',
    reconcileOnSettlement: () => [],
    withReconcileNotes: (b: string) => b,
    claimSettleNotice: () => true,
    terminalState: { activePaneIds: () => new Set<string>() },
  };
  root.provide('pi-herdr.surface', surface);
  root.provide('pi-herdr.subagent-deps', deps);
  await root.plugin(subagentPlugin);
  try {
    // 被污染的注册表条目：paneId 指向 master 自身、已 consumed、herdr 状态 idle
    // —— 正是会话 01a0bd3a 里 wA:p1F 条目的形态
    const poisoned = makeEntry('p0', cwd);
    await fire(pi, 'session_start', {}, { sessionManager: { getBranch: () => [
      { type: 'custom', customType: SUBS_CUSTOM_TYPE, data: { subs: [poisoned] } },
    ] } });
    await fire(pi, 'turn_start');
    assert.deepEqual(closePaneCalls, [], 'master 自身 pane 不得被 closePane');
    const snap = pi.entries.filter(([t]) => t === SUBS_CUSTOM_TYPE).at(-1)?.[1] as { subs: SubEntry[] };
    const self = snap.subs.find((s) => s.paneId === 'p0');
    assert.ok(self, '条目仍在注册表');
    assert.equal(self.status, 'consumed', '条目不被误标 closed');
  } finally {
    await root.fiber.dispose();
  }
});
