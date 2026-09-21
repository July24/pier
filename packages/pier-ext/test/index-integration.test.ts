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
  sent: Array<{ message: unknown; options: unknown }>;
  events: {
    emitted: Array<{ channel: string; data: unknown }>;
    on(channel: string, handler: (data: unknown) => void): () => void;
    emit(channel: string, data: unknown): void;
  };
  registerTool(def: { name: string; execute?: (...a: unknown[]) => unknown }): void;
  registerCommand(name: string, options: { handler?: (...a: unknown[]) => unknown }): void;
  on(event: string, handler: (...a: unknown[]) => unknown): void;
  appendEntry(customType: string, data: unknown): void;
  sendMessage(message: unknown, options?: unknown): void;
  sentUserMessages: Array<{ content: string; opts?: unknown }>;
  sendUserMessage(content?: string, opts?: unknown): Promise<void>;
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
    sent: [],
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
    sendMessage(message, options) {
      this.sent.push({ message, options });
    },
    sentUserMessages: [],
    sendUserMessage(content, opts) {
      this.sentUserMessages.push({ content: String(content ?? ''), opts });
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
  assert.ok(!pi.commands.has('locks'), 'write locks stay herdr-only');
  assert.ok(!pi.tools.has('subagent'), 'worker must not register subagent tools');
  assert.ok(!pi.tools.has('terminal'), 'worker must not register terminal tools');

  await fire(pi, 'session_start', { reason: 'new' }, { sessionManager: { getBranch: () => [] } });
  await fire(pi, 'turn_start');
  await fire(pi, 'tool_execution_start', { toolCallId: 'c1', toolName: 'read' });
  await fire(pi, 'tool_execution_end', { toolCallId: 'c1' });
  await fire(pi, 'agent_settled');
  await fire(pi, 'session_shutdown');
}));

test('index bare pi: todo loop only; no workbench tools', withCleanup(async (cleanup) => {
  const env = cleanup.env();
  env.delete('PI_HERDR_SUBAGENT');
  env.delete('HERDR_ENV');
  env.delete('HERDR_SOCKET_PATH');
  env.delete('HERDR_PANE_ID');
  env.delete('PI_HERDR_ROLE_MANIFEST');

  const pi = fakePi();
  await pier(pi as never);

  assert.ok(pi.tools.has('todo_write'), 'bare pi keeps todo_write');
  assert.ok(pi.tools.has('ask_user_question'));
  assert.ok(!pi.tools.has('subagent'), 'bare pi must not register subagent');
  assert.ok(!pi.tools.has('terminal'), 'bare pi must not register terminal');
  assert.ok(!pi.tools.has('list_agents'));
  assert.ok(!pi.tools.has('terminal_open'));
  assert.ok(pi.commands.has('todos'));
  assert.ok(!pi.commands.has('locks'), 'write locks stay herdr-only');

  await fire(pi, 'session_start', { reason: 'new' }, { sessionManager: { getBranch: () => [] } });
  await fire(pi, 'agent_settled');
  await fire(pi, 'session_shutdown');
}));

test('index herdr master: mounts subagent + terminal + locks', withCleanup(async (cleanup) => {
  const env = cleanup.env();
  env.delete('PI_HERDR_SUBAGENT');
  env.set('HERDR_ENV', '1');
  env.set('HERDR_SOCKET_PATH', '/tmp/pier-test-sock');
  env.set('HERDR_PANE_ID', 'p1');
  env.delete('PI_HERDR_ROLE_MANIFEST');

  const pi = fakePi();
  await pier(pi as never);

  assert.ok(pi.tools.has('todo_write'));
  assert.ok(pi.tools.has('subagent'), 'herdr master mounts subagent');
  assert.ok(pi.tools.has('terminal'), 'herdr master mounts terminal');
  assert.ok(pi.commands.has('todos'));
  assert.ok(pi.commands.has('locks'));
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
  assert.match(result.content[0]?.text ?? '', /"deploy staging\?"="ok"/);

  const all = pi.events.emitted.filter((e) => e.channel === 'herdr:blocked');
  assert.equal(all.length, 2);
  assert.deepEqual(all[1]?.data, { active: false });
  assert.equal(officialDepth, 0);
}));

