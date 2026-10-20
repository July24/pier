/**
 * Closed set of cordis services this process provides on the root.
 *
 * `ctx.get`/`ctx.provide` also accept an arbitrary string and return `any`, so a raw call plus `as`
 * neither rejects a mistyped key nor a dropped bag field (fe99252). Mounts and plugins go through
 * the helpers below. Instances stay on the root: a plugin-fiber Service would unload them on HMR.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { DisposeLedger } from './ledger.ts';
import type { PiSurface } from './pi-surface.ts';
import type { TerminalDeps } from './plugins/terminal.ts';
import type { TodoDeps } from './plugins/todo.ts';
import type { SubagentDeps } from './plugins/subagent.ts';

export interface PierCordisServices {
  'pi-herdr.ledger': DisposeLedger;
  'pi-herdr.surface': PiSurface<object>;
  'pi-herdr.terminal-deps': TerminalDeps;
  'pi-herdr.todo-deps': TodoDeps;
  'pi-herdr.subagent-deps': SubagentDeps;
}

declare module '@deepseek-ai/cordis' {
  interface Context extends PierCordisServices {}
}

export function cordisProvide<K extends keyof PierCordisServices>(
  ctx: Context,
  key: K,
  value: PierCordisServices[K],
): void {
  ctx.provide(key, value);
}

/** Throws when the root has not provided `key`. `ctx.get` itself returns `T | undefined`. */
export function cordisGet<K extends keyof PierCordisServices>(ctx: Context, key: K): PierCordisServices[K] {
  const value = ctx.get(key) as PierCordisServices[K] | undefined;
  if (value === undefined) throw new Error(`[pi-herdr] cordis service missing: ${key}`);
  return value;
}
