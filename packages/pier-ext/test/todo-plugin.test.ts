/** core/todo plugin wiring (tool/command/read-hook, widget slot, tombstone, stop reminder, widgetLines
 *  window) over a real TodosService + fakePi, plus the pane-title pure functions (M22/D68/D96). */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import todoPlugin, { widgetLines } from '../src/plugins/todo.ts';
import { BLOCKED_LABEL_KEY, formatBlockedLabel, formatPaneTitle, sidebarTodoTokens, staleTokenClearance } from '../src/pane-title.ts';
import { PiSurface } from '../src/pi-surface.ts';
import { DisposeLedger } from '../src/ledger.ts';
import { TodosService } from '../src/todos-service.ts';
import type { TodoItem } from '../src/vocab.ts';
import { fakePi, fire, type FakePi } from './test-utils.ts';
const WIDGET_MAX_LINES = 10;
interface TodoDepsOverrides {
  ledger?: DisposeLedger;
  getBlockedDepth?: () => number;
  stopReminder?: { getBlockedDepth: () => number; getRunningSubs: () => number };
}

/** One mount fixture for every test: real service + surface, individual deps overridable. */
async function mount(pi: FakePi, over: TodoDepsOverrides = {}) {
  const { ledger, ...rest } = over;
  const todos = new TodosService({ strict: false, allowParallelInProgress: true });
  const surface = new PiSurface(pi as unknown as object, ledger);
  const state: { renderWidget: (ctx: unknown) => void; rerenderWidget?: () => void } = { renderWidget: () => {}, rerenderWidget: () => {} };
  const ctx = new Context();
  ctx.provide('pi-herdr.surface', surface);
  ctx.provide('pi-herdr.todo-deps', {
    todos,
    allowParallelInProgress: true,
    maxItems: 15,
    state,
    mirrorTodos: () => {},
    appendEntry: (customType: string, data: unknown) => { pi.appendEntry(customType, data); },
    ...rest,
  });
  await ctx.plugin(todoPlugin);
  return { ctx, todos, state };
}

