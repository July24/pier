/**
 * pollLoop transition planners: takeover, blocked gate, observation, vacuum.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSettlementNoticeText,
  formatObservationTimeoutNotice,
  formatPaneClosedNotice,
  isSettlementCandidate,
  planBlockedGate,
  planObservationTick,
  planTakeoverTick,
  planVacuumTick,
} from '../src/subagent-poller.ts';

test('planTakeoverTick: missing agent → ignore', () => {
  assert.equal(planTakeoverTick({
    currentStatus: null, previousStatus: 'working', idleStartedAt: 1, now: 2, idleMs: 60_000,
  }).kind, 'ignore');
});

test('planTakeoverTick: idle edge starts timer; sustained idle returns control', () => {
  assert.equal(planTakeoverTick({
    currentStatus: 'idle', previousStatus: 'working', idleStartedAt: null, now: 10, idleMs: 60_000,
  }).kind, 'start-idle');
  assert.equal(planTakeoverTick({
    currentStatus: 'idle', previousStatus: 'idle', idleStartedAt: 1, now: 60_002, idleMs: 60_000,
  }).kind, 'return-control');
  assert.deepEqual(planTakeoverTick({
    currentStatus: 'idle', previousStatus: 'idle', idleStartedAt: 1, now: 50_000, idleMs: 60_000,
  }), { kind: 'hold', lastAgentStatus: 'idle', clearIdleTimer: false });
});

test('planTakeoverTick: working/blocked clears idle timer', () => {
  assert.deepEqual(planTakeoverTick({
    currentStatus: 'working', previousStatus: 'idle', idleStartedAt: 1, now: 2, idleMs: 60_000,
  }), { kind: 'hold', lastAgentStatus: 'working', clearIdleTimer: true });
});

test('planBlockedGate: first blocked notifies; subsequent stay silent; idle clears', () => {
  assert.deepEqual(planBlockedGate('blocked', false), { kind: 'stay-blocked', notify: true });
  assert.deepEqual(planBlockedGate('blocked', true), { kind: 'stay-blocked', notify: false });
  assert.equal(planBlockedGate('idle', true).kind, 'clear-gate');
  assert.equal(planBlockedGate(null, false).kind, 'pass');
});

test('planObservationTick: first settle starts window; working after grace = takeover', () => {
  assert.equal(planObservationTick({
    observationStartedAt: null, now: 10, windowMs: 30_000, agentStatus: 'idle',
    machineInjectAgoMs: 1, machineInjectGraceMs: 60_000,
  }).kind, 'start-observation');
  assert.equal(planObservationTick({
    observationStartedAt: 1, now: 10, windowMs: 30_000, agentStatus: 'working',
    machineInjectAgoMs: 61_000, machineInjectGraceMs: 60_000,
  }).kind, 'user-takeover');
  assert.equal(planObservationTick({
    observationStartedAt: 1, now: 10, windowMs: 30_000, agentStatus: 'working',
    machineInjectAgoMs: 100, machineInjectGraceMs: 60_000,
  }).kind, 'machine-inject-reset');
});

test('planObservationTick: wait until window elapses then settle', () => {
  assert.equal(planObservationTick({
    observationStartedAt: 1, now: 29_000, windowMs: 30_000, agentStatus: 'idle',
    machineInjectAgoMs: 99_000, machineInjectGraceMs: 60_000,
  }).kind, 'wait');
  assert.equal(planObservationTick({
    observationStartedAt: 1, now: 30_001, windowMs: 30_000, agentStatus: 'idle',
    machineInjectAgoMs: 99_000, machineInjectGraceMs: 60_000,
  }).kind, 'settle');
});

test('planVacuumTick: null waitState is heartbeat; dead pane beats timeout', () => {
  assert.deepEqual(planVacuumTick({
    waitState: null, paneAlive: true, now: 50, lastActivityAt: 1, timeoutMs: 100,
  }), { refreshActivity: true, action: 'continue' });
  assert.deepEqual(planVacuumTick({
    waitState: 'idle', paneAlive: false, now: 50, lastActivityAt: 1, timeoutMs: 10,
  }), { refreshActivity: false, action: 'pane-closed' });
  assert.deepEqual(planVacuumTick({
    waitState: 'idle', paneAlive: true, now: 50, lastActivityAt: 1, timeoutMs: 10,
  }), { refreshActivity: false, action: 'timeout' });
});

test('isSettlementCandidate: 定稿文本，或"回合已结束且无待决工具"', () => {
  assert.equal(isSettlementCandidate({ text: 'ready', pendingTool: false, activity: false }), true);
  assert.equal(isSettlementCandidate({ text: null, pendingTool: false, activity: true, turnEnded: true }), true);
  assert.equal(isSettlementCandidate({ text: null, pendingTool: true, activity: true, turnEnded: true }), false);
  assert.equal(isSettlementCandidate({ text: null, pendingTool: false, activity: false }), false);
});

test('isSettlementCandidate (A16): 只有 activity 而回合未结束 → 绝不结算', () => {
  // 实测回归：三个仍在工作的 worker 被通知"finished … left no closing message"，
  // 其中一个随后被 GC 关掉 pane。工具间空档期（toolResult 已写、下一条 assistant 未到）正是这个形状。
  assert.equal(isSettlementCandidate({ text: null, pendingTool: false, activity: true }), false);
  assert.equal(isSettlementCandidate({ text: null, pendingTool: false, activity: true, turnEnded: false }), false);
  assert.equal(isSettlementCandidate({ text: null, pendingTool: true, activity: true, turnEnded: false }), false);
});

test('isSettlementCandidate: OCC 压缩期一律不结算（01a0be1f 假结算回归）', () => {
  // 子代理 OCC 在 todo 边界 abort → transcript 尾部是 stopReason 'error' 的空 assistant，
  // turnEnded 判定会把它当成已结束的回合；压缩标记必须压过其它一切信号。
  assert.equal(isSettlementCandidate({ text: null, pendingTool: false, activity: true, turnEnded: true, compacting: true }), false);
  // 已有定稿收尾文本也一样：abort 之前的文本不是最终收尾，continuation 还会继续工作。
  assert.equal(isSettlementCandidate({ text: 'all done', pendingTool: false, activity: true, compacting: true }), false);
  // 标记消失（continuation 已产出 assistant / 无 OCC）→ 恢复原判定。
  assert.equal(isSettlementCandidate({ text: 'all done', pendingTool: false, activity: true, compacting: false }), true);
  assert.equal(isSettlementCandidate({ text: null, pendingTool: false, activity: true, turnEnded: true, compacting: false }), true);
});

test('buildSettlementNoticeText: combines notice and optional statLine', () => {
  const withStat = buildSettlementNoticeText('p1 (task)', 'finished all', '1 file changed');
  assert.match(withStat, /Background subagent p1 \(task\) finished/);
  assert.match(withStat, /Its closing message: finished all/);
  assert.match(withStat, /\n1 file changed$/);

  const withoutStat = buildSettlementNoticeText('p1 (task)', null, null);
  assert.match(withoutStat, /It left no closing message\.$/);
  assert.ok(!withoutStat.includes('\n'));
});

test('formatPaneClosedNotice: formats closed pane notice', () => {
  const notice = formatPaneClosedNotice('p1', 'build assets');
  assert.equal(notice, 'Background subagent p1 (build assets) stopped before settling (its pane closed).');
});

test('formatObservationTimeoutNotice: formats timeout notice with idle duration and start ISO', () => {
  const notice = formatObservationTimeoutNotice({
    paneId: 'p1',
    description: 'build assets',
    idleSeconds: 120,
    startedAtIso: '2025-01-01T00:00:00.000Z',
  });
  assert.match(notice, /Background subagent p1 \(build assets\) has shown no progress for 120s \(observed since 2025-01-01T00:00:00\.000Z\)\./);
  assert.match(notice, /Run subagent\(action: "list"\)/);
});

