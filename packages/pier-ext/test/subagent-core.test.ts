/**
 * Subagent domain unit tests: pure planners and notices (launch line, validation, tab placement,
 * readiness backoff, liveness notices, task-id resolution) plus plugin wiring (tool surface, port
 * binding, action dispatch, list rendering).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import subagentPlugin from '../src/plugins/subagent.ts';
import { PiSurface } from '../src/pi-surface.ts';
import { DisposeLedger } from '../src/ledger.ts';
import type { HerdrClientLike } from '../src/herdr-client.ts';
import {
  FOREGROUND_POLL_MS,
  TAB_NAME_MAX,
  Semaphore,
  agoText,
  buildAliveNotice,
  buildBlockedGateNotice,
  buildLaunchLine,
  buildLaunchParts,
  classifyWorktreeZone,
  emptySubagentPortBox,
  foldSubsRegistry,
  formatSubagentResult,
  isAlive,
  makeProgressUpdate,
  nextTaskTabName,
  planForegroundTick,
  planLaunchValidation,
  planTabPlacement,
  resolveTaskIdPrefix,
  tabNameForTask,
  type AliveProbe,
  type SubEntry,
} from '../src/subagent-core.ts';
import { planReadyAttempt, readyBackoffMs, readyFailureText } from '../src/subagent-spawn.ts';
import { SUBS_CUSTOM_TYPE } from '../src/subagent-core.ts';

const RT = { nodePath: '/usr/local/bin/node', cliPath: '/opt/pi/dist/cli.js', extPath: '/ext/index.ts' };

test('buildLaunchLine: win32 uses PowerShell & syntax, POSIX starts via sh', () => {
  const parts = ['/usr/local/bin/node', '/opt/pi/dist/cli.js', '-e', '/ext/index.ts'];
  assert.equal(
    buildLaunchLine(parts, 'win32'),
    `& '/usr/local/bin/node' '/opt/pi/dist/cli.js' '-e' '/ext/index.ts'`,
  );
  assert.equal(
    buildLaunchLine(parts, 'darwin'),
    `'/usr/local/bin/node' '/opt/pi/dist/cli.js' '-e' '/ext/index.ts'`,
  );
  assert.equal(buildLaunchLine(parts, 'linux'), buildLaunchLine(parts, 'darwin'));
  // A quoted path stays a single literal under both syntaxes.
  assert.equal(buildLaunchLine(["it's a path"], 'darwin'), `'it'\\''s a path'`);
  assert.equal(buildLaunchLine(["it's a path"], 'win32'), `& 'it''s a path'`);
});

test('buildLaunchParts: fullscreen TUI by default (static frames); PI_HERDR_TUI=regular opts out', () => {
  assert.deepEqual(
    buildLaunchParts(RT, {}, {}),
    ['/usr/local/bin/node', '/opt/pi/dist/cli.js', '-e', '/ext/index.ts', '--tui-mode', 'fullscreen'],
  );
  assert.deepEqual(
    buildLaunchParts(RT, {}, { PI_HERDR_TUI: 'regular' }),
    ['/usr/local/bin/node', '/opt/pi/dist/cli.js', '-e', '/ext/index.ts'],
  );
  assert.deepEqual(
    buildLaunchParts(RT, { approve: true, roleModel: 'zai/glm-4.7', resumeFile: '/s.jsonl' }, {}),
    [
      '/usr/local/bin/node', '/opt/pi/dist/cli.js', '-a', '-e', '/ext/index.ts',
      '--tui-mode', 'fullscreen', '--provider', 'zai', '--model', 'glm-4.7', '--session', '/s.jsonl',
    ],
  );
});

const mkSub = (over: Record<string, unknown>) => ({
  taskId: 't1', kind: 'short', paneId: 'w1:p1', tabId: 'w1:t9', cwd: 'F:\\herdr-pi',
  description: 'task', background: true, status: 'running', sessionFile: null,
  launchCommand: ['x'], createdAt: 1, ...over,
});

const registryBranch = (subs: Array<Record<string, unknown> | SubEntry>) =>
  [{ type: 'custom', customType: SUBS_CUSTOM_TYPE, data: { version: 2, subs } }] as never;

test('foldSubsRegistry: last snapshot wins; legacy kinds normalize; v1 rows migrate', () => {
  const reg = foldSubsRegistry([
    { type: 'session' },
    { type: 'custom', customType: 'other', data: { x: 1 } },
    { type: 'custom', customType: SUBS_CUSTOM_TYPE, data: { version: 2, subs: [mkSub({ paneId: 'w1:p1', status: 'settled' })] } },
    { type: 'custom', customType: SUBS_CUSTOM_TYPE, data: { version: 2, subs: [mkSub({ paneId: 'w1:p2', status: 'consumed', kind: 'resident', tabName: '调研' })] } },
  ] as never);
  assert.equal(reg.version, 2);
  assert.equal(reg.subs.length, 1);
  assert.equal(reg.subs[0]!.paneId, 'w1:p2');
  assert.equal(reg.subs[0]!.status, 'consumed');
  assert.equal(reg.subs[0]!.kind, 'task', 'resident folds to task');
  assert.equal(reg.subs[0]!.tabName, '调研');

  const unknownRole = foldSubsRegistry(registryBranch([mkSub({ paneId: 'w1:p3', kind: 'advisor' })]));
  assert.equal(unknownRole.subs[0]!.kind, 'advisor', 'unknown role names pass through');

  const v1 = foldSubsRegistry([
    { type: 'custom', customType: SUBS_CUSTOM_TYPE, data: { version: 1, subs: [{ paneId: 'w1:p9', description: 'old', background: true, status: 'settled', createdAt: 5 }] } },
  ] as never);
  assert.equal(v1.subs[0]!.taskId, 'w1:p9', 'v1 rows default taskId to the pane id');
  assert.equal(v1.subs[0]!.kind, 'task');
  assert.equal(v1.subs[0]!.cwd, '');
  assert.deepEqual(v1.subs[0]!.launchCommand, []);

  assert.deepEqual(foldSubsRegistry([{ type: 'session' }] as never), { version: 2, subs: [] });
});

test('foldSubsRegistry: takeover fields and isolate metadata survive a persist/rebuild round-trip', () => {
  const reg = foldSubsRegistry(registryBranch([mkSub({
    paneId: 'w1:p1',
    status: 'running',
    userTakeover: true,
    observationStartedAt: 1234567890,
    lastAgentStatus: 'working',
    isolate: { worktreePath: '/wt/pier-x', branch: 'pier/x', baseSha: 'abc', releasedAt: null, retainNotified: false },
  })]));
  assert.equal(reg.subs[0]!.userTakeover, true);
  assert.equal(reg.subs[0]!.observationStartedAt, 1234567890);
  assert.equal(reg.subs[0]!.lastAgentStatus, 'working');
  assert.equal(reg.subs[0]!.isolate?.branch, 'pier/x');

  const legacy = foldSubsRegistry(registryBranch([mkSub({ paneId: 'w1:p1', status: 'settled' })]));
  assert.equal(legacy.subs[0]!.userTakeover, undefined);
  assert.equal(legacy.subs[0]!.observationStartedAt, null);
  assert.equal(legacy.subs[0]!.lastAgentStatus, null);
  assert.equal(legacy.subs[0]!.tabName, '', 'rows without a tab name fall back to empty');
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

test('planLaunchValidation: herdr, prompt and isolate/cwd gates', () => {
  assert.match(errorText(planLaunchValidation({ prompt: 'x' }, false)), /HERDR_ENV/);
  assert.match(errorText(planLaunchValidation({ prompt: '   ' }, true)), /prompt/);
  assert.match(errorText(planLaunchValidation({ prompt: 'x', isolate: true, cwd: '/tmp' }, true)), /mutually exclusive/);
});

test('planLaunchValidation: defaults the role, extracts suggested tools, normalizes the kind', () => {
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
  assert.equal(readyBackoffMs(0), 500);
  assert.equal(readyBackoffMs(1), 1000);
  assert.equal(readyBackoffMs(2), 2000);
  assert.equal(readyBackoffMs(3), 4000);
  assert.equal(readyBackoffMs(4), 4000);
  assert.equal(readyBackoffMs(99), 4000);
  assert.equal(readyBackoffMs(-3), 500);
  assert.equal(readyBackoffMs(1.7), 1000);
});

test('planReadyAttempt: ready wins; a gone pane fails fast; an unknown probe keeps retrying', () => {
  assert.deepEqual(planReadyAttempt({ elapsedMs: 10, attempt: 0, timeoutMs: 90_000, alive: true, ready: true }), { kind: 'ready' });
  assert.deepEqual(planReadyAttempt({ elapsedMs: 10, attempt: 0, timeoutMs: 90_000, alive: false, ready: false }), { kind: 'give-up', reason: 'pane-gone' });
  assert.deepEqual(planReadyAttempt({ elapsedMs: 10, attempt: 0, timeoutMs: 90_000, alive: null, ready: false }), { kind: 'retry', delayMs: 500 });
  assert.deepEqual(planReadyAttempt({ elapsedMs: 89_999, attempt: 7, timeoutMs: 90_000, alive: true, ready: false }), { kind: 'retry', delayMs: 4000 });
  assert.deepEqual(planReadyAttempt({ elapsedMs: 90_000, attempt: 8, timeoutMs: 90_000, alive: true, ready: false }), { kind: 'give-up', reason: 'timeout' });
  // A dead pane outranks the timeout: the more accurate reason wins.
  assert.deepEqual(planReadyAttempt({ elapsedMs: 120_000, attempt: 9, timeoutMs: 90_000, alive: false, ready: false }), { kind: 'give-up', reason: 'pane-gone' });
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
  assert.deepEqual(
    planTabPlacement({ desiredTab: '调研', description: 'x', knownTabs }),
    { mode: 'append', tabName: '调研', tabId: 'w1:t9' },
  );
  assert.deepEqual(
    planTabPlacement({ desiredTab: '新任务', description: 'x', knownTabs }),
    { mode: 'new', tabName: '新任务', tabId: null },
  );
  assert.deepEqual(
    planTabPlacement({ desiredTab: undefined, description: '现状', knownTabs, zone: { zone: 'main', tabName: null }, mainTabId: 'w1:t0' }),
    { mode: 'append', tabName: 'main', tabId: 'w1:t0' },
  );
  // Whitespace-only is treated as absent.
  assert.deepEqual(
    planTabPlacement({ desiredTab: '   ', description: 'spike', knownTabs, zone: { zone: 'main', tabName: null }, mainTabId: 'w1:t0' }),
    { mode: 'append', tabName: 'main', tabId: 'w1:t0' },
  );
  assert.deepEqual(
    planTabPlacement({ description: 'bug#2', knownTabs: [{ tabName: 'hotfix-2', tabId: 'w1:t5' }], zone: { zone: 'worktree', tabName: 'hotfix-2' }, mainTabId: 'w1:t0' }),
    { mode: 'append', tabName: 'hotfix-2', tabId: 'w1:t5' },
  );
  assert.deepEqual(
    planTabPlacement({ description: 'bug#3', knownTabs: [{ tabName: 'hotfix-2', tabId: 'w1:t5' }], zone: { zone: 'worktree', tabName: 'hotfix-3' }, mainTabId: 'w1:t0' }),
    { mode: 'new', tabName: 'hotfix-3', tabId: null },
  );
  // No zone information → derive from the description and always create.
  assert.deepEqual(
    planTabPlacement({ description: '网络调研现状', knownTabs: [{ tabName: '网络调研现状', tabId: 'w1:t9' }] }),
    { mode: 'new', tabName: '网络调研现状-2', tabId: null },
  );
});

test('classifyWorktreeZone: main checkout, sibling worktree, unrelated dir, prefix trap', () => {
  const worktrees = ['F:/repo', 'F:/wt/hotfix-2', 'F:/wt/hotfix-3'];
  assert.deepEqual(
    classifyWorktreeZone({ cwd: 'F:\\repo\\packages', masterCwd: 'F:/repo', worktrees }),
    { zone: 'main', tabName: null },
  );
  assert.deepEqual(
    classifyWorktreeZone({ cwd: 'F:\\wt\\hotfix-2\\src', masterCwd: 'F:/repo', worktrees }),
    { zone: 'worktree', tabName: 'hotfix-2' },
  );
  assert.deepEqual(
    classifyWorktreeZone({ cwd: 'f:/WT/HOTFIX-3', masterCwd: 'F:/repo', worktrees }),
    { zone: 'worktree', tabName: 'hotfix-3' },
  );
  assert.deepEqual(
    classifyWorktreeZone({ cwd: 'C:\\temp', masterCwd: 'F:/repo', worktrees }),
    { zone: 'main', tabName: null },
  );
  assert.deepEqual(
    classifyWorktreeZone({ cwd: 'F:/repo-x', masterCwd: 'F:/repo', worktrees }),
    { zone: 'main', tabName: null },
    '/repo-x is not under /repo',
  );
});

/* ── plugin wiring ──────────────────────────────────────────────── */

