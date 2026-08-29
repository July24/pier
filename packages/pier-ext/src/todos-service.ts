/** Why: Preserve the established compatibility and safety behavior (D65, D75). */
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
  /** Why: Preserve the established compatibility and safety behavior. */
  lastWriteAt: number | null = null;
  readonly config: TodosConfig;

  constructor(config: TodosConfig) {
    super();
    this.config = config;
  }

  /** Why: Preserve the established compatibility and safety behavior (D75). */
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

  /** Why: Preserve the established compatibility and safety behavior (M16). */
  private emitCompletedTransitions(before: readonly TodoItem[], after: readonly TodoItem[]): void {
    const count = countCompletedTransitions(before, after);
    if (count > 0) this.emit('todo.completed', { count, at: Date.now() });
  }

  rebuild(entries: readonly unknown[]): void {
    // Why: Preserve the established compatibility and safety behavior.
    // Why: Preserve the established compatibility and safety behavior.
    const folded = foldLatestTodosMeta(entries as Parameters<typeof foldLatestTodosMeta>[0]);
    if (folded) {
      this._items = folded.items;
      this.lastWriteAt = folded.writtenAt;
    }
    this.emit('todo.updated', { items: this._items, reason: 'rebuild' });
  }
}
