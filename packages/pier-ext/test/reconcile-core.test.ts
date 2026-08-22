/**
 * M17：todo↔subagent 自动对账（开发方案.md §M17 / P2 拍板）。
 * 缝：reconcileTodos 纯规划器（匹配/置信度/note 文案）+ unblock 编辑 op（权威路径回放）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileTodos } from '../src/reconcile-core.ts';
import {
  TODO_EDIT_CUSTOM_TYPE,
  applyTodoEdits,
  foldLatestTodos,
} from '../src/todo-core.ts';

const D = '调研 cordis';

function items(list: Array<[string, string, string?]>) {
  return list.map(([content, status, blocker]) => ({
    content, status: status as never, ...(blocker ? { blocker } : {}),
  }));
}

/* ── 匹配与自动勾（至多一条，最优档唯一才勾） ──────────────────── */

test('exact 匹配唯一 pending → 自动 completed（edit op done，tier=exact）', () => {
  const prev = items([[D, 'pending'], ['别的任务', 'in_progress']]);
  const p = reconcileTodos(prev, { description: D, outcome: 'settled' });
  assert.deepEqual(p.edits, [{ op: 'done', content: D }]);
  assert.equal(p.completed?.content, D);
  assert.equal(p.tier, 'exact');
  assert.equal(p.items.find((t) => t.content === D)?.status, 'completed');
  assert.ok(p.noteLines.some((l) => l.includes('Reconciled') && l.includes(D)));
});

test('委派标记约定：todo 带尾部 " <sub>" 标记、description 为去标记内容 → prefix 档仍自动勾', () => {
  // todo_write 工具描述承诺的约定（master 委派上表 + <sub> 标记；subagent description 用去标记内容）。
  // 钉死匹配语义：标记放尾部不破坏 prefix 匹配——将来改 matchTier 不得悄悄破坏文档承诺。
  const prev = items([[`${D} <sub>`, 'in_progress']]);
  const p = reconcileTodos(prev, { description: D, outcome: 'settled' });
  assert.equal(p.tier, 'prefix');
  assert.equal(p.edits.length, 1);
  assert.equal(p.edits[0].op, 'done');
  assert.equal(p.edits[0].content, `${D} <sub>`);
});

test('prefix 匹配（todo 内容长、description 短，双向）→ in_progress 也自动勾', () => {
  const prev = items([[`${D} 生命周期与 fiber 语义`, 'in_progress']]);
  const p = reconcileTodos(prev, { description: D, outcome: 'settled' });
  assert.equal(p.tier, 'prefix');
  assert.equal(p.edits.length, 1);
  assert.equal(p.edits[0].op, 'done');
  // 反向：description 是 todo 的前缀延伸
  const rev = reconcileTodos(items([['cordis', 'pending']]), {
    description: 'cordis fiber',
    outcome: 'settled',
  });
  assert.equal(rev.tier, 'prefix');
});

test('substring = 低置信度 → 不勾 + note 提示候选（P2）', () => {
  const prev = items([[`深入研究 ${D} 的用法`, 'pending']]);
  const p = reconcileTodos(prev, { description: D, outcome: 'settled' });
  assert.equal(p.edits.length, 0);
  assert.equal(p.completed, null);
  assert.equal(p.tier, 'substring');
  assert.equal(p.items[0].status, 'pending'); // 不动
  assert.ok(p.noteLines.some((l) => l.includes('low-confidence') && l.includes('深入研究')));
});

test('同档多候选（歧义）→ 不勾 + note 列出候选', () => {
  const prev = items([[`${D} 甲`, 'pending'], [`${D} 乙`, 'pending']]);
  const p = reconcileTodos(prev, { description: D, outcome: 'settled' });
  assert.equal(p.edits.length, 0);
  assert.equal(p.tier, 'prefix');
  assert.ok(p.noteLines.some((l) => l.includes('ambiguous') && l.includes('甲') && l.includes('乙')));
});

