/**
 * widget 活动锚定窗口（用户实证二修）：
 * 可见区段锚定第一条 in_progress（无则最后一条 open）——正在做的条目及其
 * 前后上下文可见，不再是固定头部/尾部（旧"丢最老"实现让执行位置滚出视窗）。
 * 预算按渲染行数（含 phase 头）计，≤ WIDGET_MAX_LINES。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WIDGET_MAX_LINES, widgetLines } from '../src/core/todo.ts';
import type { TodoItem } from '../src/vocab.ts';

const it = (content: string, status: TodoItem['status'], phase?: string): TodoItem =>
  ({ content, status, ...(phase ? { phase } : {}) }) as TodoItem;

test('widgetLines: 复现实证场景——老 phase 组 + 最新 open 组，超窗时最新组存活', () => {
  // 截图场景：[打包][文档][验证][发布] 四组 8 条（5✓ + 2○ + 1□），
  // 最新工作（发布组 in_progress）必须可见，老 completed 条目被隐藏
  const items = [
    it('改造 packages/pier-ext', 'completed', '打包'),
    it('编写 README', 'completed', '文档'),
    it('更新根目录文档', 'completed', '文档'),
    it('npm pack 验证', 'completed', '验证'),
    it('准备 workflow', 'completed', '发布'),
    it('发布 npm', 'in_progress', '发布'),
    it('打 tag', 'pending'),
    it('验证安装', 'blocked', '验证'),
  ];
  const lines = widgetLines(items);
  assert.ok(lines.length <= WIDGET_MAX_LINES, `widget 自控 ≤${WIDGET_MAX_LINES} 行（实际 ${lines.length}）`);
  const joined = lines.join('\n');
  assert.ok(joined.includes('▶ 发布 npm'), '最新 in_progress 可见');
  assert.ok(joined.includes('■ 验证安装'), 'blocked 可见');
  assert.ok(joined.includes('○ 打 tag'), 'pending 可见');
  assert.ok(!joined.includes('✓ 编写 README'), '老 completed 让位隐藏');
  assert.match(joined, /\+\d+ hidden/, '隐藏计数行存在');
  assert.match(joined, /\/todos/, '指路全量视图');
});

test('widgetLines: 预算内全量显示（无隐藏行）', () => {
  const items = [
    it('a', 'in_progress', 'P1'),
    it('b', 'pending', 'P1'),
    it('c', 'completed', 'P2'),
  ];
  const lines = widgetLines(items);
  assert.equal(lines[0], 'todo: 1▶ 1○ 0■ 1✓');
  assert.deepEqual(lines.slice(1), ['  [P1]', '  ▶ a', '  ○ b', '  [P2]', '  ✓ c']);
  assert.ok(!lines.some((l) => l.includes('hidden')), '无隐藏行');
});

test('widgetLines: 全 open 超窗 → 保最新（丢最老 open）', () => {
  const items = Array.from({ length: 12 }, (_, i) => it(`t${i}`, 'pending'));
  const lines = widgetLines(items);
  const itemLines = lines.filter((l) => l.startsWith('  ○'));
  assert.equal(itemLines.length, 8, '摘要+more 占 2 行 → 8 条可见');
  assert.ok(itemLines.some((l) => l.includes('t11')), '最新存活');
  assert.ok(!itemLines.some((l) => /t0$/.test(l)), '最老（t0）隐藏');
  assert.ok(!itemLines.some((l) => /t3$/.test(l)), 't3 隐藏');
});

test('widgetLines: 活动锚定滚动——执行到中部时，窗口跟着 in_progress 走（前因后果可见）', () => {
  // 12 条 open 无 phase：in_progress 在 t4 → 窗口以 t4 为锚（尾部优先扩张）
  const items = Array.from({ length: 12 }, (_, i) =>
    it(`t${i}`, i === 4 ? 'in_progress' : 'pending'));
  const lines = widgetLines(items);
  const joined = lines.join('\n');
  assert.ok(lines.length <= WIDGET_MAX_LINES, '行数预算');
  assert.ok(joined.includes('▶ t4'), '锚点（正在做）必可见');
  assert.ok(joined.includes('○ t5'), '后续工作可见（尾部优先）');
  assert.ok(joined.includes('○ t3'), '前一条上下文可见');
  assert.ok(!joined.includes('○ t0'), '远处已完成让位');
  assert.match(joined, /\+\d+ hidden/);
});

test('widgetLines: 无 in_progress → 锚定最后一条 open（最新存活）', () => {
  const items = [
    ...Array.from({ length: 10 }, (_, i) => it(`done${i}`, 'completed')),
    it('next1', 'pending'),
    it('next2', 'pending'),
  ];
  const lines = widgetLines(items);
  const joined = lines.join('\n');
  assert.ok(joined.includes('○ next2'), '最后一条 open 可见');
  assert.ok(joined.includes('○ next1'), '相邻 open 可见');
  assert.ok(!joined.includes('done0'), '老 completed 让位');
});

test('widgetLines: 空列表 → 空行数组', () => {
  assert.deepEqual(widgetLines([]), []);
});

test('widgetLines: blocked 带 blocker 后缀', () => {
  const items = [{ content: 'x', status: 'blocked', blocker: '等审核' } as TodoItem];
  const lines = widgetLines(items);
  assert.ok(lines.some((l) => l.includes('■ x — 等审核')));
});

test('widgetLines: 反冻结——归档列表不逐条渲染，两行降权', () => {
  const items = [
    it('Verify gateway', 'completed', 'verify'),
    it('Verify ids', 'completed', 'verify'),
    it('Update doc', 'completed', 'doc'),
  ];
  const lines = widgetLines(items, { archivedAgeMs: 16 * 3_600_000 });
  assert.equal(lines.length, 2);
  assert.match(lines[0], /todo: 0▶ 0○ 0■ 3✓ · archived 16h/);
  assert.match(lines[1], /\/todos/);
  assert.ok(!lines.some((l) => l.includes('Verify gateway')), '归档后死条目不再占视窗');
  // 未传归档 → 原有全量渲染行为不变
  const plain = widgetLines(items);
  assert.ok(plain.some((l) => l.includes('✓ Verify gateway')));
});
