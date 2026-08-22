/**
 * 档 0：master 进程内每个 subagent 一个 cordis fiber。
 * pipe / poller / history 的清理走 ctx.effect，dispose LIFO。
 * C3：worker 进程不引入本模块。
 */
import { Context } from '@deepseek-ai/cordis';

export interface ScopeHooks {
  onDispose?: () => void;
}

export function createSessionRoot(hooks: ScopeHooks = {}): Context {
  const root = new Context();
  if (hooks.onDispose) {
    root.effect(() => () => { hooks.onDispose?.(); }, 'session-root');
  }
  return root;
}

export async function mountSubagentScope(
  root: Context,
  paneId: string,
  hooks: ScopeHooks = {},
) {
  return root.plugin({
    name: `subagent:${paneId}`,
    apply(ctx: Context) {
      ctx.effect(() => () => { hooks.onDispose?.(); }, `subagent:${paneId}`);
    },
  }, { paneId });
}

export async function disposeSessionRoot(root: Context): Promise<void> {
  try {
    await root.fiber.dispose();
  } catch {
    /* 二次 dispose 是 no-op */
  }
}
