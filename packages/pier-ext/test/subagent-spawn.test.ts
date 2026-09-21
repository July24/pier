/**
 * Spawn domain: isolate planning/execution, readiness failures, and the `spawn` tool path
 * end-to-end against a real pipe server (prompt injection, settlement, ledger bookkeeping).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import subagentPlugin from '../src/plugins/subagent.ts';
import { PiSurface } from '../src/pi-surface.ts';
import { pipeNameFor, pipePathFor, type PipeRequest } from '../src/pipe-channel.ts';
import type { HerdrClientLike } from '../src/herdr-client.ts';
import { emptySubagentPortBox, type SubagentPortBox } from '../src/subagent-core.ts';
import { appendHistory } from '../src/history-store.ts';
import { preferredHistoryFile } from '../src/storage-layout.ts';
import { SUBS_CUSTOM_TYPE, type SubEntry } from '../src/subagent-core.ts';
import { sessionDirName } from '../src/session-tail.ts';
import {
  buildIsolatePreamble,
  evaluateRelease,
  foldSubsRegistry,
  formatWorktreeStat,
  parseWorktreePorcelain,
  planIsolateWorktree,
} from '../src/subagent-core.ts';
import { createSpawner } from '../src/subagent-spawn.ts';

/* ── isolate planning (pure) ────────────────────────────────────── */

test('planIsolateWorktree: ascii fold, dedupe suffix, non-ascii fallback', () => {
  const base = planIsolateWorktree({ description: 'Fix Auth Flow!', taskHex: 'a1b2c3', existingPierBranches: new Set() });
  assert.equal(base.slug, 'fix-auth-flow');
  assert.equal(base.branch, 'pier/fix-auth-flow');
  assert.equal(base.worktreeDirName, 'pier-fix-auth-flow');

  const again = planIsolateWorktree({ description: 'Fix Auth Flow!', taskHex: 'a1b2c3', existingPierBranches: new Set(['fix-auth-flow']) });
  assert.equal(again.slug, 'fix-auth-flow-2');
  const third = planIsolateWorktree({
    description: 'Fix Auth Flow!',
    taskHex: 'a1b2c3',
    existingPierBranches: new Set(['fix-auth-flow', 'fix-auth-flow-2']),
  });
  assert.equal(third.slug, 'fix-auth-flow-3');

  const nonAscii = planIsolateWorktree({ description: '纯中文描述', taskHex: 'deadbe', existingPierBranches: new Set() });
  assert.equal(nonAscii.slug, 'task-deadbe');
  assert.equal(nonAscii.worktreeDirName, 'pier-task-deadbe');
  const collided = planIsolateWorktree({ description: '另一个', taskHex: 'deadbe', existingPierBranches: new Set(['task-deadbe']) });
  assert.equal(collided.slug, 'task-deadbe-2');
});

test('buildIsolatePreamble: named path/branch/base plus commit discipline', () => {
  const text = buildIsolatePreamble({ worktreePath: 'C:/wt/pier-x', branch: 'pier/x', baseShort: 'abc1234' });
  assert.match(text, /C:\/wt\/pier-x/);
  assert.match(text, /branch pier\/x/);
  assert.match(text, /base abc1234/);
  assert.match(text, /NEVER push/);
  assert.match(text, /git add -A && git commit/);
  assert.match(text, /Do not touch the main checkout/);
});

test('formatWorktreeStat: isolate rows, lightweight shared-checkout row, null on missing input', () => {
  assert.equal(
    formatWorktreeStat({ branch: 'pier/x', commits: 2, statLine: '3 files changed, 10 insertions(+)', dirtyCount: 0 }),
    'Worktree pier/x: 2 commit(s) since base; 3 files changed, 10 insertions(+); uncommitted: 0 file(s)',
  );
  assert.match(
    formatWorktreeStat({ branch: 'pier/x', commits: 1, statLine: '1 file changed', dirtyCount: 2 })!,
    /uncommitted: 2 file\(s\) \(worker should have committed\)/,
  );
  assert.equal(formatWorktreeStat({ branch: 'pier/x', commits: 1, statLine: null, dirtyCount: 0 }), null);
  assert.equal(formatWorktreeStat({ branch: 'pier/x', commits: 1, statLine: 'x', dirtyCount: null }), null);
  assert.equal(
    formatWorktreeStat({ branch: null, commits: null, statLine: '2 files changed, 5 insertions(+)', dirtyCount: 3 }),
    'git: 2 files changed, 5 insertions(+); uncommitted: 3 file(s)',
  );
  assert.equal(formatWorktreeStat({ branch: null, commits: null, statLine: null, dirtyCount: 0 }), null);
});