test('ask_user_question options path emits herdr:blocked once around select', withCleanup(async (cleanup) => {
  const pi = await workerPier(cleanup);
  const exec = pi.tools.get('ask_user_question')?.execute;
  assert.ok(exec);
  let resolveSelect: ((value: string) => void) | undefined;
  const select = new Promise<string>((resolve) => { resolveSelect = resolve; });
  const running = exec!({}, {
    question: 'Which database?',
    options: [
      { label: 'Redis', description: 'mem' },
      { label: 'Postgres', description: 'rel' },
    ],
  }, undefined, undefined, {
    ui: {
      select: async (_title: string, options: string[]) => {
        await select;
        return options[0];
      },
      input: async () => { throw new Error('input must not run for an authored pick'); },
    },
  });
  const blocked = pi.events.emitted.filter((e) => e.channel === 'herdr:blocked');
  assert.equal(blocked.length, 1);
  assert.deepEqual(blocked[0]?.data, { active: true, label: 'Which database?' });
  resolveSelect!('first');
  const result = await running as { content: Array<{ text: string }>; details: { cancelled: boolean } };
  assert.equal(result.details.cancelled, false);
  assert.match(result.content[0]?.text ?? '', /"Which database\?"="Redis"/);
  const all = pi.events.emitted.filter((e) => e.channel === 'herdr:blocked');
  assert.equal(all.length, 2);
  assert.deepEqual(all[1]?.data, { active: false });
}));

test('ask_user_question questions batch keeps one herdr:blocked around both selects', withCleanup(async (cleanup) => {
  const pi = await workerPier(cleanup);
  const exec = pi.tools.get('ask_user_question')?.execute;
  assert.ok(exec);
  let selects = 0;
  const running = exec!({}, {
    questions: [
      { question: 'Cache?', options: [{ label: 'Redis', description: 'mem' }, { label: 'Memcached', description: 'dist' }] },
      { question: 'SQL?', options: [{ label: 'Postgres', description: 'rel' }, { label: 'SQLite', description: 'file' }] },
    ],
  }, undefined, undefined, {
    ui: {
      select: async (_title: string, options: string[]) => {
        selects += 1;
        const mid = pi.events.emitted.filter((e) => e.channel === 'herdr:blocked');
        assert.equal(mid.length, 1, 'gate stays open between questions');
        return options[0];
      },
      input: async () => { throw new Error('input must not run'); },
    },
  });
  const result = await running as { content: Array<{ text: string }> };
  assert.equal(selects, 2);
  assert.match(result.content[0]?.text ?? '', /"Cache\?"="Redis"/);
  assert.match(result.content[0]?.text ?? '', /"SQL\?"="Postgres"/);
  const all = pi.events.emitted.filter((e) => e.channel === 'herdr:blocked');
  assert.equal(all.length, 2);
}));


/* ── generic human gate (pi 0.84.4+ ui_prompt events) ─────────────── */

test('ui_prompt_start opens the gate and emits one herdr:blocked edge', withCleanup(async (cleanup) => {
  const pi = await workerPier(cleanup);
  await fire(pi, 'ui_prompt_start', { reason: 'ui_prompt', kind: 'confirm', title: 'Delete branch?' });
  const edges = pi.events.emitted.filter((e) => e.channel === 'herdr:blocked');
  assert.deepEqual(edges.map((e) => e.data), [{ active: true, label: 'Delete branch?' }]);

  await fire(pi, 'ui_prompt_end', { reason: 'ui_prompt' });
  assert.deepEqual(
    pi.events.emitted.filter((e) => e.channel === 'herdr:blocked').map((e) => e.data),
    [{ active: true, label: 'Delete branch?' }, { active: false }],
  );
}));

test('ui_prompt_start without a title falls back to the prompt kind', withCleanup(async (cleanup) => {
  const pi = await workerPier(cleanup);
  await fire(pi, 'ui_prompt_start', { kind: 'editor' });
  assert.deepEqual(pi.events.emitted.filter((e) => e.channel === 'herdr:blocked')[0]?.data, {
    active: true,
    label: 'editor',
  });
  await fire(pi, 'ui_prompt_end');
}));