/** Runs todo_write and returns its text payload. */
async function todoWrite(pi: FakePi, todos: unknown, eventCtx: unknown = { ui: {} }) {
  const result = await pi.tools.get('todo_write')?.execute?.(null, { todos }, undefined, undefined, eventCtx);
  return result as { content: Array<{ text: string }> };
}
test('core/todo：工具/命令/读钩注册 + todo_write 全链（完成通知 + 读钩信封）', async () => {
  const pi = fakePi();
  const { ctx } = await mount(pi);
  assert.ok(pi.tools.has('todo_write')); assert.ok(pi.commands.has('todos'));
  assert.ok((pi.listeners.get('before_agent_start') ?? []).length >= 1);
  const r = await todoWrite(pi, [
    { content: 'a', status: 'in_progress' },
    { content: 'b', status: 'pending' },
  ]);
  assert.match(r.content[0].text, /1 in progress/);
  // Loop closure: the write that settles an item reports it back to the caller.
  const done = await todoWrite(pi, [
    { content: 'a', status: 'completed' },
    { content: 'b', status: 'pending' },
  ]);
  assert.match(done.content[0].text, /Completed: a/);
  // The read hook answers with a silently displayed message envelope on an injection turn.
  const injected = (await pi.listeners.get('before_agent_start')?.[0]?.()) as
    | { message?: { customType: string } }
    | undefined;
  assert.ok(injected?.message?.customType, '注入 todo 提示');
  await ctx.fiber.dispose();
});
test('core/todo：墓碑（ledger.disposeKey 本文件）→ 工具 inert + 读钩 no-op', async () => {
  const pi = fakePi();
  const ledger = new DisposeLedger();
  const { ctx } = await mount(pi, { ledger });
  assert.equal(ledger.disposeKey(new URL('../src/plugins/todo.ts', import.meta.url).href), 1);
  const r = await todoWrite(pi, [], {});
  assert.match(r.content[0].text, /disposed/); assert.equal(await pi.listeners.get('before_agent_start')?.[0]?.(), undefined);
  await ctx.fiber.dispose();
});
test('core/todo：/todos unblock 端到端（blocked → pending + 权威 appendEntry + 幂等 no-op）', async () => {
  const pi = fakePi();
  const { ctx, todos } = await mount(pi);
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
  // The human edit is persisted as one authoritative branch entry, so replay rebuilds it.
  const [customType, data] = pi.entries[0] as [string, { version: number; edits: unknown[]; ts: number }];
  assert.equal(customType, 'pi-herdr.todo-edit'); assert.equal(data.version, 1);
  assert.deepEqual(data.edits, [{ op: 'unblock', content: '汇总结果' }]); assert.equal(typeof data.ts, 'number');
  assert.ok(notes.some((n) => n.includes('unblocked')), '用户反馈');
  await handler('unblock 汇总', { ui });
  assert.equal(pi.entries.length, 1, 'no-op 不追加权威条目'); assert.ok(notes.some((n) => n.includes('no change')));
  await ctx.fiber.dispose();
});
test('core/todo：R1 归档清空执行链——窗口拍不清，终态拍 rm 全量落盘 + 内存清空 → 空守卫接管', async () => {
  const pi = fakePi();
  const { ctx, todos } = await mount(pi);
  const hook = pi.listeners.get('before_agent_start')?.[0];
  todos.replace([{ content: '探查代码', status: 'completed' }, { content: '写文档', status: 'completed' }]);
  todos.lastWriteAt = Date.now() - 2 * 3_600_000; // all done + 2h idle → archived
  const win = (await hook?.()) as { message?: { content: string } } | undefined;
  assert.match(win?.message?.content ?? '', /rewrite window/i); assert.equal(todos.items.length, 2, '窗口不清空');
  assert.ok(!pi.entries.some(([t]) => t === 'pi-herdr.todo-edit'), '窗口不落盘');
  // Same cadence as the empty guard (4 turns), so the terminal notice lands on the 5th pass.
  for (let i = 0; i < 4; i++) await hook?.();
  assert.equal(todos.items.length, 0, 'R1：内存列表已清空');
  const rmEntry = pi.entries.find(([t]) => t === 'pi-herdr.todo-edit') as [string, { edits: Array<{ op: string }> }] | undefined;
  assert.deepEqual(rmEntry?.[1].edits.map((e) => e.op), ['rm', 'rm'], 'rm 全量落盘（rebuild 折叠得空表）');
  for (let i = 0; i < 3; i++) await hook?.();
  const empty = (await hook?.()) as { message?: { content: string } } | undefined;
  assert.match(empty?.message?.content ?? '', /todo list is empty/i, '空守卫接管');
  await ctx.fiber.dispose();
});

