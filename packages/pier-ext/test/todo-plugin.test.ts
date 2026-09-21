/**
 * core/todo 插件接线：surface 挂载 todo_write + /todos 命令 + 读钩 + widget 槽回填 + tombstone +
 * master stop reminder；外加 widget 活动锚定窗口（用户实证二修：可见区段锚定第一条 in_progress，
 * 无则最后一条 open，预算按渲染行数含 phase 头计 ≤10 行）。真实 TodosService + 假 pi。
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import todoPlugin, { widgetLines } from '../src/plugins/todo.ts';
import { PiSurface } from '../src/pi-surface.ts';
import { DisposeLedger } from '../src/ledger.ts';
import { TodosService } from '../src/todos-service.ts';
import type { TodoItem } from '../src/vocab.ts';

const WIDGET_MAX_LINES = 10;

interface FakePi {
  tools: Map<string, { execute?: (...a: unknown[]) => unknown }>;
  commands: Map<string, { handler?: (...a: unknown[]) => unknown }>;
  listeners: Map<string, Array<(...a: unknown[]) => unknown>>;
  entries: Array<[string, unknown]>;
  sent: Array<{ msg: { customType?: string; content?: string; display?: boolean }; opts?: { deliverAs?: string; triggerTurn?: boolean } }>;
  userSent: string[];
  registerTool(def: { name: string; execute?: (...a: unknown[]) => unknown }): void;
  registerCommand(name: string, options: { handler?: (...a: unknown[]) => unknown }): void;
  on(event: string, handler: (...a: unknown[]) => unknown): void;
  appendEntry(customType: string, data: unknown): void;
  sendMessage(msg: { customType?: string; content?: string; display?: boolean }, opts?: { deliverAs?: string; triggerTurn?: boolean }): Promise<void>;
  sendUserMessage(content: string): Promise<void>;
}

function fakePi(): FakePi {
  const sent: Array<{ msg: { customType?: string; content?: string; display?: boolean }; opts?: { deliverAs?: string; triggerTurn?: boolean } }> = [];
  const userSent: string[] = [];
  return {
    tools: new Map<string, { execute?: (...a: unknown[]) => unknown }>(),
    commands: new Map<string, { handler?: (...a: unknown[]) => unknown }>(),
    listeners: new Map<string, Array<(...a: unknown[]) => unknown>>(),
    entries: [] as Array<[string, unknown]>,
    sent,
    userSent,
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
    sendMessage(
      msg: { customType?: string; content?: string; display?: boolean },
      opts?: { deliverAs?: string; triggerTurn?: boolean },
    ) {
      sent.push({ msg, opts });
      return Promise.resolve();
    },
    sendUserMessage(content: string) {
      userSent.push(content);
      return Promise.resolve();
    },
  };
}

type StopReminder = { getBlockedDepth: () => number; getRunningSubs: () => number };

async function mount(
  pi: FakePi,
  ledger?: DisposeLedger,
  depsOverride?: {
    appendEntry?: (t: string, d: unknown) => void;
    stopReminder?: StopReminder;
    getBlockedDepth?: () => number;
  },
) {
  const todos = new TodosService({ strict: false, allowParallelInProgress: true });
  const surface = new PiSurface(pi as unknown as object, ledger);
  const calls: string[] = [];
  const state = { renderWidget: (_ctx: unknown) => {}, rerenderWidget: () => {} };
  const deps = {
    todos,
    allowParallelInProgress: true,
    maxItems: 15,
    mirrorTodos: () => { calls.push('mirror'); },
    appendEntry: (t: string, d: unknown) => { pi.appendEntry(t, d); },
    state,
    ...(depsOverride?.getBlockedDepth ? { getBlockedDepth: depsOverride.getBlockedDepth } : {}),
    ...(depsOverride?.stopReminder ? { stopReminder: depsOverride.stopReminder } : {}),
    ...(depsOverride?.appendEntry ? { appendEntry: depsOverride.appendEntry } : {}),
  };
  const ctx = new Context();
  ctx.provide('pi-herdr.surface', surface);
  ctx.provide('pi-herdr.todo-deps', deps);
  await ctx.plugin(todoPlugin);
  return { ctx, todos, calls, state };
}

const emit = async (pi: FakePi, ev: string, arg?: unknown) => {
  for (const h of pi.listeners.get(ev) ?? []) await h(arg);
};

test('core/todo：工具/命令/读钩注册 + widget 槽回填 + todo_write 全链', async () => {
  const pi = fakePi();
  const { ctx, calls, state } = await mount(pi);
  assert.ok(pi.tools.has('todo_write'));
  assert.ok(pi.commands.has('todos'));
  assert.ok(!pi.commands.has('todo'), '/todo 导出已删（用户不用）');
  assert.ok((pi.listeners.get('before_agent_start') ?? []).length >= 1);
  assert.equal(typeof state.renderWidget, 'function', '槽已回填');

  const r = await pi.tools.get('todo_write')?.execute?.(null, {
    todos: [
      { content: 'a', status: 'in_progress' },
      { content: 'b', status: 'pending' },
    ],
  }, undefined, undefined, { ui: {} }) as { content: Array<{ text: string }> };
  assert.match(r.content[0].text, /1 in progress/);
  assert.ok(calls.includes('mirror'), 'mirrorTodos 已调');

  // 空列表首轮：planTodoReadHook 注入提示（message 形态，display:false）
  const injected = (await pi.listeners.get('before_agent_start')?.[0]?.()) as { message?: { customType: string } } | undefined;
  assert.ok(injected?.message?.customType, '空列表注入 todo 提示');
  await ctx.fiber.dispose();
});

test('core/todo：墓碑（ledger.disposeKey 本文件）→ 工具 inert + 读钩 no-op', async () => {
  const pi = fakePi();
  const ledger = new DisposeLedger();
  const { ctx } = await mount(pi, ledger);
  const n = ledger.disposeKey(new URL('../src/plugins/todo.ts', import.meta.url).href);
  assert.equal(n, 1);
  const r = await pi.tools.get('todo_write')?.execute?.(null, { todos: [] }, undefined, undefined, {}) as { content: Array<{ text: string }> };
  assert.match(r.content[0].text, /disposed/);
  assert.equal(await pi.listeners.get('before_agent_start')?.[0]?.(), undefined);
  await ctx.fiber.dispose();
});

test('core/todo：/todos unblock 命令端到端（blocked → pending + 权威 appendEntry + 幂等 no-op）', async () => {
  const pi = fakePi();
  const appended: Array<[string, unknown]> = [];
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

  await handler('unblock 汇总', { ui });
  assert.equal(todos.items.find((t) => t.content === '汇总结果')?.status, 'pending', '状态回 pending');
  assert.equal(todos.items.find((t) => t.content === '汇总结果')?.blocker, undefined, 'blocker 已清');
  assert.deepEqual(appended, [['pi-herdr.todo-edit', { version: 1, edits: [{ op: 'unblock', content: '汇总结果' }], ts: appended[0]?.[1] && (appended[0][1] as { ts: number }).ts }]]);
  assert.ok(notes.some((n) => n.includes('unblocked')), '用户反馈');

  await handler('unblock 汇总', { ui });
  assert.equal(appended.length, 1, 'no-op 不追加权威条目');
  assert.ok(notes.some((n) => n.includes('no change')));
  await ctx.fiber.dispose();
});

test('core/todo：R1 归档清空执行链——窗口拍不清，终态拍 rm 全量落盘 + 内存清空 → 空守卫接管', async () => {
  const pi = fakePi();
  const { ctx, todos } = await mount(pi);
  const hook = pi.listeners.get('before_agent_start')?.[0];
  todos.replace([{ content: '探查代码', status: 'completed' }, { content: '写文档', status: 'completed' }]);
  todos.lastWriteAt = Date.now() - 2 * 3_600_000; // 全完成 + 墙钟 2h 前 → archived

  const win = (await hook?.()) as { message?: { content: string } } | undefined;
  assert.match(win?.message?.content ?? '', /rewrite window/i);
  assert.equal(todos.items.length, 2, '窗口不清空');
  assert.ok(!pi.entries.some(([t]) => t === 'pi-herdr.todo-edit'), '窗口不落盘');

  // 与空守卫共用节奏（4 轮）：推到第 5 拍才终态
  for (let i = 0; i < 4; i++) await hook?.();
  assert.equal(todos.items.length, 0, 'R1：内存列表已清空');
  const rmEntry = pi.entries.find(([t]) => t === 'pi-herdr.todo-edit') as [string, { edits: Array<{ op: string }> }] | undefined;
  assert.deepEqual(rmEntry?.[1].edits.map((e) => e.op), ['rm', 'rm'], 'rm 全量落盘（rebuild 折叠得空表）');

  for (let i = 0; i < 3; i++) await hook?.();
  const empty = (await hook?.()) as { message?: { content: string } } | undefined;
  assert.match(empty?.message?.content ?? '', /todo list is empty/i, '空守卫接管');
  await ctx.fiber.dispose();
});

test('D41 stop 提醒：custom 通道 + 宽限窗 + 唤醒取消（决策矩阵见 todo-reminder-core.test.ts）', async () => {
  const pi = fakePi();
  const { ctx, todos } = await mount(pi, undefined, {
    stopReminder: { getBlockedDepth: () => 0, getRunningSubs: () => 0 },
  });
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  };
  todos.replace([{ content: 'push special-fix to repo', status: 'pending' }]);
  await emit(pi, 'turn_end', { message: { role: 'assistant', stopReason: 'end_turn' } });

  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await emit(pi, 'agent_settled');
    mock.timers.tick(29_999);
    await flush();
    assert.equal(pi.sent.length, 0, '宽限窗内不注入');

    await emit(pi, 'agent_start');
    mock.timers.tick(60_000);
    await flush();
    assert.equal(pi.sent.length, 0, '用户已接管，提醒取消');

    await emit(pi, 'agent_settled');
    mock.timers.tick(30_001);
    await flush();
    const { msg, opts } = pi.sent[0]!;
    assert.equal(msg.customType, 'pi-herdr.todo-reminder');
    assert.equal(msg.display, true);
    assert.equal(opts?.deliverAs, 'followUp');
    assert.equal(opts?.triggerTurn, true);
    assert.equal(pi.userSent.length, 0, '不再走 sendUserMessage 用户通道');
    assert.match(msg.content ?? '', /Reconcile the list instead of blindly continuing/);
  } finally {
    mock.timers.reset();
    await ctx.fiber.dispose();
  }
});

test('D41 stop 提醒：未配置 stopReminder 时不注册催办钩子', async () => {
  const pi = fakePi();
  const { ctx } = await mount(pi);
  assert.equal((pi.listeners.get('agent_start') ?? []).length, 0);
  await ctx.fiber.dispose();
});

test('core/todo：闸门深度>0 → widget 折叠一行；归零恢复；rerender 槽生效', async () => {
  const pi = fakePi();
  let depth = 0;
  const captured: string[][] = [];
  const widgetCtx = { ui: { setWidget: (_id: string, lines: string[]) => { captured.push(lines); } } };
  const { state } = await mount(pi, undefined, { getBlockedDepth: () => depth });
  assert.equal(typeof state.rerenderWidget, 'function', 'rerender 槽已回填');

  await pi.tools.get('todo_write')?.execute?.(null, {
    todos: [
      { content: 'a', status: 'in_progress' },
      { content: 'b', status: 'pending' },
    ],
  }, undefined, undefined, widgetCtx);
  state.renderWidget(widgetCtx);
  assert.ok((captured.at(-1) ?? []).length > 1, '闸门关着 → 全量窗口');

  depth = 1;
  state.rerenderWidget(); // index enterBlocked 路径
  const collapsed = captured.at(-1) ?? [];
  assert.equal(collapsed.length, 1, '闸门开着 → 一行摘要');
  assert.match(collapsed[0], /^todo: 1▶ 1○ /);
  assert.match(collapsed[0], /\/todos/);

  depth = 0;
  state.rerenderWidget(); // index exitBlocked 路径
  assert.ok((captured.at(-1) ?? []).length > 1, '闸门释放 → 恢复全量');
});

/* ── widgetLines：活动锚定窗口 ─────────────────────────────────── */

