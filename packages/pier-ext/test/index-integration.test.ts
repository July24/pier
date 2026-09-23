/**
 * index.ts composition root: process-mode mounting, the herdr human gate, and the session
 * lifecycle (notice buffering, session-object pruning, todo folding on resume).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import pier from '../src/index.ts';
import { pipeRequestTo } from '../src/pipe-channel.ts';
import { fakePi, fire, withCleanup, type CleanupContext, type FakePi } from './test-utils.ts';

type IndexMode = 'worker' | 'bare' | 'master';

/**
 * Boots the real composition root on one process-mode branch. `extra` lands on top of the mode
 * baseline (`undefined` deletes), so a test names only the variables it cares about.
 */
async function mountIndex(
  cleanup: CleanupContext,
  mode: IndexMode,
  extra: Record<string, string | undefined> = {},
): Promise<FakePi> {
  const env = cleanup.env();
  for (const key of ['PI_HERDR_SUBAGENT', 'HERDR_ENV', 'HERDR_SOCKET_PATH', 'HERDR_PANE_ID', 'PI_HERDR_ROLE_MANIFEST']) {
    env.delete(key);
  }
  if (mode === 'worker') env.set('PI_HERDR_SUBAGENT', '1');
  if (mode === 'master') {
    env.set('HERDR_ENV', '1');
    env.set('HERDR_SOCKET_PATH', '/tmp/pier-test-sock');
    env.set('HERDR_PANE_ID', 'p1');
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) env.delete(key);
    else env.set(key, value);
  }
  const pi = fakePi();
  await pier(pi as never);
  return pi;
}

/** The `ui` the ask tool sees for an authored pick: the test's own `select`, and an input path that must not run. */
const authoredUi = (select: (title: string, options: string[]) => Promise<string | undefined>) =>
  ({ ui: { select, input: async () => { throw new Error('input must not run for an authored pick'); } } });

/** The herdr:blocked edge stream the herdr host (and pi core) consumes. */
function blockedEdges(pi: FakePi): unknown[] {
  return pi.events.emitted.filter((e) => e.channel === 'herdr:blocked').map((e) => e.data);
}

/** Mounts a worker index and returns the registered ask tool's execute. */
async function workerAsk(cleanup: CleanupContext) {
  const pi = await mountIndex(cleanup, 'worker');
  const exec = pi.tools.get('ask_user_question')?.execute;
  assert.ok(exec, 'ask_user_question must be registered');
  return { pi, exec };
}

/**
 * Control for the negative ask cases: on the *same* mounted index a valid ask must open the gate
 * for the whole wait and close it afterwards. Without it a mount whose gate is dead would make
 * every "no herdr:blocked edge" assertion below pass vacuously.
 */
async function expectGateOpensAndCloses(pi: FakePi, exec: (...a: unknown[]) => unknown): Promise<void> {
  let release: ((value: string) => void) | undefined;
  const held = new Promise<string>((resolve) => { release = resolve; });
  const running = exec({}, { question: 'deploy staging?' }, undefined, undefined, { ui: { input: () => held } });
  assert.deepEqual(blockedEdges(pi), [{ active: true, label: 'deploy staging?' }], 'a valid ask opens the gate while the human is asked');
  release!('ok');
  const result = await running as { content: Array<{ text: string }> };
  assert.match(result.content[0]?.text ?? '', /"deploy staging\?"="ok"/);
  assert.deepEqual(blockedEdges(pi), [{ active: true, label: 'deploy staging?' }, { active: false }]);
}

/* ── mount surface per process mode ─────────────────────────────── */

