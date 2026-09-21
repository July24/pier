/** lock-core (write locks) / reconcile-core (todo↔subagent) / progress-core (badges): pure planners.
 *  Lock tokens: schema-capped keys (^[A-Za-z0-9_-]{1,32}$, ≤16 per report) → key = hash, value = `paneId|path`. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acquireTokensFor, bashWriteTargets, findLockHolders, fnv1a64, isLockTokenKey, LOCK_BATCH_LIMIT, LOCK_TOKEN_PREFIX,
  lockTokenKey, lockTokenValue, normalizeLockPath, parseLockTokenValue, planWriteGuard, releaseTokensFor, WRITE_LOCK_ENV,
  WRITE_TOOLS, writePathsOfTool, type LockAgentView,
} from '../src/lock-core.ts';
import { estimateEta, formatProgressSuffix, planToolBadge } from '../src/progress-core.ts';
import { reconcileTodos } from '../src/reconcile-core.ts';
import { applyTodoEdits, foldLatestTodosMeta, TODO_EDIT_CUSTOM_TYPE } from '../src/todo-core.ts';

// Platform-native forms: a foreign-platform path would resolve as relative on this host.
const CWD = process.platform === 'win32' ? 'F:\\proj' : '/proj';
/** Normalized form of locked file a.cs; LOCKED_ALT is the same file with case/separator jitter. */
const LOCKED = process.platform === 'win32' ? 'f:/proj/a.cs' : '/proj/a.cs';
const LOCKED_ALT = process.platform === 'win32' ? 'F:\\Proj\\A.CS' : '/Proj/A.CS';

const agent = (paneId: string, locks: Record<string, string>): LockAgentView => ({
  paneId, tokens: Object.fromEntries(Object.entries(locks).map(([p, holder]) => [lockTokenKey(p), lockTokenValue(p, holder)])),
});

const guard = (opts: { toolName: string; input: unknown; agents: readonly LockAgentView[]; ownPaneId: string; hard?: boolean }) =>
  planWriteGuard({ cwd: CWD, hard: false, ...opts });

test('normalizeLockPath: separators unified, lowercased, relative → absolute, trailing slash dropped', () => {
  const cases: Array<[string, string]> = process.platform === 'win32'
    ? [['F:\\A\\B.cs', 'f:/a/b.cs'], ['f:/a/b.cs', 'f:/a/b.cs'], ['src/x.ts', 'f:/proj/src/x.ts'], ['f:/a/', 'f:/a'], ['F:\\A\\..\\A\\B.cs', 'f:/a/b.cs']]
    : [['/A/B.cs', '/a/b.cs'], ['/a/b.cs', '/a/b.cs'], ['src/x.ts', '/proj/src/x.ts'], ['/a/', '/a'], ['/A/../A/B.cs', '/a/b.cs']];
  for (const [input, expected] of cases) assert.equal(normalizeLockPath(input, CWD), expected);
});

test('lockTokenKey: schema-safe hash key, stable per path, distinct across paths', () => {
  const key = lockTokenKey('f:/some/long/path/to/a file.cs');
  assert.match(key, /^[A-Za-z0-9_-]{1,32}$/); assert.ok(key.startsWith(LOCK_TOKEN_PREFIX));
  assert.equal(isLockTokenKey(key), true); assert.equal(isLockTokenKey('pi-herdr-meta'), false);
  assert.equal(isLockTokenKey(LOCK_TOKEN_PREFIX), false); assert.equal(lockTokenKey('f:/a.cs'), lockTokenKey('f:/a.cs'), 'all panes must derive one key per path');
  assert.notEqual(lockTokenKey('f:/a.cs'), lockTokenKey('f:/b.cs')); assert.match(fnv1a64('f:/a.cs'), /^[0-9a-f]{16}$/);
  assert.equal(LOCK_BATCH_LIMIT, 16, 'schema caps every report at 16 token keys');
});

test('lockTokenValue / parseLockTokenValue: round-trip; malformed value → null', () => {
  assert.deepEqual(parseLockTokenValue(lockTokenValue('f:/a.cs', 'w6:p9Q')), { holderPaneId: 'w6:p9Q', path: 'f:/a.cs' });
  assert.equal(parseLockTokenValue('no-separator'), null); assert.equal(parseLockTokenValue('|lead'), null);
  assert.equal(parseLockTokenValue('trail|'), null);
});

