/** Subagent domain units: pure planners and notices (launch line, validation, tab placement,
 * readiness, liveness, isolate/worktree planning, task-id resolution) plus plugin wiring. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DisposeLedger } from '../src/ledger.ts';
import { mountSubagent, runSubagent, subEntry } from './test-utils.ts';
import {
  FOREGROUND_POLL_MS, SUBS_CUSTOM_TYPE, TAB_NAME_MAX, Semaphore, agoText, buildAliveNotice, buildBlockedGateNotice,
  buildLaunchLine, buildLaunchParts, classifyWorktreeZone, foldSubsRegistry, formatSubagentResult, isAlive,
  makeProgressUpdate, nextTaskTabName, planForegroundTick, planLaunchValidation, planTabPlacement, resolveTaskIdPrefix,
  tabNameForTask, type AliveProbe, type SubEntry,
} from '../src/subagent-core.ts';
import { planReadyAttempt, readyBackoffMs, readyFailureText } from '../src/subagent-spawn.ts';

const RT = { nodePath: '/usr/local/bin/node', cliPath: '/opt/pi/dist/cli.js', extPath: '/ext/index.ts' };

test('buildLaunchLine: win32 uses PowerShell & syntax, POSIX starts via sh', () => {
  const parts = ['/usr/local/bin/node', '/opt/pi/dist/cli.js', '-e', '/ext/index.ts'];
  const posix = `'/usr/local/bin/node' '/opt/pi/dist/cli.js' '-e' '/ext/index.ts'`;
  assert.equal(buildLaunchLine(parts, 'win32'), `& ${posix}`);
  assert.equal(buildLaunchLine(parts, 'darwin'), posix);
  assert.equal(buildLaunchLine(parts, 'linux'), buildLaunchLine(parts, 'darwin'));
  // A quoted path stays a single literal under both syntaxes.
  assert.equal(buildLaunchLine(["it's a path"], 'darwin'), `'it'\\''s a path'`);
  assert.equal(buildLaunchLine(["it's a path"], 'win32'), `& 'it''s a path'`);
});

test('buildLaunchParts: fullscreen TUI by default (static frames); PI_HERDR_TUI=regular opts out', () => {
  const base = ['/usr/local/bin/node', '/opt/pi/dist/cli.js', '-e', '/ext/index.ts'];
  assert.deepEqual(buildLaunchParts(RT, {}, {}), [...base, '--tui-mode', 'fullscreen']);
  assert.deepEqual(buildLaunchParts(RT, {}, { PI_HERDR_TUI: 'regular' }), base);
  assert.deepEqual(buildLaunchParts(RT, { approve: true, roleModel: 'zai/glm-4.7', resumeFile: '/s.jsonl' }, {}), [
    '/usr/local/bin/node', '/opt/pi/dist/cli.js', '-a', '-e', '/ext/index.ts',
    '--tui-mode', 'fullscreen', '--provider', 'zai', '--model', 'glm-4.7', '--session', '/s.jsonl',
  ]);
});

const mkSub = (over: Record<string, unknown>) => ({
  taskId: 't1', kind: 'short', paneId: 'w1:p1', tabId: 'w1:t9', cwd: 'F:\\herdr-pi', description: 'task', background: true,
  status: 'running', sessionFile: null, launchCommand: ['x'], createdAt: 1, ...over,
});

const registry = (...rows: unknown[]) => [{ type: 'custom', customType: SUBS_CUSTOM_TYPE, data: { version: 2, subs: rows } }];

const entryFrom = (row: Record<string, unknown>): SubEntry => foldSubsRegistry(registry(row)).subs[0]!;

test('foldSubsRegistry: last snapshot wins; legacy kinds normalize; v1 rows migrate', () => {
  const reg = foldSubsRegistry([
    { type: 'session' },
    { type: 'custom', customType: 'other', data: { x: 1 } },
    ...registry(mkSub({ paneId: 'w1:p1', status: 'settled' })),
    ...registry(mkSub({ paneId: 'w1:p2', status: 'consumed', kind: 'resident', tabName: '调研' })),
  ]);
  assert.equal(reg.version, 2);
  assert.equal(reg.subs.length, 1);
  assert.equal(reg.subs[0]!.paneId, 'w1:p2');
  assert.equal(reg.subs[0]!.status, 'consumed');
  assert.equal(reg.subs[0]!.kind, 'task', 'resident folds to task');
  assert.equal(reg.subs[0]!.tabName, '调研');

  assert.equal(entryFrom(mkSub({ paneId: 'w1:p3', kind: 'advisor' })).kind, 'advisor', 'unknown role names pass through');

  const v1 = entryFrom({ paneId: 'w1:p9', description: 'old', background: true, status: 'settled', createdAt: 5 });
  assert.equal(v1.taskId, 'w1:p9', 'v1 rows default taskId to the pane id');
  assert.equal(v1.kind, 'task');
  assert.equal(v1.cwd, '');
  assert.deepEqual(v1.launchCommand, []);

  assert.deepEqual(foldSubsRegistry([{ type: 'session' }] as never), { version: 2, subs: [] });
});

test('foldSubsRegistry: takeover fields survive a persist/rebuild round-trip; malformed isolate falls back to none', () => {
  const isolate = { worktreePath: '/wt/pier-x', branch: 'pier/x', baseSha: 'abc', releasedAt: null, retainNotified: false };
  const row = entryFrom(mkSub({
    paneId: 'w1:p1',
    status: 'running',
    userTakeover: true,
    observationStartedAt: 1234567890,
    lastAgentStatus: 'working',
    isolate,
  }));
  assert.equal(row.userTakeover, true);
  assert.equal(row.observationStartedAt, 1234567890);
  assert.equal(row.lastAgentStatus, 'working');
  assert.deepEqual(row.isolate, isolate);

  const legacy = entryFrom(mkSub({ paneId: 'w1:p1', status: 'settled' }));
  assert.equal(legacy.userTakeover, undefined);
  assert.equal(legacy.observationStartedAt, null);
  assert.equal(legacy.lastAgentStatus, null);
  assert.equal(legacy.tabName, '', 'rows without a tab name fall back to empty');
  assert.equal(entryFrom(mkSub({ isolate: { branch: 'pier/y' } })).isolate, undefined);
});

test('makeProgressUpdate: pi AgentToolResult shape (a bare string crashed the interactive TUI)', () => {
  const update = makeProgressUpdate('subagent running…');
  assert.ok(Array.isArray(update.content));
  assert.equal(update.content.length, 1);
  assert.equal(update.content[0]!.text, 'subagent running…');
  const texts = { ...update, isError: false }.content.filter((c) => c.type === 'text');
  assert.equal(texts.length, 1);
});

test('Semaphore: queues past the cap, releases in order, reusable after drain', async () => {
  const sem = new Semaphore(2);
  const rel1 = await sem.acquire();
  const rel2 = await sem.acquire();
  assert.equal(sem.activeCount, 2);
  let queued = true;
  const p3 = sem.acquire().then((r) => { queued = false; return r; });
  assert.equal(queued, true, 'a third acquire queues while the cap is full');
  rel1();
  const rel3 = await p3;
  assert.equal(queued, false, 'release admits the queue head');
  assert.equal(sem.activeCount, 2);
  rel2();
  rel3();
  assert.equal(sem.activeCount, 0);
  (await sem.acquire())();
  assert.equal(sem.activeCount, 0);
});

test('formatSubagentResult: five outcomes', () => {
  assert.equal(formatSubagentResult({ kind: 'completed', text: 'DONE' }, 't'), 'DONE');
  assert.equal(formatSubagentResult({ kind: 'completed', text: '' }, 't'), 'Subagent finished but produced no output.');
  assert.match(formatSubagentResult({ kind: 'timeout', text: 'partial' }, 't'), /timed out[\s\S]*partial/);
  const blocked = formatSubagentResult({ kind: 'blocked', text: 'waiting' }, 't');
  assert.match(blocked, /blocked/);
  assert.match(blocked, /human decision/);
  assert.match(formatSubagentResult({ kind: 'no-output', text: '' }, 't'), /no readable output/);
  assert.match(formatSubagentResult({ kind: 'spawn-failed', text: 'boom' }, 't'), /boom/);
});

const NOW = 1_800_000_000_000;
const probe = (over: Partial<AliveProbe>): AliveProbe => ({ paneExists: true, agentStatus: null, lastActivityMs: null, ...over });

test('isAlive: gone pane is death; working/blocked is life; idle/unknown ride session freshness', () => {
  assert.equal(isAlive(probe({ paneExists: false, agentStatus: 'working', lastActivityMs: NOW - 1000 }), NOW), false);
  assert.equal(isAlive(probe({ agentStatus: 'working' }), NOW), true);
  assert.equal(isAlive(probe({ agentStatus: 'blocked', lastActivityMs: NOW - 999_999 }), NOW), true);
  assert.equal(isAlive(probe({ agentStatus: 'idle', lastActivityMs: NOW - 119_999 }), NOW), true);
  assert.equal(isAlive(probe({ agentStatus: 'idle', lastActivityMs: NOW - 120_001 }), NOW), false);
  assert.equal(isAlive(probe({}), NOW), false);
  assert.equal(isAlive(probe({ agentStatus: 'idle', lastActivityMs: NOW - 30_001 }), NOW, 30_000), false);
});

test('agoText: relative times, clock skew clamps to zero', () => {
  assert.equal(agoText(NOW - 12_000, NOW), '12s ago');
  assert.equal(agoText(NOW - 180_000, NOW), '3m ago');
  assert.equal(agoText(NOW - 7_200_000, NOW), '2h ago');
  assert.equal(agoText(NOW + 5_000, NOW), '0s ago');
});

test('buildAliveNotice: backgrounded pane — do not redo the work, a notice will arrive', () => {
  const text = buildAliveNotice(
    { paneId: 'wA:p2', description: 'Explore CRM', scenario: 'moved-to-bg', probe: probe({ agentStatus: 'working', lastActivityMs: NOW - 12_000 }) },
    NOW,
  );
  assert.match(text, /still running in pane wA:p2/);
  assert.match(text, /agent_status=working/);
  assert.match(text, /last session activity 12s ago/);
  assert.match(text, /Do NOT redo its work/);
  assert.match(text, /moved it to background/i);
  assert.match(text, /subagent\(action: "list"\)/);
});

test('buildAliveNotice: error-alive rewrites the failure wording', () => {
  const text = buildAliveNotice(
    { paneId: 'wA:p3', description: 'Explore HR', scenario: 'error-alive', probe: probe({ agentStatus: 'idle', lastActivityMs: NOW - 45_000 }) },
    NOW,
  );
  assert.match(text, /is ALIVE in pane wA:p3/);
  assert.match(text, /NOT that the task failed/);
  assert.match(text, /no readable output.*could not be read yet/s);
  assert.match(text, /Do NOT redo its work/);
  assert.ok(!buildAliveNotice({ paneId: 'wA:p4', description: 'X', scenario: 'moved-to-bg', probe: probe({ agentStatus: 'working' }) }, NOW)
    .includes('last session activity'), 'unknown activity omits the clause');
});

test('buildBlockedGateNotice: the master must not take over or answer for the human', () => {
  const text = buildBlockedGateNotice({ paneId: 'wB:p3', description: 'Explore HR', question: '用哪个数据源？' });
  assert.match(text, /BLOCKED waiting for a HUMAN decision in pane wB:p3/);
  assert.match(text, /question: "用哪个数据源？"/);
  assert.match(text, /Do NOT take over its work/);
  assert.match(text, /Tell the user to open that pane/);
  assert.match(text, /subagent\(action: "send"\)/);
  assert.match(text, /do not redo the work yourself/);
  assert.ok(!buildBlockedGateNotice({ paneId: 'wB:p4', description: 'X', question: null }).includes('question:'));
});

test('planLaunchValidation: herdr, prompt, isolate/cwd and role/kind normalization', () => {
  const errorText = (result: { kind: string; text?: string }): string => (result.kind === 'error' ? result.text! : '');
  assert.match(errorText(planLaunchValidation({ prompt: 'x' }, false)), /HERDR_ENV/);
  assert.match(errorText(planLaunchValidation({ prompt: '   ' }, true)), /prompt/);
  assert.match(errorText(planLaunchValidation({ prompt: 'x', isolate: true, cwd: '/tmp' }, true)), /mutually exclusive/);

  const ok = planLaunchValidation({
    description: 'scan',
    prompt: 'do it',
    run_in_background: true,
    allowed_tools: ['read', 1, 'write'],
    tab: 'feat',
  }, true);
  assert.equal(ok.kind, 'ok');
  if (ok.kind !== 'ok') return;
  assert.equal(ok.spec.description, 'scan');
  assert.equal(ok.background, true);
  assert.equal(ok.manifestRole, 'worker-default');
  assert.deepEqual(ok.suggested, ['read', 'write']);
  assert.equal(ok.tab, 'feat');
  assert.equal(ok.roleKind, 'task');
  const role = planLaunchValidation({ prompt: 'x', role: 'resident' }, true);
  assert.equal(role.kind === 'ok' && role.roleKind, 'task', 'legacy role labels fold to task');
});

test('planForegroundTick: human gate, finalized text, collect, wait, continue', () => {
  assert.equal(planForegroundTick({ state: 'blocked', session: { text: null, pendingTool: false, activity: false } }).kind, 'blocked');
  assert.deepEqual(
    planForegroundTick({ state: 'idle', session: { text: 'done', pendingTool: false, activity: true } }),
    { kind: 'settled', text: 'done' },
  );
  assert.deepEqual(
    planForegroundTick({ state: 'idle', session: { text: null, pendingTool: true, activity: false } }),
    { kind: 'wait', delayMs: FOREGROUND_POLL_MS },
  );
  assert.equal(planForegroundTick({ state: 'done', session: { text: null, pendingTool: false, activity: true } }).kind, 'collect-final');
  assert.equal(planForegroundTick({ state: 'working', session: { text: null, pendingTool: false, activity: false } }).kind, 'continue');
  assert.equal(planForegroundTick({ state: null, session: { text: null, pendingTool: false, activity: false } }).kind, 'continue');
});

test('readyBackoffMs: exponential with a cap (500ms → 1s → 2s → 4s → 4s)', () => {
  for (const [attempt, ms] of [[0, 500], [1, 1000], [2, 2000], [3, 4000], [4, 4000], [99, 4000], [-3, 500], [1.7, 1000]] as const) {
    assert.equal(readyBackoffMs(attempt), ms, `attempt ${attempt}`);
  }
});

test('planReadyAttempt: ready wins; a gone pane fails fast; an unknown probe keeps retrying', () => {
  const plan = (over: Partial<Parameters<typeof planReadyAttempt>[0]>) =>
    planReadyAttempt({ elapsedMs: 10, attempt: 0, timeoutMs: 90_000, alive: true, ready: false, ...over });
  assert.deepEqual(plan({ ready: true }), { kind: 'ready' });
  assert.deepEqual(plan({ alive: false }), { kind: 'give-up', reason: 'pane-gone' });
  assert.deepEqual(plan({ alive: null }), { kind: 'retry', delayMs: 500 });
  assert.deepEqual(plan({ elapsedMs: 89_999, attempt: 7 }), { kind: 'retry', delayMs: 4000 });
  assert.deepEqual(plan({ elapsedMs: 90_000, attempt: 8 }), { kind: 'give-up', reason: 'timeout' });
  // A dead pane outranks the timeout: the more accurate reason wins.
  assert.deepEqual(plan({ elapsedMs: 120_000, attempt: 9, alive: false }), { kind: 'give-up', reason: 'pane-gone' });
});

test('readyFailureText: crash, working-but-slow and never-registered are distinguishable', () => {
  const crashed = readyFailureText({
    paneId: 'wX:p9',
    reason: 'pane-gone',
    elapsedMs: 4_200,
    timeoutMs: 90_000,
    tail: "TypeError: Cannot read properties of undefined (reading 'total')",
  });
  assert.match(crashed, /wX:p9 exited before its pipe became ready/);
  assert.match(crashed, /last output of wX:p9/);

  const slow = readyFailureText({
    paneId: 'wX:p9', reason: 'timeout', elapsedMs: 90_000, timeoutMs: 90_000, lastStatus: 'working',
    hint: 'Tip: pass run_in_background to avoid blocking the master turn while the worker boots.',
  });
  assert.match(slow, /pipe not ready within 90s/);
  assert.match(slow, /alive and working/);
  assert.match(slow, /run_in_background/);

  const stuck = readyFailureText({ paneId: 'wX:p9', reason: 'timeout', elapsedMs: 90_000, timeoutMs: 90_000, lastStatus: 'idle' });
  assert.match(stuck, /never registered its pipe/);
  assert.ok(!stuck.includes('last output'));
});

test('resolveTaskIdPrefix: exact beats length, prefixes need four chars and report ambiguity', () => {
  const candidates = [
    'c1b5274d-1111-2222-3333-444455556666',
    'c1b5899a-aaaa-bbbb-cccc-ddddeeeeffff',
    'a2f48901-0000-1111-2222-333344445555',
    'p2',
  ];
  const resolved = resolveTaskIdPrefix('c1b5274d', candidates);
  assert.equal(resolved.kind === 'resolved' && resolved.taskId, candidates[0]);
  const four = resolveTaskIdPrefix('A2F4', candidates);
  assert.equal(four.kind === 'resolved' && four.taskId, candidates[2], 'prefix match is case-insensitive');
  const ambiguous = resolveTaskIdPrefix('c1b5', candidates);
  assert.ok(ambiguous.kind === 'ambiguous');
  if (ambiguous.kind === 'ambiguous') assert.deepEqual(ambiguous.candidates, [candidates[0], candidates[1]]);
  assert.equal(resolveTaskIdPrefix('c1b', candidates).kind, 'too_short');
  assert.equal(resolveTaskIdPrefix('ffff', candidates).kind, 'not_found');
  assert.equal(resolveTaskIdPrefix('  ', candidates).kind, 'not_found');
  const exact = resolveTaskIdPrefix('p2', candidates);
  assert.equal(exact.kind === 'resolved' && exact.taskId, 'p2');
});

test('tabNameForTask/nextTaskTabName: collapse, truncate, and suffix within the limit', () => {
  assert.equal(tabNameForTask('  网络调研   现状  '), '网络调研 现状');
  assert.equal(tabNameForTask('a'.repeat(30)), 'a'.repeat(TAB_NAME_MAX));
  assert.equal(tabNameForTask('   '), 'task');
  assert.equal(nextTaskTabName('调研', new Set(['spike'])), '调研');
  assert.equal(nextTaskTabName('调研', new Set(['调研'])), '调研-2');
  assert.equal(nextTaskTabName('调研', new Set(['调研', '调研-2'])), '调研-3');
  const long = 'a'.repeat(TAB_NAME_MAX);
  const next = nextTaskTabName(long, new Set([long]));
  assert.equal(next, 'a'.repeat(TAB_NAME_MAX - 2) + '-2');
  assert.ok(next.length <= TAB_NAME_MAX);
});

test('planTabPlacement: explicit tab joins or creates; D86 zone decides otherwise', () => {
  const knownTabs = [{ tabName: '调研', tabId: 'w1:t9' }, { tabName: 'spike', tabId: 'w1:t10' }];
  const main = { zone: 'main' as const, tabName: null };
  const cases: Array<[string, Parameters<typeof planTabPlacement>[0], unknown]> = [
    ['an existing tab name joins it', { desiredTab: '调研', description: 'x', knownTabs }, { mode: 'append', tabName: '调研', tabId: 'w1:t9' }],
    ['an unknown tab name creates one', { desiredTab: '新任务', description: 'x', knownTabs }, { mode: 'new', tabName: '新任务', tabId: null }],
    ['without a tab name the zone decides', { description: '现状', knownTabs, zone: main, mainTabId: 'w1:t0' }, { mode: 'append', tabName: 'main', tabId: 'w1:t0' }],
    ['a whitespace-only tab name counts as absent', { desiredTab: '   ', description: 'spike', knownTabs, zone: main, mainTabId: 'w1:t0' }, { mode: 'append', tabName: 'main', tabId: 'w1:t0' }],
    ['a worktree zone with a live tab joins it', { description: 'bug#2', knownTabs: [{ tabName: 'hotfix-2', tabId: 'w1:t5' }], zone: { zone: 'worktree', tabName: 'hotfix-2' }, mainTabId: 'w1:t0' }, { mode: 'append', tabName: 'hotfix-2', tabId: 'w1:t5' }],
    ['a worktree zone without one creates it', { description: 'bug#3', knownTabs: [{ tabName: 'hotfix-2', tabId: 'w1:t5' }], zone: { zone: 'worktree', tabName: 'hotfix-3' }, mainTabId: 'w1:t0' }, { mode: 'new', tabName: 'hotfix-3', tabId: null }],
    // No zone information → derive from the description and always create.
    ['no zone derives the name and creates', { description: '网络调研现状', knownTabs: [{ tabName: '网络调研现状', tabId: 'w1:t9' }] }, { mode: 'new', tabName: '网络调研现状-2', tabId: null }],
  ];
  for (const [name, input, expected] of cases) assert.deepEqual(planTabPlacement(input), expected, name);
});

test('classifyWorktreeZone: main checkout, sibling worktree, unrelated dir, prefix trap', () => {
  const worktrees = ['F:/repo', 'F:/wt/hotfix-2', 'F:/wt/hotfix-3'];
  const cases: Array<[string, string, unknown]> = [
    ['the main checkout and its children', 'F:\\repo\\packages', { zone: 'main', tabName: null }],
    ['a sibling worktree, named after its directory', 'F:\\wt\\hotfix-2\\src', { zone: 'worktree', tabName: 'hotfix-2' }],
    ['case-insensitive matching', 'f:/WT/HOTFIX-3', { zone: 'worktree', tabName: 'hotfix-3' }],
    ['an unrelated directory is main', 'C:\\temp', { zone: 'main', tabName: null }],
    ['a name prefix is not a parent (/repo-x vs /repo)', 'F:/repo-x', { zone: 'main', tabName: null }],
  ];
  for (const [name, cwd, expected] of cases) {
    assert.deepEqual(classifyWorktreeZone({ cwd, masterCwd: 'F:/repo', worktrees }), expected, name);
  }
});

/* ── plugin wiring ──────────────────────────────────────────────── */

