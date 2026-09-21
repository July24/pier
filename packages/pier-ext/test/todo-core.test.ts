/**
 * Pure todo logic: validate/normalize, edit application, branch folding, the read-hook planner
 * (recite / empty guard / stale notice / archive window) and the stop-reminder decision.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyTodoEdits, boundedView, completionTransitions, currentActivity, foldLatestTodosMeta, fuzzyFind,
  listsEqual, normalizeStrict, revertedCompleted, validateTodos, type TodoItem,
} from '../src/todo-core.ts';
import { planTodoReadHook } from '../src/todo-read-hook.ts';
import { STALE_CLOCK_MS, STALE_NOTICE_MAX, STALE_TURNS } from '../src/stale-core.ts';
import { TODO_REMINDER_CUSTOM_TYPE, planStopTodoReminder, todoReminderGraceMs } from '../src/todo-reminder-core.ts';
import { withCleanup } from './test-utils.ts';
const HOUR = 3_600_000;

/* ── validate / normalize ─────────────────────────────────────── */
test('validateTodos: 合法列表通过并规范化（五态 + phase；空数组 = 清空）', () => {
  const res = validateTodos([
    { content: '搭仓库', status: 'in_progress' },
    { content: '写测试', status: 'pending' },
  ]);
  assert.equal(res.ok, true);
  assert.deepEqual(res.items, [
    { content: '搭仓库', status: 'in_progress' },
    { content: '写测试', status: 'pending' },
  ]);
  assert.deepEqual(validateTodos([]), { ok: true, items: [] });
  const five = validateTodos([
    { content: 'a', status: 'pending', phase: '调研' },
    { content: 'b', status: 'in_progress' },
    { content: 'c', status: 'completed' },
    { content: 'd', status: 'blocked', blocker: '等文档' },
    { content: 'e', status: 'abandoned' },
  ]);
  assert.equal(five.ok, true);
  assert.deepEqual(five.items, [
    { content: 'a', status: 'pending', phase: '调研' },
    { content: 'b', status: 'in_progress' },
    { content: 'c', status: 'completed' },
    { content: 'd', status: 'blocked', blocker: '等文档' },
    { content: 'e', status: 'abandoned' },
  ]);
  // Empty/blank phase is dropped rather than stored; 30 chars is the cap.
  assert.equal(validateTodos([{ content: 'a', status: 'pending', phase: '' }]).ok, true);
  assert.equal(validateTodos([{ content: 'a', status: 'pending', phase: '  ' }]).ok, true);
  assert.equal(validateTodos([{ content: 'a', status: 'pending', phase: 'x'.repeat(30) }]).ok, true);
});

