/**
 * index.ts composition root: process-mode mounting, the herdr human gate, and the session
 * lifecycle (notice buffering, session-object pruning, todo folding on resume).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import pier from '../src/index.ts';
import { pipeNameFor, pipeRequestTo, startPipeServer, type PipeRequest } from '../src/pipe-channel.ts';
import { sessionDirName } from '../src/storage-layout.ts';
import { fakePi, fire, jsonl, subEntry, transcriptMessage, withCleanup, type CleanupContext, type FakePi } from './test-utils.ts';
import { readWorkerMarker, writeWorkerMarker } from '../src/worker-marker.ts';

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
  const pi = await mountIndex(cleanup, 'worker');

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

test('index: before_agent_start marks the run busy so settlement notices enter the D92 buffer', withCleanup(async (cleanup) => {
  const paneId = 'p_busy_start';
  const pi = await mountIndex(cleanup, 'master', { HERDR_SOCKET_PATH: '/tmp/pier-test-sock-busy', HERDR_PANE_ID: paneId });
  const cwd = cleanup.tempDir('pier-busy-ws').path;
  const ctx = { cwd, sessionManager: { getBranch: () => [] } };
  try {
    await fire(pi, 'session_start', { reason: 'new' }, ctx);
    // pi 1.2 counts the run as busy here, before turn_start fires.
    await fire(pi, 'before_agent_start', { messageType: 'user', prompt: 'start', systemPromptOptions: { sections: {} } });
    const res = await pipeRequestTo(cwd, paneId, { type: 'reply', id: 'r-busy-start', paneId: 'p_child', text: 'child finished', sessionFile: null });
    assert.equal(res.type, 'ok');
    assert.equal(pi.userSent.length, 0, 'a notice arriving during the start window is buffered');
    await fire(pi, 'agent_settled', {}, ctx);
    assert.equal(pi.userSent.length, 1, 'the buffered notice flushes once the run settles');
  } finally {
    await fire(pi, 'session_shutdown');
  }
}));

test('settle fast-path (D49): an aborted settle keeps the machine request armed; the genuine settle pushes the reply', withCleanup(async (cleanup) => {
  const childPane = 'p_settle_child';
  // Own transcript under the temp agent home so the genuine settle finds its closing text.
  const home = cleanup.tempDir('pier-settle-home').path;
  const cwd = cleanup.tempDir('pier-settle-ws').path;
  const parentCwd = cleanup.tempDir('pier-settle-parent').path;
  const pi = await mountIndex(cleanup, 'master', {
    HERDR_SOCKET_PATH: '/tmp/pier-test-sock-settle',
    HERDR_PANE_ID: childPane,
    PI_CODING_AGENT_DIR: home,
    PI_SESSION_FILE: 'smoke-sess-0001',
  });
  const ctx = { cwd, sessionManager: { getBranch: () => [] }, isIdle: () => true };
  const replies: PipeRequest[] = [];
  const replyArrived = Promise.withResolvers<void>();
  const parent = startPipeServer(pipeNameFor(parentCwd, 'p_settle_parent'), (req) => {
    replies.push(req);
    replyArrived.resolve();
    return Promise.resolve({ type: 'ok', id: req.id });
  });

  try {
    await fire(pi, 'session_start', { reason: 'new' }, ctx);
    const prompted = await pipeRequestTo(cwd, childPane, {
      type: 'prompt', id: 'prompt-smoke', text: 'go', from: pipeNameFor(parentCwd, 'p_settle_parent'), push: true,
    });
    assert.equal(prompted.type, 'ok');

    // The run "settles" on an abort (user ESC here; OCC's abort lands on the same guard via
    // intentionalAbort/compactionInFlight): pre-fix this consumed the request with a null-text
    // reply, so the worker's real closing message could never be delivered.
    await fire(pi, 'turn_start');
    await fire(pi, 'turn_end', { message: { role: 'assistant', stopReason: 'aborted' } }, ctx);
    await fire(pi, 'agent_settled', {}, ctx);
    assert.equal(replies.length, 0, 'an aborted settle must not answer the machine request');

    // A provider error is retried by pi: it is not a settlement either, and answering would consume
    // the one-shot request with a null-text reply before the retry delivers the real closing message.
    await fire(pi, 'turn_start');
    await fire(pi, 'turn_end', { message: { role: 'assistant', stopReason: 'error' } }, ctx);
    await fire(pi, 'agent_settled', {}, ctx);
    assert.equal(replies.length, 0, 'an error stop must keep the machine request armed');

    // The continuation run genuinely settles: the still-armed request now carries the real text.
    await fire(pi, 'turn_start');
    await fire(pi, 'turn_end', { message: { role: 'assistant', stopReason: 'stop' } }, ctx);
    const sessDir = join(home, 'sessions', sessionDirName(process.cwd()));
    await mkdir(sessDir, { recursive: true });
    await writeFile(
      join(sessDir, '2026-09-22T00-00-00-000Z_smoke-sess-0001.jsonl'),
      jsonl(
        { type: 'session', id: 'smoke-sess-0001' },
        transcriptMessage('assistant', '服务已停、环境干净；报告全文写入 /tmp/report.md', Date.now() + 1000),
      ),
    );
    await fire(pi, 'agent_settled', {}, ctx);
    // pushSettleReply is fire-and-forget, and the reply crosses a real unix socket: await the
    // arrival signal with a deadline (deterministic time control cannot cross a socket).
    const deadline = setTimeout(() => replyArrived.reject(new Error('settle reply did not arrive within 2s')), 2000);
    deadline.unref?.();
    await replyArrived.promise;
    clearTimeout(deadline);
    assert.equal(replies.length, 1, 'exactly one settle reply, from the genuine settle');
    const reply = replies[0]!;
    assert.ok(reply.type === 'reply', `expected a reply, got ${reply.type}`);
    assert.equal(reply.id, 'prompt-smoke');
    assert.match(reply.text ?? '', /报告全文写入/);
    assert.equal(reply.paneId, childPane);
  } finally {
    parent.close();
    await fire(pi, 'session_shutdown'); // close the child's pipe server even when an assertion fails
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
  // pi checks the signal only inside the next request: the aborted run still opens a turn first,
  // and that request fails as an 'error' stop ("This operation was aborted").
  await fire(pi, 'turn_start');
  await fire(pi, 'turn_end', { message: { role: 'assistant', stopReason: 'error' } }, ctx);
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

/* ── herdr 0.9.2 restore identity: worker marker + self-reported resume ── */

