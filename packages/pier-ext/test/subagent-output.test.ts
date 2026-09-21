/**
 * subagent-output.test.ts
 *
 * Unit tests for subagent-output-core pure functions and integration tests
 * for subagent(action: "output").
 *
 * Requirements:
 *  - Deterministic (no sleep)
 *  - Covers initial call, normal append, no new output, scrolling, clear-screen,
 *    repeated text ambiguity, bounded truncation, status resolution, formatSubagentOutput
 *  - Integration tests for subagent(action: "output"): agent.read preference with readPane fallback,
 *    missing/unknown agentId, cursor delta progression across multiple calls.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import subagentPlugin from '../src/plugins/subagent.ts';
import { PiSurface } from '../src/pi-surface.ts';
import { HerdrClient, NoopHerdrClient, herdrSocketTarget, type HerdrClientLike, type AgentInfo } from '../src/herdr-client.ts';
import { emptySubagentPortBox } from '../src/subagent-port.ts';
import { SUBS_CUSTOM_TYPE, type SubEntry } from '../src/subagent-core.ts';
import {
  boundText,
  computeSubagentOutputDelta,
  extractTail,
  formatSubagentOutput,
  resolveSubagentStatus,
  type SubagentOutputCursor,
} from '../src/subagent-output-core.ts';

/* ── 1. Pure Function: boundText & extractTail ────────────────────── */

test('boundText: within limit remains intact; over limit retains tail and sets truncated: true', () => {
  const short = boundText('hello world', 20);
  assert.equal(short.text, 'hello world');
  assert.equal(short.truncated, false);

  const exact = boundText('12345', 5);
  assert.equal(exact.text, '12345');
  assert.equal(exact.truncated, false);

  const long = boundText('abcdefghij', 4);
  assert.equal(long.text, 'ghij');
  assert.equal(long.truncated, true);
});

test('extractTail: short text returned in full; long text slices last N chars', () => {
  assert.equal(extractTail('short', 10), 'short');
  assert.equal(extractTail('0123456789', 4), '6789');
});

/* ── 2. Pure Function: computeSubagentOutputDelta ─────────────────── */

test('computeSubagentOutputDelta: first call without cursor returns full bounded text (restart: false)', () => {
  const res = computeSubagentOutputDelta(null, 'Line 1\nLine 2\nLine 3\n', { maxChars: 100 });
  assert.equal(res.delta, 'Line 1\nLine 2\nLine 3\n');
  assert.equal(res.restart, false);
  assert.equal(res.truncated, false);
  assert.equal(res.nextCursor.fullLength, 21);
  assert.ok(res.nextCursor.tail.endsWith('Line 3\n'));
});

test('computeSubagentOutputDelta: no new output returns empty delta', () => {
  const text = 'Line 1\nLine 2\n';
  const initial = computeSubagentOutputDelta(null, text);
  assert.equal(initial.delta, text);

  const second = computeSubagentOutputDelta(initial.nextCursor, text);
  assert.equal(second.delta, '');
  assert.equal(second.restart, false);
  assert.equal(second.truncated, false);
  assert.equal(second.nextCursor, initial.nextCursor);
});

test('computeSubagentOutputDelta: normal append returns only the new delta', () => {
  const text1 = 'Step 1: start\nStep 2: build\n';
  const res1 = computeSubagentOutputDelta(null, text1);

  const text2 = 'Step 1: start\nStep 2: build\nStep 3: test passed\n';
  const res2 = computeSubagentOutputDelta(res1.nextCursor, text2);
  assert.equal(res2.delta, 'Step 3: test passed\n');
  assert.equal(res2.restart, false);
  assert.equal(res2.truncated, false);
  assert.equal(res2.nextCursor.fullLength, text2.length);
});

test('computeSubagentOutputDelta: repeated text ambiguity degrades to full bounded text with restart: true', () => {
  // If the tail occurs multiple times in current text, it cannot be disambiguated reliably.
  const cursor: SubagentOutputCursor = {
    tail: 'ping\n',
    fullLength: 5,
  };
  const text = 'ping\nping\nping\nping\n';
  const res = computeSubagentOutputDelta(cursor, text);
  assert.equal(res.restart, true);
  assert.equal(res.delta, text);
  assert.equal(res.nextCursor.fullLength, text.length);
});

