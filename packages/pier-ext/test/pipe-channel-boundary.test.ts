/**
 * pipe-channel boundary tests.
 * Covers: malformed frames, timeouts, error responses.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Server } from 'node:net';
import { randomUUID } from 'node:crypto';
import { pipeRequest, pipePathFor, parsePipeLine } from '../src/pipe-channel.ts';

test('parsePipeLine: valid request', () => {
  const line = '{"type":"ping","id":"test-123"}';
  const result = parsePipeLine(line);
  assert.equal(result?.type, 'ping');
  assert.equal(result?.id, 'test-123');
});

test('parsePipeLine: malformed JSON returns null', () => {
  const result = parsePipeLine('not valid JSON');
  assert.equal(result, null);
});

test('parsePipeLine: empty line returns null', () => {
  const result = parsePipeLine('');
  assert.equal(result, null);
});

test('pipeRequest: successful ping', async () => {
  const pipeName = `test-ping-${randomUUID()}`;
  const pipePath = pipePathFor(pipeName);
  
  const server = new Server((socket) => {
    socket.on('data', (data) => {
      const req = JSON.parse(data.toString());
      socket.write(JSON.stringify({ type: 'ok', id: req.id }) + '\n');
      socket.end();
    });
  });
  
  await new Promise<void>((resolve) => server.listen(pipePath, resolve));
  
  try {
    const result = await pipeRequest(pipeName, { type: 'ping', id: 'test' }, 1000);
    assert.equal(result.type, 'ok');
  } finally {
    server.close();
  }
});

test('pipeRequest: malformed response', async () => {
  const pipeName = `test-malformed-${randomUUID()}`;
  const pipePath = pipePathFor(pipeName);
  
  const server = new Server((socket) => {
    socket.on('data', () => {
      socket.write('not valid JSON\n');
      socket.end();
    });
  });
  
  await new Promise<void>((resolve) => server.listen(pipePath, resolve));
  
  try {
    await assert.rejects(
      () => pipeRequest(pipeName, { type: 'ping', id: 'test' }, 1000),
      /bad response frame/
    );
  } finally {
    server.close();
  }
});

test('pipeRequest: timeout', async () => {
  const pipeName = `test-timeout-${randomUUID()}`;
  const pipePath = pipePathFor(pipeName);
  
  const server = new Server((socket) => {
    socket.on('data', () => {
      // Never respond
    });
  });
  
  await new Promise<void>((resolve) => server.listen(pipePath, resolve));
  
  try {
    await assert.rejects(
      () => pipeRequest(pipeName, { type: 'ping', id: 'test' }, 100),
      /timeout/
    );
  } finally {
    server.close();
  }
});

test('pipeRequest: error response', async () => {
  const pipeName = `test-error-${randomUUID()}`;
  const pipePath = pipePathFor(pipeName);
  
  const server = new Server((socket) => {
    socket.on('data', (data) => {
      const req = JSON.parse(data.toString());
      socket.write(JSON.stringify({ type: 'error', id: req.id, message: 'Test error' }) + '\n');
      socket.end();
    });
  });
  
  await new Promise<void>((resolve) => server.listen(pipePath, resolve));
  
  try {
    const result = await pipeRequest(pipeName, { type: 'ping', id: 'test' }, 1000);
    assert.equal(result.type, 'error');
    assert.equal(result.message, 'Test error');
  } finally {
    server.close();
  }
});

test('pipePathFor: Windows path format', () => {
  const originalPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32', writable: true });
  
  const path = pipePathFor('test-pipe');
  assert.ok(path.startsWith('\\\\.\\pipe\\'), 'Windows path should start with \\\\.\\pipe\\');
  
  Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
});

test('pipePathFor: Unix path format', () => {
  const originalPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'linux', writable: true });
  
  const path = pipePathFor('test-pipe');
  assert.ok(path.startsWith('/tmp/'), 'Unix path should start with /tmp/');
  assert.ok(path.endsWith('.sock'), 'Unix path should end with .sock');
  
  Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
});
