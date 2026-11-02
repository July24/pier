/** herdr-core client: wire behavior against a fake socket, error kinds, wait semantics, and the
 *  contract — every method/param pier sends must exist in the `hc schema` snapshot. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type Socket } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreClient, CoreError, CoreWatch, childEnvironment, coreUnavailableHint, detectCoreEnv } from '../src/core-client.ts';

interface Call { method: string; params: Record<string, unknown> }
type Answer = { result: unknown } | { error: { kind: string; message: string } };

async function withCore(
  answer: (call: Call) => Answer,
  body: (client: CoreClient, calls: Call[]) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'pier-core-'));
  const socketPath = join(dir, 's.sock');
  const calls: Call[] = [];
  const server: Server = createServer((sock) => {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => {
      buf += chunk;
      const idx = buf.indexOf('\n');
      if (idx < 0) return;
      const req = JSON.parse(buf.slice(0, idx)) as { id: number; method: string; params: Record<string, unknown> };
      calls.push({ method: req.method, params: req.params });
      const a = answer({ method: req.method, params: req.params });
      // A notification before the reply must be skipped by id.
      sock.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'heartbeat', params: { seq: 1 } })}\n`);
      const reply = 'result' in a
        ? { jsonrpc: '2.0', id: req.id, result: a.result }
        : { jsonrpc: '2.0', id: req.id, error: { code: -32000, message: a.error.message, data: { kind: a.error.kind, hint: 'h' } } };
      sock.end(`${JSON.stringify(reply)}\n`);
    });
  });
  const { promise: listening, resolve } = Promise.withResolvers<void>();
  server.listen(socketPath, resolve);
  await listening;
  try {
    await body(new CoreClient({ socketPath, terminalId: 't1' }), calls);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const terminal = (over: Record<string, unknown> = {}) => ({
  address: 't2', labels: {}, argv: [], cwd: '/w', state: 'live', created_ms: 1, screen: 'exact', cols: 80, rows: 24, ...over,
});

test('detectCoreEnv needs both the socket and the terminal id', () => {
  assert.deepEqual(detectCoreEnv({ HC_TERMINAL_SOCKET: '/s', HC_TERMINAL_ID: 't3' }), { socketPath: '/s', terminalId: 't3' });
  assert.equal(detectCoreEnv({ HC_TERMINAL_ID: 't3' }), null);
  assert.equal(detectCoreEnv({ HERDR_ENV: '1', HERDR_SOCKET_PATH: '/s', HERDR_PANE_ID: 'p1' }), null);
});

test('childEnvironment forwards the caller env, drops core identity, applies overrides last', () => {
  const env = childEnvironment({ PATH: '/bin', HC_TERMINAL_ID: 't1', HC_SCOPE: 'x', KEY: 'a', GONE: undefined }, { KEY: 'b' });
  assert.deepEqual(env, { PATH: '/bin', KEY: 'b' });
});

test('getTerminal decodes status/labels; not_found → null; other kinds throw CoreError', async () => {
  await withCore((c) => {
    if (c.params.terminal === 't9') return { error: { kind: 'not_found', message: 'no terminal t9' } };
    if (c.params.terminal === 't8') return { error: { kind: 'unavailable', message: 'lost' } };
    return { result: terminal({ status: { state: 'blocked', kind: 'question', msg: 'Pick one?' }, labels: { 'pier.session': '/s.jsonl' }, parent: 't1' }) };
  }, async (client) => {
    const t = await client.getTerminal('t2');
    assert.equal(t?.status, 'blocked'); assert.equal(t?.statusKind, 'question'); assert.equal(t?.statusMsg, 'Pick one?');
    assert.equal(t?.labels['pier.session'], '/s.jsonl'); assert.equal(t?.parent, 't1');
    assert.equal(await client.getTerminal('t9'), null);
    await assert.rejects(client.getTerminal('t8'), (err: unknown) => err instanceof CoreError && err.kind === 'unavailable');
  });
});

test('an unreported or unknown status word decodes as unknown', async () => {
  await withCore(() => ({ result: { terminals: [terminal(), terminal({ address: 't3', status: { state: 'thinking' } })], hidden_finished: 0, machines: [] } }),
    async (client) => {
      assert.deepEqual((await client.listTerminals()).map((t) => t.status), ['unknown', 'unknown']);
    });
});

test('waitForOutput: output → matched, check-in → timeout, a core refusal → unavailable', async () => {
  const answers: Answer[] = [
    { result: { terminal: 't2', ended: true, reason: 'output', turn: 0, children: [] } },
    { result: { terminal: 't2', ended: false, reason: 'timeout', turn: 0, children: [] } },
    { error: { kind: 'finished', message: 'over' } },
  ];
  await withCore(() => answers.shift()!, async (client) => {
    assert.deepEqual(await client.waitForOutput('t2', 'READY', 1000), { matched: true });
    assert.deepEqual(await client.waitForOutput('t2', 'READY', 1000), { matched: false, reason: 'timeout' });
    assert.deepEqual(await client.waitForOutput('t2', 'READY', 1000), { matched: false, reason: 'unavailable' });
  });
});

test('setLabels removes with an empty value and never throws; run defaults the parent to this terminal', async () => {
  await withCore((c) => (c.method === 'terminal.label' ? { error: { kind: 'not_found', message: 'gone' } } : { result: terminal() }),
    async (client, calls) => {
      await client.setLabels({ 'pier.todo': '▶1', 'pier.lock.x': null });
      assert.deepEqual(calls[0]!.params.labels, { 'pier.todo': '▶1', 'pier.lock.x': '' });
      await client.setLabels({});
      assert.equal(calls.length, 1, 'an empty patch sends nothing');

      await client.run({ argv: ['pi'], noNotify: true });
      assert.equal(calls[1]!.params.parent, 't1'); assert.equal(calls[1]!.params.no_notify, true);
      await client.run({ parent: null });
      assert.equal(calls[2]!.params.no_parent, true); assert.equal('parent' in calls[2]!.params, false);
    });
});

test('kill/remove tolerate a terminal that is already gone', async () => {
  await withCore((c) => ({ error: { kind: c.method === 'terminal.kill' ? 'finished' : 'not_found', message: 'gone' } }), async (client) => {
    await client.kill('t2');
    await client.remove('t2');
  });
});

test('coreUnavailableHint: transport failures get a hint, domain errors do not', () => {
  assert.match(coreUnavailableHint(new Error('connect ENOENT /s.sock')) ?? '', /herdr-core unreachable/);
  assert.equal(coreUnavailableHint(new CoreError('terminal.get', 'not_found', 'x', null)), null);
  assert.equal(coreUnavailableHint(new Error('invalid regex')), null);
});

/* ── contract: requests stay inside the hc 0.1.16 OpenRPC snapshot ── */

