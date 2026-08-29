/**
 * vocab: confirmation / settlement copy contracts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatSettlementNotice, formatTodoConfirmation } from '../src/vocab.ts';

test('formatTodoConfirmation: pending / in_progress / completed counts', () => {
  assert.equal(
    formatTodoConfirmation([
      { content: 'a', status: 'pending' },
      { content: 'b', status: 'in_progress' },
      { content: 'c', status: 'completed' },
      { content: 'd', status: 'blocked' },
    ]),
    'Updated todo list: 1 pending, 1 in progress, 1 completed.',
  );
});

test('formatSettlementNotice: with and without closing message', () => {
  assert.equal(
    formatSettlementNotice('p1 (task)', 'done'),
    'Background subagent p1 (task) finished and will do no further work unless you send it more. Its closing message: done',
  );
  assert.equal(
    formatSettlementNotice('p1 (task)', null),
    'Background subagent p1 (task) finished and will do no further work unless you send it more. It left no closing message.',
  );
});
