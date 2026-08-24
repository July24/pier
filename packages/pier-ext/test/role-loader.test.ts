/**
 * 档2 Week1：role 档案加载器。
 * 缝：loadRoleConfig(name, {read}) —— read 注入（默认 node:fs 真读 src/roles/）。
 * 错误分类：ROLE_NOT_FOUND（含路径穿越拦截）/ INVALID_ROLE_CONFIG（校验 issues 全量透出）。
 * v1.1：两层用户目录（workspace → user → builtin）+ 内置名保留（ROLE_RESERVED）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  loadRoleConfig,
  RoleLoaderError,
  roleLayers,
  workspaceRolesDir,
  userRolesDir,
  RESERVED_ROLE_NAMES,
  type LayerReader,
} from '../src/role-loader.ts';

/** 内存档案表模拟读取器（键 = 相对文件名）。 */
function readerWith(files: Record<string, unknown>) {
  return (name: string) => {
    if (name in files) return JSON.stringify(files[name]);
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };
}

const GOOD = {
  role: 'worker-default',
  version: '1.0.0',
  manifest: { tools: ['bash', 'read', 'todo_write', 'ask_user_question'] },
};

test('loadRoleConfig：读档案 + 校验通过 → RoleManifest；默认规则补 {"*":"allow"} 语义留给 compose，loader 不改写', () => {
  const role = loadRoleConfig('worker-default', { read: readerWith({ 'worker-default.json': GOOD }) });
  assert.equal(role.role, 'worker-default');
  assert.deepEqual(role.manifest.tools, GOOD.manifest.tools);
});

test('loadRoleConfig：档案不存在 → ROLE_NOT_FOUND（含角色名）', () => {
  assert.throws(
    () => loadRoleConfig('nope', { read: readerWith({}) }),
    (e: unknown) => {
      assert.ok(e instanceof RoleLoaderError);
      assert.equal(e.code, 'ROLE_NOT_FOUND');
      assert.match(e.message, /nope/);
      return true;
    },
  );
});

test('loadRoleConfig：路径穿越/非法角色名 → ROLE_NOT_FOUND（不触盘）', () => {
  let touched = false;
  const read = () => { touched = true; throw new Error('should not read'); };
  for (const bad of ['../secret', 'a/b', 'A_B', '.hidden', '', 'café']) {
    assert.throws(
      () => loadRoleConfig(bad, { read }),
      (e: unknown) => {
        assert.ok(e instanceof RoleLoaderError);
        assert.equal(e.code, 'ROLE_NOT_FOUND');
        return true;
      },
      `name=${JSON.stringify(bad)}`,
    );
  }
  assert.equal(touched, false, '非法名不应触盘');
});

test('loadRoleConfig：JSON 解析失败 / 校验失败 → INVALID_ROLE_CONFIG（issues 透出）', () => {
  assert.throws(
    () => loadRoleConfig('broken', { read: () => '{not json' }),
    (e: unknown) => {
      assert.ok(e instanceof RoleLoaderError);
      assert.equal(e.code, 'INVALID_ROLE_CONFIG');
      assert.match(e.message, /JSON/);
      return true;
    },
  );
  assert.throws(
    () => loadRoleConfig('bad', { read: readerWith({ 'bad.json': { role: 'bad', version: '1.0', roleType: 'nope', manifest: { tools: [] } } }) }),
    (e: unknown) => {
      assert.ok(e instanceof RoleLoaderError);
      assert.equal(e.code, 'INVALID_ROLE_CONFIG');
      const msg = (e as RoleLoaderError).issues.join('\n');
      assert.match(msg, /version/);
      assert.match(msg, /roleType/); // WS-D8：roleType 已是契约外字段，出现即报
      assert.match(msg, /todo_write/);
      return true;
    },
  );
});

test('loadRoleConfig：档案 role 字段与文件名不一致 → INVALID_ROLE_CONFIG（防错挂）', () => {
  assert.throws(
    () => loadRoleConfig('alpha', { read: readerWith({ 'alpha.json': { ...GOOD, role: 'beta' } }) }),
    (e: unknown) => {
      assert.ok(e instanceof RoleLoaderError);
      assert.equal(e.code, 'INVALID_ROLE_CONFIG');
      assert.match(e.message, /beta/);
      return true;
    },
  );
});