interface OpenRpc { methods: Array<{ name: string; params: Array<{ name: string; required?: boolean }> }> }
const schema = JSON.parse(readFileSync(new URL('./fixtures/hc-contract.json', import.meta.url), 'utf8')) as OpenRpc;

test('contract: every request pier sends names a real method, known params, and all required ones', async () => {
  await withCore((c) => {
    if (c.method === 'terminal.list') return { result: { terminals: [], hidden_finished: 0, machines: [] } };
    if (c.method === 'terminal.read') return { result: { text: '', complete: true, how: 'screen' } };
    if (c.method === 'terminal.wait') return { result: { terminal: 't2', ended: true, reason: 'status', turn: 0, children: [], status: 'idle' } };
    if (c.method === 'terminal.interrupt') return { result: { outcome: 'stopped', key: 'esc' } };
    if (c.method === 'server.status') return { result: { version: '0.1.16' } };
    return { result: terminal() };
  }, async (client, calls) => {
    await client.setLabels({ a: 'b' });
    await client.placementLabels();
    await client.getTerminal('t2');
    await client.listTerminals({ labels: { a: 'b' }, all: true });
    await client.run({ argv: ['pi'], cwd: '/w', env: { A: '1' }, labels: { a: 'b' }, name: 'w', noNotify: true });
    await client.run({ line: 'echo hi', parent: null });
    await client.send('t2', 'hi', { force: true });
    await client.keys('t2', ['enter']);
    await client.interrupt('t2');
    await client.read('t2', { lines: 40 });
    await client.waitForOutput('t2', 'x', 1000);
    await client.kill('t2');
    await client.remove('t2');
    await client.serverVersion();
    for (const call of calls) {
      const method = schema.methods.find((m) => m.name === call.method);
      assert.ok(method, `${call.method} is not in hc schema`);
      const known = new Set(method.params.map((p) => p.name));
      for (const key of Object.keys(call.params)) assert.ok(known.has(key), `${call.method}: unknown param ${key}`);
      for (const p of method.params.filter((p) => p.required)) assert.ok(p.name in call.params, `${call.method}: missing ${p.name}`);
    }
  });
});

