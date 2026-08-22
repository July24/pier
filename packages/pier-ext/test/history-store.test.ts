/**
 * history-store 纯逻辑单测（v1.2）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendHistory,
  applyReportedSessionFile,
  generationsByTask,
  historyFilePath,
  latestGeneration,
  normalizeEntryKind,
  parseHistoryEntries,
  readHistory,
  type HistoryEntry,
} from '../src/history-store.ts';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mk = (over: Partial<HistoryEntry>): HistoryEntry => ({
  taskId: 't1',
  kind: 'short',
  paneId: 'w1:p1',
  tabId: 'w1:t9',
  workspaceId: 'w1',
  cwd: 'F:\\herdr-pi',
  description: 'task',
  sessionFile: 'C:\\sess\\a.jsonl',
  launchCommand: ['node', 'cli.js'],
  status: 'running',
  createdAt: 1,
  ...over,
});

test('historyFilePath: 按 cwd 分区（与 pi 会话分区同构）', () => {
  assert.equal(
    historyFilePath('C:\\home\\.pi\\agent', 'F:\\herdr-pi'),
    path.join('C:\\home\\.pi\\agent', 'herdr-pi', 'history', '--F--herdr-pi--', 'history.jsonl'),
  );
});

test('parseHistoryEntries: 容忍损坏行', () => {
  const entries = parseHistoryEntries(['{bad', '', JSON.stringify(mk({})), 'garbage'].join('\n'));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].taskId, 't1');
});

test('append/read 往返 + 目录自动创建', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-'));
  const file = historyFilePath(tmp, 'F:\\herdr-pi');
  appendHistory(file, mk({}));
  appendHistory(file, mk({ status: 'closed', closedAt: 2 }));
  const entries = readHistory(file);
  assert.equal(entries.length, 2);
  assert.equal(entries[1].status, 'closed');
  assert.ok(fs.existsSync(file));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('generationsByTask/latestGeneration: 代际折叠与复活链', () => {
  const entries = [
    mk({ paneId: 'w1:p1', status: 'closed', closedAt: 10, taskId: 't1' }),
    mk({ paneId: 'w1:p2', status: 'running', revivedFrom: 'w1:p1', taskId: 't1', createdAt: 20 }),
    mk({ paneId: 'w1:p3', taskId: 't2', createdAt: 5 }),
  ];
  const gens = generationsByTask(entries);
  assert.equal(gens.get('t1')?.length, 2);
  assert.equal(gens.get('t2')?.length, 1);
  const latest = latestGeneration(entries, 't1');
  assert.equal(latest?.paneId, 'w1:p2');
  assert.equal(latest?.revivedFrom, 'w1:p1');
  assert.equal(latestGeneration(entries, 'tX'), null);
});

test('normalizeEntryKind: short/resident/缺省 → task；role 名原样', () => {
  assert.equal(normalizeEntryKind('short'), 'task');
  assert.equal(normalizeEntryKind('resident'), 'task');
  assert.equal(normalizeEntryKind(undefined), 'task');
  assert.equal(normalizeEntryKind(''), 'task');
  assert.equal(normalizeEntryKind('advisor'), 'advisor');
  assert.equal(normalizeEntryKind('websearch'), 'websearch');
});

test('applyReportedSessionFile: 只接受 .jsonl；非法不覆盖', () => {
  assert.equal(applyReportedSessionFile('old.jsonl', 'C:\\sess\\a.jsonl'), 'C:\\sess\\a.jsonl');
  assert.equal(applyReportedSessionFile('old.jsonl', 'not-a-path'), 'old.jsonl');
  assert.equal(applyReportedSessionFile(null, 'C:\\sess\\b.jsonl'), 'C:\\sess\\b.jsonl');
  assert.equal(applyReportedSessionFile(null, null), null);
});

test('parseHistoryEntries: 旧 kind=resident 读盘不炸，折叠为 task', () => {
  const entries = parseHistoryEntries(JSON.stringify(mk({ kind: 'resident' })));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'task');
});
