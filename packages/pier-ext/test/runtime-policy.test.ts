/**
 * runtime-policy: env overrides and invalid-value fallback.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimePolicy } from '../src/runtime-policy.ts';
import { withCleanup } from './test-utils.ts';

test('createRuntimePolicy: overrides beat env', () => {
  const p = createRuntimePolicy({ gitTimeoutMs: 42, subagentTimeoutMs: 99 });
  assert.equal(p.gitTimeoutMs, 42);
  assert.equal(p.subagentTimeoutMs, 99);
});

test('createRuntimePolicy: observationWindowMs and readinessTimeoutMs defaults', () => {
  const p = createRuntimePolicy();
  assert.equal(p.observationWindowMs, 30_000);
  assert.equal(p.readinessTimeoutMs, 30_000);
});

test('createRuntimePolicy: PIER_GIT_TIMEOUT_MS and PIER_SUBAGENT_TIMEOUT_MS', withCleanup(async (cleanup) => {
  const env = cleanup.env();
  env.set('PIER_GIT_TIMEOUT_MS', '2500');
  env.set('PIER_SUBAGENT_TIMEOUT_MS', '8000');
  const p = createRuntimePolicy();
  assert.equal(p.gitTimeoutMs, 2500);
  assert.equal(p.subagentTimeoutMs, 8000);
}));

test('createRuntimePolicy: invalid env falls back to default', withCleanup(async (cleanup) => {
  const env = cleanup.env();
  env.set('PIER_GIT_TIMEOUT_MS', 'nope');
  env.set('PIER_SUBAGENT_TIMEOUT_MS', '-1');
  const p = createRuntimePolicy();
  assert.equal(p.gitTimeoutMs, 10_000);
  assert.equal(p.subagentTimeoutMs, 600_000);
}));
