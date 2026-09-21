/**
 * herdr-client: env detection, the Noop contract, the NDJSON socket protocol, and the A6 wire
 * contract — regenerate fixtures/herdr-contract.json after a herdr upgrade so drift shows up here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  HERDR_PROTOCOL_EXPECTED, HerdrClient, NoopHerdrClient, createHerdrClient, detectHerdrEnv,
  herdrSocketTarget, herdrUnavailableHint,
} from '../src/herdr-client.ts';
import { LOCK_BATCH_LIMIT } from '../src/lock-core.ts';
import { withCleanup, type CleanupContext } from './test-utils.ts';

type RpcHandler = (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>;
/** Either the handler itself, or one canned reply per method; an unlisted method answers `{ ok: true }`. */
type RpcAnswers = RpcHandler | Record<string, unknown>;

/** One NDJSON request per connection; the handler's value becomes the `result` envelope. */
class FakeHerdrServer {
  readonly socketPath: string;
  readonly received: Array<{ method: string; params: Record<string, unknown> }> = [];
  rawResponse: string | null = null;
  error: { code: string; message: string } | null = null;
  handler: RpcHandler = () => ({ ok: true });
  private server: Server | null = null;
  private readonly sockets = new Set<{ destroy(): void; on(event: string, cb: () => void): void }>();

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  listen(): Promise<void> {
    this.server = createServer((socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
      socket.setEncoding('utf8');
      let buf = '';
      socket.on('data', (chunk: string) => {
        buf += chunk;
        const idx = buf.indexOf('\n');
        if (idx < 0) return;
        if (this.rawResponse != null) {
          socket.write(this.rawResponse);
          socket.end();
          return;
        }
        let msg: { id?: string; method?: string; params?: Record<string, unknown> };
        try {
          msg = JSON.parse(buf.slice(0, idx).trim()) as typeof msg;
        } catch {
          socket.write(JSON.stringify({ id: '1', error: { code: 'parse', message: 'bad json' } }) + '\n');
          socket.end();
          return;
        }
        this.received.push({ method: String(msg.method ?? ''), params: msg.params ?? {} });
        if (this.error) {
          socket.write(JSON.stringify({ id: msg.id ?? '1', error: this.error }) + '\n');
          socket.end();
          return;
        }
        // Async arrow so a synchronous handler throw becomes a rejection (error envelope), like the real server.
        void (async () => this.handler(String(msg.method ?? ''), msg.params ?? {}))().then((result) => {
          socket.write(JSON.stringify({ id: msg.id ?? '1', result }) + '\n');
          socket.end();
        }, (err: Error) => {
          socket.write(JSON.stringify({ id: msg.id ?? '1', error: { code: 'error', message: err.message } }) + '\n');
          socket.end();
        });
      });
    });
    const ready = Promise.withResolvers<void>();
    this.server.once('error', ready.reject);
    // Same conversion as HerdrClient.target(): win32 maps to \\.\pipe\, otherwise listening on a raw
    // file path fails with EACCES.
    this.server.listen(herdrSocketTarget(this.socketPath), () => ready.resolve());
    return ready.promise;
  }

  close(): Promise<void> {
    const server = this.server;
    if (!server) return Promise.resolve();
    const done = Promise.withResolvers<void>();
    // Destroy live connections first: a client that never hangs up would keep close() pending.
    for (const socket of this.sockets) socket.destroy();
    server.close(() => {
      try { unlinkSync(this.socketPath); } catch { /* already gone */ }
      done.resolve();
    });
    return done.promise;
  }
}

/** Real-socket case: `answers` replies to the request, `setup` tweaks the server before it listens. */
function rpcTest(
  name: string,
  answers: RpcAnswers,
  body: (client: HerdrClient, server: FakeHerdrServer) => Promise<void>,
  setup?: (server: FakeHerdrServer) => void,
): void {
  test(name, withCleanup(async (cleanup: CleanupContext) => {
    const dir = cleanup.tempDir('herdr');
    const server = new FakeHerdrServer(join(dir.path, `s-${randomUUID().slice(0, 8)}.sock`));
    server.handler = typeof answers === 'function' ? answers : (method) => answers[method] ?? { ok: true };
    setup?.(server);
    await server.listen();
    const client = new HerdrClient({ socketPath: server.socketPath, paneId: 'p-self', workspaceId: 'w1', tabId: 't1' });
    try {
      await body(client, server);
    } finally {
      await server.close();
    }
  }));
}