test('computeSubagentOutputDelta: partial scroll matches suffix of prevTail with prefix of currText', () => {
  // Suppose prevTail was lines 15..20 (e.g. 50 chars). Lines 15..17 scrolled off.
  // Suffix of prevTail (lines 18..20, length >= minOverlap) is at start of currText.
  const prevTail = 'line 15\nline 16\nline 17\nline 18\nline 19\nline 20\n';
  const cursor: SubagentOutputCursor = {
    tail: prevTail,
    fullLength: 200,
  };
  // Suffix: 'line 18\nline 19\nline 20\n' (length 24 >= 16)
  const currText = 'line 18\nline 19\nline 20\nline 21: new!\n';
  const res = computeSubagentOutputDelta(cursor, currText, { minOverlap: 16 });
  assert.equal(res.restart, false);
  assert.equal(res.delta, 'line 21: new!\n');
  assert.equal(res.truncated, false);
});

test('computeSubagentOutputDelta: full scroll out or clear screen degrades to full bounded text with restart: true', () => {
  const cursor: SubagentOutputCursor = {
    tail: 'Old Task Step 1\nOld Task Step 2\n',
    fullLength: 100,
  };
  const currText = 'Brand New Task Running\nAll previous scrolled away\n';
  const res = computeSubagentOutputDelta(cursor, currText);
  assert.equal(res.restart, true);
  assert.equal(res.delta, currText);
  assert.equal(res.truncated, false);
});

test('computeSubagentOutputDelta: delta exceeding maxChars is truncated from beginning', () => {
  const cursor: SubagentOutputCursor = {
    tail: 'START\n',
    fullLength: 6,
  };
  const largeOutput = 'START\n' + 'x'.repeat(500) + 'END';
  const res = computeSubagentOutputDelta(cursor, largeOutput, { maxChars: 50 });
  assert.equal(res.restart, false);
  assert.equal(res.truncated, true);
  assert.equal(res.delta.length, 50);
  assert.ok(res.delta.endsWith('END'));
});

/* ── 3. Pure Function: resolveSubagentStatus ──────────────────────── */

test('resolveSubagentStatus: status precedence and resolution', () => {
  // Blocked takes highest precedence
  assert.equal(resolveSubagentStatus({ localStatus: 'running', herdrStatus: 'blocked' }), 'blocked');
  assert.equal(resolveSubagentStatus({ localStatus: 'running', hasAskFlag: true }), 'blocked');

  // Herdr working -> running
  assert.equal(resolveSubagentStatus({ localStatus: 'running', herdrStatus: 'working' }), 'running');

  // Local settled or closed -> settled
  assert.equal(resolveSubagentStatus({ localStatus: 'settled', herdrStatus: 'idle' }), 'settled');
  assert.equal(resolveSubagentStatus({ localStatus: 'closed', herdrStatus: 'idle' }), 'settled');
  assert.equal(resolveSubagentStatus({ localStatus: 'running', herdrStatus: 'done' }), 'settled');

  // Herdr idle with local running -> idle
  assert.equal(resolveSubagentStatus({ localStatus: 'running', herdrStatus: 'idle' }), 'idle');

  // Default fallback
  assert.equal(resolveSubagentStatus({ localStatus: 'running', herdrStatus: null }), 'running');
  assert.equal(resolveSubagentStatus({ localStatus: 'settled', herdrStatus: null }), 'settled');
});

/* ── 4. Pure Function: formatSubagentOutput ────────────────────────── */

test('formatSubagentOutput: renders header and content correctly', () => {
  const formatted = formatSubagentOutput({
    paneId: 'wD:p6',
    status: 'running',
    revision: 5,
    bufferTruncated: false,
    deltaResult: {
      delta: 'Compiling module A...\nDone.',
      restart: false,
      truncated: false,
      nextCursor: { tail: 'Done.', fullLength: 30 },
    },
  });
  assert.match(formatted, /\[Subagent Output \| pane: wD:p6 \| status: running \| revision: 5\]/);
  assert.match(formatted, /Compiling module A\.\.\.\nDone\./);
});

