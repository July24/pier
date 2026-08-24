/**
 * todo-core 纯逻辑单测（node --test 直接跑 TS，Node 26 原生 type stripping）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  currentActivity,
  foldLatestTodos,
  validateTodos,
  normalizeStrict,
  listsEqual,
  completionTransitions,
  revertedCompleted,
  applyTodoEdits,
  fuzzyFind,
  boundedView,
} from '../src/todo-core.ts';

test('validateTodos: 合法列表通过并规范化', () => {
  const res = validateTodos([
    { content: '搭仓库', status: 'in_progress' },
    { content: '写测试', status: 'pending' },
  ]);
  assert.equal(res.ok, true);
  assert.deepEqual(res.items, [
    { content: '搭仓库', status: 'in_progress' },
    { content: '写测试', status: 'pending' },
  ]);
});

test('validateTodos: 空数组合法（清空列表）', () => {
  const res = validateTodos([]);
  assert.equal(res.ok, true);
  assert.deepEqual(res.items, []);
});

test('validateTodos: 非数组拒绝', () => {
  const res = validateTodos({ todos: [] });
  assert.equal(res.ok, false);
  assert.match(res.error!, /must be an array/);
});

test('validateTodos: 多余键拒绝（保持日志快照与模型所见一致）', () => {
  const res = validateTodos([{ content: 'a', status: 'pending', id: 1 }]);
  assert.equal(res.ok, false);
  assert.match(res.error!, /unknown field "id"/);
});

test('validateTodos: 空 content 拒绝', () => {
  const res = validateTodos([{ content: '   ', status: 'pending' }]);
  assert.equal(res.ok, false);
  assert.match(res.error!, /non-empty string/);
});

test('validateTodos: 重复 content 拒绝', () => {
  const res = validateTodos([
    { content: 'a', status: 'pending' },
    { content: 'a', status: 'completed' },
  ]);
  assert.equal(res.ok, false);
  assert.match(res.error!, /duplicate content "a"/);
});

test('validateTodos: 非法 status 拒绝', () => {
  const res = validateTodos([{ content: 'a', status: 'doing' }]);
  assert.equal(res.ok, false);
  assert.match(res.error!, /pending\|in_progress\|completed/);
});

test('validateTodos: allowParallelInProgress=false 时多条 in_progress 拒绝', () => {
  const res = validateTodos(
    [
      { content: 'a', status: 'in_progress' },
      { content: 'b', status: 'in_progress' },
    ],
    false,
  );
  assert.equal(res.ok, false);
  assert.match(res.error!, /at most one task may be in_progress \(got 2\)/);
});

test('validateTodos: 默认允许多条 in_progress（pi 工具并行执行的常态）', () => {
  const res = validateTodos([
    { content: 'a', status: 'in_progress' },
    { content: 'b', status: 'in_progress' },
  ]);
  assert.equal(res.ok, true);
});

test('foldLatestTodos: 分支路径上取最后一次快照（last-wins；pi 0.84.2 真实形状）', () => {
  const mk = (content: string, status: string) => ({
    type: 'message',
    message: {
      role: 'toolResult',
      toolName: 'todo_write',
      details: {
        'pi-herdr.todo': { version: 1, items: [{ content, status }] },
      },
    },
  });
  const entries = [
    { type: 'session', version: 3 },
    { type: 'message', message: { role: 'user', content: [] } },
    mk('第一步', 'completed'),
    { type: 'message', message: { role: 'assistant', content: [] } },
    mk('第二步', 'in_progress'),
  ];
  const folded = foldLatestTodos(entries as never);
  assert.deepEqual(folded, [{ content: '第二步', status: 'in_progress' }]);
});

test('foldLatestTodos: 无关条目与非本工具条目被跳过', () => {
  const entries = [
    { type: 'message', message: { role: 'toolResult', toolName: 'read', details: { x: 1 } } },
    { type: 'message', message: { role: 'toolResult', toolName: 'todo_write', details: {} } },
    { type: 'message', message: { role: 'toolResult', toolName: 'todo_write' } },
    { type: 'message', message: { role: 'assistant' } },
  ];
  assert.equal(foldLatestTodos(entries as never), null);
});

test('foldLatestTodos: 无任何快照时返回 null（重建时保留原状态）', () => {
  assert.equal(foldLatestTodos([]), null);
  assert.equal(foldLatestTodos([{ type: 'session' }] as never), null);
});

test('currentActivity: 取第一条 in_progress 作为活动任务', () => {
  assert.equal(
    currentActivity([
      { content: 'pending 的', status: 'pending' },
      { content: '正在做的', status: 'in_progress' },
      { content: '另一条并行', status: 'in_progress' },
    ]),
    '正在做的',
  );
  assert.equal(currentActivity([]), null);
  assert.equal(currentActivity([{ content: 'x', status: 'completed' }]), null);
});

/* ── M10（D34–D43） ───────────────────────────────────────────────── */

