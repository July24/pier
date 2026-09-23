/** Pure cores behind the hook scripts: notification.show params, agent.view.set params, boot.jsonl restore plan. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildNotificationParams } from '../src/notify.ts';
import { buildAgentViewSetParams } from '../src/agent-view.ts';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMasterPane, latestBootRecordPerWorkspace, parseBootRecords, rebuiltBootRecord } from '../src/restore-plan.ts';

/* ════════ notify: pane.agent_status_changed → notification.show ════════ */

const blockedEvent = (data: Record<string, unknown>) => ({ type: 'pane.agent_status_changed', data });

test('buildNotificationParams: valid pi blocked event produces correct notification.show params', () => {
  const params = buildNotificationParams(blockedEvent({ agent: 'pi', agent_status: 'blocked', pane_id: 'pane-42', title: 'Waiting for approval' }));
  assert.deepEqual(params, { title: 'Subagent blocked: pi', body: 'Pane pane-42 needs a human decision — Waiting for approval', sound: 'request' });
  assert.ok(params !== null && !('message' in params), 'must use body, not message');
});

test('buildNotificationParams: sound option allows valid enum values and falls back for invalid', () => {
  const event = blockedEvent({ agent: 'pi', agent_status: 'blocked', pane_id: 'p1' });
  for (const [override, expected] of [['done', 'done'], ['none', 'none'], ['invalid_sound', 'request']] as const) {
    assert.equal(buildNotificationParams(event, { soundOverride: override })?.sound, expected, override);
  }
});

test('buildNotificationParams: gates out non-pi agents, non-blocked states and malformed events', () => {
  assert.equal(buildNotificationParams(blockedEvent({ agent: 'claude', agent_status: 'blocked', pane_id: 'p1' })), null);
  assert.equal(buildNotificationParams(blockedEvent({ agent: null, agent_status: 'blocked', pane_id: 'p1' })), null);
  for (const status of ['working', 'idle', 'unknown', 'ready']) {
    assert.equal(buildNotificationParams(blockedEvent({ agent: 'pi', agent_status: status, pane_id: 'p1' })), null, `status ${status} must be gated out`);
  }
  for (const malformed of [null, undefined, 'string-event', { type: 'other.event' }, { type: 'pane.agent_status_changed' }]) {
    assert.equal(buildNotificationParams(malformed), null, `malformed ${JSON.stringify(malformed)}`);
  }
});

test('buildNotificationParams: body falls back for a missing title and normalizes pane ids', () => {
  const body = (data: Record<string, unknown>) => buildNotificationParams(blockedEvent({ agent: 'pi', agent_status: 'blocked', ...data }))?.body;
  assert.equal(body({ pane_id: 'p99' }), 'Pane p99 needs a human decision');
  assert.equal(body({}), 'Pane ? needs a human decision');
  assert.equal(body({ pane_id: 123 }), 'Pane 123 needs a human decision');
});

/* ════════ agent-view: agent.view.set (D105: no harness filter) ════════ */

test('buildAgentViewSetParams: defaults conform to the Herdr 0.9.0 agent.view.set schema', () => {
  const params = buildAgentViewSetParams();
  assert.equal(params.source, 'pier.workbench');
  assert.equal(params.label, 'Pier');
  // No harness filter: agent.view.set replaces Herdr's built-in Agents projection globally, so any filter hides harnesses.
  assert.equal(params.filter, null);
  assert.deepEqual(params.sort, [{ field: 'attention', order: 'desc' }, { field: 'pane_order', order: 'asc' }]);
});

test('buildAgentViewSetParams: source/label/filter overrides are honored', () => {
  const custom = buildAgentViewSetParams({ source: 'custom.source', label: 'Custom View' });
  assert.equal(custom.source, 'custom.source');
  assert.equal(custom.label, 'Custom View');
  assert.equal(custom.filter, null);
  const filtered = buildAgentViewSetParams({ filter: { op: 'exists', field: { token: 'custom-only' } } });
  assert.deepEqual(filtered.filter, { op: 'exists', field: { token: 'custom-only' } });
});

/* ════════ restore-plan: boot.jsonl (F05 append log) ════════ */

test('parseBootRecords: 跳过空行、坏行与缺少 workspace_id 的记录', () => {
  // truncated (crash-write), missing workspace_id, null / [] and blank lines are not records
  const text = [
    '', '{"workspace_id":"w1","tab_id":"w1:t1","pane_id":"w1:p1"}', '{"workspace_id":"w2"', '{"tab_id":"w3:t1"}',
    'null', '[]', '{"workspace_id":"w3","tab_id":"w3:t1","pane_id":"w3:p1"}', '   ',
  ].join('\n');
  assert.deepEqual(parseBootRecords(text).map((r) => r.workspace_id), ['w1', 'w3']);
  assert.deepEqual(parseBootRecords(''), []);
});

