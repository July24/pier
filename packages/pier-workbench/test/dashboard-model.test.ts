import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSnapshot, composeDashboardLines, type SessionSnapshotData } from '../src/dashboard-model.ts';

const SAMPLE_SNAPSHOT: SessionSnapshotData = {
  version: '0.9.0', protocol: 22, focused_workspace_id: 'wD', focused_tab_id: 'wD:t1', focused_pane_id: 'wD:p1',
  workspaces: [
    { workspace_id: 'wA', label: 'backend', agent_status: 'idle' },
    { workspace_id: 'wD', label: 'pier', focused: true, agent_status: 'working' },
  ],
  tabs: [
    { tab_id: 'wD:t1', workspace_id: 'wD', number: 1, label: 'main', focused: true, agent_status: 'working' },
    { tab_id: 'wD:t2', workspace_id: 'wD', number: 2, label: 'sub-task', agent_status: 'blocked' },
  ],
  panes: [
    { pane_id: 'wD:p1', workspace_id: 'wD', tab_id: 'wD:t1', agent: 'pi', display_agent: 'master', agent_status: 'working',
      focused: true, tokens: { 'pi-todo': '▶1 ○2 ■0 ✓1 · Building dashboard' } },
    { pane_id: 'wD:p2', workspace_id: 'wD', tab_id: 'wD:t2', agent: 'pi', display_agent: 'worker', agent_status: 'blocked',
      title: 'Waiting for auth input', tokens: { 'lock-1234': 'locked-file' } },
    { pane_id: 'wA:p1', workspace_id: 'wA', tab_id: 'wA:t1', agent: 'pi', display_agent: 'master', agent_status: 'idle' },
  ],
};

test('normalizeSnapshot: handles malformed inputs and unpacks response envelopes', () => {
  assert.equal(normalizeSnapshot(null), null);
  assert.equal(normalizeSnapshot(undefined), null);
  assert.equal(normalizeSnapshot('string'), null);
  const empty = normalizeSnapshot({});
  assert.deepEqual(empty?.workspaces, []);
  assert.deepEqual(empty?.tabs, []);
  assert.deepEqual(empty?.panes, []);
  // Direct snapshot, { snapshot } and { result: { snapshot } } (standard socket RPC envelope).
  const direct = normalizeSnapshot(SAMPLE_SNAPSHOT);
  assert.equal(direct?.version, '0.9.0');
  assert.equal(direct?.protocol, 22);
  assert.equal(direct?.workspaces?.length, 2);
  assert.equal(normalizeSnapshot({ snapshot: SAMPLE_SNAPSHOT })?.panes?.length, 3);
  const rpc = normalizeSnapshot({ result: { snapshot: SAMPLE_SNAPSHOT } });
  assert.equal(rpc?.version, '0.9.0');
  assert.equal(rpc?.focused_workspace_id, 'wD');
});

test('composeDashboardLines: formats empty state gracefully', () => {
  const lines = composeDashboardLines(null, { now: 1700000000000 });
  assert.ok(lines.some((l) => l.includes('PIER OPS DASHBOARD')));
  assert.ok(lines.some((l) => l.includes('Waiting for Herdr session snapshot')));
});

test('composeDashboardLines: renders the complete ops dashboard for the focused workspace', () => {
  const text = composeDashboardLines(SAMPLE_SNAPSHOT, { now: 1700000000000 }).join('\n');
  assert.ok(text.includes('Herdr v0.9.0, proto 22'));
  assert.ok(text.includes('[*wD: pier:working]'));
  assert.ok(text.includes('[wA: backend:idle]'));
  assert.ok(text.includes('Current Workspace: wD (pier)'));
  assert.ok(text.includes('*#1[main](working)'));
  assert.ok(text.includes('#2[sub-task](blocked)'));
  assert.ok(text.includes('PANE ID'), 'pane table header');
  assert.ok(text.includes('▶1 ○2 ■0 ✓1 · Building dashboard'), 'pi-todo wins over the pane title');
  assert.ok(text.includes('worker'));
  assert.ok(text.includes('! BLOCKED'), 'blocked panes are marked in the status column');
  assert.ok(text.includes('Waiting for auth input'));
  assert.ok(text.includes('[1 lock]'));
  assert.ok(text.includes('⚠️  ALERT: 1 SUBAGENT(S) BLOCKED — WAITING ON HUMAN DECISION'));
  assert.ok(text.includes('Summary: 2 pane(s) | Pier agents: 2 (1 working, 1 blocked, 0 idle)'));
});

test('composeDashboardLines: targetWorkspaceId option overrides focused workspace', () => {
  const text = composeDashboardLines(SAMPLE_SNAPSHOT, { targetWorkspaceId: 'wA', now: 1700000000000 }).join('\n');
  assert.ok(text.includes('Current Workspace: wA (backend)'));
  assert.ok(text.includes('wA:p1'));
  assert.ok(!text.includes('wD:p1'), 'other workspaces do not leak into the pane table');
  assert.ok(text.includes('Summary: 1 pane(s) | Pier agents: 1 (0 working, 0 blocked, 1 idle)'));
});

test('composeDashboardLines: Herdr 0.9.1 terminal_title_stripped and foreground_cwd display', () => {
  const snapshot = {
    workspaces: [{ workspace_id: 'w1', label: 'test' }],
    tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', number: 1, label: 'main' }],
    panes: [
      { pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1', agent: 'shell', title: '⠋ npm test --watch', terminal_title_stripped: 'npm test --watch' },
      { pane_id: 'w1:p2', workspace_id: 'w1', tab_id: 'w1:t1', agent: 'other', foreground_cwd: '/repo/packages/core' },
    ],
  };
  const text = composeDashboardLines(snapshot, { targetWorkspaceId: 'w1' }).join('\n');
  assert.ok(text.includes('npm test --watch'));
  assert.ok(text.includes('cwd: core'));
  assert.ok(!text.includes('⠋'), 'spinner-laden title must not win over terminal_title_stripped');
});
