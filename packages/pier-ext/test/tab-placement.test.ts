/**
 * v1.3 M5 任务 tab 放置纯逻辑单测（D25/D26）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TAB_NAME_MAX,
  classifyWorktreeZone,
  foldSubsRegistry,
  nextTaskTabName,
  planTabPlacement,
  tabNameForTask,
} from '../src/subagent-core.ts';

test('tabNameForTask: 折叠空白 + 截断 ≤20 + 空 → task', () => {
  assert.equal(tabNameForTask('  网络调研   现状  '), '网络调研 现状');
  assert.equal(tabNameForTask('a'.repeat(30)), 'a'.repeat(TAB_NAME_MAX));
  assert.equal(tabNameForTask(''), 'task');
  assert.equal(tabNameForTask('   '), 'task');
});

test('nextTaskTabName: 无撞名原样；撞名 -2/-3；后缀保持总长 ≤20', () => {
  assert.equal(nextTaskTabName('调研', new Set(['spike'])), '调研');
  assert.equal(nextTaskTabName('调研', new Set(['调研'])), '调研-2');
  assert.equal(nextTaskTabName('调研', new Set(['调研', '调研-2'])), '调研-3');
  const long = 'a'.repeat(TAB_NAME_MAX);
  assert.equal(nextTaskTabName(long, new Set([long])), 'a'.repeat(TAB_NAME_MAX - 2) + '-2');
  assert.ok(nextTaskTabName(long, new Set([long])).length <= TAB_NAME_MAX);
});

test('planTabPlacement: 显式同名 tab 存在 → append 且带既有 tabId', () => {
  const plan = planTabPlacement({
    desiredTab: '调研',
    description: 'anything',
    knownTabs: [{ tabName: '调研', tabId: 'w1:t9' }, { tabName: 'spike', tabId: 'w1:t10' }],
  });
  assert.deepEqual(plan, { mode: 'append', tabName: '调研', tabId: 'w1:t9' });
});

test('planTabPlacement: 显式 tab 不存在 → new 同名', () => {
  const plan = planTabPlacement({
    desiredTab: '新任务',
    description: 'anything',
    knownTabs: [{ tabName: '调研', tabId: 'w1:t9' }],
  });
  assert.deepEqual(plan, { mode: 'new', tabName: '新任务', tabId: null });
});

test('planTabPlacement: 缺省（D86 zone=main）→ append 进 main tab', () => {
  const plan = planTabPlacement({
    desiredTab: undefined,
    description: '网络调研现状',
    knownTabs: [{ tabName: 'main', tabId: 'w1:t0' }],
    zone: { zone: 'main', tabName: null },
    mainTabId: 'w1:t0',
  });
  assert.deepEqual(plan, { mode: 'append', tabName: 'main', tabId: 'w1:t0' });
});

test('planTabPlacement: 缺省（D86 zone=worktree）→ join-or-create 目录名 tab', () => {
  const join = planTabPlacement({
    desiredTab: undefined,
    description: '修 bug#2',
    knownTabs: [{ tabName: 'hotfix-2', tabId: 'w1:t5' }],
    zone: { zone: 'worktree', tabName: 'hotfix-2' },
    mainTabId: 'w1:t0',
  });
  assert.deepEqual(join, { mode: 'append', tabName: 'hotfix-2', tabId: 'w1:t5' });

  const create = planTabPlacement({
    desiredTab: undefined,
    description: '修 bug#3',
    knownTabs: [{ tabName: 'hotfix-2', tabId: 'w1:t5' }],
    zone: { zone: 'worktree', tabName: 'hotfix-3' },
    mainTabId: 'w1:t0',
  });
  assert.deepEqual(create, { mode: 'new', tabName: 'hotfix-3', tabId: null });

  // 撞名（同 basename 不同父目录）→ 序号后缀
  const collide = planTabPlacement({
    desiredTab: undefined,
    description: '修 bug#4',
    knownTabs: [{ tabName: 'hotfix-3', tabId: 'w1:t6' }],
    zone: { zone: 'worktree', tabName: 'hotfix-3' },
    mainTabId: 'w1:t0',
  });
  assert.deepEqual(collide, { mode: 'append', tabName: 'hotfix-3', tabId: 'w1:t6' });
});

test('planTabPlacement: 显式空串/空白视为缺省（D86 zone 生效）', () => {
  const plan = planTabPlacement({
    desiredTab: '   ',
    description: 'local spike',
    knownTabs: [{ tabName: 'main', tabId: 'w1:t0' }],
    zone: { zone: 'main', tabName: null },
    mainTabId: 'w1:t0',
  });
  assert.deepEqual(plan, { mode: 'append', tabName: 'main', tabId: 'w1:t0' });
});

test('planTabPlacement: 无 zone 信息 → 旧 description 派生兜底（永远 new）', () => {
  const plan = planTabPlacement({
    desiredTab: undefined,
    description: '网络调研现状',
    knownTabs: [{ tabName: '网络调研现状', tabId: 'w1:t9' }],
  });
  assert.deepEqual(plan, { mode: 'new', tabName: '网络调研现状-2', tabId: null });
});

test('classifyWorktreeZone: 主检出→main；其他 worktree→目录名；非 git/无关→main 兜底', () => {
  const wts = ['F:/repo', 'F:/wt/hotfix-2', 'F:/wt/hotfix-3'];
  // cwd 在主检出内（master 也在）→ main
  assert.deepEqual(
    classifyWorktreeZone({ cwd: 'F:\\repo\\packages', masterCwd: 'F:/repo', worktrees: wts }),
    { zone: 'main', tabName: null },
  );
  // cwd 在 hotfix-2 worktree（master 不在）→ worktree tab = 目录名
  assert.deepEqual(
    classifyWorktreeZone({ cwd: 'F:\\wt\\hotfix-2\\src', masterCwd: 'F:/repo', worktrees: wts }),
    { zone: 'worktree', tabName: 'hotfix-2' },
  );
  // 大小写/斜杠不敏感
  assert.deepEqual(
    classifyWorktreeZone({ cwd: 'f:/WT/HOTFIX-3', masterCwd: 'F:/repo', worktrees: wts }),
    { zone: 'worktree', tabName: 'hotfix-3' },
  );
  // 非 git / 与列表无关 → main 兜底（同检出同 tab）
  assert.deepEqual(
    classifyWorktreeZone({ cwd: 'C:\\temp', masterCwd: 'F:/repo', worktrees: wts }),
    { zone: 'main', tabName: null },
  );
  // 前缀陷阱：/repo-x 不是 /repo 之下
  assert.deepEqual(
    classifyWorktreeZone({ cwd: 'F:/repo-x', masterCwd: 'F:/repo', worktrees: wts }),
    { zone: 'main', tabName: null },
  );
});

test('foldSubsRegistry: v3 条目带 tabName；旧条目缺省为空串', () => {
  const mk = (over: Record<string, unknown>) => ({
    taskId: 't1', kind: 'short', paneId: 'w1:p1', tabId: 'w1:t9', cwd: 'F:\\herdr-pi',
    description: 'task', background: true, status: 'running', sessionFile: null,
    launchCommand: ['x'], createdAt: 1, ...over,
  });
  const entries = [
    { type: 'custom', customType: 'pi-herdr.subs', data: { version: 2, subs: [mk({ paneId: 'w1:p1', tabName: '调研' })] } },
  ];
  const reg = foldSubsRegistry(entries as never);
  assert.equal(reg.subs[0].tabName, '调研');
  const legacy = foldSubsRegistry([
    { type: 'custom', customType: 'pi-herdr.subs', data: { version: 2, subs: [mk({ paneId: 'w1:p2' })] } },
  ] as never);
  assert.equal(legacy.subs[0].tabName, '');
});
