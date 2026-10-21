import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSnapshot, composeDashboardLines, paneStatus, displayWidth, clipToWidth, wrapToWidth, fitDashboardLines, type SessionSnapshotData } from '../src/dashboard-model.ts';

const SAMPLE_SNAPSHOT: SessionSnapshotData = {
  version: '0.9.0', protocol: 22, focused_workspace_id: 'wD', focused_tab_id: 'wD:t1', focused_pane_id: 'wD:p1',
  workspaces: [{ workspace_id: 'wA', label: 'backend', agent_status: 'idle' }, { workspace_id: 'wD', label: 'pier', focused: true, agent_status: 'working' }],
  tabs: [{ tab_id: 'wD:t1', workspace_id: 'wD', number: 1, label: 'main', focused: true, agent_status: 'working' },
    { tab_id: 'wD:t2', workspace_id: 'wD', number: 2, label: 'sub-task', agent_status: 'blocked' }],
  panes: [
    { pane_id: 'wD:p1', workspace_id: 'wD', tab_id: 'wD:t1', agent: 'pi', display_agent: 'master', agent_status: 'working', focused: true, tokens: { 'pi-todo': '▶1 ○2 ■0 ✓1 · Building dashboard' } },
    { pane_id: 'wD:p2', workspace_id: 'wD', tab_id: 'wD:t2', agent: 'pi', display_agent: 'worker', agent_status: 'blocked', title: 'Waiting for auth input', tokens: { 'lock-1234': 'locked-file' } },
    { pane_id: 'wA:p1', workspace_id: 'wA', tab_id: 'wA:t1', agent: 'pi', display_agent: 'master', agent_status: 'idle' },
  ],
};

test('normalizeSnapshot: handles malformed inputs and unpacks response envelopes', () => {
  for (const bad of [null, undefined, 'string']) assert.equal(normalizeSnapshot(bad), null);
  const empty = normalizeSnapshot({});
  for (const key of ['workspaces', 'tabs', 'panes'] as const) assert.deepEqual(empty?.[key], []);
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
  // pi-todo wins over the pane title; blocked panes are marked in the status column
  for (const needle of ['Herdr v0.9.0, proto 22', '[*wD: pier:working]', '[wA: backend:idle]', 'Current Workspace: wD (pier)', '*#1[main](working)', '#2[sub-task](blocked)', 'PANE ID', '▶1 ○2 ■0 ✓1 · Building dashboard', 'worker', 'Waiting for auth input', '[1 lock]', '! BLOCKED'])
    assert.ok(text.includes(needle), needle);
  assert.ok(text.includes('⚠️  ALERT: 1 SUBAGENT(S) BLOCKED — WAITING ON HUMAN DECISION'));
  assert.ok(text.includes('Summary: 2 pane(s) | Pier agents: 2 (1 working, 1 blocked, 0 idle)'));
});