test('acquire/release tokens: hash keys, acquire carries paneId|path, release clears with null', () => {
  const acq = acquireTokensFor(['f:/a.cs', 'f:/b.cs'], 'pZ');
  assert.deepEqual(Object.keys(acq).sort(), [lockTokenKey('f:/a.cs'), lockTokenKey('f:/b.cs')].sort()); assert.equal(acq[lockTokenKey('f:/a.cs')], 'pZ|f:/a.cs');
  assert.deepEqual(releaseTokensFor(['f:/a.cs']), { [lockTokenKey('f:/a.cs')]: null });
});

test('writePathsOfTool: write/edit expose their path; other tools expose none', () => {
  assert.deepEqual([...WRITE_TOOLS].sort(), ['edit', 'write'], 'only these tools register locks');
  assert.equal(WRITE_LOCK_ENV, 'PI_HERDR_WRITE_LOCK', 'documented env knob for hard mode');
  assert.deepEqual(writePathsOfTool('write', { path: 'F:/a.cs', content: 'x' }), ['F:/a.cs']);
  assert.deepEqual(writePathsOfTool('edit', { path: 'F:/a.cs', edits: [] }), ['F:/a.cs']); assert.deepEqual(writePathsOfTool('bash', { command: 'rm x' }), []);
  assert.deepEqual(writePathsOfTool('read', { path: 'F:/a.cs' }), []); assert.deepEqual(writePathsOfTool('write', {}), []);
});

test('findLockHolders: lists every other holder, dedupes, excludes self and cleared tokens', () => {
  const agents: LockAgentView[] = [
    agent('pA', { 'f:/a.cs': 'pA' }),
    agent('pB', { 'f:/a.cs': 'pB' }),
    agent('pC', { 'f:/a.cs': 'pA' }), // same holder twice
    { paneId: 'pD', tokens: { [lockTokenKey('f:/c.cs')]: null, unrelated: 'x' } },
  ];
  assert.deepEqual(findLockHolders(agents, 'pZ', 'f:/a.cs'), ['pA', 'pB']); assert.deepEqual(findLockHolders(agents, 'pA', 'f:/a.cs'), ['pB'], 'self is excluded');
  assert.deepEqual(findLockHolders(agents, 'pZ', 'f:/c.cs'), [], 'a cleared token holds nothing'); assert.deepEqual(findLockHolders(agents, 'pZ', 'f:/zz.cs'), []);
});

test('planWriteGuard: non-write tool / missing path skip; no conflict pass; same-pane reentry pass', () => {
  const agents = [agent('pA', { [LOCKED]: 'pA' })];
  assert.equal(guard({ toolName: 'read', input: { path: 'a.cs' }, agents, ownPaneId: 'pB', hard: true }).kind, 'skip');
  assert.equal(guard({ toolName: 'write', input: {}, agents: [], ownPaneId: 'pB' }).kind, 'skip');
  assert.equal(guard({ toolName: 'write', input: { path: 'other.cs', content: '' }, agents, ownPaneId: 'pB', hard: true }).kind, 'pass');
  assert.equal(guard({ toolName: 'write', input: { path: 'a.cs', content: '' }, agents, ownPaneId: 'pA', hard: true }).kind, 'pass');
});

test('planWriteGuard: soft mode (default) → warn naming path/holders and both lookups, tool passes', () => {
  const agents = [agent('pA', { [LOCKED]: 'pA' })];
  const g = guard({ toolName: 'write', input: { path: LOCKED_ALT, content: '' }, agents, ownPaneId: 'pB' });
  assert.equal(g.kind, 'warn');
  if (g.kind !== 'warn') return;
  assert.deepEqual(g.holderPaneIds, ['pA']); assert.deepEqual(g.paths, [LOCKED], 'the normalized path is what matches the token');
  assert.match(g.warning, /pA/); assert.match(g.warning, /a\.cs/i);
  assert.match(g.warning, /conflict|locked/i); assert.match(g.warning, /by pane pA /, 'single holder is singular');
  assert.match(g.warning, /\/locks/, 'human view'); assert.match(g.warning, /herdr agent list/, 'agent-readable view');
});

