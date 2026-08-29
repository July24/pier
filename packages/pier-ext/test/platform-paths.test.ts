/**
 * platform-paths: injectable overrides; production singleton is non-empty.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createPlatformPaths, platformPaths } from '../src/platform-paths.ts';

test('createPlatformPaths: overrides win; sessionsDir defaults under agentDataDir', () => {
  const p = createPlatformPaths({
    agentDataDir: '/x/agent',
    worktreeBaseDir: '/x/wt',
  });
  assert.equal(p.agentDataDir, '/x/agent');
  assert.equal(p.worktreeBaseDir, '/x/wt');
  assert.equal(p.sessionsDir, join('/x/agent', 'sessions'));
});

test('createPlatformPaths: explicit sessionsDir is kept', () => {
  const p = createPlatformPaths({
    agentDataDir: '/x/agent',
    sessionsDir: '/custom/sessions',
  });
  assert.equal(p.sessionsDir, '/custom/sessions');
});

test('platformPaths singleton: required dirs are absolute-ish non-empty', () => {
  assert.ok(platformPaths.agentDataDir.length > 0);
  assert.ok(platformPaths.worktreeBaseDir.length > 0);
  assert.ok(platformPaths.sessionsDir.length > 0);
});
