/**
 * /dashboard command: the standalone view, and the three-level Herdr → tab → local fallback.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatStandaloneDashboard, installDashboardCommand } from '../src/dashboard-command.ts';
import type { HerdrClientLike, HerdrEnv, OpenPluginPaneOptions, OpenPluginPaneResult } from '../src/herdr-client.ts';
import type { TodoItem } from '../src/vocab.ts';

const ENV: HerdrEnv = { socketPath: '/tmp/herdr.sock', paneId: 'p1', workspaceId: 'w1', tabId: 't1' };

class MockHerdrClient {
  available = true;
  mode: OpenPluginPaneResult['mode'] = 'popup';
  shouldThrow = false;
  opened: OpenPluginPaneOptions | null = null;

  async openPluginPane(opts: OpenPluginPaneOptions): Promise<OpenPluginPaneResult> {
    this.opened = opts;
    if (this.shouldThrow) throw new Error('plugin not found');
    if (this.mode === 'popup') return { mode: 'popup', ok: true };
    if (this.mode === 'fallback_tab') return { mode: 'fallback_tab', tabId: 't2' };
    return { mode: 'pane', paneId: 'p2' };
  }
}

/** Install the command and run its handler, capturing the notifications it raises. */
async function runDashboard(
  opts: { available?: boolean; mode?: OpenPluginPaneResult['mode']; shouldThrow?: boolean; env?: HerdrEnv | null; todos?: TodoItem[]; locks?: string[] },
): Promise<{ notifications: Array<{ text: string; level?: string }>; client: MockHerdrClient }> {
  const client = new MockHerdrClient();
  client.available = opts.available ?? true;
  client.mode = opts.mode ?? 'popup';
  client.shouldThrow = opts.shouldThrow ?? false;

  type Handler = (args: unknown, ctx: unknown) => Promise<void>;
  let handler: Handler | undefined;
  installDashboardCommand({
    pi: {
      registerCommand: (name: string, options: { description: string; handler: (args: unknown, ctx: unknown) => Promise<void> }) => {
        assert.equal(name, 'dashboard');
        handler = options.handler;
      },
    },
    client: client as unknown as HerdrClientLike,
    env: opts.env === undefined ? ENV : opts.env,
    getTodoItems: () => opts.todos ?? [],
    getHeldLocks: () => opts.locks ?? [],
  });
  const notifications: Array<{ text: string; level?: string }> = [];
  await handler!(null, { ui: { notify: (text: string, level?: string) => notifications.push({ text, level }) } });
  return { notifications, client };
}

test('formatStandaloneDashboard: groups the todos by status and lists the write locks', () => {
  const todos: TodoItem[] = [
    { content: 'Build task', status: 'in_progress' },
    { content: 'Waiting human approval', status: 'blocked', blocker: 'needs review' },
    { content: 'Initial setup', status: 'completed' },
    { content: 'Future plan', status: 'pending' },
  ];
  const text = formatStandaloneDashboard({ todos, locks: ['/path/to/file.ts'], now: 1726567200000 });

  assert.match(text, /PIER OPS DASHBOARD/);
  assert.match(text, /Mode: Standalone/);
  assert.match(text, /Todos: 4 total \(1 done, 1 working, 1 blocked, 1 pending\)/);
  assert.match(text, /Active: ▶ Build task/);
  assert.match(text, /Blocked: ■ Waiting human approval \(needs review\)/);
  assert.match(text, /Write Locks: \/path\/to\/file\.ts/);
});

test('formatStandaloneDashboard: empty state, and recent completions only when nothing is in flight', () => {
  const empty = formatStandaloneDashboard({ todos: [], locks: [] });
  assert.match(empty, /Todos: \(none\)/);
  assert.match(empty, /Write Locks: \(none\)/);

  const done = formatStandaloneDashboard({
    todos: [
      { content: 'one', status: 'completed' },
      { content: 'two', status: 'completed' },
      { content: 'three', status: 'completed' },
      { content: 'four', status: 'completed' },
      { content: 'stale', status: 'abandoned' },
    ],
    locks: [],
  });
  assert.match(done, /Completed: ✓ two, three, four/, 'only the last three completions are listed');
  assert.match(done, /5 total \(4 done, 0 working, 0 blocked, 0 pending\)/, 'abandoned counts in the total but has no bucket');

  const busy = formatStandaloneDashboard({
    todos: [{ content: 'working', status: 'in_progress' }, { content: 'one', status: 'completed' }],
    locks: [],
  });
  assert.equal(busy.includes('Completed: ✓'), false);
});

test('installDashboardCommand: Herdr 0.9.1 opens the popup plugin pane without notifying', async () => {
  const { notifications, client } = await runDashboard({});
  assert.equal(client.opened?.pluginId, 'pier.workbench');
  assert.equal(client.opened?.entrypoint, 'dashboard');
  assert.equal(client.opened?.placement, 'popup');
  assert.deepEqual(notifications, []);
});

test('installDashboardCommand: Herdr < 0.9.1 falls back to a tab and says so', async () => {
  const { notifications } = await runDashboard({ mode: 'fallback_tab' });
  assert.equal(notifications.length, 1);
  assert.match(notifications[0]!.text, /opened in new tab/);
});

test('installDashboardCommand: outside Herdr, or when the pane fails, the local view is shown', async () => {
  const outside = await runDashboard({ available: false, env: null, todos: [{ content: 'Local task', status: 'in_progress' }], locks: ['local.lock'] });
  assert.equal(outside.client.opened, null, 'no pane is attempted outside Herdr');
  assert.match(outside.notifications[0]!.text, /Mode: Standalone/);
  assert.match(outside.notifications[0]!.text, /Local task/);
  assert.match(outside.notifications[0]!.text, /local\.lock/);

  const failing = await runDashboard({ shouldThrow: true, todos: [{ content: 'Fallback task', status: 'completed' }] });
  assert.match(failing.notifications[0]!.text, /Mode: Standalone/);
  assert.match(failing.notifications[0]!.text, /Fallback task/);
});
