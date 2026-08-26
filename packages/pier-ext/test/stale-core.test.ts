/**
 * 反冻结纯核心（stale-core）：双条件陈旧度判定 + 年龄显示。
 * 实证锚点：会话 01a03253——全完成 3✓ 列表冻结 16h / 37 轮。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STALE_CLOCK_MS,
  STALE_NOTICE_MAX,
  STALE_TURNS,
  evaluateStaleness,
  formatAge,
  isArchived,
  openTodos,
} from '../src/stale-core.ts';
import type { TodoItem } from '../src/vocab.ts';

const done = (content: string): TodoItem => ({ content, status: 'completed' });
const HOUR = 3_600_000;

const ALL_DONE = [done('Verify gateway'), done('Verify id consistency'), done('Update design doc')];

test('常量：双条件阈值（6 轮 / 1h）与警告封顶 3', () => {
  assert.equal(STALE_TURNS, 6);
  assert.equal(STALE_CLOCK_MS, HOUR);
  assert.equal(STALE_NOTICE_MAX, 3);
});

test('openTodos：pending/in_progress/blocked 计入，completed/abandoned 不计', () => {
  const items: TodoItem[] = [
    { content: 'a', status: 'pending' },
    { content: 'b', status: 'in_progress' },
    { content: 'c', status: 'blocked', blocker: 'x' },
    { content: 'd', status: 'completed' },
    { content: 'e', status: 'abandoned' },
  ];
  assert.equal(openTodos(items), 3);
  assert.equal(openTodos(ALL_DONE), 0);
});

test('fresh：有 open 项的列表无论多老都不判 stale（settled 提醒兜底）', () => {
  const items: TodoItem[] = [done('a'), { content: 'b', status: 'pending' }];
  const st = evaluateStaleness({ items, lastWriteAt: 0, turnsSinceWrite: 999, now: 1e12 });
  assert.equal(st.kind, 'fresh');
  assert.equal(st.open, 1);
});

test('fresh：全完成但写入新鲜（<1h 且 <6 轮）→ 正常复读不警告', () => {
  const st = evaluateStaleness({
    items: ALL_DONE,
    lastWriteAt: 10 * HOUR,
    turnsSinceWrite: 3,
    now: 10 * HOUR + 30 * 60_000,
  });
  assert.equal(st.kind, 'fresh');
});

test('stale（A）：全完成 + ≥6 轮未写（时钟未到）→ turns 维度警告', () => {
  const st = evaluateStaleness({
    items: ALL_DONE,
    lastWriteAt: 10 * HOUR,
    turnsSinceWrite: 6,
    now: 10 * HOUR + 30 * 60_000,
  });
  assert.equal(st.kind, 'stale');
  assert.equal(st.open, 0);
});

test('archived（B）：全完成 + 墙钟 ≥1h → 时钟优先于 turns（即使 0 轮）', () => {
  const st = evaluateStaleness({
    items: ALL_DONE,
    lastWriteAt: 10 * HOUR,
    turnsSinceWrite: 1,
    now: 10 * HOUR + HOUR,
  });
  assert.equal(st.kind, 'archived');
  assert.equal(st.ageMs, HOUR);
});

test('保守：lastWriteAt 未知（旧会话无时间戳）→ 永不 stale/archived', () => {
  const st = evaluateStaleness({ items: ALL_DONE, lastWriteAt: null, turnsSinceWrite: 99, now: 1e12 });
  assert.equal(st.kind, 'stale'); // turns 维度仍可用（进程内轮数已知）
  assert.equal(st.ageMs, null);
  assert.equal(isArchived(ALL_DONE, null, 1e12), false);
});

test('空列表 → fresh（空守卫另有归属）', () => {
  const st = evaluateStaleness({ items: [], lastWriteAt: 0, turnsSinceWrite: 99, now: 1e12 });
  assert.equal(st.kind, 'fresh');
});

test('isArchived：标题路径仅时钟维度', () => {
  const t0 = 100 * HOUR;
  assert.equal(isArchived(ALL_DONE, t0, t0 + HOUR - 1), false);
  assert.equal(isArchived(ALL_DONE, t0, t0 + HOUR), true);
  // open 项存在 → 永不归档
  assert.equal(isArchived([{ content: 'x', status: 'in_progress' }], t0, t0 + 10 * HOUR), false);
});

test('formatAge：m / h（floor）/ d', () => {
  assert.equal(formatAge(45 * 60_000), '45m');
  assert.equal(formatAge(90 * 60_000), '1h');
  assert.equal(formatAge(16 * HOUR), '16h');
  assert.equal(formatAge(50 * HOUR), '2d');
});