test('formatSubagentOutput: renders empty delta notice and restart/truncated flags', () => {
  const formatted = formatSubagentOutput({
    paneId: 'wD:p6',
    status: 'blocked',
    revision: 2,
    bufferTruncated: true,
    askQuestion: 'Confirm overwrite?',
    deltaResult: {
      delta: '',
      restart: true,
      truncated: false,
      nextCursor: { tail: '', fullLength: 0 },
    },
  });
  assert.match(formatted, /status: blocked \(question: "Confirm overwrite\?"\)/);
  assert.match(formatted, /buffer scrolled or reset — full text returned \(not a process restart\)/);
  assert.match(formatted, /truncated: true/);
  assert.match(formatted, /\(no new output since last read\)/);
});

/* ── 5. Integration: subagent(action: "output") ───────────────────── */

interface FakePi {
  tools: Map<string, { execute?: (...a: unknown[]) => unknown }>;
  listeners: Map<string, Array<(...a: unknown[]) => unknown>>;
  entries: Array<[string, unknown]>;
  registerTool(def: { name: string; execute?: (...a: unknown[]) => unknown }): void;
  on(event: string, handler: (...a: unknown[]) => unknown): void;
  appendEntry(customType: string, data: unknown): void;
}

function createFakePi(): FakePi {
  return {
    tools: new Map(),
    listeners: new Map(),
    entries: [],
    registerTool(def) { this.tools.set(def.name, def); },
    on(event, handler) { this.listeners.set(event, [...(this.listeners.get(event) ?? []), handler]); },
    appendEntry(type, data) { this.entries.push([type, data]); },
  };
}

function makeSubEntry(paneId: string, status: SubEntry['status'] = 'running'): SubEntry {
  return {
    taskId: `task-${paneId}`,
    kind: 'task',
    paneId,
    tabId: 't1',
    tabName: 'worker',
    cwd: '/test/cwd',
    description: 'test worker subagent',
    background: true,
    status,
    consumedAt: null,
    sessionFile: null,
    launchCommand: [],
    createdAt: Date.now(),
    revivedFrom: null,
  };
}

async function mountSubagent(opts: {
  pi: FakePi;
  client: HerdrClientLike;
  subs?: SubEntry[];
}): Promise<Context> {
  const surface = new PiSurface(opts.pi as unknown as object);
  const root = new Context();
  const deps = {
    client: opts.client,
    env: { paneId: 'masterPane', tabId: 't0', workspaceId: 'w0' },
    extPath: '/test/index.ts',
    sessionRoot: root,
    port: emptySubagentPortBox(),
    getSessionId: () => 'sess-1',
    reconcileOnSettlement: () => [],
    withReconcileNotes: (b: string) => b,
    claimSettleNotice: () => true,
    terminalState: { activePaneIds: () => new Set<string>() },
  };
  root.provide('pi-herdr.surface', surface);
  root.provide('pi-herdr.subagent-deps', deps);
  await root.plugin(subagentPlugin);

  if (opts.subs && opts.subs.length > 0) {
    for (const h of opts.pi.listeners.get('session_start') ?? []) {
      await h({}, {
        sessionManager: {
          getBranch: () => [
            { type: 'custom', customType: SUBS_CUSTOM_TYPE, data: { subs: opts.subs } },
          ],
        },
      });
    }
  }

  return root;
}

test('subagent action output: missing or unknown agentId returns helpful error', async () => {
  const pi = createFakePi();
  const client = {
    available: true,
    listAgents: async () => [],
  } as unknown as HerdrClientLike;
  const root = await mountSubagent({ pi, client });

  try {
    const tool = pi.tools.get('subagent');
    assert.ok(tool?.execute);

    // Missing agentId (A1: hard failures throw, so the message is the rejection reason)
    await assert.rejects(
      async () => { await tool.execute!(null, { action: 'output' }); },
      /missing agentId for output/,
    );

    // Unknown agentId
    await assert.rejects(
      async () => { await tool.execute!(null, { action: 'output', agentId: 'nonexistent-pane' }); },
      /unknown subagent id "nonexistent-pane"/,
    );
  } finally {
    await root.fiber.dispose();
  }
});