test('evaluateRelease: only merged and clean releases; everything else retains with a reason', () => {
  assert.deepEqual(evaluateRelease({ merged: true, dirtyCount: 0 }), { action: 'release' });
  assert.deepEqual(evaluateRelease({ merged: false, dirtyCount: 0 }), { action: 'retain', reason: 'unmerged' });
  assert.deepEqual(evaluateRelease({ merged: true, dirtyCount: 4 }), { action: 'retain', reason: 'dirty' });
  assert.deepEqual(evaluateRelease({ merged: null, dirtyCount: 0 }), { action: 'retain', reason: 'unknown' });
  assert.deepEqual(evaluateRelease({ merged: true, dirtyCount: null }), { action: 'retain', reason: 'unknown' });
});

test('foldSubsRegistry: isolate metadata round-trips, malformed shapes fall back to none', () => {
  const entry: SubEntry = {
    taskId: 't1', kind: 'task', paneId: 'p1', tabId: 'tab1', tabName: 'pier-x', cwd: 'C:/wt/pier-x',
    description: 'x', background: true, status: 'settled', consumedAt: null, sessionFile: null,
    launchCommand: [], createdAt: 1, revivedFrom: null,
    isolate: { worktreePath: 'C:/wt/pier-x', branch: 'pier/x', baseSha: 'abc', releasedAt: null, retainNotified: false },
  };
  const folded = foldSubsRegistry([{ type: 'custom', customType: SUBS_CUSTOM_TYPE, data: { subs: [entry] } }]);
  assert.deepEqual(folded.subs[0]!.isolate, entry.isolate);
  const partial = foldSubsRegistry([{ type: 'custom', customType: SUBS_CUSTOM_TYPE, data: { subs: [{ ...entry, isolate: { branch: 'pier/y' } }] } }]);
  assert.equal(partial.subs[0]!.isolate, undefined);
});

test('parseWorktreePorcelain: multi-block POSIX output, Windows CRLF, detached and bare blocks', () => {
  const posix = parseWorktreePorcelain([
    'worktree /home/dev/proj',
    'HEAD 1234567890abcdef',
    'branch refs/heads/master',
    '',
    'worktree /home/dev/.herdr/worktrees/proj/pier-fix-auth',
    'HEAD fedcba0987654321',
    'branch refs/heads/pier/fix-auth',
    '',
    'worktree /Users/Shared/proj2',
    'branch refs/heads/feature/x',
    '',
  ].join('\n'));
  assert.equal(posix.size, 3);
  assert.equal(posix.get('master'), '/home/dev/proj');
  assert.equal(posix.get('pier/fix-auth'), '/home/dev/.herdr/worktrees/proj/pier-fix-auth');

  const windows = parseWorktreePorcelain([
    'worktree F:/herdr-pi',
    'HEAD 1234567890abcdef',
    'branch refs/heads/master',
    '',
    'worktree C:/Users/Some Name/.herdr/worktrees/herdr-pi/pier-d98-iso-x',
    'branch refs/heads/pier/d98-iso-x',
    '',
  ].join('\r\n'));
  assert.equal(windows.size, 2);
  assert.equal(windows.get('pier/d98-iso-x'), 'C:/Users/Some Name/.herdr/worktrees/herdr-pi/pier-d98-iso-x');

  const odd = parseWorktreePorcelain([
    'worktree /repo', 'HEAD abc', 'branch refs/heads/main', '',
    'worktree /tmp/detached-wt', 'HEAD def', 'detached', '',
    'worktree /tmp/bare-repo.git', 'bare', '',
    'worktree /tmp/orphan-block', '',
  ].join('\n'));
  assert.deepEqual([...odd.entries()], [['main', '/repo']]);
});