test('subagent plugin: one tool, lifecycle hooks, port binding and unbinding', async () => {
  const { root, pi, port } = await mountSubagent();
  assert.ok(pi.tools.has('subagent'));
  assert.ok(!pi.tools.has('list_agents'), 'no legacy tool aliases');
  assert.ok((pi.listeners.get('session_start') ?? []).length >= 1);
  assert.ok((pi.listeners.get('turn_start') ?? []).length >= 1, 'GC turn_start hook');
  assert.ok(port.current, 'port bound at mount');
  for (const key of ['applyReplySession', 'reconcileOnReply', 'listRunningSubs', 'settleStatLine'] as const) {
    assert.equal(typeof port.current[key], 'function', `port member ${key}`);
  }
  port.current.applyReplySession('unknown', null);
  assert.deepEqual(port.current.reconcileOnReply('unknown'), []);

  assert.match((await runSubagent(pi, { action: 'list' })).content[0]!.text, /No background subagents/);
  await assert.rejects(runSubagent(pi, { action: 'explode' }), /unknown action "explode"/);

  await root.fiber.dispose();
  assert.equal(port.current, null, 'port unbound on dispose');
});

test('subagent plugin: ledger tombstone makes the tool inert', async () => {
  const ledger = new DisposeLedger();
  const { root, pi, port } = await mountSubagent({ ledger });
  assert.equal(ledger.disposeKey(new URL('../src/plugins/subagent.ts', import.meta.url).href), 1);
  assert.match((await runSubagent(pi, { action: 'list' })).content[0]!.text, /disposed/);
  assert.equal(typeof port.current?.reconcileOnReply, 'function');
  await root.fiber.dispose();
});