test('detectHerdrEnv: requires HERDR_ENV=1 plus socket and pane', () => {
  assert.equal(detectHerdrEnv({}), null);
  assert.equal(detectHerdrEnv({ HERDR_ENV: '1' }), null);
  assert.equal(detectHerdrEnv({ HERDR_ENV: '1', HERDR_SOCKET_PATH: '/tmp/s' }), null);
  const full = { HERDR_ENV: '1', HERDR_SOCKET_PATH: '/tmp/s', HERDR_PANE_ID: 'p1', HERDR_WORKSPACE_ID: 'w1', HERDR_TAB_ID: 't1' };
  assert.deepEqual(detectHerdrEnv(full), { socketPath: '/tmp/s', paneId: 'p1', workspaceId: 'w1', tabId: 't1' });
  // missing workspace/tab default to empty string
  const bare = { HERDR_ENV: '1', HERDR_SOCKET_PATH: '/tmp/s', HERDR_PANE_ID: 'p1' };
  assert.deepEqual(detectHerdrEnv(bare), { socketPath: '/tmp/s', paneId: 'p1', workspaceId: '', tabId: '' });
});

test('createHerdrClient: missing env → Noop; present env → live client', () => {
  const missing = createHerdrClient({});
  assert.equal(missing.env, null);
  assert.equal(missing.client.available, false);
  assert.ok(missing.client instanceof NoopHerdrClient);

  const live = createHerdrClient({ HERDR_ENV: '1', HERDR_SOCKET_PATH: '/tmp/s', HERDR_PANE_ID: 'p1' });
  assert.equal(live.client.available, true);
  assert.ok(live.client instanceof HerdrClient);
});

test('NoopHerdrClient: queries empty; split/createTab throw', async () => {
  const c = new NoopHerdrClient();
  assert.equal(c.available, false);
  assert.deepEqual(await c.listAgents(), []);
  assert.deepEqual(await c.tabList(), []);
  assert.equal(await c.waitAgent(), null);
  assert.deepEqual(await c.readPane(), { text: '', revision: 0, truncated: false });
  await assert.rejects(() => c.splitPane(), /herdr-managed pane/);
  await assert.rejects(() => c.createTab(), /herdr-managed pane/);
});

test('herdrSocketTarget: Unix passthrough; Windows named-pipe prefix', () => {
  assert.equal(herdrSocketTarget('/tmp/herdr.sock', 'darwin'), '/tmp/herdr.sock');
  assert.equal(herdrSocketTarget('/tmp/herdr.sock', 'linux'), '/tmp/herdr.sock');
  assert.equal(herdrSocketTarget('herdr-pipe', 'win32'), '\\\\.\\pipe\\herdr-pipe');
  assert.equal(herdrSocketTarget('\\\\.\\pipe\\already', 'win32'), '\\\\.\\pipe\\already');
});

rpcTest('HerdrClient: pane.list maps fields; connection roundtrip',
  { 'pane.list': { panes: [{ pane_id: 'p2', tab_id: 't1', workspace_id: 'w1', agent_status: 'idle' }] } },
  async (client, server) => {
    assert.deepEqual(await client.listPanes(), [{ paneId: 'p2', tabId: 't1', workspaceId: 'w1', agentStatus: 'idle' }]);
    assert.equal(server.received[0]?.method, 'pane.list');
  });

rpcTest('HerdrClient: listAgents maps agent_session.value', {
  'agent.list': { agents: [{ pane_id: 'p2', agent: 'pi', agent_status: 'working', state_labels: { k: 'v' }, tokens: { 'pi-todo': 'x' },
    agent_session: { value: '/sess/a.jsonl', kind: 'path' } }] },
}, async (client) => {
  const agents = await client.listAgents();
  assert.equal(agents.length, 1);
  assert.equal(agents[0].paneId, 'p2');
  assert.equal(agents[0].session, '/sess/a.jsonl');
  assert.equal(agents[0].status, 'working');
  assert.equal(await client.getAgentSessionPath('p2'), '/sess/a.jsonl');
  assert.equal(await client.getAgentSessionPath('missing'), null);
});