/* ── stop reminder wiring ─────────────────────────────────────── */
test('D41 stop 提醒：custom 通道 + 宽限窗 + 唤醒取消（决策矩阵见 todo-core.test.ts）', async () => {
  const pi = fakePi();
  const { ctx, todos } = await mount(pi, { stopReminder: { getBlockedDepth: () => 0, getRunningSubs: () => 0 } });
  const flush = async (): Promise<void> => { for (let i = 0; i < 4; i++) await Promise.resolve(); };
  todos.replace([{ content: 'push special-fix to repo', status: 'pending' }]);
  await fire(pi, 'turn_end', { message: { role: 'assistant', stopReason: 'end_turn' } });
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await fire(pi, 'agent_settled');
    mock.timers.tick(29_999);
    await flush();
    assert.equal(pi.sent.length, 0, '宽限窗内不注入');
    await fire(pi, 'agent_start');
    mock.timers.tick(60_000);
    await flush();
    assert.equal(pi.sent.length, 0, '用户已接管，提醒取消');
    await fire(pi, 'agent_settled');
    mock.timers.tick(30_001);
    await flush();
    const { msg, opts } = pi.sent[0]!;
    assert.equal(msg.customType, 'pi-herdr.todo-reminder'); assert.equal(msg.display, true);
    assert.equal(opts?.deliverAs, 'followUp'); assert.equal(opts?.triggerTurn, true);
    assert.equal(pi.userSent.length, 0, '不再走 sendUserMessage 用户通道'); assert.match(String(msg.content ?? ''), /Reconcile the list instead of blindly continuing/);
  } finally {
    mock.timers.reset();
    await ctx.fiber.dispose();
  }
});
test('D41 stop 提醒：投递即计数，封顶 3 次后不再注入（pi.sendMessage 返回 void）', async () => {
  const pi = fakePi();
  const { ctx, todos } = await mount(pi, { stopReminder: { getBlockedDepth: () => 0, getRunningSubs: () => 0 } });
  const flush = async (): Promise<void> => { for (let i = 0; i < 4; i++) await Promise.resolve(); };
  todos.replace([{ content: 'push special-fix to repo', status: 'pending' }]);
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    // The counter has to advance on delivery: it used to ride `send(...).then(...)`, and pi's
    // fire-and-forget sendMessage returns void — the throw was swallowed, so every settle sent
    // "Reminder 1/3" again and the cap never engaged.
    for (let round = 1; round <= 3; round += 1) {
      await fire(pi, 'turn_end', { message: { role: 'assistant', stopReason: 'end_turn' } });
      await fire(pi, 'agent_settled');
      mock.timers.tick(30_001);
      await flush();
      assert.equal(pi.sent.length, round, `round ${round}: exactly one reminder is delivered`);
      assert.match(String(pi.sent[round - 1]!.msg.content ?? ''), new RegExp(`Reminder ${round}/3`));
    }
    // Capped: a further settle must stay silent even after a full grace window.
    await fire(pi, 'turn_end', { message: { role: 'assistant', stopReason: 'end_turn' } });
    await fire(pi, 'agent_settled');
    mock.timers.tick(60_000);
    await flush();
    assert.equal(pi.sent.length, 3, 'the third reminder is the last one');
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

/* ── widget slot wiring ───────────────────────────────────────── */
test('core/todo：widget 槽回填 + 闸门深度 >0 折叠一行、归零恢复（rerender 复用上次 eventCtx）', async () => {
  const pi = fakePi();
  let depth = 0;
  const captured: string[][] = [];
  const widgetCtx = { ui: { setWidget: (_id: string, lines: string[]) => { captured.push(lines); } } };
  const { state } = await mount(pi, { getBlockedDepth: () => depth });
  await todoWrite(pi, [
    { content: 'a', status: 'in_progress' },
    { content: 'b', status: 'pending' },
  ], widgetCtx);
  assert.ok((captured.at(-1) ?? []).length > 1, '闸门关着 → 全量窗口');
  depth = 1;
  state.rerenderWidget?.(); // index enterBlocked path: slot filled by the mount, last ctx reused
  assert.equal(captured.at(-1)?.length, 1, '闸门开着 → 一行摘要');
  depth = 0;
  state.rerenderWidget?.(); // index exitBlocked path
  assert.ok((captured.at(-1) ?? []).length > 1, '闸门释放 → 恢复全量');
});

/* ── widgetLines: activity-anchored window ────────────────────── */
const it = (content: string, status: TodoItem['status'], phase?: string): TodoItem =>
  ({ content, status, ...(phase ? { phase } : {}) }) as TodoItem;
const DONE_LIST = [it('Verify gateway', 'completed', 'verify'), it('Verify ids', 'completed', 'verify'), it('Update doc', 'completed', 'doc')];
const GATED_LIST = [it('Dispatch workers', 'in_progress', 'repro'), it('Wait user', 'blocked'), it('Old done', 'completed', 'repro')];
interface WindowCase {
  name: string; items: TodoItem[]; opts?: { archivedAgeMs?: number; blockedDepth?: number };
  /** `exact` pins the full render; the summary token format is owned by that case alone. */
  exact?: string[]; lines?: number; budget?: boolean; hidden?: boolean; includes?: string[]; excludes?: string[];
}
const WINDOW_CASES: WindowCase[] = [
  { name: '预算内全量：摘要 token + phase 分组渲染', items: [it('a', 'in_progress', 'P1'), it('b', 'pending', 'P1'), it('c', 'completed', 'P2')], exact: ['todo: 1▶ 1○ 0■ 1✓', '  [P1]', '  ▶ a', '  ○ b', '  [P2]', '  ✓ c'] },
  { name: '空列表 → 空行数组', items: [], exact: [] },
  { name: 'blocked 带 blocker 后缀', items: [{ content: 'x', status: 'blocked', blocker: '等审核' } as TodoItem], includes: ['■ x — 等审核'] },
  {
    name: '实证场景：老 phase 组让位，最新 open 组存活',
    items: [it('改造 packages/pier-ext', 'completed', '打包'), it('编写 README', 'completed', '文档'), it('更新根目录文档', 'completed', '文档'), it('npm pack 验证', 'completed', '验证'), it('准备 workflow', 'completed', '发布'), it('发布 npm', 'in_progress', '发布'), it('打 tag', 'pending'), it('验证安装', 'blocked', '验证')],
    budget: true, hidden: true,
    includes: ['▶ 发布 npm', '■ 验证安装', '○ 打 tag', '/todos'], excludes: ['✓ 编写 README'],
  },
  { name: '活动锚定滚动：窗口跟着中部 in_progress 走', items: Array.from({ length: 12 }, (_, i) => it(`t${i}`, i === 4 ? 'in_progress' : 'pending')), budget: true, hidden: true, includes: ['▶ t4', '○ t5', '○ t3'], excludes: ['○ t0'] },
  { name: '无 in_progress → 锚定最后一条 open', items: [...Array.from({ length: 10 }, (_, i) => it(`done${i}`, 'completed')), it('next1', 'pending'), it('next2', 'pending')], includes: ['○ next2', '○ next1'], excludes: ['done0'] },
  { name: '反冻结：归档列表两行降权，死条目不再占视窗', items: DONE_LIST, opts: { archivedAgeMs: 16 * 3_600_000 }, lines: 2, includes: ['archived 16h', '/todos'], excludes: ['Verify gateway'] },
  { name: '未传归档 → 原有全量渲染', items: DONE_LIST, includes: ['✓ Verify gateway'] },
  { name: '闸门开着 → 一行摘要（带 /todos 指路）', items: GATED_LIST, opts: { blockedDepth: 1 }, lines: 1, includes: ['/todos'] },
  { name: '闸门优先于归档', items: DONE_LIST, opts: { blockedDepth: 2, archivedAgeMs: 16 * 3_600_000 }, lines: 1 },
  { name: '深度归零 → 恢复窗口行为', items: GATED_LIST, opts: { blockedDepth: 0 }, includes: ['Dispatch workers'] },
];
test('widgetLines: 窗口矩阵（预算内全量 / 活动锚定 / 归档降权 / 闸门折叠）', async (t) => {
  for (const c of WINDOW_CASES) {
    await t.test(c.name, () => {
      const lines = widgetLines(c.items, c.opts);
      if (c.exact) {
        assert.deepEqual(lines, c.exact, c.name);
        return;
      }
      const joined = lines.join('\n');
      if (c.budget) assert.ok(lines.length <= WIDGET_MAX_LINES, `widget 自控 ≤${WIDGET_MAX_LINES} 行（实际 ${lines.length}）`);
      if (c.lines !== undefined) assert.equal(lines.length, c.lines, c.name);
      if (c.hidden) assert.match(joined, /\+\d+ hidden/, '隐藏计数行存在');
      for (const s of c.includes ?? []) assert.ok(joined.includes(s), `${c.name}: 应含 ${s}`);
      for (const s of c.excludes ?? []) assert.ok(!joined.includes(s), `${c.name}: 不该含 ${s}`);
    });
  }
});

/* ── pane-title pure functions (M22: the title is the kanban, D68 formula) ── */
test('formatPaneTitle: 计数 + 标题选取（D91 四件套 ▶○■✓）；空列表 → null（clear_title）', () => {
  assert.equal(formatPaneTitle([]), null); assert.equal(formatPaneTitle([], '调研 kimi'), null);
  assert.equal(
    formatPaneTitle([
      { content: 'pending 的', status: 'pending' },
      { content: 'Clone kimi-code', status: 'in_progress' },
      { content: '另一条并行', status: 'in_progress' },
      { content: '已完成', status: 'completed' },
    ]),
    '▶2 ○1 ■0 ✓1 · Clone kimi-code',
  );
  assert.equal(
    formatPaneTitle([{ content: '卡住', status: 'blocked', blocker: '等确认' }, { content: '写测试', status: 'pending' }], '调研'),
    '▶0 ○1 ■1 ✓0 · 调研',
  );
  // no in_progress → the fallback label; without one, counts only
  const pendingOnly = [{ content: '写测试', status: 'pending' as const }];
  assert.equal(formatPaneTitle(pendingOnly, '调研'), '▶0 ○1 ■0 ✓0 · 调研'); assert.equal(formatPaneTitle(pendingOnly), '▶0 ○1 ■0 ✓0');
});

test('formatPaneTitle: M16 progressSuffix 拼进计数后（保守/ETA/空）；超 TITLE_MAX 本地先裁', () => {
  const items = [
    { content: 'a', status: 'in_progress' as const },
    { content: 'b', status: 'pending' as const },
    { content: 'c', status: 'completed' as const },
  ];
  assert.equal(formatPaneTitle(items, null, { progressSuffix: '1/3' }), '▶1 ○1 ■0 ✓1 (1/3) · a');
  assert.equal(formatPaneTitle(items, null, { progressSuffix: '1/3 ~4m' }), '▶1 ○1 ■0 ✓1 (1/3 ~4m) · a');
  assert.equal(formatPaneTitle(items, null, {}), '▶1 ○1 ■0 ✓1 · a'); assert.equal(formatPaneTitle(items, null, { progressSuffix: '' }), '▶1 ○1 ■0 ✓1 · a');

  // herdr truncates title/state_label at 80 characters, so the clip has to happen locally first
  const title = formatPaneTitle([{ content: 'x'.repeat(200), status: 'in_progress' }]);
  assert.ok(title); assert.equal(title.length, 80);
  assert.equal(title.slice(0, 8), '▶1 ○0 ■0');
});

test('formatPaneTitle: 反冻结（stale-core D）——归档列表降权为 ✓N done <age>', () => {
  const done3 = [
    { content: 'Verify gateway', status: 'completed' as const },
    { content: 'Verify ids', status: 'completed' as const },
    { content: 'Update doc', status: 'completed' as const },
  ];
  const t0 = 100 * 3_600_000;
  // no lastWriteAt (older callers) → unchanged behaviour (the full four-glyph summary)
  assert.equal(formatPaneTitle(done3, null, {}), '▶0 ○0 ■0 ✓3');
  // fresh (<1h) → full weight
  assert.equal(formatPaneTitle(done3, null, { lastWriteAt: t0, now: t0 + 30 * 60_000 }), '▶0 ○0 ■0 ✓3');
  // archived (≥1h) → `✓3 done <age>`; a dead list no longer poses as the current state
  assert.equal(formatPaneTitle(done3, null, { lastWriteAt: t0, now: t0 + 16 * 3_600_000 }), '✓3 done 16h');
  // any open item → never archived, however old the list is
  const withOpen = [...done3, { content: 'next', status: 'in_progress' as const }];
  assert.equal(formatPaneTitle(withOpen, null, { lastWriteAt: t0, now: t0 + 48 * 3_600_000 }), '▶1 ○0 ■0 ✓3 · next');
});

test('formatBlockedLabel: 取第一条 blocked 的 blocker；无 blocked → null', () => {
  assert.equal(formatBlockedLabel([{ content: 'a', status: 'pending' }]), null);
  assert.equal(formatBlockedLabel([{ content: '等文档', status: 'blocked', blocker: '人类确认范围' }]), '人类确认范围');
  assert.equal(formatBlockedLabel([{ content: '卡住了', status: 'blocked' }]), '卡住了');
});

test('herdr token maps: stale 清理为 16 个 null 键；侧栏日报只带 pi-todo', () => {
  const tokens = staleTokenClearance();
  assert.equal(Object.keys(tokens).length, 16); assert.equal(tokens['pi-herdr'], null);
  for (let i = 0; i < 15; i += 1) assert.equal(tokens[`pi-herdr-${i}`], null);
  // the blocked state_label key herdr accepts (anything else is rejected as invalid_state_label)
  assert.equal(BLOCKED_LABEL_KEY, 'blocked');

  const withTodo = sidebarTodoTokens('▶1 ○0 ■0 ✓0 · a');
  assert.equal(withTodo['pi-todo'], '▶1 ○0 ■0 ✓0 · a'); assert.equal(Object.keys(withTodo).length, 1);
  // no todo: an empty string (herdr patch semantics delete the key instead of keeping a stale summary)
  assert.equal(sidebarTodoTokens(null)['pi-todo'], '');
  // D96: the stale cleanup is never merged into the daily report (stale 16 + pi-todo 1 = 17 > herdr's
  // tokens maxProperties=16, which rejects the whole request and drops title and tokens alike).
  const daily = sidebarTodoTokens('t');
  assert.ok(!('pi-herdr' in daily), 'the daily report carries pi-todo only, never the stale chunks'); assert.deepEqual(Object.keys(daily), ['pi-todo']);
});
