/**
 * 档2 Week1：role manifest 校验器（D76 v2；WS-D8 后 = version + 三态 rules，无 roleType）。
 * 缝：validateRoleManifest(unknown) → {ok, value|issues}——纯函数，错误收集式。
 * 期望值来源 = DESIGN.md 定稿的 probe-role 档案（独立真值，非实现回声）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRoleManifest } from '../src/role-manifest.ts';

/** 定稿 probe-role 档案（known-good 字面量）。 */
const READONLY = {
  role: 'probe-role',
  version: '1.1.0',
  description: '只读worker角色：调研+搜索，不修改代码',
  manifest: {
    tools: ['bash', 'read', 'grep', 'glob', 'web_search', 'todo_write', 'ask_user_question'],
    rules: {
      write: 'deny',
      edit: 'deny',
      subagent: 'deny',
      bash: 'ask',
      '*': 'allow',
    },
  },
  services: { todos: { mode: 'serial', reminderLimit: 3 } },
} as const;

test('validateRoleManifest：定稿 probe-role 档案通过并保留全部语义', () => {
  const r = validateRoleManifest(READONLY);
  assert.equal(r.ok, true, JSON.stringify((r as { issues?: string[] }).issues));
  if (!r.ok) return;
  assert.equal(r.value.role, 'probe-role');
  assert.equal(r.value.version, '1.1.0');
  assert.equal(r.value.manifest.rules?.bash, 'ask');
  assert.equal(r.value.manifest.rules?.write, 'deny');
  assert.equal(r.value.services?.todos.mode, 'serial');
});

test('version：必须 x.y.z 三段数字；"1.0"/"v1.0.0"/数字 都报 issue', () => {
  for (const bad of ['1.0', 'v1.0.0', 1, null]) {
    const r = validateRoleManifest({ ...READONLY, version: bad });
    assert.equal(r.ok, false, `version=${JSON.stringify(bad)} 应报错`);
    assert.ok((r as { issues: string[] }).issues.some((i) => i.includes('version')));
  }
});

test('roleType：已移除（WS-D8）——出现即未知顶层键报 issue', () => {
  const r = validateRoleManifest({ ...READONLY, roleType: 'executor' });
  assert.equal(r.ok, false, 'roleType 应被视为契约外字段');
  assert.ok((r as { issues: string[] }).issues.some((i) => i.includes('roleType')));
});

test('model（WS-D10）：provider/model 通过；裸名/多斜杠/非字符串 报 issue；可省略', () => {
  const good = validateRoleManifest({ ...READONLY, model: 'opencode-go/muse-spark-1.2-contributor' });
  assert.equal(good.ok, true, JSON.stringify((good as { issues?: string[] }).issues));
  if (good.ok) assert.equal(good.value.model, 'opencode-go/muse-spark-1.2-contributor');
  for (const bad of ['muse-spark', 'a/b/c', 42, null]) {
    const r = validateRoleManifest({ ...READONLY, model: bad as never });
    assert.equal(r.ok, false, `model=${JSON.stringify(bad)} 应报错`);
    assert.ok((r as { issues: string[] }).issues.some((i) => i.includes('model')), JSON.stringify(bad));
  }
});

test('unknownTools（D82）：allow/deny 通过；其他值报 issue；可省略（缺省 deny）', () => {
  for (const good of ['allow', 'deny'] as const) {
    const r = validateRoleManifest({
      ...READONLY,
      manifest: { ...READONLY.manifest, unknownTools: good },
    });
    assert.equal(r.ok, true, JSON.stringify((r as { issues?: string[] }).issues));
    if (r.ok) assert.equal(r.value.manifest.unknownTools, good);
  }
  for (const bad of ['maybe', 'ALLOW', 1, null]) {
    const r = validateRoleManifest({
      ...READONLY,
      manifest: { ...READONLY.manifest, unknownTools: bad as never },
    });
    assert.equal(r.ok, false, `unknownTools=${JSON.stringify(bad)} 应报错`);
    assert.ok((r as { issues: string[] }).issues.some((i) => i.includes('unknownTools')), JSON.stringify(bad));
  }
});

