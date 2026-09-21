/**
 * Delegation ledger (history-store): append-only JSONL, one row per status change, partitioned by cwd.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendHistory,
  inheritOutcome,
  applyReportedSessionFile,
  generationsByTask,
  historyFilePath,
  inspectHistory,
  latestGeneration,
  normalizeEntryKind,
  parseHistoryEntries,
  readHistory,
  type HistoryEntry,
} from '../src/history-store.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { withCleanup } from './test-utils.ts';

const mk = (over: Partial<HistoryEntry> = {}): HistoryEntry => ({
  taskId: 't1', kind: 'short', paneId: 'w1:p1', tabId: 'w1:t9', workspaceId: 'w1', cwd: 'F:\\herdr-pi',
  description: 'task', sessionFile: 'C:\\sess\\a.jsonl', launchCommand: ['node', 'cli.js'], status: 'running',
  createdAt: 1, ...over,
});

test('historyFilePath: partitioned by cwd (mirrors pi session partitioning)', () => {
  assert.equal(
    historyFilePath('C:\\home\\.pi\\agent', 'F:\\herdr-pi'),
    path.join('C:\\home\\.pi\\agent', 'herdr-pi', 'history', '--F%3A%5Cherdr-pi--', 'history.jsonl'),
  );
});

test('parseHistoryEntries: skips junk lines, non-objects, rows without taskId and invalid statuses', () => {
  const entries = parseHistoryEntries(['{bad', '', JSON.stringify(mk({})), 'garbage'].join('\n'));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].taskId, 't1');
  assert.equal(parseHistoryEntries(JSON.stringify({ paneId: 'p', status: 'running' })).length, 0);
  assert.equal(parseHistoryEntries(JSON.stringify({ taskId: 't1', status: 'nope' })).length, 0);
});

test('inspectHistory/readHistory: missing vs unreadable (directory); both read as empty', withCleanup(async (cleanup) => {
  const missing = path.join(cleanup.tempDir('hist-none').path, 'history.jsonl');
  assert.equal(inspectHistory(missing).status, 'missing');
  assert.deepEqual(readHistory(missing), []);
  assert.equal(inspectHistory(cleanup.tempDir('hist-dir').path).status, 'unreadable');
}));

test('appendHistory: a file where the parent directory should be → ok:false', withCleanup(async (cleanup) => {
  const tmp = cleanup.tempDir('hist-block').path;
  const blocker = path.join(tmp, 'notdir');
  fs.writeFileSync(blocker, 'x');
  assert.equal(appendHistory(path.join(blocker, 'history.jsonl'), mk()).ok, false);
}));

test('append/read round-trip: rows append in order and the directory is created on demand', withCleanup(async (cleanup) => {
  const file = historyFilePath(cleanup.tempDir('hist').path, 'F:\\herdr-pi');
  appendHistory(file, mk());
  appendHistory(file, mk({ status: 'closed', closedAt: 2 }));
  const entries = readHistory(file);
  assert.equal(entries.length, 2);
  assert.equal(entries[1].status, 'closed');
  assert.ok(fs.existsSync(file));
}));

test('generationsByTask/latestGeneration: generations fold per task and follow the revival chain', () => {
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

test('normalizeEntryKind: short/resident/missing → task; role names unchanged (also on disk read)', () => {
  assert.equal(normalizeEntryKind('short'), 'task');
  assert.equal(normalizeEntryKind('resident'), 'task');
  assert.equal(normalizeEntryKind(undefined), 'task');
  assert.equal(normalizeEntryKind(''), 'task');
  assert.equal(normalizeEntryKind('advisor'), 'advisor');
  assert.equal(normalizeEntryKind('websearch'), 'websearch');
  const legacy = parseHistoryEntries(JSON.stringify(mk({ kind: 'resident' })));
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].kind, 'task');
});

test('applyReportedSessionFile: only a .jsonl path is accepted; an invalid report never overwrites', () => {
  assert.equal(applyReportedSessionFile('old.jsonl', 'C:\\sess\\a.jsonl'), 'C:\\sess\\a.jsonl');
  assert.equal(applyReportedSessionFile('old.jsonl', 'not-a-path'), 'old.jsonl');
  assert.equal(applyReportedSessionFile(null, 'C:\\sess\\b.jsonl'), 'C:\\sess\\b.jsonl');
  assert.equal(applyReportedSessionFile(null, null), null);
});

test('inheritOutcome: an omitted patch value inherits the latest non-empty outcome', () => {
  assert.equal(inheritOutcome('最终报告…', undefined), '最终报告…', 'undefined → inherit');
  assert.equal(inheritOutcome(null, 'observation timeout'), 'observation timeout');
  assert.equal(inheritOutcome('最终报告…', null), null, 'an explicit null also wins');
  assert.equal(inheritOutcome(undefined, undefined), null);
});

test('via: the writer marker survives a round-trip (one row per event, auditable)', () => {
  const rows = parseHistoryEntries([
    JSON.stringify({ taskId: 't1', kind: 'task', paneId: 'p1', status: 'consumed', outcome: 'x', createdAt: 1, via: 'poll-settle' }),
    JSON.stringify({ taskId: 't1', kind: 'task', paneId: 'p1', status: 'closed', createdAt: 2, via: 'gc' }),
  ].join('\n'));
  assert.deepEqual(rows.map((r) => r.via), ['poll-settle', 'gc']);
});