test('composeDashboardLines: panes without an agent render as shell, not unknown', () => {
  const snapshot: SessionSnapshotData = {
    version: '0.9.5', protocol: 22, focused_workspace_id: 'w1',
    workspaces: [{ workspace_id: 'w1', label: 'pier' }],
    tabs: [
      { tab_id: 'w1:t1', workspace_id: 'w1', number: 1, label: 'main', agent_status: 'unknown' },
      { tab_id: 'w1:t2', workspace_id: 'w1', number: 2, label: 'work', agent_status: 'idle' },
    ],
    panes: [
      { pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t2', agent: 'pi', display_agent: 'master', agent_status: 'idle' },
      { pane_id: 'w1:p2', workspace_id: 'w1', tab_id: 'w1:t1', agent: null, agent_status: 'unknown', title: 'zsh' },
    ],
  };
  const text = composeDashboardLines(snapshot, { now: 1700000000000 }).join('\n');
  assert.ok(text.includes('#1[main](shell)'), 'a shell-only tab reports shell, not unknown');
  assert.ok(text.includes('#2[work](idle)'), 'an agent tab keeps its real status');
  const row = text.split('\n').find((l) => l.includes('w1:p2'))!;
  assert.ok(row, 'the shell pane is listed');
  assert.match(row, /shell/, 'no agent → shell, not a stalled unknown');
  assert.doesNotMatch(row, /unknown/);
  assert.equal(paneStatus({ pane_id: 'p3', workspace_id: 'w1', tab_id: 'w1:t1', agent: 'pi', agent_status: 'unknown' }), 'unknown', 'a real agent with unknown status stays unknown');
});

test('composeDashboardLines: targetWorkspaceId option overrides focused workspace', () => {
  const text = composeDashboardLines(SAMPLE_SNAPSHOT, { targetWorkspaceId: 'wA', now: 1700000000000 }).join('\n');
  assert.ok(text.includes('Current Workspace: wA (backend)'));
  assert.ok(text.includes('wA:p1'));
  assert.ok(!text.includes('wD:p1'), 'other workspaces do not leak into the pane table');
  assert.ok(text.includes('Summary: 1 pane(s) | Pier agents: 1 (0 working, 0 blocked, 1 idle)'));
});

test('composeDashboardLines: pi-parent tokens group workers under their delegating master; blocked alert attributes the source', () => {
  const snapshot: SessionSnapshotData = {
    version: '0.9.2', protocol: 22, focused_workspace_id: 'w1',
    workspaces: [{ workspace_id: 'w1', label: 'pier' }],
    tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', number: 1, label: 'main' }],
    panes: [
      { pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1', agent: 'pi', display_agent: 'master', agent_status: 'working', focused: true, tokens: { 'pi-todo': '▶1 ○1 ✓0 · orchestrating' } },
      { pane_id: 'w1:p3', workspace_id: 'w1', tab_id: 'w1:t1', agent: 'pi', display_agent: 'worker', agent_status: 'blocked', tokens: { 'pi-parent': 'w1:p1', 'pi-task': 'run migration tests' } },
      { pane_id: 'w1:p2', workspace_id: 'w1', tab_id: 'w1:t1', agent: 'pi', display_agent: 'worker', agent_status: 'idle', tokens: { 'pi-parent': 'w1:p1' } },
      { pane_id: 'w1:p4', workspace_id: 'w1', tab_id: 'w1:t1', agent: 'shell', agent_status: 'idle', tokens: { 'pi-parent': 'w1:pGone' } },
    ],
  };
  const text = composeDashboardLines(snapshot, { now: 1700000000000 }).join('\n');
  const rows = text.split('\n').filter((l) => /^w1:p\d|^↳ w1:p\d/.test(l));
  assert.deepEqual(rows.map((r) => r.slice(0, 10).trimEnd()), ['w1:p1', '↳ w1:p3', '↳ w1:p2', 'w1:p4'], 'children follow their parent; an orphan parent stays flat');
  // Worker desc falls back through pi-todo → title; the blocked worker carries its delegated task.
  assert.ok(text.includes('↳ w1:p3'));
  assert.ok(text.includes('! BLOCKED'));
  assert.ok(text.includes('⚠️  ALERT: 1 SUBAGENT(S) BLOCKED — WAITING ON HUMAN DECISION [w1:p3 ← w1:p1]'), 'alert names the delegation edge');
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

test('composeDashboardLines: every line fits the requested terminal width (including wide CJK)', () => {
  const wide: SessionSnapshotData = {
    version: '0.9.5', protocol: 22, focused_workspace_id: 'w1',
    workspaces: [
      { workspace_id: 'w1', label: '一个非常长的工作区名称-中文-copy', focused: true, agent_status: 'working' },
      { workspace_id: 'w2', label: 'second-workspace-with-a-long-name' },
    ],
    tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', number: 1, label: '一个很长的任务标签页名称', agent_status: 'working' }],
    panes: [{ pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1', agent: 'pi', display_agent: 'master', agent_status: 'working', tokens: { 'pi-todo': '▶ 构建一个非常长的任务标题用于测试折行 ✓1/8' } }],
  };
  for (const width of [40, 60, 80, 120]) {
    const composed = composeDashboardLines(wide, { width, now: 1700000000000 });
    const lines = fitDashboardLines(composed, { width, height: 1000 }).lines;
    for (const line of lines) assert.ok(displayWidth(line) <= width, `width ${width}: ${displayWidth(line)} cells: ${line}`);
    assert.ok(lines.join('').includes('一个非常长的工作区名称'), 'wrapped free text keeps its content');
  }
});

test('clipToWidth/displayWidth: wide characters are measured in cells, never split mid-surrogate', () => {
  assert.equal(displayWidth('中a'), 3);
  assert.equal(clipToWidth('中文中文', 5), '中文…');
  assert.equal(clipToWidth('abcdef', 4), 'abc…');
  assert.equal(displayWidth(clipToWidth('emoji ⚠️ done', 10)), 10);
});

test('fitDashboardLines: wraps rows, slices the viewport, and clamps the offset', () => {
  const lines = Array.from({ length: 10 }, (_, i) => `line-${i}`);
  const view = fitDashboardLines(lines, { width: 10, height: 3, offset: 0 });
  assert.equal(view.total, 10);
  assert.equal(view.visible, 3);
  assert.equal(view.lines.length, 3);
  const scrolled = fitDashboardLines(lines, { width: 10, height: 3, offset: 8 });
  assert.equal(scrolled.offset, 7, 'offset clamps to total - height');
  assert.equal(scrolled.lines[0], 'line-7');
  const short = fitDashboardLines(lines.slice(0, 2), { width: 80, height: 10, offset: 5 });
  assert.equal(short.offset, 0);
  assert.equal(short.visible, 2);
  // A long logical line becomes physical rows, so no horizontal information is clipped away.
  const wrapped = fitDashboardLines(['0123456789ABCDEF'], { width: 10, height: 10 });
  assert.deepEqual(wrapped.lines, ['0123456789', 'ABCDEF']);
  assert.equal(wrapped.total, 2);
});

test('wrapToWidth: wide characters stay whole and no row exceeds the width', () => {
  assert.deepEqual(wrapToWidth('abcdef', 4), ['abcd', 'ef']);
  assert.deepEqual(wrapToWidth('中文中文', 4), ['中文', '中文']);
  assert.deepEqual(wrapToWidth('a中b', 2), ['a', '中', 'b']);
  assert.ok(wrapToWidth('emoji ⚠️ done', 5).every((line) => displayWidth(line) <= 5));
});
