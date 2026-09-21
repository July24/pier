/**
 * session-tail 纯逻辑单测（v1.1 结果通道）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compactionBusy,
  deriveSubSessionState,
  hasAssistantAfter,
  hasPendingToolCall,
  lastAssistantText,
  lastAssistantTurnEnded,
  listSessionFiles,
  parseSessionEntries,
  sessionDirName,
  sessionFileById,
} from '../src/session-tail.ts';
import { COMPACTION_INFLIGHT_TYPE, COMPACTION_SETTLED_TYPE } from '../src/compact-coordinator.ts';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mkMsg = (role: string, text: string, ts: number, stopReason = 'stop') => ({
  type: 'message',
  message: { role, content: [{ type: 'text', text }], timestamp: ts, stopReason },
});

test('parseSessionEntries: 容忍损坏行与空行', () => {
  const entries = parseSessionEntries(
    ['{bad json', '', JSON.stringify(mkMsg('assistant', 'hello', 100)), '{"type":"session"}'].join('\n'),
  );
  assert.equal(entries.length, 2);
  assert.equal(entries[0].type, 'message');
  assert.equal(entries[1].type, 'session');
});

test('lastAssistantText: 取最后一条 stop 定稿的 assistant 文本（跳过 toolUse 中间态）', () => {
  const entries = [
    mkMsg('user', 'task', 1),
    mkMsg('assistant', 'thinking...', 2, 'toolUse'),
    mkMsg('assistant', 'final answer', 3, 'stop'),
  ];
  const r = lastAssistantText(entries);
  assert.equal(r?.text, 'final answer');
});

test('lastAssistantText: sinceTs 过滤注入前的旧消息', () => {
  const entries = [mkMsg('assistant', 'old', 100), mkMsg('assistant', 'new', 200)];
  const r = lastAssistantText(entries, { sinceTs: 150 });
  assert.equal(r?.text, 'new');
});

test('lastAssistantText: 无定稿 assistant → null', () => {
  assert.equal(lastAssistantText([mkMsg('user', 'hi', 1)]), null);
  assert.equal(lastAssistantText([mkMsg('assistant', 'mid', 1, 'toolUse')]), null);
});

test('hasAssistantAfter: 时间点之后的任意 assistant 消息', () => {
  const entries = [mkMsg('assistant', 'a', 100)];
  assert.equal(hasAssistantAfter(entries, 100), true);
  assert.equal(hasAssistantAfter(entries, 101), false);
});

test('hasPendingToolCall: 挂起工具调用 = 未结算（等人类输入）', () => {
  const tc = (ts: number, n = 1) => ({
    type: 'message',
    message: { role: 'assistant', content: Array.from({ length: n }, () => ({ type: 'toolCall' })), timestamp: ts, stopReason: 'toolUse' },
  });
  const tr = (ts: number) => ({ type: 'message', message: { role: 'toolResult', content: [], timestamp: ts } });
  // 单调用挂起
  assert.equal(hasPendingToolCall([mkMsg('user', 'q', 1), tc(10)], 5), true);
  // 调用后有结果 → 不挂起
  assert.equal(hasPendingToolCall([tc(10), tr(11)], 5), false);
  // 并行两调用、一个结果 → 仍挂起
  assert.equal(hasPendingToolCall([tc(10, 2), tr(11)], 5), true);
  // sinceTs 之前的旧调用不算
  assert.equal(hasPendingToolCall([tc(3)], 5), false);
});

test('sessionDirName: cwd → collision-resistant session dir', () => {
  assert.equal(sessionDirName('F:\\herdr-pi'), '--F%3A%5Cherdr-pi--');
  assert.equal(sessionDirName('/home/u/proj'), '--%2Fhome%2Fu%2Fproj--');
});

test('listSessionFiles/sessionFileById: 候选定位（v1.3 M7 结算串线修复）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-sess2-'));
  const dir = path.join(tmp, '--F--herdr-pi--');
  fs.mkdirSync(dir, { recursive: true });
  const a = path.join(dir, '2026-01-01T00-00-00_aaaa.jsonl');
  const b = path.join(dir, '2026-01-01T00-00-01_bbbb.jsonl');
  const c = path.join(dir, '2026-01-01T00-00-02_cccc.jsonl');
  for (const f of [a, b, c]) fs.writeFileSync(f, '{}');
  const t = Date.now();
  fs.utimesSync(a, new Date(t - 3000), new Date(t - 3000));
  fs.utimesSync(b, new Date(t - 2000), new Date(t - 2000));
  fs.utimesSync(c, new Date(t - 1000), new Date(t - 1000));
  const list = listSessionFiles('F:\\herdr-pi', tmp, 2);
  assert.deepEqual(list, [c, b]);
  assert.equal(sessionFileById('F:\\herdr-pi', tmp, 'bbbb'), b);
  assert.equal(sessionFileById('F:\\herdr-pi', tmp, 'zzzz'), null);
  assert.equal(sessionFileById('Z:\\nowhere', tmp, 'bbbb'), null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('lastAssistantTurnEnded (A16): 只有结束的回合才算结束，toolUse 中间态不算', () => {
  const entries = [
    mkMsg('user', 'task', 1),
    mkMsg('assistant', 'thinking', 2, 'toolUse'),
    mkMsg('toolResult', 'ok', 3),
  ];
  // 工具已回、下一条 assistant 还没来——真实工作流里最常见的一刻，绝不能当作结算。
  assert.equal(lastAssistantTurnEnded(entries, 1), false);
  // 补上真正的收尾（stop）后就结束了。
  assert.equal(lastAssistantTurnEnded([...entries, mkMsg('assistant', 'done', 4, 'stop')], 1), true);
  // 没有 assistant 消息 / 早于注入点：都不算结束。
  assert.equal(lastAssistantTurnEnded([mkMsg('user', 'task', 1)], 1), false);
  assert.equal(lastAssistantTurnEnded([mkMsg('assistant', 'done', 5, 'stop')], 10), false);
  // stopReason 缺失（流式中间态）保守地按"未结束"处理。
  const streaming = [{ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'x' }], timestamp: 6 } }];
  assert.equal(lastAssistantTurnEnded(streaming, 1), false);
});

test('listSessionFiles/sessionFileById (A8): pi core 的 POSIX 目录名必须能定位到会话', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-sess-a8-'));
  const cwd = '/Users/yehaoyu/Documents/pier';
  const dir = path.join(tmp, '--Users-yehaoyu-Documents-pier--'); // pi core 的真实命名
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, '2026-01-01T00-00-00_dead.jsonl');
  fs.writeFileSync(f, '{}');
  // 旧实现用 `--%2FUsers…--` / `---Users…--` 找，返回空而不报错（静默失效）
  assert.deepEqual(listSessionFiles(cwd, tmp, 4), [f]);
  assert.equal(sessionFileById(cwd, tmp, 'dead'), f);
  assert.equal(sessionFileById(cwd, tmp, 'beef'), null);
  // 双读不回归：pier 旧编码目录仍可读
  const legacy = path.join(tmp, '---Users-yehaoyu-Documents-pier--');
  fs.mkdirSync(legacy, { recursive: true });
  const g = path.join(legacy, '2026-01-01T00-00-01_beef.jsonl');
  fs.writeFileSync(g, '{}');
  assert.equal(sessionFileById(cwd, tmp, 'beef'), g);
  assert.equal(listSessionFiles(cwd, tmp, 4).length, 2);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('deriveSubSessionState/compactionBusy: OCC 标记期间不结算（01a0be1f 假结算回归）', () => {
  const mkCustom = (customType: string) => ({ type: 'custom', customType, data: {}, timestamp: 0 });
  const INFLIGHT = COMPACTION_INFLIGHT_TYPE;
  const SETTLED = COMPACTION_SETTLED_TYPE;
  // OCC 在 todo 边界 abort：turn 落在 transcript 里是 stopReason 'error'、空 content 的 assistant。
  const abortedTurn = mkMsg('assistant', '', 2, 'error');
  const task = mkMsg('user', 'fix bugs 19795-19799', 1);

  // 1. inflight 标记是最后一条 → 正在压缩总结请求，hold。
  let state = deriveSubSessionState([task, abortedTurn, mkCustom(INFLIGHT)], 0);
  assert.equal(state.compacting, true);
  assert.equal(compactionBusy([task, abortedTurn, mkCustom(INFLIGHT)]), true);

  // 2. settled 标记已写但 continuation 的 assistant 还没来 → 仍是机器停顿，hold。
  state = deriveSubSessionState([task, abortedTurn, mkCustom(INFLIGHT), mkCustom(SETTLED)], 0);
  assert.equal(state.compacting, true);

  // 3. continuation 的 assistant 出现在 settled 标记之后 → hold 释放。
  const continuation = mkMsg('assistant', 'Let me continue: compile and run tests', 4, 'toolUse');
  state = deriveSubSessionState([task, abortedTurn, mkCustom(INFLIGHT), mkCustom(SETTLED), continuation], 0);
  assert.equal(state.compacting, false);
  assert.equal(state.turnEnded, false);

  // 4. 无标记（旧版本/未开 OCC 的子会话）→ 行为不变。
  state = deriveSubSessionState([task, abortedTurn], 0);
  assert.equal(state.compacting, false);

  // 5. 已有定稿收尾文本但压缩正在进行 → compacting 仍为 true（结算与否由
  //    isSettlementCandidate 的 compacting 守卫决定，abort 之前的文本不算最终收尾）。
  const closing = mkMsg('assistant', 'all tests pass, committed', 5, 'stop');
  state = deriveSubSessionState([task, closing, mkCustom(INFLIGHT)], 0);
  assert.equal(state.compacting, true);
  assert.equal(state.text, 'all tests pass, committed');
});

test('compactionBusy: 结算后追加的无关 custom 条目不影响判定（最后标记胜出）', () => {
  const mkCustom = (customType: string) => ({ type: 'custom', customType, data: {}, timestamp: 0 });
  const continuation = mkMsg('assistant', 'continuing', 4, 'toolUse');
  const entries = [
    mkMsg('user', 'task', 1),
    mkCustom(COMPACTION_INFLIGHT_TYPE),
    mkCustom(COMPACTION_SETTLED_TYPE),
    continuation,
    mkCustom('pi-herdr.subs'), // 同会话后续写入的其它 custom 条目
  ];
  assert.equal(compactionBusy(entries), false);
});
