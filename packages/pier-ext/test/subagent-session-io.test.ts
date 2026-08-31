/**
 * subSessionState must tolerate herdr-reported session paths that do not
 * exist yet (session 01a055c5: spawn-failed on `null.length`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HerdrClientLike } from '../src/herdr-client.ts';
import { createSessionIo } from '../src/subagent-session-io.ts';

function io(reported: string | null, sessionsDir: string, ownSession = '') {
  return createSessionIo({
    client: {
      getAgentSessionPath: async () => reported,
    } as unknown as HerdrClientLike,
    getSessionId: () => ownSession,
    sessionsDir: () => sessionsDir,
  });
}

test('subSessionState: missing reported jsonl is skipped (01a055c5 null.length)', async () => {
  const sessionsDir = mkdtempSync(join(tmpdir(), 'pier-session-io-'));
  const ghost = join(sessionsDir, 'not-created-yet.jsonl');
  const state = await io(ghost, sessionsDir).subSessionState('wC:p4', sessionsDir, Date.now());
  assert.deepEqual(state, { text: null, pendingTool: false, activity: false });
});

test('subSessionState: readable session after injectTs still settles', async () => {
  const sessionsDir = mkdtempSync(join(tmpdir(), 'pier-session-io-'));
  const file = join(sessionsDir, 'child.jsonl');
  const ts = 1_800_000_000_000;
  writeFileSync(file, JSON.stringify({
    type: 'message',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      timestamp: ts + 10,
      stopReason: 'stop',
    },
  }) + '\n');
  const state = await io(file, sessionsDir).subSessionState('wC:p4', sessionsDir, ts);
  assert.deepEqual(state, { text: 'ok', pendingTool: false, activity: true });
});