/* ── readiness failures ─────────────────────────────────────────── */

const gitStub = {
  listWorktrees: async () => [],
  runGit: async () => null,
  worktreeStatLine: async () => null,
  invalidateWorktreesCache: () => undefined,
};

const spawnerFor = (client: Record<string, unknown>, over: Record<string, unknown> = {}) => createSpawner({
  client: client as unknown as HerdrClientLike,
  env: { paneId: 'p0', tabId: 't0', workspaceId: 'w1' },
  runtime: { nodePath: '/usr/bin/node', cliPath: '/cli.js', extPath: '/ext.ts' },
  git: gitStub,
  ...over,
} as Parameters<typeof createSpawner>[0]);

test('waitSubReady: a gone pane fails fast with its last output instead of waiting out the timeout', async () => {
  const spawner = spawnerFor({
    listPanes: async () => [],
    readPane: async () => ({ text: 'TypeError: boom at footer.render', revision: 1, truncated: false }),
  });
  const started = Date.now();
  const out = await spawner.waitSubReady('/tmp/pier-a14-nonexistent', 'wA14:p404');
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.match(out.message, /exited before its pipe became ready/);
  assert.match(out.message, /TypeError: boom at footer\.render/);
  assert.ok(Date.now() - started < 10_000, 'pane-gone must not wait for the readiness timeout');
});

test('waitSubReady: herdr detection diagnostics are attached to the failure', async () => {
  const spawner = spawnerFor({
    available: true,
    listPanes: async () => [],
    readPane: async () => ({ text: 'SyntaxError: unexpected token', revision: 1, truncated: false }),
    agentExplain: async () => ({ matched_rule: 'pi-worker', skip_state_reason: 'process_crashed' }),
  });
  const out = await spawner.waitSubReady('/tmp/pier-091-explain', 'wA14:p405');
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.match(out.message, /Herdr detection diagnosis:/);
  assert.match(out.message, /matched rule: pi-worker/);
  assert.match(out.message, /skip reason: process_crashed/);
});

test('waitSubReady: an unknown shell is alive-but-not-ready, not pane-gone', async () => {
  const paneId = 'wH:p3';
  const spawner = spawnerFor({
    listPanes: async () => [{ paneId, agentStatus: 'unknown' }],
    readPane: async () => ({ text: 'booting', revision: 0, truncated: false }),
  }, { readinessTimeoutMs: 50 });
  const out = await spawner.waitSubReady('/tmp/pier-unknown-shell', paneId);
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.match(out.message, /pipe not ready within/);
  assert.match(out.message, /never registered its pipe/, 'an unknown shell means "still booting", not "gone"');
});

/* ── spawn tool: pipe harness ───────────────────────────────────── */

const SUB_TEXT = 'REPORT: all channel-fee contact points mapped';
const PROMPT = '你在 apnv3-backend 仓库探查渠道费用触点（只读）。输出完整报告。';

interface FakePi {
  tools: Map<string, { execute?: (...a: unknown[]) => unknown }>;
  listeners: Map<string, Array<(...a: unknown[]) => unknown>>;
  entries: Array<[string, unknown]>;
  registerTool(def: { name: string; execute?: (...a: unknown[]) => unknown }): void;
  on(event: string, handler: (...a: unknown[]) => unknown): void;
  appendEntry(customType: string, data: unknown): void;
}

function fakePi(): FakePi {
  return {
    tools: new Map(),
    listeners: new Map(),
    entries: [],
    registerTool(def) { this.tools.set(def.name, def); },
    on(event, handler) { this.listeners.set(event, [...(this.listeners.get(event) ?? []), handler]); },
    appendEntry(customType, data) { this.entries.push([customType, data]); },
  };
}

interface Harness {
  closePaneCalls: string[];
  prompts: PipeRequest[];
  /** Simulate the child answering: the settle text is written when the prompt arrives. */
  onPrompt?: () => void;
}

