/**
 * todo-core 纯逻辑单测（node --test 直接跑 TS，Node 26 原生 type stripping）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  currentActivity,
  foldLatestTodosMeta,
  validateTodos,
  normalizeStrict,
  listsEqual,
  completionTransitions,
  revertedCompleted,
  applyTodoEdits,
  fuzzyFind,
  boundedView,
  type TodoItem,
} from '../src/todo-core.ts';
import { countTodos } from '../src/vocab.ts';

test('validateTodos: 合法列表通过并规范化（含空数组 = 清空）', () => {
  const res = validateTodos([
    { content: '搭仓库', status: 'in_progress' },
    { content: '写测试', status: 'pending' },
  ]);
  assert.equal(res.ok, true);
  assert.deepEqual(res.items, [
    { content: '搭仓库', status: 'in_progress' },
    { content: '写测试', status: 'pending' },
  ]);
  assert.deepEqual(validateTodos([]), { ok: true, items: [] });
});

test('validateTodos: 非数组 / 多余键 / 空 content / 重复 content / 非法 status 全部硬拒', () => {
  assert.match(validateTodos({ todos: [] }).error!, /must be an array/);
  // 多余键拒绝：保持日志快照与模型所见一致
  assert.match(validateTodos([{ content: 'a', status: 'pending', id: 1 }]).error!, /unknown field "id"/);
  assert.match(validateTodos([{ content: '   ', status: 'pending' }]).error!, /non-empty string/);
  assert.match(
    validateTodos([{ content: 'a', status: 'pending' }, { content: 'a', status: 'completed' }]).error!,
    /duplicate content "a"/,
  );
  assert.match(validateTodos([{ content: 'a', status: 'doing' }]).error!, /pending\|in_progress\|completed/);
});

test('validateTodos: in_progress 并行策略（默认允许多条，serial 模式拒第 2 条）', () => {
  const two = [
    { content: 'a', status: 'in_progress' },
    { content: 'b', status: 'in_progress' },
  ];
  assert.equal(validateTodos(two).ok, true, 'pi 工具并行执行的常态');
  const res = validateTodos(two, false);
  assert.equal(res.ok, false);
  assert.match(res.error!, /at most one task may be in_progress \(got 2\)/);
});

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

test('validateTodos: blocker 容忍归一（用户实证：模型用空串填充 Optional 字段）', () => {
  // 非 blocked 态带 blocker → 丢弃，status 是权威
  const drop = validateTodos([{ content: 'a', status: 'completed', blocker: 'x' }]);
  assert.equal(drop.ok, true);
  assert.equal('blocker' in (drop as { items: TodoItem[] }).items[0], false);
  // 空/空白 blocker（任意状态）→ 视为缺省
  assert.equal(validateTodos([{ content: 'a', status: 'completed', blocker: '' }]).ok, true);
  const emptyBlocked = validateTodos([{ content: 'a', status: 'blocked', blocker: '' }]);
  assert.equal(emptyBlocked.ok, false, 'blocked 态必须有非空 blocker');
  assert.match((emptyBlocked as { error: string }).error, /non-empty string/);
  // blocked 态合法 blocker 保留；类型畸形仍硬拒
  assert.equal((validateTodos([{ content: 'a', status: 'blocked', blocker: '等审核' }]) as { items: TodoItem[] }).items[0].blocker, '等审核');
  assert.equal(validateTodos([{ content: 'a', status: 'blocked', blocker: 123 }]).ok, false);
});

test('validateTodos: phase 空/空白视为缺省；30 字上限；类型畸形仍拒', () => {
  assert.equal(validateTodos([{ content: 'a', status: 'pending', phase: '' }]).ok, true);
  assert.equal(validateTodos([{ content: 'a', status: 'pending', phase: '  ' }]).ok, true);
  assert.equal(validateTodos([{ content: 'a', status: 'pending', phase: 'x'.repeat(31) }]).ok, false);
  assert.equal(validateTodos([{ content: 'a', status: 'pending', phase: 42 }]).ok, false);
  assert.equal(validateTodos([{ content: 'a', status: 'pending', phase: 'x'.repeat(30) }]).ok, true);
});

test('normalizeStrict: 多条 in_progress 保留第一条；无 in_progress 自动晋升第一条 pending', () => {
  assert.deepEqual(normalizeStrict([
    { content: 'a', status: 'in_progress' },
    { content: 'b', status: 'in_progress' },
    { content: 'c', status: 'pending' },
  ]), [
    { content: 'a', status: 'in_progress' },
    { content: 'b', status: 'pending' },
    { content: 'c', status: 'pending' },
  ]);
  // blocked/abandoned 不参与晋升
  assert.deepEqual(normalizeStrict([
    { content: 'a', status: 'blocked', blocker: 'x' },
    { content: 'b', status: 'pending' },
  ]), [
    { content: 'a', status: 'blocked', blocker: 'x' },
    { content: 'b', status: 'in_progress' },
  ]);
  assert.deepEqual(normalizeStrict([{ content: 'a', status: 'completed' }]), [{ content: 'a', status: 'completed' }]);
  assert.deepEqual(normalizeStrict([]), []);
});

test('listsEqual: 全等判定（含 blocker/phase/长度）', () => {
  assert.equal(listsEqual([{ content: 'a', status: 'pending' }], [{ content: 'a', status: 'pending' }]), true);
  assert.equal(listsEqual([{ content: 'a', status: 'pending', phase: 'p' }], [{ content: 'a', status: 'pending' }]), false);
  assert.equal(
    listsEqual([{ content: 'a', status: 'blocked', blocker: 'x' }], [{ content: 'a', status: 'blocked', blocker: 'y' }]),
    false,
  );
  assert.equal(listsEqual([{ content: 'a', status: 'pending' }], []), false);
});

test('completionTransitions/revertedCompleted: 过渡与回退', () => {
  const prev: TodoItem[] = [
    { content: 'a', status: 'in_progress' },
    { content: 'b', status: 'pending' },
    { content: 'c', status: 'completed' },
  ];
  const next: TodoItem[] = [
    { content: 'a', status: 'completed' },
    { content: 'b', status: 'completed' },
    { content: 'c', status: 'pending' },
  ];
  assert.deepEqual(completionTransitions(prev, next), ['a', 'b']);
  assert.deepEqual(revertedCompleted(prev, next), ['c']);
});

test('applyTodoEdits: done/drop/rm 语义与幂等', () => {
  const items: TodoItem[] = [
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

const mkSnap = (items: Array<{ content: string; status: string }>, timestamp?: string) => ({
  type: 'message',
  ...(timestamp ? { timestamp } : {}),
  message: {
    role: 'toolResult',
    toolName: 'todo_write',
    details: { 'pi-herdr.todo': { version: 1, items } },
  },
});
const mkEdit = (op: string, content: string, ts = 1) => ({
  type: 'custom',
  customType: 'pi-herdr.todo-edit',
  data: { version: 1, edits: [{ op, content }], ts },
});

test('foldLatestTodosMeta: 分支路径上取最后一次快照（last-wins），无关条目跳过', () => {
  const entries = [
    { type: 'session', version: 3 },
    { type: 'message', message: { role: 'user', content: [] } },
    mkSnap([{ content: '第一步', status: 'completed' }]),
    { type: 'message', message: { role: 'assistant', content: [] } },
    mkSnap([{ content: '第二步', status: 'in_progress' }]),
  ];
  assert.deepEqual(foldLatestTodosMeta(entries as never)?.items, [{ content: '第二步', status: 'in_progress' }]);

  const irrelevant = [
    { type: 'message', message: { role: 'toolResult', toolName: 'read', details: { x: 1 } } },
    { type: 'message', message: { role: 'toolResult', toolName: 'todo_write', details: {} } },
    { type: 'message', message: { role: 'toolResult', toolName: 'todo_write' } },
    { type: 'message', message: { role: 'assistant' } },
  ];
  assert.equal(foldLatestTodosMeta(irrelevant as never), null);
  assert.equal(foldLatestTodosMeta([]), null, '无任何快照 → null（重建时保留原状态）');
  assert.equal(foldLatestTodosMeta([{ type: 'session' }] as never), null);
});

test('foldLatestTodosMeta: 双源折叠（快照 + 人类编辑交错）', () => {
  const entries = [
    mkSnap([{ content: 'a', status: 'pending' }, { content: 'b', status: 'pending' }]),
    mkEdit('done', 'a'),
    { type: 'custom', customType: 'pi-herdr.subs', data: { version: 2, subs: [] } }, // 无关 custom 跳过
    mkEdit('rm', 'b'),
  ];
  assert.deepEqual(foldLatestTodosMeta(entries as never)?.items, [{ content: 'a', status: 'completed' }]);
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

test('fuzzyFind: 精确 → 前缀 → 子串，歧义列出候选', () => {
  const items: TodoItem[] = [
    { content: '修 board 路径 bug', status: 'pending' },
    { content: 'board 渲染', status: 'pending' },
    { content: '路径测试', status: 'pending' },
  ];
  assert.deepEqual(fuzzyFind(items, '修 board 路径 bug'), ['修 board 路径 bug']);
  assert.deepEqual(fuzzyFind(items, 'board'), ['board 渲染'], '唯一前缀命中 → 不进子串层');
  assert.deepEqual(fuzzyFind(items, '路径'), ['路径测试']);
  assert.deepEqual(fuzzyFind(items, '测试'), ['路径测试']);
  // 无精确/前缀命中 → 子串层，多条即歧义
  const items2: TodoItem[] = [
    { content: '修 board 路径 bug', status: 'pending' },
    { content: '写 board 测试', status: 'pending' },
  ];
  assert.deepEqual(fuzzyFind(items2, 'bug'), ['修 board 路径 bug']);
  assert.deepEqual(fuzzyFind(items2, '不存在'), []);
});

test('boundedView: 预算内原样；超预算隐最老保最新（open 截头部，completed 尾部填充）', () => {
  const items: TodoItem[] = [
    { content: 'o1', status: 'pending' },
    { content: 'o2', status: 'in_progress' },
    { content: 'c1', status: 'completed' },
  ];
  assert.deepEqual(boundedView(items, 10), { visible: items, hiddenCompleted: 0, hiddenOpen: 0 });

  const big: TodoItem[] = [
    { content: 'o1', status: 'pending' },
    { content: 'o2', status: 'pending' },
    { content: 'o3', status: 'pending' },
    { content: 'c1', status: 'completed' },
    { content: 'c2', status: 'completed' },
  ];
  const v = boundedView(big, 2); // open 超额：保 o2/o3，最老 open 与全部 completed 隐藏
  assert.deepEqual(v.visible.map((i) => i.content), ['o2', 'o3']);
  assert.equal(v.hiddenOpen, 1);
  assert.equal(v.hiddenCompleted, 2);
  const v2 = boundedView(big, 4); // 剩余预算给最新完成项（c2），不是最老 c1
  assert.deepEqual(v2.visible.map((i) => i.content), ['o1', 'o2', 'o3', 'c2']);
  assert.equal(v2.hiddenCompleted, 1);
  assert.equal(v2.hiddenOpen, 0);
});

test('countTodos: blocked/abandoned 不计入 completed（D34）；blocked 单列（D91）', () => {
  const c = countTodos([
    { content: 'a', status: 'pending' },
    { content: 'b', status: 'in_progress' },
    { content: 'c', status: 'completed' },
    { content: 'd', status: 'blocked', blocker: 'x' },
    { content: 'e', status: 'abandoned' },
  ]);
  assert.deepEqual(c, { pending: 1, inProgress: 1, completed: 1, blocked: 1 });
});