rpcTest('HerdrClient: splitPane extracts a nested pane_id via findIdIn',
  { 'pane.split': { created: { pane_id: 'p-new' } } }, async (client, server) => {
    assert.equal(await client.splitPane({ direction: 'right', cwd: '/repo' }), 'p-new');
    assert.equal(server.received[0]?.params.direction, 'right');
    assert.equal(server.received[0]?.params.cwd, '/repo');
  });

rpcTest('HerdrClient: splitPane 转发 ratio；pane.layout 解析真矩形', {
  'pane.split': { pane: { pane_id: 'p-r' } },
  'pane.layout': { type: 'pane_layout', layout: {
    tab_id: 't1', zoomed: false, focused_pane_id: 'p1',
    panes: [
      { pane_id: 'p1', focused: true, rect: { x: 0, y: 0, width: 80, height: 12 } },
      { pane_id: 'p2', focused: false, rect: { x: 0, y: 12, width: 80, height: 28 } },
    ],
  } },
}, async (client, server) => {
  assert.equal(await client.splitPane({ direction: 'down', focus: false, ratio: 0.3, targetPaneId: 'p1' }), 'p-r');
  assert.equal(server.received[0]?.params.ratio, 0.3);
  assert.equal(server.received[0]?.params.focus, false);
  const live = await client.paneLayout({ paneId: 'p1' });
  assert.equal(live?.focusedPaneId, 'p1');
  assert.equal(live?.panes[1]?.h, 28);
  assert.equal(live?.panes[1]?.paneId, 'p2');
});

rpcTest('HerdrClient: splitPane retries without ratio on an unknown-parameter error', (_method, params) => (params.ratio === undefined
  ? { pane: { pane_id: 'p-r' } }
  : (() => { throw new Error("unknown field `ratio`"); })()), async (client, server) => {
  // Older servers reject `ratio` as an unknown parameter; the client retries the same split without it.
  assert.equal(await client.splitPane({ direction: 'right', ratio: 0.5 }), 'p-r');
  assert.equal(server.received.length, 2, 'the split was retried once');
  assert.equal('ratio' in server.received[1]!.params, false);
});

rpcTest('HerdrClient: splitPane throws when the response carries no pane_id', { 'pane.split': { ok: true } }, async (client) => {
  await assert.rejects(() => client.splitPane({}), /no pane_id/);
});

rpcTest('HerdrClient: createTab requires tab_id; sendPaneText appends CR',
  { 'tab.create': { tab_id: 't9', root: { pane_id: 'p9' } } }, async (client, server) => {
    assert.deepEqual(await client.createTab({ workspaceId: 'w1', label: 'main' }), { tabId: 't9', paneId: 'p9' });
    await client.sendPaneText('p9', 'hello');
    assert.equal(server.received.find((r) => r.method === 'pane.send_text')?.params.text, 'hello\r');
  });

rpcTest('HerdrClient: tabList drops tabs without tab_id; tabClose / closePane', {
  'tab.list': { tabs: [{ tab_id: 't1', workspace_id: 'w1', label: 'main', pane_count: 2, agent_status: 'idle' }, { label: 'bad' }] },
}, async (client, server) => {
  const tabs = await client.tabList();
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].tabId, 't1');
  assert.equal(tabs[0].paneCount, 2);
  await client.tabClose('t1');
  await client.closePane('p2');
  assert.ok(server.received.some((r) => r.method === 'tab.close' && r.params.tab_id === 't1'));
  assert.ok(server.received.some((r) => r.method === 'pane.close' && r.params.pane_id === 'p2'));
});

rpcTest('HerdrClient: exportLayout reads nested layout envelope; failure → null',
  { 'layout.export': { layout: { tab_id: 't1', zoomed: true, root: { type: 'pane' } } } }, async (client, server) => {
    // D-4: focusedPaneId rides along (null when the server omits it).
    assert.deepEqual(await client.exportLayout({ paneId: 'p1' }), { tabId: 't1', zoomed: true, root: { type: 'pane' }, focusedPaneId: null });
    const missing = new HerdrClient({ socketPath: join(server.socketPath, 'no-such.sock'), paneId: 'p', workspaceId: 'w', tabId: 't' });
    assert.equal(await missing.exportLayout({ paneId: 'p' }), null, 'an unreachable socket degrades to null');
  });

