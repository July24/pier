/** Single owner of todo state; every mutation path (tool, human edit, M17 reconcile, archive) lands here (D65, D75). */
import { EventEmitter } from 'node:events';
import { applyTodoEdits, completionTransitions, foldLatestTodosMeta, listsEqual, type TodoEdit, type TodoItem } from './todo-core.ts';
import type { RuntimeRoleManifest } from './tool-gate.ts';

export interface TodosConfig {
  strict: boolean;
  allowParallelInProgress: boolean;
}

export type TodoCompletionSource = 'tool' | 'reconcile' | 'human' | 'archive';

export class TodosService extends EventEmitter {
  private _items: TodoItem[] = [];
  /** Live list (read-only). Mutations must go through replace/applyEdits/rebuild. */
  get items(): readonly TodoItem[] {
    return this._items;
  }
  /** Clock anchor for staleness/archiving; null until the first write. */
  lastWriteAt: number | null = null;
  readonly config: TodosConfig;

  constructor(config: TodosConfig) {
    super();
    this.config = config;
  }

  /** D75: subagents are strict (one in_progress); the role manifest may force parallel mode. */
  static configFromRuntime(manifest: RuntimeRoleManifest | null, isSubagent: boolean): TodosConfig {
    const strict = isSubagent;
    const mode = manifest?.services?.todos?.mode;
    return {
      strict,
      allowParallelInProgress: mode === 'parallel' || mode === 'serial' ? mode === 'parallel' : !strict,
    };
  }

  replace(items: readonly TodoItem[], opts?: { source?: TodoCompletionSource }): { changed: boolean } {
    const next = items.map((it) => ({ ...it }));
    if (listsEqual(this._items, next)) return { changed: false };
    const before = this._items;
    this._items = next;
    this.lastWriteAt = Date.now();
    this.emitCompletedTransitions(before, this._items, opts?.source ?? 'tool');
    this.emit('todo.updated', { items: this._items });
    return { changed: true };
  }

  applyEdits(edits: readonly TodoEdit[], opts?: { source?: TodoCompletionSource }): { changed: boolean } {
    const before = this._items;
    const next = applyTodoEdits(this._items, edits);
    if (listsEqual(before, next)) return { changed: false };
    this._items = next;
    this.lastWriteAt = Date.now();
    this.emitCompletedTransitions(before, this._items, opts?.source ?? 'reconcile');
    this.emit('todo.edited', { edits, items: this._items });
    this.emit('todo.updated', { items: this._items });
    return { changed: true };
  }

  /** M16: ETA and compaction boundaries feed off this single completion diff (same rule as the tool's D36 report). */
  private emitCompletedTransitions(
    before: readonly TodoItem[],
    after: readonly TodoItem[],
    source: TodoCompletionSource = 'tool',
  ): void {
    const count = completionTransitions(before, after).length;
    if (count > 0) this.emit('todo.completed', { count, at: Date.now(), source });
  }

  /** Branch replay: fold the JSONL to the authoritative list, or keep current state when absent. */
  rebuild(entries: readonly unknown[]): void {
    const folded = foldLatestTodosMeta(entries as Parameters<typeof foldLatestTodosMeta>[0]);
    if (folded) {
      this._items = folded.items;
      this.lastWriteAt = folded.writtenAt;
    }
    this.emit('todo.updated', { items: this._items, reason: 'rebuild' });
  }
}