test('planWriteGuard: hard mode → block, reason lists every holder plus the lookup hint', () => {
  const agents = [agent('pA', { [LOCKED]: 'pA' }), agent('pB', { [LOCKED]: 'pB' })];
  const g = guard({ toolName: 'edit', input: { path: LOCKED_ALT, edits: [] }, agents, ownPaneId: 'pZ', hard: true });
  assert.equal(g.kind, 'block');
  if (g.kind !== 'block') return;
  assert.deepEqual(g.holderPaneIds, ['pA', 'pB']); assert.match(g.reason, /panes pA, pB/);
  assert.match(g.reason, /locked/i); assert.match(g.reason, /herdr agent list/);
});

test('bashWriteTargets: obvious redirect / tee / sed -i / truncate targets, nothing guessed', () => {
  const cases: Array<[string | undefined, string[]]> = [
    ['echo hi > out.txt', ['out.txt']],
    ['npm test >> logs/build.log', ['logs/build.log']],
    ['cat a b > "my file.txt"', ['my file.txt']],
    ["printf x | tee -a 'report.csv'", ['report.csv']],
    ["sed -i '' 's/a/b/' src/app.ts", ['src/app.ts']],
    ["sed -i.bak 's/a/b/' src/app.ts", ['src/app.ts']],
    ['truncate -s 0 cache.db', ['cache.db']],
    ['echo x > a.txt && echo y >> a.txt', ['a.txt']], // deduped
    ['git status', []],
    ['echo "a > b"', []],
    ['make 2>&1', []],
    [undefined, []],
    ['', []],
  ];
  for (const [command, expected] of cases) {
    assert.deepEqual(bashWriteTargets(command), expected, `bashWriteTargets(${JSON.stringify(command)})`);
  }
});

test('planWriteGuard (bash): conflicting bash write warns even under hard lock, write tool still blocks', () => {
  const agents = [agent('p9', { [LOCKED]: 'p9' })];
  // hard mode cannot block shell writes: unparsed shell means false positives are too costly
  const bash = guard({ toolName: 'bash', input: { command: `sed -i '' 's/a/b/' ${LOCKED_ALT}` }, agents, ownPaneId: 'pB', hard: true });
  assert.equal(bash.kind, 'warn');
  if (bash.kind !== 'warn') return;
  assert.deepEqual(bash.paths, [LOCKED]); assert.match(bash.warning, /not blocked/);
  assert.match(bash.warning, /re-read the file/);

  const write = guard({ toolName: 'write', input: { path: LOCKED_ALT, content: '' }, agents, ownPaneId: 'pB', hard: true });
  assert.equal(write.kind, 'block');
  assert.equal(guard({ toolName: 'bash', input: { command: 'echo hi > free.txt' }, agents, ownPaneId: 'pB', hard: true }).kind, 'pass');
  assert.equal(guard({ toolName: 'bash', input: { command: `echo x > ${LOCKED_ALT}` }, agents, ownPaneId: 'p9', hard: true }).kind, 'pass');
});

test('estimateEta: <2 completion points or a stale newest point → null (conservative: show plain N/M)', () => {
  assert.equal(estimateEta({ completedAt: [], total: 7, now: 1000 }), null); assert.equal(estimateEta({ completedAt: [1000], total: 7, now: 2000 }), null);
  assert.equal(estimateEta({ completedAt: [0, 60_000], total: 7, now: 10 * 60_000 }), null);
  assert.equal(estimateEta({ completedAt: [590_000, 600_000], total: 7, now: 1_800_000 }), null);
});

test('estimateEta: point spacing gives the rate, remaining × spacing the eta; done → 0; total=0 → null', () => {
  // 0s/60s/120s → 1 step per 60s, 4 steps left → 240s
  const e = estimateEta({ completedAt: [0, 60_000, 120_000], total: 7, now: 130_000 });
  assert.ok(e); assert.equal(e!.remaining, 4);
  assert.equal(e!.etaMs, 240_000); assert.equal(e!.confidence, 'ok');
  const done = estimateEta({ completedAt: [0, 60_000], total: 2, now: 61_000 });
  assert.ok(done); assert.equal(done!.etaMs, 0);
  assert.equal(estimateEta({ completedAt: [0, 60_000], total: 0, now: 61_000 }), null);
});

