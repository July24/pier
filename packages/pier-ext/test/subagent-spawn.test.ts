/** Spawn domain: isolate/worktree planning, readiness failures, the spawn tool (piped prompt
 * injection, foreground/background settlement, rollback) and the injectable git adapter. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HerdrClientLike } from '../src/herdr-client.ts';
import { pipeNameFor, startPipeServer, type PipeRequest } from '../src/pipe-channel.ts';
import { appendHistory } from '../src/history-store.ts';
import { preferredHistoryFile } from '../src/storage-layout.ts';
import {
  buildIsolatePreamble, evaluateRelease, formatWorktreeStat, parseWorktreePorcelain, planIsolateWorktree, type SubagentPortBox,
} from '../src/subagent-core.ts';
import { NodeGitAdapter, createSpawner, type GitExecFile } from '../src/subagent-spawn.ts';
import {
  TempHome, jsonl, mountSubagent, runSubagent, runSubagentRejects, subsSnapshot, transcriptMessage, type FakePi,
} from './test-utils.ts';

/* ── isolate/worktree planning (pure) ──────────────────────────── */

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

const spawnerFor = (client: Record<string, unknown>, over: Record<string, unknown> = {}) => createSpawner({
  client: client as unknown as HerdrClientLike,
  env: { paneId: 'p0', tabId: 't0', workspaceId: 'w1' },
  runtime: { nodePath: '/usr/bin/node', cliPath: '/cli.js', extPath: '/ext.ts' },
  git: { listWorktrees: async () => [], runGit: async () => null, worktreeStatLine: async () => null, invalidateWorktreesCache: () => undefined },
  ...over,
} as Parameters<typeof createSpawner>[0]);

