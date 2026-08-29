/**
 * subagent execute planners: launch validation, isolate guard, foreground wait.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FOREGROUND_POLL_MS,
  planForegroundTick,
  planIsolateRepoGuard,
  planLaunchValidation,
  planPatienceExpiry,
} from '../src/subagent-launch.ts';

test('planLaunchValidation: herdr missing / empty prompt / isolate×cwd', () => {
  assert.equal(planLaunchValidation({ prompt: 'x' }, false).kind, 'error');
  assert.equal(planLaunchValidation({ prompt: '   ' }, true).kind, 'error');
  const mutex = planLaunchValidation({ prompt: 'x', isolate: true, cwd: '/tmp' }, true);
  assert.equal(mutex.kind, 'error');
  if (mutex.kind === 'error') assert.match(mutex.text, /mutually exclusive/);
});

test('planLaunchValidation: defaults role and extracts suggested tools', () => {
  const ok = planLaunchValidation({
    description: 'scan',
    prompt: 'do it',
    run_in_background: true,
    allowed_tools: ['read', 1, 'write'],
    tab: 'feat',
  }, true);
  assert.equal(ok.kind, 'ok');
  if (ok.kind !== 'ok') return;
  assert.equal(ok.spec.description, 'scan');
  assert.equal(ok.background, true);
  assert.equal(ok.manifestRole, 'worker-default');
  assert.deepEqual(ok.suggested, ['read', 'write']);
  assert.equal(ok.tab, 'feat');
  assert.equal(ok.roleKind, 'task');
});

test('planIsolateRepoGuard: missing HEAD is an error', () => {
  assert.equal(planIsolateRepoGuard(null).kind, 'error');
  const ok = planIsolateRepoGuard('abc123\n');
  assert.equal(ok.kind, 'ok');
  if (ok.kind === 'ok') assert.equal(ok.sha, 'abc123\n');
});

test('planForegroundTick: blocked / settle / wait / collect / continue', () => {
  assert.equal(planForegroundTick({
    state: 'blocked', session: { text: null, pendingTool: false, activity: false },
  }).kind, 'blocked');
  assert.deepEqual(planForegroundTick({
    state: 'idle', session: { text: 'done', pendingTool: false, activity: true },
  }), { kind: 'settled', text: 'done' });
  assert.deepEqual(planForegroundTick({
    state: 'idle', session: { text: null, pendingTool: true, activity: false },
  }), { kind: 'wait', delayMs: FOREGROUND_POLL_MS });
  assert.equal(planForegroundTick({
    state: 'done', session: { text: null, pendingTool: false, activity: true },
  }).kind, 'collect-final');
  assert.equal(planForegroundTick({
    state: null, session: { text: null, pendingTool: false, activity: false },
  }).kind, 'continue');
});

test('planPatienceExpiry: live pane moves to background', () => {
  assert.equal(planPatienceExpiry(true), 'move-to-background');
  assert.equal(planPatienceExpiry(false), 'timeout');
});
