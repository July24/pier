/** Todo-only plugin mount (bare cordis root, no loader/hmr). Used by worker panes and by standalone
 *  pi outside herdr, so bootstrap/subagent/terminal stay out of those processes. */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Context } from '@deepseek-ai/cordis';
import { PiSurface } from './pi-surface.ts';
import { baseTodoDeps, cordisProvide } from './cordis-services.ts';
import todoPlugin from './plugins/todo.ts';
import type { TodosService } from './todos-service.ts';
import type { TodoUiSlot } from './plugins/todo.ts';

export interface TodoOnlyMount {
  pi: ExtensionAPI;
  todos: TodosService;
  todoUi: TodoUiSlot;
  mirrorTodos: () => void;
  /** Human-gate depth source; collapses the todo widget to one line while a gate is open. */
  getBlockedDepth?: () => number;
  /** Master-only stop reminder; omit on worker panes. */
  stopReminder?: {
    getBlockedDepth: () => number;
    getRunningSubs: () => number;
    isCompactionInFlight?: () => boolean;
    isIntentionalAbort?: () => boolean;
  };
}

export async function mountTodoOnly(m: TodoOnlyMount): Promise<void> {
  const workerRoot = new Context();
  const workerSurface = new PiSurface(m.pi as unknown as object);
  cordisProvide(workerRoot, 'pi-herdr.surface', workerSurface);
  cordisProvide(workerRoot, 'pi-herdr.todo-deps', {
    ...baseTodoDeps(m),
    ...(m.getBlockedDepth ? { getBlockedDepth: m.getBlockedDepth } : {}),
    ...(m.stopReminder ? { stopReminder: m.stopReminder } : {}),
  });
  await workerRoot.plugin(todoPlugin);
  m.pi.on('session_shutdown', () => {
    void workerRoot.fiber.dispose();
  });
}