function errorText(result: { kind: string; text?: string }): string {
  return result.kind === 'error' ? result.text! : '';
}

interface FakePi {
  tools: Map<string, Record<string, unknown>>;
  listeners: Map<string, Array<(...a: unknown[]) => unknown>>;
  entries: Array<[string, unknown]>;
  registerTool(def: Record<string, unknown>): void;
  on(event: string, handler: (...a: unknown[]) => unknown): void;
  appendEntry(customType: string, data: unknown): void;
}

function fakePi(): FakePi {
  return {
    tools: new Map<string, Record<string, unknown>>(),
    listeners: new Map<string, Array<(...a: unknown[]) => unknown>>(),
    entries: [] as Array<[string, unknown]>,
    registerTool(def: Record<string, unknown>) {
      this.tools.set(String(def.name), def);
    },
    on(event: string, handler: (...a: unknown[]) => unknown) {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), handler]);
    },
    appendEntry(customType: string, data: unknown) {
      this.entries.push([customType, data]);
    },
  };
}

function fakeClient(panes: Array<Record<string, unknown>> = []): HerdrClientLike {
  return {
    available: true,
    tabList: async () => [],
    listPanes: async () => panes,
    listAgents: async () => [],
    waitAgent: async () => null,
    getAgentSessionPath: async () => null,
    createTab: async () => ({ tabId: 't1', paneId: 'p1' }),
    splitPane: async () => 'p2',
    sendPaneText: async () => undefined,
    tabClose: async () => undefined,
    closePane: async () => undefined,
  } as unknown as HerdrClientLike;
}

