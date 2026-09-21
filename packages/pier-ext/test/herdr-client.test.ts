/**
 * herdr-client: env detection, Noop contract, NDJSON socket protocol (envelope decoding, error
 * mapping, batching). The wire contract itself (request shapes vs the herdr schema) lives in
 * herdr-contract.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  HerdrClient,
  NoopHerdrClient,
  createHerdrClient,
  detectHerdrEnv,
  herdrSocketTarget,
  herdrUnavailableHint,
} from '../src/herdr-client.ts';
import { LOCK_BATCH_LIMIT } from '../src/lock-core.ts';
import { withCleanup, type CleanupContext } from './test-utils.ts';

type RpcHandler = (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>;

class FakeHerdrServer {
  readonly socketPath: string;
  readonly received: Array<{ method: string; params: Record<string, unknown> }> = [];
  hang = false;
  rawResponse: string | null = null;
  error: { code: string; message: string } | null = null;
  handler: RpcHandler = () => ({ ok: true });
  private server: Server | null = null;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  listen(): Promise<void> {
    this.server = createServer((socket) => {
      socket.setEncoding('utf8');
      let buf = '';
      socket.on('data', (chunk: string) => {
        buf += chunk;
        const idx = buf.indexOf('\n');
        if (idx < 0) return;
        if (this.hang) return;
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
    server.close(() => {
      try { unlinkSync(this.socketPath); } catch { /* already gone */ }
      done.resolve();
    });
    return done.promise;
  }
}

function clientFor(server: FakeHerdrServer): HerdrClient {
  return new HerdrClient({
    socketPath: server.socketPath,
    paneId: 'p-self',
    workspaceId: 'w1',
    tabId: 't1',
  });
}

/** Run `body` against a fake server on a temp socket, closing it afterwards. */
async function withServer(
  cleanup: CleanupContext,
  handler: RpcHandler,
  body: (client: HerdrClient, server: FakeHerdrServer) => Promise<void>,
  setup?: (server: FakeHerdrServer) => void,
): Promise<void> {
  const dir = cleanup.tempDir('herdr');
  const server = new FakeHerdrServer(join(dir.path, `s-${randomUUID().slice(0, 8)}.sock`));
  server.handler = handler;
  setup?.(server);
  await server.listen();
  try {
    await body(clientFor(server), server);
  } finally {
    await server.close();
  }
}

test('detectHerdrEnv: requires HERDR_ENV=1 plus socket and pane', () => {
  assert.equal(detectHerdrEnv({}), null);
  assert.equal(detectHerdrEnv({ HERDR_ENV: '1' }), null);
  assert.equal(detectHerdrEnv({ HERDR_ENV: '1', HERDR_SOCKET_PATH: '/tmp/s' }), null);
  const env = detectHerdrEnv({
    HERDR_ENV: '1',
    HERDR_SOCKET_PATH: '/tmp/s',
    HERDR_PANE_ID: 'p1',
    HERDR_WORKSPACE_ID: 'w1',
    HERDR_TAB_ID: 't1',
  });
  assert.deepEqual(env, { socketPath: '/tmp/s', paneId: 'p1', workspaceId: 'w1', tabId: 't1' });
  // missing workspace/tab default to empty string
  assert.deepEqual(
    detectHerdrEnv({ HERDR_ENV: '1', HERDR_SOCKET_PATH: '/tmp/s', HERDR_PANE_ID: 'p1' }),
    { socketPath: '/tmp/s', paneId: 'p1', workspaceId: '', tabId: '' },
  );
});

