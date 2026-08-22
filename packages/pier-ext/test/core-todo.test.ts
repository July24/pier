/**
 * 档1 core/todo 插件接线：surface 挂载 todo_write + /todos /todo 命令 +
 * 读钩 + widget 槽回填 + tombstone。真实 TodosService + 假 pi。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import todoPlugin from '../src/core/todo.ts';
import { PiSurface } from '../src/pi-surface.ts';
import { DisposeLedger } from '../src/ledger.ts';
import { TodosService } from '../src/todos-service.ts';

function fakePi() {
  return {
    tools: new Map<string, { execute?: (...a: unknown[]) => unknown }>(),
    commands: new Map<string, { handler?: (...a: unknown[]) => unknown }>(),
    listeners: new Map<string, Array<(...a: unknown[]) => unknown>>(),
    entries: [] as Array<[string, unknown]>,
    registerTool(def: { name: string; execute?: (...a: unknown[]) => unknown }) {
      this.tools.set(def.name, def);
    },
    registerCommand(name: string, options: { handler?: (...a: unknown[]) => unknown }) {
      this.commands.set(name, options);
    },
    on(event: string, handler: (...a: unknown[]) => unknown) {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), handler]);
    },
    appendEntry(customType: string, data: unknown) {
      this.entries.push([customType, data]);
    },
  };
}

function makeDeps(pi: ReturnType<typeof fakePi>, ledger?: DisposeLedger) {
  const todos = new TodosService({ strict: false, allowParallelInProgress: true });
  const surface = new PiSurface(pi as unknown as object, ledger);
  const calls: string[] = [];
  const state = { renderWidget: (_ctx: unknown) => {} };
  const deps = {
    todos,
    allowParallelInProgress: true,
    maxItems: 15,
    mirrorTodos: () => { calls.push('mirror'); },
    appendEntry: (t: string, d: unknown) => { pi.appendEntry(t, d); void d; },
    state,
  };
  return { todos, surface, deps, calls, state };
}

async function mount(pi: ReturnType<typeof fakePi>, ledger?: DisposeLedger, depsOverride?: { appendEntry?: (t: string, d: unknown) => void }) {
  const m = makeDeps(pi, ledger);
  if (depsOverride?.appendEntry) m.deps.appendEntry = depsOverride.appendEntry;
  const ctx = new Context();
  ctx.provide('pi-herdr.surface', m.surface);
  ctx.provide('pi-herdr.todo-deps', m.deps);
  await ctx.plugin(todoPlugin);
  return { ctx, ...m };
}

test('core/todo：工具/双命令/读钩注册 + widget 槽回填', async () => {
  const pi = fakePi();
  const { ctx, calls, state } = await mount(pi);
  assert.ok(pi.tools.has('todo_write'));
  assert.ok(pi.commands.has('todos'));
  assert.ok(pi.commands.has('todo'));
  assert.ok((pi.listeners.get('before_agent_start') ?? []).length >= 1);
  assert.equal(typeof state.renderWidget, 'function', '槽已回填');

  // todo_write 全链：替换 + 镜像 + 快照 details
  const r = await pi.tools.get('todo_write')?.execute?.(null, {
    todos: [
      { content: 'a', status: 'in_progress' },
      { content: 'b', status: 'pending' },
    ],
  }, undefined, undefined, { ui: {} }) as { content: Array<{ text: string }> };
  assert.match(r.content[0].text, /1 in progress/);
  assert.ok(calls.includes('mirror'), 'mirrorTodos 已调');

  // 空列表首轮：planTodoReadHook 注入提示（message 形态，display:false）
  const hook = pi.listeners.get('before_agent_start')?.[0];
  const injected = (await hook?.()) as { message?: { customType: string } } | undefined;
  assert.ok(injected?.message?.customType, '空列表注入 todo 提示');
  await ctx.fiber.dispose();
});

test('core/todo：墓碑（ledger.disposeKey 本文件）→ 工具 inert + 读钩 no-op', async () => {
  const pi = fakePi();
  const ledger = new DisposeLedger();
  const { ctx } = await mount(pi, ledger);
  const n = ledger.disposeKey(new URL('../src/core/todo.ts', import.meta.url).href);
  assert.equal(n, 1);
  const r = await pi.tools.get('todo_write')?.execute?.(null, { todos: [] }, undefined, undefined, {}) as { content: Array<{ text: string }> };
  assert.match(r.content[0].text, /disposed/);
  const hook = pi.listeners.get('before_agent_start')?.[0];
  assert.equal(await hook?.(), undefined);
  await ctx.fiber.dispose();
});

test('core/todo：/todos unblock 命令端到端（blocked → pending + 权威 appendEntry + 幂等 no-op）', async () => {
  const pi = fakePi();
  const appended: Array<[string, unknown]> = [];
  // mount 依赖 TodoDeps.appendEntry——重挂一个捕获版
  const { ctx, todos } = await mount(pi, undefined, {
    appendEntry: (customType: string, data: unknown) => { appended.push([customType, data]); },
  });
  todos.replace([
    { content: '汇总结果', status: 'blocked', blocker: '等 调研 cordis' },
    { content: '别的', status: 'pending' },
  ]);
  const handler = pi.commands.get('todos')?.handler as (args: string, eventCtx: unknown) => Promise<void>;
  const notes: string[] = [];
  const ui = { notify: (t: string) => { notes.push(t); } };

  // unblock：模糊匹配「汇总」→ 命中 blocked 条目
  await handler('unblock 汇总', { ui });
  assert.equal(todos.items.find((t) => t.content === '汇总结果')?.status, 'pending', '状态回 pending');
  assert.equal(todos.items.find((t) => t.content === '汇总结果')?.blocker, undefined, 'blocker 已清');
  assert.equal(appended.length, 1, '权威 custom 条目已写');
  assert.equal(appended[0][0], 'pi-herdr.todo-edit');
  assert.deepEqual((appended[0][1] as { edits: Array<{ op: string; content: string }> }).edits,
    [{ op: 'unblock', content: '汇总结果' }]);
  assert.ok(notes.some((n) => n.includes('unblocked')), '用户反馈');

  // 幂等：再 unblock 同条（已 pending）→ no change，不再追加权威条目
  await handler('unblock 汇总', { ui });
  assert.equal(appended.length, 1, 'no-op 不追加权威条目');
  assert.ok(notes.some((n) => n.includes('no change')));
  await ctx.fiber.dispose();
});
