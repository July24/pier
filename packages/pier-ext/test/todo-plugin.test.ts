/** core/todo plugin wiring (tool/command/read-hook, widget slot, tombstone, stop reminder, widgetLines
 *  window) over a real TodosService + fakePi, plus the pane-title pure functions (M22/D68/D96). */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { cordisProvide } from '../src/cordis-services.ts';
import todoPlugin, { widgetLines } from '../src/plugins/todo.ts';
import { TODO_ARCHIVE_WINDOW_CUSTOM_TYPE, todoListHash } from '../src/todo-core.ts';
import type { WorkerWidgetRow } from '../src/tree-view.ts';
import { BLOCKED_LABEL_KEY, formatBlockedLabel, formatPaneTitle, sidebarTodoTokens, staleTokenClearance } from '../src/pane-title.ts';
import { PiSurface } from '../src/pi-surface.ts';
import { DisposeLedger } from '../src/ledger.ts';
import { TodosService } from '../src/todos-service.ts';
import type { TodoItem } from '../src/vocab.ts';
import { fakePi, fire, type FakePi } from './test-utils.ts';

interface TodoDepsOverrides {
  ledger?: DisposeLedger;
  getBlockedDepth?: () => number;
  getWorkers?: () => readonly WorkerWidgetRow[];
  stopReminder?: { getBlockedDepth: () => number; getRunningSubs: () => number };
  mirrorTodos?: () => void;
}