test('index mount surface: worker and bare pi stay todo-only', async (t) => {
  for (const mode of ['worker', 'bare'] as const) await t.test(mode, withCleanup(async (cleanup) => {
    const pi = await mountIndex(cleanup, mode);
    assert.ok(pi.tools.has('todo_write'), `${mode} mounts todo_write`);
    assert.ok(pi.tools.has('ask_user_question'), 'common tool still registered');
    for (const tool of ['subagent', 'terminal', 'list_agents', 'terminal_open']) assert.ok(!pi.tools.has(tool), `${mode} must not register ${tool}`);
    assert.ok(pi.commands.has('todos'));
    assert.ok(!pi.commands.has('locks'), 'write locks stay herdr-only');

    // A full session lifecycle must not throw and has no herdr to report to.
    const ctx = { sessionManager: { getBranch: () => [] } };
    await fire(pi, 'session_start', { reason: 'new' }, ctx);
    await fire(pi, 'turn_start');
    await fire(pi, 'tool_execution_start', { toolCallId: 'c1', toolName: 'read' });
    await fire(pi, 'tool_execution_end', { toolCallId: 'c1' });
    await fire(pi, 'agent_settled', {}, ctx);
    await fire(pi, 'session_shutdown');
    assert.deepEqual(blockedEdges(pi), [], `${mode} never opens a herdr gate`);
  }));
});

test('index herdr master: mounts subagent + terminal + locks', withCleanup(async (cleanup) => {
  const pi = await mountIndex(cleanup, 'master');
  for (const tool of ['todo_write', 'subagent', 'terminal']) assert.ok(pi.tools.has(tool), `herdr master mounts ${tool}`);
  for (const command of ['todos', 'locks']) assert.ok(pi.commands.has(command), `herdr master mounts /${command}`);
  await fire(pi, 'session_shutdown');
}));

/* ── human gate: the herdr:blocked edges pi core and herdr consume ── */

test('ask_user_question emits herdr:blocked once around ui.input (official herdr:pi contract)', withCleanup(async (cleanup) => {
  const { pi, exec } = await workerAsk(cleanup);
  let officialDepth = 0;
  pi.events.on('herdr:blocked', (data) => {
    if (data && typeof data === 'object' && 'active' in data && data.active === true) officialDepth += 1;
    else officialDepth = Math.max(0, officialDepth - 1);
  });

  let resolveInput: ((value: string) => void) | undefined;
  const input = new Promise<string>((resolve) => { resolveInput = resolve; });
  const running = exec!({}, { question: 'deploy staging?' }, undefined, undefined, { ui: { input: () => input } });

  assert.deepEqual(blockedEdges(pi), [{ active: true, label: 'deploy staging?' }]);
  assert.equal(officialDepth, 1, 'official listener must see depth 1, not 2 from self-echo');

  resolveInput!('ok');
  const result = await running as { content: Array<{ text: string }> };
  assert.match(result.content[0]?.text ?? '', /"deploy staging\?"="ok"/);

  assert.deepEqual(blockedEdges(pi), [{ active: true, label: 'deploy staging?' }, { active: false }]);
  assert.equal(officialDepth, 0);
}));

test('ask_user_question empty question does not emit herdr:blocked', withCleanup(async (cleanup) => {
  const { pi, exec } = await workerAsk(cleanup);
  // Whitespace is not a question: the prepare rejection must land before the gate is published,
  // so a model that fumbles the argument never leaves the pane reporting blocked.
  const result = await exec!({}, { question: '   ' }, undefined, undefined, {
    ui: { input: async () => 'nope' },
  }) as { content: Array<{ text: string }>; details: { error?: string } };
  assert.equal(result.details.error, 'empty_question');
  assert.match(result.content[0]?.text ?? '', /must be a non-empty string/);
  assert.deepEqual(blockedEdges(pi), [], 'a rejected ask must not publish a herdr:blocked edge');

  await expectGateOpensAndCloses(pi, exec!);
}));

test('ask_user_question reserved Other does not emit herdr:blocked', withCleanup(async (cleanup) => {
  const { pi, exec } = await workerAsk(cleanup);
  const result = await exec!({}, {
    question: 'Which database?',
    options: [{ label: 'Redis', description: 'mem' }, { label: 'Other', description: 'typed' }],
  }, undefined, undefined, {
    ui: { input: async () => 'nope' },
  }) as { content: Array<{ text: string }>; details: { error?: string } };
  assert.equal(result.details.error, 'reserved_label');
  assert.match(result.content[0]?.text ?? '', /is reserved/);
  assert.deepEqual(blockedEdges(pi), [], 'an unusable pick must not publish a herdr:blocked edge');

  await expectGateOpensAndCloses(pi, exec!);
}));

