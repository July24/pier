/** Worker identity marker: path derivation from a session file, write/read roundtrip, and the
 * boot probe that restores worker mode after a herdr 0.9.2 server restart. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hasWorkerMarker, readWorkerMarker, workerMarkerPath, writeWorkerMarker } from '../src/worker-marker.ts';
import { resolveSessionRoot } from '../src/efficiency-store.ts';
import { withCleanup } from './test-utils.ts';

const SESSION_FILE = '/sessions/--proj--/2026-10-08T01-00-00Z_a1b2c3d4.jsonl';

test('workerMarkerPath: sits beside the efficiency store for the same session (one root per session)', () => {
  const marker = workerMarkerPath(SESSION_FILE)!;
  assert.equal(marker, join(resolveSessionRoot(dirname(SESSION_FILE), 'a1b2c3d4')!, 'worker.json'));
  assert.equal(workerMarkerPath(null), null);
  assert.equal(workerMarkerPath(''), null);
});

test('writeWorkerMarker/hasWorkerMarker/readWorkerMarker: idempotent roundtrip; bare id keys the directory', withCleanup((cleanup) => {
  const dir = cleanup.tempDir('marker');
  const sessionFile = join(dir.path, '2026-10-08T01-00-00Z_a1b2c3d4.jsonl');
  assert.equal(hasWorkerMarker(sessionFile), false);
  writeWorkerMarker(sessionFile, 'worker-default');
  writeWorkerMarker(sessionFile, 'worker-default');
  assert.equal(hasWorkerMarker(sessionFile), true);
  const marker = readWorkerMarker(sessionFile)!;
  assert.equal(marker.v, 1);
  assert.equal(marker.role, 'worker-default');
  assert.ok(marker.ts > 0);
  assert.equal(existsSync(join(dirname(sessionFile), 'herdr-pi', 'a1b2c3d4', 'worker.json')), true, 'timestamp prefix stripped from the id');
  // A master session file in the same directory has no marker of its own.
  assert.equal(hasWorkerMarker(join(dir.path, '2026-10-08T02-00-00Z_e5f6.jsonl')), false);
}));

test('writeWorkerMarker/readWorkerMarker: delegation roundtrips; old markers without it still parse', withCleanup((cleanup) => {
  const dir = cleanup.tempDir('marker-delegation');
  const sessionFile = join(dir.path, '2026-10-08T01-00-00Z_a1b2c3d4.jsonl');
  const delegation = {
    parentPaneId: 'wD:p1',
    parentSessionId: 'e5f6a7b8',
    taskId: 't-42',
    description: 'harden pipe channel',
    role: 'worker-default',
  };
  writeWorkerMarker(sessionFile, 'worker-default', delegation);
  assert.deepEqual(readWorkerMarker(sessionFile)!.delegation, delegation);
  // A torn delegation payload degrades to no-delegation, keeping worker-mode detection intact.
  const markerPath = workerMarkerPath(sessionFile)!;
  writeFileSync(markerPath, `${JSON.stringify({ v: 1, ts: 1, role: 'worker-default', delegation: 'garbage' })}\n`);
  const torn = readWorkerMarker(sessionFile)!;
  assert.equal(torn.role, 'worker-default');
  assert.equal(torn.delegation, undefined);
}));

test('writeWorkerMarker: unwritable location never throws (restore is best-effort)', () => {
  writeWorkerMarker('/definitely/not/writable/2026-10-08T01-00-00Z_a1b2c3d4.jsonl');
  writeWorkerMarker(null);
});

test('readWorkerMarker: torn or foreign JSON is treated as no marker, not an error', withCleanup((cleanup) => {
  const dir = cleanup.tempDir('marker-torn');
  const sessionFile = join(dir.path, '2026-10-08T01-00-00Z_a1b2c3d4.jsonl');
  const marker = workerMarkerPath(sessionFile)!;
  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(marker, '{"v":2,');
  assert.equal(readWorkerMarker(sessionFile), null);
  writeFileSync(marker, '{"v":1,"ts":"not-a-number"}');
  assert.equal(readWorkerMarker(sessionFile), null);
}));
