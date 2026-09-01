/**
 * index-runtime: master vs worker vs herdr-absent branching.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planIndexMode } from '../src/index-runtime.ts';

test('planIndexMode: worker flag wins even inside herdr', () => {
  const mode = planIndexMode({
    PI_HERDR_SUBAGENT: '1',
    HERDR_ENV: '1',
    HERDR_SOCKET_PATH: '/tmp/s',
    HERDR_PANE_ID: 'p1',
  });
  assert.equal(mode.isSubagent, true);
  assert.equal(mode.hasHerdr, true);
  assert.equal(mode.composeMaster, false);
});

test('planIndexMode: herdr pane without worker flag → compose master', () => {
  const mode = planIndexMode({
    HERDR_ENV: '1',
    HERDR_SOCKET_PATH: '/tmp/s',
    HERDR_PANE_ID: 'p1',
  });
  assert.equal(mode.isSubagent, false);
  assert.equal(mode.hasHerdr, true);
  assert.equal(mode.composeMaster, true);
});

test('planIndexMode: herdr unavailable → no master manifest or workbench', () => {
  const mode = planIndexMode({});
  assert.equal(mode.isSubagent, false);
  assert.equal(mode.hasHerdr, false);
  assert.equal(mode.composeMaster, false);
});
