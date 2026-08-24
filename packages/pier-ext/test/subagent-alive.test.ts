/**
 * 探活 + 存活通知（A2/B1 统一出口）纯逻辑单测：
 * isAlive（pane 在 + working/blocked 或近期会话活动）、agoText、buildAliveNotice 两场景话术。
 * 实证背景：前台 90s 硬窗口误判 no-output → master 抢活；三子代理 101s 被 consumed、
 * 4 分钟后各自产出完整报告（session 01a03253 实测）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agoText, buildAliveNotice, buildBlockedGateNotice, isAlive, type AliveProbe } from '../src/subagent-core.ts';

const NOW = 1_800_000_000_000;

function probe(over: Partial<AliveProbe>): AliveProbe {
  return { paneExists: true, agentStatus: null, lastActivityMs: null, ...over };
}

test('isAlive: pane 消失 → 死（探活失败保留原错误语义）', () => {
  assert.equal(isAlive(probe({ paneExists: false, agentStatus: 'working', lastActivityMs: NOW - 1000 }), NOW), false);
});

test('isAlive: working/blocked → 活（会话沉寂也活）', () => {
  assert.equal(isAlive(probe({ agentStatus: 'working', lastActivityMs: null }), NOW), true);
  assert.equal(isAlive(probe({ agentStatus: 'blocked', lastActivityMs: NOW - 999_999 }), NOW), true);
});

test('isAlive: idle/unknown 靠会话活动判定（默认 120s 新鲜度）', () => {
  assert.equal(isAlive(probe({ agentStatus: 'idle', lastActivityMs: NOW - 60_000 }), NOW), true, '1 分钟内有活动 → 活');
  assert.equal(isAlive(probe({ agentStatus: 'idle', lastActivityMs: NOW - 119_999 }), NOW), true, '边界内');
  assert.equal(isAlive(probe({ agentStatus: 'idle', lastActivityMs: NOW - 120_001 }), NOW), false, '2 分钟外沉寂 → 死');
  assert.equal(isAlive(probe({ agentStatus: null, lastActivityMs: null }), NOW), false, '无活动无状态 → 死');
  // 自定义新鲜度
  assert.equal(isAlive(probe({ agentStatus: 'idle', lastActivityMs: NOW - 30_001 }), NOW, 30_000), false);
});

test('agoText: 人话相对时间', () => {
  assert.equal(agoText(NOW - 12_000, NOW), '12s ago');
  assert.equal(agoText(NOW - 180_000, NOW), '3m ago');
  assert.equal(agoText(NOW - 7_200_000, NOW), '2h ago');
  assert.equal(agoText(NOW + 5_000, NOW), '0s ago', '时钟回拨钳 0');
});

test('buildAliveNotice: moved-to-bg 场景——转后台 + 禁重做 + 通知承诺', () => {
  const text = buildAliveNotice(
    { paneId: 'wA:p2', description: 'Explore CRM', scenario: 'moved-to-bg', probe: probe({ agentStatus: 'working', lastActivityMs: NOW - 12_000 }) },
    NOW,
  );
  assert.match(text, /still running in pane wA:p2/);
  assert.match(text, /agent_status=working/);
  assert.match(text, /last session activity 12s ago/);
  assert.match(text, /Do NOT redo its work/);
  assert.match(text, /moved it to background/i);
  assert.match(text, /list_agents/);
});

test('buildAliveNotice: error-alive 场景——改写错误文案，明确"没失败"', () => {
  const text = buildAliveNotice(
    { paneId: 'wA:p3', description: 'Explore HR', scenario: 'error-alive', probe: probe({ agentStatus: 'idle', lastActivityMs: NOW - 45_000 }) },
    NOW,
  );
  assert.match(text, /is ALIVE in pane wA:p3/);
  assert.match(text, /NOT that the task failed/);
  assert.match(text, /no readable output.*could not be read yet/s);
  assert.match(text, /Do NOT redo its work/);
  assert.match(text, /list_agents/);
});

test('buildAliveNotice: 会话活动未知时省略 activity 子句', () => {
  const text = buildAliveNotice(
    { paneId: 'wA:p4', description: 'X', scenario: 'moved-to-bg', probe: probe({ agentStatus: 'working' }) },
    NOW,
  );
  assert.ok(!text.includes('last session activity'));
});


test('buildBlockedGateNotice: 闸门话术——不揽活/引导用户/授权例外经 send_message', () => {
  const text = buildBlockedGateNotice({ paneId: 'wB:p3', description: 'Explore HR', question: '用哪个数据源？' });
  assert.match(text, /BLOCKED waiting for a HUMAN decision in pane wB:p3/);
  assert.match(text, /question: "用哪个数据源？"/);
  assert.match(text, /Do NOT take over its work/);
  assert.match(text, /Tell the user to open that pane/);
  assert.match(text, /explicitly authorizes/);
  assert.match(text, /send_message/);
  assert.match(text, /do not redo the work yourself/);
});

test('buildBlockedGateNotice: question 缺省时省略子句', () => {
  const text = buildBlockedGateNotice({ paneId: 'wB:p4', description: 'X', question: null });
  assert.ok(!text.includes('question:'));
  assert.match(text, /BLOCKED waiting for a HUMAN decision/);
});