test('ui_prompt_start with kind custom is not a human gate (resident overlays)', withCleanup(async (cleanup) => {
  const pi = await workerPier(cleanup);
  // pi routes both modals and persistent overlays through ctx.ui.custom; pier's own slim-frame
  // overlay never calls done(), so treating it as a gate left working panes blocked all session.
  await fire(pi, 'ui_prompt_start', { reason: 'ui_prompt', kind: 'custom' });
  assert.deepEqual(pi.events.emitted.filter((e) => e.channel === 'herdr:blocked'), []);

  // The gate still works for the inherently blocking dialogs, even right after an overlay.
  await fire(pi, 'ui_prompt_start', { reason: 'ui_prompt', kind: 'confirm', title: 'Proceed?' });
  assert.deepEqual(
    pi.events.emitted.filter((e) => e.channel === 'herdr:blocked').map((e) => e.data),
    [{ active: true, label: 'Proceed?' }],
  );
  await fire(pi, 'ui_prompt_end', {});
  assert.deepEqual(
    pi.events.emitted.filter((e) => e.channel === 'herdr:blocked').map((e) => e.data),
    [{ active: true, label: 'Proceed?' }, { active: false }],
  );
}));

test('a nested ui prompt inside the ask tool keeps exactly one blocked edge', withCleanup(async (cleanup) => {
  const pi = await workerPier(cleanup);
  const exec = pi.tools.get('ask_user_question')?.execute;
  assert.ok(exec);

  let resolveInput: ((value: string) => void) | undefined;
  const input = new Promise<string>((resolve) => { resolveInput = resolve; });
  const running = exec!({}, { question: 'ship it?' }, undefined, undefined, {
    ui: {
      // pi fires ui_prompt_start/end around the dialog the ask tool opens.
      input: async () => {
        await fire(pi, 'ui_prompt_start', { kind: 'input', title: 'ship it?' });
        const value = await input;
        await fire(pi, 'ui_prompt_end', {});
        return value;
      },
    },
  });

  assert.equal(
    pi.events.emitted.filter((e) => e.channel === 'herdr:blocked' && (e.data as { active?: boolean }).active === true).length,
    1,
    'the ask tool gate and the nested prompt must coalesce',
  );
  resolveInput!('yes');
  await running;
  const edges = pi.events.emitted.filter((e) => e.channel === 'herdr:blocked').map((e) => e.data);
  assert.deepEqual(edges, [{ active: true, label: 'ship it?' }, { active: false }]);
}));

test('ui_prompt_end without a matching start is harmless', withCleanup(async (cleanup) => {
  const pi = await workerPier(cleanup);
  await fire(pi, 'ui_prompt_end');
  // Depth is clamped: nothing is emitted for a release that never had a gate.
  assert.deepEqual(pi.events.emitted.filter((e) => e.channel === 'herdr:blocked'), []);
}));

test('role manifest deny returns terminate for the whole batch', withCleanup(async (cleanup) => {
  const env = cleanup.env();
  env.set('PI_HERDR_SUBAGENT', '1');
  env.set('PI_HERDR_ROLE_MANIFEST', JSON.stringify({
    role: 'probe',
    version: 'v1',
    tools: ['read'],
    permissions: { bash: 'deny' },
    unknownTools: 'deny',
  }));
  env.delete('HERDR_ENV');
  const pi = fakePi();
  await pier(pi as never);
  const verdicts: unknown[] = [];
  for (const handler of pi.listeners.get('tool_call') ?? []) {
    verdicts.push(await handler({ toolName: 'bash' }));
  }
  const verdict = verdicts[0] as { block?: boolean; terminate?: boolean; reason?: string };
  assert.equal(verdict.block, true);
  assert.equal(verdict.terminate, true, 'denied batches must be able to stop without another model call');
  assert.match(verdict.reason ?? '', /bash/);
}));

