/**
 * 档 0/档 2：TodosService.configFromRuntime + 状态/事件（D75 阶段 3）。
 * 缝：configFromRuntime / replace / applyEdits / rebuild / 订阅。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TodosService } from '../src/todos-service.ts';

const service = () => new TodosService(TodosService.configFromRuntime(null, false));

/** todo_write 快照条目（rebuild 的输入形状）。 */
const snap = (items: Array<{ content: string; status: string }>, timestamp?: string) => ({
  type: 'message',
  ...(timestamp ? { timestamp } : {}),
  message: { role: 'toolResult', toolName: 'todo_write', details: { 'pi-herdr.todo': { version: 1, items } } },
});

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
  const svc = service();
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
  const svc = service();
  const edited: unknown[] = [];
  svc.on('todo.edited', (e) => edited.push(e));
  svc.rebuild([snap([{ content: 'A', status: 'pending' }])]);
  assert.deepEqual(svc.items, [{ content: 'A', status: 'pending' }]);
  assert.equal(edited.length, 0);
});

test('反冻结：lastWriteAt 三路径锚定（replace/applyEdits 写时钟，rebuild 取条目时间戳）', () => {
  const svc = service();
  assert.equal(svc.lastWriteAt, null); // 初始未知 → 陈旧度保守
  svc.replace([{ content: 'a', status: 'pending' }]);
  assert.ok(typeof svc.lastWriteAt === 'number');
  const t1 = svc.lastWriteAt as number;
  svc.applyEdits([{ op: 'done', content: 'a' }]);
  assert.ok((svc.lastWriteAt as number) >= t1); // 编辑同样刷新停滞期
  // rebuild：从条目 timestamp 恢复（ISO 字符串）
  svc.rebuild([snap([{ content: 'B', status: 'completed' }], '2026-08-24T09:11:20.291Z')]);
  assert.equal(svc.lastWriteAt, Date.parse('2026-08-24T09:11:20.291Z'));
  // 无时间戳的旧条目 → null（保守不判 archived）
  svc.rebuild([snap([{ content: 'C', status: 'completed' }])]);
  assert.equal(svc.lastWriteAt, null);
  // 人类编辑条目兜底 ts 字段
  svc.rebuild([
    snap([{ content: 'D', status: 'completed' }]),
    { type: 'custom', customType: 'pi-herdr.todo-edit', data: { version: 1, edits: [{ op: 'done', content: 'D' }], ts: 1234 } },
  ]);
  assert.equal(svc.lastWriteAt, 1234);
});

test('getSnapshot: defensive copy; mutating snapshot does not change service', () => {
  const svc = service();
  svc.replace([{ content: 'A', status: 'pending' }]);
  const copy = svc.getSnapshot();
  copy[0].status = 'completed';
  copy.push({ content: 'B', status: 'pending' });
  assert.equal(svc.items.length, 1);
  assert.equal(svc.items[0].status, 'pending');
  assert.equal(svc.items[0].content, 'A', 'items getter 与快照内容一致');
  assert.deepEqual(svc.getSnapshot()[0], { content: 'A', status: 'pending' });
});

test('replace/applyEdits: no-op skips clock and events', () => {
  const svc = service();
  const updated: unknown[] = [];
  const edited: unknown[] = [];
  svc.on('todo.updated', (e) => updated.push(e));
  svc.on('todo.edited', (e) => edited.push(e));
  assert.deepEqual(svc.replace([{ content: 'A', status: 'pending' }]), { changed: true });
  const t1 = svc.lastWriteAt as number;
  assert.equal(updated.length, 1);
  assert.deepEqual(svc.replace([{ content: 'A', status: 'pending' }]), { changed: false });
  assert.equal(svc.lastWriteAt, t1);
  assert.equal(updated.length, 1);
  assert.deepEqual(svc.applyEdits([{ op: 'done', content: 'missing' }]), { changed: false });
  assert.equal(edited.length, 0);
  assert.equal(svc.lastWriteAt, t1);
  assert.deepEqual(svc.applyEdits([{ op: 'done', content: 'A' }]), { changed: true });
  assert.equal(edited.length, 1);
  assert.ok((svc.lastWriteAt as number) >= t1);
});
