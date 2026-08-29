/**
 * session-tail 纯逻辑单测（v1.1 结果通道）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasAssistantAfter,
  hasPendingToolCall,
  lastAssistantText,
  listSessionFiles,
  parseSessionEntries,
  sessionDirName,
  sessionFileById,
} from '../src/session-tail.ts';
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
