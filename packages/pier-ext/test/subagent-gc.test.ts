/**
 * Board hygiene: gc-core decision tables (task tabs, panes, isolate sweep, path containment),
 * the registry projection, and the plugin-level GC pass.
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
import { SUBS_CUSTOM_TYPE, emptySubagentPortBox, type SubEntry } from '../src/subagent-core.ts';
import { isPathInside, planIsolateSweep, shouldClosePane, shouldCloseTaskTab, type GcEntryLike } from '../src/gc-core.ts';

const NOW = 1_000_000;
const TTL = 600_000;

const work = (over: Partial<GcEntryLike> = {}): GcEntryLike => ({
  kind: 'task',
  status: 'consumed',
  consumedAt: NOW - TTL - 1000,
  ...over,
});

test('shouldCloseTaskTab: closes only when every work pane finished and the grace TTL elapsed', () => {
  assert.equal(shouldCloseTaskTab({ entries: [work()], paneStatuses: ['idle', 'unknown'], ttlMs: TTL, now: NOW }), true);
  assert.equal(shouldCloseTaskTab({ entries: [], paneStatuses: ['idle'], ttlMs: TTL, now: NOW }), false, 'the main tab never closes');
  assert.equal(shouldCloseTaskTab({ entries: [work({ status: 'running', consumedAt: null })], paneStatuses: ['working'], ttlMs: TTL, now: NOW }), false);
  assert.equal(shouldCloseTaskTab({ entries: [work({ consumedAt: NOW - 1000 })], paneStatuses: ['idle'], ttlMs: TTL, now: NOW }), false, 'grace period');
  assert.equal(shouldCloseTaskTab({ entries: [work({ kind: 'resident', status: 'settled' })], paneStatuses: ['idle'], ttlMs: TTL, now: NOW }), true, 'legacy resident is not exempt');
  assert.equal(shouldCloseTaskTab({ entries: [work({ kind: 'advisor', status: 'running', consumedAt: null })], paneStatuses: ['working'], ttlMs: TTL, now: NOW }), false);
  assert.equal(shouldCloseTaskTab({ entries: [work()], paneStatuses: ['blocked'], ttlMs: TTL, now: NOW }), false, 'a human gate keeps the tab');
  assert.equal(shouldCloseTaskTab({ entries: [work()], paneStatuses: ['working'], ttlMs: TTL, now: NOW }), false);
});

test('shouldClosePane: explicit status gate, previous-turn grace, vanished pane recorded closed', () => {
  const base = { prevTurnStart: NOW };
  assert.equal(shouldClosePane({ ...base, consumedAt: NOW - 1000, herdrStatus: 'idle' }), true);
  assert.equal(shouldClosePane({ ...base, consumedAt: NOW - 1000, herdrStatus: 'done' }), true);
  assert.equal(shouldClosePane({ ...base, consumedAt: NOW - 1000, herdrStatus: 'working' }), false);
  assert.equal(shouldClosePane({ ...base, consumedAt: NOW - 1000, herdrStatus: 'blocked' }), false);
  assert.equal(shouldClosePane({ ...base, consumedAt: NOW - 1000, herdrStatus: 'unknown' }), false);
  assert.equal(shouldClosePane({ ...base, consumedAt: NOW + 500, herdrStatus: 'idle' }), false, 'consumed this turn keeps the notice visible');
  assert.equal(shouldClosePane({ ...base, consumedAt: null, herdrStatus: 'idle' }), false);
  assert.equal(shouldClosePane({ ...base, consumedAt: null, herdrStatus: undefined }), true, 'a vanished pane is recorded closed');
});

test('planIsolateSweep: untracked pier/* branches need an explicit opt-in', () => {
  const plan = planIsolateSweep({
    branches: ['pier/other-session', 'pier/mine'],
    worktreesByBranch: new Map([['pier/other-session', '/wt/other'], ['pier/mine', '/wt/mine']]),
    registeredBranches: new Set(['pier/mine']),
    pendingBranches: new Set(),
    sessionOwned: [],
    cwd: '/repo',
    sweepOrphans: false,
  });
  assert.deepEqual(plan.candidates, []);
  assert.deepEqual(plan.skipped, []);
});

test('planIsolateSweep: opt-in skips pending branches and never the worktree we run in', () => {
  const plan = planIsolateSweep({
    branches: ['pier/self', 'pier/other', 'pier/pending', 'pier/branchless'],
    worktreesByBranch: new Map([
      ['pier/self', '/wt/self'],
      ['pier/other', '/wt/other'],
      ['pier/pending', '/wt/pending'],
    ]),
    registeredBranches: new Set(),
    pendingBranches: new Set(['pier/pending']),
    sessionOwned: [],
    cwd: '/wt/self',
    sweepOrphans: true,
  });
  assert.deepEqual(plan.candidates.map((c) => c.branch), ['pier/other']);
  assert.deepEqual(plan.skipped, [
    { branch: 'pier/self', reason: 'self' },
    { branch: 'pier/pending', reason: 'pending' },
  ]);
});

test('planIsolateSweep: session-owned isolates stay candidates and prefer the live worktree path', () => {
  const plan = planIsolateSweep({
    branches: [],
    worktreesByBranch: new Map([['pier/mine', '/wt/moved']]),
    registeredBranches: new Set(['pier/mine']),
    pendingBranches: new Set(),
    sessionOwned: [{ branch: 'pier/mine', worktreePath: '/wt/recorded' }],
    cwd: '/repo',
    sweepOrphans: false,
  });
  assert.deepEqual(plan.candidates, [{ branch: 'pier/mine', worktreePath: '/wt/moved' }]);

  const nested = planIsolateSweep({
    branches: [],
    worktreesByBranch: new Map(),
    registeredBranches: new Set(),
    pendingBranches: new Set(),
    sessionOwned: [{ branch: 'pier/nested', worktreePath: '/wt/pier/nested' }],
    cwd: '/wt/pier/nested',
    sweepOrphans: false,
  });
  assert.deepEqual(nested.candidates, []);
  assert.deepEqual(nested.skipped, [{ branch: 'pier/nested', reason: 'self' }]);
});

test('isPathInside: equal paths and real children match; siblings and name prefixes do not', () => {
  assert.equal(isPathInside('/wt/a', '/wt/a'), true);
  assert.equal(isPathInside('/wt/a/sub', '/wt/a'), true);
  assert.equal(isPathInside('/wt/a/sub', '/wt/a/'), true);
  assert.equal(isPathInside('/wt/ab', '/wt/a'), false);
  assert.equal(isPathInside('/wt/a', '/wt/a/sub'), false);
  assert.equal(isPathInside('C:\\wt\\a\\sub', 'C:\\wt\\a'), true);
});

/* ── plugin-level GC ────────────────────────────────────────────── */

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
    tools: new Map(),
    listeners: new Map(),
    entries: [],
    registerTool(def) { this.tools.set(def.name, def); },
    on(event, handler) { this.listeners.set(event, [...(this.listeners.get(event) ?? []), handler]); },
    appendEntry(customType, data) { this.entries.push([customType, data]); },
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