test('worker session_start writes the restore marker next to its session file', withCleanup(async (cleanup) => {
  const pi = await mountIndex(cleanup, 'worker', { PI_SESSION_FILE: undefined, PI_SESSION_ID: undefined });
  const dir = cleanup.tempDir('wmark');
  const sessionFile = join(dir.path, '2026-10-08T01-00-00Z_a1b2c3d4.jsonl');
  await fire(pi, 'session_start', { reason: 'new' }, {
    sessionManager: { getBranch: () => [], getSessionFile: () => sessionFile, getSessionDir: () => dir.path },
    cwd: dir.path,
  });
  assert.equal(existsSync(join(dir.path, 'herdr-pi', 'a1b2c3d4', 'worker.json')), true, 'marker keyed by bare session id');
  await fire(pi, 'session_shutdown');
}));

test('a herdr boot whose session has a worker marker mounts todo-only (restored worker, no spawn env)', withCleanup(async (cleanup) => {
  const dir = cleanup.tempDir('wmark-restore');
  const sessionFile = join(dir.path, '2026-10-08T01-00-00Z_a1b2c3d4.jsonl');
  writeWorkerMarker(sessionFile, 'worker-default');
  const pi = await mountIndex(cleanup, 'master', { PI_SESSION_FILE: sessionFile });
  assert.equal(pi.tools.has('subagent'), false, 'restored worker must not grow master delegation tools');
  assert.equal(pi.tools.has('todo_write'), true, 'todo loop still mounts');
  await fire(pi, 'session_shutdown');
}));

/* ── delegation identity chain (RFC rfc-delegation-identity §2): env > marker > branch fold ── */

const DELEGATION_ENV_JSON = JSON.stringify({
  parentPaneId: 'wD:p1',
  parentSessionId: 'e5f6a7b8',
  taskId: 't-42',
  description: 'harden pipe channel',
  role: 'worker-default',
});