test('latestBootRecordPerWorkspace: 同 workspace 只保留最新一条（追加顺序 = 时间顺序）', () => {
  const latest = latestBootRecordPerWorkspace(parseBootRecords([
    '{"workspace_id":"w1","tab_id":"w1:t1","pane_id":"w1:p1"}', '{"workspace_id":"w1","tab_id":"w1:t1","pane_id":"w1:p9"}',
    '{"workspace_id":"w1","tab_id":"w1:t1","pane_id":"w1:p2"}', '{"workspace_id":"w2","tab_id":"w2:t1","pane_id":"w2:p1"}', '{"workspace_id":"w1","tab_id":"w1:t2","pane_id":"w1:p3"}',
  ].join('\n')));
  assert.equal(latest.length, 2, '一个 workspace 恰好恢复一次');
  const w1 = latest.find((r) => r.workspace_id === 'w1');
  assert.equal(w1?.pane_id, 'w1:p3', '取最后一条（关机时有效的 pane）');
  assert.equal(w1?.tab_id, 'w1:t2');
  assert.equal(latest.find((r) => r.workspace_id === 'w2')?.pane_id, 'w2:p1');
  assert.deepEqual(latestBootRecordPerWorkspace([]), []);
});

test('isMasterPane / rebuiltBootRecord: live master detection and the record that points at it', () => {
  assert.equal(isMasterPane({ pane_id: 'p', agent: 'pi' }), true);
  assert.equal(isMasterPane({ pane_id: 'p', title: '▶ main' }), true);
  assert.equal(isMasterPane({ pane_id: 'p', title: 'zsh' }), false);
  const rec = { workspace_id: 'w1', tab_id: 'w1:t1', pane_id: 'w1:p1', cwd: '/repo' };
  assert.deepEqual(rebuiltBootRecord(rec, { tabId: 'w1:t9', paneId: 'w1:p9' }, 5), { workspace_id: 'w1', tab_id: 'w1:t9', pane_id: 'w1:p9', cwd: '/repo', ts: 5 });
  assert.equal(rebuiltBootRecord(rec, { paneId: 'w1:p9' }, 5)?.tab_id, 'w1:t1', 'a split keeps the recorded tab');
  assert.equal(rebuiltBootRecord(rec, { tabId: 'w1:t9', paneId: null }, 5), null);
});

test('restore-layout: a rebuilt main tab is recorded, so the next startup does not build another master', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pier-restore-'));
  const home = join(dir, 'home');
  const bootFile = join(home, '.pi', 'agent', 'herdr-pi', 'boot.jsonl');
  mkdirSync(join(home, '.pi', 'agent', 'herdr-pi'), { recursive: true });
  writeFileSync(bootFile, JSON.stringify({ workspace_id: 'w1', tab_id: 'w1:t1', pane_id: 'w1:p1', cwd: dir }) + '\n');
  writeFileSync(join(dir, 'boot-config.json'), JSON.stringify({ mainTabLabel: 'main', piNode: 'node', piCli: 'cli.js', extPath: 'ext.ts' }));

  // Stateful fake herdr: the old tab is gone after a restart, layout.apply creates a live master.
  const panes: Array<Record<string, string>> = [{ pane_id: 'w1:p5', tab_id: 'w1:t5', workspace_id: 'w1', title: 'zsh' }];
  const tabs = new Set(['w1:t5']);
  const calls: string[] = [];
  const server = createServer((sock) => {
    sock.setEncoding('utf8');
    sock.on('data', (line: string) => {
      const { id, method, params } = JSON.parse(line.trim());
      calls.push(method);
      let result: unknown = {};
      if (method === 'pane.list') result = { panes };
      else if (method === 'workspace.get') result = { workspace: { workspace_id: 'w1' } };
      else if (method === 'tab.get') {
        if (!tabs.has(params.tab_id)) { sock.end(JSON.stringify({ id, error: { code: 'not_found', message: 'no tab' } }) + '\n'); return; }
        result = { tab: { tab_id: params.tab_id } };
      } else if (method === 'layout.apply') {
        tabs.add('w1:t9');
        panes.push({ pane_id: 'w1:p9', tab_id: 'w1:t9', workspace_id: 'w1', agent: 'pi' });
        result = { tab: { tab_id: 'w1:t9' }, panes: [{ pane_id: 'w1:p9' }] };
      }
      sock.end(JSON.stringify({ id, result }) + '\n');
    });
  });
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\pier-restore-${process.pid}` : join(dir, 'herdr.sock');
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const script = fileURLToPath(new URL('../scripts/restore-layout.mjs', import.meta.url));
  const run = () => new Promise<void>((resolve, reject) => {
    execFile(process.execPath, [...process.execArgv.filter((a) => !a.startsWith('--test')), script], {
      env: { ...process.env, HOME: home, USERPROFILE: home, HERDR_SOCKET_PATH: socketPath, HERDR_PLUGIN_CONFIG_DIR: dir },
    }, (err) => (err ? reject(err) : resolve()));
  });
  try {
    await run();
    await run();
    assert.equal(calls.filter((m) => m === 'layout.apply').length, 1, 'the second startup finds the rebuilt master instead of rebuilding');
    const newest = latestBootRecordPerWorkspace(parseBootRecords(readFileSync(bootFile, 'utf8')))[0];
    assert.equal(newest?.tab_id, 'w1:t9');
    assert.equal(newest?.pane_id, 'w1:p9');
    // pi-pier's focus poller finds heat-reflow.mjs through this record when it is installed from npm.
    assert.equal(readFileSync(join(home, '.pi', 'agent', 'herdr-pi', 'workbench-root'), 'utf8').trim(), fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, ''));
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
