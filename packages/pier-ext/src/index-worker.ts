/**
 * Worker-process todo plugin mount (bare cordis root, no loader/hmr).
 *
 * Why: short-lived worker panes only need the todo coordination plugin.
 * Dynamically imported from the worker branch so bootstrap/loader stay out.
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Context } from '@deepseek-ai/cordis';
import { PiSurface } from './pi-surface.ts';
import todoPlugin from './core/todo.ts';
import type { TodosService } from './todos-service.ts';
import type { TodoUiSlot } from './core/todo.ts';

export interface WorkerPluginMount {
  pi: ExtensionAPI;
  todos: TodosService;
  todoUi: TodoUiSlot;
  mirrorTodos: () => void;
}

export async function mountWorkerTodo(m: WorkerPluginMount): Promise<void> {
  const workerRoot = new Context();
  const workerSurface = new PiSurface(m.pi as unknown as object);
  workerRoot.provide('pi-herdr.surface', workerSurface);
  workerRoot.provide('pi-herdr.todo-deps', {
    todos: m.todos,
    allowParallelInProgress: m.todos.config.allowParallelInProgress,
    maxItems: 15,
    mirrorTodos: m.mirrorTodos,
    appendEntry: (customType: string, data: unknown) => {
      (m.pi as { appendEntry?: (t: string, d: unknown) => void }).appendEntry?.(customType, data);
    },
    state: m.todoUi,
  });
  await workerRoot.plugin(todoPlugin);
  m.pi.on('session_shutdown', () => {
    void workerRoot.fiber.dispose();
  });
}
