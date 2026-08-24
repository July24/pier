/**
 * M18：文件级写锁（S2：默认软 veto；PI_HERDR_WRITE_LOCK=1 硬启）。
 * 缝：normalizeLockPath / fnv1a64 / token 编解码 / findLockConflict / planWriteGuard。
 * token 契约（schema 实测）：键 ^[A-Za-z0-9_-]{1,32}$、每报 ≤16 键 → 键=哈希、值=paneId|path。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCK_BATCH_LIMIT,
  LOCK_TOKEN_PREFIX,
  WRITE_LOCK_ENV,
  WRITE_TOOLS,
  acquireTokensFor,
  findLockConflict,
  fnv1a64,
  formatConflictWarning,
  isLockTokenKey,
  lockTokenKey,
  lockTokenValue,
  normalizeLockPath,
  parseLockTokenValue,
  planWriteGuard,
  releaseTokensFor,
  writePathsOfTool,
  type LockAgentView,
} from '../src/lock-core.ts';

// 平台参数化：CWD 与锁定文件按平台取原生形态（异平台路径在本平台 resolve 会当相对路径）
const CWD = process.platform === 'win32' ? 'F:\\proj' : '/proj';
/** 锁定文件 a.cs（位于 CWD 下）的归一形态。 */
const LOCKED = process.platform === 'win32' ? 'f:/proj/a.cs' : '/proj/a.cs';
/** 同一文件的原始抖动形态（大小写/分隔符），验证归一后才匹配 token。 */
const LOCKED_ALT = process.platform === 'win32' ? 'F:\\Proj\\A.CS' : '/Proj/A.CS';

function agent(paneId: string, locks: Record<string, string>): LockAgentView {
  const tokens: Record<string, string | null> = {};
  for (const [p, holder] of Object.entries(locks)) tokens[lockTokenKey(p)] = lockTokenValue(p, holder);
  return { paneId, tokens };
}

/* ── 路径归一（Windows 大小写/分隔符/相对路径） ────────────────── */

test('normalizeLockPath：分隔符统一、小写、相对→绝对、去尾斜杠', () => {
  if (process.platform === 'win32') {
    assert.equal(normalizeLockPath('F:\\A\\B.cs', CWD), 'f:/a/b.cs');
    assert.equal(normalizeLockPath('f:/a/b.cs', CWD), 'f:/a/b.cs');
    assert.equal(normalizeLockPath('src/x.ts', CWD), 'f:/proj/src/x.ts');
    assert.equal(normalizeLockPath('f:/a/', CWD), 'f:/a');
    assert.equal(
      normalizeLockPath('F:\\A\\..\\A\\B.cs', CWD),
      normalizeLockPath('F:\\A\\B.cs', CWD),
    );
  } else {
    assert.equal(normalizeLockPath('/A/B.cs', CWD), '/a/b.cs');
    assert.equal(normalizeLockPath('src/x.ts', CWD), '/proj/src/x.ts');
    assert.equal(normalizeLockPath('/a/', CWD), '/a');
    assert.equal(
      normalizeLockPath('/A/../A/B.cs', CWD),
      normalizeLockPath('/A/B.cs', CWD),
    );
  }
});

/* ── token 编解码（schema：键无点/冒号/斜杠 → 哈希键 + 值带路径） ─ */

test('fnv1a64：稳定、16 hex、不同输入不同值', () => {
  assert.equal(fnv1a64('f:/a.cs'), fnv1a64('f:/a.cs'));
  assert.match(fnv1a64('f:/a.cs'), /^[0-9a-f]{16}$/);
  assert.notEqual(fnv1a64('f:/a.cs'), fnv1a64('f:/b.cs'));
});

test('lockTokenKey 匹配 schema 模式 ^[A-Za-z0-9_-]{1,32}$；isLockTokenKey 判命名空间', () => {
  const key = lockTokenKey('f:/some/long/path/to/a file.cs');
  assert.match(key, /^[A-Za-z0-9_-]{1,32}$/);
  assert.ok(key.startsWith(LOCK_TOKEN_PREFIX));
  assert.equal(isLockTokenKey(key), true);
  assert.equal(isLockTokenKey('pi-herdr-meta'), false);
  assert.equal(isLockTokenKey(LOCK_TOKEN_PREFIX), false);
  assert.equal(LOCK_BATCH_LIMIT, 16);
});

test('lockTokenValue / parseLockTokenValue 往返；畸形值 → null', () => {
  const v = lockTokenValue('f:/a.cs', 'w6:p9Q');
  const p = parseLockTokenValue(v);
  assert.deepEqual(p, { holderPaneId: 'w6:p9Q', path: 'f:/a.cs' });
  assert.equal(parseLockTokenValue('no-separator'), null);
  assert.equal(parseLockTokenValue('|lead'), null);
  assert.equal(parseLockTokenValue('trail|'), null);
});

/* ── 工具路径提取（write/edit 才参与） ─────────────────────────── */