test('rules：值必须是 allow/ask/deny；键为工具名或 *；未知值报 issue', () => {
  const r = validateRoleManifest({
    ...READONLY,
    manifest: { ...READONLY.manifest, rules: { bash: 'maybe' as never, 'a b': 'allow' as const } },
  });
  assert.equal(r.ok, false);
  const issues = (r as { issues: string[] }).issues;
  assert.ok(issues.some((i) => i.includes('maybe') && i.includes('bash')));
  assert.ok(issues.some((i) => i.includes('a b')));
});

test('基线非空约束：tools 缺 todo_write 或 ask_user_question → issue（防协调失效）', () => {
  const noTodo = validateRoleManifest({
    ...READONLY,
    manifest: { ...READONLY.manifest, tools: ['bash', 'read', 'ask_user_question'] },
  });
  assert.equal(noTodo.ok, false);
  assert.ok((noTodo as { issues: string[] }).issues.some((i) => i.includes('todo_write')));

  const noAsk = validateRoleManifest({
    ...READONLY,
    manifest: { ...READONLY.manifest, tools: ['bash', 'read', 'todo_write'] },
  });
  assert.equal(noAsk.ok, false);
  assert.ok((noAsk as { issues: string[] }).issues.some((i) => i.includes('ask_user_question')));
});

test('tools：空数组 / 非字符串项 / 重复项 → issue', () => {
  const empty = validateRoleManifest({ ...READONLY, manifest: { ...READONLY.manifest, tools: [] } });
  assert.equal(empty.ok, false);
  assert.ok((empty as { issues: string[] }).issues.some((i) => i.includes('todo_write') || i.includes('空')));

  const dup = validateRoleManifest({
    ...READONLY,
    manifest: { ...READONLY.manifest, tools: [...READONLY.manifest.tools, 'bash'] },
  });
  assert.equal(dup.ok, false);
  assert.ok((dup as { issues: string[] }).issues.some((i) => i.includes('bash') && i.includes('重复')));

  const nonStr = validateRoleManifest({
    ...READONLY,
    manifest: { ...READONLY.manifest, tools: ['bash', 42 as never, 'todo_write', 'ask_user_question'] },
  });
  assert.equal(nonStr.ok, false);
});

test('constraints/rate_limits：已移除（WS-D6）——出现即未知键报 issue', () => {
  const r = validateRoleManifest({
    ...READONLY,
    manifest: {
      ...READONLY.manifest,
      constraints: { rate_limits: { web_search: { max_calls_per_hour: 10 } } },
    },
  });
  assert.equal(r.ok, false, 'constraints 应被视为契约外字段');
  assert.ok((r as { issues: string[] }).issues.some((i) => i.includes('constraints')));
});

test('services.todos：mode 必须 serial/parallel；reminderLimit 正整数', () => {
  const badMode = validateRoleManifest({
    ...READONLY,
    services: { todos: { mode: 'concurrent' as never, reminderLimit: 3 } },
  });
  assert.equal(badMode.ok, false);
  assert.ok((badMode as { issues: string[] }).issues.some((i) => i.includes('mode')));

  const badLimit = validateRoleManifest({
    ...READONLY,
    services: { todos: { mode: 'serial', reminderLimit: 0 } },
  });
  assert.equal(badLimit.ok, false);
  assert.ok((badLimit as { issues: string[] }).issues.some((i) => i.includes('reminderLimit')));
});

test('严格契约：未知顶层键报 issue（防 typo 静默失效）；role 名模式 [a-z0-9-]+', () => {
  const typo = validateRoleManifest({ ...READONLY, rulez: {} });
  assert.equal(typo.ok, false);
  assert.ok((typo as { issues: string[] }).issues.some((i) => i.includes('rulez')));

  const badName = validateRoleManifest({ ...READONLY, role: 'Web Search' });
  assert.equal(badName.ok, false);
  assert.ok((badName as { issues: string[] }).issues.some((i) => i.includes('role')));
});

test('可省略字段：description/rules/constraints/services 全缺省仍合法（默认 {"*":"allow"}）', () => {
  const r = validateRoleManifest({
    role: 'worker-default',
    version: '1.0.0',
    manifest: { tools: ['bash', 'read', 'todo_write', 'ask_user_question'] },
  });
  assert.equal(r.ok, true, JSON.stringify((r as { issues?: string[] }).issues));
});