test('内置档案：worker-default / master 两份真实落盘可加载 + D83 镜像防漂移（默认 fs 读取）', async () => {
  const { loadRoleConfig: load } = await import('../src/role-loader.ts');
  for (const name of ['worker-default', 'master']) {
    const role = load(name);
    assert.equal(role.role, name, name);
    assert.match(role.version, /^\d+\.\d+\.\d+$/, name);
    assert.equal(load(name).model, undefined, `${name} 不设 model（进程默认）`);
  }
  // D83 继承制：worker-default.tools ≡ master.tools − subagent 族 − terminal 族（防漂移钉死）
  const EXCLUDED = new Set([
    'subagent', 'resume_subagent', 'list_agents', 'send_message', 'interrupt_agent',
    'terminal_open', 'terminal_send', 'terminal_read', 'terminal_signal', 'terminal_close', 'terminal_list',
  ]);
  const mt = load('master').manifest.tools;
  const wt = load('worker-default').manifest.tools;
  const expected = [...new Set(mt.filter((t) => !EXCLUDED.has(t)))].sort();
  assert.deepEqual([...new Set(wt)].sort(), expected, 'worker 应精确镜像 master 减两族');
  // 排除族必须显式 deny（D82 unknownTools=allow 实装后仍持禁令）
  const wr = load('worker-default').manifest.rules ?? {};
  for (const t of EXCLUDED) assert.equal(wr[t], 'deny', `${t} 应显式 deny`);
  // WS-D7：master 档案含自研核心全量（terminal 族 + subagent 族 + 协调 + 执行）
  for (const need of ['todo_write', 'ask_user_question', 'subagent', 'send_message', 'terminal_open', 'terminal_read', 'pwsh', 'web_search']) {
    assert.ok(mt.includes(need), `master.tools 应含 ${need}`);
  }
  // D82：master/worker 姿态 allow（用户装的扩展默认可见）
  assert.equal(load('master').manifest.unknownTools, 'allow');
  assert.equal(load('worker-default').manifest.unknownTools, 'allow');
});

/* ── v1.1：两层用户目录 + 内置名保留 ─────────────────────────── */

const CUSTOM = {
  role: 'reviewer',
  version: '1.0.0',
  description: '只读审查',
  // C7 基线非空约束：任何角色必须含两件协调工具
  manifest: { tools: ['read', 'grep', 'web_search', 'todo_write', 'ask_user_question'], rules: { write: 'deny', edit: 'deny' } },
};

/** 三层内存 reader：workspace → user → builtin（dirs 由 roleLayers 顺序约定）。 */
function layerReaderWith(byDir: Record<string, Record<string, unknown>>): { read: LayerReader; dirs: string[] } {
  const dirs = roleLayers({ baseDir: 'F:\\ws' }).map((l) => l.dir);
  const keys = Object.keys(byDir);
  // 把 byDir 的键按声明序贴到三层目录（w=workspace / u=user / b=builtin）
  const map = new Map<string, Record<string, unknown>>();
  if (keys[0]) map.set(dirs[0], byDir[keys[0]]);
  if (keys[1]) map.set(dirs[1], byDir[keys[1]]);
  if (keys[2]) map.set(dirs[2], byDir[keys[2]]);
  return {
    dirs,
    read: (dir, fileName) => {
      const files = map.get(dir);
      if (!files || !(fileName in files)) return null;
      return JSON.stringify(files[fileName]);
    },
  };
}

test('v1.1 层序：workspace → user → builtin 优先级（各层命中各自内容）', () => {
  const { read } = layerReaderWith({
    w: { 'reviewer.json': { ...CUSTOM, description: 'ws 层' } },
    u: { 'auditor.json': { ...CUSTOM, role: 'auditor', description: 'user 层' } },
    b: {},
  });
  // workspace 命中
  assert.equal(loadRoleConfig('reviewer', { layerRead: read, baseDir: 'F:\\ws' }).description, 'ws 层');
  // user 命中
  assert.equal(loadRoleConfig('auditor', { layerRead: read, baseDir: 'F:\\ws' }).description, 'user 层');
});

test('v1.1 层序：workspace 覆盖 user（同角色名，高层优先）', () => {
  const { read } = layerReaderWith({
    w: { 'reviewer.json': { ...CUSTOM, description: 'from ws' } },
    u: { 'reviewer.json': { ...CUSTOM, description: 'from user' } },
    b: {},
  });
  assert.equal(loadRoleConfig('reviewer', { layerRead: read, baseDir: 'F:\\ws' }).description, 'from ws');
});