/** Each rejection carries a model-visible reason, so the wording is part of the contract. */
const REJECTED: Array<[string, unknown, RegExp]> = [
  ['非数组', { todos: [] }, /must be an array/],
  ['多余键', [{ content: 'a', status: 'pending', id: 1 }], /unknown field "id"/], // keeps the log snapshot faithful
  ['空 content', [{ content: '   ', status: 'pending' }], /non-empty string/],
  ['重复 content', [{ content: 'a', status: 'pending' }, { content: 'a', status: 'completed' }], /duplicate content "a"/],
  ['非法 status', [{ content: 'a', status: 'doing' }], /pending\|in_progress\|completed/],
  ['phase 超长', [{ content: 'a', status: 'pending', phase: 'x'.repeat(31) }], /`phase` must be a non-empty string ≤ 30 chars/],
  ['phase 类型畸形', [{ content: 'a', status: 'pending', phase: 42 }], /`phase` must be a non-empty string/],
  ['blocker 类型畸形', [{ content: 'a', status: 'blocked', blocker: 123 }], /`blocker` must be a non-empty string/],
  ['blocked 缺非空 blocker', [{ content: 'a', status: 'blocked', blocker: '' }], /`blocker` must be a non-empty string/],
];
test('validateTodos: 硬拒矩阵（形状/字段/类型畸形）', () => {
  for (const [name, input, expected] of REJECTED) {
    const res = validateTodos(input);
    assert.equal(res.ok, false, `${name}: 必须拒`);
    assert.match(res.error!, expected, name);
  }
});
test('validateTodos: in_progress 并行策略（默认允许多条，serial 模式拒第 2 条）', () => {
  const two = [
    { content: 'a', status: 'in_progress' },
    { content: 'b', status: 'in_progress' },
  ];
  assert.equal(validateTodos(two).ok, true, 'pi 工具并行执行的常态');
  const res = validateTodos(two, false);
  assert.equal(res.ok, false);
  assert.match(res.error!, /at most one task may be in_progress \(got 2\)/);
});
test('validateTodos: blocker 归一（非 blocked 态丢弃；空串视为缺省）', () => {
  const drop = validateTodos([{ content: 'a', status: 'completed', blocker: 'x' }]);
  assert.equal(drop.ok, true);
  assert.equal('blocker' in (drop as { items: TodoItem[] }).items[0], false);
  assert.equal(validateTodos([{ content: 'a', status: 'completed', blocker: '' }]).ok, true);
  assert.equal((validateTodos([{ content: 'a', status: 'blocked', blocker: '等审核' }]) as { items: TodoItem[] }).items[0].blocker, '等审核');
});
test('normalizeStrict: 多条 in_progress 保留第一条；无 in_progress 自动晋升第一条 pending', () => {
  assert.deepEqual(normalizeStrict([
    { content: 'a', status: 'in_progress' },
    { content: 'b', status: 'in_progress' },
    { content: 'c', status: 'pending' },
  ]), [
    { content: 'a', status: 'in_progress' },
    { content: 'b', status: 'pending' },
    { content: 'c', status: 'pending' },
  ]);
  assert.deepEqual(normalizeStrict([ // blocked/abandoned do not take part in promotion
    { content: 'a', status: 'blocked', blocker: 'x' },
    { content: 'b', status: 'pending' },
  ]), [
    { content: 'a', status: 'blocked', blocker: 'x' },
    { content: 'b', status: 'in_progress' },
  ]);
  assert.deepEqual(normalizeStrict([{ content: 'a', status: 'completed' }]), [{ content: 'a', status: 'completed' }]);
  assert.deepEqual(normalizeStrict([]), []);
});
test('listsEqual: 全等判定（含 blocker/phase/长度）', () => {
  assert.equal(listsEqual([{ content: 'a', status: 'pending' }], [{ content: 'a', status: 'pending' }]), true);
  assert.equal(listsEqual([{ content: 'a', status: 'pending', phase: 'p' }], [{ content: 'a', status: 'pending' }]), false);
  assert.equal(listsEqual([{ content: 'a', status: 'blocked', blocker: 'x' }], [{ content: 'a', status: 'blocked', blocker: 'y' }]), false);
  assert.equal(listsEqual([{ content: 'a', status: 'pending' }], []), false);
});
test('completionTransitions/revertedCompleted: 过渡与回退', () => {
  const prev: TodoItem[] = [
    { content: 'a', status: 'in_progress' },
    { content: 'b', status: 'pending' },
    { content: 'c', status: 'completed' },
  ];
  const next: TodoItem[] = [
    { content: 'a', status: 'completed' },
    { content: 'b', status: 'completed' },
    { content: 'c', status: 'pending' },
  ];
  assert.deepEqual(completionTransitions(prev, next), ['a', 'b']);
  assert.deepEqual(revertedCompleted(prev, next), ['c']);
});
test('applyTodoEdits: done/drop/rm 语义与幂等', () => {
  const items: TodoItem[] = [
    { content: 'a', status: 'pending' },
    { content: 'b', status: 'in_progress' },
    { content: 'c', status: 'blocked', blocker: 'x' },
    { content: 'd', status: 'completed' },
  ];
  const out = applyTodoEdits(items, [
    { op: 'done', content: 'a' },
    { op: 'drop', content: 'b' },
    { op: 'rm', content: 'c' },
    { op: 'done', content: 'd' }, // completed is terminal (D37)
    { op: 'rm', content: '不存在的' }, // unknown content is a no-op
  ]);
  assert.deepEqual(out, [
    { content: 'a', status: 'completed' },
    { content: 'b', status: 'abandoned' },
    { content: 'd', status: 'completed' },
  ]);
});