rpcTest('HerdrClient: waitAgent maps timeout errors to null; returns agent_status on success',
  { 'agent.wait': { agent: { agent_status: 'idle' } } }, async (client) => {
    assert.equal(await client.waitAgent('p2', ['idle'], 200), 'idle');
  });

rpcTest('HerdrClient: waitAgent returns null on a timeout error envelope', {}, async (client) => {
  assert.equal(await client.waitAgent('p2', ['idle'], 50), null);
}, (server) => { server.error = { code: 'timeout', message: 'agent wait timeout' }; });

rpcTest('HerdrClient: a bad frame rejects', {}, async (client) => {
  await assert.rejects(() => client.closePane('p'), /bad frame/);
}, (server) => { server.rawResponse = 'not-json\n'; });

rpcTest('HerdrClient: an error envelope rejects with code and message', {}, async (client) => {
  await assert.rejects(() => client.closePane('p'), /not_found: no pane/);
}, (server) => { server.error = { code: 'not_found', message: 'no pane' }; });

test('HerdrClient: connection refused rejects control RPCs; report* swallows', async () => {
  const c = new HerdrClient({ socketPath: join('/tmp', `pier-herdr-missing-${randomUUID()}.sock`), paneId: 'p', workspaceId: 'w', tabId: 't' });
  await assert.rejects(() => c.closePane('p'));
  await c.reportAgent('idle', null);
  await c.reportDisplayAgent('worker');
  await c.reportAskFlag('waiting');
});

test('D-2: pier never reports a session path (native herdr:pi owns the field)', () => {
  // The invariant: session paths have a single writer, so the client must not gain a reportAgentSession.
  assert.equal(typeof (HerdrClient.prototype as unknown as Record<string, unknown>).reportAgentSession, 'undefined');
});

rpcTest('HerdrClient: reportLockTokens batches at LOCK_BATCH_LIMIT', {}, async (client, server) => {
  const tokens: Record<string, string | null> = {};
  for (let i = 0; i < LOCK_BATCH_LIMIT + 1; i++) tokens[`lock-${i}`] = `p|${i}`;
  await client.reportLockTokens(tokens);
  const meta = server.received.filter((r) => r.method === 'pane.report_metadata');
  assert.equal(meta.length, 2);
  assert.equal(Object.keys(meta[0].params.tokens as object).length, LOCK_BATCH_LIMIT);
  assert.equal(Object.keys(meta[1].params.tokens as object).length, 1);
});

rpcTest('HerdrClient: readPane unwraps read envelope; waitForOutput on a match', {
  'pane.read': { read: { text: 'hi', revision: 3, truncated: true } },
  'pane.wait_for_output': { matched: true },
}, async (client, server) => {
  const read = await client.readPane('p2', { source: 'recent', lines: 20 });
  assert.deepEqual(read, { text: 'hi', revision: 3, truncated: true });
  assert.equal(server.received[0]?.params.strip_ansi, false);
  assert.deepEqual(await client.waitForOutput('p2', { type: 'substring', value: 'x' }, 50), { matched: true });
});

rpcTest('HerdrClient: waitForOutput degrades to a discriminated timeout', {}, async (client) => {
  assert.deepEqual(await client.waitForOutput('p2', { type: 'substring', value: 'x' }, 50), { matched: false, reason: 'timeout' });
}, (server) => { server.error = { code: 'timeout', message: 'wait timeout' }; });