/** Fires one before_agent_start and returns the sections map the handler mutated. */
async function delegationSections(pi: FakePi): Promise<Record<string, string>> {
  const sections: Record<string, string> = {};
  await fire(pi, 'before_agent_start', { systemPromptOptions: { sections } });
  return sections;
}

test('worker session_start: delegation env writes the first-frame entry, the prompt section, and the marker', withCleanup(async (cleanup) => {
  const dir = cleanup.tempDir('delegation-env');
  const sessionFile = join(dir.path, '2026-10-08T01-00-00Z_a1b2c3d4.jsonl');
  const pi = await mountIndex(cleanup, 'worker', {
    PI_SESSION_FILE: sessionFile,
    PI_HERDR_DELEGATION: DELEGATION_ENV_JSON,
  });
  const ctx = { sessionManager: { getBranch: () => [], getSessionFile: () => sessionFile, getSessionDir: () => dir.path } };
  await fire(pi, 'session_start', { reason: 'new' }, ctx);
  const entry = pi.entries.find(([type]) => type === 'pi-herdr.delegation');
  assert.ok(entry, 'first-frame delegation entry written');
  assert.deepEqual(entry![1], { version: 1, parentPaneId: 'wD:p1', parentSessionId: 'e5f6a7b8', taskId: 't-42', description: 'harden pipe channel', role: 'worker-default', ts: (entry![1] as { ts: number }).ts });
  const sections = await delegationSections(pi);
  assert.match(sections['pier-delegation'] ?? '', /delegated subagent of the master pane wD:p1/);
  assert.match(sections['pier-delegation'] ?? '', /Task: harden pipe channel/);
  assert.deepEqual(readWorkerMarker(sessionFile)!.delegation, JSON.parse(DELEGATION_ENV_JSON));
  await fire(pi, 'session_shutdown');
}));

test('restored worker: no env — the marker and the branch entry each re-arm the delegation identity', withCleanup(async (cleanup) => {
  const dir = cleanup.tempDir('delegation-restore');
  const sessionFile = join(dir.path, '2026-10-08T01-00-00Z_a1b2c3d4.jsonl');
  writeWorkerMarker(sessionFile, 'worker-default', JSON.parse(DELEGATION_ENV_JSON));
  const pi = await mountIndex(cleanup, 'worker', { PI_SESSION_FILE: sessionFile });
  await fire(pi, 'session_start', { reason: 'resume' }, {
    sessionManager: { getBranch: () => [], getSessionFile: () => sessionFile, getSessionDir: () => dir.path },
  });
  assert.match((await delegationSections(pi))['pier-delegation'] ?? '', /master pane wD:p1/, 'marker alone re-arms the section');

  const pi2 = await mountIndex(cleanup, 'worker', { PI_SESSION_FILE: sessionFile });
  await mkdir(join(dir.path, 'herdr-pi'), { recursive: true });
  await fire(pi2, 'session_start', { reason: 'resume' }, {
    sessionManager: {
      getBranch: () => [{ type: 'custom', customType: 'pi-herdr.delegation', data: JSON.parse(DELEGATION_ENV_JSON) }],
      getSessionFile: () => sessionFile,
      getSessionDir: () => dir.path,
    },
  });
  assert.match((await delegationSections(pi2))['pier-delegation'] ?? '', /master pane wD:p1/, 'branch entry alone re-arms the section');
  assert.equal(pi2.entries.filter(([type]) => type === 'pi-herdr.delegation').length, 0, 'an existing branch entry is not duplicated');
  await fire(pi, 'session_shutdown');
  await fire(pi2, 'session_shutdown');
}));

