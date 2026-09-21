/**
 * TodosService: role-config resolution, branch rebuild, the lastWriteAt anti-freeze clock, and
 * change/event semantics (a no-op write must not move state, clock, or events).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TodosService } from '../src/todos-service.ts';
const service = () => new TodosService(TodosService.configFromRuntime(null, false));
/** todo_write snapshot entry (the shape rebuild folds). */
const snap = (items: Array<{ content: string; status: string }>, timestamp?: string) => ({
  type: 'message',
  ...(timestamp ? { timestamp } : {}),
  message: { role: 'toolResult', toolName: 'todo_write', details: { 'pi-herdr.todo': { version: 1, items } } },
});
type Manifest = Parameters<typeof TodosService.configFromRuntime>[0];
const PARALLEL_MANIFEST = { role: 'x', tools: [], permissions: {}, services: { todos: { mode: 'parallel' } } } as Manifest;
const SERIAL_MANIFEST = { role: 'x', tools: [], permissions: {}, services: { todos: { mode: 'serial' } } } as Manifest;
const CONFIG_CASES: Array<[string, Manifest | null, boolean, { strict: boolean; allowParallelInProgress: boolean }]> = [
  ['worker 无 manifest → strict serial（v1 语义保持）', null, true, { strict: true, allowParallelInProgress: false }],
  ['master 无 manifest → parallel', null, false, { strict: false, allowParallelInProgress: true }],
  ['worker 档案 mode=serial → 保持 serial', SERIAL_MANIFEST, true, { strict: true, allowParallelInProgress: false }],
  // An explicit mode declaration beats the process default in both directions.
  ['worker 档案 mode=parallel → 放行', PARALLEL_MANIFEST, true, { strict: true, allowParallelInProgress: true }],
  ['master 档案 mode=parallel → 放行', PARALLEL_MANIFEST, false, { strict: false, allowParallelInProgress: true }],
];
test('configFromRuntime: 进程默认 vs manifest services.todos.mode（显式声明优先）', () => {
  for (const [name, manifest, isSubagent, expected] of CONFIG_CASES) {
    const cfg = TodosService.configFromRuntime(manifest, isSubagent);
    assert.equal(cfg.strict, expected.strict, `${name}: strict`);
    assert.equal(cfg.allowParallelInProgress, expected.allowParallelInProgress, `${name}: allowParallel`);
  }
});
test('replace/applyEdits: 状态迁移 + 事件；no-op 跳过时钟与事件', () => {
  const svc = service();
  const updated: unknown[] = [];
  const edited: unknown[] = [];
  svc.on('todo.updated', (e) => updated.push(e));
  svc.on('todo.edited', (e) => edited.push(e));
  assert.deepEqual(svc.replace([{ content: 'Clone kimi', status: 'pending' }]), { changed: true });
  assert.equal(svc.items.length, 1);
  assert.equal(updated.length, 1);
  assert.deepEqual(svc.applyEdits([{ op: 'done', content: 'Clone kimi' }]), { changed: true });
  assert.equal(svc.items[0].status, 'completed');
  assert.equal(edited.length, 1);
  assert.equal(updated.length, 2);
  // A no-op write must leave state, clock and events untouched.
  const t1 = svc.lastWriteAt as number;
  assert.deepEqual(svc.replace([{ content: 'Clone kimi', status: 'completed' }]), { changed: false });
  assert.equal(svc.lastWriteAt, t1, 'no-op 不刷新时钟');
  assert.equal(updated.length, 2);
  assert.deepEqual(svc.applyEdits([{ op: 'done', content: 'missing' }]), { changed: false });
  assert.equal(edited.length, 1);
  assert.equal(svc.lastWriteAt, t1);
});
test('rebuild + 反冻结：从分支折叠落定权威列表；lastWriteAt 三路径锚定', () => {
  const svc = service();
  assert.equal(svc.lastWriteAt, null); // unknown start → conservative staleness
  svc.replace([{ content: 'a', status: 'pending' }]);
  assert.ok(typeof svc.lastWriteAt === 'number');
  const t1 = svc.lastWriteAt as number;
  svc.applyEdits([{ op: 'done', content: 'a' }]);
  assert.ok((svc.lastWriteAt as number) >= t1);
  svc.rebuild([snap([{ content: 'B', status: 'completed' }], '2026-08-24T09:11:20.291Z')]);
  assert.deepEqual(svc.items, [{ content: 'B', status: 'completed' }], 'rebuild 落定权威列表');
  assert.equal(svc.lastWriteAt, Date.parse('2026-08-24T09:11:20.291Z'));
  // An entry without a timestamp → null (the list is never judged archived).
  svc.rebuild([snap([{ content: 'C', status: 'completed' }])]);
  assert.equal(svc.lastWriteAt, null);
  // Human-edit entries fall back to their ts field.
  svc.rebuild([
    snap([{ content: 'D', status: 'completed' }]),
    { type: 'custom', customType: 'pi-herdr.todo-edit', data: { version: 1, edits: [{ op: 'done', content: 'D' }], ts: 1234 } },
  ]);
  assert.equal(svc.lastWriteAt, 1234);
});
