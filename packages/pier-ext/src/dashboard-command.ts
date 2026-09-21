import type { HerdrClientLike, HerdrEnv } from './herdr-client.ts';
import type { TodoItem, TodoStatus } from './vocab.ts';

export interface DashboardCommandDeps {
  pi: {
    registerCommand(name: string, options: { description: string; handler: (args: unknown, ctx: unknown) => Promise<void> }): void;
  };
  client: HerdrClientLike;
  env: HerdrEnv | null;
  getTodoItems?: () => readonly TodoItem[];
  getHeldLocks?: () => readonly string[];
}

/**
 * Presentation of the todo states that appear in the standalone view: `count` labels the summary
 * line, `live` adds the detail line that follows it. `abandoned` is tracked but not shown.
 */
const STATUS_ROWS: ReadonlyArray<{
  status: Exclude<TodoStatus, 'abandoned'>;
  count: string;
  live?: { label: string; glyph: string; line: (todo: TodoItem) => string };
}> = [
  { status: 'completed', count: 'done' },
  { status: 'in_progress', count: 'working', live: { label: 'Active', glyph: '▶', line: (todo) => todo.content } },
  {
    status: 'blocked',
    count: 'blocked',
    live: { label: 'Blocked', glyph: '■', line: (todo) => `${todo.content}${todo.blocker ? ` (${todo.blocker})` : ''}` },
  },
  { status: 'pending', count: 'pending' },
];

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
    for (const todo of opts.todos) groups[todo.status].push(todo);

    lines.push(
      `Todos: ${opts.todos.length} total (${STATUS_ROWS.map((row) => `${groups[row.status].length} ${row.count}`).join(', ')})`,
    );
    for (const row of STATUS_ROWS) {
      const items = groups[row.status];
      if (row.live && items.length > 0) {
        lines.push(`${row.live.label}: ${row.live.glyph} ${items.map(row.live.line).join(', ')}`);
      }
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

      // Level 1 / Level 2: Herdr environment
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
          // If plugin is not installed or socket error occurs, fall through to Level 3 local view
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