/* ── CoreWatch: one events.subscribe line kept in sync with the core ── */

interface EventServer {
  /** Subscribe requests in arrival order (one per (re)connection). */
  subscriptions: Array<Record<string, unknown>>;
  /** The next connection that has sent its subscribe request. */
  nextConnection(): Promise<Socket>;
}

async function withEventServer(body: (watch: CoreWatch, server: EventServer) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'pier-watch-'));
  const socketPath = join(dir, 's.sock');
  const subscriptions: Array<Record<string, unknown>> = [];
  const pending: Socket[] = [];
  const takers: Array<(s: Socket) => void> = [];
  const server: Server = createServer((sock) => {
    let buf = '';
    let subscribed = false;
    sock.setEncoding('utf8');
    sock.on('error', () => {});
    sock.on('data', (chunk) => {
      if (subscribed) return;
      buf += chunk;
      const idx = buf.indexOf('\n');
      if (idx < 0) return;
      subscribed = true;
      const req = JSON.parse(buf.slice(0, idx)) as { method: string; params: Record<string, unknown> };
      assert.equal(req.method, 'events.subscribe');
      subscriptions.push(req.params);
      const take = takers.shift();
      if (take) take(sock);
      else pending.push(sock);
    });
  });
  const { promise: listening, resolve } = Promise.withResolvers<void>();
  server.listen(socketPath, resolve);
  await listening;
  const watch = new CoreWatch({ socketPath, terminalId: 't1' });
  try {
    await body(watch, {
      subscriptions,
      nextConnection: () => {
        const ready = pending.shift();
        if (ready) return Promise.resolve(ready);
        const { promise, resolve: take } = Promise.withResolvers<Socket>();
        takers.push(take);
        return promise;
      },
    });
  } finally {
    watch.close();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const send = (sock: Socket, msg: unknown): void => { sock.write(`${JSON.stringify(msg)}\n`); };
const event = (seq: number, terminal: string, type: string, data: unknown) =>
  ({ jsonrpc: '2.0', method: 'event', params: { seq, terminal, type, data } });
const reply = (seq: number, terminals: unknown[]) => ({ jsonrpc: '2.0', id: 1, result: { seq, terminals } });

test('watch: subscribes to its own children with a schema-valid request', async () => {
  await withEventServer(async (watch, server) => {
    const ready = watch.ready();
    send(await server.nextConnection(), reply(1, []));
    assert.equal(await ready, true);
    assert.deepEqual(server.subscriptions, [{ children_of: 't1' }]);
    const method = schema.methods.find((m) => m.name === 'events.subscribe')!;
    const known = new Set(method.params.map((p) => p.name));
    for (const key of Object.keys(server.subscriptions[0]!)) assert.ok(known.has(key), `unknown param ${key}`);
  });
});

test('watch: events patch the snapshot, wake waiters, and stale seqs are ignored', async () => {
  await withEventServer(async (watch, server) => {
    const ready = watch.ready();
    const sock = await server.nextConnection();
    send(sock, reply(5, [terminal({ status: { state: 'working' }, parent: 't1' })]));
    await ready;
    assert.equal(watch.get('t2')?.status, 'working');

    let seen = watch.version('t2');
    const woke = watch.changed('t2', seen, 2000);
    send(sock, event(6, 't2', 'status', { status: { state: 'blocked', kind: 'question', msg: 'Ship?' }, records: {}, reported: true }));
    assert.equal(await woke, true);
    assert.equal(watch.get('t2')?.status, 'blocked');
    assert.equal(watch.get('t2')?.statusMsg, 'Ship?');

    // seq 6 again and an older seq are already reflected; only seq 7 applies.
    seen = watch.version('t2');
    send(sock, event(6, 't2', 'turn', { turn: 9, state: 'done' }));
    send(sock, event(4, 't2', 'turn', { turn: 9, state: 'done' }));
    send(sock, event(7, 't2', 'labels', { labels: { 'pier.todo': '▶1' } }));
    assert.equal(await watch.changed('t2', seen, 2000), true);
    assert.equal(watch.get('t2')?.turn, 0, 'stale turn events were dropped');
    assert.deepEqual(watch.get('t2')?.labels, { 'pier.todo': '▶1' });

    seen = watch.version('t2');
    send(sock, event(8, 't2', 'finished', { reason: 'exited', exit_code: 0, signal: null, finished_ms: 1 }));
    await watch.changed('t2', seen, 2000);
    assert.equal(watch.get('t2')?.state, 'finished');
    seen = watch.version('t2');
    send(sock, event(9, 't2', 'removed', {}));
    await watch.changed('t2', seen, 2000);
    assert.equal(watch.get('t2'), undefined);

    // A change to another terminal does not wake this one.
    seen = watch.version('t2');
    const other = watch.changed('t2', seen, 150);
    send(sock, event(10, 't3', 'created', terminal({ address: 't3', parent: 't1' })));
    assert.equal(await other, false);
    assert.equal(watch.get('t3')?.parent, 't1');
  });
});

test('watch: `missed` replaces the snapshot and wakes every waiter', async () => {
  await withEventServer(async (watch, server) => {
    const ready = watch.ready();
    const sock = await server.nextConnection();
    send(sock, reply(1, [terminal()]));
    await ready;
    const woke = watch.changed('t2', watch.version('t2'), 2000);
    send(sock, { jsonrpc: '2.0', method: 'missed', params: { seq: 30, terminals: [terminal({ address: 't4' })] } });
    assert.equal(await woke, true);
    assert.equal(watch.get('t2'), undefined);
    assert.equal(watch.get('t4')?.id, 't4');
  });
});

test('watch: a dropped line goes blind, wakes waiters, then reconnects with a fresh snapshot', async () => {
  await withEventServer(async (watch, server) => {
    const ready = watch.ready();
    const first = await server.nextConnection();
    send(first, reply(3, [terminal({ status: { state: 'working' } })]));
    await ready;

    const blind = watch.changed('t2', watch.version('t2'), 2000);
    first.destroy();
    assert.equal(await blind, true, 'losing the line is a change for every terminal');
    assert.equal(watch.connected, false);

    // core restarts its seq at 1: the new snapshot must not be filtered as stale.
    const second = await server.nextConnection();
    const back = watch.changed('t2', watch.version('t2'), 3000);
    send(second, reply(1, [terminal({ status: { state: 'done' } })]));
    assert.equal(await back, true);
    assert.equal(watch.connected, true);
    assert.equal(watch.get('t2')?.status, 'done');
    send(second, event(2, 't2', 'turn', { turn: 1, state: 'done' }));
    await watch.changed('t2', watch.version('t2'), 2000);
    assert.equal(watch.get('t2')?.turn, 1);
    assert.equal(server.subscriptions.length, 2);
  });
});

test('watch: close resolves pending waiters with false', async () => {
  await withEventServer(async (watch, server) => {
    const ready = watch.ready();
    send(await server.nextConnection(), reply(1, []));
    await ready;
    const pending = watch.changed('t2', watch.version('t2'), 60_000);
    watch.close();
    assert.equal(await pending, false);
  });
});