/** p0 = master (tab t0); splitPane creates p2. */
function fakeClient(sessionFile: string, h: Harness): HerdrClientLike {
  return {
    available: true,
    tabList: async () => [{ tabName: 'main', tabId: 't0', workspaceId: 'w1', label: 'main' }],
    listPanes: async () => [
      { paneId: 'p0', tabId: 't0', agentStatus: 'working' },
      { paneId: 'p2', tabId: 't0', agentStatus: 'idle' },
    ],
    listAgents: async () => [],
    waitAgent: async () => 'idle',
    getAgentSessionPath: async () => sessionFile,
    createTab: async () => ({ tabId: 't9', paneId: 'p9' }),
    splitPane: async () => 'p2',
    sendPaneText: async () => undefined,
    exportLayout: async () => { throw new Error('layout export unavailable in test'); },
    tabClose: async () => undefined,
    closePane: async (paneId: string) => { h.closePaneCalls.push(paneId); },
  } as unknown as HerdrClientLike;
}

/** One connection per request; prompt requests can be rejected on demand. */
async function startPipeSim(cwd: string, h: Harness, opts: { rejectPrompt?: boolean }): Promise<{ stop: () => Promise<void> }> {
  const sockPath = pipePathFor(pipeNameFor(cwd, 'p2'));
  try {
    if (existsSync(sockPath)) unlinkSync(sockPath);
  } catch { /* stale socket cleanup is best effort */ }
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => {
      buf += chunk;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      const req = JSON.parse(buf.slice(0, i)) as PipeRequest;
      buf = '';
      const isPrompt = req.type === 'prompt' || req.type === 'follow_up';
      if (isPrompt) {
        h.prompts.push(req);
        h.onPrompt?.();
      }
      const res = isPrompt && opts.rejectPrompt
        ? { type: 'error' as const, id: req.id, message: 'sim rejected' }
        : { type: 'ok' as const, id: req.id };
      sock.write(JSON.stringify(res) + '\n');
    });
  });
  const { promise, resolve } = Promise.withResolvers<void>();
  server.listen(sockPath, () => resolve());
  await promise;
  // Destroying the live sockets first: a lingering client would keep close() pending forever.
  return {
    stop: async () => {
      for (const sock of sockets) sock.destroy();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    },
  };
}

interface SpawnCtx {
  pi: FakePi;
  port: SubagentPortBox;
  h: Harness;
  cwd: string;
}

async function withSpawnEnv(fn: (ctx: SpawnCtx) => Promise<void>, opts: { rejectPrompt?: boolean; childCwd?: string } = {}): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'pier-spawn-home-'));
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = home; // keep the ledger and session scan inside the temp dir
  const cwd = mkdtempSync(join(tmpdir(), 'pier-spawn-cwd-'));
  const sessionFile = join(cwd, 'sub-session.jsonl');
  const h: Harness = {
    closePaneCalls: [],
    prompts: [],
    onPrompt: opts.rejectPrompt ? undefined : () => writeFileSync(sessionFile, JSON.stringify({
      type: 'message',
      message: { role: 'assistant', content: [{ type: 'text', text: SUB_TEXT }], timestamp: Date.now(), stopReason: 'stop' },
    }) + '\n'),
  };
  const pipeSim = await startPipeSim(opts.childCwd ?? cwd, h, opts);
  const pi = fakePi();
  const port = emptySubagentPortBox();
  const root = new Context();
  root.provide('pi-herdr.surface', new PiSurface(pi as unknown as object));
  root.provide('pi-herdr.subagent-deps', {
    client: fakeClient(sessionFile, h),
    env: { paneId: 'p0', tabId: 't0', workspaceId: 'w1' },
    extPath: new URL('../src/index.ts', import.meta.url).pathname,
    sessionRoot: root,
    port,
    getSessionId: () => '',
    reconcileOnSettlement: () => [],
    withReconcileNotes: (b: string) => b,
    claimSettleNotice: () => true,
    terminalState: { activePaneIds: () => new Set<string>() },
  });
  await root.plugin(subagentPlugin);
  try {
    await fn({ pi, port, h, cwd });
  } finally {
    await root.fiber.dispose();
    await pipeSim.stop();
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
  }
}

const run = (pi: FakePi, params: Record<string, unknown>, cwd: string) =>
  pi.tools.get('subagent')!.execute!('tc', params, undefined, undefined, { cwd }) as Promise<{
    content: Array<{ text: string }>;
    details?: Record<string, unknown>;
  }>;

