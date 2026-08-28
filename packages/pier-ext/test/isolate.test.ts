/**
 * D98 worktree 隔离写并行（isolate）：
 *  - 纯函数：planIsolateWorktree / buildIsolatePreamble / formatWorktreeStat / evaluateRelease；
 *  - 工具面：isolate×cwd 互斥文案、非 git 目录 isolate 显式失败（真 runGit 子进程）；
 *  - 注册表折叠：SubEntry.isolate 字段持久化往返。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import {
  buildIsolatePreamble,
  evaluateRelease,
  foldSubsRegistry,
  formatWorktreeStat,
  parseWorktreePorcelain,
  planIsolateWorktree,
  SUBS_CUSTOM_TYPE,
  type SubEntry,
} from '../src/subagent-core.ts';
import subagentPlugin from '../src/core/subagent.ts';
import { PiSurface } from '../src/pi-surface.ts';
import { TodosService } from '../src/todos-service.ts';
import type { HerdrClientLike } from '../src/herdr-client.ts';

/* ── planIsolateWorktree ─────────────────────────────────────────── */

test('planIsolateWorktree：ascii-fold + 撞名加序号 + dirName 前缀', () => {
  const base = planIsolateWorktree({ description: 'Fix Auth Flow!', taskHex: 'a1b2c3', existingPierBranches: new Set() });
  assert.equal(base.slug, 'fix-auth-flow');
  assert.equal(base.branch, 'pier/fix-auth-flow');
  assert.equal(base.worktreeDirName, 'pier-fix-auth-flow');

  const again = planIsolateWorktree({ description: 'Fix Auth Flow!', taskHex: 'a1b2c3', existingPierBranches: new Set(['fix-auth-flow']) });
  assert.equal(again.slug, 'fix-auth-flow-2');
  assert.equal(again.branch, 'pier/fix-auth-flow-2');

  const third = planIsolateWorktree({
    description: 'Fix Auth Flow!',
    taskHex: 'a1b2c3',
    existingPierBranches: new Set(['fix-auth-flow', 'fix-auth-flow-2']),
  });
  assert.equal(third.slug, 'fix-auth-flow-3');
});

test('planIsolateWorktree：纯非 ascii 描述 → task-<taskHex>', () => {
  const p = planIsolateWorktree({ description: '纯中文描述', taskHex: 'deadbe', existingPierBranches: new Set() });
  assert.equal(p.slug, 'task-deadbe');
  assert.equal(p.branch, 'pier/task-deadbe');
  assert.equal(p.worktreeDirName, 'pier-task-deadbe');
  // task-hex 撞名同样加序号
  const q = planIsolateWorktree({ description: '另一个', taskHex: 'deadbe', existingPierBranches: new Set(['task-deadbe']) });
  assert.equal(q.slug, 'task-deadbe-2');
});

/* ── buildIsolatePreamble ────────────────────────────────────────── */

test('buildIsolatePreamble：含路径/分支/base 字面量 + NEVER push 纪律', () => {
  const text = buildIsolatePreamble({ worktreePath: 'C:/wt/pier-x', branch: 'pier/x', baseShort: 'abc1234' });
  assert.match(text, /C:\/wt\/pier-x/);
  assert.match(text, /branch pier\/x/);
  assert.match(text, /base abc1234/);
  assert.match(text, /NEVER push/);
  assert.match(text, /git add -A && git commit/);
  assert.match(text, /Do not touch the main checkout/);
});

/* ── formatWorktreeStat ──────────────────────────────────────────── */

test('formatWorktreeStat：isolate 行矩阵', () => {
  const full = formatWorktreeStat({ branch: 'pier/x', commits: 2, statLine: '3 files changed, 10 insertions(+)', dirtyCount: 0 });
  assert.equal(full, 'Worktree pier/x: 2 commit(s) since base; 3 files changed, 10 insertions(+); uncommitted: 0 file(s)');

  const dirty = formatWorktreeStat({ branch: 'pier/x', commits: 1, statLine: '1 file changed', dirtyCount: 2 });
  assert.match(dirty, /uncommitted: 2 file\(s\) \(worker should have committed\)/);

  // 任一输入缺失 → null（静默省略）
  assert.equal(formatWorktreeStat({ branch: 'pier/x', commits: null, statLine: 'x', dirtyCount: 0 }), null);
  assert.equal(formatWorktreeStat({ branch: 'pier/x', commits: 1, statLine: null, dirtyCount: 0 }), null);
  assert.equal(formatWorktreeStat({ branch: 'pier/x', commits: 1, statLine: 'x', dirtyCount: null }), null);
});

