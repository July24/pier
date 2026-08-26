/**
 * settled 唤醒决策纯核心（反唤醒风暴；session 01a03bf0 实证）。
 * 缝：planSettleWake（abort 抑制 / D96 去重 / 冷却）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ABORT_STOP_REASON,
  D96_REPEAT_NOTICE_MS,
  planSettleWake,
} from '../src/settle-wake-core.ts';

const SUBS = [{ paneId: 'wA:p6' }, { paneId: 'wA:p7' }];
const KEY = 'wA:p6,wA:p7';
const T0 = 100 * 60_000;

test('常量：abort 语义 + 冷却 10 分钟', () => {
  assert.equal(ABORT_STOP_REASON, 'aborted');
  assert.equal(D96_REPEAT_NOTICE_MS, 10 * 60_000);
});

test('abort 抑制：ESC 中止后的 settled 不做任何唤醒（含有 running subs 的场景）', () => {
  const plan = planSettleWake({
    lastStopReason: 'aborted',
    running: SUBS,
    lastNoticeKey: null,
    lastNoticeAt: 0,
    now: T0,
  });
  assert.equal(plan.wake, false);
  assert.equal(plan.notice, false);
  // 锚点保持（不打乱后续自然 settle 的去重状态）
  assert.equal(plan.noticeKey, null);
  assert.equal(plan.noticeAt, 0);
});

test('自然 settle + 新 running 集合 → 注入 D96 提醒一次', () => {
  const plan = planSettleWake({
    lastStopReason: 'stop',
    running: SUBS,
    lastNoticeKey: null,
    lastNoticeAt: 0,
    now: T0,
  });
  assert.equal(plan.wake, true);
  assert.equal(plan.notice, true);
  assert.equal(plan.noticeKey, KEY);
  assert.equal(plan.noticeAt, T0);
});

test('自激励环抑制：同集合立即再 settle → 不再提醒（实证 30 连注入的解）', () => {
  const plan = planSettleWake({
    lastStopReason: 'stop',
    running: SUBS,
    lastNoticeKey: KEY,
    lastNoticeAt: T0,
    now: T0 + 1000, // 提醒触发的新 run 秒级 settle
  });
  assert.equal(plan.wake, true);
  assert.equal(plan.notice, false);
  assert.equal(plan.noticeKey, KEY, '锚点不变');
});

test('冷却到点：同集合 10 分钟后允许重提醒', () => {
  const plan = planSettleWake({
    lastStopReason: 'stop',
    running: SUBS,
    lastNoticeKey: KEY,
    lastNoticeAt: T0,
    now: T0 + D96_REPEAT_NOTICE_MS,
  });
  assert.equal(plan.notice, true);
  assert.equal(plan.noticeAt, T0 + D96_REPEAT_NOTICE_MS);
});

test('集合变化重置去重：新 sub 加入 → 立即提醒；集合清空 → 锚点复位', () => {
  const grown = planSettleWake({
    lastStopReason: 'stop',
    running: [...SUBS, { paneId: 'wA:p9' }],
    lastNoticeKey: KEY,
    lastNoticeAt: T0,
    now: T0 + 5000,
  });
  assert.equal(grown.notice, true, '集合变化绕过冷却');
  const emptied = planSettleWake({
    lastStopReason: 'stop',
    running: [],
    lastNoticeKey: KEY,
    lastNoticeAt: T0,
    now: T0 + 5000,
  });
  assert.equal(emptied.notice, false);
  assert.equal(emptied.noticeKey, null, '空集合复位锚点（下次新 subs 再提醒）');
});

test('stopReason 未知（null，旧 pi 版本）→ 视作自然结束，不误伤正常提醒', () => {
  const plan = planSettleWake({
    lastStopReason: null,
    running: SUBS,
    lastNoticeKey: null,
    lastNoticeAt: 0,
    now: T0,
  });
  assert.equal(plan.wake, true);
  assert.equal(plan.notice, true);
});