test('formatProgressSuffix: conservative N/M, eta in <1m / ~Nm / ~Nh buckets, total=0 empty', () => {
  assert.equal(formatProgressSuffix({ completed: 3, total: 7, eta: null }), '3/7');
  assert.equal(formatProgressSuffix({ completed: 3, total: 7, eta: { remaining: 4, etaMs: 240_000, confidence: 'ok' } }), '3/7 ~4m');
  assert.equal(formatProgressSuffix({ completed: 0, total: 0, eta: null }), ''); assert.equal(formatProgressSuffix({ completed: 5, total: 5, eta: null }), '5/5 ✓');
  assert.equal(formatProgressSuffix({ completed: 1, total: 9, eta: { remaining: 8, etaMs: 30_000, confidence: 'ok' } }), '1/9 <1m');
  assert.equal(formatProgressSuffix({ completed: 1, total: 9, eta: { remaining: 8, etaMs: 90_000, confidence: 'ok' } }), '1/9 ~2m');
  assert.equal(formatProgressSuffix({ completed: 1, total: 9, eta: { remaining: 8, etaMs: 3_600_000, confidence: 'ok' } }), '1/9 ~1h');
});

test('planToolBadge: single tool name; first + count; empty → null (title not overwritten)', () => {
  assert.equal(planToolBadge([]), null); assert.equal(planToolBadge(['bash']), '🔧 bash');
  assert.equal(planToolBadge(['bash', 'read', 'grep']), '🔧 bash +2');
});

// reconcile: D is the description a settled subagent reported; `status as never` keeps the tuple table readable.
const D = '调研 cordis';

function items(list: Array<[string, string, string?]>) {
  return list.map(([content, status, blocker]) => ({ content, status: status as never, ...(blocker ? { blocker } : {}) }));
}

test('exact unique pending match → auto-completed (done edit, tier=exact)', () => {
  const prev = items([[D, 'pending'], ['别的任务', 'in_progress']]);
  const p = reconcileTodos(prev, { description: D, outcome: 'settled' });
  assert.deepEqual(p.edits, [{ op: 'done', content: D }]); assert.equal(p.completed?.content, D);
  assert.equal(p.tier, 'exact'); assert.equal(p.items.find((t) => t.content === D)?.status, 'completed');
  assert.ok(p.noteLines.some((l) => l.includes('Reconciled') && l.includes(D)));
  // a candidate at a lower tier never blocks the unique best-tier match
  const lower = reconcileTodos(items([[D, 'pending'], [`${D} 补充`, 'pending']]), { description: D, outcome: 'settled' });
  assert.deepEqual(lower.edits, [{ op: 'done', content: D }]); assert.equal(lower.items.find((t) => t.content === `${D} 补充`)?.status, 'pending');
});

test('delegation convention: trailing " <sub>" marker on todo, plain description → prefix tier done', () => {
  // todo_write's tool description promises this convention (master delegates with the marker,
  // subagent description uses the stripped content), so the marker must not break matching.
  const prev = items([[`${D} <sub>`, 'in_progress']]);
  const p = reconcileTodos(prev, { description: D, outcome: 'settled' });
  assert.equal(p.tier, 'prefix'); assert.equal(p.edits.length, 1);
  assert.equal(p.edits[0].op, 'done'); assert.equal(p.edits[0].content, `${D} <sub>`);
});

test('prefix match either direction (longer todo / extending description) → auto-done', () => {
  const prev = items([[`${D} 生命周期与 fiber 语义`, 'in_progress']]);
  const p = reconcileTodos(prev, { description: D, outcome: 'settled' });
  assert.equal(p.tier, 'prefix'); assert.equal(p.edits.length, 1);
  assert.equal(p.edits[0].op, 'done');
  const rev = reconcileTodos(items([['cordis', 'pending']]), {
    description: 'cordis fiber',
    outcome: 'settled',
  });
  assert.equal(rev.tier, 'prefix');
});

