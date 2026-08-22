/**
 * 档2 Week2-3：manifest 合成（C7 v2 三态权限）。
 * 缝：composeManifest(sources) —— 纯函数；期望值 = cordis-adoption-options.md §4.3 示例。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ManifestError, composeManifest } from '../src/manifest-compose.ts';

test('S1 正常 union：基线+模型建议并集去重，排序确定，permissions 全 allow', () => {
  const r = composeManifest({
    roleBaseline: ['bash', 'edit', 'write', 'todo_write'],
    modelSuggested: ['read', 'grep', 'bash'],
    rulePermissions: { '*': 'allow' },
  });
  assert.deepEqual(r.tools, ['bash', 'edit', 'grep', 'read', 'todo_write', 'write']);
  assert.deepEqual(r.permissions, {
    bash: 'allow', edit: 'allow', grep: 'allow',
    read: 'allow', todo_write: 'allow', write: 'allow',
  });
});

test('S2 规则 deny 排除：模型建议 write 也进不来（护栏不可绕过）；D82 后 deny 记入 permissions', () => {
  const r = composeManifest({
    roleBaseline: ['bash', 'edit', 'read', 'todo_write'],
    modelSuggested: ['write', 'bash'],
    rulePermissions: { write: 'deny', edit: 'deny', '*': 'allow' },
  });
  assert.deepEqual(r.tools, ['bash', 'read', 'todo_write']);
  assert.deepEqual(r.permissions, {
    write: 'deny', edit: 'deny', bash: 'allow', read: 'allow', todo_write: 'allow',
  });
});

test('S3 三态混合（websearch 形态）：deny 排除 + ask 标记并存', () => {
  const r = composeManifest({
    roleBaseline: ['bash', 'read', 'grep', 'web_search', 'todo_write'],
    modelSuggested: ['bash', 'write'],
    rulePermissions: { bash: 'ask', write: 'deny', edit: 'deny', '*': 'allow' },
  });
  assert.deepEqual(r.tools, ['bash', 'grep', 'read', 'todo_write', 'web_search']);
  assert.deepEqual(r.permissions, {
    bash: 'ask', write: 'deny', edit: 'deny',
    grep: 'allow', read: 'allow', todo_write: 'allow', web_search: 'allow',
  });
});

test('S4 通配符默认：显式规则 > `*` 默认 > allow 兜底；`*` 也可为 ask/deny', () => {
  const r = composeManifest({
    roleBaseline: ['bash', 'read', 'todo_write'],
    modelSuggested: ['grep', 'write'],
    rulePermissions: { bash: 'ask', '*': 'allow' },
  });
  assert.deepEqual(r.permissions, {
    bash: 'ask', read: 'allow', todo_write: 'allow', grep: 'allow', write: 'allow',
  });

  // `*` = ask：未列出工具降为 ask
  const askAll = composeManifest({
    roleBaseline: ['read', 'todo_write'],
    modelSuggested: [],
    rulePermissions: { '*': 'ask' },
  });
  assert.deepEqual(askAll.permissions, { read: 'ask', todo_write: 'ask' });

  // 无 `*` 键 → 兜底 allow；D82 后 deny 规则键保留在 permissions
  const noStar = composeManifest({
    roleBaseline: ['read', 'todo_write'],
    modelSuggested: [],
    rulePermissions: { write: 'deny' },
  });
  assert.deepEqual(noStar.permissions, { write: 'deny', read: 'allow', todo_write: 'allow' });
});

test('S9 D82 姿态透传：unknownTools 缺省 deny；allow 透传；排除族 deny 保留（基线外规则键）', () => {
  const d = composeManifest({
    roleBaseline: ['bash', 'read', 'todo_write'],
    modelSuggested: [],
    rulePermissions: { '*': 'allow' },
  });
  assert.equal(d.unknownTools, 'deny');
  // worker-default 形态：排除族（基线外）deny 规则键进 permissions——stance=allow 下闸门仍持禁令
  const w = composeManifest({
    roleBaseline: ['bash', 'read', 'todo_write'],
    modelSuggested: [],
    rulePermissions: { subagent: 'deny', terminal_open: 'deny', '*': 'allow' },
    unknownTools: 'allow',
  });
  assert.equal(w.unknownTools, 'allow');
  assert.equal(w.permissions.subagent, 'deny');
  assert.equal(w.permissions.terminal_open, 'deny');
  assert.ok(!w.tools.includes('subagent'));
});

test('S6 空检测（deny-all trap）：合成后为空 → ManifestError(EMPTY_MANIFEST)，消息含三源诊断', () => {
  assert.throws(
    () => composeManifest({
      roleBaseline: ['bash'],
      modelSuggested: ['read'],
      rulePermissions: { bash: 'deny', read: 'deny', '*': 'deny' },
    }),
    (e: unknown) => {
      assert.ok(e instanceof ManifestError);
      assert.equal(e.code, 'EMPTY_MANIFEST');
      assert.match(e.message, /bash/);
      assert.match(e.message, /read/);
      return true;
    },
  );
});

test('S7 模型未填 allowed_tools：只用基线', () => {
  const r = composeManifest({
    roleBaseline: ['bash', 'edit', 'todo_write'],
    modelSuggested: [],
    rulePermissions: { '*': 'allow' },
  });
  assert.deepEqual(r.tools, ['bash', 'edit', 'todo_write']);
});

test('S8 基线为空 → ManifestError(INVALID_ROLE_CONFIG)（协调工具强制）', () => {
  assert.throws(
    () => composeManifest({
      roleBaseline: [],
      modelSuggested: ['bash'],
      rulePermissions: { '*': 'allow' },
    }),
    (e: unknown) => {
      assert.ok(e instanceof ManifestError);
      assert.equal(e.code, 'INVALID_ROLE_CONFIG');
      assert.match(e.message, /todo_write/);
      assert.match(e.message, /ask_user_question/);
      return true;
    },
  );
});

test('确定性：同输入两次调用结果逐字相等；非字符串工具项被过滤', () => {
  const sources = {
    roleBaseline: ['read', 'todo_write', 'bash'],
    modelSuggested: ['grep'],
    rulePermissions: { bash: 'ask' },
  } as const;
  assert.deepEqual(composeManifest(sources), composeManifest(sources));

  const dirty = composeManifest({
    roleBaseline: ['read', 'todo_write', 42 as never, null as never],
    modelSuggested: [],
    rulePermissions: {},
  });
  assert.deepEqual(dirty.tools, ['read', 'todo_write']);
});