async function mount(pi: FakePi, ledger?: DisposeLedger, panes: Array<Record<string, unknown>> = [], available = true) {
  const surface = new PiSurface(pi as unknown as object, ledger);
  const port = emptySubagentPortBox();
  const root = new Context();
  root.provide('pi-herdr.surface', surface);
  root.provide('pi-herdr.subagent-deps', {
    client: { ...fakeClient(panes), available } as HerdrClientLike,
    env: { paneId: 'p0', tabId: 't0', workspaceId: 'w1' },
    extPath: 'F:/repo/pier/packages/pier-ext/src/index.ts',
    sessionRoot: root,
    port,
    getSessionId: () => '',
    reconcileOnSettlement: () => [],
    withReconcileNotes: (b: string) => b,
    claimSettleNotice: () => true,
    terminalState: { activePaneIds: () => new Set<string>() },
  });
  await root.plugin(subagentPlugin);
  return { root, port, pi };
}

async function fire(pi: FakePi, event: string, ...args: unknown[]): Promise<void> {
  for (const h of pi.listeners.get(event) ?? []) await h(...args);
}

const runTool = (pi: FakePi, params: Record<string, unknown>) =>
  (pi.tools.get('subagent')!.execute as (id: unknown, p: unknown) => Promise<{ content: Array<{ text: string }> }>)(null, params);