const it = (content: string, status: TodoItem['status'], phase?: string): TodoItem =>
  ({ content, status, ...(phase ? { phase } : {}) }) as TodoItem;

test('widgetLines: 实证场景——老 phase 组 + 最新 open 组，超窗时最新组存活', () => {
  const items = [
    it('改造 packages/pier-ext', 'completed', '打包'),
    it('编写 README', 'completed', '文档'),
    it('更新根目录文档', 'completed', '文档'),
    it('npm pack 验证', 'completed', '验证'),
    it('准备 workflow', 'completed', '发布'),
    it('发布 npm', 'in_progress', '发布'),
    it('打 tag', 'pending'),
    it('验证安装', 'blocked', '验证'),
  ];
  const lines = widgetLines(items);
  assert.ok(lines.length <= WIDGET_MAX_LINES, `widget 自控 ≤${WIDGET_MAX_LINES} 行（实际 ${lines.length}）`);
  const joined = lines.join('\n');
  assert.ok(joined.includes('▶ 发布 npm'), '最新 in_progress 可见');
  assert.ok(joined.includes('■ 验证安装'), 'blocked 可见');
  assert.ok(joined.includes('○ 打 tag'), 'pending 可见');
  assert.ok(!joined.includes('✓ 编写 README'), '老 completed 让位隐藏');
  assert.match(joined, /\+\d+ hidden/, '隐藏计数行存在');
  assert.match(joined, /\/todos/, '指路全量视图');
});