const runRejects = async (pi: FakePi, params: Record<string, unknown>, cwd: string): Promise<string> => {
  try {
    await run(pi, params, cwd);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('expected the subagent tool to fail');
};

test('spawn: foreground run injects the prompt once and settles with the closing text', { timeout: 30_000 }, async () => {
  await withSpawnEnv(async ({ pi, port, h, cwd }) => {
    const result = await run(pi, { description: '探查', prompt: PROMPT }, cwd);
    const text = result.content[0]!.text;
    assert.ok(!/failed to spawn/.test(text), `no spawn failure: ${text}`);
    assert.match(text, /REPORT: all channel-fee contact points mapped/);
    assert.equal(h.prompts.length, 1, 'the prompt is injected exactly once');
    assert.equal((h.prompts[0] as { text?: string }).text, PROMPT, 'the whole prompt reaches the worker');
    assert.deepEqual(port.current?.listRunningSubs() ?? [], [], 'no ghost running row survives the foreground run');
  });
});

test('spawn/send: the reply pipe is scoped by the master session cwd, not the worker cwd', { timeout: 30_000 }, async () => {
  const other = mkdtempSync(join(tmpdir(), 'pier-spawn-other-'));
  await withSpawnEnv(async ({ pi, h, cwd }) => {
    const spawned = await run(pi, { description: '跨仓库任务', prompt: PROMPT, run_in_background: true, cwd: other }, cwd);
    assert.match(spawned.content[0]!.text, /^started subagent p2 /);
    const expected = pipeNameFor(cwd, 'p0');
    assert.equal((h.prompts[0] as { from?: string }).from, expected, 'spawn replies to the master session pipe');
    assert.notEqual((h.prompts[0] as { from?: string }).from, pipeNameFor(other, 'p0'));

    const sent = await run(pi, { action: 'send', agentId: 'p2', message: 'wrap up and report' }, cwd);
    assert.match(sent.content[0]!.text, /Message sent to subagent p2/);
    assert.equal((h.prompts[1] as { from?: string }).from, expected, 'follow_up replies to the same master pipe');
  }, { childCwd: other });
});

test('spawn: a rejected prompt injection rolls back the ledger and closes the pane', { timeout: 30_000 }, async () => {
  await withSpawnEnv(async ({ pi, port, h, cwd }) => {
    const text = (await run(pi, { description: '探查', prompt: PROMPT }, cwd)).content[0]!.text;
    assert.match(text, /failed to spawn/);
    assert.match(text, /sim rejected/);
    assert.deepEqual(h.closePaneCalls, ['p2'], 'the failed pane is closed');
    assert.deepEqual(port.current?.listRunningSubs() ?? [], [], 'no ghost running row in the ledger');
    const snapshots = pi.entries.filter(([t]) => t === SUBS_CUSTOM_TYPE);
    const last = snapshots.at(-1)?.[1] as { subs?: Array<{ paneId: string }> } | undefined;
    assert.ok(!last?.subs?.some((s) => s.paneId === 'p2'), 'the final snapshot no longer lists the pane');
  }, { rejectPrompt: true });
});

test('spawn: run_in_background returns immediately and keeps the row running', { timeout: 30_000 }, async () => {
  await withSpawnEnv(async ({ pi, port, cwd }) => {
    const result = await run(pi, { description: '后台探查', prompt: PROMPT, run_in_background: true }, cwd);
    assert.match(result.content[0]!.text, /^started subagent p2 \(task [0-9a-f-]+\)$/);
    assert.equal(result.details?.background, true);
    assert.equal(result.details?.paneId, 'p2');
    const running = port.current?.listRunningSubs() ?? [];
    assert.deepEqual(running.map((s) => s.paneId), ['p2']);
    assert.equal(running[0]!.description, '后台探查');
  });
});

test('send/resume: short prefixes resolve at four characters and report ambiguity or misses', { timeout: 30_000 }, async () => {
  await withSpawnEnv(async ({ pi, h, cwd }) => {
    const spawned = await run(pi, { description: '后台任务', prompt: PROMPT, run_in_background: true }, cwd);
    const fullTaskId = spawned.details?.taskId as string;
    assert.ok(typeof fullTaskId === 'string' && fullTaskId.length >= 8);
    const short8 = fullTaskId.slice(0, 8);
    const short4 = fullTaskId.slice(0, 4);

    const sent8 = await run(pi, { action: 'send', agentId: short8, message: '8-char prefix message' }, cwd);
    assert.match(sent8.content[0]!.text, /Message sent to subagent p2/);
    assert.equal((h.prompts[1] as { text?: string }).text, '8-char prefix message');

    await run(pi, { action: 'send', agentId: short4, message: '4-char prefix message' }, cwd);
    assert.equal(h.prompts.length, 3);

    assert.match(await runRejects(pi, { action: 'send', agentId: fullTaskId.slice(0, 3), message: 'x' }, cwd), /too short \(minimum 4 characters\)/);
    assert.match(await runRejects(pi, { action: 'send', agentId: '00000000', message: 'x' }, cwd), /unknown subagent id "00000000"/);

    const resumed = await run(pi, { action: 'resume', taskId: short8 }, cwd);
    assert.match(resumed.content[0]!.text, /resumed subagent/);
    assert.equal(resumed.details?.taskId, fullTaskId, 'resume reports the full taskId');
    assert.match(await runRejects(pi, { action: 'resume', taskId: fullTaskId.slice(0, 3) }, cwd), /too short \(minimum 4 characters\)/);
    assert.match(await runRejects(pi, { action: 'resume', taskId: 'ffffffff' }, cwd), /no history for task "ffffffff"/);

    // A second generation sharing the prefix makes the four-character prefix ambiguous.
    const ambiguousTaskId = `${short4}9999-0000-1111-2222-333344445555`;
    appendHistory(preferredHistoryFile(process.env.PI_CODING_AGENT_DIR!, cwd), {
      taskId: ambiguousTaskId,
      kind: 'task',
      paneId: 'p3',
      tabId: 't0',
      workspaceId: 'w1',
      cwd,
      description: '歧义冲突任务',
      sessionFile: null,
      launchCommand: ['node', 'cli.js'],
      status: 'settled',
      createdAt: Date.now() + 10,
    });
    const ambiguous = await runRejects(pi, { action: 'resume', taskId: short4 }, cwd);
    assert.match(ambiguous, /ambiguous task id/);
    assert.match(ambiguous, new RegExp(fullTaskId));
    assert.match(ambiguous, new RegExp(ambiguousTaskId));
  });
});

/* ── isolate at the tool surface ────────────────────────────────── */

async function mountTool(pi: FakePi, client: HerdrClientLike = fakeClient('/tmp/none.jsonl', { closePaneCalls: [], prompts: [] })) {
  const root = new Context();
  root.provide('pi-herdr.surface', new PiSurface(pi as unknown as object));
  root.provide('pi-herdr.subagent-deps', {
    client,
    env: { paneId: 'p0', tabId: 't0', workspaceId: 'w1' },
    extPath: 'F:/repo/pier/packages/pier-ext/src/index.ts',
    sessionRoot: root,
    port: emptySubagentPortBox(),
    getSessionId: () => '',
    reconcileOnSettlement: () => [],
    withReconcileNotes: (b: string) => b,
    claimSettleNotice: () => true,
    terminalState: { activePaneIds: () => new Set<string>() },
  });
  await root.plugin(subagentPlugin);
  return root;
}

test('isolate: mutually exclusive with cwd', async () => {
  const pi = fakePi();
  const root = await mountTool(pi);
  try {
    const text = await runRejects(pi, { description: 'x', prompt: 'do x', isolate: true, cwd: 'F:/somewhere' }, process.cwd());
    assert.match(text, /`isolate` and `cwd` are mutually exclusive — isolate creates a new worktree, cwd delegates into an existing one/);
  } finally {
    await root.fiber.dispose();
  }
});

test('isolate: outside a git repository it fails instead of degrading to the shared checkout', async () => {
  const pi = fakePi();
  const root = await mountTool(pi);
  try {
    const nonGit = mkdtempSync(join(tmpdir(), 'd98-nogit-'));
    const text = await runRejects(pi, { description: 'x', prompt: 'do x', isolate: true }, nonGit);
    assert.match(text, /isolate requires a git repository with at least one commit/);
  } finally {
    await root.fiber.dispose();
  }
});

/* ── resume and reply-session healing ───────────────────────────── */

async function mountWithClient(pi: FakePi, client: HerdrClientLike, deps: Record<string, unknown> = {}) {
  const root = new Context();
  root.provide('pi-herdr.surface', new PiSurface(pi as unknown as object));
  root.provide('pi-herdr.subagent-deps', {
    client,
    env: { paneId: 'p0', tabId: 't0', workspaceId: 'w1' },
    extPath: new URL('../src/index.ts', import.meta.url).pathname,
    sessionRoot: root,
    port: emptySubagentPortBox(),
    getSessionId: () => '',
    reconcileOnSettlement: () => [],
    withReconcileNotes: (b: string) => b,
    claimSettleNotice: () => true,
    terminalState: { activePaneIds: () => new Set<string>() },
    ...deps,
  });
  await root.plugin(subagentPlugin);
  return root;
}

const fire = async (pi: FakePi, event: string, ...args: unknown[]): Promise<void> => {
  for (const h of pi.listeners.get(event) ?? []) await h(...args);
};

const branchOf = (entry: SubEntry) => [{ type: 'custom', customType: SUBS_CUSTOM_TYPE, data: { subs: [entry] } }];
const ledgerSnapshot = (pi: FakePi) => pi.entries.filter(([t]) => t === SUBS_CUSTOM_TYPE).at(-1)?.[1] as { subs: SubEntry[] } | undefined;

test('resume: a ledger row pointing at the master session is refused; another pane is reused', { timeout: 30_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'pier-resume-self-'));
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = home;
  const cwd = mkdtempSync(join(tmpdir(), 'pier-resume-self-cwd-'));
  const masterFile = join(cwd, 'master-session.jsonl');
  const otherFile = join(cwd, 'other-session.jsonl');
  writeFileSync(masterFile, '{}\n');
  writeFileSync(otherFile, '{}\n');

  const pi = fakePi();
  const client = {
    ...fakeClient(masterFile, { closePaneCalls: [], prompts: [] }),
    listPanes: async () => [
      { paneId: 'p0', tabId: 't0', agentStatus: 'idle' },
      { paneId: 'p2', tabId: 't0', agentStatus: 'idle' },
    ],
    listAgents: async () => [
      { paneId: 'p0', status: 'idle', session: masterFile },
      { paneId: 'p2', status: 'idle', session: otherFile },
    ],
  } as unknown as HerdrClientLike;
  const root = await mountWithClient(pi, client);
  try {
    const histFile = preferredHistoryFile(home, cwd);
    const base = {
      kind: 'task' as const, tabId: 't0', workspaceId: 'w1', cwd,
      launchCommand: ['node', 'cli.js'], status: 'closed' as const,
    };
    appendHistory(histFile, { ...base, taskId: '8183022d-a733-4292-911b-850e6dffba5a', paneId: 'wA:p25', description: 'Investigate bug 19812', sessionFile: masterFile, createdAt: Date.now() });
    appendHistory(histFile, { ...base, taskId: '937f4abf-0000-4111-8222-333333333333', paneId: 'wA:p2old', description: 'healthy task', sessionFile: otherFile, createdAt: Date.now() + 1 });

    assert.match(await runRejects(pi, { action: 'resume', taskId: '8183022d' }, cwd), /master's own session/);
    assert.ok(!ledgerSnapshot(pi)?.subs.some((s) => s.paneId === 'p0'), 'the master pane never enters the registry');

    const ok = await run(pi, { action: 'resume', taskId: '937f4abf' }, cwd);
    assert.match(ok.content[0]!.text, /reused existing pane/);
    assert.equal(ok.details?.paneId, 'p2');
  } finally {
    await root.fiber.dispose();
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
  }
});

