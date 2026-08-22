/**
 * 档1 pi-surface（D79）：pi 注册面代理 + tombstone 补偿。
 * 缝：PiSurface.forModule(key) → scoped 面；disposeModule/ledger.disposeKey 翻墓碑。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PiSurface } from '../src/pi-surface.ts';
import { DisposeLedger } from '../src/ledger.ts';

/** 假 pi：工具表 Map（按名覆盖——镜像 pi dist 实测语义）+ 监听列表。 */
function fakePi() {
  const tools = new Map<string, { execute?: (...a: unknown[]) => unknown }>();
  const listeners = new Map<string, Array<(...a: unknown[]) => unknown>>();
  return {
    tools,
    listeners,
    registerTool(def: { name: string; execute?: (...a: unknown[]) => unknown }) {
      tools.set(def.name, def);
    },
    on(event: string, handler: (...a: unknown[]) => unknown) {
      listeners.set(event, [...(listeners.get(event) ?? []), handler]);
    },
  };
}

async function callTool(pi: ReturnType<typeof fakePi>, name: string, ...a: unknown[]) {
  return pi.tools.get(name)?.execute?.(...a);
}
function emit(pi: ReturnType<typeof fakePi>, event: string, ...a: unknown[]) {
  for (const h of pi.listeners.get(event) ?? []) h(...a);
}

test('surface：alive 期注册直通（工具执行/事件触发）', async () => {
  const pi = fakePi();
  const s = new PiSurface(pi);
  const scoped = s.forModule('core/a');
  let fired = 0;
  scoped.on('session_start', () => { fired++; });
  scoped.registerTool({ name: 't1', execute: async () => 'OK' });
  emit(pi, 'session_start');
  assert.equal(fired, 1);
  assert.equal(await callTool(pi, 't1'), 'OK');
});

test('surface：disposeModule 翻墓碑——handler no-op + 工具 inert', async () => {
  const pi = fakePi();
  const s = new PiSurface(pi);
  const scoped = s.forModule('core/a');
  let fired = 0;
  scoped.on('turn_start', () => { fired++; });
  scoped.registerTool({ name: 't1', execute: async () => 'OK' });
  assert.equal(s.disposeModule('core/a'), true);
  emit(pi, 'turn_start');
  assert.equal(fired, 0, '墓碑后 handler 不再触发（修 hmr 双触发）');
  const r = await callTool(pi, 't1') as { content: Array<{ text: string }> };
  assert.match(r.content[0].text, /disposed/);
  assert.equal(s.disposeModule('core/a'), false, '二次 dispose 幂等 false');
});

test('surface：热换模拟——旧组翻墓碑后同重注册覆盖，新版本生效', async () => {
  const pi = fakePi();
  const s = new PiSurface(pi);
  const v1 = s.forModule('core/a');
  v1.registerTool({ name: 't1', execute: async () => 'v1' });
  let v1Fired = 0;
  v1.on('turn_start', () => { v1Fired++; });
  s.disposeModule('core/a'); // 模拟 hmr 补偿拆旧

  const v2 = s.forModule('core/a'); // 新版本同 key 挂载
  v2.registerTool({ name: 't1', execute: async () => 'v2' });
  let v2Fired = 0;
  v2.on('turn_start', () => { v2Fired++; });

  assert.equal(await callTool(pi, 't1'), 'v2', 'Map.set 覆盖语义：新版本顶掉旧条目');
  emit(pi, 'turn_start');
  assert.equal(v1Fired, 0, '旧 handler 墓碑 no-op（不双触发）');
  assert.equal(v2Fired, 1, '新 handler 单次触发');
});

test('surface：ledger 咬合——disposeKey(模块) 自动翻墓碑', () => {
  const pi = fakePi();
  const ledger = new DisposeLedger();
  const s = new PiSurface(pi, ledger);
  const scoped = s.forModule('core/a');
  let fired = 0;
  scoped.on('session_start', () => { fired++; });
  ledger.disposeKey('core/a'); // hmr/reload 同款路径
  emit(pi, 'session_start');
  assert.equal(fired, 0, '账本补偿即翻墓碑');
});

// 档1 d87 前置：hmr partialReload 真实时序（node_modules/cordis-plugin-hmr 源读证）=
// registry.delete(旧) → reload(新插件重挂，forModule 同 key) → **之后** emit('hmr/reload')
// → bootstrap hook 才 ledger.disposeKey(file)。若 disposeModule 翻「当前组」，
// 翻掉的是新版本正引用的组对象 → 新工具死到货。世代化修复：disposeKey 只收割
// 「登记世代之前的世代」，登记后新挂的世代豁免；挂载时自翻更旧世代。
test('surface：hmr 真实时序——后置 disposeKey 不得杀死新世代（世代化墓碑）', async () => {
  const pi = fakePi();
  const ledger = new DisposeLedger();
  const s = new PiSurface(pi, ledger);
  const KEY = 'file:///F:/repo/src/core/demo.ts';

  // v1 挂载（工具 + 监听）
  const s1 = s.forModule(KEY);
  s1.registerTool({ name: 'demo', execute: async () => 'v1' });
  let v1Fired = 0;
  s1.on('turn_start', () => { v1Fired++; });
  emit(pi, 'turn_start');
  assert.equal(v1Fired, 1, '前置：v1 存活');

  // 模拟 reload()：新插件体执行 → 同 key 再 forModule（v2 工具按名覆盖）
  const s2 = s.forModule(KEY);
  s2.registerTool({ name: 'demo', execute: async () => 'v2' });
  let v2Fired = 0;
  s2.on('turn_start', () => { v2Fired++; });

  // 模拟 emit('hmr/reload')（重挂之后！）→ disposeKey 补偿
  ledger.disposeKey(KEY);

  assert.equal(await callTool(pi, 'demo'), 'v2', '新世代工具必须存活（死到货回归）');
  emit(pi, 'turn_start');
  assert.equal(v1Fired, 1, '旧世代监听自挂载 v2 起已 no-op（不双触发）');
  assert.equal(v2Fired, 1, '新世代监听正常触发');
});