test('formatWorktreeStat：非 isolate（branch=null）小件轻量行', () => {
  const line = formatWorktreeStat({ branch: null, commits: null, statLine: '2 files changed, 5 insertions(+)', dirtyCount: 3 });
  assert.equal(line, 'git: 2 files changed, 5 insertions(+); uncommitted: 3 file(s)');
  assert.equal(formatWorktreeStat({ branch: null, commits: null, statLine: null, dirtyCount: 0 }), null);
  assert.equal(formatWorktreeStat({ branch: null, commits: null, statLine: 'x', dirtyCount: null }), null);
});

/* ── evaluateRelease ─────────────────────────────────────────────── */

test('evaluateRelease：merged+clean → release；其余 retain 通道矩阵', () => {
  assert.deepEqual(evaluateRelease({ merged: true, dirtyCount: 0 }), { action: 'release' });
  assert.deepEqual(evaluateRelease({ merged: false, dirtyCount: 0 }), { action: 'retain', reason: 'unmerged' });
  assert.deepEqual(evaluateRelease({ merged: true, dirtyCount: 4 }), { action: 'retain', reason: 'dirty' });
  assert.deepEqual(evaluateRelease({ merged: null, dirtyCount: 0 }), { action: 'retain', reason: 'unknown' });
  assert.deepEqual(evaluateRelease({ merged: true, dirtyCount: null }), { action: 'retain', reason: 'unknown' });
});

/* ── 注册表折叠：isolate 字段往返 ─────────────────────────────────── */

test('foldSubsRegistry：isolate 字段持久化往返（缺字段补默认）', () => {
  const entry: SubEntry = {
    taskId: 't1', kind: 'task', paneId: 'p1', tabId: 'tab1', tabName: 'pier-x', cwd: 'C:/wt/pier-x',
    description: 'x', background: true, status: 'settled', consumedAt: null, sessionFile: null,
    launchCommand: [], createdAt: 1, revivedFrom: null,
    isolate: { worktreePath: 'C:/wt/pier-x', branch: 'pier/x', baseSha: 'abc', releasedAt: null, retainNotified: false },
  };
  const folded = foldSubsRegistry([{ type: 'custom', customType: SUBS_CUSTOM_TYPE, data: { subs: [entry] } }]);
  assert.equal(folded.subs.length, 1);
  assert.deepEqual(folded.subs[0]!.isolate, entry.isolate);

  // 形状不完整的 isolate → undefined（不炸）
  const partial = foldSubsRegistry([{ type: 'custom', customType: SUBS_CUSTOM_TYPE, data: { subs: [{ ...entry, isolate: { branch: 'pier/y' } }] } }]);
  assert.equal(partial.subs[0]!.isolate, undefined);
});

/* ── 工具面：互斥与非 git 显式失败（真插件挂载） ─────────────────── */

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
    tools: new Map<string, { execute?: (...a: unknown[]) => unknown }>(),
    listeners: new Map<string, Array<(...a: unknown[]) => unknown>>(),
    entries: [] as Array<[string, unknown]>,
    registerTool(def: { name: string; execute?: (...a: unknown[]) => unknown }) {
      this.tools.set(def.name, def);
    },
    on(event: string, handler: (...a: unknown[]) => unknown) {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), handler]);
    },
    appendEntry(customType: string, data: unknown) {
      this.entries.push([customType, data]);
    },
  };
}

function fakeClient(): HerdrClientLike {
  return {
    available: true,
    tabList: async () => [],
    listPanes: async () => [],
    listAgents: async () => [],
    waitAgent: async () => null,
    getAgentSessionPath: async () => null,
    createTab: async () => ({ tabId: 't1', paneId: 'p1' }),
    splitPane: async () => 'p2',
    sendPaneText: async () => undefined,
    tabClose: async () => undefined,
    closePane: async () => undefined,
  } as unknown as HerdrClientLike;
}

