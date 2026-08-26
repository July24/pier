/**
 * 档 0/档 2：TodosService.configFromRuntime + 状态/事件（D75 阶段 3）。
 * 缝：configFromRuntime / replace / applyEdits / rebuild / 订阅。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TodosService } from '../src/todos-service.ts';

test('configFromRuntime: worker 无 manifest → strict serial（v1 语义保持）', () => {
  const cfg = TodosService.configFromRuntime(null, true);
  assert.equal(cfg.strict, true);
  assert.equal(cfg.allowParallelInProgress, false);
});

test('configFromRuntime: master 无 manifest → parallel', () => {
  const cfg = TodosService.configFromRuntime(null, false);
  assert.equal(cfg.strict, false);
  assert.equal(cfg.allowParallelInProgress, true);
});

test('configFromRuntime: manifest services.todos.mode 优先（master 档案 parallel / worker 档案 serial）', () => {
  const masterCfg = TodosService.configFromRuntime(
    { role: 'master', tools: [], permissions: {}, services: { todos: { mode: 'parallel' } } },
    false,
  );
  assert.equal(masterCfg.allowParallelInProgress, true);
  const workerCfg = TodosService.configFromRuntime(
    { role: 'worker-default', tools: [], permissions: {}, services: { todos: { mode: 'serial' } } },
    true,
  );
  assert.equal(workerCfg.strict, true);
  assert.equal(workerCfg.allowParallelInProgress, false);
  // mode 声明 parallel 的 worker 也放行（显式声明 > 进程默认）
  const explicitParallel = TodosService.configFromRuntime(
    { role: 'x', tools: [], permissions: {}, services: { todos: { mode: 'parallel' } } },
    true,
  );
  assert.equal(explicitParallel.allowParallelInProgress, true);
});

test('replace 发出 todo.updated；applyEdits 发出 todo.edited', () => {
  const svc = new TodosService(TodosService.configFromRuntime(null, false));
  const updated: unknown[] = [];
  const edited: unknown[] = [];
  svc.on('todo.updated', (e) => updated.push(e));
  svc.on('todo.edited', (e) => edited.push(e));
  svc.replace([{ content: 'Clone kimi', status: 'pending' }]);
  assert.equal(svc.items.length, 1);
  assert.equal(updated.length, 1);
  svc.applyEdits([{ op: 'done', content: 'Clone kimi' }]);
  assert.equal(svc.items[0].status, 'completed');
  assert.equal(edited.length, 1);
  assert.equal(updated.length, 2);
});

test('rebuild 从分支折叠，不发 edited', () => {
  const svc = new TodosService(TodosService.configFromRuntime(null, false));
  const edited: unknown[] = [];
  svc.on('todo.edited', (e) => edited.push(e));
  svc.rebuild([
    {
      type: 'message',
      message: {
        role: 'toolResult',
        toolName: 'todo_write',
        details: { 'pi-herdr.todo': { version: 1, items: [{ content: 'A', status: 'pending' }] } },
      },
    },
  ]);
  assert.deepEqual(svc.items, [{ content: 'A', status: 'pending' }]);
  assert.equal(edited.length, 0);
});

test('反冻结：lastWriteAt 三路径锚定（replace/applyEdits 写时钟，rebuild 取条目时间戳）', () => {
  const svc = new TodosService(TodosService.configFromRuntime(null, false));
  assert.equal(svc.lastWriteAt, null); // 初始未知 → 陈旧度保守
  svc.replace([{ content: 'a', status: 'pending' }]);
  assert.ok(typeof svc.lastWriteAt === 'number');
  const t1 = svc.lastWriteAt as number;
  svc.applyEdits([{ op: 'done', content: 'a' }]);
  assert.ok((svc.lastWriteAt as number) >= t1); // 编辑同样刷新停滞期
  // rebuild：从条目 timestamp 恢复（epoch ms 或 ISO 字符串均可）
  svc.rebuild([
    {
      type: 'message',
      timestamp: '2026-08-24T09:11:20.291Z',
      message: {
        role: 'toolResult',
        toolName: 'todo_write',
        details: { 'pi-herdr.todo': { version: 1, items: [{ content: 'B', status: 'completed' }] } },
      },
    },
  ]);
  assert.equal(svc.lastWriteAt, Date.parse('2026-08-24T09:11:20.291Z'));
  // 无时间戳的旧条目 → null（保守不判 archived）
  svc.rebuild([
    {
      type: 'message',
      message: {
        role: 'toolResult',
        toolName: 'todo_write',
        details: { 'pi-herdr.todo': { version: 1, items: [{ content: 'C', status: 'completed' }] } },
      },
    },
  ]);
  assert.equal(svc.lastWriteAt, null);
  // 人类编辑条目兜底 ts 字段
  svc.rebuild([
    {
      type: 'message',
      message: {
        role: 'toolResult',
        toolName: 'todo_write',
        details: { 'pi-herdr.todo': { version: 1, items: [{ content: 'D', status: 'completed' }] } },
      },
    },
    { type: 'custom', customType: 'pi-herdr.todo-edit', data: { version: 1, edits: [{ op: 'done', content: 'D' }], ts: 1234 } },
  ]);
  assert.equal(svc.lastWriteAt, 1234);
});
