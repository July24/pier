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
import type { TodoDeps, TodoUiSlot } from './plugins/todo.ts';
import type { TodosService } from './todos-service.ts';
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

/** The six required 'pi-herdr.todo-deps' fields both mounts assemble identically (maxItems mirrors
 * the tool prompt's "at most 15 entries"); masters and workers spread their own optional seams —
 * getWorkers/getBlockedDepth/stopReminder — on top of this base. */
export function baseTodoDeps(m: {
  pi: unknown;
  todos: TodosService;
  todoUi: TodoUiSlot;
  mirrorTodos: () => void;
}): Pick<TodoDeps, 'todos' | 'allowParallelInProgress' | 'maxItems' | 'mirrorTodos' | 'appendEntry' | 'state'> {
  return {
    todos: m.todos,
    allowParallelInProgress: m.todos.config.allowParallelInProgress,
    maxItems: 15,
    mirrorTodos: m.mirrorTodos,
    appendEntry: (customType: string, data: unknown) => {
      // Unchecked cast: pi's ExtensionAPI type omits this optional runtime entry-append seam.
      const pi = m.pi as { appendEntry?: (t: string, d: unknown) => void };
      pi.appendEntry?.(customType, data);
    },
    state: m.todoUi,
  };
}