async function mount(pi: FakePi): Promise<Context> {
  const surface = new PiSurface(pi as unknown as object);
  const slots = { applyReplySession: null, reconcileOnReply: null, listRunningSubs: null, settleStatLine: null };
  const root = new Context();
  const deps = {
    client: fakeClient(),
    env: { paneId: 'p0', tabId: 't0', workspaceId: 'w1' },
    extPath: 'F:/repo/pier/packages/pier-ext/src/index.ts',
    sessionRoot: root,
    slots,
    getSessionId: () => '',
    getBlockedDepth: () => 0,
    reconcileOnSettlement: () => [],
    withReconcileNotes: (b: string) => b,
    claimSettleNotice: () => true,
    terminalState: { activePaneIds: () => new Set<string>() },
    todos: new TodosService({ strict: false, allowParallelInProgress: true }),
  };
  root.provide('pi-herdr.surface', surface);
  root.provide('pi-herdr.subagent-deps', deps);
  await root.plugin(subagentPlugin);
  return root;
}

async function runSubagent(pi: FakePi, params: Record<string, unknown>, cwd?: string): Promise<string> {
  const r = await pi.tools.get('subagent')?.execute?.('tc1', params, undefined, undefined, { cwd: cwd ?? process.cwd() }) as { content: Array<{ text: string }> };
  return r.content[0]!.text;
}

test('subagent 工具：isolate×cwd 互斥显式报错', async () => {
  const pi = fakePi();
  const root = await mount(pi);
  try {
    const text = await runSubagent(pi, {
      description: 'x', prompt: 'do x', isolate: true, cwd: 'F:/somewhere',
    });
    assert.match(text, /Error: `isolate` and `cwd` are mutually exclusive — isolate creates a new worktree, cwd delegates into an existing one/);
  } finally {
    await root.fiber.dispose();
  }
});

test('subagent 工具：isolate 在非 git 目录显式失败（不降级共享检出）', async () => {
  const pi = fakePi();
  const root = await mount(pi);
  try {
    const nonGit = mkdtempSync(join(tmpdir(), 'd98-nogit-'));
    const text = await runSubagent(pi, { description: 'x', prompt: 'do x', isolate: true }, nonGit);
    assert.match(text, /Error: isolate requires a git repository with at least one commit/);
  } finally {
    await root.fiber.dispose();
  }
});

/* ── parseWorktreePorcelain：跨平台矩阵 ──────────────────────────── */

test('parseWorktreePorcelain：POSIX 路径 + refs/heads/ 剥离 + 多块配对', () => {
  const out = [
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
  ].join('\n');
  const m = parseWorktreePorcelain(out);
  assert.equal(m.size, 3);
  assert.equal(m.get('master'), '/home/dev/proj');
  assert.equal(m.get('pier/fix-auth'), '/home/dev/.herdr/worktrees/proj/pier-fix-auth');
  assert.equal(m.get('feature/x'), '/Users/Shared/proj2');
});

test('parseWorktreePorcelain：Windows git 输出（正斜杠 + CRLF）', () => {
  const out = [
    'worktree F:/herdr-pi',
    'HEAD 1234567890abcdef',
    'branch refs/heads/master',
    '',
    'worktree C:/Users/Some Name/.herdr/worktrees/herdr-pi/pier-d98-iso-x',
    'branch refs/heads/pier/d98-iso-x',
    '',
  ].join('\r\n');
  const m = parseWorktreePorcelain(out);
  assert.equal(m.size, 2);
  assert.equal(m.get('master'), 'F:/herdr-pi');
  assert.equal(m.get('pier/d98-iso-x'), 'C:/Users/Some Name/.herdr/worktrees/herdr-pi/pier-d98-iso-x');
});

test('parseWorktreePorcelain：detached HEAD 块（无 branch 行）与 bare 行忽略', () => {
  const out = [
    'worktree /repo',
    'HEAD abc',
    'branch refs/heads/main',
    '',
    'worktree /tmp/detached-wt',
    'HEAD def',
    'detached',
    '',
    'worktree /tmp/bare-repo.git',
    'bare',
    '',
    'worktree /tmp/orphan-block', // branch 行缺失（畸形块）→ 不入表
    '',
  ].join('\n');
  const m = parseWorktreePorcelain(out);
  assert.equal(m.size, 1);
  assert.equal(m.get('main'), '/repo');
  assert.ok(!m.has('detached-wt'));
});