test('applyReplySession: a bare session id self-report repairs a poisoned sessionFile', { timeout: 30_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'pier-reply-session-'));
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = home;
  const cwd = mkdtempSync(join(tmpdir(), 'pier-reply-cwd-'));
  const dir = join(home, 'sessions', sessionDirName(cwd));
  mkdirSync(dir, { recursive: true });
  const realFile = join(dir, '2026-09-20T05-14-07-064Z_01a0bd3c-6557-746b-adf6-5128f2326c57.jsonl');
  writeFileSync(realFile, '{}\n');
  const poisoned = join(cwd, 'stale-01a0bd34.jsonl');
  writeFileSync(poisoned, '{}\n');

  const pi = fakePi();
  const port = emptySubagentPortBox();
  const root = await mountWithClient(pi, fakeClient(realFile, { closePaneCalls: [], prompts: [] }), { port, getSessionId: () => '99999999-9999-4999-8999-999999999999' });
  try {
    await fire(pi, 'session_start', {}, {
      sessionManager: {
        getBranch: () => branchOf({
          taskId: '11111111-2222-4333-8444-555555555555', kind: 'task', paneId: 'p2', tabId: 't0', tabName: 'main',
          cwd, description: 'Investigate bug 19803', status: 'settled', background: true,
          sessionFile: poisoned, launchCommand: [], createdAt: Date.now() - 60_000, revivedFrom: null,
        }),
      },
    });
    port.current!.applyReplySession('p2', '01a0bd3c-6557-746b-adf6-5128f2326c57');
    assert.equal(ledgerSnapshot(pi)!.subs.find((s) => s.paneId === 'p2')!.sessionFile, realFile);
  } finally {
    await root.fiber.dispose();
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
  }
});

