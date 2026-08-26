/**
 * D69：before_agent_start 阅读钩子纯规划。
 * 缝：planTodoReadHook（fresh 复读 / 空守卫 / stale 警告 / archived 归档通知）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_GUARD_EVERY_N, planTodoReadHook } from '../src/todo-read-hook.ts';
import { STALE_CLOCK_MS, STALE_NOTICE_MAX, STALE_TURNS } from '../src/stale-core.ts';
import type { TodoItem } from '../src/vocab.ts';

const HOUR = 3_600_000;
/** 实证场景：全完成 3✓（会话 01a03253 冻结列表的形状）。 */
const ALL_DONE: TodoItem[] = [
  { content: 'Verify gateway forwarding', status: 'completed', phase: 'verify' },
  { content: 'Verify APN vs CRM company id', status: 'completed', phase: 'verify' },
  { content: 'Update design doc sections', status: 'completed', phase: 'doc' },
];

/** fresh 基线参数（写入 1 轮前 / 1 分钟前）。 */
const fresh = {
  lastWriteAt: 100 * HOUR,
  turnsSinceWrite: 1,
  now: 100 * HOUR + 60_000,
  staleNotices: 0,
  lastStaleGuardTurn: null,
};

test('每轮注入有界摘要；display=false', () => {
  const plan = planTodoReadHook({
    items: [{ content: 'Clone kimi', status: 'in_progress' }],
    turn: 1,
    lastEmptyGuardTurn: null,
    ...fresh,
  });
  assert.equal(plan.inject, true);
  assert.equal(plan.effect, 'recite');
  assert.equal(plan.message.display, false);
  assert.match(plan.message.content, /Clone kimi/);
  assert.equal(plan.message.customType, 'pi-herdr.todo-read');
});

test('全完成但新鲜 → 仍正常复读（不误伤刚完成的列表）', () => {
  const plan = planTodoReadHook({
    items: ALL_DONE,
    turn: 2,
    lastEmptyGuardTurn: null,
    ...fresh,
  });
  assert.equal(plan.effect, 'recite');
  assert.match(plan.message.content, /todos ▶0 ○0 ■0 ✓3/);
});

test('空列表：会话开始注入一次，之后每 N 轮再守卫', () => {
  assert.equal(EMPTY_GUARD_EVERY_N, 4);
  const first = planTodoReadHook({ items: [], turn: 0, lastEmptyGuardTurn: null, ...fresh });
  assert.equal(first.inject, true);
  assert.equal(first.effect, 'empty-guard');
  assert.match(first.message.content, /empty/);
  const skip = planTodoReadHook({ items: [], turn: 1, lastEmptyGuardTurn: 0, ...fresh });
  assert.equal(skip.inject, false);
  const again = planTodoReadHook({ items: [], turn: 4, lastEmptyGuardTurn: 0, ...fresh });
  assert.equal(again.inject, true);
});

test('stale（A）：≥STALE_TURNS 轮未写 → 复读改警告，附旧条目供改写', () => {
  const plan = planTodoReadHook({
    items: ALL_DONE,
    turn: 10,
    lastEmptyGuardTurn: null,
    lastWriteAt: fresh.lastWriteAt,
    turnsSinceWrite: STALE_TURNS,
    now: fresh.lastWriteAt + 30 * 60_000, // 时钟未到 1h → 走 turns 维度
    staleNotices: 0,
    lastStaleGuardTurn: null,
  });
  assert.equal(plan.inject, true);
  assert.equal(plan.effect, 'stale-notice');
  assert.match(plan.message.content, /unchanged for 6 turns, nothing open/);
  assert.match(plan.message.content, /Verify gateway forwarding/); // 旧条目保留参照
  assert.match(plan.message.content, /todo_write/); // 行动指令
});

