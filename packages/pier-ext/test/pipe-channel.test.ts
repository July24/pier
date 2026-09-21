/**
 * M11 pipe-channel transport layer (D45): deterministic naming, round trips, timeouts, bad frames,
 * plus the boundary cases (malformed response, timeout, error response) of the JSON-lines protocol.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import * as fs from 'node:fs';
import {
  pipeNameCandidates,
  pipeNameFor,
  pipePathFor,
  pipeRequest,
  pipeRequestTo,
  startPipeServer,
} from '../src/pipe-channel.ts';

test('pipeNameFor: collision-resistant workspace encoding + paneId', () => {
  assert.equal(
    pipeNameFor('F:\\herdr-pi', 'w6:p2C'),
    'pi-herdr---F%3A%5Cherdr-pi---w6-p2C',
  );
  assert.equal(
    pipeNameFor('/home/u/proj', 'w1:p9'),
    'pi-herdr---%2Fhome%2Fu%2Fproj---w1-p9',
  );
});

test('pipeNameCandidates: new encoding first, then legacy', () => {
  assert.deepEqual(pipeNameCandidates('F:\\herdr-pi', 'w6:p2C'), [
    'pi-herdr---F%3A%5Cherdr-pi---w6-p2C',
    'pi-herdr---F--herdr-pi---w6-p2C',
  ]);
});

test('pipePathFor: win32 does not double-prefix an already-namespaced pipe', () => {
  const original = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32', writable: true });
  try {
    assert.equal(pipePathFor('\\\\.\\pipe\\already'), '\\\\.\\pipe\\already');
    assert.equal(pipePathFor('plain'), '\\\\.\\pipe\\plain');
  } finally {
    Object.defineProperty(process, 'platform', { value: original, writable: true });
  }
});

test('pipePathFor: POSIX falls back to a /tmp socket path', () => {
  const original = process.platform;
  Object.defineProperty(process, 'platform', { value: 'linux', writable: true });
  try {
    assert.equal(pipePathFor('test-pipe'), '/tmp/test-pipe.sock');
  } finally {
    Object.defineProperty(process, 'platform', { value: original, writable: true });
  }
});

test('pipeRequest/startPipeServer: 往返 + ping + 错误帧', async () => {
  const seen: string[] = [];
  await withPipeServer('test', async (req) => {
    seen.push(req.type);
    if (req.type === 'ping') return { type: 'ok', id: req.id, detail: 'pong' };
    if (req.type === 'prompt') return { type: 'ok', id: req.id };
    return { type: 'error', id: req.id, message: `unknown ${req.type}` };
  }, async (name) => {
    const ping = await pipeRequest(name, { type: 'ping', id: 'p1' });
    assert.deepEqual(ping, { type: 'ok', id: 'p1', detail: 'pong' });
    const prompt = await pipeRequest(name, { type: 'prompt', id: 'p2', text: 'hi' });
    assert.equal(prompt.type, 'ok');
    assert.deepEqual(seen, ['ping', 'prompt']);
  });
});

test('pipeRequest: error response 原样交回调用方', async () => {
  await withPipeServer('err', async (req) => ({ type: 'error', id: req.id, message: 'Test error' }), async (name) => {
    const res = await pipeRequest(name, { type: 'ping', id: 'test' }, 2000);
    assert.equal(res.type, 'error');
    if (res.type === 'error') assert.equal(res.message, 'Test error');
  });
});

test('pipeRequest: malformed response frame rejects', async () => {
  const name = `pi-herdr-malformed-${process.pid}-${Date.now()}`;
  const server = net.createServer((sock) => {
    sock.on('data', () => { sock.end('not valid JSON\n'); });
  });
  await new Promise<void>((resolve) => server.listen(pipePathFor(name), () => resolve()));
  try {
    await assert.rejects(() => pipeRequest(name, { type: 'ping', id: 'x' }, 2000), /bad response frame/);
  } finally {
    await closeServer(server);
  }
});

test('pipeRequest: no answer within the deadline rejects with a timeout', async () => {
  const name = `pi-herdr-timeout-${process.pid}-${Date.now()}`;
  const sockets: net.Socket[] = [];
  const server = net.createServer((sock) => {
    sockets.push(sock); // accept, read, never answer
  });
  await new Promise<void>((resolve) => server.listen(pipePathFor(name), () => resolve()));
  try {
    await assert.rejects(() => pipeRequest(name, { type: 'ping', id: 'x' }, 150), /timeout/);
  } finally {
    for (const s of sockets) s.destroy();
    await closeServer(server);
  }
});

test('pipeRequest: 连接不存在 → 抛错（调用方重试）', async () => {
  await assert.rejects(
    () => pipeRequest(`pi-herdr-nobody-${process.pid}-${Date.now()}`, { type: 'ping', id: 'x' }, 1500),
  );
});

test('pipeRequestTo: reaches a server listening on the legacy name', async () => {
  const cwd = 'F:\\herdr-pi';
  const paneId = `w-test:${process.pid}`;
  const names = pipeNameCandidates(cwd, paneId);
  assert.equal(names.length, 2);
  const server = startPipeServer(names[1], async (req) => ({ type: 'ok', id: req.id, detail: 'legacy' }));
  try {
    await waitListening(server);
    const res = await pipeRequestTo(cwd, paneId, { type: 'ping', id: 'mig' }, 2000);
    assert.equal(res.type, 'ok');
    if (res.type === 'ok') assert.equal(res.detail, 'legacy');
  } finally {
    await closeServer(server);
  }
});

test('pipeRequestTo: both names missing throws the last connection error', async () => {
  await assert.rejects(
    () => pipeRequestTo(`/no-such-${process.pid}`, 'w0:p0', { type: 'ping', id: 'x' }, 400),
  );
});

/** Start a server on a unique pipe name, run `body`, then close it. */
async function withPipeServer(
  prefix: string,
  handler: Parameters<typeof startPipeServer>[1],
  body: (name: string) => Promise<void>,
): Promise<void> {
  const name = `pi-herdr-${prefix}-${process.pid}-${Date.now()}`;
  const server = startPipeServer(name, handler);
  try {
    await waitListening(server);
    await body(name);
  } finally {
    await closeServer(server);
  }
}