test('validateTodos: 五态 + blocker + phase 通过', () => {
  const res = validateTodos([
    { content: 'a', status: 'pending', phase: '调研' },
    { content: 'b', status: 'in_progress' },
    { content: 'c', status: 'completed' },
    { content: 'd', status: 'blocked', blocker: '等文档' },
    { content: 'e', status: 'abandoned' },
  ]);
  assert.equal(res.ok, true);
  assert.deepEqual(res.items, [
    { content: 'a', status: 'pending', phase: '调研' },
    { content: 'b', status: 'in_progress' },
    { content: 'c', status: 'completed' },
    { content: 'd', status: 'blocked', blocker: '等文档' },
    { content: 'e', status: 'abandoned' },
  ]);
});

test('validateTodos: blocker 只允许 blocked 态', () => {
  const bad = validateTodos([{ content: 'a', status: 'pending', blocker: 'x' }]);
  assert.equal(bad.ok, false);
  assert.match(bad.error!, /only allowed when status is "blocked"/);
  const empty = validateTodos([{ content: 'a', status: 'blocked', blocker: '  ' }]);
  assert.equal(empty.ok, false);
  assert.match(empty.error!, /non-empty string/);
});

test('validateTodos: phase 非空且 ≤30 字符', () => {
  assert.equal(validateTodos([{ content: 'a', status: 'pending', phase: '' }]).ok, false);
  assert.equal(validateTodos([{ content: 'a', status: 'pending', phase: 'x'.repeat(31) }]).ok, false);
  assert.equal(validateTodos([{ content: 'a', status: 'pending', phase: 'x'.repeat(30) }]).ok, true);
});

test('normalizeStrict: 多条 in_progress 保留第一条、其余退回 pending', () => {
  const out = normalizeStrict([
    { content: 'a', status: 'in_progress' },
    { content: 'b', status: 'in_progress' },
    { content: 'c', status: 'pending' },
  ]);
  assert.deepEqual(out, [
    { content: 'a', status: 'in_progress' },
    { content: 'b', status: 'pending' },
    { content: 'c', status: 'pending' },
  ]);
});

test('normalizeStrict: 无 in_progress 自动晋升第一条 pending；跳过 blocked/abandoned', () => {
  assert.deepEqual(normalizeStrict([
    { content: 'a', status: 'blocked', blocker: 'x' },
    { content: 'b', status: 'pending' },
  ]), [
    { content: 'a', status: 'blocked', blocker: 'x' },
    { content: 'b', status: 'in_progress' },
  ]);
  assert.deepEqual(normalizeStrict([{ content: 'a', status: 'completed' }]),
    [{ content: 'a', status: 'completed' }]);
  assert.deepEqual(normalizeStrict([]), []);
});

test('listsEqual: 全等判定（含 blocker/phase）', () => {
  assert.equal(listsEqual(
    [{ content: 'a', status: 'pending' }],
    [{ content: 'a', status: 'pending' }],
  ), true);
  assert.equal(listsEqual(
    [{ content: 'a', status: 'pending', phase: 'p' }],
    [{ content: 'a', status: 'pending' }],
  ), false);
  assert.equal(listsEqual(
    [{ content: 'a', status: 'blocked', blocker: 'x' }],
    [{ content: 'a', status: 'blocked', blocker: 'y' }],
  ), false);
  assert.equal(listsEqual([{ content: 'a', status: 'pending' }], []), false);
});

test('completionTransitions/revertedCompleted: 过渡与回退', () => {
  const prev = [
    { content: 'a', status: 'in_progress' },
    { content: 'b', status: 'pending' },
    { content: 'c', status: 'completed' },
  ];
  const next = [
    { content: 'a', status: 'completed' },
    { content: 'b', status: 'completed' },
    { content: 'c', status: 'pending' },
  ];
  assert.deepEqual(completionTransitions(prev, next), ['a', 'b']);
  assert.deepEqual(revertedCompleted(prev, next), ['c']);
});