/** One mount fixture for every test: real service + surface, individual deps overridable. */
async function mount(pi: FakePi, over: TodoDepsOverrides = {}) {
  const { ledger, ...rest } = over;
  const todos = new TodosService({ strict: false, allowParallelInProgress: true });
  const surface = new PiSurface(pi as unknown as object, ledger);
  const state: { renderWidget: (ctx: unknown) => void; rerenderWidget?: () => void } = { renderWidget: () => {}, rerenderWidget: () => {} };
  const ctx = new Context();
  cordisProvide(ctx, 'pi-herdr.surface', surface);
  cordisProvide(ctx, 'pi-herdr.todo-deps', {
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
test('core/todo：R1 归档链——窗口落盘标记；下一轮立即终态 rm + 标题/widget 刷新；空守卫接管', async () => {
  const pi = fakePi();
  let mirrored = 0;
  const widgets: string[][] = [];
  const { ctx, todos } = await mount(pi, { mirrorTodos: () => { mirrored += 1; } });
  const hook = pi.listeners.get('before_agent_start')?.[0];
  const eventCtx = { ui: { setWidget: (_id: string, lines: string[]) => { widgets.push(lines); } } };
  const items = [{ content: '探查代码', status: 'completed' }, { content: '写文档', status: 'completed' }] as const;
  todos.replace(items);
  const writtenAt = Date.now() - 2 * 3_600_000; // all done + 2h idle → archived
  todos.lastWriteAt = writtenAt;
  const win = (await hook?.(eventCtx)) as { message?: { content: string } } | undefined;
  assert.match(win?.message?.content ?? '', /rewrite window/i); assert.equal(todos.items.length, 2, '窗口不清空');
  const marker = pi.entries.find(([t]) => t === TODO_ARCHIVE_WINDOW_CUSTOM_TYPE)?.[1] as
    | { version: number; itemsHash: string }
    | undefined;
  assert.ok(marker, '窗口期落盘标记：/resume 后不再重复警告');
  assert.equal(marker.version, 1);
  assert.equal(marker.itemsHash, todoListHash(items));
  assert.equal(todos.archiveWindowOffered, true);

  // The very next run clears: the empty-guard cadence must not delay the terminal notice.
  const mirroredBefore = mirrored;
  const term = (await hook?.(eventCtx)) as { message?: { content: string } } | undefined;
  assert.match(term?.message?.content ?? '', /archived and cleared from tracking/);
  assert.doesNotMatch(term?.message?.content ?? '', /rewrite window/i);
  assert.equal(todos.items.length, 0, 'R1：内存列表已清空');
  assert.equal(mirrored, mirroredBefore + 1, 'clear refreshes the pane title/sidebar mirror');
  assert.deepEqual(widgets.at(-1), [], 'clear refreshes the resident widget');
  const rmEntry = pi.entries.find(([t]) => t === 'pi-herdr.todo-edit') as [string, { edits: Array<{ op: string }> }] | undefined;
  assert.deepEqual(rmEntry?.[1].edits.map((e) => e.op), ['rm', 'rm'], 'rm 全量落盘（rebuild 折叠得空表）');

  // Resume: the same branch folds the marker on rebuild and goes straight to the terminal clear.
  todos.rebuild([
    {
      type: 'message',
      timestamp: new Date(writtenAt).toISOString(),
      message: { role: 'toolResult', toolName: 'todo_write', details: { 'pi-herdr.todo': { version: 1, items } } },
    },
    { type: 'custom', customType: TODO_ARCHIVE_WINDOW_CUSTOM_TYPE, data: marker },
  ]);
  assert.equal(todos.archiveWindowOffered, true, 'resume folds the persisted window offer');
  const resumed = (await hook?.(eventCtx)) as { message?: { content: string } } | undefined;
  assert.match(resumed?.message?.content ?? '', /archived and cleared from tracking/, 'resumed session reaches the clear, not the window again');
  assert.equal(todos.items.length, 0);

  for (let i = 0; i < 3; i++) await hook?.(eventCtx);
  const empty = (await hook?.(eventCtx)) as { message?: { content: string } } | undefined;
  assert.match(empty?.message?.content ?? '', /todo list is empty/i, '空守卫接管');
  await ctx.fiber.dispose();
});

test('pi 1.2 before_agent_start policy: user + compaction continuation only', async () => {
  const pi = fakePi();
  const { ctx, todos } = await mount(pi);
  const hook = pi.listeners.get('before_agent_start')?.[0];
  todos.replace([{ content: 'a', status: 'in_progress' }]);
  const userRun = { messageType: 'user', prompt: 'continue', systemPromptOptions: { sections: {} } };
  const customRun = (customType: string) => ({ messageType: 'custom', message: { customType } });
  assert.ok((await hook?.(userRun)) as { message?: unknown } | undefined);
  assert.equal(await hook?.(customRun('pi-herdr.todo-reminder')), undefined, 'own stop reminder must not re-inject');
  assert.ok((await hook?.(customRun('pi-herdr.compaction-continue'))) as { message?: unknown } | undefined);
  assert.equal(await hook?.(customRun('pi-herdr.config-guide')), undefined, 'config guide is not a user task');
  assert.equal(await hook?.(customRun('third-party.run')), undefined, 'unknown custom runs stay untouched');
  // pi 1.1 has no messageType: preserve the old user-run behavior.
  assert.ok((await hook?.()) as { message?: unknown } | undefined);
  await ctx.fiber.dispose();
});

test('pi 1.2 before_agent_start policy: skipped custom runs do not advance the guard cadence', async () => {
  const pi = fakePi();
  const { ctx, todos } = await mount(pi);
  const hook = pi.listeners.get('before_agent_start')?.[0];
  todos.replace([]);
  const customReminder = { messageType: 'custom', message: { customType: 'pi-herdr.todo-reminder' } };
  const userRun = { messageType: 'user', prompt: 'next', systemPromptOptions: { sections: {} } };
  assert.ok((await hook?.(userRun)) as { message?: unknown } | undefined, 'first empty-list guard');
  for (let i = 0; i < 4; i++) assert.equal(await hook?.(customReminder), undefined);
  assert.equal(await hook?.(userRun), undefined, 'four skipped custom runs must not count as four turns');
  const later = [];
  for (let i = 0; i < 4; i++) later.push(await hook?.(userRun));
  assert.ok(later.some((r) => r !== undefined), 'the guard still fires on real user turns');
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

test('D41 stop 提醒：provider error / agent_settled.aborted / 重试的 turn_start 都不催', async () => {
  const pi = fakePi();
  const { ctx, todos } = await mount(pi, { stopReminder: { getBlockedDepth: () => 0, getRunningSubs: () => 0 } });
  const flush = async (): Promise<void> => { for (let i = 0; i < 4; i++) await Promise.resolve(); };
  todos.replace([{ content: 'finish the migration', status: 'in_progress' }]);
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    // An upstream/provider error is retried by pi: a triggerTurn reminder would join the failing window.
    await fire(pi, 'turn_end', { message: { role: 'assistant', stopReason: 'error' } });
    await fire(pi, 'agent_settled', {});
    mock.timers.tick(60_000);
    await flush();
    assert.equal(pi.sent.length, 0, 'no reminder after an error stop');

    // A scheduled reminder is cancelled when the retry starts a turn (agent_start is not guaranteed).
    await fire(pi, 'turn_end', { message: { role: 'assistant', stopReason: 'end_turn' } });
    await fire(pi, 'agent_settled', {});
    await fire(pi, 'turn_start');
    mock.timers.tick(60_000);
    await flush();
    assert.equal(pi.sent.length, 0, 'the retry turn cancels the pending reminder');

    // agent_settled.aborted is authoritative for ESC mid-tool even when stopReason looks natural.
    await fire(pi, 'turn_end', { message: { role: 'assistant', stopReason: 'end_turn' } });
    await fire(pi, 'agent_settled', { aborted: true });
    mock.timers.tick(60_000);
    await flush();
    assert.equal(pi.sent.length, 0, 'a cancelled settle never schedules a reminder');
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
test('core/todo：widget 槽回填（D113 单行自态）+ 闸门折叠一行、归零恢复（rerender 复用上次 eventCtx）', async () => {
  const pi = fakePi();
  let depth = 0;
  const captured: string[][] = [];
  const widgetCtx = { ui: { setWidget: (_id: string, lines: string[]) => { captured.push(lines); } } };
  const { state } = await mount(pi, { getBlockedDepth: () => depth });
  await todoWrite(pi, [
    { content: 'a', status: 'in_progress' },
    { content: 'b', status: 'pending' },
  ], widgetCtx);
  assert.deepEqual(captured.at(-1), ['▶ a ✓0/2'], '统一 widget：自己一行 = 当前条 + done/total');
  depth = 1;
  state.rerenderWidget?.(); // index enterBlocked path: slot filled by the mount, last ctx reused
  assert.equal(captured.at(-1)?.length, 1, '闸门开着 → 一行摘要');
  assert.match(captured.at(-1)![0]!, /\/todos for all/);
  depth = 0;
  state.rerenderWidget?.(); // index exitBlocked path
  assert.deepEqual(captured.at(-1), ['▶ a ✓0/2'], '闸门释放 → 恢复单行');
});

test('core/todo：worker 行经 getWorkers 挂进统一 widget（master 挂载语义）', async () => {
  const pi = fakePi();
  const captured: string[][] = [];
  const widgetCtx = { ui: { setWidget: (_id: string, lines: string[]) => { captured.push(lines); } } };
  const { state } = await mount(pi, {
    getWorkers: () => [
      { paneId: 'p2', slug: 'fix-auth', description: 'fix auth', kind: 'task', todos: { items: [{ content: 'auth tests', status: 'in_progress' }, { content: 'extract middleware', status: 'completed' }] } },
      { paneId: 'p3', slug: 'migration', description: 'migrate', kind: 'task', todos: { items: [{ content: 'confirm schema', status: 'blocked', blocker: '等人' }] } },
    ],
  });
  await todoWrite(pi, [{ content: 'orchestrate', status: 'in_progress' }], widgetCtx);
  assert.deepEqual(captured.at(-1), [
    '▶ orchestrate ✓0/1',
    '↳ fix-auth ▶ auth tests ✓1/2',
    '↳ migration ■ confirm schema (等人) ✓0/1',
  ]);
  state.rerenderWidget?.();
  assert.equal(captured.length, 2, 'rerender re-reads getWorkers（todo_sync 到达后即刷新）');
});

/* ── widgetLines: unified one-line-per-agent matrix (D113) ────── */
const it = (content: string, status: TodoItem['status'], phase?: string): TodoItem =>
  ({ content, status, ...(phase ? { phase } : {}) }) as TodoItem;
const DONE_LIST = [it('Verify gateway', 'completed', 'verify'), it('Verify ids', 'completed', 'verify'), it('Update doc', 'completed', 'doc')];
const GATED_LIST = [it('Dispatch workers', 'in_progress', 'repro'), it('Wait user', 'blocked'), it('Old done', 'completed', 'repro')];
interface WindowCase {
  name: string; items: TodoItem[]; opts?: { archivedAgeMs?: number; blockedDepth?: number; workers?: readonly WorkerWidgetRow[] };
  exact?: string[]; lines?: number; includes?: string[]; excludes?: string[];
}
const WINDOW_CASES: WindowCase[] = [
  { name: '自态单行：当前条 + done/total（phase 分组退出常驻面）', items: [it('a', 'in_progress', 'P1'), it('b', 'pending', 'P1'), it('c', 'completed', 'P2')], exact: ['▶ a ✓1/3'] },
  { name: '空列表且无 worker → 空行数组（widget 隐藏）', items: [], exact: [] },
  { name: 'blocked 带 blocker 后缀', items: [{ content: 'x', status: 'blocked', blocker: '等审核' } as TodoItem], includes: ['■ waiting on: 等审核', '✓0/1'] },
  { name: '全 completed → widget 隐藏（计数无可操作信息）', items: DONE_LIST, exact: [] },
  { name: 'worker 行：全量条目 → 当前条 + 计数；blocked → 等人', items: [it('发布 npm', 'in_progress')], opts: { workers: [
    { paneId: 'p2', slug: 'fix-auth', description: 'fix auth', todos: { items: [{ content: 'auth tests', status: 'in_progress' }, { content: 'done one', status: 'completed' }] } },
    { paneId: 'p3', slug: 'migration', description: 'migrate', todos: { items: [{ content: 'confirm schema', status: 'blocked', blocker: '等人' }] } },
  ] }, exact: ['▶ 发布 npm ✓0/1', '↳ fix-auth ▶ auth tests ✓1/2', '↳ migration ■ confirm schema (等人) ✓0/1'] },
  { name: '全 completed + worker → 自态隐藏，worker 行保留', items: DONE_LIST, opts: { workers: [
    { paneId: 'p2', slug: 'fix-auth', description: 'fix auth', todos: { items: [{ content: 'auth tests', status: 'in_progress' }] } },
  ] }, exact: ['↳ fix-auth ▶ auth tests ✓0/1'] },
  { name: 'worker 冷缓存：摘要 token 兜底；无 slug 用 paneId+描述', items: [it('a', 'in_progress')], opts: { workers: [
    { paneId: 'p2', slug: 'fix-auth', description: 'fix auth', todos: { summary: '▶1 ○2 ✓0 · wiring' } },
    { paneId: 'p9', description: 'legacy row', todos: null },
  ] }, exact: ['▶ a ✓0/1', '↳ fix-auth · ▶1 ○2 ✓0 · wiring', '↳ p9 · legacy row'] },
  { name: 'worker 超预算折叠：>9 个 running 折计数行指路 /pier-tree', items: [], opts: { workers: Array.from({ length: 12 }, (_, i) => ({ paneId: `p${i}`, slug: `w${i}`, description: `d${i}`, todos: { items: [{ content: `cur${i}`, status: 'in_progress' }] } })) }, lines: 10, includes: ['…+3 more subagents · /pier-tree'] },
  { name: '反冻结：归档一行降权 + worker 仍可见', items: DONE_LIST, opts: { archivedAgeMs: 16 * 3_600_000, workers: [{ paneId: 'p2', slug: 'fix-auth', description: 'fix auth', todos: null }] }, includes: ['archived 16h', '↳ fix-auth'], excludes: ['Verify gateway'] },
  { name: '闸门开着 → 一行摘要（带 /todos 指路，worker 计数）', items: GATED_LIST, opts: { blockedDepth: 1, workers: [{ paneId: 'p2', slug: 'w', description: 'd', todos: null }] }, lines: 1, includes: ['/todos', '↳×1'] },
  { name: '闸门优先于归档', items: DONE_LIST, opts: { blockedDepth: 2, archivedAgeMs: 16 * 3_600_000 }, lines: 1 },
  { name: '深度归零 → 恢复统一行', items: GATED_LIST, opts: { blockedDepth: 0 }, includes: ['▶ Dispatch workers'] },
];
test('widgetLines: 统一状态条矩阵（自态单行 / worker 行 / 冷缓存 / 折叠 / 闸门）', async (t) => {
  for (const c of WINDOW_CASES) {
    await t.test(c.name, () => {
      const lines = widgetLines(c.items, c.opts as Parameters<typeof widgetLines>[1]);
      if (c.exact) {
        assert.deepEqual(lines, c.exact, c.name);
        return;
      }
      const joined = lines.join('\n');
      if (c.lines !== undefined) assert.equal(lines.length, c.lines, c.name);
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
