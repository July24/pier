/**
 * D69：before_agent_start 阅读钩子纯规划。
 * 缝：planTodoReadHook。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_GUARD_EVERY_N, planTodoReadHook } from '../src/todo-read-hook.ts';

test('每轮注入有界摘要；display=false', () => {
  const plan = planTodoReadHook({
    items: [{ content: 'Clone kimi', status: 'in_progress' }],
    turn: 1,
    lastEmptyGuardTurn: null,
  });
  assert.equal(plan.inject, true);
  assert.equal(plan.message.display, false);
  assert.match(plan.message.content, /Clone kimi/);
  assert.equal(plan.message.customType, 'pi-herdr.todo-read');
});

test('空列表：会话开始注入一次，之后每 N 轮再守卫', () => {
  assert.equal(EMPTY_GUARD_EVERY_N, 4);
  const first = planTodoReadHook({ items: [], turn: 0, lastEmptyGuardTurn: null });
  assert.equal(first.inject, true);
  assert.match(first.message.content, /empty/);
  const skip = planTodoReadHook({ items: [], turn: 1, lastEmptyGuardTurn: 0 });
  assert.equal(skip.inject, false);
  const again = planTodoReadHook({ items: [], turn: 4, lastEmptyGuardTurn: 0 });
  assert.equal(again.inject, true);
});
