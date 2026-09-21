/**
 * 路径布局合并测试：storage-layout（会话目录编码 + 双读迁移）与 platform-paths（平台数据/工作树目录）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import {
  historyFilePath,
  historyFilePathLegacy,
  preferredHistoryFile,
  piCoreSessionDirName,
  piSessionDirCandidates,
  preferredSessionDir,
  sessionDirCandidates,
  sessionDirName,
  sessionDirNameLegacy,
  userRolesDir,
  workspaceRolesDir,
} from '../src/storage-layout.ts';
import { createPlatformPaths, platformPaths } from '../src/platform-paths.ts';

/* ── storage-layout ─────────────────────────────────────────────────────── */

test('sessionDirName: percent-encodes separators so a/b ≠ a-b', () => {
  assert.equal(sessionDirName('a/b'), '--a%2Fb--');
  assert.equal(sessionDirName('a-b'), '--a-b--');
  assert.notEqual(sessionDirName('a/b'), sessionDirName('a-b'));
  assert.equal(sessionDirName('F:\\herdr-pi'), '--F%3A%5Cherdr-pi--');
  assert.equal(sessionDirName('/home/u/proj'), '--%2Fhome%2Fu%2Fproj--');
  assert.equal(sessionDirName('a%b/c'), '--a%25b%2Fc--');
});

test('sessionDirNameLegacy: old flattening kept for dual-read', () => {
  assert.equal(sessionDirNameLegacy('F:\\herdr-pi'), '--F--herdr-pi--');
  assert.equal(sessionDirNameLegacy('/home/u/proj'), '---home-u-proj--');
  assert.equal(sessionDirNameLegacy('a/b'), sessionDirNameLegacy('a-b'));
});

test('sessionDirCandidates: new encoding first, then legacy', () => {
  assert.deepEqual(sessionDirCandidates('F:\\herdr-pi'), ['--F%3A%5Cherdr-pi--', '--F--herdr-pi--']);
});

test('historyFilePath: canonical write path uses new encoding', () => {
  assert.equal(
    historyFilePath('C:\\home\\.pi\\agent', 'F:\\herdr-pi'),
    join('C:\\home\\.pi\\agent', 'herdr-pi', 'history', '--F%3A%5Cherdr-pi--', 'history.jsonl'),
  );
});

test('preferredHistoryFile: existing legacy ledger wins over missing new dir', () => {
  const root = mkdtempSync(join(tmpdir(), 'pier-hist-mig-'));
  try {
    const cwd = 'F:\\herdr-pi';
    assert.equal(preferredHistoryFile(root, cwd), historyFilePath(root, cwd));
    const legacy = historyFilePathLegacy(root, cwd);
    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(legacy, '{}\n');
    assert.equal(preferredHistoryFile(root, cwd), legacy);
    const next = historyFilePath(root, cwd);
    mkdirSync(dirname(next), { recursive: true });
    writeFileSync(next, '{}\n');
    assert.equal(preferredHistoryFile(root, cwd), next);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('preferredSessionDir: missing both → new encoding', () => {
  const parent = join(tmpdir(), 'pier-no-such-session-parent');
  assert.equal(preferredSessionDir(parent, 'a/b'), join(parent, '--a%2Fb--'));
});

test('role dirs: user-global uses the legacy agent layout, workspace is per-project', () => {
  assert.equal(userRolesDir(), join(homedir(), '.pi', 'agent', 'herdr-pi', 'roles'));
  assert.equal(workspaceRolesDir('/repo'), join('/repo', '.pi-herdr', 'roles'));
});

test('piCoreSessionDirName: 与 pi core 逐字节一致（剥离一个前导分隔符、不转义 %）', () => {
  // pi core（dist/migrations.js:102）: `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
  assert.equal(piCoreSessionDirName('/Users/yehaoyu/Documents/pier'), '--Users-yehaoyu-Documents-pier--');
  // Windows：盘符前没有分隔符，等价于 pier 的 legacy 形态
  assert.equal(piCoreSessionDirName('F:\\herdr-pi'), '--F--herdr-pi--');
  // `%` 不转义（这正是旧实现 POSIX 全落空的原因：pier 新版编成了 %2F）
  assert.equal(piCoreSessionDirName('/a%2Fb'), '--a%2Fb--');
  assert.notEqual(piCoreSessionDirName('/home/u/proj'), sessionDirName('/home/u/proj'));
  assert.notEqual(piCoreSessionDirName('/home/u/proj'), sessionDirNameLegacy('/home/u/proj'));
});

test('piSessionDirCandidates: pi core 名在前，pier 旧编码兜底且去重', () => {
  assert.deepEqual(piSessionDirCandidates('/home/u/proj'), [
    '--home-u-proj--',
    '--%2Fhome%2Fu%2Fproj--',
    '---home-u-proj--',
  ]);
  // Windows 上 pi core 名与 legacy 相同 → 不重复
  assert.deepEqual(piSessionDirCandidates('F:\\herdr-pi'), ['--F--herdr-pi--', '--F%3A%5Cherdr-pi--']);
});

/* ── platform-paths ─────────────────────────────────────────────────────── */

test('createPlatformPaths: overrides win; sessionsDir defaults under agentDataDir', () => {
  const p = createPlatformPaths({ agentDataDir: '/x/agent', worktreeBaseDir: '/x/wt' });
  assert.equal(p.agentDataDir, '/x/agent');
  assert.equal(p.worktreeBaseDir, '/x/wt');
  assert.equal(p.sessionsDir, join('/x/agent', 'sessions'));
  assert.equal(createPlatformPaths({ agentDataDir: '/x/agent', sessionsDir: '/custom/sessions' }).sessionsDir, '/custom/sessions');
});

test('platformPaths singleton: required dirs are absolute-ish non-empty', () => {
  assert.ok(platformPaths.agentDataDir.length > 0);
  assert.ok(platformPaths.worktreeBaseDir.length > 0);
  assert.ok(platformPaths.sessionsDir.length > 0);
  assert.equal(platformPaths.sessionsDir, join(platformPaths.agentDataDir, 'sessions'));
});
