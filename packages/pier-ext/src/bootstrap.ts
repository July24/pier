/**
 * Bootstrap the master Cordis tree (D78 mount topology, D80 ecosystem adoption, D81 split).
 *
 * Loads group, timer and HMR plugins in order so declarations resolve, with HMR as a development-only
 * path (`--expose-internals` plus PIER_HMR=1); production has no watcher. Workers bypass this module
 * (C3/D81): short-lived processes mount manually, and this module plus subagent-poller.ts are the
 * master-only dynamic imports.
 */
import { Context } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import Group from '@deepseek-ai/cordis-plugin-group';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { DisposeLedger } from './ledger.ts';
import { pierOption } from './pier-options.ts';

export interface BootstrapHooks {
  onDispose?: () => void;
}

export interface CordisApp {
  /** Root owns subagent scopes and lifecycle effects. */
  root: Context;
  /** False means the loader was not mounted (bare-tree fallback). */
  loaderReady: boolean;
  hmrActive: boolean;
  /** Shared ledger compensates HMR disposal and handles session_shutdown cleanup. */
  ledger: DisposeLedger;
}

/** HMR requires Node's --expose-internals flag (D80①). */
export function detectExposeInternals(): boolean {
  return process.execArgv.some((a) => a === '--expose-internals' || a.startsWith('--expose-internals='));
}

export async function createCordisApp(hooks: BootstrapHooks = {}): Promise<CordisApp> {
  const root = new Context();
  const ledger = new DisposeLedger();
  // Inject the ledger through Cordis DI because loader transforms entry config and cannot carry live instances.
  root.provide('pi-herdr.ledger', ledger);
  if (hooks.onDispose) {
    root.effect(() => () => { hooks.onDispose?.(); }, 'session-root');
  }
  // Resolve relative entry names (./plugins/...) from this module's directory.
  root.baseUrl = pathToFileURL(path.dirname(fileURLToPath(import.meta.url))).href + '/';

  let loaderReady = false;
  let hmrActive = false;
  try {
    await root.plugin(Loader);
    const withLoader = root as Context & { loader?: { builtins: Record<string, unknown> } };
    if (withLoader.loader) {
      withLoader.loader.builtins.group = Group; // D80③: declarations resolve cordis:group through this builtin.
      loaderReady = true;
    }
  } catch (err) {
    console.error(`[pi-herdr] cordis loader degraded (bare tree): ${err instanceof Error ? err.message : String(err)}`);
  }

  // B10: canonical PIER_HMR, legacy PI_HERDR_HMR.
  if (loaderReady && detectExposeInternals() && pierOption('PIER_HMR') === '1') {
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
      // HMR already disposes old fiber effects; disposeKey additionally retires the older pi-surface
      // generations while keeping generations registered after the reload boundary alive (D80⑤/d87).
      // Cordis' own HMR boundary event (not part of pi's typed Events map).
      (root as unknown as { on(name: string, fn: (reloads: unknown) => void): void }).on('hmr/reload', (reloads: unknown) => {
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
          /* Best-effort compensation; disposal failures are non-fatal. */
        }
      });
    } catch (err) {
      // D80②: a failed HMR mount degrades to zero watchers while the rest of the tree remains usable.
      console.error(`[pi-herdr] hmr mount failed (degraded): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { root, loaderReady, hmrActive, ledger };
}