test('subagent action output: incremental progression via agent.read', async () => {
  const pi = createFakePi();
  let currentOutput = 'Initial output line 1\nInitial output line 2\n';
  let readAgentCalls = 0;

  const client = {
    available: true,
    async listAgents(): Promise<AgentInfo[]> {
      return [{
        paneId: 'pWorker',
        agent: 'pi',
        status: 'working',
        session: null,
        stateLabels: {},
        tokens: {},
      }];
    },
    async readAgent(target: string, opts?: { source?: string; stripAnsi?: boolean }) {
      readAgentCalls++;
      assert.equal(target, 'pWorker');
      return { text: currentOutput, revision: 1, truncated: false };
    },
    async readPane() {
      throw new Error('should prefer readAgent over readPane');
    },
  } as unknown as HerdrClientLike;

  const sub = makeSubEntry('pWorker', 'running');
  const root = await mountSubagent({ pi, client, subs: [sub] });

  try {
    const tool = pi.tools.get('subagent');
    assert.ok(tool?.execute);

    // 1. First output call: returns initial full text
    const res1 = await tool.execute(null, { action: 'output', agentId: 'pWorker' }) as {
      content: Array<{ text: string }>;
      details: { status: string; revision: number; deltaLength: number; restart: boolean };
    };
    assert.equal(readAgentCalls, 1);
    assert.equal(res1.details.status, 'running');
    assert.equal(res1.details.restart, false);
    assert.match(res1.content[0].text, /Initial output line 1/);
    assert.match(res1.content[0].text, /Initial output line 2/);

    // 2. Second output call with append: returns only delta
    currentOutput += 'New line 3 appended!\n';
    const res2 = await tool.execute(null, { action: 'output', agentId: 'pWorker' }) as {
      content: Array<{ text: string }>;
      details: { status: string; revision: number; deltaLength: number; restart: boolean };
    };
    assert.equal(readAgentCalls, 2);
    assert.equal(res2.details.restart, false);
    assert.match(res2.content[0].text, /New line 3 appended!/);
    assert.ok(!res2.content[0].text.includes('Initial output line 1'));

    // 3. Third output call with no change: indicates no new output
    const res3 = await tool.execute(null, { action: 'output', agentId: 'pWorker' }) as {
      content: Array<{ text: string }>;
      details: { deltaLength: number };
    };
    assert.equal(readAgentCalls, 3);
    assert.equal(res3.details.deltaLength, 0);
    assert.match(res3.content[0].text, /no new output since last read/);
  } finally {
    await root.fiber.dispose();
  }
});

test('subagent action output: falls back to readPane when readAgent fails or is unsupported', async () => {
  const pi = createFakePi();
  let readPaneCalled = false;

  const client = {
    available: true,
    async listAgents(): Promise<AgentInfo[]> {
      return [{
        paneId: 'pWorker',
        agent: 'pi',
        status: 'working',
        session: null,
        stateLabels: {},
        tokens: {},
      }];
    },
    async readAgent() {
      // Simulate older Herdr 0.8 rejecting unknown method agent.read
      throw new Error('unknown method: agent.read');
    },
    async readPane(paneId: string) {
      readPaneCalled = true;
      assert.equal(paneId, 'pWorker');
      return { text: 'fallback text from readPane\n', revision: 0, truncated: false };
    },
  } as unknown as HerdrClientLike;

  const sub = makeSubEntry('pWorker', 'running');
  const root = await mountSubagent({ pi, client, subs: [sub] });

  try {
    const tool = pi.tools.get('subagent');
    const res = await tool?.execute?.(null, { action: 'output', agentId: 'pWorker' }) as {
      content: Array<{ text: string }>;
    };
    assert.ok(readPaneCalled, 'readPane must be called when readAgent rejects');
    assert.match(res.content[0].text, /fallback text from readPane/);
  } finally {
    await root.fiber.dispose();
  }
});

