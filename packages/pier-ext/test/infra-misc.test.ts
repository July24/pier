/**
 * 小体量基础设施纯函数的合并测试：DisposeLedger（D80⑤ hmr 补偿 + D79 反注册共用）与
 * routing-telemetry（RFC docs/rfc-jev-role-routing.md §8 的埋点行规划器）。
 * 两者都是无文件 I/O 的进程级簿记，故同址。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { DisposeLedger } from '../src/ledger.ts';
import {
  planDenyHitRow,
  planSpawnProfileRow,
  scanRoleAxisUsage,
  taskFingerprint,
} from '../src/routing-telemetry.ts';

/* ── DisposeLedger ──────────────────────────────────────────────────────── */

test('ledger：disposeKey 只拆匹配 key（hmr 补偿语义），未匹配保留', () => {
  const led = new DisposeLedger();
  const ran: string[] = [];
  led.add('F:/x/src/a.ts', () => ran.push('a'));
  led.add('F:/x/src/b.ts', () => ran.push('b'));
  led.add('F:/x/src/a.ts', () => ran.push('a2'));
  const n = led.disposeKey('F:\\x\\src\\a.ts'); // Windows 路径形态也要命中
  assert.equal(n, 2);
  assert.deepEqual(ran.sort(), ['a', 'a2']);
  assert.equal(led.size, 1, 'b 保留');
});

test('ledger：disposeAll LIFO（与 cordis effect 语义一致）；异常不中断后续拆除', () => {
  const led = new DisposeLedger();
  const ran: string[] = [];
  led.add('a', () => ran.push('1'));
  led.add('b', () => { throw new Error('boom'); });
  led.add('c', () => ran.push('3'));
  assert.equal(led.disposeAll(), 3);
  assert.deepEqual(ran, ['3', '1'], 'LIFO 且异常被吞');
  assert.equal(led.size, 0);
});

test('ledger：add 返回撤销函数（资源自拆后移除，防 hmr 补偿二次拆）', () => {
  const led = new DisposeLedger();
  let disposed = 0;
  const undo = led.add('a', () => disposed++);
  undo();
  assert.equal(led.size, 0);
  assert.equal(led.disposeKey('a'), 0, '已撤销不再拆');
  assert.equal(disposed, 0);
});

test('ledger：键归一（file:// URL vs 路径、反斜杠、逻辑名）都可命中', () => {
  for (const [registered, lookup] of [
    [resolve('x.ts'), pathToFileURL(resolve('x.ts')).href], // import.meta.url vs hmr filename
    ['F:\\repo\\pier\\x.ts', 'F:/repo/pier/x.ts'], // Windows hmr filename 形态
    ['pi-surface', 'pi-surface'], // D79 逻辑名原样
  ] as const) {
    const led = new DisposeLedger();
    const ran: string[] = [];
    led.add(registered, () => ran.push('hit'));
    assert.equal(led.disposeKey(lookup), 1, `${registered} ↔ ${lookup}`);
    assert.deepEqual(ran, ['hit']);
  }
});

/* ── routing telemetry（Phase 0 RFC docs/rfc-jev-role-routing.md §8） ───── */

test('taskFingerprint：确定性 8 位 hex；不同任务不同指纹；任务文本不出现在行里', () => {
  const a = taskFingerprint('fix the login bug in auth.ts');
  assert.match(a, /^[0-9a-f]{8}$/);
  assert.equal(a, taskFingerprint('fix the login bug in auth.ts'), '同任务同指纹（跨 spawn 可关联）');
  assert.notEqual(a, taskFingerprint('write unit tests for auth.ts'));
});

test('spawn 画像行：字段齐全；allowedTools/manifestTools 为拷贝（防外层可变引用污染）', () => {
  const allowedTools = ['bash'];
  const row = planSpawnProfileRow({
    now: 123,
    roleExplicit: false,
    role: 'worker-default',
    allowedTools,
    manifestTools: ['read', 'bash', 'todo_write'],
    task: 'secret task text',
  });
  assert.deepEqual(row, {
    kind: 'spawn',
    ts: 123,
    roleExplicit: false,
    role: 'worker-default',
    allowedTools: ['bash'],
    manifestTools: ['read', 'bash', 'todo_write'],
    taskSha8: taskFingerprint('secret task text'),
  });
  allowedTools.push('mutated');
  assert.deepEqual(row.allowedTools, ['bash'], '行持有快照，不随源数组漂移');
  assert.ok(!JSON.stringify(row).includes('secret task text'), '隐私红线：任务文本不落入行');
});

test('deny 命中行：形状', () => {
  assert.deepEqual(planDenyHitRow({ now: 7, role: 'worker-default', tool: 'subagent' }), {
    kind: 'deny',
    ts: 7,
    role: 'worker-default',
    tool: 'subagent',
  });
});

const ROLE_A = JSON.stringify({
  role: 'reviewer',
  manifest: { unknownTools: 'deny', rules: { '*': 'allow', edit: 'ask', write: 'deny' } },
});
const ROLE_B = JSON.stringify({
  role: 'worker-default',
  manifest: { unknownTools: 'allow', rules: { subagent: 'deny', terminal: 'deny', '*': 'allow' } },
});

test('三轴扫描：省略 rules 的最小合法档案按隐式 {"*":"allow"} 计入 parsed（schema 可省略）', () => {
  const row = scanRoleAxisUsage({
    now: 1,
    files: [
      { name: 'minimal.json', text: JSON.stringify({ role: 'fast-worker', manifest: { tools: ['read'] } }) },
      { name: 'no-manifest.json', text: JSON.stringify({ role: 'x' }) },
    ],
  });
  assert.equal(row.parsed, 1, 'rules 省略 ≠ 非法');
  assert.equal(row.invalid, 1, '缺 manifest 才是非法');
  assert.equal(row.stanceDeny, 1, 'unknownTools 缺省 = deny（schema 契约）');
  assert.equal(row.askEntries, 0);
  assert.deepEqual(row.explicitDenies, []);
});

test('三轴扫描：ask/姿态/explicit deny 计数正确；通配 deny 不计入 explicit', () => {
  const row = scanRoleAxisUsage({ now: 1, files: [{ name: 'a.json', text: ROLE_A }, { name: 'b.json', text: ROLE_B }] });
  assert.deepEqual(row, {
    kind: 'axis-usage',
    ts: 1,
    files: 2,
    parsed: 2,
    invalid: 0,
    askEntries: 1,
    stanceAllow: 1,
    stanceDeny: 1,
    explicitDenies: [
      ['reviewer', 'write'],
      ['worker-default', 'subagent'],
      ['worker-default', 'terminal'],
    ],
  });
});
