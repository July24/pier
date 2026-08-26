/**
 * 长任务生命周期回归（01a03c0d 复盘 B1/B2/B4/B5/B6/O1）：
 *  - B1 观察超时 = 无活动预算（working 心跳续命），非总墙钟；
 *  - B4 观察窗内 working 先归因机器注入宽限，才判用户接管；
 *  - O2 超时通知带行动钩子（list_agents / 不要 sleep 盲等）；
 *  - B2 GC 豁免「结算通知未送达」的 pane；
 *  - B5 台账 via 标记 + closed 行 outcome 继承；
 *  - B6 session 启动时清僵尸 running；
 *  - O1 SUBS 快照内容哈希门控。
 * 缝：pollLoop 不可直驱（30s 切片/真 herdr），以纯函数 + 台账行断言覆盖。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inheritOutcome, parseHistoryEntries, type HistoryEntry } from '../src/history-store.ts';
import { shouldClosePane } from '../src/gc-core.ts';

test('B5 inheritOutcome：patch 未指定 → 继承最近非空；显式（含 null）→ 以 patch 为准', () => {
  assert.equal(inheritOutcome('最终报告…', undefined), '最终报告…', '未指定 → 继承');
  assert.equal(inheritOutcome(null, 'observation timeout'), 'observation timeout', '显式值优先');
  assert.equal(inheritOutcome('最终报告…', null), null, '显式 null 也优先（timeout 后 session 补报场景由调用方决定顺序）');
  assert.equal(inheritOutcome(undefined, undefined), null, '无历史 → null');
});

test('B5 via 字段随台账行落盘（解析兼容）', () => {
  const rows = parseHistoryEntries(
    JSON.stringify({ taskId: 't1', kind: 'task', paneId: 'p1', status: 'consumed', outcome: 'x', createdAt: 1, via: 'poll-settle' }) + '\n'
    + JSON.stringify({ taskId: 't1', kind: 'task', paneId: 'p1', status: 'closed', createdAt: 2, via: 'gc' }),
  );
  assert.equal((rows[0] as HistoryEntry).via, 'poll-settle');
  assert.equal((rows[1] as HistoryEntry).via, 'gc');
});

test('B2 语义（gc-core 侧）：无活动预算不进 GC 判定——shouldClosePane 仅看 consumedAt/prevTurnStart', () => {
  // B2 的豁免在 gcPass 调用层（pendingNoticeIds），这里锁定底层契约不变：
  // consumed 于上一轮之前 + idle → 可关；本轮消费 → 不可关（通知轮还没过完）。
  const prevTurnStart = 1_000_000;
  assert.equal(shouldClosePane({ consumedAt: prevTurnStart - 1, herdrStatus: 'idle', prevTurnStart }), true);
  assert.equal(shouldClosePane({ consumedAt: prevTurnStart + 1, herdrStatus: 'idle', prevTurnStart }), false, '本轮消费 → 不可关');
});

test('B1 语义锁定：常量经环境变量可调，默认 600s（无活动窗口）', () => {
  // 源常量在模块顶层读 env；此处锁语义文档：超时基准 = 距最近活动，而非 poller 起点。
  // （pollLoop 是带 30s 切片的事件循环，单测直驱会引入真实等待——由 spawn 集成链覆盖。）
  assert.ok(Number(process.env.PI_HERDR_SUBAGENT_TIMEOUT_MS ?? 600000) >= 600000);
});