test('substring = low confidence → no edit, note lists the candidate', () => {
  const prev = items([[`深入研究 ${D} 的用法`, 'pending']]);
  const p = reconcileTodos(prev, { description: D, outcome: 'settled' });
  assert.equal(p.edits.length, 0); assert.equal(p.completed, null);
  assert.equal(p.tier, 'substring'); assert.equal(p.items[0].status, 'pending');
  assert.ok(p.noteLines.some((l) => l.includes('low-confidence') && l.includes('深入研究')));
});

test('multiple candidates at one tier (ambiguous) → no edit, note lists both', () => {
  const prev = items([[`${D} 甲`, 'pending'], [`${D} 乙`, 'pending']]);
  const p = reconcileTodos(prev, { description: D, outcome: 'settled' });
  assert.equal(p.edits.length, 0); assert.equal(p.tier, 'prefix');
  assert.ok(p.noteLines.some((l) => l.includes('ambiguous') && l.includes('甲') && l.includes('乙')));
});

test('failed outcome → no edits; a confident candidate gets a "kept open" note, no candidate stays silent', () => {
  const prev = items([[D, 'in_progress']]);
  const p = reconcileTodos(prev, { description: D, outcome: 'failed' });
  assert.equal(p.edits.length, 0); assert.equal(p.items[0].status, 'in_progress');
  assert.ok(p.noteLines.some((l) => l.includes('kept open')));
  const none = reconcileTodos(items([['不相干', 'pending']]), { description: D, outcome: 'failed' });
  assert.equal(none.noteLines.length, 0);
});

test('blocked items whose blocker matches at any tier → unblocked, blocker cleared (failed never unblocks)', () => {
  const prev = items([['汇总报告', 'blocked', `等 ${D} 完成`], ['另一份汇总', 'blocked', `等 ${D} 完成`]]);
  const p = reconcileTodos(prev, { description: D, outcome: 'settled' });
  assert.equal(p.edits.filter((e) => e.op === 'unblock').length, 2); assert.ok(p.items.every((t) => t.status === 'pending' && !('blocker' in t)));
  assert.ok(p.noteLines.some((l) => l.includes('Unblocked')));
  const sub = reconcileTodos(items([['汇总', 'blocked', `深入研究 ${D} 之后`]]), { description: D, outcome: 'settled' });
  assert.equal(sub.edits.filter((e) => e.op === 'unblock').length, 1); assert.equal(sub.items[0].status, 'pending');
  const fail = reconcileTodos(items([['汇总', 'blocked', `等 ${D}`]]), { description: D, outcome: 'failed' });
  assert.equal(fail.edits.length, 0);
});

test('completed/abandoned never match; whitespace and case are normalized before exact match', () => {
  const terminal = reconcileTodos(items([[D, 'completed'], [`${D} 旧`, 'abandoned']]), { description: D, outcome: 'settled' });
  assert.equal(terminal.edits.length, 0); assert.equal(terminal.noteLines.length, 0, 'no candidates → no edits, no notes');
  const normalized = reconcileTodos(items([['  调研  CORDIS ', 'pending']]), { description: '调研 cordis', outcome: 'settled' });
  assert.equal(normalized.tier, 'exact');
});

test('unblock op: blocked→pending clears blocker (non-blocked no-op), replayable via the custom entry', () => {
  const next = applyTodoEdits(items([['a', 'blocked', 'x'], ['b', 'pending']]), [{ op: 'unblock', content: 'a' }]);
  assert.deepEqual(next, [{ content: 'a', status: 'pending' }, { content: 'b', status: 'pending' }]);
  // Branch replay through the authoritative path (pi-herdr.todo-edit) must fold to the same state.
  const branch = [
    { type: 'message', message: { role: 'toolResult', toolName: 'todo_write', details: { 'pi-herdr.todo': { version: 1, items: [{ content: '汇总', status: 'blocked', blocker: '等调研' }] } } } },
    { type: 'custom', customType: TODO_EDIT_CUSTOM_TYPE, data: { version: 1, edits: [{ op: 'unblock', content: '汇总' }], ts: 1 } },
  ];
  assert.deepEqual(foldLatestTodosMeta(branch as never)?.items, [{ content: '汇总', status: 'pending' }]);
});
