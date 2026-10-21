/** Shared Pier popup opening: one entrypoint, env-selected initial tab, ui_busy is surfaced. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openPierPanel } from '../src/panel-open.ts';
import type { HerdrEnv, OpenPluginPaneOptions, OpenPluginPaneResult } from '../src/herdr-client.ts';
import { fakeHerdr } from './test-utils.ts';

const ENV: HerdrEnv = { socketPath: '/tmp/pier-panel-test.sock', paneId: 'p1', workspaceId: 'w1', tabId: 't1' };

function fakeClient(open: (opts: OpenPluginPaneOptions) => Promise<OpenPluginPaneResult>, available = true) {
  return fakeHerdr({ available, openPluginPane: open });
}

test('openPierPanel: opens the shared panel entrypoint with the requested initial tab', async () => {
  const calls: OpenPluginPaneOptions[] = [];
  const client = fakeClient(async (opts) => {
    calls.push(opts);
    return { mode: 'popup', ok: true };
  });
  const result = await openPierPanel({ client, env: ENV }, { panel: 'tree', treeFile: '/tmp/tree.txt' });
  assert.equal(result, 'popup');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.entrypoint, 'panel');
  assert.equal(calls[0]!.placement, 'popup');
  assert.equal(calls[0]!.env?.PIER_PANEL, 'tree');
  assert.equal(calls[0]!.env?.PIER_TREE_FILE, '/tmp/tree.txt');
});

test('openPierPanel: dashboard opens the same entrypoint on its tab without a tree file', async () => {
  const calls: OpenPluginPaneOptions[] = [];
  const client = fakeClient(async (opts) => {
    calls.push(opts);
    return { mode: 'popup', ok: true };
  });
  assert.equal(await openPierPanel({ client, env: ENV }, { panel: 'dashboard' }), 'popup');
  assert.equal(calls[0]!.env?.PIER_PANEL, 'dashboard');
  assert.equal(calls[0]!.env?.PIER_TREE_FILE, undefined);
});

test('openPierPanel: ui_busy is reported, never retried as a tab', async () => {
  const client = fakeClient(async () => ({ mode: 'busy' }));
  assert.equal(await openPierPanel({ client, env: ENV }, { panel: 'dashboard' }), 'busy');
});

test('openPierPanel: legacy tab fallback and transport failure stay distinguishable', async () => {
  const tab = await openPierPanel(
    { client: fakeClient(async () => ({ mode: 'fallback_tab', tabId: 't2' })), env: ENV },
    { panel: 'dashboard' },
  );
  assert.equal(tab, 'tab');
  const down = await openPierPanel(
    { client: fakeClient(async () => { throw new Error('ECONNREFUSED'); }), env: ENV },
    { panel: 'dashboard' },
  );
  assert.equal(down, 'unavailable');
  const outside = await openPierPanel(
    { client: fakeClient(async () => ({ mode: 'popup', ok: true }), false), env: null },
    { panel: 'dashboard' },
  );
  assert.equal(outside, 'unavailable');
});