test('v1.1：三层全无 → ROLE_NOT_FOUND（消息含三层查找序）', () => {
  const { read } = layerReaderWith({ b: {} });
  assert.throws(
    () => loadRoleConfig('ghost', { layerRead: read, baseDir: 'F:\\ws' }),
    (e: unknown) => {
      assert.ok(e instanceof RoleLoaderError);
      assert.equal(e.code, 'ROLE_NOT_FOUND');
      assert.match(e.message, /workspace/);
      assert.match(e.message, /user/);
      assert.match(e.message, /builtin/);
      return true;
    },
  );
});

test('v1.1 内置名保留：workspace/user 层定义 master 或 worker-default → ROLE_RESERVED', () => {
  const { read } = layerReaderWith({
    w: { 'master.json': { ...CUSTOM, role: 'master' } },
    u: { 'worker-default.json': { ...CUSTOM, role: 'worker-default' } },
    b: {},
  });
  for (const name of ['master', 'worker-default']) {
    assert.throws(
      () => loadRoleConfig(name, { layerRead: read, baseDir: 'F:\\ws' }),
      (e: unknown) => {
        assert.ok(e instanceof RoleLoaderError);
        assert.equal(e.code, 'ROLE_RESERVED');
        assert.match(e.message, new RegExp(name));
        return true;
      },
    );
  }
  assert.deepEqual([...RESERVED_ROLE_NAMES], ['master', 'worker-default']);
});

test('v1.1 builtinDirect：master 自应用无视 workspace 诱饵，直读内置（d11 活体抓到的边界）', async () => {
  const { readFileSync: rf, existsSync: ex } = await import('node:fs');
  const { ROLES_DIR } = await import('../src/role-loader.ts');
  const mem = layerReaderWith({ w: { 'master.json': { ...CUSTOM, role: 'master' } } }); // 诱饵（version 1.0.0）
  const read: LayerReader = (dir, fileName) => {
    if (dir === ROLES_DIR) return ex(join(dir, fileName)) ? rf(join(dir, fileName), 'utf8') : null; // 内置层走真实 fs（平台原生分隔符）
    return mem.read(dir, fileName);
  };
  // 默认（spawn 语义）：诱饵存在 → 响亮报错
  assert.throws(
    () => loadRoleConfig('master', { layerRead: read, baseDir: 'F:\\ws' }),
    (e: unknown) => {
      assert.equal((e as RoleLoaderError).code, 'ROLE_RESERVED');
      return true;
    },
  );
  // builtinDirect（自应用语义）：跳过用户层 → 真实内置档案（版本 ≠ 诱饵 1.0.0，含 subagent 工具）
  const role = loadRoleConfig('master', { layerRead: read, baseDir: 'F:\\ws', builtinDirect: true });
  assert.notEqual(role.version, '1.0.0');
  assert.ok(role.manifest.tools.includes('subagent'));
});

test('v1.1：命中层校验失败立即报 INVALID_ROLE_CONFIG（不静默落下一层）', () => {
  const { read } = layerReaderWith({
    w: { 'reviewer.json': { ...CUSTOM, manifest: { tools: [] } } }, // 基线空 → 校验失败
    b: { 'reviewer.json': CUSTOM }, // 内置有合法版（不应被静默采用）
  });
  assert.throws(
    () => loadRoleConfig('reviewer', { layerRead: read, baseDir: 'F:\\ws' }),
    (e: unknown) => {
      assert.ok(e instanceof RoleLoaderError);
      assert.equal(e.code, 'INVALID_ROLE_CONFIG');
      assert.match(e.message, /workspace/); // 错误消息标注命中层
      return true;
    },
  );
});

test('v1.1 目录助手：workspaceRolesDir(baseDir) / userRolesDir() 路径形态', () => {
  const WS = process.platform === 'win32' ? 'F:\\ws' : '/ws';
  assert.equal(workspaceRolesDir(WS), join(WS, '.pi-herdr', 'roles'));
  assert.equal(workspaceRolesDir(), join(process.cwd(), '.pi-herdr', 'roles'));
  assert.match(userRolesDir().replace(/\\/g, '/'), /\/\.pi\/agent\/herdr-pi\/roles$/);
  const layers = roleLayers({ baseDir: WS });
  assert.equal(layers.length, 3);
  assert.match(layers[0].dir.replace(/\\/g, '/'), /\.pi-herdr\/roles$/);
  assert.match(layers[2].dir.replace(/\\/g, '/'), /src\/roles$/);
});