test('subagent action output: blocked status with human gate question reported accurately', async () => {
  const pi = createFakePi();
  const client = {
    available: true,
    async listAgents(): Promise<AgentInfo[]> {
      return [{
        paneId: 'pWorker',
        agent: 'pi',
        status: 'blocked',
        session: null,
        stateLabels: {},
        tokens: { 'pi-ask': 'Should we delete existing tables?' },
      }];
    },
    async readAgent() {
      return { text: 'Waiting for decision...\n', revision: 2, truncated: false };
    },
    async readPane() {
      return { text: 'Waiting for decision...\n', revision: 2, truncated: false };
    },
  } as unknown as HerdrClientLike;

  const sub = makeSubEntry('pWorker', 'running');
  const root = await mountSubagent({ pi, client, subs: [sub] });

  try {
    const tool = pi.tools.get('subagent');
    const res = await tool?.execute?.(null, { action: 'output', agentId: 'pWorker' }) as {
      content: Array<{ text: string }>;
      details: { status: string };
    };
    assert.equal(res.details.status, 'blocked');
    assert.match(res.content[0].text, /status: blocked \(question: "Should we delete existing tables\?"\)/);
  } finally {
    await root.fiber.dispose();
  }
});

test('subagent action output: settled subagent reflects settled status', async () => {
  const pi = createFakePi();
  const client = {
    available: true,
    async listAgents(): Promise<AgentInfo[]> {
      return [{
        paneId: 'pWorker',
        agent: 'pi',
        status: 'idle',
        session: null,
        stateLabels: {},
        tokens: {},
      }];
    },
    async readAgent() {
      return { text: 'Task completed successfully.\n', revision: 4, truncated: false };
    },
  } as unknown as HerdrClientLike;

  // Local registry marks sub as settled
  const sub = makeSubEntry('pWorker', 'settled');
  const root = await mountSubagent({ pi, client, subs: [sub] });

  try {
    const tool = pi.tools.get('subagent');
    const res = await tool?.execute?.(null, { action: 'output', agentId: 'pWorker' }) as {
      content: Array<{ text: string }>;
      details: { status: string };
    };
    assert.equal(res.details.status, 'settled');
    assert.match(res.content[0].text, /status: settled/);
  } finally {
    await root.fiber.dispose();
  }
});

/* ── 6. HerdrClient: readAgent RPC & NoopHerdrClient ──────────────── */

test('NoopHerdrClient: readAgent returns empty output buffer', async () => {
  const noop = new NoopHerdrClient();
  const res = await noop.readAgent();
  assert.deepEqual(res, { text: '', revision: 0, truncated: false });
});

