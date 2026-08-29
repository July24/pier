/**
 * index.ts lifecycle: worker mode + herdr-unavailable degradation.
 * Master/loader path is covered by core-subagent + bootstrap; this boots the
 * real composition root on the worker branch (no cordis loader).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pier from '../src/index.ts';
import { withCleanup } from './test-utils.ts';

interface FakePi {
  tools: Map<string, { name?: string; execute?: (...a: unknown[]) => unknown }>;
  commands: Map<string, { handler?: (...a: unknown[]) => unknown }>;
  listeners: Map<string, Array<(...a: unknown[]) => unknown>>;
  entries: Array<[string, unknown]>;
  registerTool(def: { name: string; execute?: (...a: unknown[]) => unknown }): void;
  registerCommand(name: string, options: { handler?: (...a: unknown[]) => unknown }): void;
  on(event: string, handler: (...a: unknown[]) => unknown): void;
  appendEntry(customType: string, data: unknown): void;
  sendUserMessage(): Promise<void>;
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
}

function fakePi(): FakePi {
  return {
    tools: new Map(),
    commands: new Map(),
    listeners: new Map(),
    entries: [],
    registerTool(def) {
      this.tools.set(def.name, def);
    },
    registerCommand(name, options) {
      this.commands.set(name, options);
    },
    on(event, handler) {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), handler]);
    },
    appendEntry(customType, data) {
      this.entries.push([customType, data]);
    },
    sendUserMessage() {
      return Promise.resolve();
    },
    getActiveTools() {
      return [...this.tools.keys()];
    },
    setActiveTools(_names) {},
  };
}

async function fire(pi: FakePi, event: string, ...args: unknown[]): Promise<void> {
  for (const h of pi.listeners.get(event) ?? []) await h(...args);
}

test('index worker mode: todo + ask_user_question; no subagent tools; herdr no-op', withCleanup(async (cleanup) => {
  const env = cleanup.env();
  env.set('PI_HERDR_SUBAGENT', '1');
  env.delete('HERDR_ENV');
  env.delete('HERDR_SOCKET_PATH');
  env.delete('HERDR_PANE_ID');
  env.delete('PI_HERDR_ROLE_MANIFEST');

  const pi = fakePi();
  await pier(pi as never);

  assert.ok(pi.tools.has('todo_write'), 'worker mounts todo_write');
  assert.ok(pi.tools.has('ask_user_question'), 'common tool still registered');
  assert.ok(pi.commands.has('todos'));
  assert.ok(pi.commands.has('locks'));
  assert.ok(!pi.tools.has('subagent'), 'worker must not register subagent tools');
  assert.ok(!pi.tools.has('list_agents'));
  assert.ok(!pi.tools.has('terminal_open'));

  await fire(pi, 'session_start', { reason: 'new' }, { sessionManager: { getBranch: () => [] } });
  await fire(pi, 'turn_start');
  await fire(pi, 'tool_execution_start', { toolCallId: 'c1', toolName: 'read' });
  await fire(pi, 'tool_execution_end', { toolCallId: 'c1' });
  await fire(pi, 'agent_settled');
  await fire(pi, 'session_shutdown');
}));

test('index master mode: loader mounts subagent + terminal + todo', withCleanup(async (cleanup) => {
  const env = cleanup.env();
  env.delete('PI_HERDR_SUBAGENT');
  env.delete('HERDR_ENV');
  env.delete('HERDR_SOCKET_PATH');
  env.delete('HERDR_PANE_ID');
  env.delete('PI_HERDR_ROLE_MANIFEST');

  const pi = fakePi();
  await pier(pi as never);

  assert.ok(pi.tools.has('todo_write'), 'master mounts todo_write');
  assert.ok(pi.tools.has('subagent'), 'master mounts subagent via loader');
  assert.ok(pi.tools.has('list_agents'));
  assert.ok(pi.tools.has('terminal_open'), 'master mounts terminal via loader');
  assert.ok(pi.commands.has('todos'));
  assert.ok(pi.commands.has('locks'));

  await fire(pi, 'session_start', { reason: 'new' }, { sessionManager: { getBranch: () => [] } });
  await fire(pi, 'agent_settled');
  await fire(pi, 'session_shutdown');
}));