/* ── branch folding + pure views ──────────────────────────────── */
const mkSnap = (items: Array<{ content: string; status: string }>, timestamp?: string) => ({
  type: 'message',
  ...(timestamp ? { timestamp } : {}),
  message: { role: 'toolResult', toolName: 'todo_write', details: { 'pi-herdr.todo': { version: 1, items } } },
});
test('foldLatestTodosMeta: 分支上快照 last-wins；无关条目跳过 → null', () => {
  const branch = [
    { type: 'session', version: 3 },
    { type: 'message', message: { role: 'user', content: [] } },
    mkSnap([{ content: '第一步', status: 'completed' }]),
    { type: 'message', message: { role: 'assistant', content: [] } },
    mkSnap([{ content: '第二步', status: 'in_progress' }]),
  ];
  assert.deepEqual(foldLatestTodosMeta(branch as never)?.items, [{ content: '第二步', status: 'in_progress' }]);
  const irrelevant = [
    { type: 'message', message: { role: 'toolResult', toolName: 'read', details: { x: 1 } } },
    { type: 'message', message: { role: 'toolResult', toolName: 'todo_write', details: {} } },
    { type: 'message', message: { role: 'toolResult', toolName: 'todo_write' } },
    { type: 'message', message: { role: 'assistant' } },
    { type: 'session' },
  ];
  assert.equal(foldLatestTodosMeta(irrelevant as never), null, '无任何快照 → null（重建时保留原状态）');
  assert.equal(foldLatestTodosMeta([]), null);
});
test('currentActivity: 取第一条 in_progress 作为活动任务', () => {
  assert.equal(currentActivity([
    { content: 'pending 的', status: 'pending' },
    { content: '正在做的', status: 'in_progress' },
    { content: '另一条并行', status: 'in_progress' },
  ]), '正在做的');
  assert.equal(currentActivity([]), null);
  assert.equal(currentActivity([{ content: 'x', status: 'completed' }]), null);
});
test('fuzzyFind: 精确 → 前缀 → 子串，歧义列出候选', () => {
  const items: TodoItem[] = [
    { content: '修 board 路径 bug', status: 'pending' },
    { content: 'board 渲染', status: 'pending' },
    { content: '路径测试', status: 'pending' },
  ];
  assert.deepEqual(fuzzyFind(items, '修 board 路径 bug'), ['修 board 路径 bug']);
  assert.deepEqual(fuzzyFind(items, 'board'), ['board 渲染'], '唯一前缀命中 → 不进子串层');
  assert.deepEqual(fuzzyFind(items, '路径'), ['路径测试']);
  assert.deepEqual(fuzzyFind(items, '测试'), ['路径测试']);
  const items2: TodoItem[] = [ // no exact/prefix hit → substring tier
    { content: '修 board 路径 bug', status: 'pending' },
    { content: '写 board 测试', status: 'pending' },
  ];
  assert.deepEqual(fuzzyFind(items2, 'bug'), ['修 board 路径 bug']);
  assert.deepEqual(fuzzyFind(items2, '不存在'), []);
});
test('boundedView: 预算内原样；超预算隐最老保最新（open 截头部，completed 尾部填充）', () => {
  const items: TodoItem[] = [
    { content: 'o1', status: 'pending' },
    { content: 'o2', status: 'in_progress' },
    { content: 'c1', status: 'completed' },
  ];
  assert.deepEqual(boundedView(items, 10), { visible: items, hiddenCompleted: 0, hiddenOpen: 0 });
  const big: TodoItem[] = [
    { content: 'o1', status: 'pending' },
    { content: 'o2', status: 'pending' },
    { content: 'o3', status: 'pending' },
    { content: 'c1', status: 'completed' },
    { content: 'c2', status: 'completed' },
  ];
  const v = boundedView(big, 2); // open over budget: keep o2/o3, hide the oldest open and all completed
  assert.deepEqual(v.visible.map((i) => i.content), ['o2', 'o3']);
  assert.equal(v.hiddenOpen, 1);
  assert.equal(v.hiddenCompleted, 2);
  const v2 = boundedView(big, 4); // leftover budget goes to the newest completion (c2), not the oldest
  assert.deepEqual(v2.visible.map((i) => i.content), ['o1', 'o2', 'o3', 'c2']);
  assert.equal(v2.hiddenCompleted, 1);
  assert.equal(v2.hiddenOpen, 0);
});
/* ── read hook (planTodoReadHook) ─────────────────────────────── */

