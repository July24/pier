/**
 * 档 0：todos 升为进程内 Service（D65 / D75 阶段 2）。
 * 持久化仍是 pi 会话分支重放；D75 阶段 3：config 从 role manifest services 注入
 * （无 manifest 的 master / 纯标签 worker 走默认——worker serial、master parallel）。
 */
import { EventEmitter } from 'node:events';
import {
  applyTodoEdits,
  foldLatestTodosMeta,
  listsEqual,
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
  private _items: TodoItem[] = [];
  /**
   * Live list (read-only). Mutations must go through replace/applyEdits/rebuild.
   */
  get items(): readonly TodoItem[] {
    return this._items;
  }
  /**
   * 列表最后一次真实变更时间（epoch ms）；分支重建取自条目时间戳，无则 null。
   * 陈旧度判定（stale-core）的时钟锚点；null → 保守永不判 stale。
   */
  lastWriteAt: number | null = null;
  readonly config: TodosConfig;

  constructor(config: TodosConfig) {
    super();
    this.config = config;
  }

  /** D75 阶段 3：role manifest services.todos（mode）驱动；strict = 进程身份（worker）。 */
  static configFromRuntime(manifest: RuntimeRoleManifest | null, isSubagent: boolean): TodosConfig {
    const strict = isSubagent;
    const mode = manifest?.services?.todos?.mode;
    const allowParallelInProgress = mode === 'parallel' || mode === 'serial' ? mode === 'parallel' : !strict;
    return { strict, allowParallelInProgress };
  }

  /** Defensive copy for callers that must not mutate service state. */
  getSnapshot(): TodoItem[] {
    return this._items.map((it) => ({ ...it }));
  }

  replace(items: readonly TodoItem[]): { changed: boolean } {
    const next = items.map((it) => ({ ...it }));
    if (listsEqual(this._items, next)) return { changed: false };
    const before = this._items;
    this._items = next;
    this.lastWriteAt = Date.now();
    this.emitCompletedTransitions(before, this._items);
    this.emit('todo.updated', { items: this._items });
    return { changed: true };
  }

  applyEdits(edits: readonly TodoEdit[]): { changed: boolean } {
    const before = this._items;
    const next = applyTodoEdits(this._items, edits);
    if (listsEqual(before, next)) return { changed: false };
    this._items = next;
    this.lastWriteAt = Date.now();
    this.emitCompletedTransitions(before, this._items);
    this.emit('todo.edited', { edits, items: this._items });
    this.emit('todo.updated', { items: this._items });
    return { changed: true };
  }

  /** M16：completed 转换数（所有编辑路径统一 diff；速率估算的原料）。 */
  private emitCompletedTransitions(before: readonly TodoItem[], after: readonly TodoItem[]): void {
    const count = countCompletedTransitions(before, after);
    if (count > 0) this.emit('todo.completed', { count, at: Date.now() });
  }

  rebuild(entries: readonly unknown[]): void {
    // 与 v1.x rebuildFromBranch 同语义：分支上折叠不到快照时保留现值
    //（重建失败不影响主流程；下次 todo_write 会重新锚定）。
    const folded = foldLatestTodosMeta(entries as Parameters<typeof foldLatestTodosMeta>[0]);
    if (folded) {
      this._items = folded.items;
      this.lastWriteAt = folded.writtenAt;
    }
    this.emit('todo.updated', { items: this._items, reason: 'rebuild' });
  }
}