test('HerdrClient: readAgent sends agent.read RPC and unwraps response envelope', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'herdr-read-agent-'));
  const sockPath = join(tmpDir, `test-${randomUUID().slice(0, 8)}.sock`);
  const received: Array<{ method: string; params: Record<string, unknown> }> = [];

  const server = createServer((socket) => {
    socket.setEncoding('utf8');
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk;
      const idx = buf.indexOf('\n');
      if (idx < 0) return;
      const msg = JSON.parse(buf.slice(0, idx).trim());
      received.push({ method: msg.method, params: msg.params });
      // Observed Herdr envelope: { read: { text, revision, truncated } }
      const res = {
        id: msg.id,
        result: {
          read: {
            text: 'agent output text line 1\n',
            revision: 42,
            truncated: false,
          },
        },
      };
      socket.write(JSON.stringify(res) + '\n');
      socket.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(herdrSocketTarget(sockPath), () => resolve());
  });

  try {
    const client = new HerdrClient({
      socketPath: sockPath,
      paneId: 'pMaster',
      workspaceId: 'w0',
      tabId: 't0',
    });
    const read = await client.readAgent('pWorker', { source: 'recent', lines: 100, stripAnsi: true });
    assert.deepEqual(read, {
      text: 'agent output text line 1\n',
      revision: 42,
      truncated: false,
    });
    assert.equal(received.length, 1);
    assert.equal(received[0].method, 'agent.read');
    assert.equal(received[0].params.target, 'pWorker');
    assert.equal(received[0].params.source, 'recent');
    assert.equal(received[0].params.format, 'text');
    assert.equal(received[0].params.strip_ansi, true);
    assert.equal(received[0].params.lines, 100);
  } finally {
    server.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('P2-4: restart 旗标文案不再暗示进程重启（fullscreen TUI 恒态）', () => {
  const out = formatSubagentOutput({
    paneId: 'p1',
    status: 'running',
    revision: 0,
    bufferTruncated: false,
    deltaResult: { delta: 'x', restart: true, truncated: false, nextCursor: { tail: 'x', fullLength: 1 } },
  });
  assert.match(out, /buffer scrolled or reset — full text returned \(not a process restart\)/);
  assert.doesNotMatch(out, /restart: true/);
});

test('p25 (01a0c282): idle/settled output falls back to the session transcript when the pane shows only the status overlay', async () => {
  // Evidence shape: every pane read returned the 306-char todo footer while the worker's
  // real report existed only in its session file. The action must surface that report,
  // exactly once per distinct report.
  const home = mkdtempSync(join(tmpdir(), 'pier-out-home-'));
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = home;
  const reportFile = join(home, 'sessions', 'sub-report.jsonl');
  mkdirSync(join(home, 'sessions'), { recursive: true });
  writeFileSync(reportFile, JSON.stringify({
    type: 'message',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'FINAL REPORT: region enum + converter delivered byte-identical to dev_eu' }],
      timestamp: Date.now(),
      stopReason: 'stop',
    },
  }) + '\n');

  const client = {
    available: true,
    listAgents: async () => [{
      paneId: 'pWorker',
      agent: 'pi',
      status: 'idle',
      session: reportFile,
      stateLabels: {},
      tokens: {},
    } as AgentInfo],
    readAgent: async () => ({ text: 'todo: 0▶ 0○ 0■ 7✓\n   +3 hidden (7✓) · /todos\n', revision: 0, truncated: false }),
  } as unknown as HerdrClientLike;

  const sub = makeSubEntry('pWorker', 'running');
  const pi = createFakePi();
  const root = await mountSubagent({ pi, client, subs: [sub] });
  try {
    const tool = pi.tools.get('subagent');
    assert.ok(tool?.execute);

    const res1 = await tool.execute!(null, { action: 'output', agentId: 'pWorker', max_chars: 3000 }) as {
      content: Array<{ text: string }>;
      details: { status: string; deltaLength: number; reportDelivered?: boolean };
    };
    assert.equal(res1.details.status, 'idle');
    assert.ok(res1.details.deltaLength > 0, 'first read returns the overlay footer as the full text');
    assert.match(res1.content[0].text, /todo: 0▶ 0○ 0■ 7✓/, 'pane read is footer-only');
    assert.equal(res1.details.reportDelivered, true, 'report must be surfaced from the transcript');
    assert.match(res1.content[0].text, /Subagent Report \| latest finalized message from session transcript/);
    assert.match(res1.content[0].text, /FINAL REPORT: region enum/);

    // Second poll with unchanged transcript: no duplicate report section.
    const res2 = await tool.execute!(null, { action: 'output', agentId: 'pWorker', max_chars: 3000 }) as {
      content: Array<{ text: string }>;
      details: { reportDelivered?: boolean; deltaLength?: number };
    };
    assert.equal(res2.details.deltaLength, 0, 'pane delta stays empty (overlay footer unchanged)');
    assert.equal(res2.details.reportDelivered, false, 'unchanged report is not re-delivered');
    assert.doesNotMatch(res2.content[0].text, /Subagent Report/);
  } finally {
    await root.fiber.dispose();
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    rmSync(home, { recursive: true, force: true });
  }
});
