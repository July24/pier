/**
 * 档1 bootstrap：master 进程的 cordis 树根（D78 挂载树 / D80 生态采用 / D81 三分法）。
 *
 * 形态：Loader 作根插件 → builtins.group 注册（D80③ `cordis:group`）→
 *      timer（hmr 前置依赖，D80②）→ hmr（仅开发姿态：`--expose-internals` 且
 *      env PI_HERDR_HMR=1，缺一即跳过——生产路径零 watcher）。
 *
 * worker 进程不走本模块（C3/D81：短命进程手动 mount，无 loader/hmr）——
 * 与 subagent-scope.ts 同为 master 分支动态 import。
 *
 * 后续：core 模块（todo/subagent/terminal/approval/reconcile 族）逐个迁为
 * loader entry（热换面 = entry，D80③ 手动 mount 不热换）。
 */
import { Context } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import Group from '@deepseek-ai/cordis-plugin-group';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { DisposeLedger } from './ledger.ts';

export interface BootstrapHooks {
  onDispose?: () => void;
}

export interface CordisApp {
  /** 树根（subagent scope 与 lifecycle effect 都挂这里）。 */
  root: Context;
  /** loader service 是否就绪（false = 降级为裸树，行为同档0）。 */
  loaderReady: boolean;
  /** hmr 是否激活（开发姿态才有）。 */
  hmrActive: boolean;
  /** dispose 账本（D80⑤ hmr 补偿 + D79 反注册共用；session_shutdown 走 disposeAll）。 */
  ledger: DisposeLedger;
}

/** node 是否带 --expose-internals（hmr 的硬前提，D80①）。 */
export function detectExposeInternals(): boolean {
  return process.execArgv.some((a) => a === '--expose-internals' || a.startsWith('--expose-internals='));
}

export async function createCordisApp(hooks: BootstrapHooks = {}): Promise<CordisApp> {
  const root = new Context();
  const ledger = new DisposeLedger();
  // 服务注入（cordis 原生 DI）：core entry 用 ctx.get('pi-herdr.ledger') 取账本——
  // （entry config 过不了活实例，loader 会变换 config；provide/get 是 hmr/timer 同款机制）
  root.provide('pi-herdr.ledger', ledger);
  if (hooks.onDispose) {
    root.effect(() => () => { hooks.onDispose?.(); }, 'session-root');
  }
  // 相对名 entry（./core/...）以本文件目录解析
  root.baseUrl = pathToFileURL(path.dirname(fileURLToPath(import.meta.url))).href + '/';

  let loaderReady = false;
  let hmrActive = false;
  try {
    await root.plugin(Loader);
    const withLoader = root as Context & { loader?: { builtins: Record<string, unknown> } };
    if (withLoader.loader) {
      withLoader.loader.builtins.group = Group; // D80③：声明里用 cordis:group 引用
      loaderReady = true;
    }
  } catch (err) {
    console.error(`[pi-herdr] cordis loader degraded (bare tree): ${err instanceof Error ? err.message : String(err)}`);
  }

  if (loaderReady && detectExposeInternals() && process.env.PI_HERDR_HMR === '1') {
    try {
      const withLoader = root as Context & {
        loader?: { create: (o: { name: string; config?: unknown }) => Promise<unknown> };
      };
      await withLoader.loader?.create({ name: '@deepseek-ai/cordis-plugin-timer' });
      await withLoader.loader?.create({
        name: '@deepseek-ai/cordis-plugin-hmr',
        config: {
          root: [path.dirname(fileURLToPath(import.meta.url))],
          debounce: 200,
          ignored: [],
        },
      });
      hmrActive = true;
      console.error('[pi-herdr] hmr active (dev posture: --expose-internals + PI_HERDR_HMR=1)');
      // D80⑤（修正后）：hmr reload **会**拆旧 fiber 的 effect-disposers（registry.delete）——
      // ctx.effect 是 core entry 主拆除机制。本 hook 补的是账本侧：pi-surface 旧世代
      // 收割（d87 世代化：重挂后的 disposeKey 只杀登记世代及之前，新世代豁免）。
      root.on('hmr/reload', (reloads: unknown) => {
        try {
          const files: string[] = [];
          for (const r of (reloads as Map<unknown, { filename?: string }>).values()) {
            if (typeof r?.filename === 'string') files.push(r.filename);
          }
          if (files.length > 0) {
            const n = ledger.disposeKey(files);
            if (n > 0) console.error(`[pi-herdr] ledger: compensated ${n} disposal(s) for ${files.join(', ')}`);
          }
        } catch {
          /* 补偿尽力而为 */
        }
      });
    } catch (err) {
      // D80②：hmr 挂失败不致命——降级为零 watcher，树其余部分照常
      console.error(`[pi-herdr] hmr mount failed (degraded): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { root, loaderReady, hmrActive, ledger };
}
