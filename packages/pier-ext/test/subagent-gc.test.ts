/**
 * Board hygiene: gc-core decision tables (task tabs, panes, isolate sweep, path containment),
 * the registry projection, and the plugin-level GC pass.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fire, fakeHerdr, mountSubagent, subEntry, subsSnapshot } from './test-utils.ts';
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
  const tab = (over: Partial<GcEntryLike>, paneStatuses: string[], ms = TTL, now = NOW) =>
    shouldCloseTaskTab({ entries: [work(over)], paneStatuses, ttlMs: ms, now });
  assert.equal(tab({}, ['idle', 'unknown']), true);
  assert.equal(shouldCloseTaskTab({ entries: [], paneStatuses: ['idle'], ttlMs: TTL, now: NOW }), false, 'the main tab never closes');
  assert.equal(tab({ status: 'running', consumedAt: null }, ['working']), false);
  assert.equal(tab({ consumedAt: NOW - 1000 }, ['idle']), false, 'grace period');
  assert.equal(tab({ kind: 'resident', status: 'settled' }, ['idle']), true, 'legacy resident is not exempt');
  assert.equal(tab({ kind: 'advisor', status: 'running', consumedAt: null }, ['working']), false);
  assert.equal(tab({}, ['blocked']), false, 'a human gate keeps the tab');
  assert.equal(tab({}, ['working']), false);
});

test('shouldClosePane: explicit status gate, previous-turn grace, vanished pane recorded closed', () => {
  const pane = (over: Partial<Parameters<typeof shouldClosePane>[0]> = {}) =>
    shouldClosePane({ prevTurnStart: NOW, consumedAt: NOW - 1000, herdrStatus: 'idle', ...over });
  assert.equal(pane(), true);
  assert.equal(pane({ herdrStatus: 'done' }), true);
  assert.equal(pane({ herdrStatus: 'working' }), false);
  assert.equal(pane({ herdrStatus: 'blocked' }), false);
  assert.equal(pane({ herdrStatus: 'unknown' }), false);
  assert.equal(pane({ consumedAt: NOW + 500 }), false, 'consumed this turn keeps the notice visible');
  assert.equal(pane({ consumedAt: null }), false);
  assert.equal(pane({ consumedAt: null, herdrStatus: undefined }), true, 'a vanished pane is recorded closed');
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

const pane = (id: string) => ({ paneId: id, tabId: 'tMAIN', workspaceId: 'w1', agentStatus: 'idle' });
const consumed = (paneId: string, cwd: string) => subEntry({
  paneId, taskId: `task-${paneId}`, tabId: 'tMAIN', tabName: 'main', cwd, description: 'pane-gc 回归',
  status: 'consumed', consumedAt: Date.now() - 120_000, createdAt: Date.now() - 150_000,
});

test('GC pass: a live consumed pane is closed, a vanished pane is only recorded closed', async () => {
  const closePaneCalls: string[] = [];
  const cwd = mkdtempSync(join(tmpdir(), 'pane-gc-'));
  const { root, pi } = await mountSubagent({
    env: { tabId: 'tMAIN' },
    client: {
      listPanes: async () => [pane('pAlive')],
      closePane: async (paneId) => { closePaneCalls.push(paneId); },
    },
    subs: [consumed('pAlive', cwd), consumed('pGone', cwd)],
  });
  try {
    await fire(pi, 'turn_start');
    assert.deepEqual(closePaneCalls, ['pAlive']);
    const byId = new Map(subsSnapshot(pi)!.subs.map((s) => [s.paneId, s.status]));
    assert.equal(byId.get('pAlive'), 'closed');
    assert.equal(byId.get('pGone'), 'closed');
  } finally {
    await root.fiber.dispose();
  }
});

test('GC pass: the master pane is never collected, whatever the registry claims', async () => {
  const closePaneCalls: string[] = [];
  const cwd = mkdtempSync(join(tmpdir(), 'pane-gc-self-'));
  const { root, pi } = await mountSubagent({
    env: { tabId: 'tMAIN' },
    client: {
      listPanes: async () => [pane('p0')],
      closePane: async (paneId) => { closePaneCalls.push(paneId); },
    },
    subs: [consumed('p0', cwd)], // p0 is the master itself
  });
  try {
    await fire(pi, 'turn_start');
    assert.deepEqual(closePaneCalls, [], 'closePane must never target the master');
    assert.equal(subsSnapshot(pi)!.subs.find((s) => s.paneId === 'p0')!.status, 'consumed', 'the row is left alone');
  } finally {
    await root.fiber.dispose();
  }
});

test('registry: startup sweeps zombie running rows whose pane herdr no longer lists', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pane-gc-zombie-'));
  const { root, pi } = await mountSubagent({
    env: { tabId: 'tMAIN' },
    client: fakeHerdr({ listPanes: async () => [] }),
    subs: [{ ...consumed('pZombie', cwd), status: 'running', consumedAt: null }],
  });
  try {
    assert.equal(subsSnapshot(pi)!.subs.find((s) => s.paneId === 'pZombie')!.status, 'closed');
  } finally {
    await root.fiber.dispose();
  }
});