test('stale（A）：每 N 轮一次 + 封顶 STALE_NOTICE_MAX', () => {
  assert.equal(STALE_NOTICE_MAX, 3);
  const base = {
    items: ALL_DONE,
    lastEmptyGuardTurn: null,
    lastWriteAt: fresh.lastWriteAt,
    turnsSinceWrite: STALE_TURNS,
    now: fresh.lastWriteAt + 30 * 60_000,
  };
  // 节奏内未到 → 跳过
  const skip = planTodoReadHook({ ...base, turn: 8, staleNotices: 1, lastStaleGuardTurn: 6 });
  assert.equal(skip.inject, false);
  assert.equal(skip.effect, 'none');
  // 节奏到但已封顶 → 跳过
  const capped = planTodoReadHook({ ...base, turn: 12, staleNotices: STALE_NOTICE_MAX, lastStaleGuardTurn: 6 });
  assert.equal(capped.inject, false);
  // 节奏到且未封顶 → 注入
  const due = planTodoReadHook({ ...base, turn: 12, staleNotices: STALE_NOTICE_MAX - 1, lastStaleGuardTurn: 6 });
  assert.equal(due.inject, true);
});

test('archived（B+R2）：首个到期拍 = 重写窗口（stale-notice，带旧条目参照）', () => {
  const base = {
    items: ALL_DONE,
    lastWriteAt: 100 * HOUR,
    turnsSinceWrite: 1,
    now: 100 * HOUR + 16 * HOUR, // 实证：16h 冻结（01a03253）；01a03c0d 同款 1h+ idle
  };
  const first = planTodoReadHook({ ...base, turn: 0, lastEmptyGuardTurn: null, staleNotices: 0, lastStaleGuardTurn: null });
  assert.equal(first.inject, true);
  assert.equal(first.effect, 'stale-notice', 'R2：停滞期首次 → 重写窗口而非终态');
  assert.equal(first.archived, true);
  assert.equal(first.clearArchived, false, '窗口不清空');
  assert.match(first.message.content, /rewrite window/i);
  assert.match(first.message.content, /about to be archived/);
  assert.ok(first.message.content.includes('Verify gateway forwarding'), '窗口附旧条目作改写参照');

  // 节奏共享：窗口后的 3 轮静默（lastEmptyGuardTurn 已记）
  const skip = planTodoReadHook({ ...base, turn: 1, lastEmptyGuardTurn: 0, staleNotices: 1, lastStaleGuardTurn: 0 });
  assert.equal(skip.inject, false, '与空守卫共用节奏：N 轮内不再注入');
});

test('archived（B+R1/R3）：窗口被无视 → 终态通知 + clearArchived + 无 [] 豁免出口', () => {
  const base = {
    items: ALL_DONE,
    lastWriteAt: 100 * HOUR,
    turnsSinceWrite: 1,
    now: 100 * HOUR + 16 * HOUR,
  };
  const second = planTodoReadHook({ ...base, turn: EMPTY_GUARD_EVERY_N, lastEmptyGuardTurn: 0, staleNotices: 1, lastStaleGuardTurn: 0 });
  assert.equal(second.inject, true);
  assert.equal(second.effect, 'archive-notice');
  assert.equal(second.archived, true);
  assert.equal(second.clearArchived, true, 'R1：通知注入即清空内存列表');
  assert.match(second.message.content, /3 completed entries/);
  assert.match(second.message.content, /16h ago/);
  assert.match(second.message.content, /cleared from tracking.*list is now empty/s);
  assert.match(second.message.content, /multi-step work must be tracked/);
  assert.ok(!second.message.content.includes('if tracking is not needed'), 'R3：去掉豁免出口');
  assert.ok(!second.message.content.includes('Verify gateway forwarding'), '终态明细不再复读');
  // 非到期拍：inject false 且不置 clearArchived
  const quiet = planTodoReadHook({ ...base, turn: EMPTY_GUARD_EVERY_N + 1, lastEmptyGuardTurn: EMPTY_GUARD_EVERY_N, staleNotices: 1, lastStaleGuardTurn: 0 });
  assert.equal(quiet.inject, false);
  assert.equal(quiet.clearArchived, false);
});

test('时钟阈值边界：恰好 STALE_CLOCK_MS → archived（时钟优先于 turns；R2 窗口态）', () => {
  const plan = planTodoReadHook({
    items: ALL_DONE,
    turn: 3,
    lastEmptyGuardTurn: null,
    lastWriteAt: 0,
    turnsSinceWrite: 2,
    now: STALE_CLOCK_MS,
    staleNotices: 0,
    lastStaleGuardTurn: null,
  });
  assert.equal(plan.effect, 'stale-notice');
  assert.equal(plan.archived, true, '时钟维度已归档（窗口态）');
});
