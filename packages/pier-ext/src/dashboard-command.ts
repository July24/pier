import type { HerdrClientLike, HerdrEnv } from './herdr-client.ts';
import { isTodoStatus, type TodoItem, type TodoStatus } from './vocab.ts';

export interface DashboardCommandDeps {
  pi: {
    registerCommand(name: string, options: { description: string; handler: (args: unknown, ctx: unknown) => Promise<void> }): void;
  };
  client: HerdrClientLike;
  env: HerdrEnv | null;
  getTodoItems?: () => readonly TodoItem[];
  getHeldLocks?: () => readonly string[];
}

/** SUMMARY_ORDER fixes the summary-line order; LIVE_ROWS adds the detail line below it.
 * `abandoned` is counted in the total but never listed. */
const SUMMARY_ORDER = [
  { status: 'completed', label: 'done' },
  { status: 'in_progress', label: 'working' },
  { status: 'blocked', label: 'blocked' },
  { status: 'pending', label: 'pending' },
] as const;

const LIVE_ROWS = [
  { status: 'in_progress', label: 'Active', glyph: '▶', line: (todo: TodoItem) => todo.content },
  {
    status: 'blocked',
    label: 'Blocked',
    glyph: '■',
    line: (todo: TodoItem) => `${todo.content}${todo.blocker ? ` (${todo.blocker})` : ''}`,
  },
] as const;

export function formatStandaloneDashboard(opts: {
  todos: readonly TodoItem[];
  locks: readonly string[];
  now?: number;
}): string {
  const lines: string[] = [];
  const timeStr = new Date(opts.now ?? Date.now()).toTimeString().split(' ')[0] ?? '';
  lines.push(`==================== PIER OPS DASHBOARD ==================== [${timeStr}] (standalone)`);
  lines.push('Mode: Standalone (Non-Herdr / Local Session)');
  lines.push('--------------------------------------------------------------------------------');

  if (opts.todos.length === 0) {
    lines.push('Todos: (none)');
  } else {
    const groups: Record<TodoStatus, TodoItem[]> = {
      pending: [], in_progress: [], completed: [], blocked: [], abandoned: [],
    };
    // Corrupt snapshots can carry any status; a prototype key would make `groups[...].push` throw.
    const todos = opts.todos.filter((todo) => isTodoStatus(todo.status));
    for (const todo of todos) groups[todo.status].push(todo);

    lines.push(
      `Todos: ${todos.length} total (${SUMMARY_ORDER.map((row) => `${groups[row.status].length} ${row.label}`).join(', ')})`,
    );
    for (const row of LIVE_ROWS) {
      const items = groups[row.status];
      if (items.length > 0) lines.push(`${row.label}: ${row.glyph} ${items.map(row.line).join(', ')}`);
    }
    // Recent completions only carry signal when nothing is in flight.
    if (groups.in_progress.length === 0 && groups.blocked.length === 0 && groups.completed.length > 0) {
      lines.push(`Completed: ✓ ${groups.completed.slice(-3).map((todo) => todo.content).join(', ')}`);
    }
  }

  const locks = opts.locks;
  lines.push(`Write Locks: ${locks.length > 0 ? locks.join(', ') : '(none)'}`);
  lines.push('--------------------------------------------------------------------------------');
  lines.push('Tip: Inside Herdr 0.9.1, /dashboard opens the interactive modal popup.');
  lines.push('================================================================================');
  return lines.join('\n');
}

export function installDashboardCommand(deps: DashboardCommandDeps): void {
  deps.pi.registerCommand('dashboard', {
    description: 'Open the Pier Ops Dashboard (modal popup in Herdr 0.9.1, tab fallback, or local TUI view)',
    handler: async (_args, ctx) => {
      const ui = (ctx as { ui?: { notify?: (text: string, level?: string) => void } }).ui;

      if (deps.client.available && deps.env) {
        try {
          const res = await deps.client.openPluginPane({
            pluginId: 'pier.workbench',
            entrypoint: 'dashboard',
            placement: 'popup',
            width: '80%',
            height: '80%',
            focus: true,
          });
          if (res.mode === 'fallback_tab') {
            ui?.notify?.('Herdr < 0.9.1: Pier Dashboard opened in new tab', 'info');
          }
          return;
        } catch {
          // Plugin missing or socket error: fall through to the Level 3 local view.
        }
      }

      // Level 3: Standalone / Non-Herdr fallback
      const text = formatStandaloneDashboard({
        todos: deps.getTodoItems?.() ?? [],
        locks: deps.getHeldLocks?.() ?? [],
      });
      ui?.notify?.(text, 'info');
    },
  });
}
