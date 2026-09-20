/**
 * Phase 0（RFC docs/rfc-jev-role-routing.md §8）：路由埋点纯函数。
 * 缝：planSpawnProfileRow / planDenyHitRow（行形状）；scanRoleAxisUsage（三轴使用分布）；
 *      taskFingerprint（隐私红线：任务文本永不入遥测，只有 sha8 指纹）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planDenyHitRow,
  planSpawnProfileRow,
  scanRoleAxisUsage,
  taskFingerprint,
} from '../src/routing-telemetry.ts';

test('taskFingerprint：确定性 8 位 hex；不同任务不同指纹；任务文本不出现在行里', () => {
  const a = taskFingerprint('fix the login bug in auth.ts');
  assert.match(a, /^[0-9a-f]{8}$/);
  assert.equal(a, taskFingerprint('fix the login bug in auth.ts'), '同任务同指纹（跨 spawn 可关联）');
  assert.notEqual(a, taskFingerprint('write unit tests for auth.ts'));
});

test('spawn 画像行：字段齐全；allowedTools/manifestTools 为拷贝（防外层可变引用污染）', () => {
  const allowedTools = ['bash'];
  const manifestTools = ['read', 'bash', 'todo_write'];
  const row = planSpawnProfileRow({
    now: 123,
    roleExplicit: false,
    role: 'worker-default',
    allowedTools,
    manifestTools,
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

test('三轴扫描：畸形 JSON / 缺 role / 缺 rules 计入 invalid，扫描不抛', () => {
  const row = scanRoleAxisUsage({
    now: 1,
    files: [
      { name: 'broken.json', text: '{not json' },
      { name: 'no-role.json', text: JSON.stringify({ manifest: { rules: {} } }) },
      { name: 'no-rules.json', text: JSON.stringify({ role: 'x', manifest: { tools: [] } }) },
      { name: 'ok.json', text: ROLE_B },
    ],
  });
  assert.equal(row.parsed, 1);
  assert.equal(row.invalid, 3, '三类畸形各计一次，互不掩盖');
  assert.equal(row.stanceAllow, 1);
  assert.deepEqual(row.explicitDenies, [
    ['worker-default', 'subagent'],
    ['worker-default', 'terminal'],
  ]);
});
