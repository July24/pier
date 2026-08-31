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
  events: {
    emitted: Array<{ channel: string; data: unknown }>;
    on(channel: string, handler: (data: unknown) => void): () => void;
    emit(channel: string, data: unknown): void;
  };
  registerTool(def: { name: string; execute?: (...a: unknown[]) => unknown }): void;
  registerCommand(name: string, options: { handler?: (...a: unknown[]) => unknown }): void;
  on(event: string, handler: (...a: unknown[]) => unknown): void;
  appendEntry(customType: string, data: unknown): void;
  sendUserMessage(): Promise<void>;
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
}

function fakePi(): FakePi {
  const bus = new Map<string, Array<(data: unknown) => void>>();
  const emitted: Array<{ channel: string; data: unknown }> = [];
  return {
    tools: new Map(),
    commands: new Map(),
    listeners: new Map(),
    entries: [],
    events: {
      emitted,
      on(channel, handler) {
        bus.set(channel, [...(bus.get(channel) ?? []), handler]);
        return () => {
          bus.set(channel, (bus.get(channel) ?? []).filter((h) => h !== handler));
        };
      },
      emit(channel, data) {
        emitted.push({ channel, data });
        for (const handler of bus.get(channel) ?? []) handler(data);
      },
    },
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

async function workerPier(cleanup: { env: () => { set: (k: string, v: string) => void; delete: (k: string) => void } }): Promise<FakePi> {
  const env = cleanup.env();
  env.set('PI_HERDR_SUBAGENT', '1');
  env.delete('HERDR_ENV');
  env.delete('HERDR_SOCKET_PATH');
  env.delete('HERDR_PANE_ID');
  env.delete('PI_HERDR_ROLE_MANIFEST');
  const pi = fakePi();
  await pier(pi as never);
  return pi;
}

test('ask_user_question emits herdr:blocked once around ui.input (official herdr:pi contract)', withCleanup(async (cleanup) => {
  const pi = await workerPier(cleanup);
  let officialDepth = 0;
  pi.events.on('herdr:blocked', (data) => {
    if (data && typeof data === 'object' && 'active' in data && data.active === true) officialDepth += 1;
    else officialDepth = Math.max(0, officialDepth - 1);
  });

  let resolveInput: ((value: string) => void) | undefined;
  const input = new Promise<string>((resolve) => { resolveInput = resolve; });
  const exec = pi.tools.get('ask_user_question')?.execute;
  assert.ok(exec);
  const running = exec!({}, { question: 'deploy staging?' }, undefined, undefined, {
    ui: { input: () => input },
  });

  const blocked = pi.events.emitted.filter((e) => e.channel === 'herdr:blocked');
  assert.equal(blocked.length, 1);
  assert.deepEqual(blocked[0]?.data, { active: true, label: 'deploy staging?' });
  assert.equal(officialDepth, 1, 'official listener must see depth 1, not 2 from self-echo');

  resolveInput!('ok');
  const result = await running as { content: Array<{ text: string }> };
  assert.match(result.content[0]?.text ?? '', /The human answered: ok/);

  const all = pi.events.emitted.filter((e) => e.channel === 'herdr:blocked');
  assert.equal(all.length, 2);
  assert.deepEqual(all[1]?.data, { active: false });
  assert.equal(officialDepth, 0);
}));

test('ask_user_question empty question does not emit herdr:blocked', withCleanup(async (cleanup) => {
  const pi = await workerPier(cleanup);
  const exec = pi.tools.get('ask_user_question')?.execute;
  assert.ok(exec);
  const result = await exec!({}, { question: '   ' }, undefined, undefined, {
    ui: { input: async () => 'nope' },
  }) as { content: Array<{ text: string }> };
  assert.match(result.content[0]?.text ?? '', /must be a non-empty string/);
  assert.equal(pi.events.emitted.filter((e) => e.channel === 'herdr:blocked').length, 0);
}));

