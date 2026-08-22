/**
 * 档2 Week4-5：worker 执行期强制（tool gate）。
 * websearch Day 1：D77 可见层（planActiveTools——manifest 外工具感知不到）。
 * 限速机制已整体移除（WS-D6）——权限边界归我们，资源配额归插件引入者。
 * 缝：planToolGate(toolName, manifest)（纯决策）；
 *      planActiveTools(manifestTools, currentActive)（交集，空交集不动防清空）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planActiveTools, planToolGate, type RuntimeRoleManifest } from '../src/tool-gate.ts';

const M: RuntimeRoleManifest = {
  role: 'worker-readonly',
  version: '1.1.0',
  tools: ['bash', 'read', 'grep', 'web_search', 'todo_write', 'ask_user_question'],
  permissions: { bash: 'ask', write: 'deny', '*': 'allow' },
};

/* ── planToolGate ──────────────────────────────────────────────── */

test('gate：无 manifest → open（向后兼容：master/纯标签 worker 不强制）', () => {
  assert.deepEqual(planToolGate('bash', null), { kind: 'open' });
});

test('gate：manifest 内且 allow → allow；ask 标记（v1 退化放行+日志）', () => {
  assert.equal(planToolGate('read', M).kind, 'allow');
  const ask = planToolGate('bash', M);
  assert.deepEqual(ask, { kind: 'ask', notice: '[APPROVAL_NEEDED] worker-readonly.bash' });
});

test('gate：不在 tools → deny（reason 含角色与工具名）；权限 deny → deny（双保险）', () => {
  const d1 = planToolGate('write', M); // write 在 permissions 但不在 tools（合成已排除）
  assert.equal(d1.kind, 'deny');
  if (d1.kind === 'deny') {
    assert.match(d1.reason, /worker-readonly/);
    assert.match(d1.reason, /write/);
  }
  const d2 = planToolGate('subagent', M);
  assert.equal(d2.kind, 'deny');
});

/* ── planActiveTools（D77 可见层：manifest 外工具感知不到） ──────── */

test('可见层：交集裁剪——manifest 外工具被隐藏（pi-web-access 多工具插件场景）', () => {
  // 现实场景：插件注册了 web_search/source_check/fetch_content/get_search_content，
  // manifest 只认 web_search → 其余三个从模型视野消失
  const active = ['read', 'bash', 'web_search', 'source_check', 'fetch_content', 'get_search_content', 'todo_write'];
  const plan = planActiveTools(['bash', 'read', 'grep', 'web_search', 'todo_write'], active);
  assert.deepEqual(plan?.next, ['read', 'bash', 'web_search', 'todo_write']);
  assert.equal(plan?.changed, true);
});

test('可见层：无重叠（manifest 全命中）→ changed:false（无需动）', () => {
  const active = ['read', 'bash', 'todo_write'];
  const plan = planActiveTools(['read', 'bash', 'todo_write', 'grep'], active);
  assert.deepEqual(plan?.next, ['read', 'bash', 'todo_write']);
  assert.equal(plan?.changed, false);
});

test('可见层：空交集 → null（fail-open 保留现状，防把工具集清空）', () => {
  // "manifest 列了但一个都没装"（如 web_search 插件装之前的 websearch 别名档案）
  assert.equal(planActiveTools(['web_search'], ['read', 'bash', 'edit']), null);
  assert.equal(planActiveTools([], ['read', 'bash']), null); // 空 manifest 同样防御
  assert.equal(planActiveTools(['read'], []), null); // 现状为空不动
});

/* ── D82 unknownTools 姿态（可见性=信任关系） ───────────────────── */

const STANCE: RuntimeRoleManifest = {
  role: 'worker-default',
  version: '1.3.0',
  tools: ['bash', 'read', 'todo_write'],
  permissions: { subagent: 'deny', terminal_open: 'deny', '*': 'allow' },
  unknownTools: 'allow',
};

test('gate D82：未知工具 + allow → 放行（用户装的扩展，* 兜底）；排除族 deny 仍拒', () => {
  assert.equal(planToolGate('muse_deep_think', STANCE).kind, 'allow'); // 未知工具流入
  assert.equal(planToolGate('subagent', STANCE).kind, 'deny'); // 排除族持禁令（D83）
  assert.equal(planToolGate('terminal_open', STANCE).kind, 'deny');
  assert.equal(planToolGate('bash', STANCE).kind, 'allow'); // 已知工具不受影响
});

test('gate D82：未知工具 + deny（缺省）→ 拒（原语义，M 即缺省形态）', () => {
  assert.equal(planToolGate('subagent', M).kind, 'deny'); // M 无 unknownTools → deny
  const noStance: RuntimeRoleManifest = { ...M, unknownTools: 'deny' };
  assert.equal(planToolGate('muse_deep_think', noStance).kind, 'deny');
});

test('gate D82：未知工具 + allow + *:ask → ask 标记（规则仍适用未知者）', () => {
  const askUnknown: RuntimeRoleManifest = { ...STANCE, permissions: { ...STANCE.permissions, '*': 'ask' } };
  assert.deepEqual(planToolGate('muse_deep_think', askUnknown), {
    kind: 'ask', notice: '[APPROVAL_NEEDED] worker-default.muse_deep_think',
  });
});

test('可见层 D82：allow → 只隐藏显式 deny，未知工具保持可见（不交集裁剪）', () => {
  const active = ['read', 'bash', 'subagent', 'terminal_open', 'muse_deep_think', 'todo_write'];
  const plan = planActiveTools(STANCE.tools, active, {
    unknownTools: STANCE.unknownTools,
    permissions: STANCE.permissions,
  });
  assert.deepEqual(plan?.next, ['read', 'bash', 'muse_deep_think', 'todo_write']);
  assert.equal(plan?.changed, true);
});

test('可见层 D82：allow + 无 deny → changed:false（master 全量场景不动）', () => {
  const active = ['read', 'bash', 'muse_deep_think'];
  const plan = planActiveTools(['read', 'bash'], active, {
    unknownTools: 'allow',
    permissions: { '*': 'allow' },
  });
  assert.deepEqual(plan?.next, active);
  assert.equal(plan?.changed, false);
});
