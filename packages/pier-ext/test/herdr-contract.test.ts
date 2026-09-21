/**
 * A6: the herdr wire contract (a protocol-generation gap silently drifts field semantics).
 *
 * Approach: the *required/allowed parameter table* exported by `herdr api schema` is stored as a
 * fixture (test/fixtures/herdr-contract.json); every request the pier client really sends is recorded
 * and checked method by method: the method exists, no unknown fields, all required fields present, no
 * undefined values. Regenerate the fixture when herdr is upgraded — drift then shows up here instead of
 * in the user's pane.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HERDR_PROTOCOL_EXPECTED, HerdrClient, herdrSocketTarget } from '../src/herdr-client.ts';
import { withCleanup } from './test-utils.ts';

/** Minimal, schema-shaped answers: enough for the client's response parsing to succeed. */
function respond(method: string): Record<string, unknown> {
  switch (method) {
    case 'pane.split': return { type: 'pane_info', pane: { pane_id: 'w1:p3', tab_id: 'w1:t1', workspace_id: 'w1' } };
    case 'tab.create': return { type: 'pane_info', pane: { pane_id: 'w1:p3', tab_id: 'w1:t2', workspace_id: 'w1' } };
    case 'pane.list': return { type: 'pane_list', panes: [] };
    case 'tab.list': return { type: 'tab_list', tabs: [] };
    case 'tab.get': return { type: 'tab_info', tab: { tab_id: 'w1:t1', workspace_id: 'w1', label: 'main', number: 1, focused: true, pane_count: 1, agent_status: 'idle' } };
    case 'agent.list': return { type: 'agent_list', agents: [] };
    case 'agent.wait': return { type: 'agent_status', agent: { agent_status: 'idle' } };
    case 'pane.read': return { type: 'pane_read', text: '', revision: 0, truncated: false };
    case 'layout.export': return { type: 'layout_export', layout: { workspace_id: 'w1', tab_id: 'w1:t1', zoomed: false, focused_pane_id: 'w1:p1', root: { type: 'pane', pane_id: 'w1:p1' } } };
    default: return { type: 'ok' };
  }
}

interface ContractFixture {
  _source: string;
  methods: Record<string, { def: string | null; required: string[]; allowed: string[] }>;
}

const contract: ContractFixture = JSON.parse(
  readFileSync(new URL('./fixtures/herdr-contract.json', import.meta.url), 'utf8'),
) as ContractFixture;

/** Records every request pier sends and answers with a permissive success payload. */
class RecordingServer {
  readonly socketPath: string;
  readonly received: Array<{ method: string; params: Record<string, unknown> }> = [];
  private server: Server | null = null;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  async listen(): Promise<void> {
    this.server = createServer((sock) => {
      let buf = '';
      sock.setEncoding('utf8');
      sock.on('data', (chunk) => {
        buf += chunk;
        const i = buf.indexOf('\n');
        if (i < 0) return;
        let req: { id?: string; method?: string; params?: Record<string, unknown> };
        try { req = JSON.parse(buf.slice(0, i)); } catch { sock.destroy(); return; }
        buf = buf.slice(i + 1);
        this.received.push({ method: String(req.method), params: req.params ?? {} });
        sock.end(JSON.stringify({ id: req.id ?? '1', result: respond(String(req.method)) }) + '\n');
      });
      sock.on('error', () => { /* client may hang up */ });
    });
    // Raw filesystem socket paths fail with EACCES on Windows; route through the
    // production transport helper (identity on POSIX, named pipe on win32).
    await new Promise<void>((resolve) => this.server!.listen(herdrSocketTarget(this.socketPath), () => resolve()));
  }

  async close(): Promise<void> {
    const server = this.server;
    if (!server) return;
    const s = server as unknown as { closeAllConnections?: () => void };
    s.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('A6 contract: every request pier sends stays inside the herdr schema', withCleanup(async (cleanup) => {
  const dir = cleanup.tempDir('herdr-contract');
  const server = new RecordingServer(join(dir.path, `s-${randomUUID().slice(0, 8)}.sock`));
  await server.listen();
  try {
    const client = new HerdrClient({
      socketPath: server.socketPath,
      paneId: 'w1:p1',
      workspaceId: 'w1',
      tabId: 'w1:t1',
    });
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
    await client.openPluginPane({
      pluginId: 'pier.workbench',
      entrypoint: 'dashboard',
      placement: 'popup',
      width: '80%',
      height: '80%',
      focus: true,
    });
    await client.agentExplain('w1:p1');
  } finally {
    await server.close();
  }

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
}));

test('A6 contract: pane.split really forwards focus (it used to be dropped silently)', withCleanup(async (cleanup) => {
  const dir = cleanup.tempDir('herdr-focus-fwd');
  const server = new RecordingServer(join(dir.path, `s-${randomUUID().slice(0, 8)}.sock`));
  await server.listen();
  try {
    const client = new HerdrClient({ socketPath: server.socketPath, paneId: 'p', workspaceId: 'w', tabId: 't' });
    await client.splitPane({ direction: 'right', focus: false });
  } finally {
    await server.close();
  }
  const split = server.received.find((r) => r.method === 'pane.split');
  assert.ok(split, 'pane.split was sent');
  assert.equal(split!.params.focus, false, 'the client must not swallow focus');
  assert.equal(split!.params.direction, 'right');
  // When it is not specified, do not guess: leave the server default (focus defaults to false in the schema)
  const dir2 = cleanup.tempDir('herdr-focus-default');
  const server2 = new RecordingServer(join(dir2.path, `s-${randomUUID().slice(0, 8)}.sock`));
  await server2.listen();
  try {
    const client = new HerdrClient({ socketPath: server2.socketPath, paneId: 'p', workspaceId: 'w', tabId: 't' });
    await client.splitPane({ direction: 'down' });
  } finally {
    await server2.close();
  }
  assert.equal('focus' in server2.received[0]!.params, false);
}));
