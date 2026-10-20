/** Delegation identity pure chain: env → context → section/tokens/title, plus the branch fold
 * and the record validator shared by the marker and the custom entry. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DELEGATION_CUSTOM_TYPE,
  DELEGATION_ENV,
  DELEGATION_TASK_TOKEN,
  applyWorkerTag,
  buildDelegationSection,
  delegationEnv,
  delegationFromRecord,
  delegationSidebarTokens,
  foldDelegation,
  parseDelegationContext,
} from '../src/delegation-core.ts';

const CTX = {
  parentPaneId: 'wD:p1',
  parentSessionId: 'a1b2c3d4',
  taskId: 't-9',
  description: 'refactor auth flow',
  role: 'reviewer',
};

test('delegationEnv ↔ parseDelegationContext: JSON roundtrip, contract env name', () => {
  const env = delegationEnv(CTX);
  assert.deepEqual(Object.keys(env), [DELEGATION_ENV]);
  assert.deepEqual(parseDelegationContext(env[DELEGATION_ENV]), CTX);
});

test('parseDelegationContext: absent/torn/malformed input degrades to null', () => {
  for (const bad of [undefined, null, '', '{', '[]', '"text"', '{"taskId":"t"}', '{"description":"d"}'])
    assert.equal(parseDelegationContext(bad), null, JSON.stringify(bad));
});

test('parseDelegationContext: empty parent ids are tolerated (tests/RPC), role defaults', () => {
  const parsed = parseDelegationContext(JSON.stringify({ parentPaneId: '', parentSessionId: '', taskId: 't', description: 'd' }));
  assert.deepEqual(parsed, { parentPaneId: '', parentSessionId: '', taskId: 't', description: 'd', role: 'worker-default' });
});

test('delegationFromRecord: non-object records are null, not an error', () => {
  for (const bad of [null, undefined, 'x', 7, []]) assert.equal(delegationFromRecord(bad), null);
  assert.deepEqual(delegationFromRecord({ ...CTX }), CTX);
});

test('buildDelegationSection: identity, self pane, and the delivery contract are all present', () => {
  const text = buildDelegationSection(CTX, 'wD:p2');
  assert.match(text, /master pane wD:p1 \(session a1b2c3d4\)/);
  assert.match(text, /Task: refactor auth flow\. Role: reviewer\./);
  assert.match(text, /pane wD:p2 \(agentId "wD:p2"\)/);
  assert.match(text, /state your final answer plainly/);
  assert.match(text, /say exactly what blocks you/);
  // Unknown parent ids degrade to placeholders instead of empty strings.
  const bare = buildDelegationSection({ ...CTX, parentPaneId: '', parentSessionId: '' }, '');
  assert.match(bare, /master pane unknown pane \(session unknown session\)/);
  assert.doesNotMatch(bare, /agentId/);
});

test('delegationSidebarTokens: parent+task tokens; no parent pane → empty patch (no report)', () => {
  assert.deepEqual(delegationSidebarTokens(CTX), { 'pi-parent': 'wD:p1', 'pi-task': 'refactor auth flow' });
  assert.deepEqual(delegationSidebarTokens({ ...CTX, parentPaneId: '' }), {});
});

test('delegationSidebarTokens: long descriptions clip at the herdr 80-char boundary', () => {
  const tokens = delegationSidebarTokens({ ...CTX, description: 'x'.repeat(120) });
  assert.equal(tokens[DELEGATION_TASK_TOKEN]!.length, 80);
});

test('applyWorkerTag: prefixes a todo title, stands alone before the first todo_write, passes masters through', () => {
  assert.equal(applyWorkerTag('▶1 ○2 ■0 ✓0 (1/2) · wiring', CTX.description), '↳ ▶1 ○2 ■0 ✓0 (1/2) · wiring');
  assert.equal(applyWorkerTag(null, CTX.description), '↳ refactor auth flow');
  assert.equal(applyWorkerTag('plain title', null), 'plain title');
  assert.equal(applyWorkerTag(null, null), null);
});

test('applyWorkerTag: standalone fallback clips so the tagged title stays ≤80', () => {

  assert.equal((applyWorkerTag(null, 'y'.repeat(120)) ?? '').length, 80);
});

test('foldDelegation: last branch entry wins; foreign/torn entries are skipped', () => {
  const entries = [
    { type: 'custom', customType: DELEGATION_CUSTOM_TYPE, data: { ...CTX, description: 'first' } },
    { type: 'custom', customType: 'pi-herdr.subs', data: { subs: [] } },
    { type: 'user', content: 'hi' },
    { type: 'custom', customType: DELEGATION_CUSTOM_TYPE, data: { taskId: 't-9', description: 'second', role: 'coder' } },
    { type: 'custom', customType: DELEGATION_CUSTOM_TYPE, data: { broken: true } },
  ];
  assert.deepEqual(foldDelegation(entries), { parentPaneId: '', parentSessionId: '', taskId: 't-9', description: 'second', role: 'coder' });
  assert.equal(foldDelegation([]), null);
  assert.equal(foldDelegation([{ type: 'custom', customType: DELEGATION_CUSTOM_TYPE, data: { broken: true } }]), null);
});

test('parseDelegationContext: parentPipe roundtrips; absent stays absent (Phase 2 report_progress dial-home)', () => {
  const withPipe = delegationEnv({ ...CTX, parentPipe: 'pi-herdr--proj--p1' });
  assert.equal(parseDelegationContext(withPipe[DELEGATION_ENV])?.parentPipe, 'pi-herdr--proj--p1');
  const withoutPipe = delegationEnv(CTX);
  assert.equal(parseDelegationContext(withoutPipe[DELEGATION_ENV])?.parentPipe, undefined);
});