test('subagent plugin: one tool, lifecycle hooks, port binding and unbinding', async () => {
  const pi = fakePi();
  const { root, port } = await mount(pi);
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

  assert.match((await runTool(pi, { action: 'list' })).content[0]!.text, /No background subagents/);
  await assert.rejects(runTool(pi, { action: 'explode' }), /unknown action "explode"/);

  await root.fiber.dispose();
  assert.equal(port.current, null, 'port unbound on dispose');
});

test('subagent plugin: ledger tombstone makes the tool inert', async () => {
  const pi = fakePi();
  const ledger = new DisposeLedger();
  const { root, port } = await mount(pi, ledger);
  assert.equal(ledger.disposeKey(new URL('../src/plugins/subagent.ts', import.meta.url).href), 1);
  assert.match((await runTool(pi, { action: 'list' })).content[0]!.text, /disposed/);
  assert.equal(typeof port.current?.reconcileOnReply, 'function');
  await root.fiber.dispose();
});

test('subagent plugin: tool_result hook only rewrites our errors, and stays silent for a dead pane', async () => {
  const pi = fakePi();
  const { root } = await mount(pi);
  await fire(pi, 'session_start', {}, {
    sessionManager: {
      getBranch: () => registryBranch([
        mkSub({ paneId: 'w1:p2', cwd: '/tmp', description: 'dead worker', taskId: 'task-1' }),
      ]),
    },
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
  const pi = fakePi();
  const { root } = await mount(pi);
  const def = pi.tools.get('subagent')! as {
    promptSnippet?: string;
    promptGuidelines?: string[];
    prepareArguments?: (args: unknown) => Record<string, unknown>;
  };
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
  const pi = fakePi();
  const entry = (paneId: string, taskId: string, description: string): SubEntry => ({
    ...(mkSub({ paneId, taskId, description, tabId: 't-1', cwd: '/workspace/repo' }) as unknown as SubEntry),
    status: 'running',
  });
  // available:false keeps the session-recovery pollers out of a rendering-only test.
  const { root } = await mount(pi, undefined, [
    { paneId: 'p-1', agentStatus: 'working', foregroundCwd: '/workspace/repo/packages/sub' },
    { paneId: 'p-2', agentStatus: 'working', foregroundCwd: '/workspace/repo' },
  ], false);
  try {
    await fire(pi, 'session_start', {}, {
      sessionManager: { getBranch: () => registryBranch([entry('p-1', 'task-1', 'Worker 1'), entry('p-2', 'task-2', 'Worker 2')]) },
    });
    const lines = (await runTool(pi, { action: 'list' })).content[0]!.text.split('\n');
    assert.equal(lines[0], 'p-1 [running working] (task) [cwd: sub] Worker 1');
    assert.equal(lines[1], 'p-2 [running working] (task) Worker 2', 'no cwd tag when the foreground cwd is the worker cwd');
  } finally {
    await root.fiber.dispose();
  }
});
