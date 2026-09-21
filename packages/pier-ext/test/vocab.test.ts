/**
 * vocab: the confirmation / settlement copy the model reads back. Wording is the contract —
 * `formatTodoConfirmation` stays byte-aligned with DSH, and a settlement must never claim a worker
 * produced nothing when the text was merely unreadable (P0-1).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatSettlementNotice, formatTodoConfirmation, type TodoStatus } from '../src/vocab.ts';

const CONFIRMATIONS: Array<{ name: string; statuses: TodoStatus[]; expected: string }> = [
  {
    name: 'no blocked item keeps the DSH wording (no blocked column)',
    statuses: ['pending', 'in_progress', 'completed'],
    expected: 'Updated todo list: 1 pending, 1 in progress, 1 completed.',
  },
  {
    // A4: apnv3 returned "0 pending, 0 in progress, 0 completed." while items sat blocked.
    name: 'blocked items append a column',
    statuses: ['pending', 'in_progress', 'completed', 'blocked', 'blocked'],
    expected: 'Updated todo list: 1 pending, 1 in progress, 1 completed, 2 blocked.',
  },
  {
    name: 'abandoned is counted in no column (D34)',
    statuses: ['abandoned'],
    expected: 'Updated todo list: 0 pending, 0 in progress, 0 completed.',
  },
];

test('formatTodoConfirmation: counts and the blocked column', () => {
  for (const c of CONFIRMATIONS) {
    assert.equal( formatTodoConfirmation(c.statuses.map((status, i) => ({ content: `t${i}`, status }))), c.expected, c.name, );
  }
});

const HEAD = 'Background subagent p1 (task) finished and will do no further work unless you send it more.';

test('formatSettlementNotice: closing message, silent, and the two unreadable-text reasons', () => {
  assert.equal( formatSettlementNotice('p1 (task)', 'done'), `${HEAD} Its closing message: done`, );
  // The default reason is 'silent'.
  assert.equal(formatSettlementNotice('p1 (task)', null), `${HEAD} It left no closing message.`);
  assert.equal(formatSettlementNotice('p1 (task)', null, 'silent'), `${HEAD} It left no closing message.`);
  const suspect = formatSettlementNotice('p1 (task)', null, 'attribution-suspect');
  assert.ok(suspect.includes('attribution is suspect'), suspect);
  assert.ok(!suspect.includes('left no closing message'), 'a mis-attribution must not read as "no output"');
  const extract = formatSettlementNotice('p1 (task)', null, 'extraction-failed');
  assert.ok(extract.includes('could not be extracted'), extract);
});