test('master and delegation-less workers never grow a pier-delegation section', withCleanup(async (cleanup) => {
  const master = await mountIndex(cleanup, 'master', { PI_HERDR_DELEGATION: DELEGATION_ENV_JSON });
  // mountIndex only clears its baseline keys: unset the delegation env explicitly for the worker mount.
  const worker = await mountIndex(cleanup, 'worker', { PI_HERDR_DELEGATION: undefined });
  try {
    assert.equal('pier-delegation' in (await delegationSections(master)), false, 'master ignores the delegation env');
    await fire(worker, 'session_start', { reason: 'new' }, { sessionManager: { getBranch: () => [] } });
    assert.equal('pier-delegation' in (await delegationSections(worker)), false, 'no delegation → no section');
    assert.equal(worker.entries.filter(([type]) => type === 'pi-herdr.delegation').length, 0);
  } finally {
    // Shutdown must run even on assertion failure, or the mounted cordis handles hang the runner.
    await fire(master, 'session_shutdown');
    await fire(worker, 'session_shutdown');
  }
}));

test('tool_execution_end.durationMs (pi ≥ 1.1) lands in the tools efficiency ledger', withCleanup(async (cleanup) => {
  const pi = await mountIndex(cleanup, 'worker', { PI_SESSION_FILE: undefined, PI_SESSION_ID: undefined });
  const dir = cleanup.tempDir('tools-ledger');
  const sessionFile = join(dir.path, '2026-10-08T01-00-00Z_a1b2c3d4.jsonl');
  const ctx = { sessionManager: { getBranch: () => [], getSessionFile: () => sessionFile, getSessionDir: () => dir.path }, cwd: dir.path };
  await fire(pi, 'session_start', { reason: 'new' }, ctx);
  await fire(pi, 'tool_execution_start', { toolCallId: 't1', toolName: 'bash' });
  await fire(pi, 'tool_execution_end', { toolCallId: 't1', durationMs: 1234 });
  const ledger = join(dir.path, 'herdr-pi', 'a1b2c3d4', 'efficiency-logs', 'tools.jsonl');
  const row = JSON.parse((await readFile(ledger, 'utf8')).trim());
  assert.equal(row.tool, 'bash', 'tool name recovered from the start event');
  assert.equal(row.durationMs, 1234);
  assert.equal(row.sessionId, 'a1b2c3d4');
  // Old-pi shape (no durationMs on the event) logs nothing — no estimated wall-clock either.
  await fire(pi, 'tool_execution_start', { toolCallId: 't2', toolName: 'read' });
  await fire(pi, 'tool_execution_end', { toolCallId: 't2' });
  const lines = (await readFile(ledger, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 1, 'a tool without a recorded duration stays out of the ledger');
  await fire(pi, 'session_shutdown');
}));

test('F6 reconcile: a pipe settlement auto-completes the todo and refreshes the resident widget', withCleanup(async (cleanup) => {
  const cwd = cleanup.tempDir('pier-reconcile-ws').path;
  const items = [
    { content: 'harden pipe channel', status: 'in_progress' },
    { content: 'collect results', status: 'pending' },
  ];
  const branch = [
    { type: 'custom', customType: 'pi-herdr.subs', data: { version: 2, subs: [subEntry({
      paneId: 'w2', slug: 'harden-pipe', description: 'harden pipe channel',
    })] } },
  ];
  const widgets: string[][] = [];
  const pi = await mountIndex(cleanup, 'master', {
    HERDR_SOCKET_PATH: '/tmp/pier-test-sock-reconcile', HERDR_PANE_ID: 'p1',
  });
  try {
    const ctx = {
      cwd,
      ui: { setWidget: (_id: string, lines: string[]) => { widgets.push(lines); } },
      sessionManager: { getBranch: () => branch },
    };
    await fire(pi, 'session_start', { reason: 'new' }, ctx);
    // Seed through the real tool so the widget has a line to refresh (session_start renders before rebuild).
    const todoWrite = pi.tools.get('todo_write')!.execute!;
    await todoWrite('c1', { todos: items }, undefined, undefined, ctx);
    assert.deepEqual(widgets.at(-1)?.slice(0, 1), ['▶ harden pipe channel ✓0/2'], 'widget starts on the open item');

    const res = await pipeRequestTo(cwd, 'p1', { type: 'reply', id: 'reply-1', paneId: 'w2', text: 'done', sessionFile: null });
    assert.equal(res.type, 'ok');
    assert.deepEqual(widgets.at(-1)?.slice(0, 1), ['▶ collect results ✓1/2'],
      'M17 reconcile must re-render the widget, not leave the stale pre-settle line');
  } finally {
    await fire(pi, 'session_shutdown');
  }
}));

test('D113 unified widget: worker todo_write pushes todo_sync to the master pipe; widget + /pier-tree render live worker state', withCleanup(async (cleanup) => {
  const dir = cleanup.tempDir('widget-e2e');
  const masterCwd = dir.path;
  // A running registry row for pane w2: the tree/widget render REGISTRY rows joined with the push cache.
  const branch = [
    { type: 'custom', customType: 'pi-herdr.subs', data: { version: 2, subs: [{
      taskId: 't-88', kind: 'task', paneId: 'w2', slug: 'harden-pipe', tabId: 't0', tabName: 'task',
      cwd: masterCwd, description: 'harden pipe channel', background: true, status: 'running',
      sessionFile: null, launchCommand: [], createdAt: Date.now() - 60_000,
    }] } },
  ];
  const masterWidgets: string[][] = [];
  const master = await mountIndex(cleanup, 'master');
  try {
    await fire(master, 'session_start', { reason: 'new' }, {
      cwd: masterCwd,
      ui: { setWidget: (_id: string, lines: string[]) => { masterWidgets.push(lines); } },
      sessionManager: {
        getBranch: () => branch,
        getSessionFile: () => join(masterCwd, '2026-10-20T01-00-00Z_m1m1m1m1.jsonl'),
        getSessionDir: () => masterCwd,
      },
    });
    const parentPipe = pipeNameFor(masterCwd, 'p1');

    // Worker with a herdr pane id, so its push keys the same paneId the registry row uses.
    const worker = await mountIndex(cleanup, 'worker', {
      HERDR_ENV: '1', HERDR_SOCKET_PATH: '/tmp/pier-test-sock-dead', HERDR_PANE_ID: 'w2',
      PI_HERDR_DELEGATION: JSON.stringify({
        parentPaneId: 'p1', parentSessionId: 'm1m1m1m1', parentPipe,
        taskId: 't-88', description: 'harden pipe channel', role: 'worker-default',
      }),
    });
    try {
      const workerWidgets: string[][] = [];
      const workerCtx = { ui: { setWidget: (_id: string, lines: string[]) => { workerWidgets.push(lines); } } };
      await fire(worker, 'session_start', { reason: 'new' }, { ...workerCtx, sessionManager: { getBranch: () => [] } });
      const todoWrite = worker.tools.get('todo_write')?.execute!;
      await todoWrite('t1', { todos: [
        { content: 'extract auth middleware', status: 'completed' },
        { content: 'auth module tests', status: 'in_progress' },
        { content: 'token refresh', status: 'pending' },
      ] }, undefined, undefined, workerCtx);
      assert.deepEqual(workerWidgets.at(-1), ['▶ auth module tests ✓1/3'], 'worker widget = one self line');

      // The push arrived and re-rendered the MASTER widget with the live worker row.
      await new Promise((r) => setTimeout(r, 50));
      assert.ok(masterWidgets.some((lines) => lines.includes('↳ harden-pipe ▶ auth module tests ✓1/3')),
        `master widget shows the worker line: ${JSON.stringify(masterWidgets.at(-1))}`);

      // /pier-tree renders the full delegation tree with the worker's COMPLETE list.
      const notified: string[] = [];
      const tree = master.commands.get('pier-tree');
      assert.ok(tree, '/pier-tree registers on master');
      assert.equal(typeof tree!.handler, 'function');
      await (tree!.handler as (args: unknown, ctx: unknown) => Promise<void>)([], { ui: { notify: (text: string) => { notified.push(text); } } });
      const text = notified.join('\n');
      assert.ok(text.includes('PIER DELEGATION TREE'));
      assert.ok(text.includes('harden-pipe (w2 · running)'));
      assert.ok(text.includes('auth module tests'), 'worker current item reaches the tree');
      assert.ok(text.includes('extract auth middleware') && text.includes('token refresh'), 'worker FULL list is cached and rendered');
    } finally {
      await fire(worker, 'session_shutdown');
    }
  } finally {
    await fire(master, 'session_shutdown');
  }
}));