/** Planner input mirrored locally: a drifted field surfaces at the call site. */
interface ReadHookInput { items: readonly TodoItem[]; turn: number; lastEmptyGuardTurn: number | null; lastWriteAt: number | null; turnsSinceWrite: number | null; now: number; staleNotices: number; lastStaleGuardTurn: number | null }

/** Fresh baseline: written 1 turn / 1 minute ago. */
const FRESH: ReadHookInput = {
  items: [],
  turn: 0,
  lastEmptyGuardTurn: null,
  lastWriteAt: 100 * HOUR,
  turnsSinceWrite: 1,
  now: 100 * HOUR + 60_000,
  staleNotices: 0,
  lastStaleGuardTurn: null,
};

/** Real shape: a frozen list, all done (3✓). */
const ALL_DONE: TodoItem[] = [
  { content: 'Verify gateway forwarding', status: 'completed', phase: 'verify' },
  { content: 'Verify APN vs CRM company id', status: 'completed', phase: 'verify' },
  { content: 'Update design doc sections', status: 'completed', phase: 'doc' },
];
const KIMI: TodoItem[] = [{ content: 'Clone kimi', status: 'in_progress' }];
const STALE: Partial<ReadHookInput> = { lastWriteAt: 100 * HOUR, turnsSinceWrite: STALE_TURNS, now: 100 * HOUR + 30 * 60_000 };
const IDLE_16H: Partial<ReadHookInput> = { lastWriteAt: 100 * HOUR, turnsSinceWrite: 1, now: 100 * HOUR + 16 * HOUR };
interface ReadCase {
  name: string; input?: Partial<ReadHookInput>; inject?: boolean; effect?: string; archived?: boolean;
  clearArchived?: boolean; customType?: string; display?: boolean; matches?: RegExp[]; notMatches?: RegExp[];
}
const READ_CASES: ReadCase[] = [
  { name: '新鲜 → 每轮复读（静默注入，自带通道类型）', input: { items: KIMI, turn: 1 }, inject: true, effect: 'recite', display: false, customType: 'pi-herdr.todo-read', matches: [/Clone kimi/] },
  { name: '刚全完成但新鲜 → 照常复读', input: { items: ALL_DONE, turn: 2 }, effect: 'recite' },
  { name: '空列表：会话开始注入一次', input: { items: [], turn: 0 }, inject: true, effect: 'empty-guard', matches: [/empty/] },
  { name: '空列表：N 轮内静默', input: { items: [], turn: 1, lastEmptyGuardTurn: 0 }, inject: false },
  { name: '空列表：N 轮后再守卫', input: { items: [], turn: 4, lastEmptyGuardTurn: 0 }, inject: true },
  { name: 'stale（A）：复读改警告 + 旧条目参照 + 行动指令', input: { items: ALL_DONE, turn: 10, ...STALE }, inject: true, effect: 'stale-notice', matches: [/unchanged for 6 turns, nothing open/, /Verify gateway forwarding/, /todo_write/] },
  { name: 'stale：节奏内未到 → 跳过', input: { items: ALL_DONE, turn: 8, ...STALE, staleNotices: 1, lastStaleGuardTurn: 6 }, inject: false, effect: 'none' },
  { name: 'stale：已封顶 3 → 跳过', input: { items: ALL_DONE, turn: 12, ...STALE, staleNotices: STALE_NOTICE_MAX, lastStaleGuardTurn: 6 }, inject: false, effect: 'none' },
  { name: 'stale：节奏到且未封顶 → 注入', input: { items: ALL_DONE, turn: 12, ...STALE, staleNotices: STALE_NOTICE_MAX - 1, lastStaleGuardTurn: 6 }, inject: true },
  { name: 'archived（R2）：首个到期拍 = 重写窗口，不清空', input: { items: ALL_DONE, turn: 0, ...IDLE_16H }, inject: true, effect: 'stale-notice', archived: true, clearArchived: false, matches: [/rewrite window/i, /about to be archived/, /Verify gateway forwarding/] },
  { name: 'archived：窗口后与空守卫共享节奏 → 静默', input: { items: ALL_DONE, turn: 1, lastEmptyGuardTurn: 0, ...IDLE_16H, staleNotices: 1, lastStaleGuardTurn: 0 }, inject: false },
  {
    name: 'archived（R1/R3）：窗口被无视 → 终态通知 + clearArchived，明细不复读',
    input: { items: ALL_DONE, turn: 4, lastEmptyGuardTurn: 0, ...IDLE_16H, staleNotices: 1, lastStaleGuardTurn: 0 },
    inject: true,
    effect: 'archive-notice',
    archived: true,
    clearArchived: true,
    matches: [/3 completed entries/, /16h ago/, /cleared from tracking.*list is now empty/s, /multi-step work must be tracked/],
    notMatches: [/if tracking is not needed/, /Verify gateway forwarding/],
  },
  { name: 'archived：非到期拍不置 clearArchived', input: { items: ALL_DONE, turn: 5, lastEmptyGuardTurn: 4, ...IDLE_16H, staleNotices: 1, lastStaleGuardTurn: 0 }, inject: false, clearArchived: false },
  { name: 'archived：时钟阈值边界即窗口态（时钟优先于 turns）', input: { items: ALL_DONE, turn: 3, lastWriteAt: 0, turnsSinceWrite: 2, now: STALE_CLOCK_MS }, effect: 'stale-notice', archived: true },
];
test('读钩矩阵：复读 / 空守卫 / 停滞警告 / 归档窗口（同一 planner，不同输入）', async (t) => {
  assert.equal(STALE_NOTICE_MAX, 3);
  for (const c of READ_CASES) {
    await t.test(c.name, () => {
      const plan = planTodoReadHook({ ...FRESH, ...c.input });
      if (c.inject !== undefined) assert.equal(plan.inject, c.inject, c.name);
      if (c.effect !== undefined) assert.equal(plan.effect, c.effect, c.name);
      if (c.archived !== undefined) assert.equal(plan.archived, c.archived, c.name);
      if (c.clearArchived !== undefined) assert.equal(plan.clearArchived, c.clearArchived, c.name);
      if (c.display !== undefined) assert.equal(plan.message.display, c.display, c.name);
      if (c.customType !== undefined) assert.equal(plan.message.customType, c.customType, c.name);
      for (const re of c.matches ?? []) assert.match(plan.message.content, re, c.name);
      for (const re of c.notMatches ?? []) assert.doesNotMatch(plan.message.content, re, c.name);
    });
  }
});