test('ask_user_question options path emits herdr:blocked once around select', withCleanup(async (cleanup) => {
  const { pi, exec } = await workerAsk(cleanup);
  let resolveSelect: (() => void) | undefined;
  const select = new Promise<void>((resolve) => { resolveSelect = resolve; });
  const running = exec!({}, { question: 'Which database?', options: [{ label: 'Redis', description: 'mem' }, { label: 'Postgres', description: 'rel' }] },
    undefined, undefined, authoredUi(async (_title, options) => { await select; return options[0]; }));
  assert.deepEqual(blockedEdges(pi), [{ active: true, label: 'Which database?' }]);
  resolveSelect!();
  const result = await running as { content: Array<{ text: string }>; details: { cancelled: boolean } };
  assert.equal(result.details.cancelled, false);
  assert.match(result.content[0]?.text ?? '', /"Which database\?"="Redis"/);
  assert.deepEqual(blockedEdges(pi), [{ active: true, label: 'Which database?' }, { active: false }]);
}));

test('ask_user_question questions batch keeps one herdr:blocked around both selects', withCleanup(async (cleanup) => {
  const { pi, exec } = await workerAsk(cleanup);
  let selects = 0;
  const running = exec!({}, {
    questions: [
      { question: 'Cache?', options: [{ label: 'Redis', description: 'mem' }, { label: 'Memcached', description: 'dist' }] },
      { question: 'SQL?', options: [{ label: 'Postgres', description: 'rel' }, { label: 'SQLite', description: 'file' }] },
    ],
  }, undefined, undefined, authoredUi(async (_title, options) => {
    selects += 1;
    assert.equal(blockedEdges(pi).length, 1, 'gate stays open between questions');
    return options[0];
  }));
  const result = await running as { content: Array<{ text: string }> };
  assert.equal(selects, 2);
  assert.match(result.content[0]?.text ?? '', /"Cache\?"="Redis"/);
  assert.match(result.content[0]?.text ?? '', /"SQL\?"="Postgres"/);
  assert.equal(blockedEdges(pi).length, 2);
}));

test('ask_user_question without ui does not emit herdr:blocked', withCleanup(async (cleanup) => {
  const { pi, exec } = await workerAsk(cleanup);
  // No ui at all: the tool bails out before publishing, so a headless run never reports blocked.
  const result = await exec!({}, { question: 'deploy staging?' }, undefined, undefined, {}) as {
    content: Array<{ text: string }>;
    details: { error?: string };
  };
  assert.equal(result.details.error, 'no_ui');
  assert.match(result.content[0]?.text ?? '', /UI not available/);
  assert.deepEqual(blockedEdges(pi), [], 'a missing ui must not publish a herdr:blocked edge');

  await expectGateOpensAndCloses(pi, exec!);
}));

test('ui_prompt_start opens the gate and emits one herdr:blocked edge', withCleanup(async (cleanup) => {
  const pi = await mountIndex(cleanup, 'worker');
  await fire(pi, 'ui_prompt_start', { reason: 'ui_prompt', kind: 'confirm', title: 'Delete branch?' });
  assert.deepEqual(blockedEdges(pi), [{ active: true, label: 'Delete branch?' }]);

  await fire(pi, 'ui_prompt_end', { reason: 'ui_prompt' });
  assert.deepEqual(blockedEdges(pi), [{ active: true, label: 'Delete branch?' }, { active: false }]);
}));