test('高置信但次高档有候选 → 仍只看最优档（唯一 exact 勾，prefix 不动）', () => {
  const prev = items([[D, 'pending'], [`${D} 补充`, 'pending']]);
  const p = reconcileTodos(prev, { description: D, outcome: 'settled' });
  assert.deepEqual(p.edits, [{ op: 'done', content: D }]);
  assert.equal(p.items.find((t) => t.content === `${D} 补充`)?.status, 'pending');
});

/* ── outcome 门（失败/中止不动） ──────────────────────────────── */

test('failed outcome → 不产生任何 edit；高置信候选 note 提示 kept open', () => {
  const prev = items([[D, 'in_progress']]);
  const p = reconcileTodos(prev, { description: D, outcome: 'failed' });
  assert.equal(p.edits.length, 0);
  assert.equal(p.items[0].status, 'in_progress');
  assert.ok(p.noteLines.some((l) => l.includes('kept open')));
  // 无候选的 failed → 静默
  const none = reconcileTodos(items([['不相干', 'pending']]), { description: D, outcome: 'failed' });
  assert.equal(none.noteLines.length, 0);
});

/* ── blocked 解锁（blocker 匹配描述；回 pending 清 blocker） ──── */

test('blocked 的 blocker 任意档匹配 → unblock（可多条）', () => {
  const prev = items([
    ['汇总报告', 'blocked', `等 ${D} 完成`],
    ['另一份汇总', 'blocked', `等 ${D} 完成`],
  ]);
  const p = reconcileTodos(prev, { description: D, outcome: 'settled' });
  assert.equal(p.edits.filter((e) => e.op === 'unblock').length, 2);
  assert.ok(p.items.every((t) => t.status === 'pending' && !('blocker' in t)));
  assert.ok(p.noteLines.some((l) => l.includes('Unblocked')));
});

test('blocker substring（「等 X 完成」短语包含）→ 也解锁；failed 不解锁', () => {
  const prev = items([['汇总', 'blocked', `深入研究 ${D} 之后`]]);
  const lo = reconcileTodos(prev, { description: D, outcome: 'settled' });
  assert.equal(lo.edits.filter((e) => e.op === 'unblock').length, 1);
  assert.equal(lo.items[0].status, 'pending');
  const fail = reconcileTodos(items([['汇总', 'blocked', `等 ${D}`]]), { description: D, outcome: 'failed' });
  assert.equal(fail.edits.length, 0);
});

/* ── 边界 ─────────────────────────────────────────────────────── */

test('completed/abandoned 条目永不参与匹配；无候选 → 零编辑零提示', () => {
  const prev = items([[D, 'completed'], [`${D} 旧`, 'abandoned']]);
  const p = reconcileTodos(prev, { description: D, outcome: 'settled' });
  assert.equal(p.edits.length, 0);
  assert.equal(p.noteLines.length, 0);
});

test('大小写/空白归一：仍算 exact', () => {
  const p = reconcileTodos(items([['  调研  CORDIS ', 'pending']]), {
    description: '调研 cordis',
    outcome: 'settled',
  });
  assert.equal(p.tier, 'exact');
});

/* ── unblock 编辑 op：applyTodoEdits + 分支回放（权威闭环） ────── */

test('unblock op：applyTodoEdits blocked→pending 清 blocker；非 blocked 为 no-op', () => {
  const next = applyTodoEdits(items([['a', 'blocked', 'x'], ['b', 'pending']]), [{ op: 'unblock', content: 'a' }]);
  assert.deepEqual(next[0], { content: 'a', status: 'pending' });
  assert.deepEqual(next[1], { content: 'b', status: 'pending' });
});

test('unblock op 经 custom 条目回放（foldLatestTodos，重启/分支正确性）', () => {
  const branch = [
    {
      type: 'message',
      message: {
        role: 'toolResult',
        toolName: 'todo_write',
        details: { 'pi-herdr.todo': { version: 1, items: [{ content: '汇总', status: 'blocked', blocker: '等调研' }] } },
      },
    },
    { type: 'custom', customType: TODO_EDIT_CUSTOM_TYPE, data: { version: 1, edits: [{ op: 'unblock', content: '汇总' }], ts: 1 } },
  ];
  const folded = foldLatestTodos(branch as never);
  assert.deepEqual(folded, [{ content: '汇总', status: 'pending' }]);
});