async function waitListening(server: net.Server): Promise<void> {
  if (server.listening) return;
  const wait = Promise.withResolvers<void>();
  server.once('listening', wait.resolve);
  server.once('error', wait.reject);
  await wait.promise;
}

async function closeServer(server: net.Server): Promise<void> {
  const s = server as unknown as { closeAllConnections?: () => void };
  s.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test('startPipeServer: bad frame replies type=error message=bad frame', async () => {
  await withPipeServer('badframe', async (req) => ({ type: 'ok', id: req.id }), async (name) => {
    const sock = net.createConnection(pipePathFor(name));
    sock.setEncoding('utf8');
    const wait = Promise.withResolvers<string>();
    let buf = '';
    sock.on('data', (chunk) => { buf += chunk; });
    sock.on('end', () => wait.resolve(buf));
    sock.on('error', wait.reject);
    sock.on('connect', () => sock.write('not-json\n'));
    const reply = JSON.parse((await wait.promise).split('\n')[0] ?? 'null') as { type?: string; message?: string };
    assert.equal(reply.type, 'error');
    assert.equal(reply.message, 'bad frame');
  });
});

test('startPipeServer: handler throw becomes error response with the message', async () => {
  await withPipeServer('throw', async () => {
    throw new Error('handler exploded');
  }, async (name) => {
    const res = await pipeRequest(name, { type: 'ping', id: 't1' }, 2000);
    assert.equal(res.type, 'error');
    if (res.type === 'error') assert.match(res.message, /handler exploded/);
  });
});

/* ── F04 / F16 regression seams ─────────────────────────────────── */

test('startPipeServer (F04): POSIX 上先清掉崩溃残留的 socket 文件再 listen', async () => {
  if (process.platform === 'win32') return; // Windows named pipes live in the kernel namespace — no stale file
  const name = `pi-herdr-stale-${process.pid}-${Date.now()}`;
  const p = pipePathFor(name);
  // Simulate a crashed previous process: the socket path is still occupied (Node's own close() removes
  // the file, so a placeholder file stands in for it).
  fs.writeFileSync(p, '');
  assert.ok(fs.existsSync(p), 'precondition: path is occupied');
  const server = startPipeServer(name, async (req) => ({ type: 'ok', id: req.id }));
  try {
    const res = await pipeRequest(name, { type: 'ping', id: 'after-stale' }, 2500);
    assert.equal(res.type, 'ok', 'a stale socket file must not break listen');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('pipeRequest (F16): 对端在回包前断开 → 立刻报错（不再等到超时）', async () => {
  const name = `pi-herdr-drop-${process.pid}-${Date.now()}`;
  const live: net.Socket[] = [];
  const server = net.createServer((sock) => {
    live.push(sock);
    sock.end(); // accept the connection and hang up without ever answering
  });
  await new Promise<void>((resolve) => server.listen(pipePathFor(name), () => resolve()));
  try {
    const t0 = Date.now();
    await assert.rejects(
      () => pipeRequest(name, { type: 'ping', id: 'x' }, 5000),
      /connection closed|EPIPE|ECONNRESET/,
    );
    assert.ok(Date.now() - t0 < 3000, 'must reject on disconnect, not wait for the 5s timeout');
  } finally {
    // A half-open socket keeps server.close() from ever calling back (the runner would cancel the file).
    for (const s of live) s.destroy();
    await closeServer(server);
  }
});

test('startPipeServer (F04): listen 失败必须可见（onError），且无人接听时也不崩进程', async () => {
  // An EventEmitter 'error' with no listener throws and would kill the extension host, so the failure
  // has to surface through onError while a listener-less server stays alive.
  // Occupy the socket address: POSIX uses a directory (unlink-proof → EADDRINUSE); Windows pipe names
  // live in the kernel namespace, so a live server squats the name instead (FIRST_PIPE_INSTANCE → EADDRINUSE).
  const name = `pi-herdr-badpath-${process.pid}-${Date.now()}`;
  const p = pipePathFor(name);
  const squatter = net.createServer(() => {});
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => squatter.listen(p, () => resolve()));
  } else {
    fs.mkdirSync(p, { recursive: true });
  }
  try {
    const seen = await new Promise<Error | null>((resolve) => {
      let server: net.Server | null = null;
      try {
        server = startPipeServer(name, async (req) => ({ type: 'ok', id: req.id }), (e) => resolve(e));
        server.on('listening', () => resolve(null));
      } catch (e) {
        resolve(e as Error);
        return;
      }
      setTimeout(() => resolve(null), 2500);
    });
    assert.ok(seen, 'a failed listen must surface through onError (or a throw)');
    const code = seen && typeof seen === 'object' && 'code' in seen ? seen.code : undefined;
    assert.match(String(code ?? ''), /EADDRINUSE/);
    // Same failure without onError: the process must survive (an unhandled 'error' would kill the file).
    const noListener = startPipeServer(name, async (req) => ({ type: 'ok', id: req.id }));
    noListener.on('error', () => { /* keep the test process alive on purpose */ });
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(true);
  } finally {
    await new Promise<void>((resolve) => squatter.close(() => resolve()));
    if (process.platform !== 'win32') fs.rmSync(p, { recursive: true, force: true });
  }
});
