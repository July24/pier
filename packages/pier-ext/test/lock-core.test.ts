/**
 * M18：文件级写锁（S2：默认软 veto；PI_HERDR_WRITE_LOCK=1 硬启）。
 * 缝：normalizeLockPath / fnv1a64 / token 编解码 / planWriteGuard（含 warn/block 文案）。
 * token 契约（schema 实测）：键 ^[A-Za-z0-9_-]{1,32}$、每报 ≤16 键 → 键=哈希、值=paneId|path。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bashWriteTargets,
  LOCK_BATCH_LIMIT,
  LOCK_TOKEN_PREFIX,
  WRITE_LOCK_ENV,
  WRITE_TOOLS,
  acquireTokensFor,
  findLockHolders,
  fnv1a64,
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

const guard = (opts: {
  toolName: string;
  input: unknown;
  agents: readonly LockAgentView[];
  ownPaneId: string;
  hard?: boolean;
}) => planWriteGuard({ cwd: CWD, hard: false, ...opts });

/* ── 路径归一（Windows 大小写/分隔符/相对路径） ────────────────── */

test('normalizeLockPath：分隔符统一、小写、相对→绝对、去尾斜杠', () => {
  const cases: Array<[string, string]> = process.platform === 'win32'
    ? [['F:\\A\\B.cs', 'f:/a/b.cs'], ['f:/a/b.cs', 'f:/a/b.cs'], ['src/x.ts', 'f:/proj/src/x.ts'], ['f:/a/', 'f:/a'], ['F:\\A\\..\\A\\B.cs', 'f:/a/b.cs']]
    : [['/A/B.cs', '/a/b.cs'], ['/a/b.cs', '/a/b.cs'], ['src/x.ts', '/proj/src/x.ts'], ['/a/', '/a'], ['/A/../A/B.cs', '/a/b.cs']];
  for (const [input, expected] of cases) {
    assert.equal(normalizeLockPath(input, CWD), expected);
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
  assert.deepEqual(parseLockTokenValue(lockTokenValue('f:/a.cs', 'w6:p9Q')), { holderPaneId: 'w6:p9Q', path: 'f:/a.cs' });
  assert.equal(parseLockTokenValue('no-separator'), null);
  assert.equal(parseLockTokenValue('|lead'), null);
  assert.equal(parseLockTokenValue('trail|'), null);
});

test('acquire/release tokens：键=哈希、acquire 值=paneId|path、release 值 null', () => {
  const acq = acquireTokensFor(['f:/a.cs', 'f:/b.cs'], 'pZ');
  assert.deepEqual(Object.keys(acq).map((k) => k.startsWith('lock-')).every(Boolean), true);
  assert.deepEqual(acq[lockTokenKey('f:/a.cs')], 'pZ|f:/a.cs');
  assert.deepEqual(releaseTokensFor(['f:/a.cs']), { [lockTokenKey('f:/a.cs')]: null });
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

/* ── 持有者查询（异 pane 持有、去重、排除自己/null） ────────────── */

test('findLockHolders：列出全部持有者、去重并排除自己；已清除的 token 不算', () => {
  const agents: LockAgentView[] = [
    agent('pA', { 'f:/a.cs': 'pA' }),
    agent('pB', { 'f:/a.cs': 'pB' }),
    agent('pC', { 'f:/a.cs': 'pA' }), // duplicate holder
    { paneId: 'pD', tokens: { [lockTokenKey('f:/c.cs')]: null, unrelated: 'x' } },
  ];
  assert.deepEqual(findLockHolders(agents, 'pZ', 'f:/a.cs'), ['pA', 'pB']);
  assert.deepEqual(findLockHolders(agents, 'pA', 'f:/a.cs'), ['pB'], 'self is excluded');
  assert.deepEqual(findLockHolders(agents, 'pZ', 'f:/c.cs'), [], 'a cleared token holds nothing');
  assert.deepEqual(findLockHolders(agents, 'pZ', 'f:/zz.cs'), []);
});

/* ── 决策（skip/pass/warn/block） ─────────────────────────────── */

test('planWriteGuard：非写工具/缺路径 skip；无冲突 pass；同 pane 重入 pass', () => {
  const agents = [agent('pA', { [LOCKED]: 'pA' })];
  assert.equal(guard({ toolName: 'read', input: { path: 'a.cs' }, agents, ownPaneId: 'pB', hard: true }).kind, 'skip');
  assert.equal(guard({ toolName: 'write', input: {}, agents: [], ownPaneId: 'pB' }).kind, 'skip');
  assert.equal(guard({ toolName: 'write', input: { path: 'other.cs', content: '' }, agents, ownPaneId: 'pB', hard: true }).kind, 'pass');
  assert.equal(guard({ toolName: 'write', input: { path: 'a.cs', content: '' }, agents, ownPaneId: 'pA', hard: true }).kind, 'pass');
});

test('planWriteGuard：软模式（默认）→ warn，文案含路径/持有者与查询入口，工具放行', () => {
  const agents = [agent('pA', { [LOCKED]: 'pA' })];
  const g = guard({ toolName: 'write', input: { path: LOCKED_ALT, content: '' }, agents, ownPaneId: 'pB' });
  assert.equal(g.kind, 'warn');
  if (g.kind !== 'warn') return;
  assert.deepEqual(g.holderPaneIds, ['pA']);
  assert.deepEqual(g.paths, [LOCKED], '归一路径后才匹配 token');
  assert.match(g.warning, /pA/);
  assert.match(g.warning, /a\.cs/i);
  assert.match(g.warning, /conflict|locked/i);
  assert.match(g.warning, /by pane pA /, '单个持有者用单数');
  assert.match(g.warning, /\/locks/, 'warning points at the human view');
  assert.match(g.warning, /herdr agent list/, 'warning points at the agent-readable view');
});

test('planWriteGuard：硬模式 → block（reason 列出全部持有者并附查询提示）', () => {
  const agents = [agent('pA', { [LOCKED]: 'pA' }), agent('pB', { [LOCKED]: 'pB' })];
  const g = guard({ toolName: 'edit', input: { path: LOCKED_ALT, edits: [] }, agents, ownPaneId: 'pZ', hard: true });
  assert.equal(g.kind, 'block');
  if (g.kind !== 'block') return;
  assert.deepEqual(g.holderPaneIds, ['pA', 'pB']);
  assert.match(g.reason, /panes pA, pB/);
  assert.match(g.reason, /locked/i);
  assert.match(g.reason, /herdr agent list/);
});

test('常量：env 名与工具集锁定', () => {
  assert.equal(WRITE_LOCK_ENV, 'PI_HERDR_WRITE_LOCK');
  assert.deepEqual([...WRITE_TOOLS].sort(), ['edit', 'write']);
});

/* ──────────── B7：bash 重定向绕过软锁（只提示、不阻断） ──────────── */

test('bashWriteTargets: 抽取明显的重定向/tee/sed -i/truncate 目标', () => {
  assert.deepEqual(bashWriteTargets('echo hi > out.txt'), ['out.txt']);
  assert.deepEqual(bashWriteTargets('npm test >> logs/build.log'), ['logs/build.log']);
  assert.deepEqual(bashWriteTargets('cat a b > "my file.txt"'), ['my file.txt']);
  assert.deepEqual(bashWriteTargets("printf x | tee -a 'report.csv'"), ['report.csv']);
  assert.deepEqual(bashWriteTargets("sed -i '' 's/a/b/' src/app.ts"), ['src/app.ts']);
  assert.deepEqual(bashWriteTargets("sed -i.bak 's/a/b/' src/app.ts"), ['src/app.ts']);
  assert.deepEqual(bashWriteTargets('truncate -s 0 cache.db'), ['cache.db']);
  // 多个目标去重
  assert.deepEqual(bashWriteTargets('echo x > a.txt && echo y >> a.txt'), ['a.txt']);
  // 只读命令 / 未知语法一律不猜（宁可不报，也不能误报阻断）
  assert.deepEqual(bashWriteTargets('git status'), []);
  assert.deepEqual(bashWriteTargets('echo "a > b"'), []);
  assert.deepEqual(bashWriteTargets('make 2>&1'), []);
  assert.deepEqual(bashWriteTargets(undefined), []);
  assert.deepEqual(bashWriteTargets(''), []);
});

test('planWriteGuard (B7)：bash 撞到别人的锁 → warn（不 block），write 工具仍可硬阻断', () => {
  const agents = [agent('p9', { [LOCKED]: 'p9' })];
  const bash = guard({
    toolName: 'bash',
    input: { command: `sed -i '' 's/a/b/' ${LOCKED_ALT}` },
    agents,
    ownPaneId: 'pB',
    hard: true, // 即便开了硬锁，bash 也不能阻断（没解析 shell，误判代价太高）
  });
  assert.equal(bash.kind, 'warn');
  if (bash.kind !== 'warn') return;
  assert.deepEqual(bash.paths, [LOCKED]);
  assert.match(bash.warning, /not blocked/);
  assert.match(bash.warning, /re-read the file/);

  const write = guard({ toolName: 'write', input: { path: LOCKED_ALT, content: '' }, agents, ownPaneId: 'pB', hard: true });
  assert.equal(write.kind, 'block');

  // 没有冲突时 bash 不产生噪音
  assert.equal(guard({ toolName: 'bash', input: { command: 'echo hi > free.txt' }, agents, ownPaneId: 'pB', hard: true }).kind, 'pass');
  // 自己锁自己（重入）也不提示
  assert.equal(guard({ toolName: 'bash', input: { command: `echo x > ${LOCKED_ALT}` }, agents, ownPaneId: 'p9', hard: true }).kind, 'pass');
});