rpcTest('HerdrClient (0.9.1): openPluginPane popup, nested agent.explain, ping version, 0.9.1 list fields', (method, params) => {
  if (method === 'plugin.pane.open') {
    if (params.placement === 'popup') return { type: 'plugin_pane_opened', plugin_pane: { plugin_id: 'pier.workbench', entrypoint: 'dashboard', pane: { pane_id: 'w1:p8' } } };
    return { type: 'plugin_pane_opened', plugin_pane: { pane: { pane_id: 'w1:p8', tab_id: 'w1:t3' } } };
  }
  if (method === 'agent.explain') return { type: 'agent_explain', explain: { matched_rule: 'pi-standard', skip_state_reason: 'process_crashed' } };
  if (method === 'ping') return { type: 'pong', version: '0.9.1', protocol: 22 };
  if (method === 'agent.list') {
    return { agents: [{ pane_id: 'p2', agent: 'pi', agent_status: 'working', state_labels: {}, tokens: {}, foreground_cwd: '/repo/sub',
      agent_session: { value: '/sess/a.jsonl', kind: 'path' } }] };
  }
  if (method === 'pane.list') {
    return { panes: [{ pane_id: 'p2', tab_id: 't1', workspace_id: 'w1', agent_status: 'idle', foreground_cwd: '/repo/sub',
      terminal_title: '⠋ npm run dev', terminal_title_stripped: 'npm run dev' }] };
  }
  return {};
}, async (client, server) => {
  const popRes = await client.openPluginPane({ pluginId: 'pier.workbench', entrypoint: 'dashboard', placement: 'popup' });
  assert.deepEqual(popRes, { mode: 'popup', ok: true });

  const explain = await client.agentExplain('w1:p1');
  assert.equal(explain?.matched_rule, 'pi-standard');
  assert.equal(explain?.skip_state_reason, 'process_crashed');
  assert.equal(explain?.type, undefined, 'unwraps {type, explain} envelope');

  assert.equal(await client.getServerVersion(), '0.9.1');
  assert.equal(server.received.filter((r) => r.method === 'ping').length, 1, 'the version is cached');

  const agents = await client.listAgents();
  assert.equal(agents[0]?.foregroundCwd, '/repo/sub');

  const panes = await client.listPanes();
  assert.equal(panes[0]?.foregroundCwd, '/repo/sub');
  assert.equal(panes[0]?.terminalTitle, '⠋ npm run dev');
  assert.equal(panes[0]?.terminalTitleStripped, 'npm run dev');
});

rpcTest('HerdrClient (0.9.0): an unknown `popup` variant retries as a tab', (method, params) => {
  if (method !== 'plugin.pane.open') return {};
  if (params.placement === 'popup') throw new Error("unknown variant `popup`, expected one of `overlay`, `split`, `tab`, `zoomed`");
  return { type: 'plugin_pane_opened', plugin_pane: { pane: { pane_id: 'w1:p9', tab_id: 'w1:t4' } } };
}, async (client) => {
  const res = await client.openPluginPane({ pluginId: 'pier.workbench', entrypoint: 'dashboard', placement: 'popup' });
  assert.equal(res.mode, 'fallback_tab');
  if (res.mode !== 'fallback_tab') throw new Error('expected fallback_tab');
  assert.equal(res.paneId, 'w1:p9');
});

test('herdrUnavailableHint (B5): 传输层失败给出可动作的一句话，其它错误返回 null', () => {
  assert.match(String(herdrUnavailableHint(new Error('connect ENOENT /tmp/herdr.sock'))), /herdr unreachable/);
  assert.match(String(herdrUnavailableHint(new Error('connect ECONNREFUSED 127.0.0.1:1'))), /HERDR_SOCKET_PATH/);
  assert.match(String(herdrUnavailableHint(new Error('socket hang up'))), /herdr unreachable/);
  // a domain error must not be dressed up as "herdr unreachable"
  assert.equal(herdrUnavailableHint(new Error('pane_not_found: wX:p9')), null);
  assert.equal(herdrUnavailableHint(new Error('invalid regex')), null);
});

/* ── A6 wire contract ───────────────────────────────────────────── */

interface ContractFixture {
  _source: string;
  methods: Record<string, { def: string | null; required: string[]; allowed: string[] }>;
}

const contract = JSON.parse(readFileSync(new URL('./fixtures/herdr-contract.json', import.meta.url), 'utf8')) as ContractFixture;

/** Minimal, schema-shaped answers: enough for the client's response parsing to succeed. */
function respond(method: string): Record<string, unknown> {
  const pane = { pane_id: 'w1:p3', tab_id: 'w1:t1', workspace_id: 'w1' };
  const answers: Record<string, () => Record<string, unknown>> = {
    'pane.split': () => ({ type: 'pane_info', pane }),
    'tab.create': () => ({ type: 'pane_info', pane: { ...pane, tab_id: 'w1:t2' } }),
    'pane.list': () => ({ type: 'pane_list', panes: [] }),
    'tab.list': () => ({ type: 'tab_list', tabs: [] }),
    'tab.get': () => ({ type: 'tab_info', tab: { tab_id: 'w1:t1', workspace_id: 'w1', label: 'main', number: 1, focused: true, pane_count: 1, agent_status: 'idle' } }),
    'agent.list': () => ({ type: 'agent_list', agents: [] }),
    'agent.wait': () => ({ type: 'agent_status', agent: { agent_status: 'idle' } }),
    'pane.read': () => ({ type: 'pane_read', text: '', revision: 0, truncated: false }),
    'layout.export': () => ({ type: 'layout_export', layout: { workspace_id: 'w1', tab_id: 'w1:t1', zoomed: false, focused_pane_id: 'w1:p1', root: { type: 'pane', pane_id: 'w1:p1' } } }),
  };
  return (answers[method] ?? (() => ({ type: 'ok' })))();
}

