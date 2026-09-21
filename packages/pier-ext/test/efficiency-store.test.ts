/**
 * D101-D103 Efficiency Store & I/O Adapter Tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendEfficiencyLog,
  clearVerifiedObjectCacheForTest,
  efficiencyLogPath,
  isValidSessionId,
  observationObjectPath,
  pruneObjectsDirectory,
  pruneSessionObjects,
  readBashFullOutput,
  readStoredObjectChunk,
  reducerObjectPath,
  resolveSessionRoot,
  storeContentAddressedObject,
} from '../src/efficiency-store.ts';

test('isValidSessionId & resolveSessionRoot: validates format and prevents path traversal', () => {
  assert.equal(isValidSessionId('session-123_abc.test'), true);
  assert.equal(isValidSessionId('01a03bf0'), true);

  assert.equal(isValidSessionId('../../etc/passwd'), false);
  assert.equal(isValidSessionId(''), false);
  assert.equal(isValidSessionId(null), false);
  assert.equal(isValidSessionId('bad/id'), false);

  assert.equal(
    resolveSessionRoot('/tmp/sessions', '01a03bf0'),
    join('/tmp/sessions', 'herdr-pi', '01a03bf0'),
  );
  assert.equal(resolveSessionRoot(null, '01a03bf0'), null);
  assert.equal(resolveSessionRoot('/tmp/sessions', '../../bad'), null);
});

test('path helpers generate clean normalized paths', () => {
  const root = '/tmp/sessions/herdr-pi/sess_1';
  assert.equal(
    observationObjectPath(root, 'obs_123'),
    join(root, 'observation-pack', 'objects', 'obs_123.txt'),
  );
  assert.equal(
    reducerObjectPath(root, 'hash_abc'),
    join(root, 'evidence-preserving-reducer', 'objects', 'hash_abc.txt'),
  );
  assert.equal(
    efficiencyLogPath(root, 'compact'),
    join(root, 'efficiency-logs', 'compact.jsonl'),
  );
});

test('storeContentAddressedObject & readStoredObjectChunk: round-trip, idempotence and integrity', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'pier-store-test-'));
  try {
    const filePath = join(tempDir, 'objects', 'test_obj.txt');
    const content = 'Hello world!\nLine 2\nLine 3\n';

    // 1. Initial write
    const res = await storeContentAddressedObject(filePath, content);
    assert.equal(res.path, filePath);
    assert.equal(res.bytes, Buffer.byteLength(content, 'utf8'));
    assert.equal(res.lines, 3);

    // 2. Idempotent write with same content
    const res2 = await storeContentAddressedObject(filePath, content);
    assert.equal(res2.hash, res.hash);

    // 3. Read chunk
    const chunk = await readStoredObjectChunk(filePath, 0, { maxBytes: 1024, maxLines: 2 });
    assert.equal(chunk.text, 'Hello world!\nLine 2\n');
    assert.equal(chunk.lines, 2);
    assert.equal(chunk.eof, false);

    // 4. Corrupted file with mismatched size must throw
    clearVerifiedObjectCacheForTest();
    await writeFile(filePath, 'tampered content');
    await assert.rejects(
      () => storeContentAddressedObject(filePath, content),
      /size mismatch/,
    );

    // 5. Corrupted file with exact same length but different content must throw hash mismatch
    clearVerifiedObjectCacheForTest();
    const tamperedSameLength = 'Hello world!\nLine 2\nLine 9\n'; // exact 27 bytes as content
    assert.equal(Buffer.byteLength(tamperedSameLength, 'utf8'), Buffer.byteLength(content, 'utf8'));
    await writeFile(filePath, tamperedSameLength, 'utf8');
    await assert.rejects(
      () => storeContentAddressedObject(filePath, content),
      /hash mismatch/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('appendEfficiencyLog: appends newline-delimited JSON', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'pier-log-test-'));
  try {
    const logPath = join(tempDir, 'logs', 'test.jsonl');
    await appendEfficiencyLog(logPath, { event: 'step_1', val: 100 });
    await appendEfficiencyLog(logPath, { event: 'step_2', val: 200 });

    const raw = await readFile(logPath, 'utf8');
    const lines = raw.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.deepEqual(lines[0], { event: 'step_1', val: 100 });
    assert.deepEqual(lines[1], { event: 'step_2', val: 200 });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('readBashFullOutput: rejects non-bash logs and paths outside tmpdir', async () => {
  assert.equal(await readBashFullOutput('/tmp/not-bash.log', 1000), null);
  assert.equal(await readBashFullOutput(null, 1000), null);
  assert.equal(await readBashFullOutput('/tmpEvil/pi-bash-fake.log', 1000), null);
  assert.equal(await readBashFullOutput('/tmp/../etc/pi-bash-fake.log', 1000), null);

  const tempFile = join(tmpdir(), 'pi-bash-test1234.log');
  await writeFile(tempFile, 'Full diagnostic output text\nPass', 'utf8');
  try {
    const res = await readBashFullOutput(tempFile, 1000);
    assert.ok(res !== null);
    assert.equal(res!.content, 'Full diagnostic output text\nPass');
    assert.equal(res!.lines, 2);
  } finally {
    await rm(tempFile, { force: true });
  }
});

test('pruneObjectsDirectory: removes oldest objects when file count or total size exceeds limits', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'pier-prune-test-'));
  try {
    const dir = join(tempDir, 'objects');
    await storeContentAddressedObject(join(dir, 'file1.txt'), 'content 1');
    // slight delay for mtime distinction
    await new Promise((r) => setTimeout(r, 10));
    await storeContentAddressedObject(join(dir, 'file2.txt'), 'content 2');
    await new Promise((r) => setTimeout(r, 10));
    await storeContentAddressedObject(join(dir, 'file3.txt'), 'content 3');

    // Prune to max 2 files
    const removed = await pruneObjectsDirectory(dir, { maxFiles: 2 });
    assert.equal(removed, 1);

    const remaining = await readdir(dir);
    assert.equal(remaining.length, 2);
    // file1.txt was oldest, so it must have been pruned
    assert.equal(remaining.includes('file1.txt'), false);
    assert.equal(remaining.includes('file2.txt'), true);
    assert.equal(remaining.includes('file3.txt'), true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('pruneSessionObjects: prunes both content-addressed dirs of one session root', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'pier-prune-session-test-'));
  try {
    const root = join(tempDir, 'herdr-pi', 'sess');
    const obsDir = join(root, 'observation-pack', 'objects');
    const redDir = join(root, 'evidence-preserving-reducer', 'objects');

    for (const [dir, name] of [
      [obsDir, 'obs_a.txt'],
      [obsDir, 'obs_b.txt'],
      [redDir, 'hash_c.txt'],
      [redDir, 'hash_d.txt'],
    ] as const) {
      await storeContentAddressedObject(join(dir, name), `content ${name}`);
      await new Promise((r) => setTimeout(r, 5)); // distinct mtimes for oldest-first pruning
    }

    const removed = await pruneSessionObjects(root, { maxFiles: 1 });
    assert.equal(removed, 2, 'one file pruned per directory');
    const obsFiles = await readdir(obsDir);
    const redFiles = await readdir(redDir);
    assert.equal(obsFiles.length, 1);
    assert.equal(redFiles.length, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