async function mountGc(pi: FakePi, client: HerdrClientLike) {
  const root = new Context();
  root.provide('pi-herdr.surface', new PiSurface(pi as unknown as object));
  root.provide('pi-herdr.subagent-deps', {
    client,
    env: { paneId: 'p0', tabId: 'tMAIN', workspaceId: 'w1' },
    extPath: 'F:/repo/pier/packages/pier-ext/src/index.ts',
    sessionRoot: root,
    port: emptySubagentPortBox(),
    getSessionId: () => '',
    reconcileOnSettlement: () => [],
    withReconcileNotes: (b: string) => b,
    claimSettleNotice: () => true,
    terminalState: { activePaneIds: () => new Set<string>() },
  });
  await root.plugin(subagentPlugin);
  return root;
}

async function fire(pi: FakePi, event: string, ...args: unknown[]): Promise<void> {
  for (const h of pi.listeners.get(event) ?? []) await h(...args);
}

const seed = (pi: FakePi, subs: SubEntry[]) =>
  fire(pi, 'session_start', {}, { sessionManager: { getBranch: () => [{ type: 'custom', customType: SUBS_CUSTOM_TYPE, data: { subs } }] } });

const snapshot = (pi: FakePi) => pi.entries.filter(([t]) => t === SUBS_CUSTOM_TYPE).at(-1)?.[1] as { subs: SubEntry[] } | undefined;

test('GC pass: a live consumed pane is closed, a vanished pane is only recorded closed', async () => {
  const pi = fakePi();
  const closePaneCalls: string[] = [];
  const cwd = mkdtempSync(join(tmpdir(), 'pane-gc-'));
  const root = await mountGc(pi, fakeClient(closePaneCalls, ['pAlive']));
  try {
    await seed(pi, [makeEntry('pAlive', cwd), makeEntry('pGone', cwd)]);
    await fire(pi, 'turn_start');
    assert.deepEqual(closePaneCalls, ['pAlive']);
    const byId = new Map(snapshot(pi)!.subs.map((s) => [s.paneId, s.status]));
    assert.equal(byId.get('pAlive'), 'closed');
    assert.equal(byId.get('pGone'), 'closed');
  } finally {
    await root.fiber.dispose();
  }
});

test('GC pass: the master pane is never collected, whatever the registry claims', async () => {
  const pi = fakePi();
  const closePaneCalls: string[] = [];
  const cwd = mkdtempSync(join(tmpdir(), 'pane-gc-self-'));
  const root = await mountGc(pi, fakeClient(closePaneCalls, ['p0']));
  try {
    await seed(pi, [makeEntry('p0', cwd)]); // p0 is the master itself
    await fire(pi, 'turn_start');
    assert.deepEqual(closePaneCalls, [], 'closePane must never target the master');
    assert.equal(snapshot(pi)!.subs.find((s) => s.paneId === 'p0')!.status, 'consumed', 'the row is left alone');
  } finally {
    await root.fiber.dispose();
  }
});

test('registry: startup sweeps zombie running rows whose pane herdr no longer lists', async () => {
  const pi = fakePi();
  const cwd = mkdtempSync(join(tmpdir(), 'pane-gc-zombie-'));
  const root = await mountGc(pi, fakeClient([], []));
  try {
    await seed(pi, [{ ...makeEntry('pZombie', cwd), status: 'running', consumedAt: null }]);
    assert.equal(snapshot(pi)!.subs.find((s) => s.paneId === 'pZombie')!.status, 'closed');
  } finally {
    await root.fiber.dispose();
  }
});