test('ui_prompt gate: label fallback, resident overlays, stray releases', async (t) => {
  await t.test('a missing title falls back to the prompt kind', withCleanup(async (cleanup) => {
    const pi = await mountIndex(cleanup, 'worker');
    await fire(pi, 'ui_prompt_start', { kind: 'editor' });
    assert.deepEqual(blockedEdges(pi), [{ active: true, label: 'editor' }]);
    await fire(pi, 'ui_prompt_end');
    assert.deepEqual(blockedEdges(pi), [{ active: true, label: 'editor' }, { active: false }]);
  }));

  await t.test('kind custom is not a human gate', withCleanup(async (cleanup) => {
    const pi = await mountIndex(cleanup, 'worker');
    // pi routes modals and persistent overlays through the same ctx.ui.custom; pier's own
    // slim-frame overlay never calls done(), so gating it left panes blocked for the session.
    await fire(pi, 'ui_prompt_start', { reason: 'ui_prompt', kind: 'custom' });
    assert.deepEqual(blockedEdges(pi), []);

    // The inherently blocking dialogs still gate, even right after an overlay.
    await fire(pi, 'ui_prompt_start', { reason: 'ui_prompt', kind: 'confirm', title: 'Proceed?' });
    assert.deepEqual(blockedEdges(pi), [{ active: true, label: 'Proceed?' }]);
    await fire(pi, 'ui_prompt_end', {});
    assert.deepEqual(blockedEdges(pi), [{ active: true, label: 'Proceed?' }, { active: false }]);
  }));

  await t.test('ui_prompt_end without a matching start is harmless', withCleanup(async (cleanup) => {
    const pi = await mountIndex(cleanup, 'worker');
    await fire(pi, 'ui_prompt_end');
    // Depth is clamped: a release that never had a gate emits nothing.
    assert.deepEqual(blockedEdges(pi), []);
  }));
});

test('a nested ui prompt inside the ask tool keeps exactly one blocked edge', withCleanup(async (cleanup) => {
  const { pi, exec } = await workerAsk(cleanup);

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

  const openEdges = pi.events.emitted.filter((e) => e.channel === 'herdr:blocked' && (e.data as { active?: boolean }).active === true);
  assert.equal(openEdges.length, 1, 'the ask tool gate and the nested prompt must coalesce');
  resolveInput!('yes');
  await running;
  assert.deepEqual(blockedEdges(pi), [{ active: true, label: 'ship it?' }, { active: false }]);
}));

/* ── role manifest ──────────────────────────────────────────────── */

test('role manifest deny returns terminate for the whole batch', withCleanup(async (cleanup) => {
  const pi = await mountIndex(cleanup, 'worker', {
    PI_HERDR_ROLE_MANIFEST: JSON.stringify({ role: 'probe', version: 'v1', tools: ['read'], permissions: { bash: 'deny' }, unknownTools: 'deny' }),
  });
  const verdicts: unknown[] = [];
  for (const handler of pi.listeners.get('tool_call') ?? []) {
    verdicts.push(await handler({ toolName: 'bash' }));
  }
  const verdict = verdicts[0] as { block?: boolean; terminate?: boolean; reason?: string };
  assert.equal(verdict.block, true);
  assert.equal(verdict.terminate, true, 'denied batches must be able to stop without another model call');
  assert.match(verdict.reason ?? '', /bash/);
}));

/* ── session lifecycle ──────────────────────────────────────────── */

test('index session lifecycle: derives the session object root and prunes it on shutdown', withCleanup(async (cleanup) => {
  const pi = await mountIndex(cleanup, 'worker', { PI_SESSION_FILE: undefined, PI_SESSION_ID: undefined });
  const sessionDir = cleanup.tempDir('index-prune').path;

  const sessionId = 'sess_idx_prune';
  const dirs = ['observation-pack', 'evidence-preserving-reducer'].map((plane) => join(sessionDir, 'herdr-pi', sessionId, plane, 'objects'));
  // One file above the default cap (300) per directory, so the shutdown prune must act.
  for (const dir of dirs) {
    await mkdir(dir, { recursive: true });
    for (let i = 0; i < 301; i++) await writeFile(join(dir, `f${i}.txt`), `content ${i}`);
  }

  const ctx = { sessionManager: { getSessionDir: () => sessionDir, getSessionId: () => sessionId, getBranch: () => [] } };
  await fire(pi, 'session_start', { reason: 'new' }, ctx);
  await fire(pi, 'session_shutdown');

  for (const dir of dirs) {
    const files = await readdir(dir);
    assert.equal(files.length, 300, `${dir} must be pruned to the default cap on shutdown`);
  }
}));

