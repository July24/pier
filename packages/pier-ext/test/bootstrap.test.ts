/**
 * 档1 bootstrap：cordis 树根（Loader + group builtin + 条件 hmr）。
 * 缝：createCordisApp() → { root, loaderReady, hmrActive }——纯启动逻辑。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCordisApp, detectExposeInternals } from '../src/bootstrap.ts';

test('bootstrap：Loader 挂载成功 + builtins.group 注册（D80③）', async () => {
  const app = await createCordisApp();
  assert.equal(app.loaderReady, true);
  const withLoader = app.root as unknown as {
    loader?: { builtins: Record<string, unknown> };
    get?: (k: string) => unknown;
  };
  assert.ok(withLoader.loader, 'loader service 应在树上');
  assert.ok(withLoader.loader.builtins.group, 'cordis:group builtin 已注册');
  assert.equal(app.hmrActive, false, '无 --expose-internals + PI_HERDR_HMR → hmr 不挂（零 watcher）');
  await app.root.fiber.dispose();
});

test('bootstrap：detectExposeInternals 按当前 execArgv 判定（测试进程通常无旗标）', () => {
  assert.equal(typeof detectExposeInternals(), 'boolean');
  assert.equal(detectExposeInternals(), process.execArgv.includes('--expose-internals'));
});

test('bootstrap：dispose 后树可拆（session_shutdown 路径）', async () => {
  let disposed = false;
  const app = await createCordisApp({ onDispose: () => { disposed = true; } });
  await app.root.fiber.dispose();
  assert.equal(disposed, true, 'onDispose 钩子随树拆除触发');
});