test('subagent plugin: tool_result hook only rewrites our errors, and stays silent for a dead pane', async () => {
  const { root, pi } = await mountSubagent({
    subs: [subEntry({ paneId: 'w1:p2', cwd: '/tmp', description: 'dead worker', createdAt: 1 })],
  });
  const hook = (pi.listeners.get('tool_result') ?? [])[0]!;
  const call = (event: Record<string, unknown>) => hook(event) as Promise<unknown>;
  assert.equal(await call({ toolName: 'subagent', toolCallId: 'tc1', isError: true, content: [{ type: 'text', text: 'Error: failed to reach subagent w1:p2: pipe not ready' }] }), undefined);
  assert.equal(await call({ toolName: 'subagent', toolCallId: 'tc2', isError: false, content: [] }), undefined);
  assert.equal(await call({ toolName: 'bash', toolCallId: 'tc3', isError: true, content: [] }), undefined);
  assert.equal(await call({ toolName: 'subagent', toolCallId: 'tc4', isError: true, content: [{ type: 'text', text: 'Error: unknown action' }] }), undefined);
  await root.fiber.dispose();
});

test('subagent plugin: prompt surface is present and a missing action normalizes to spawn', async () => {
  const { root, pi } = await mountSubagent();
  const def = pi.tools.get('subagent')!;
  assert.match(String(def.promptSnippet ?? ''), /subagent/);
  assert.ok((def.promptGuidelines?.length ?? 0) >= 4);
  const guidelines = (def.promptGuidelines ?? []).join(' ');
  assert.match(guidelines, /run_in_background/);
  assert.match(guidelines, /isolate/);
  assert.match(guidelines, /action: "send"/);
  assert.deepEqual(def.prepareArguments?.({ description: 'x', prompt: 'y' }), { description: 'x', prompt: 'y', action: 'spawn' });
  assert.deepEqual(def.prepareArguments?.({ action: 'list' }), { action: 'list' });
  assert.deepEqual(def.prepareArguments?.(undefined), { action: 'spawn' });
  await root.fiber.dispose();
});