test('index session lifecycle: derives the session object root and prunes it on shutdown', withCleanup(async (cleanup) => {
  const env = cleanup.env();
  env.set('PI_HERDR_SUBAGENT', '1');
  env.delete('HERDR_ENV');
  env.delete('HERDR_SOCKET_PATH');
  env.delete('HERDR_PANE_ID');
  env.delete('PI_HERDR_ROLE_MANIFEST');
  env.delete('PI_SESSION_FILE');
  env.delete('PI_SESSION_ID');

  const { mkdir, writeFile, readdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const sessionDir = cleanup.tempDir('index-prune').path;

  const sessionId = 'sess_idx_prune';
  const dirs = [
    join(sessionDir, 'herdr-pi', sessionId, 'observation-pack', 'objects'),
    join(sessionDir, 'herdr-pi', sessionId, 'evidence-preserving-reducer', 'objects'),
  ];
  // One file above the default cap (300) per directory, so the shutdown prune must act.
  for (const dir of dirs) {
    await mkdir(dir, { recursive: true });
    for (let i = 0; i < 301; i++) await writeFile(join(dir, `f${i}.txt`), `content ${i}`);
  }

  const pi = fakePi();
  await pier(pi as never);

  const ctx = {
    sessionManager: { getSessionDir: () => sessionDir, getSessionId: () => sessionId, getBranch: () => [] },
  };
  await fire(pi, 'session_start', { reason: 'new' }, ctx);
  await fire(pi, 'session_shutdown');

  for (const dir of dirs) {
    const files = await readdir(dir);
    assert.equal(files.length, 300, `${dir} must be pruned to the default cap on shutdown`);
  }
}));

test('index: /pier-config reports configuration and hands a guided change to the agent', withCleanup(async (cleanup) => {
  const env = cleanup.env();
  env.set('PI_HERDR_SUBAGENT', '1');
  env.delete('HERDR_ENV');
  env.delete('HERDR_PLUGIN_CONFIG_DIR');
  env.delete('PI_HERDR_ROLE_MANIFEST');

  const { join } = await import('node:path');
  const pi = fakePi();
  await pier(pi as never);

  assert.ok(pi.commands.has('pier-config'), 'D104 command is registered');
  assert.equal(pi.commands.has('efficiency'), false, '/efficiency was superseded by /pier-config (not yet released)');

  const notes: Array<{ text: string; level?: string }> = [];
  const cwd = cleanup.tempDir('pier-config-ws').path;
  const ctx = {
    cwd,
    ui: { notify: (text: string, level?: string) => { notes.push({ text, level }); } },
    isProjectTrusted: () => false,
  };
  const command = pi.commands.get('pier-config') as { handler?: (...a: unknown[]) => Promise<void> };

  await command.handler?.('show efficiency', ctx);
  const showOutput = notes.map((n) => n.text).join('\n');
  assert.match(showOutput, /efficiency — Efficiency mechanisms/);
  assert.match(showOutput, /observationPack\.enabled = /);
  assert.match(showOutput, /evidencePreservingReducer\.timeoutMs = /);

  notes.length = 0;
  await command.handler?.('show bogus', ctx);
  assert.match(notes.map((n) => n.text).join('\n'), /unknown plane "bogus"/);
  assert.equal(notes[0]?.level, 'warning');

  notes.length = 0;
  await command.handler?.('check', ctx);
  assert.match(notes.map((n) => n.text).join('\n'), /pier config check \(workspace trusted: false\)/);

  notes.length = 0;
  await command.handler?.('doc', ctx);
  const docOutput = notes.map((n) => n.text).join('\n');
  assert.match(docOutput, /config report written:/);
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(join(cwd, '.pi-herdr', 'config-report.md')), true, 'report file is written into the workspace');

  notes.length = 0;
  await command.handler?.('', ctx);
  assert.match(notes.map((n) => n.text).join('\n'), /asking the agent to guide the change/);
  assert.equal(pi.sent.length, 1, 'bare invocation injects exactly one guidance message');
  const injected = pi.sent[0]!.message as { customType?: string; content?: string; display?: boolean };
  assert.equal(injected.customType, 'pi-herdr.config-guide');
  assert.equal(injected.display, false);
  assert.match(String(injected.content), /^\[PIER-CONFIG\]/);
  assert.deepEqual(pi.sent[0]!.options, { triggerTurn: true });
}));

