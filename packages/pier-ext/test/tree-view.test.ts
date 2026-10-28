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
  assert.equal(selfLine([it('fix it <sub>', 'in_progress')]), '▶ fix it ✓0/1', 'the delegation marker is not display text');
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

test('formatDelegationTree: workers and settled nodes hang off master with tree connectors', () => {
  const lines = formatDelegationTree({
    selfItems: [it('orchestrate <sub>', 'in_progress'), it('draft RFC', 'completed')],
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
  assert.equal(lines[0], 'Delegation tree · 2 running · 1 settled');
  assert.ok(lines.includes('● master (this pane)  ✓1/2'));
  assert.ok(lines.includes('│   ▶ orchestrate  ↳ sub'), 'delegated entry: marker replaced, rail continues to children');
  assert.ok(lines.includes('├─ ↳ fix-auth (p2 · running · reviewer)  ✓1/2'));
  assert.ok(lines.includes('│      ▶ auth tests') && lines.includes('│      ✓ extract middleware'), 'worker full list under its node');
  assert.ok(lines.includes('├─ ↳ migration (p3 · running)  ▶1 ✓2 · schema'), 'cold cache renders the summary');
  assert.ok(lines.includes('└─ ✓ run-e2e (p4 · settled 2m ago)  result delivered'), 'last child closes the tree');
});

test('formatDelegationTree: last running worker closes the rail under its items', () => {
  const lines = formatDelegationTree({
    selfItems: [it('a', 'completed')],
    workers: [{ paneId: 'p2', slug: 'w', description: 'w', todos: { items: [{ content: 'x', status: 'pending' }] } }],
  });
  assert.ok(lines.includes('└─ ↳ w (p2 · running)  ✓0/1'));
  assert.ok(lines.includes('       ○ x'), 'no dangling │ after the last child');
});

test('formatDelegationTree: empty state still names the master node without rails', () => {
  const lines = formatDelegationTree({ selfItems: [], workers: [], settled: [] });
  assert.ok(lines.includes('● master (this pane)  no todos'));
  assert.ok(!lines.some((l) => /[│├└]/.test(l)));
});
