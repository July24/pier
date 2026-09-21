/**
 * Pure cores behind the hook scripts: notification.show params, agent.view.set params, and the
 * boot.jsonl restore plan.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildNotificationParams } from '../src/notify.ts';
import { buildAgentViewSetParams } from '../src/agent-view.ts';
import { latestBootRecordPerWorkspace, parseBootRecords } from '../src/restore-plan.ts';

/* ════════ notify：pane.agent_status_changed → notification.show ════════ */

const blockedEvent = (data: Record<string, unknown>) => ({ type: 'pane.agent_status_changed', data });

test('buildNotificationParams: valid pi blocked event produces correct notification.show params', () => {
  const params = buildNotificationParams(blockedEvent({
    agent: 'pi',
    agent_status: 'blocked',
    pane_id: 'pane-42',
    title: 'Waiting for approval',
  }));

  assert.deepEqual(params, {
    title: 'Subagent blocked: pi',
    body: 'Pane pane-42 needs a human decision — Waiting for approval',
    sound: 'request',
  });
  assert.equal((params as Record<string, unknown>).message, undefined, 'must use body, not message');
});

test('buildNotificationParams: sound option allows valid enum values and falls back for invalid', () => {
  const event = blockedEvent({ agent: 'pi', agent_status: 'blocked', pane_id: 'p1' });
  assert.equal(buildNotificationParams(event, { soundOverride: 'done' })?.sound, 'done');
  assert.equal(buildNotificationParams(event, { soundOverride: 'none' })?.sound, 'none');
  assert.equal(buildNotificationParams(event, { soundOverride: 'invalid_sound' })?.sound, 'request');
});

test('buildNotificationParams: gates out non-pi agents, non-blocked states and malformed events', () => {
  assert.equal(buildNotificationParams(blockedEvent({ agent: 'claude', agent_status: 'blocked', pane_id: 'p1' })), null);
  assert.equal(buildNotificationParams(blockedEvent({ agent: null, agent_status: 'blocked', pane_id: 'p1' })), null);
  for (const status of ['working', 'idle', 'unknown', 'ready']) {
    assert.equal(
      buildNotificationParams(blockedEvent({ agent: 'pi', agent_status: status, pane_id: 'p1' })),
      null,
      `status ${status} must be gated out`,
    );
  }

  assert.equal(buildNotificationParams(null), null);
  assert.equal(buildNotificationParams(undefined), null);
  assert.equal(buildNotificationParams('string-event'), null);
  assert.equal(buildNotificationParams({ type: 'other.event' }), null);
  assert.equal(buildNotificationParams({ type: 'pane.agent_status_changed' }), null);
});

test('buildNotificationParams: body falls back for a missing title and normalizes pane ids', () => {
  assert.equal(
    buildNotificationParams(blockedEvent({ agent: 'pi', agent_status: 'blocked', pane_id: 'p99' }))?.body,
    'Pane p99 needs a human decision',
  );
  assert.equal(
    buildNotificationParams(blockedEvent({ agent: 'pi', agent_status: 'blocked' }))?.body,
    'Pane ? needs a human decision',
  );
  assert.equal(
    buildNotificationParams(blockedEvent({ agent: 'pi', agent_status: 'blocked', pane_id: 123 }))?.body,
    'Pane 123 needs a human decision',
  );
});

/* ════════ agent-view：agent.view.set（D105 无 harness 过滤） ════════ */

test('buildAgentViewSetParams: defaults conform to the Herdr 0.9.0 agent.view.set schema', () => {
  const params = buildAgentViewSetParams();

  assert.equal(params.source, 'pier.workbench');
  assert.equal(params.label, 'Pier');
  // No harness filter: agent.view.set replaces Herdr's built-in Agents projection globally, so any
  // filter silently hides the harnesses it omits.
  assert.equal(params.filter, null);
  assert.deepEqual(params.sort, [
    { field: 'attention', order: 'desc' },
    { field: 'pane_order', order: 'asc' },
  ]);
});

test('buildAgentViewSetParams: source/label/filter overrides are honored', () => {
  const custom = buildAgentViewSetParams({ source: 'custom.source', label: 'Custom View' });
  assert.equal(custom.source, 'custom.source');
  assert.equal(custom.label, 'Custom View');
  assert.equal(custom.filter, null);

  const filtered = buildAgentViewSetParams({ filter: { op: 'exists', field: { token: 'custom-only' } } });
  assert.deepEqual(filtered.filter, { op: 'exists', field: { token: 'custom-only' } });
});

/* ════════ restore-plan：boot.jsonl（F05 追加日志） ════════ */

test('parseBootRecords: 跳过空行、坏行与缺少 workspace_id 的记录', () => {
  const text = [
    '',
    '{"workspace_id":"w1","tab_id":"w1:t1","pane_id":"w1:p1"}',
    '{"workspace_id":"w2"', // 半截（崩溃写坏）行
    '{"tab_id":"w3:t1"}', // 没有 workspace_id
    'null',
    '[]',
    '{"workspace_id":"w3","tab_id":"w3:t1","pane_id":"w3:p1"}',
    '   ',
  ].join('\n');
  assert.deepEqual(parseBootRecords(text).map((r) => r.workspace_id), ['w1', 'w3']);
  assert.deepEqual(parseBootRecords(''), []);
});

test('latestBootRecordPerWorkspace: 同 workspace 只保留最新一条（追加顺序 = 时间顺序）', () => {
  const latest = latestBootRecordPerWorkspace(parseBootRecords([
    '{"workspace_id":"w1","tab_id":"w1:t1","pane_id":"w1:p1"}',
    '{"workspace_id":"w1","tab_id":"w1:t1","pane_id":"w1:p9"}',
    '{"workspace_id":"w1","tab_id":"w1:t1","pane_id":"w1:p2"}',
    '{"workspace_id":"w2","tab_id":"w2:t1","pane_id":"w2:p1"}',
    '{"workspace_id":"w1","tab_id":"w1:t2","pane_id":"w1:p3"}',
  ].join('\n')));

  assert.equal(latest.length, 2, '一个 workspace 恰好恢复一次');
  const w1 = latest.find((r) => r.workspace_id === 'w1');
  assert.equal(w1?.pane_id, 'w1:p3', '取最后一条（关机时有效的 pane）');
  assert.equal(w1?.tab_id, 'w1:t2');
  assert.equal(latest.find((r) => r.workspace_id === 'w2')?.pane_id, 'w2:p1');
  assert.deepEqual(latestBootRecordPerWorkspace([]), []);
});
