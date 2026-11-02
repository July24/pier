/** Board hygiene: gc-core decision tables (task tabs, terminals, isolate sweep, path containment)
 * and the plugin-level GC pass. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeWatch, fire, mountSubagent, subEntry, subsSnapshot, terminalInfo } from './test-utils.ts';
import type { SubEntry } from '../src/subagent-core.ts';
import type { TerminalInfo } from '../src/core-client.ts';
import { isPathInside, planIsolateSweep, shouldClosePane, shouldCloseTaskTab, type GcEntryLike } from '../src/gc-core.ts';

const NOW = 1_000_000;
const TTL = 600_000;
const work = (over: Partial<GcEntryLike> = {}): GcEntryLike => ({
  kind: 'task',
  status: 'consumed',
  consumedAt: NOW - TTL - 1000,
  ...over,
});

/** planIsolateSweep input with inert defaults; each test overrides only what it exercises. */
const sweepPlan = (over: Partial<Parameters<typeof planIsolateSweep>[0]>) => planIsolateSweep({
  branches: [], worktreesByBranch: new Map(), registeredBranches: new Set(), pendingBranches: new Set(),
  sessionOwned: [], cwd: '/repo', sweepOrphans: false, ...over,
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

test('shouldClosePane: explicit status gate, previous-turn grace, vanished terminal recorded closed', () => {
  const pane = (over: Partial<Parameters<typeof shouldClosePane>[0]> = {}) =>
    shouldClosePane({ prevTurnStart: NOW, consumedAt: NOW - 1000, status: 'idle', ...over });
  assert.equal(pane(), true);
  assert.equal(pane({ status: 'done' }), true);
  assert.equal(pane({ status: 'error' }), true);
  assert.equal(pane({ status: 'working' }), false);
  assert.equal(pane({ status: 'blocked' }), false);
  assert.equal(pane({ status: 'unknown' }), false);
  assert.equal(pane({ consumedAt: NOW + 500 }), false, 'consumed this turn keeps the notice visible');
  assert.equal(pane({ consumedAt: null }), false);
  assert.equal(pane({ consumedAt: null, status: undefined }), true, 'a vanished terminal is recorded closed');
});

test('planIsolateSweep: untracked pier/* branches need an explicit opt-in', () => {
  const plan = sweepPlan({
    branches: ['pier/other-session', 'pier/mine'],
    worktreesByBranch: new Map([['pier/other-session', '/wt/other'], ['pier/mine', '/wt/mine']]),
    registeredBranches: new Set(['pier/mine']),
  });
  assert.deepEqual(plan.candidates, []);
  assert.deepEqual(plan.skipped, []);
});

test('planIsolateSweep: opt-in skips pending branches and never the worktree we run in', () => {
  const plan = sweepPlan({
    branches: ['pier/self', 'pier/other', 'pier/pending', 'pier/branchless'],
    worktreesByBranch: new Map([['pier/self', '/wt/self'], ['pier/other', '/wt/other'], ['pier/pending', '/wt/pending']]),
    pendingBranches: new Set(['pier/pending']),
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
  const plan = sweepPlan({
    worktreesByBranch: new Map([['pier/mine', '/wt/moved']]),
    registeredBranches: new Set(['pier/mine']),
    sessionOwned: [{ branch: 'pier/mine', worktreePath: '/wt/recorded' }],
  });
  assert.deepEqual(plan.candidates, [{ branch: 'pier/mine', worktreePath: '/wt/moved' }]);

  const nested = sweepPlan({
    sessionOwned: [{ branch: 'pier/nested', worktreePath: '/wt/pier/nested' }],
    cwd: '/wt/pier/nested',
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

const pane = (id: string): TerminalInfo => terminalInfo({ id, status: 'idle', labels: { 'herdr.tab': 'tMAIN' } });
const consumed = (paneId: string, cwd: string) => subEntry({
  paneId, taskId: `task-${paneId}`, tabId: 'tMAIN', tabName: 'main', cwd, description: 'pane-gc 回归',
  status: 'consumed', consumedAt: Date.now() - 120_000, createdAt: Date.now() - 150_000,
});

/** Seeds `subs`, runs one GC pass with `liveTerminals` in the children watch (and core's list),
 * then reports the retired terminal ids and the registry snapshot. */
async function gcPass(liveTerminals: string[], subs: SubEntry[]): Promise<{ closed: string[]; subs: SubEntry[] }> {
  const closed: string[] = [];
  const { root, pi } = await mountSubagent({
    client: {
      placementLabels: async () => ({ 'herdr.tab': 'tMAIN' }),
      listTerminals: async () => liveTerminals.map(pane),
      watchChildren: () => fakeWatch({ terminals: () => liveTerminals.map(pane) }),
      kill: async (id) => { closed.push(id); },
    },
    subs,
  });
  try {
    await fire(pi, 'turn_start');
    return { closed, subs: subsSnapshot(pi)!.subs };
  } finally {
    await root.fiber.dispose();
  }
}

test('GC pass: a live consumed terminal is retired, a vanished one is only recorded closed', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pane-gc-'));
  const { closed, subs } = await gcPass(['pAlive'], [consumed('pAlive', cwd), consumed('pGone', cwd)]);
  assert.deepEqual(closed, ['pAlive']);
  const byId = new Map(subs.map((s) => [s.paneId, s.status]));
  assert.equal(byId.get('pAlive'), 'closed');
  assert.equal(byId.get('pGone'), 'closed');
});

test('GC pass: the master terminal is never collected, whatever the registry claims', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pane-gc-self-'));
  const { closed, subs } = await gcPass(['t0'], [consumed('t0', cwd)]); // t0 is the master itself
  assert.deepEqual(closed, [], 'kill must never target the master');
  assert.equal(subs.find((s) => s.paneId === 't0')!.status, 'consumed', 'the row is left alone');
});

test('registry: startup sweeps zombie running rows whose terminal core no longer lists', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pane-gc-zombie-'));
  const { root, pi } = await mountSubagent({
    client: { listTerminals: async () => [] },
    subs: [{ ...consumed('pZombie', cwd), status: 'running', consumedAt: null }],
  });
  try {
    assert.equal(subsSnapshot(pi)!.subs.find((s) => s.paneId === 'pZombie')!.status, 'closed');
  } finally {
    await root.fiber.dispose();
  }
});