test('subagent plugin: list shows live state, activity and a foreign cwd only when it differs', async () => {
  const worker = (paneId: string, taskId: string, description: string): SubEntry => subEntry({
    paneId, taskId, tabId: 't-1', tabName: '', cwd: '/workspace/repo', description, createdAt: 1,
  });
  const { root, pi } = await mountSubagent({
    client: {
      available: false, // keeps the session-recovery pollers out of a rendering-only test
      listPanes: async () => [
        { paneId: 'p-1', tabId: 't-1', workspaceId: 'w1', agentStatus: 'working', foregroundCwd: '/workspace/repo/packages/sub' },
        { paneId: 'p-2', tabId: 't-1', workspaceId: 'w1', agentStatus: 'working', foregroundCwd: '/workspace/repo' },
      ],
    },
    subs: [worker('p-1', 'task-1', 'Worker 1'), worker('p-2', 'task-2', 'Worker 2')],
  });
  try {
    const lines = (await runSubagent(pi, { action: 'list' })).content[0]!.text.split('\n');
    assert.equal(lines[0], 'p-1 [running working] (task) [cwd: sub] Worker 1');
    assert.equal(lines[1], 'p-2 [running working] (task) Worker 2', 'no cwd tag when the foreground cwd is the worker cwd');
  } finally {
    await root.fiber.dispose();
  }
});
