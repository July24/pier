/** tree-view: the resident-widget line rules (workerLine/selfLine) and the /pier-tree renderer. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDelegationTree, selfLine, workerLine, type WorkerWidgetRow } from '../src/tree-view.ts';
import type { TodoItem } from '../src/vocab.ts';

const it = (content: string, status: TodoItem['status'], blocker?: string): TodoItem =>
  ({ content, status, ...(blocker ? { blocker } : {}) }) as TodoItem;

test('selfLine: current item variants', () => {
  assert.equal(selfLine([it('a', 'in_progress'), it('b', 'pending'), it('c', 'completed')]), '▶ a ✓1/3');
  assert.equal(selfLine([it('x', 'blocked', '等审核')]), '■ waiting on: 等审核 ✓0/1');
  assert.equal(selfLine([it('done1', 'completed'), it('done2', 'completed')]), null, 'a finished plan renders no self line');
  assert.equal(selfLine([]), null);
});

test('workerLine: live list / blocked reason / summary fallback / cold row', () => {
  const live: WorkerWidgetRow = {
    paneId: 'p2', slug: 'fix-auth', description: 'fix auth',
    todos: { items: [{ content: 'auth tests', status: 'in_progress' }, { content: 'done', status: 'completed' }] },
  };
  assert.equal(workerLine(live), '↳ fix-auth ▶ auth tests ✓1/2');
  assert.equal(workerLine({ ...live, todos: { items: [{ content: 'confirm schema', status: 'blocked', blocker: '等人' }] } }),
    '↳ fix-auth ■ confirm schema (等人) ✓0/1');
  assert.equal(workerLine({ ...live, todos: { items: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'completed' }] } }),
    '↳ fix-auth ✓2/2');
  assert.equal(workerLine({ ...live, todos: { summary: '▶1 ○2 ✓0 · wiring' } }), '↳ fix-auth · ▶1 ○2 ✓0 · wiring');
  assert.equal(workerLine({ paneId: 'p9', description: 'legacy row', todos: null }), '↳ p9 · legacy row');
});

test('formatDelegationTree: full tree with worker lists, summary fallback, and settled nodes', () => {
  const lines = formatDelegationTree({
    selfItems: [it('orchestrate', 'in_progress'), it('draft RFC', 'completed')],
    workers: [
      {
        paneId: 'p2', slug: 'fix-auth', description: 'fix auth', kind: 'reviewer',
        todos: { items: [{ content: 'auth tests', status: 'in_progress' }, { content: 'extract middleware', status: 'completed' }] },
      },
      { paneId: 'p3', slug: 'migration', description: 'migrate', kind: 'task', todos: { summary: '▶1 ✓2 · schema' } },
    ],
    settled: [{ paneId: 'p4', slug: 'run-e2e', description: 'e2e', settledAt: Date.now() - 120_000 }],
    now: Date.now(),
  });
  const text = lines.join('\n');
  assert.ok(text.includes('● master (this pane) · 2 items'));
  assert.ok(text.includes('▶ orchestrate'));
  assert.ok(text.includes('├─ ↳ fix-auth (p2 · running · reviewer) · 2 items'));
  assert.ok(text.includes('auth tests') && text.includes('extract middleware'), 'worker full list rendered');
  assert.ok(text.includes('↳ migration (p3 · running) · ▶1 ✓2 · schema'), 'cold cache renders the summary');
  assert.ok(text.includes('└─ ✓ run-e2e (p4 · settled 2m ago) — result delivered in the settlement notice'));
  assert.ok(text.includes('/todos edit your own list'));
  assert.ok(lines.every((l) => l.length <= 120), 'tree lines stay readable');
});

test('formatDelegationTree: empty state still names the master node', () => {
  const lines = formatDelegationTree({ selfItems: [], workers: [], settled: [] });
  assert.ok(lines[1]!.includes('● master (this pane) · 0 items'));
});