test('index: /pier-config reports configuration and hands a guided change to the agent', withCleanup(async (cleanup) => {
  const pi = await mountIndex(cleanup, 'worker', { HERDR_PLUGIN_CONFIG_DIR: undefined });

  assert.ok(pi.commands.has('pier-config'), 'D104 command is registered');
  assert.equal(pi.commands.has('efficiency'), false, '/efficiency was superseded by /pier-config (not yet released)');

  const notes: Array<{ text: string; level?: string }> = [];
  const cwd = cleanup.tempDir('pier-config-ws').path;
  const ctx = { cwd, ui: { notify: (text: string, level?: string) => { notes.push({ text, level }); } }, isProjectTrusted: () => false };
  const run = pi.commands.get('pier-config')!.handler as (...a: unknown[]) => Promise<void>;
  /** Runs the command and returns the notify text it produced. */
  const runNotes = async (args: string) => { notes.length = 0; await run(args, ctx); return notes.map((n) => n.text).join('\n'); };

  const showOutput = await runNotes('show efficiency');
  for (const re of [/efficiency — Efficiency mechanisms/, /observationPack\.enabled = /, /evidencePreservingReducer\.timeoutMs = /]) {
    assert.match(showOutput, re);
  }

  assert.match(await runNotes('show bogus'), /unknown plane "bogus"/);
  assert.equal(notes[0]?.level, 'warning');

  assert.match(await runNotes('check'), /pier config check \(workspace trusted: false\)/);

  assert.match(await runNotes('doc'), /config report written:/);
  assert.equal(existsSync(join(cwd, '.pi-herdr', 'config-report.md')), true, 'report file is written into the workspace');

  assert.match(await runNotes(''), /asking the agent to guide the change/);
  assert.equal(pi.sent.length, 1, 'bare invocation injects exactly one guidance message');
  const injected = pi.sent[0]!.msg;
  assert.equal(injected.customType, 'pi-herdr.config-guide');
  assert.equal(injected.display, false);
  assert.match(String(injected.content), /^\[PIER-CONFIG\]/);
  assert.deepEqual(pi.sent[0]!.opts, { triggerTurn: true });
}));

test('index: turn_start resets lastStopReason (A11) so a stale abort cannot swallow the next settlement', withCleanup(async (cleanup) => {
  const paneId = 'p_a11_test';
  const pi = await mountIndex(cleanup, 'master', { HERDR_SOCKET_PATH: '/tmp/pier-test-sock-a11', HERDR_PANE_ID: paneId });
  const cwd = cleanup.tempDir('pier-a11-ws').path;
  const ctx = { cwd, sessionManager: { getBranch: () => [] } };

  try {
    await fire(pi, 'session_start', { reason: 'new' }, ctx);

    // Turn 1 was aborted by the user (ESC), so the abort latch is set on purpose: a child settling
    // right after must NOT wake the agent (D92).
    await fire(pi, 'turn_start');
    await fire(pi, 'turn_end', { message: { role: 'assistant', stopReason: 'aborted' } }, ctx);
    await fire(pi, 'agent_settled', {}, ctx);

    // Turn 2 ends without a stopReason (the narrow window A11 is about): pre-fix the stale
    // "aborted" survives and the notice arriving in the settle gap is buffered forever.
    await fire(pi, 'turn_start');
    await fire(pi, 'turn_end', {}, ctx);
    const res = await pipeRequestTo(cwd, paneId, { type: 'reply', id: 'r-a11', paneId: 'p_child', text: 'child finished', sessionFile: null });
    assert.equal(res.type, 'ok');
    assert.equal(pi.userSent.length, 0, 'a notice arriving mid-settle is buffered, not injected');

    await fire(pi, 'agent_settled', {}, ctx);
    assert.equal(pi.userSent.length, 1, 'the buffered notice must reach the user when the turn settles');
    assert.match(pi.userSent[0]!.content, /child finished/);
    assert.deepEqual(pi.userSent[0]!.opts, { deliverAs: 'followUp', triggerTurn: true });
  } finally {
    await fire(pi, 'session_shutdown'); // close the pipe server even when an assertion fails
  }
}));

