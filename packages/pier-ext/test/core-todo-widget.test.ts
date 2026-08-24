/**
 * widget 全局预算（用户实证修复）：
 * pi TUI MAX_WIDGET_LINES=10 头部截断——旧实现按分组序渲染，老 phase 吃光窗口、
 * 最新任务组（in_progress 所在）整组不可见。缝：widgetLines（全局预算 + open 优先存活）。
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

test('widgetLines: 空列表 → 空行数组', () => {
  assert.deepEqual(widgetLines([]), []);
});

test('widgetLines: blocked 带 blocker 后缀', () => {
  const items = [{ content: 'x', status: 'blocked', blocker: '等审核' } as TodoItem];
  const lines = widgetLines(items);
  assert.ok(lines.some((l) => l.includes('■ x — 等审核')));
});
