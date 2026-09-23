/** Pure cores behind the hook scripts: notification.show params, agent.view.set params. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildNotificationParams } from '../src/notify.ts';
import { buildAgentViewSetParams } from '../src/agent-view.ts';

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