rpcTest('A6 contract: every request pier sends stays inside the herdr schema', respond, async (client, server) => {
  // Covers the requests pier actually sends (including the focus forwarding the client used to drop).
  await client.reportAgent('working', 'badge');
  await client.reportMetadata({ session: 'label', items: [{ content: 'x', status: 'in_progress' }] });
  await client.listAgents();
  await client.waitAgent('w1:p2', ['idle'], 50);
  await client.splitPane({ direction: 'right', cwd: '/tmp', focus: false, targetPaneId: 'w1:p1', ratio: 0.3 });
  await client.paneLayout({ paneId: 'w1:p1' });
  await client.createTab({ workspaceId: 'w1', label: 'task' });
  await client.readPane('w1:p2', { stripAnsi: true });
  await client.sendPaneText('w1:p2', 'echo hi');
  await client.sendPaneKeys('w1:p2', ['ctrl+c']);
  await client.closePane('w1:p2');
  await client.exportLayout({ paneId: 'w1:p1' });
  await client.tabList();
  await client.tabClose('w1:t1');
  await client.listPanes();
  await client.waitForOutput('w1:p2', { type: 'substring', value: 'x' }, 50);
  await client.openPluginPane({ pluginId: 'pier.workbench', entrypoint: 'dashboard', placement: 'popup', width: '80%', height: '80%', focus: true });
  await client.agentExplain('w1:p1');

  assert.ok(server.received.length >= 10, `expected several kinds of request, recorded ${server.received.length}`);
  const problems: string[] = [];
  for (const { method, params } of server.received) {
    const spec = contract.methods[method];
    if (!spec) {
      problems.push(`${method}: method missing from the contract fixture (new method? regenerate the fixture)`);
      continue;
    }
    for (const key of Object.keys(params)) {
      if (!spec.allowed.includes(key)) problems.push(`${method}: unknown parameter "${key}" (allowed: ${spec.allowed.join(', ') || 'none'})`);
      if (params[key] === undefined) problems.push(`${method}: parameter "${key}" is undefined (serializes into a missing field)`);
    }
    for (const key of spec.required) {
      if (!(key in params)) problems.push(`${method}: required parameter "${key}" missing`);
    }
  }
  assert.deepEqual(problems, [], `inconsistent with the herdr schema:\n${problems.join('\n')}`);
  // Contract-generation gate: the fixture and the client constant must name the same protocol version
  assert.match(contract._source, new RegExp(`protocol ${HERDR_PROTOCOL_EXPECTED}\\b`),
    'the fixture disagrees with HERDR_PROTOCOL_EXPECTED: after a herdr upgrade, regenerate the fixture and bump the constant');
  // report_metadata really uses the modern fields (A6: ttl_ms / state_labels, not a hard-coded old shape)
  const metaKeys = new Set(server.received.filter((r) => r.method === 'pane.report_metadata').flatMap((r) => Object.keys(r.params)));
  assert.ok(metaKeys.has('ttl_ms'), 'report_metadata carries ttl_ms');
  assert.ok(metaKeys.has('tokens') || metaKeys.has('clear_state_labels'), 'report_metadata uses the modern fields');
});

rpcTest('A6 contract: pane.split really forwards focus (it used to be dropped silently)', respond, async (client, server) => {
  await client.splitPane({ direction: 'right', focus: false });
  const split = server.received.find((r) => r.method === 'pane.split');
  assert.ok(split, 'pane.split was sent');
  assert.equal(split!.params.focus, false, 'the client must not swallow focus');
  assert.equal(split!.params.direction, 'right');
});

rpcTest('A6 contract: an unspecified focus is left to the server default', respond, async (client, server) => {
  await client.splitPane({ direction: 'down' });
  assert.equal('focus' in server.received[0]!.params, false);
});