test('writePathsOfTool：write/edit 取 path；其余工具空', () => {
  assert.equal(WRITE_TOOLS.includes('write') && WRITE_TOOLS.includes('edit'), true);
  assert.deepEqual(writePathsOfTool('write', { path: 'F:/a.cs', content: 'x' }), ['F:/a.cs']);
  assert.deepEqual(writePathsOfTool('edit', { path: 'F:/a.cs', edits: [] }), ['F:/a.cs']);
  assert.deepEqual(writePathsOfTool('bash', { command: 'rm x' }), []);
  assert.deepEqual(writePathsOfTool('read', { path: 'F:/a.cs' }), []);
  assert.deepEqual(writePathsOfTool('write', {}), []);
});

/* ── 冲突判定（异 pane 持有；同 pane 重入放行；null 清除不算） ── */

test('findLockConflict：异 pane 持有 → holder；自己/无锁/null → null', () => {
  const agents = [
    agent('pA', { 'f:/a.cs': 'pA' }),
    agent('pB', { 'f:/b.cs': 'pB' }),
  ];
  agents[1].tokens[lockTokenKey('f:/c.cs')] = null; // 已清除
  assert.deepEqual(findLockConflict(agents, 'pB', 'f:/a.cs'), { holderPaneId: 'pA' });
  assert.equal(findLockConflict(agents, 'pA', 'f:/a.cs'), null); // 重入放行
  assert.equal(findLockConflict(agents, 'pB', 'f:/b.cs'), null); // 自己
  assert.equal(findLockConflict(agents, 'pB', 'f:/c.cs'), null); // null
  assert.equal(findLockConflict(agents, 'pB', 'f:/nope.cs'), null);
});

/* ── 决策（skip/pass/warn/block） ─────────────────────────────── */

test('planWriteGuard：非写工具 skip；无冲突 pass；同 pane 重入 pass', () => {
  const agents = [agent('pA', { [LOCKED]: 'pA' })];
  assert.equal(planWriteGuard({ toolName: 'read', input: { path: 'a.cs' }, agents, ownPaneId: 'pB', cwd: CWD, hard: true }).kind, 'skip');
  assert.equal(planWriteGuard({ toolName: 'write', input: { path: 'other.cs', content: '' }, agents, ownPaneId: 'pB', cwd: CWD, hard: true }).kind, 'pass');
  assert.equal(planWriteGuard({ toolName: 'write', input: { path: 'a.cs', content: '' }, agents, ownPaneId: 'pA', cwd: CWD, hard: true }).kind, 'pass');
});

test('planWriteGuard：软模式（默认）→ warn（归一路径匹配，工具放行）', () => {
  const agents = [agent('pA', { [LOCKED]: 'pA' })];
  const g = planWriteGuard({ toolName: 'write', input: { path: LOCKED_ALT, content: '' }, agents, ownPaneId: 'pB', cwd: CWD, hard: false });
  assert.equal(g.kind, 'warn');
  if (g.kind !== 'warn') return;
  assert.equal(g.holderPaneId, 'pA');
  assert.match(g.warning, /pA/);
  assert.match(g.warning, /a\.cs/i);
  assert.deepEqual(g.paths, [LOCKED]);
});

test('planWriteGuard：硬模式 → block（reason 给模型）', () => {
  const agents = [agent('pA', { [LOCKED]: 'pA' })];
  const g = planWriteGuard({ toolName: 'edit', input: { path: LOCKED_ALT, edits: [] }, agents, ownPaneId: 'pB', cwd: CWD, hard: true });
  assert.equal(g.kind, 'block');
  if (g.kind !== 'block') return;
  assert.equal(g.holderPaneId, 'pA');
  assert.match(g.reason, /pA/);
  assert.match(g.reason, /locked/i);
});

test('planWriteGuard：缺路径 skip', () => {
  const g = planWriteGuard({ toolName: 'write', input: {}, agents: [], ownPaneId: 'pB', cwd: CWD, hard: false });
  assert.equal(g.kind, 'skip');
});

/* ── token 构造 + 警告文案 + 常量 ──────────────────────────────── */

test('acquire/release tokens：键=哈希、acquire 值=paneId|path、release 值 null', () => {
  const acq = acquireTokensFor(['f:/a.cs', 'f:/b.cs'], 'pZ');
  assert.deepEqual(Object.keys(acq).map((k) => k.startsWith('lock-')).every(Boolean), true);
  assert.deepEqual(acq[lockTokenKey('f:/a.cs')], 'pZ|f:/a.cs');
  assert.deepEqual(releaseTokensFor(['f:/a.cs']), { [lockTokenKey('f:/a.cs')]: null });
});

test('formatConflictWarning：含路径与持有者', () => {
  const w = formatConflictWarning('f:/a.cs', 'pA');
  assert.match(w, /pA/);
  assert.match(w, /a\.cs/);
  assert.match(w, /conflict|locked/i);
});

test('常量：env 名与工具集锁定', () => {
  assert.equal(WRITE_LOCK_ENV, 'PI_HERDR_WRITE_LOCK');
  assert.deepEqual([...WRITE_TOOLS].sort(), ['edit', 'write']);
});