test('widgetLines: 预算内全量显示；空列表 → 空行数组；blocked 带 blocker 后缀', () => {
  const items = [it('a', 'in_progress', 'P1'), it('b', 'pending', 'P1'), it('c', 'completed', 'P2')];
  const lines = widgetLines(items);
  assert.equal(lines[0], 'todo: 1▶ 1○ 0■ 1✓');
  assert.deepEqual(lines.slice(1), ['  [P1]', '  ▶ a', '  ○ b', '  [P2]', '  ✓ c']);
  assert.ok(!lines.some((l) => l.includes('hidden')), '无隐藏行');
  assert.deepEqual(widgetLines([]), []);
  assert.ok(widgetLines([{ content: 'x', status: 'blocked', blocker: '等审核' }]).some((l) => l.includes('■ x — 等审核')));
});

test('widgetLines: 活动锚定滚动——执行到中部时窗口跟着 in_progress 走；无 in_progress 锚定最后一条 open', () => {
  const items = Array.from({ length: 12 }, (_, i) => it(`t${i}`, i === 4 ? 'in_progress' : 'pending'));
  const lines = widgetLines(items);
  const joined = lines.join('\n');
  assert.ok(lines.length <= WIDGET_MAX_LINES, '行数预算');
  assert.ok(joined.includes('▶ t4'), '锚点（正在做）必可见');
  assert.ok(joined.includes('○ t5') && joined.includes('○ t3'), '前后上下文可见（尾部优先）');
  assert.ok(!joined.includes('○ t0'), '远处条目让位');
  assert.match(joined, /\+\d+ hidden/);

  const noActive = widgetLines([
    ...Array.from({ length: 10 }, (_, i) => it(`done${i}`, 'completed')),
    it('next1', 'pending'),
    it('next2', 'pending'),
  ]).join('\n');
  assert.ok(noActive.includes('○ next2') && noActive.includes('○ next1'), '最后一条 open 及其相邻条目可见');
  assert.ok(!noActive.includes('done0'), '老 completed 让位');
});