test('waitSubReady: gone pane, herdr diagnosis and an unknown shell are distinguished', async (t) => {
  await t.test('a gone pane fails fast with its last output instead of waiting out the timeout', async () => {
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

  await t.test('herdr detection diagnostics are attached to the failure', async () => {
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

  await t.test('an unknown shell is alive-but-not-ready, not pane-gone', async () => {
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
});

/* ── spawn tool: loopback pipe harness ──────────────────────────── */

const SUB_TEXT = 'REPORT: all channel-fee contact points mapped';
const PROMPT = '你在 apnv3-backend 仓库探查渠道费用触点（只读）。输出完整报告。';

interface PipeEnv {
  cwd: string;
  home: TempHome;
  pi: FakePi;
  port: SubagentPortBox;
  frames: PipeRequest[];
  closePaneCalls: string[];
  /** Uncancellable poll loop: park it on a `waitAgent` that never resolves so a row it holds stays
   * `running` for the rest of the test. */
  parkPollers(): void;
  /** Flipped per subtest: the next prompt frame is answered with an error. */
  rejectPrompt: boolean;
}

/** Mounts the plugin with a loopback pipe server standing in for the worker pane (p2): it records
 * the frames pier sends and answers ok, so the real `pipeRequestTo` path is exercised end to end. */
async function withPipeEnv(fn: (env: PipeEnv) => Promise<void>, opts: { childCwd?: string } = {}): Promise<void> {
  const home = new TempHome('pier-spawn-home-');
  const cwd = mkdtempSync(join(tmpdir(), 'pier-spawn-cwd-'));
  const sessionFile = join(cwd, 'sub-session.jsonl');
  let parked = false;
  const env: PipeEnv = {
    cwd, home, pi: undefined as never, port: undefined as never, frames: [], closePaneCalls: [],
    parkPollers: () => { parked = true; }, rejectPrompt: false,
  };
  const server = startPipeServer(pipeNameFor(opts.childCwd ?? cwd, 'p2'), async (req) => {
    const isPrompt = req.type === 'prompt' || req.type === 'follow_up';
    if (isPrompt) {
      env.frames.push(req);
      writeFileSync(sessionFile, jsonl(transcriptMessage('assistant', SUB_TEXT, Date.now())));
      if (env.rejectPrompt) return { type: 'error', id: req.id, message: 'sim rejected' };
    }
    return { type: 'ok', id: req.id };
  });
  const sockets = new Set<Socket>();
  server.on('connection', (sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
  });
  server.unref();
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { root, pi, port } = await mountSubagent({
    client: {
      tabList: async () => [{ tabId: 't0', workspaceId: 'w1', label: 'main', paneCount: 1, agentStatus: 'idle' }],
      listPanes: async () => [
        { paneId: 'p0', tabId: 't0', workspaceId: 'w1', agentStatus: 'working' },
        { paneId: 'p2', tabId: 't0', workspaceId: 'w1', agentStatus: 'idle' },
      ],
      waitAgent: async () => (parked ? new Promise<never>(() => {}) : 'idle'),
      getAgentSessionPath: async () => sessionFile,
      closePane: async (paneId) => { env.closePaneCalls.push(paneId); },
    },
  });
  env.pi = pi;
  env.port = port;
  try {
    await fn(env);
  } finally {
    await root.fiber.dispose();
    // Destroying the live connections first: a lingering client would keep close() pending forever.
    for (const sock of sockets) sock.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    home.dispose();
  }
}

test('spawn action: piped prompt injection, settlement and rollback', async (t) => {
  await withPipeEnv(async (env) => {
    await t.test('a foreground run injects the prompt once and settles with the closing text', async () => {
      const result = await runSubagent(env.pi, { description: '探查', prompt: PROMPT }, env.cwd);
      const text = result.content[0]!.text;
      assert.ok(!/failed to spawn/.test(text), `no spawn failure: ${text}`);
      assert.match(text, /REPORT: all channel-fee contact points mapped/);
      assert.equal(env.frames.length, 1, 'the prompt is injected exactly once');
      assert.equal((env.frames[0] as { text?: string }).text, PROMPT, 'the whole prompt reaches the worker');
      assert.equal((env.frames[0] as { push?: boolean }).push, false, 'a foreground run does not ask for a settlement push');
      assert.deepEqual(env.port.current?.listRunningSubs() ?? [], [], 'no ghost running row survives the foreground run');
    });

    await t.test('run_in_background returns immediately and keeps the row running', async () => {
      env.parkPollers();
      const result = await runSubagent(env.pi, { description: '后台探查', prompt: PROMPT, run_in_background: true }, env.cwd);
      assert.match(result.content[0]!.text, /^started subagent p2 \(task [0-9a-f-]+\)$/);
      assert.equal(result.details?.background, true);
      assert.equal(result.details?.paneId, 'p2');
      assert.equal((env.frames[1] as { push?: boolean }).push, true, 'a background run asks for the settlement push');
      const running = env.port.current?.listRunningSubs() ?? [];
      assert.deepEqual(running.map((s) => s.paneId), ['p2']);
      assert.equal(running[0]!.description, '后台探查');
    });

    await t.test('a rejected prompt injection rolls back the ledger and closes the pane', async () => {
      env.rejectPrompt = true;
      const text = (await runSubagent(env.pi, { description: '探查', prompt: PROMPT }, env.cwd)).content[0]!.text;
      assert.match(text, /failed to spawn/);
      assert.match(text, /sim rejected/);
      assert.deepEqual(env.closePaneCalls, ['p2'], 'the failed pane is closed');
      assert.ok(!(env.port.current?.listRunningSubs() ?? []).some((s) => s.paneId === 'p2'), 'no ghost running row in the ledger');
      assert.ok(!subsSnapshot(env.pi)?.subs.some((s) => s.paneId === 'p2'), 'the final snapshot no longer lists the pane');
    });
  });
});

test('spawn/send: the reply pipe is scoped by the master session cwd, not the worker cwd', async () => {
  const other = mkdtempSync(join(tmpdir(), 'pier-spawn-other-'));
  await withPipeEnv(async (env) => {
    env.parkPollers();
    const spawned = await runSubagent(env.pi, { description: '跨仓库任务', prompt: PROMPT, run_in_background: true, cwd: other }, env.cwd);
    assert.match(spawned.content[0]!.text, /^started subagent p2 /);
    const expected = pipeNameFor(env.cwd, 'p0');
    assert.equal((env.frames[0] as { from?: string }).from, expected, 'spawn replies to the master session pipe');
    assert.notEqual((env.frames[0] as { from?: string }).from, pipeNameFor(other, 'p0'));

    const sent = await runSubagent(env.pi, { action: 'send', agentId: 'p2', message: 'wrap up and report' }, env.cwd);
    assert.match(sent.content[0]!.text, /Message sent to subagent p2/);
    assert.equal((env.frames[1] as { from?: string }).from, expected, 'follow_up replies to the same master pipe');
  }, { childCwd: other });
});

test('send/resume: short prefixes resolve at four characters and report ambiguity or misses', async () => {
  await withPipeEnv(async (env) => {
    env.parkPollers();
    const spawned = await runSubagent(env.pi, { description: '后台任务', prompt: PROMPT, run_in_background: true }, env.cwd);
    const fullTaskId = spawned.details?.taskId as string;
    assert.ok(typeof fullTaskId === 'string' && fullTaskId.length >= 8);
    const short8 = fullTaskId.slice(0, 8);
    const short4 = fullTaskId.slice(0, 4);

    const sent8 = await runSubagent(env.pi, { action: 'send', agentId: short8, message: '8-char prefix message' }, env.cwd);
    assert.match(sent8.content[0]!.text, /Message sent to subagent p2/);
    assert.equal((env.frames[1] as { text?: string }).text, '8-char prefix message');

    await runSubagent(env.pi, { action: 'send', agentId: short4, message: '4-char prefix message' }, env.cwd);
    assert.equal(env.frames.length, 3);

    assert.match(await runSubagentRejects(env.pi, { action: 'send', agentId: fullTaskId.slice(0, 3), message: 'x' }, env.cwd), /too short \(minimum 4 characters\)/);
    assert.match(await runSubagentRejects(env.pi, { action: 'send', agentId: '00000000', message: 'x' }, env.cwd), /unknown subagent id "00000000"/);

    const live = await runSubagent(env.pi, { action: 'resume', taskId: short8 }, env.cwd);
    assert.match(live.content[0]!.text, /already running as pane/);
    assert.equal(live.details?.taskId, fullTaskId);
    env.port.current?.consumeReply('p2', 'done');
    const resumed = await runSubagent(env.pi, { action: 'resume', taskId: short8 }, env.cwd);
    assert.match(resumed.content[0]!.text, /resumed subagent/);
    assert.equal(resumed.details?.taskId, fullTaskId, 'resume reports the full taskId');
    assert.match(await runSubagentRejects(env.pi, { action: 'resume', taskId: fullTaskId.slice(0, 3) }, env.cwd), /too short \(minimum 4 characters\)/);
    assert.match(await runSubagentRejects(env.pi, { action: 'resume', taskId: 'ffffffff' }, env.cwd), /no history for task "ffffffff"/);

    // A second generation sharing the prefix makes the four-character prefix ambiguous.
    const ambiguousTaskId = `${short4}9999-0000-1111-2222-333344445555`;
    appendHistory(preferredHistoryFile(env.home.path, env.cwd), {
      taskId: ambiguousTaskId, kind: 'task', paneId: 'p3', tabId: 't0', workspaceId: 'w1', cwd: env.cwd,
      description: '歧义冲突任务', sessionFile: null, launchCommand: ['node', 'cli.js'],
      status: 'settled', createdAt: Date.now() + 10,
    });
    env.port.current?.consumeReply(String(resumed.details?.paneId), 'done');
    const ambiguous = await runSubagentRejects(env.pi, { action: 'resume', taskId: short4 }, env.cwd);
    assert.match(ambiguous, /ambiguous task id/);
    assert.match(ambiguous, new RegExp(fullTaskId));
    assert.match(ambiguous, new RegExp(ambiguousTaskId));
  });
});

test('resume: a task spawned into another checkout is found after it is consumed', async () => {
  const other = mkdtempSync(join(tmpdir(), 'pier-resume-other-'));
  await withPipeEnv(async (env) => {
    env.parkPollers();
    const spawned = await runSubagent(env.pi, {
      description: '跨仓库任务', prompt: PROMPT, run_in_background: true, cwd: other,
    }, env.cwd);
    const taskId = spawned.details?.taskId as string;
    const paneId = spawned.details?.paneId as string;
    assert.match(await runSubagent(env.pi, { action: 'resume', taskId }, env.cwd).then((r) => r.content[0]!.text), /already running as pane/);
    env.port.current?.consumeReply(paneId, 'done');
    const resumed = await runSubagent(env.pi, { action: 'resume', taskId }, env.cwd);
    assert.match(resumed.content[0]!.text, /resumed subagent/);
    assert.equal(resumed.details?.taskId, taskId);
    const row = subsSnapshot(env.pi)?.subs.find((s) => s.taskId === taskId);
    assert.equal(row?.cwd, other, 'revive keeps the checkout the task was spawned into');
  }, { childCwd: other });
});

/* ── isolate at the tool surface ────────────────────────────────── */

test('isolate: mutually exclusive with cwd, and outside a git repo it fails instead of degrading', async () => {
  const { root, pi } = await mountSubagent({ client: { available: true } });
  try {
    assert.match(
      await runSubagentRejects(pi, { description: 'x', prompt: 'do x', isolate: true, cwd: 'F:/somewhere' }, process.cwd()),
      /`isolate` and `cwd` are mutually exclusive — isolate creates a new worktree, cwd delegates into an existing one/,
    );
    const nonGit = mkdtempSync(join(tmpdir(), 'd98-nogit-'));
    assert.match(
      await runSubagentRejects(pi, { description: 'x', prompt: 'do x', isolate: true }, nonGit),
      /isolate requires a git repository with at least one commit/,
    );
  } finally {
    await root.fiber.dispose();
  }
});

test('isolate: an invalid role fails before any worktree or pier/ branch is created', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'd98-badrole-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  const { root, pi } = await mountSubagent({ client: { available: true } });
  try {
    assert.match(
      await runSubagentRejects(pi, { description: 'x', prompt: 'do x', isolate: true, role: 'no-such-role' }, repo),
      /role "no-such-role" manifest invalid/,
    );
    assert.equal(git('worktree', 'list', '--porcelain').match(/^worktree /gm)?.length, 1, 'no isolate worktree was added');
    assert.equal(git('for-each-ref', 'refs/heads/pier/').trim(), '', 'no pier/ branch was left behind');
  } finally {
    await root.fiber.dispose();
    rmSync(repo, { recursive: true, force: true });
  }
});

/* ── git adapter (folded from git-adapter.test.ts) ──────────────── */

test('run: prefixes git -C cwd, forwards the timeout, and the wrappers build their own argv', async () => {
  const calls: Array<{ file: string; args: readonly string[]; timeout: number }> = [];
  const exec: GitExecFile = async (file, args, opts) => {
    calls.push({ file, args, timeout: opts.timeout });
    return { stdout: 'ok\n', stderr: '' };
  };
  const result = await new NodeGitAdapter('git', 1234, exec).run('/repo', ['rev-parse', 'HEAD']);
  assert.equal(result.stdout, 'ok\n');
  assert.deepEqual(calls, [{ file: 'git', args: ['-C', '/repo', 'rev-parse', 'HEAD'], timeout: 1234 }]);

  const seen: string[][] = [];
  const git = new NodeGitAdapter('git', 1000, async (_file, args) => { seen.push([...args]); return { stdout: 'out', stderr: '' }; });
  await git.listWorktrees('/wt');
  await git.status('/wt');
  assert.deepEqual(seen[0], ['-C', '/wt', 'worktree', 'list', '--porcelain']);
  assert.deepEqual(seen[1], ['-C', '/wt', 'status', '--short']);
});

const GIT_FAILURES: Array<{ name: string; args: string[]; thrown: () => unknown; expected: RegExp }> = [
  { name: 'Error carrying a code', args: ['status', '--porcelain'], thrown: () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' }), expected: /^Git status failed: ENOENT/ },
  { name: 'non-Error throw', args: ['diff'], thrown: () => 'boom', expected: /^Git diff failed: boom$/ },
];

test('run: every failure becomes a GitError naming the operation', async () => {
  for (const c of GIT_FAILURES) {
    const exec: GitExecFile = async () => { throw c.thrown(); };
    await assert.rejects(
      () => new NodeGitAdapter('git', 1000, exec).run('/repo', c.args),
      (err: Error) => {
        assert.match(err.message, c.expected, c.name);
        return true;
      },
    );
  }
});