test('createHerdrClient: missing env → Noop; present env → live client', () => {
  const missing = createHerdrClient({});
  assert.equal(missing.env, null);
  assert.equal(missing.client.available, false);
  assert.ok(missing.client instanceof NoopHerdrClient);

  const live = createHerdrClient({
    HERDR_ENV: '1',
    HERDR_SOCKET_PATH: '/tmp/s',
    HERDR_PANE_ID: 'p1',
  });
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

test('HerdrClient: pane.list maps fields; connection roundtrip', withCleanup(async (cleanup) => {
  await withServer(cleanup, (method) => (method === 'pane.list'
    ? { panes: [{ pane_id: 'p2', tab_id: 't1', workspace_id: 'w1', agent_status: 'idle' }] }
    : {}), async (client, server) => {
    const panes = await client.listPanes();
    assert.deepEqual(panes, [{ paneId: 'p2', tabId: 't1', workspaceId: 'w1', agentStatus: 'idle' }]);
    assert.equal(server.received[0]?.method, 'pane.list');
  });
}));

test('HerdrClient: listAgents maps agent_session.value', withCleanup(async (cleanup) => {
  const agent = {
    pane_id: 'p2',
    agent: 'pi',
    agent_status: 'working',
    agent_session: { value: '/sess/a.jsonl', kind: 'path' },
    state_labels: { k: 'v' },
    tokens: { 'pi-todo': 'x' },
  };
  await withServer(cleanup, () => ({ agents: [agent] }), async (client) => {
    const agents = await client.listAgents();
    assert.equal(agents.length, 1);
    assert.equal(agents[0].paneId, 'p2');
    assert.equal(agents[0].session, '/sess/a.jsonl');
    assert.equal(agents[0].status, 'working');
    assert.equal(await client.getAgentSessionPath('p2'), '/sess/a.jsonl');
    assert.equal(await client.getAgentSessionPath('missing'), null);
  });
}));

test('HerdrClient: splitPane extracts a nested pane_id via findIdIn', withCleanup(async (cleanup) => {
  await withServer(cleanup, (method) => (method === 'pane.split' ? { created: { pane_id: 'p-new' } } : {}), async (client, server) => {
    assert.equal(await client.splitPane({ direction: 'right', cwd: '/repo' }), 'p-new');
    assert.equal(server.received[0]?.params.direction, 'right');
    assert.equal(server.received[0]?.params.cwd, '/repo');
  });
}));

test('HerdrClient: splitPane 转发 ratio；pane.layout 解析真矩形', withCleanup(async (cleanup) => {
  await withServer(cleanup, (method) => {
    if (method === 'pane.split') return { pane: { pane_id: 'p-r' } };
    if (method === 'pane.layout') {
      return {
        type: 'pane_layout',
        layout: {
          tab_id: 't1',
          zoomed: false,
          focused_pane_id: 'p1',
          panes: [
            { pane_id: 'p1', focused: true, rect: { x: 0, y: 0, width: 80, height: 12 } },
            { pane_id: 'p2', focused: false, rect: { x: 0, y: 12, width: 80, height: 28 } },
          ],
        },
      };
    }
    return {};
  }, async (client, server) => {
    assert.equal(await client.splitPane({ direction: 'down', focus: false, ratio: 0.3, targetPaneId: 'p1' }), 'p-r');
    assert.equal(server.received[0]?.params.ratio, 0.3);
    assert.equal(server.received[0]?.params.focus, false);
    const live = await client.paneLayout({ paneId: 'p1' });
    assert.equal(live?.focusedPaneId, 'p1');
    assert.equal(live?.panes[1]?.h, 28);
    assert.equal(live?.panes[1]?.paneId, 'p2');
  });
}));

test('HerdrClient: splitPane retries without ratio on an unknown-parameter error', withCleanup(async (cleanup) => {
  // Older servers reject `ratio` as an unknown parameter; the client retries the same split without it.
  await withServer(cleanup, (_method, params) => (params.ratio === undefined
    ? { pane: { pane_id: 'p-r' } }
    : (() => { throw new Error("unknown field `ratio`"); })()), async (client, server) => {
    assert.equal(await client.splitPane({ direction: 'right', ratio: 0.5 }), 'p-r');
    assert.equal(server.received.length, 2, 'the split was retried once');
    assert.equal('ratio' in server.received[1]!.params, false);
  });
}));

test('HerdrClient: splitPane throws when the response carries no pane_id', withCleanup(async (cleanup) => {
  await withServer(cleanup, () => ({ ok: true }), async (client) => {
    await assert.rejects(() => client.splitPane({}), /no pane_id/);
  });
}));

test('HerdrClient: createTab requires tab_id; sendPaneText appends CR', withCleanup(async (cleanup) => {
  await withServer(cleanup, (method) => (method === 'tab.create' ? { tab_id: 't9', root: { pane_id: 'p9' } } : {}), async (client, server) => {
    assert.deepEqual(await client.createTab({ workspaceId: 'w1', label: 'main' }), { tabId: 't9', paneId: 'p9' });
    await client.sendPaneText('p9', 'hello');
    const send = server.received.find((r) => r.method === 'pane.send_text');
    assert.equal(send?.params.text, 'hello\r');
  });
}));

test('HerdrClient: tabList drops tabs without tab_id; tabClose / closePane', withCleanup(async (cleanup) => {
  await withServer(cleanup, (method) => (method === 'tab.list' ? {
    tabs: [{ tab_id: 't1', workspace_id: 'w1', label: 'main', pane_count: 2, agent_status: 'idle' }, { label: 'bad' }],
  } : {}), async (client, server) => {
    const tabs = await client.tabList();
    assert.equal(tabs.length, 1);
    assert.equal(tabs[0].tabId, 't1');
    assert.equal(tabs[0].paneCount, 2);
    await client.tabClose('t1');
    await client.closePane('p2');
    assert.ok(server.received.some((r) => r.method === 'tab.close' && r.params.tab_id === 't1'));
    assert.ok(server.received.some((r) => r.method === 'pane.close' && r.params.pane_id === 'p2'));
  });
}));

test('HerdrClient: exportLayout reads nested layout envelope; failure → null', withCleanup(async (cleanup) => {
  await withServer(cleanup, () => ({ layout: { tab_id: 't1', zoomed: true, root: { type: 'pane' } } }), async (client) => {
    const layout = await client.exportLayout({ paneId: 'p1' });
    // D-4: focusedPaneId rides along (null when the server omits it).
    assert.deepEqual(layout, { tabId: 't1', zoomed: true, root: { type: 'pane' }, focusedPaneId: null });
  });
  const dir = cleanup.tempDir('herdr');
  const missing = new HerdrClient({
    socketPath: join(dir.path, 'no-such.sock'),
    paneId: 'p',
    workspaceId: 'w',
    tabId: 't',
  });
  assert.equal(await missing.exportLayout({ paneId: 'p' }), null, 'an unreachable socket degrades to null');
}));

test('HerdrClient: waitAgent maps timeout errors to null; returns agent_status on success', withCleanup(async (cleanup) => {
  await withServer(cleanup, () => ({ agent: { agent_status: 'idle' } }), async (client) => {
    assert.equal(await client.waitAgent('p2', ['idle'], 200), 'idle');
  });
  await withServer(cleanup, () => ({}), async (client) => {
    assert.equal(await client.waitAgent('p2', ['idle'], 50), null);
  }, (server) => { server.error = { code: 'timeout', message: 'agent wait timeout' }; });
}));

test('HerdrClient: bad frame and error envelope reject', withCleanup(async (cleanup) => {
  await withServer(cleanup, () => ({}), async (client) => {
    await assert.rejects(() => client.closePane('p'), /bad frame/);
  }, (server) => { server.rawResponse = 'not-json\n'; });
  await withServer(cleanup, () => ({}), async (client) => {
    await assert.rejects(() => client.closePane('p'), /not_found: no pane/);
  }, (server) => { server.error = { code: 'not_found', message: 'no pane' }; });
}));

test('HerdrClient: connection refused rejects control RPCs; report* swallows', async () => {
  const c = new HerdrClient({
    socketPath: join('/tmp', `pier-herdr-missing-${randomUUID()}.sock`),
    paneId: 'p',
    workspaceId: 'w',
    tabId: 't',
  });
  await assert.rejects(() => c.closePane('p'));
  await c.reportAgent('idle', null);
  await c.reportDisplayAgent('worker');
  await c.reportAskFlag('waiting');
});

test('D-2: pier never reports a session path (native herdr:pi owns the field)', () => {
  // The invariant: session paths have a single writer, so the client must not gain a reportAgentSession.
  assert.equal(typeof (HerdrClient.prototype as unknown as Record<string, unknown>).reportAgentSession, 'undefined');
});

test('HerdrClient: reportLockTokens batches at LOCK_BATCH_LIMIT', withCleanup(async (cleanup) => {
  await withServer(cleanup, () => ({}), async (client, server) => {
    const tokens: Record<string, string | null> = {};
    for (let i = 0; i < LOCK_BATCH_LIMIT + 1; i++) tokens[`lock-${i}`] = `p|${i}`;
    await client.reportLockTokens(tokens);
    const meta = server.received.filter((r) => r.method === 'pane.report_metadata');
    assert.equal(meta.length, 2);
    assert.equal(Object.keys(meta[0].params.tokens as object).length, LOCK_BATCH_LIMIT);
    assert.equal(Object.keys(meta[1].params.tokens as object).length, 1);
  });
}));

test('HerdrClient: readPane unwraps read envelope; waitForOutput timeout → discriminated result', withCleanup(async (cleanup) => {
  await withServer(cleanup, (method) => {
    if (method === 'pane.read') return { read: { text: 'hi', revision: 3, truncated: true } };
    if (method === 'pane.wait_for_output') return { matched: true };
    return {};
  }, async (client, server) => {
    const read = await client.readPane('p2', { source: 'recent', lines: 20 });
    assert.deepEqual(read, { text: 'hi', revision: 3, truncated: true });
    assert.equal(server.received[0]?.params.strip_ansi, false);
    assert.deepEqual(await client.waitForOutput('p2', { type: 'substring', value: 'x' }, 50), { matched: true });
  });
  await withServer(cleanup, () => ({}), async (client) => {
    assert.deepEqual(await client.waitForOutput('p2', { type: 'substring', value: 'x' }, 50), { matched: false, reason: 'timeout' });
  }, (server) => { server.error = { code: 'timeout', message: 'wait timeout' }; });
}));

test('HerdrClient (0.9.1): openPluginPane popup, nested agent.explain, ping version, 0.9.1 list fields', withCleanup(async (cleanup) => {
  await withServer(cleanup, (method, params) => {
    if (method === 'plugin.pane.open') {
      if (params.placement === 'popup') return { type: 'plugin_pane_opened', plugin_pane: { plugin_id: 'pier.workbench', entrypoint: 'dashboard', pane: { pane_id: 'w1:p8' } } };
      return { type: 'plugin_pane_opened', plugin_pane: { pane: { pane_id: 'w1:p8', tab_id: 'w1:t3' } } };
    }
    if (method === 'agent.explain') {
      return { type: 'agent_explain', explain: { matched_rule: 'pi-standard', skip_state_reason: 'process_crashed' } };
    }
    if (method === 'ping') return { type: 'pong', version: '0.9.1', protocol: 22 };
    if (method === 'agent.list') {
      return {
        agents: [{
          pane_id: 'p2',
          agent: 'pi',
          agent_status: 'working',
          agent_session: { value: '/sess/a.jsonl', kind: 'path' },
          state_labels: {},
          tokens: {},
          foreground_cwd: '/repo/sub',
        }],
      };
    }
    if (method === 'pane.list') {
      return {
        panes: [{
          pane_id: 'p2',
          tab_id: 't1',
          workspace_id: 'w1',
          agent_status: 'idle',
          foreground_cwd: '/repo/sub',
          terminal_title: '⠋ npm run dev',
          terminal_title_stripped: 'npm run dev',
        }],
      };
    }
    return {};
  }, async (client, server) => {
    const popRes = await client.openPluginPane({
      pluginId: 'pier.workbench',
      entrypoint: 'dashboard',
      placement: 'popup',
    });
    assert.deepEqual(popRes, { mode: 'popup', ok: true });

    const explain = await client.agentExplain('w1:p1');
    assert.equal(explain?.matched_rule, 'pi-standard');
    assert.equal(explain?.skip_state_reason, 'process_crashed');
    assert.equal(explain?.type, undefined, 'unwraps {type, explain} envelope');

    assert.equal(await client.getServerVersion(), '0.9.1');
    assert.equal(await client.getServerVersion(), '0.9.1');
    assert.equal(server.received.filter((r) => r.method === 'ping').length, 1, 'the version is cached');

    const agents = await client.listAgents();
    assert.equal(agents[0]?.foregroundCwd, '/repo/sub');

    const panes = await client.listPanes();
    assert.equal(panes[0]?.foregroundCwd, '/repo/sub');
    assert.equal(panes[0]?.terminalTitle, '⠋ npm run dev');
    assert.equal(panes[0]?.terminalTitleStripped, 'npm run dev');
  });

  // 0.9.0 serde rejects `popup` as "unknown variant" → any popup failure retries as a tab.
  await withServer(cleanup, (method, params) => {
    if (method === 'plugin.pane.open') {
      if (params.placement === 'popup') {
        throw new Error("unknown variant `popup`, expected one of `overlay`, `split`, `tab`, `zoomed`");
      }
      return { type: 'plugin_pane_opened', plugin_pane: { pane: { pane_id: 'w1:p9', tab_id: 'w1:t4' } } };
    }
    return {};
  }, async (client) => {
    const res = await client.openPluginPane({
      pluginId: 'pier.workbench',
      entrypoint: 'dashboard',
      placement: 'popup',
    });
    assert.equal(res.mode, 'fallback_tab');
    if (res.mode !== 'fallback_tab') throw new Error('expected fallback_tab');
    assert.equal(res.paneId, 'w1:p9');
  });
}));

test('herdrUnavailableHint (B5): 传输层失败给出可动作的一句话，其它错误返回 null', () => {
  assert.match(String(herdrUnavailableHint(new Error('connect ENOENT /tmp/herdr.sock'))), /herdr unreachable/);
  assert.match(String(herdrUnavailableHint(new Error('connect ECONNREFUSED 127.0.0.1:1'))), /HERDR_SOCKET_PATH/);
  assert.match(String(herdrUnavailableHint(new Error('socket hang up'))), /herdr unreachable/);
  // a domain error must not be dressed up as "herdr unreachable"
  assert.equal(herdrUnavailableHint(new Error('pane_not_found: wX:p9')), null);
  assert.equal(herdrUnavailableHint(new Error('invalid regex')), null);
});