test('widgetLines: 反冻结——归档列表两行降权；闸门开着一行摘要', () => {
  const items = [
    it('Verify gateway', 'completed', 'verify'),
    it('Verify ids', 'completed', 'verify'),
    it('Update doc', 'completed', 'doc'),
  ];
  const archived = widgetLines(items, { archivedAgeMs: 16 * 3_600_000 });
  assert.equal(archived.length, 2);
  assert.match(archived[0], /todo: 0▶ 0○ 0■ 3✓ · archived 16h/);
  assert.match(archived[1], /\/todos/);
  assert.ok(!archived.some((l) => l.includes('Verify gateway')), '归档后死条目不再占视窗');
  assert.ok(widgetLines(items).some((l) => l.includes('✓ Verify gateway')), '未传归档 → 原有全量渲染');

  const gate = widgetLines([
    it('Dispatch workers', 'in_progress', 'repro'),
    it('Wait user', 'blocked'),
    it('Old done', 'completed', 'repro'),
  ], { blockedDepth: 1 });
  assert.equal(gate.length, 1);
  assert.match(gate[0], /^todo: 1▶ 0○ 1■ 1✓ · \/todos/);
  assert.equal(widgetLines(items, { blockedDepth: 2, archivedAgeMs: 16 * 3_600_000 }).length, 1, '闸门优先于归档');
  assert.ok(widgetLines([
    it('Dispatch workers', 'in_progress', 'repro'),
    it('Wait user', 'blocked'),
    it('Old done', 'completed', 'repro'),
  ], { blockedDepth: 0 }).some((l) => l.includes('Dispatch workers')), '深度归零 → 恢复窗口行为');
});