/* ── stop reminder (planStopTodoReminder) ─────────────────────── */

/** Planner input mirrored locally: a drifted field surfaces at the call site. */
interface ReminderInput {
  lastStopReason: string | null; intentionalAbort?: boolean; compactionInFlight?: boolean; reminders: number;
  runningSubs: number; blockedDepth: number; items: ReadonlyArray<{ content: string; status: string }>;
}
const REMINDER_BASE: ReminderInput = {
  lastStopReason: 'end_turn',
  reminders: 0,
  runningSubs: 0,
  blockedDepth: 0,
  items: [
    { content: 'restart CRM user-service', status: 'in_progress' },
    { content: 'push special- fix to repo', status: 'pending' },
    { content: 'verify E2E', status: 'completed' },
    { content: 'old idea', status: 'abandoned' },
    { content: 'wait for ops deploy', status: 'blocked' },
  ],
};
test('stop 提醒常量：通道类型 + 宽限缺省 30s（env 可调，畸形回落）', withCleanup((cleanup) => {
  const env = cleanup.env();
  env.delete('PIER_TODO_GRACE_MS');
  env.delete('PI_HERDR_TODO_GRACE_MS');
  assert.equal(TODO_REMINDER_CUSTOM_TYPE, 'pi-herdr.todo-reminder');
  assert.equal(todoReminderGraceMs(), 30_000);
  env.set('PIER_TODO_GRACE_MS', '50');
  assert.equal(todoReminderGraceMs(), 50, 'env 可调（测试用小值）');
  env.set('PIER_TODO_GRACE_MS', 'not-a-number');
  assert.equal(todoReminderGraceMs(), 30_000, '畸形 env 回落缺省');
}));
interface ReminderCase {
  name: string; over?: Partial<ReminderInput>; due: boolean; nextReminders?: number; matches?: RegExp[]; excludes?: RegExp[];
}

