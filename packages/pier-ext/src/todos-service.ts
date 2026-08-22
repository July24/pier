/**
 * 档 0：todos 升为进程内 Service（D65 / D75 阶段 2）。
 * 持久化仍是 pi 会话分支重放；D75 阶段 3：config 从 role manifest services 注入
 * （无 manifest 的 master / 纯标签 worker 走默认——worker serial、master parallel）。
 */
import { EventEmitter } from 'node:events';
import {
  applyTodoEdits,
  foldLatestTodos,
  type TodoEdit,
  type TodoItem,
} from './todo-core.ts';
import { countCompletedTransitions } from './progress-core.ts';
import type { RuntimeRoleManifest } from './tool-gate.ts';

export interface TodosConfig {
  strict: boolean;
  allowParallelInProgress: boolean;
}

export class TodosService extends EventEmitter {
  items: TodoItem[] = [];
  readonly config: TodosConfig;

  constructor(config: TodosConfig) {
    super();
    this.config = config;
  }

  /** D75 阶段 3：role manifest services.todos（mode/reminderLimit）驱动；strict = 进程身份（worker）。 */
  static configFromRuntime(manifest: RuntimeRoleManifest | null, isSubagent: boolean): TodosConfig {
    const strict = isSubagent;
    const mode = manifest?.services?.todos?.mode;
    const allowParallelInProgress = mode === 'parallel' || mode === 'serial' ? mode === 'parallel' : !strict;
    return { strict, allowParallelInProgress };
  }

  replace(items: readonly TodoItem[]): void {
    const before = this.items;
    this.items = items.map((it) => ({ ...it }));
    this.emitCompletedTransitions(before, this.items);
    this.emit('todo.updated', { items: this.items });
  }

  applyEdits(edits: readonly TodoEdit[]): void {
    const before = this.items;
    this.items = applyTodoEdits(this.items, edits);
    this.emitCompletedTransitions(before, this.items);
    this.emit('todo.edited', { edits, items: this.items });
    this.emit('todo.updated', { items: this.items });
  }

  /** M16：completed 转换数（所有编辑路径统一 diff；速率估算的原料）。 */
  private emitCompletedTransitions(before: readonly TodoItem[], after: readonly TodoItem[]): void {
    const count = countCompletedTransitions(before, after);
    if (count > 0) this.emit('todo.completed', { count, at: Date.now() });
  }

  rebuild(entries: readonly unknown[]): void {
    // 与 v1.x rebuildFromBranch 同语义：分支上折叠不到快照时保留现值
    //（重建失败不影响主流程；下次 todo_write 会重新锚定）。
    const folded = foldLatestTodos(entries as Parameters<typeof foldLatestTodos>[0]);
    if (folded) this.items = folded;
    this.emit('todo.updated', { items: this.items, reason: 'rebuild' });
  }
}