test('index: turn_start resets lastStopReason (A11) so a stale abort cannot swallow the next settlement', withCleanup(async (cleanup) => {
  const env = cleanup.env();
  env.delete('PI_HERDR_SUBAGENT');
  env.set('HERDR_ENV', '1');
  env.set('HERDR_SOCKET_PATH', '/tmp/pier-test-sock-a11');
  const paneId = 'p_a11_test';
  env.set('HERDR_PANE_ID', paneId);
  env.delete('PI_HERDR_ROLE_MANIFEST');

  const cwd = cleanup.tempDir('pier-a11-ws').path;
  const pi = fakePi();
  await pier(pi as never);
  const ctx = { cwd, sessionManager: { getBranch: () => [] } };
  const { pipeRequestTo } = await import('../src/pipe-channel.ts');

  try {
    await fire(pi, 'session_start', { reason: 'new' }, ctx);

    // Turn 1 aborted by the user (ESC): the abort latch is set on purpose, so a child settling
    // right after the abort must NOT wake the agent (D92).
    await fire(pi, 'turn_start');
    await fire(pi, 'turn_end', { message: { role: 'assistant', stopReason: 'aborted' } }, ctx);
    await fire(pi, 'agent_settled', {}, ctx);

    // Turn 2 runs to its end without carrying a stopReason (the narrow window A11 is about):
    // pre-fix the stale "aborted" survives, and the notice that arrives in the settle gap is
    // buffered forever instead of being delivered.
    await fire(pi, 'turn_start');
    await fire(pi, 'turn_end', {}, ctx);
    const res = await pipeRequestTo(cwd, paneId, {
      type: 'reply',
      id: 'r-a11',
      paneId: 'p_child',
      text: 'child finished',
      sessionFile: null,
    });
    assert.equal(res.type, 'ok');
    assert.equal(pi.sentUserMessages.length, 0, 'a notice arriving mid-settle is buffered, not injected');

    await fire(pi, 'agent_settled', {}, ctx);
    assert.equal(pi.sentUserMessages.length, 1, 'the buffered notice must reach the user when the turn settles');
    assert.match(pi.sentUserMessages[0]!.content, /child finished/);
    assert.deepEqual(pi.sentUserMessages[0]!.opts, { deliverAs: 'followUp', triggerTurn: true });
  } finally {
    await fire(pi, 'session_shutdown'); // close the pipe server even when an assertion fails
  }
}));

test('P2-5: resume (session_start) folds todos from branch — kill+resume no longer starts empty', withCleanup(async (cleanup) => {
  const env = cleanup.env();
  env.delete('PI_HERDR_SUBAGENT');
  env.delete('HERDR_ENV');
  env.delete('HERDR_SOCKET_PATH');
  env.delete('HERDR_PANE_ID');

  const pi = fakePi();
  await pier(pi as never);

  // A branch carrying the last todo_write toolResult snapshot (the fold source).
  const branch = [{
    type: 'message',
    message: {
      role: 'toolResult',
      toolName: 'todo_write',
      details: {
        'pi-herdr.todo': {
          version: 1,
          items: [
            { content: 'Fix bug 19801 in isolated worktree', status: 'completed' },
            { content: 'Push to origin + update ZenTao', status: 'pending' },
          ],
        },
      },
    },
  }];
  await fire(pi, 'session_start', { reason: 'resume' }, { sessionManager: { getBranch: () => branch } });

  const notified: string[] = [];
  const todosHandler = pi.commands.get('todos')?.handler;
  assert.ok(todosHandler, 'todos command registered');
  await todosHandler([], { ui: { notify: (t: string) => { notified.push(t); } } });
  const out = notified.join('\n');
  assert.match(out, /Fix bug 19801 in isolated worktree/, `fold must restore items, got: ${out}`);
  assert.match(out, /Push to origin \+ update ZenTao/);
  assert.doesNotMatch(out, /todo list is empty/);

  await fire(pi, 'session_shutdown');
}));