test('P2-5: resume (session_start) folds todos from branch — kill+resume no longer starts empty', withCleanup(async (cleanup) => {
  const pi = await mountIndex(cleanup, 'bare');

  // A branch carrying the last todo_write toolResult snapshot (the fold source).
  const items = [
    { content: 'Fix bug 19801 in isolated worktree', status: 'completed' },
    { content: 'Push to origin + update ZenTao', status: 'pending' },
  ];
  const branch = [{ type: 'message', message: { role: 'toolResult', toolName: 'todo_write', details: { 'pi-herdr.todo': { version: 1, items } } } }];
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

test('OCC end-to-end: the intentional abort settles into ctx.compact (not swallowed by the abort gate)', withCleanup(async (cleanup) => {
  const pi = await mountIndex(cleanup, 'bare', { HOME: cleanup.tempDir('pier-occ-home').path });
  const cwd = cleanup.tempDir('pier-occ-ws').path;
  await mkdir(join(cwd, '.pi-herdr'), { recursive: true });
  await writeFile(join(cwd, '.pi-herdr', 'config.json'), JSON.stringify({ version: 1, onlineContextCompact: { enabled: true } }));

  // 25 long messages: enough history for pi's native compaction to cut (nativeCompactionFeasible).
  const branch = Array.from({ length: 25 }, (_, i) => ({
    type: 'message', id: `m${i}`, parentId: i > 0 ? `m${i - 1}` : null,
    message: { role: i % 2 === 0 ? 'user' : 'assistant', content: [{ type: 'text', text: 'log line\n'.repeat(2000) }] },
  }));
  let aborts = 0;
  const compacts: unknown[] = [];
  const ctx = {
    cwd,
    isProjectTrusted: () => true,
    // Near the window: window protection selects a compaction regardless of pacing samples.
    getContextUsage: () => ({ tokens: 125_000, contextWindow: 128_000 }),
    getSystemPrompt: () => '',
    hasPendingMessages: () => false,
    isIdle: () => true,
    sessionManager: { getBranch: () => branch, getSessionDir: () => undefined, getSessionId: () => 'occ' },
    abort: () => { aborts++; },
    compact: (opts: unknown) => { compacts.push(opts); },
  };
  await fire(pi, 'session_start', { reason: 'new' }, ctx);
  await fire(pi, 'turn_start');
  await fire(pi, 'before_provider_request', {}, ctx);
  const todoWrite = pi.tools.get('todo_write')!.execute!;
  await todoWrite('c1', { todos: [{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'pending' }] }, undefined, undefined, ctx);
  await todoWrite('c2', { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }] }, undefined, undefined, ctx);
  await fire(pi, 'turn_end', { message: { role: 'assistant', stopReason: 'toolUse' } }, ctx);
  assert.equal(aborts, 1, 'the boundary turn is aborted on purpose');
  await fire(pi, 'turn_end', { message: { role: 'assistant', stopReason: 'aborted' } }, ctx);
  await fire(pi, 'agent_settled', {}, ctx);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(compacts.length, 1, 'the settled OCC abort must reach ctx.compact');
  await fire(pi, 'session_shutdown');
}));

test('/new: a fresh session does not inherit the previous session\'s todos', withCleanup(async (cleanup) => {
  const pi = await mountIndex(cleanup, 'bare');
  const items = [{ content: 'Old session task', status: 'pending' }];
  const branch = [{ type: 'message', message: { role: 'toolResult', toolName: 'todo_write', details: { 'pi-herdr.todo': { version: 1, items } } } }];
  await fire(pi, 'session_start', { reason: 'resume' }, { sessionManager: { getBranch: () => branch } });
  await fire(pi, 'session_start', { reason: 'new' }, { sessionManager: { getBranch: () => [] } });

  const notified: string[] = [];
  await pi.commands.get('todos')!.handler!([], { ui: { notify: (t: string) => { notified.push(t); } } });
  assert.doesNotMatch(notified.join('\n'), /Old session task/);
  await fire(pi, 'session_shutdown');
}));