test('session recovery: a still-running subagent gets its settlement watch re-armed', { timeout: 30_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'pier-recover-home-'));
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = home;
  const cwd = mkdtempSync(join(tmpdir(), 'pier-recover-cwd-'));
  const dir = join(home, 'sessions', sessionDirName(cwd));
  mkdirSync(dir, { recursive: true });
  const workerFile = join(dir, '2026-09-20T06-10-00-000Z_aaaa1111-2222-4333-8444-555555555555.jsonl');
  writeFileSync(workerFile, JSON.stringify({
    type: 'message',
    message: { role: 'assistant', content: [{ type: 'text', text: 'RECOVERED_REPORT: fix committed, 199 tests green' }], timestamp: Date.now(), stopReason: 'stop' },
  }) + '\n');

  const pi = fakePi();
  const notices: string[] = [];
  const client = {
    ...fakeClient(workerFile, { closePaneCalls: [], prompts: [] }),
    listPanes: async () => [{ paneId: 'pAlive', tabId: 't0', agentStatus: 'idle' }],
    listAgents: async () => [{ paneId: 'pAlive', status: 'idle', session: workerFile }],
  } as unknown as HerdrClientLike;
  const root = await mountWithClient(pi, client, {
    getSessionId: () => 'bbbb2222-3333-4444-8555-666666666666',
    deliverNotice: async (content: string) => { notices.push(content); },
  });
  try {
    const createdAt = Date.now() - 120_000;
    await fire(pi, 'session_start', {}, {
      sessionManager: {
        getBranch: () => branchOf({
          taskId: 'cccc3333-4444-4555-8666-777777777777', kind: 'task', paneId: 'pAlive', tabId: 't0', tabName: 'main',
          cwd, description: 'Fix bugs in isolated worktree', background: true, status: 'running',
          sessionFile: null, launchCommand: [], createdAt,
          // An already-elapsed observation window lets the recovered poller settle on its first tick.
          observationStartedAt: createdAt, revivedFrom: null,
        }),
      },
    });
    assert.ok(notices.some((n) => n.includes('settlement watch re-armed')), `missing recovery notice: ${JSON.stringify(notices)}`);
    const settle = notices.find((n) => n.includes('closing message'));
    assert.ok(settle, `missing settlement notice: ${JSON.stringify(notices)}`);
    assert.match(settle!, /RECOVERED_REPORT/);
    assert.equal(ledgerSnapshot(pi)!.subs.find((s) => s.paneId === 'pAlive')!.status, 'consumed');
  } finally {
    await root.fiber.dispose();
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
  }
});