/** One input shape, different guard flags → notice or silence; every case keeps its own claim. */
const REMINDER_CASES: ReminderCase[] = [
  { name: 'open 项 → 注入 ▶/· 前缀 + 计数递增', due: true, nextReminders: 1, matches: [/▶ restart CRM user-service/, /· push special- fix to repo/, /Reminder 1\/3/], excludes: [/verify E2E/, /old idea/, /wait for ops deploy/] }, // completed/abandoned never listed; blocked is not unfinished
  { name: 'null stopReason = 未知 → 视作自然结束，正常评估', over: { lastStopReason: null }, due: true, nextReminders: 1 },
  { name: '编号随计数递增（Reminder n/3）', over: { reminders: 2 }, due: true, nextReminders: 3, matches: [/Reminder 3\/3/] },
  { name: 'ESC 中止后的 settled 不催', over: { lastStopReason: 'aborted' }, due: false, nextReminders: 0 },
  { name: '封顶：已达 3 不再注入', over: { reminders: 3 }, due: false, nextReminders: 3 },
  { name: '在途 subagent：主控本就在等，不催', over: { runningSubs: 2 }, due: false },
  { name: 'blocked 深度 >0：主控在等人工，不催', over: { blockedDepth: 1 }, due: false },
  { name: '无 open 项（全 completed/abandoned/blocked）不触发', over: { items: [{ content: 'done thing', status: 'completed' }, { content: 'dropped thing', status: 'abandoned' }, { content: 'waiting on human', status: 'blocked' }] }, due: false },
  { name: '空列表不触发', over: { items: [] }, due: false },
];
test('stop 提醒：决策矩阵（同形状输入，不同守卫 → 注入或静默）', async (t) => {
  for (const c of REMINDER_CASES) {
    await t.test(c.name, () => {
      const plan = planStopTodoReminder({ ...REMINDER_BASE, ...c.over });
      assert.equal(plan.due, c.due, c.name);
      if (c.nextReminders !== undefined) assert.equal(plan.nextReminders, c.nextReminders, c.name);
      if (!c.due) {
        assert.equal(plan.content, null, c.name);
        return;
      }
      assert.ok(plan.content, c.name);
      for (const re of c.matches ?? []) assert.match(plan.content, re, c.name);
      for (const re of c.excludes ?? []) assert.doesNotMatch(plan.content, re, c.name);
    });
  }
});
test('stop 提醒文案：对账请求而非祈使——问用户是一等出口，blocked 是等人工项的唯一归宿', () => {
  const { content } = planStopTodoReminder(REMINDER_BASE);
  assert.ok(content);
  assert.doesNotMatch(content, /Continue working on them before stopping/); // the old overreach must stay gone
  assert.match(content, /already authorized/);
  assert.match(content, /mark it blocked with a blocker note/);
  assert.match(content, /ask_user_question/);
  assert.match(content, /never execute it yourself/);
  assert.match(content, /todo_write/);
});
