/**
 * D101-D103 efficiency store & I/O adapter: session-id containment, content-addressed object
 * round-trip with integrity verification, the JSONL log writer, bash-full-output gating, pruning.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  appendEfficiencyLog,
  clearVerifiedObjectCacheForTest,
  isValidSessionId,
  pruneObjectsDirectory,
  pruneSessionObjects,
  readBashFullOutput,
  readStoredObjectChunk,
  resolveSessionRoot,
  storeContentAddressedObject,
} from '../src/efficiency-store.ts';
import { withCleanup } from './test-utils.ts';

test('isValidSessionId & resolveSessionRoot: format validation and path-traversal containment', () => {
  assert.equal(isValidSessionId('session-123_abc.test'), true); assert.equal(isValidSessionId('01a03bf0'), true);

  assert.equal(isValidSessionId('../../etc/passwd'), false); assert.equal(isValidSessionId(''), false);
  assert.equal(isValidSessionId(null), false); assert.equal(isValidSessionId('bad/id'), false);

  assert.equal(resolveSessionRoot('/tmp/sessions', '01a03bf0'), join('/tmp/sessions', 'herdr-pi', '01a03bf0'));
  assert.equal(resolveSessionRoot(null, '01a03bf0'), null); assert.equal(resolveSessionRoot('/tmp/sessions', '../../bad'), null);
});

test('storeContentAddressedObject & readStoredObjectChunk: round-trip, idempotence, integrity', withCleanup(async (cleanup) => {
  const filePath = join(cleanup.tempDir('store').path, 'objects', 'test_obj.txt');
  const content = 'Hello world!\nLine 2\nLine 3\n';

  const res = await storeContentAddressedObject(filePath, content);
  assert.equal(res.path, filePath); assert.equal(res.bytes, Buffer.byteLength(content, 'utf8'));
  assert.equal(res.lines, 3); assert.equal((await storeContentAddressedObject(filePath, content)).hash, res.hash, 'same content, same hash');

  const chunk = await readStoredObjectChunk(filePath, 0, { maxBytes: 1024, maxLines: 2 });
  assert.equal(chunk.text, 'Hello world!\nLine 2\n'); assert.equal(chunk.lines, 2);
  assert.equal(chunk.eof, false);

  // An existing object is verified before reuse: wrong size first, then an equal-length rewrite.
  clearVerifiedObjectCacheForTest();
  await writeFile(filePath, 'tampered content');
  await assert.rejects(() => storeContentAddressedObject(filePath, content), /size mismatch/);

  clearVerifiedObjectCacheForTest();
  const tamperedSameLength = 'Hello world!\nLine 2\nLine 9\n';
  assert.equal(Buffer.byteLength(tamperedSameLength, 'utf8'), Buffer.byteLength(content, 'utf8'));
  await writeFile(filePath, tamperedSameLength, 'utf8');
  await assert.rejects(() => storeContentAddressedObject(filePath, content), /hash mismatch/);
}));

test('appendEfficiencyLog: appends newline-delimited JSON', withCleanup(async (cleanup) => {
  const logPath = join(cleanup.tempDir('log').path, 'logs', 'test.jsonl');
  await appendEfficiencyLog(logPath, { event: 'step_1', val: 100 });
  await appendEfficiencyLog(logPath, { event: 'step_2', val: 200 });

  const lines = (await readFile(logPath, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2); assert.deepEqual(lines[0], { event: 'step_1', val: 100 });
  assert.deepEqual(lines[1], { event: 'step_2', val: 200 });
}));

test('readBashFullOutput: rejects non-bash logs and paths outside tmpdir', withCleanup(async (cleanup) => {
  assert.equal(await readBashFullOutput('/tmp/not-bash.log', 1000), null); assert.equal(await readBashFullOutput(null, 1000), null);
  assert.equal(await readBashFullOutput('/tmpEvil/pi-bash-fake.log', 1000), null);
  assert.equal(await readBashFullOutput('/tmp/../etc/pi-bash-fake.log', 1000), null);

  const tempFile = join(cleanup.tempDir('bash-out').path, 'pi-bash-test1234.log');
  await writeFile(tempFile, 'Full diagnostic output text\nPass', 'utf8');
  const res = await readBashFullOutput(tempFile, 1000);
  assert.ok(res !== null); assert.equal(res!.content, 'Full diagnostic output text\nPass');
  assert.equal(res!.lines, 2);
}));

test('pruneObjectsDirectory: drops the oldest objects once the file count is over the limit', withCleanup(async (cleanup) => {
  const dir = join(cleanup.tempDir('prune').path, 'objects');
  for (const [name, mtime] of [['file1.txt', 1000], ['file2.txt', 2000], ['file3.txt', 3000]] as const) {
    const file = join(dir, name);
    await storeContentAddressedObject(file, `content ${name}`);
    await utimes(file, mtime, mtime); // distinct mtimes, no sleep needed
  }

  assert.equal(await pruneObjectsDirectory(dir, { maxFiles: 2 }), 1);
  const remaining = await readdir(dir);
  assert.equal(remaining.length, 2); assert.equal(remaining.includes('file1.txt'), false, 'the oldest file is the one pruned');
  assert.equal(remaining.includes('file2.txt'), true); assert.equal(remaining.includes('file3.txt'), true);
}));

test('pruneSessionObjects: prunes both content-addressed dirs of one session root', withCleanup(async (cleanup) => {
  const root = join(cleanup.tempDir('prune-session').path, 'herdr-pi', 'sess');
  const obsDir = join(root, 'observation-pack', 'objects');
  const redDir = join(root, 'evidence-preserving-reducer', 'objects');

  for (const [dir, name, mtime] of [
    [obsDir, 'obs_a.txt', 1000],
    [obsDir, 'obs_b.txt', 2000],
    [redDir, 'hash_c.txt', 1000],
    [redDir, 'hash_d.txt', 2000],
  ] as const) {
    await storeContentAddressedObject(join(dir, name), `content ${name}`);
    await utimes(join(dir, name), mtime, mtime);
  }

  assert.equal(await pruneSessionObjects(root, { maxFiles: 1 }), 2, 'one file pruned per directory'); assert.equal((await readdir(obsDir)).length, 1);
  assert.equal((await readdir(redDir)).length, 1);
}));
