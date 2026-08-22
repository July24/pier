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
