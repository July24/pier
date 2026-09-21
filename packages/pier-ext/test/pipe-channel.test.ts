/** M11 pipe-channel transport (D45): deterministic naming, the JSON-lines request/response contract,
 * and its error paths. The round trip over a real socket IS the contract here — no in-process fakes. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import * as net from 'node:net';
import * as fs from 'node:fs';
import {
  pipeNameCandidates, pipeNameFor, pipePathFor, pipeRequest, pipeRequestTo, startPipeServer,
} from '../src/pipe-channel.ts';

type Handler = Parameters<typeof startPipeServer>[1];
type FrameCase = { name: string; line: string; handler: Handler; message: RegExp };
type PeerCase = { name: string; timeout: number; match: RegExp; maxMs?: number; accept?: (s: net.Socket) => void };

const uniqueName = (prefix: string): string =>
  `pi-herdr-${prefix.replace(/[^\w]+/g, '-')}-${process.pid}-${Date.now()}`;

const okHandler: Handler = async (req) => ({ type: 'ok', id: req.id });

/** Bind `create(name)` on a fresh pipe name, run `body`, then destroy tracked sockets before close() —
 * a half-open socket stalls `close()` forever and would cancel the file; `beforeBind` seeds the path. */
async function withServer<T>(
  prefix: string,
  create: (name: string) => net.Server,
  body: (name: string) => Promise<T>,
  beforeBind?: (name: string) => void,
): Promise<T> {
  const name = uniqueName(prefix);
  beforeBind?.(name);
  const server = create(name);
  const sockets = new Set<net.Socket>();
  server.on('connection', (sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
  });
  try {
    // `once` rejects on 'error', so a failed bind surfaces instead of hanging.
    if (!server.listening) await once(server, 'listening');
    return await body(name);
  } finally {
    for (const sock of sockets) sock.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Write one raw protocol line to `name` and resolve with the parsed reply frame. */
async function sendLine(name: string, line: string): Promise<Record<string, unknown>> {
  const sock = net.createConnection(pipePathFor(name));
  const done = Promise.withResolvers<string>();
  let buf = '';
  sock.setEncoding('utf8').on('data', (chunk) => { buf += chunk; });
  sock.on('end', () => done.resolve(buf)).on('error', done.reject).on('connect', () => { sock.write(line); });
  return JSON.parse((await done.promise).split('\n')[0] || 'null') as Record<string, unknown>;
}

test('pipe naming: workspace encoding + candidate retry order', () => {
  assert.equal(pipeNameFor('F:\\herdr-pi', 'w6:p2C'), 'pi-herdr---F%3A%5Cherdr-pi---w6-p2C');
  assert.equal(pipeNameFor('/home/u/proj', 'w1:p9'), 'pi-herdr---%2Fhome%2Fu%2Fproj---w1-p9');
  // New (percent-encoded) encoding first, legacy second: the client retries down the list.
  assert.deepEqual(pipeNameCandidates('F:\\herdr-pi', 'w6:p2C'), [
    'pi-herdr---F%3A%5Cherdr-pi---w6-p2C',
    'pi-herdr---F--herdr-pi---w6-p2C',
  ]);
});

test('pipePathFor: win32 namespace prefix, POSIX /tmp socket path', () => {
  const original = process.platform;
  const CASES: Array<[NodeJS.Platform, string, string]> = [
    ['win32', '\\\\.\\pipe\\already', '\\\\.\\pipe\\already'],
    ['win32', 'plain', '\\\\.\\pipe\\plain'],
    ['linux', 'test-pipe', '/tmp/test-pipe.sock'],
  ];
  try {
    for (const [platform, input, expected] of CASES) {
      Object.defineProperty(process, 'platform', { value: platform, writable: true });
      assert.equal(pipePathFor(input), expected, `${platform}: pipePathFor(${input})`);
    }
  } finally {
    Object.defineProperty(process, 'platform', { value: original, writable: true });
  }
});

test('pipeRequest: 往返分发 ping/prompt，error 帧原样交回调用方', async () => {
  const seen: string[] = [];
  await withServer('roundtrip', (name) => startPipeServer(name, async (req) => {
    seen.push(req.type);
    if (req.type === 'ping') return { type: 'ok', id: req.id, detail: 'pong' };
    if (req.type === 'prompt') return { type: 'ok', id: req.id };
    return { type: 'error', id: req.id, message: 'Test error' };
  }), async (name) => {
    assert.deepEqual(await pipeRequest(name, { type: 'ping', id: 'p1' }), { type: 'ok', id: 'p1', detail: 'pong' });
    assert.equal((await pipeRequest(name, { type: 'prompt', id: 'p2', text: 'hi' })).type, 'ok');
    const denied = await pipeRequest(name, { type: 'role', id: 'p3', role: 'reviewer' }, 2000);
    assert.deepEqual(denied, { type: 'error', id: 'p3', message: 'Test error' });
    assert.deepEqual(seen, ['ping', 'prompt', 'role']);
  });
});

test('startPipeServer: bad frame / handler throw answer with error frames', async (t) => {
  const CASES: FrameCase[] = [
    { name: 'malformed line → bad frame', line: 'not-json\n', handler: okHandler, message: /^bad frame$/ },
    {
      name: 'handler throw → error frame with the message',
      line: `${JSON.stringify({ type: 'ping', id: 't1' })}\n`,
      handler: async () => { throw new Error('handler exploded'); },
      message: /handler exploded/,
    },
  ];
  for (const c of CASES) {
    await t.test(c.name, () => withServer(c.name, (name) => startPipeServer(name, c.handler), async (name) => {
      const reply = await sendLine(name, c.line);
      assert.equal(reply.type, 'error');
      assert.match(String(reply.message), c.message);
    }));
  }
});

test('pipeRequest: rejects on bad frame, silence, peer hangup and a missing peer', async (t) => {
  const CASES: PeerCase[] = [
    // Scripted raw peers: junk reply / silence / immediate hangup.
    { name: 'malformed response frame', timeout: 2000, match: /bad response frame/,
      accept: (sock) => sock.on('data', () => { sock.end('not valid JSON\n'); }) },
    { name: 'no answer within the deadline', timeout: 150, match: /timeout/, accept: () => {} },
    { name: 'peer hangs up before answering', timeout: 5000, maxMs: 3000,
      match: /connection closed|EPIPE|ECONNRESET/, accept: (sock) => { sock.end(); } },
    { name: 'no server listening', timeout: 400, match: /ENOENT/ },
  ];
  for (const c of CASES) {
    await t.test(c.name, async () => {
      const started = Date.now();
      const run = async (name: string) => {
        await assert.rejects(() => pipeRequest(name, { type: 'ping', id: 'x' }, c.timeout), c.match);
        // A hangup must reject at once rather than wait out the 5s deadline.
        if (c.maxMs) assert.ok(Date.now() - started < c.maxMs, 'must reject on disconnect, not on timeout');
      };
      await (c.accept
        ? withServer(c.name, (name) => net.createServer(c.accept!).listen(pipePathFor(name)), run)
        : run(uniqueName(c.name)));
    });
  }
});

test('pipeRequestTo: legacy fallback and last-error propagation', async (t) => {
  const cwd = 'F:\\herdr-pi';
  const paneId = `w-test:${process.pid}`;
  const names = pipeNameCandidates(cwd, paneId);
  assert.equal(names.length, 2);
  const legacy: Handler = async (req) => ({ type: 'ok', id: req.id, detail: 'legacy' });
  await t.test('reaches a server listening on the legacy name only', () =>
    withServer('legacy', () => startPipeServer(names[1]!, legacy), async () => {
      assert.deepEqual(await pipeRequestTo(cwd, paneId, { type: 'ping', id: 'mig' }, 2000),
        { type: 'ok', id: 'mig', detail: 'legacy' });
    }));
  await t.test('both names missing throws the last connection error', () =>
    assert.rejects(() => pipeRequestTo(`/no-such-${process.pid}`, 'w0:p0', { type: 'ping', id: 'x' }, 400)));
});

test('startPipeServer (F04): POSIX unlinks a stale socket file before listen', async () => {
  if (process.platform === 'win32') return; // Windows pipes live in the kernel namespace: no stale file
  await withServer('stale', (name) => startPipeServer(name, okHandler), async (name) => {
    const res = await pipeRequest(name, { type: 'ping', id: 'after-stale' }, 2500);
    assert.equal(res.type, 'ok', 'a stale socket file must not break listen');
  }, (name) => {
    // A crashed peer: Node's own close() removes the real socket file, so a placeholder stands in.
    fs.writeFileSync(pipePathFor(name), '');
  });
});

test('startPipeServer (F04): a failed listen reaches onError and never kills the process', async () => {
  // An 'error' event with no listener throws and would take the extension host down, so a failed bind
  // must reach onError while a listener-less server stays alive. The address is squatted: POSIX uses a
  // directory (unlink-proof → EADDRINUSE); Windows a live server holds the name (FIRST_PIPE_INSTANCE).
  const name = uniqueName('badpath');
  const socketPath = pipePathFor(name);
  const squatter = net.createServer(() => {});
  if (process.platform === 'win32') await new Promise<void>((r) => squatter.listen(socketPath, () => r()));
  else fs.mkdirSync(socketPath, { recursive: true });
  try {
    const bound = Promise.withResolvers<Error | null>();
    startPipeServer(name, okHandler, bound.resolve).on('listening', () => bound.resolve(null));
    const seen = await bound.promise;
    assert.ok(seen, 'a failed listen must surface through onError (or a throw)');
    assert.match(String((seen as Error & { code?: string }).code ?? ''), /EADDRINUSE/);
    // Without onError, src's built-in sink must swallow it — the crash would only show once the event
    // fires, and it fires asynchronously, so real time is the only observable here.
    startPipeServer(name, okHandler);
    await new Promise((r) => setTimeout(r, 150));
  } finally {
    await new Promise<void>((resolve) => squatter.close(() => resolve()));
    if (process.platform !== 'win32') fs.rmSync(socketPath, { recursive: true, force: true });
  }
});