test('applyTodoEdits: done/drop/rm 语义与幂等', () => {
  const items = [
    { content: 'a', status: 'pending' },
    { content: 'b', status: 'in_progress' },
    { content: 'c', status: 'blocked', blocker: 'x' },
    { content: 'd', status: 'completed' },
  ];
  const out = applyTodoEdits(items, [
    { op: 'done', content: 'a' },
    { op: 'drop', content: 'b' },
    { op: 'rm', content: 'c' },
    { op: 'done', content: 'd' }, // completed 不可逆（D37）
    { op: 'rm', content: '不存在的' }, // 幂等 no-op
  ]);
  assert.deepEqual(out, [
    { content: 'a', status: 'completed' },
    { content: 'b', status: 'abandoned' },
    { content: 'd', status: 'completed' },
  ]);
});

test('foldLatestTodos: 双源折叠（快照 + 人类编辑交错）', () => {
  const mkSnap = (items: Array<{ content: string; status: string }>) => ({
    type: 'message',
    message: {
      role: 'toolResult',
      toolName: 'todo_write',
      details: { 'pi-herdr.todo': { version: 1, items } },
    },
  });
  const mkEdit = (op: string, content: string) => ({
    type: 'custom',
    customType: 'pi-herdr.todo-edit',
    data: { version: 1, edits: [{ op, content }], ts: 1 },
  });
  const entries = [
    mkSnap([{ content: 'a', status: 'pending' }, { content: 'b', status: 'pending' }]),
    mkEdit('done', 'a'),
    { type: 'custom', customType: 'pi-herdr.subs', data: { version: 2, subs: [] } }, // 无关 custom 跳过
    mkEdit('rm', 'b'),
  ];
  const folded = foldLatestTodos(entries as never);
  assert.deepEqual(folded, [{ content: 'a', status: 'completed' }]);
});

test('fuzzyFind: 精确 → 前缀 → 子串，歧义列出候选', () => {
  const items = [
    { content: '修 board 路径 bug', status: 'pending' },
    { content: 'board 渲染', status: 'pending' },
    { content: '路径测试', status: 'pending' },
  ];
  assert.deepEqual(fuzzyFind(items, '修 board 路径 bug'), ['修 board 路径 bug']);
  // 唯一前缀命中 → 直接返回该条（不进子串层）
  assert.deepEqual(fuzzyFind(items, 'board'), ['board 渲染']);
  assert.deepEqual(fuzzyFind(items, '路径'), ['路径测试']);
  assert.deepEqual(fuzzyFind(items, '测试'), ['路径测试']);
  // 无精确/前缀命中 → 子串层，多条即歧义
  const items2 = [
    { content: '修 board 路径 bug', status: 'pending' },
    { content: '写 board 测试', status: 'pending' },
  ];
  assert.deepEqual(fuzzyFind(items2, 'bug'), ['修 board 路径 bug']);
  assert.deepEqual(fuzzyFind(items2, '不存在'), []);
});

test('boundedView: 预算内原样；超预算隐最老保最新（open 超额截头部，completed 尾部填充）', () => {
  const items = [
    { content: 'o1', status: 'pending' },
    { content: 'o2', status: 'in_progress' },
    { content: 'c1', status: 'completed' },
  ];
  assert.deepEqual(boundedView(items, 10), { visible: items, hiddenCompleted: 0, hiddenOpen: 0 });
  const big = [
    { content: 'o1', status: 'pending' },
    { content: 'o2', status: 'pending' },
    { content: 'o3', status: 'pending' },
    { content: 'c1', status: 'completed' },
    { content: 'c2', status: 'completed' },
  ];
  // open 超额：保最新两条（o2/o3），最老 open（o1）与全部 completed 隐藏
  const v = boundedView(big, 2);
  assert.deepEqual(v.visible.map((i) => i.content), ['o2', 'o3']);
  assert.equal(v.hiddenOpen, 1);
  assert.equal(v.hiddenCompleted, 2);
  // completed 填充剩余预算：取最新（尾部 c2），不是最老 c1
  const v2 = boundedView(big, 4);
  assert.deepEqual(v2.visible.map((i) => i.content), ['o1', 'o2', 'o3', 'c2']);
  assert.equal(v2.hiddenCompleted, 1);
  assert.equal(v2.hiddenOpen, 0);
});

test('countTodos: blocked/abandoned 不计入 completed（D34）；blocked 单列（D91）', async () => {
  const { countTodos } = await import('../src/vocab.ts');
  const c = countTodos([
    { content: 'a', status: 'pending' },
    { content: 'b', status: 'in_progress' },
    { content: 'c', status: 'completed' },
    { content: 'd', status: 'blocked', blocker: 'x' },
    { content: 'e', status: 'abandoned' },
  ]);
  assert.deepEqual(c, { pending: 1, inProgress: 1, completed: 1, blocked: 1 });
});


