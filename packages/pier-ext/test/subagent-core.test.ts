/** Subagent domain units: pure planners and notices (launch line, validation, tab placement,
 * readiness, liveness, isolate/worktree planning, task-id resolution) plus plugin wiring. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DisposeLedger } from '../src/ledger.ts';
import { mountSubagent, runSubagent, subEntry, terminalInfo } from './test-utils.ts';
import {
  FOREGROUND_POLL_MS, MAIN_TAB_NAME, SUBS_CUSTOM_TYPE, TAB_NAME_MAX, Semaphore, agoText, buildAliveNotice, buildBlockedGateNotice,
  allocateSubSlug, slugifyTask, subRef,
  attachSubagentStructuredContent, buildLaunchLine, buildLaunchParts, classifyWorktreeZone, foldSubsRegistry, formatIsolateLocation, formatSubagentResult, isAlive,
  makeProgressUpdate, rekeySub, planForegroundTick, planLaunchValidation, planTabPlacement, resolveTaskIdPrefix,
  flattenToolParams, idParam, sleepWhileSubsRunningNote, tabNameForTask, type AliveProbe, type SubEntry,
} from '../src/subagent-core.ts';
import { planReadyAttempt, readyBackoffMs, readyFailureText } from '../src/subagent-spawn.ts';

const RT = { nodePath: '/usr/local/bin/node', cliPath: '/opt/pi/dist/cli.js', extPath: '/ext/index.ts' };

/** [case, command, running workers, note expected] */
const SLEEP_NOTE_CASES: Array<[string, string, number, boolean]> = [
  ['a long sleep while a worker runs', 'sleep 120; echo waited', 1, true],
  ['the longest of several sleeps counts', 'sleep 5 && make && sleep 300', 1, true],
  ['an `s` suffix is still seconds', 'cd x && sleep 90s; tail log', 2, true],
  ['exactly the threshold', 'sleep 60', 1, true],
  ['a short poll is left alone', 'sleep 30; tail -5 build.log', 1, false],
  ['no background worker → no note', 'sleep 840', 0, false],
  ['a minute suffix is not misread as seconds', 'sleep 2m', 1, false],
  ['a word containing sleep is not a sleep', 'grep nosleep 600 x', 1, false],
];

test('sleepWhileSubsRunningNote: long sleeps while background workers run get the auto-notice reminder', () => {
  for (const [name, command, workers, expected] of SLEEP_NOTE_CASES) {
    const running = Array.from({ length: workers }, (_, i) => ({ paneId: `p${i}`, slug: `task-${i}` }));
    const note = sleepWhileSubsRunningNote(command, running);
    assert.equal(note !== null, expected, name);
    if (note) assert.ok(note.includes('task-0@p0') && /arrives automatically/.test(note), name);
  }
});

test('foldSubsRegistry: a persisted report delivery survives the fold; a malformed one is dropped', () => {
  const row = (reportDelivered: unknown) => ({ type: 'custom', customType: SUBS_CUSTOM_TYPE, data: { subs: [{ paneId: 'p1', reportDelivered }] } });
  assert.deepEqual(foldSubsRegistry([row({ fingerprint: 'tail', at: 5 })]).subs[0]!.reportDelivered, { fingerprint: 'tail', at: 5 });
  assert.equal(foldSubsRegistry([row({ fingerprint: 3 })]).subs[0]!.reportDelivered, undefined);
});

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

test('flattenToolParams: nested parameters fill missing top-level ids and do not override them', () => {
  const flat = flattenToolParams({ action: 'output', parameters: { agentId: 'wA:p3Z', max_chars: 5000 } });
  assert.equal(flat?.agentId, 'wA:p3Z');
  assert.equal(flat?.max_chars, 5000);
  assert.equal(idParam(flat, 'agentId', 'taskId'), 'wA:p3Z');
  assert.equal(idParam({ action: 'output', parameters: { agentId: 'wA:p3Z' } }, 'agentId'), 'wA:p3Z');
  assert.equal(flattenToolParams({ agentId: 'top', parameters: { agentId: 'nested' } })?.agentId, 'top');
});

test('buildLaunchParts: fullscreen TUI by default (static frames); PI_HERDR_TUI=regular opts out', () => {
  const base = ['/usr/local/bin/node', '/opt/pi/dist/cli.js', '-e', '/ext/index.ts'];
  assert.deepEqual(buildLaunchParts(RT, {}, {}), [...base, '--tui-mode', 'fullscreen']);
  assert.deepEqual(buildLaunchParts(RT, {}, { PI_HERDR_TUI: 'regular' }), base);
  assert.deepEqual(buildLaunchParts(RT, { approve: true, model: 'zai/glm-4.7', resumeFile: '/s.jsonl' }, {}), [
    '/usr/local/bin/node', '/opt/pi/dist/cli.js', '-a', '-e', '/ext/index.ts',
    '--tui-mode', 'fullscreen', '--provider', 'zai', '--model', 'glm-4.7', '--session', '/s.jsonl',
  ]);
});

test('buildLaunchParts: the provider is split off at the first "/" only', () => {
  const modelArgs = (model: string) => {
    const parts = buildLaunchParts(RT, { model }, { PI_HERDR_TUI: 'regular' });
    return parts.slice(parts.indexOf('-e') + 2);
  };
  assert.deepEqual(modelArgs('openrouter/moonshotai/kimi-k2'), ['--provider', 'openrouter', '--model', 'moonshotai/kimi-k2']);
  assert.deepEqual(modelArgs('glm-5.3'), ['--model', 'glm-5.3'], 'a bare model id is not also passed as the provider');
  assert.deepEqual(modelArgs('/odd'), ['--model', '/odd']);
});

test('attachSubagentStructuredContent: stamps the action onto details; non-objects pass through', () => {
  const result = attachSubagentStructuredContent('spawn', {
    content: [{ type: 'text', text: 'started subagent p2' }],
    details: { paneId: 'p2', taskId: 'task-9', background: true },
  }) as { structuredContent: Record<string, unknown> };
  assert.deepEqual(result.structuredContent, { action: 'spawn', paneId: 'p2', taskId: 'task-9', background: true });
  assert.equal(
    (attachSubagentStructuredContent('list', { content: [], details: {} }) as { structuredContent: { action: string } }).structuredContent.action,
    'list',
    'empty details still yield the action',
  );
  assert.equal(attachSubagentStructuredContent('output', undefined), undefined);
});

test('rekeySub: a revived entry drops its dead pane id so it is listed (and swept) once', () => {
  const entry = subEntry({ paneId: 'w1:p3', status: 'closed' });
  const other = subEntry({ paneId: 'w1:p4' });
  const subs = new Map([['w1:p3', entry], ['w1:p4', other]]);
  entry.paneId = 'w1:p9'; // what reviveEntry does in place
  entry.status = 'running';
  rekeySub(subs, 'w1:p3', entry);
  assert.deepEqual([...subs.keys()].sort(), ['w1:p4', 'w1:p9']);
  assert.equal(subs.get('w1:p9'), entry);
  // A row that took over the old key in the meantime is not ours to delete.
  const squatter = subEntry({ paneId: 'w1:p9' });
  const map2 = new Map([['w1:p9', squatter]]);
  const moved = subEntry({ paneId: 'w1:p10' });
  rekeySub(map2, 'w1:p9', moved);
  assert.deepEqual([...map2.keys()].sort(), ['w1:p10', 'w1:p9']);
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

test('foldSubsRegistry: the observation window survives a persist/rebuild round-trip; malformed isolate falls back to none', () => {
  const isolate = { worktreePath: '/wt/pier-x', branch: 'pier/x', baseSha: 'abc', releasedAt: null, retainNotified: false };
  const row = entryFrom(mkSub({
    paneId: 'w1:p1',
    status: 'running',
    observationStartedAt: 1234567890,
    isolate,
  }));
  assert.equal(row.observationStartedAt, 1234567890);
  assert.deepEqual(row.isolate, isolate);

  const legacy = entryFrom(mkSub({ paneId: 'w1:p1', status: 'settled' }));
  assert.equal(legacy.observationStartedAt, null);
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

test('formatIsolateLocation: gives the absolute worktree path, empty for a shared checkout', () => {
  assert.equal(formatIsolateLocation(null), '');
  assert.equal(formatIsolateLocation(undefined), '');
  assert.equal(
    formatIsolateLocation({ worktreePath: '/Users/dev/.herdr/worktrees/apnv3-backend/pier-implement-20680', branch: 'pier/implement-20680' }),
    '\nWorktree: /Users/dev/.herdr/worktrees/apnv3-backend/pier-implement-20680 (branch pier/implement-20680)',
  );
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
  assert.match(text, /next turn boundary/);
  assert.match(text, /do NOT sleep or poll/i);
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
  assert.match(text, /Tell the user to open that terminal in the Herdr app/);
  assert.match(text, /subagent\(action: "send"\)/);
  assert.match(text, /do not redo the work yourself/);
  assert.ok(!buildBlockedGateNotice({ paneId: 'wB:p4', description: 'X', question: null }).includes('question:'));
});

test('planLaunchValidation: core availability, prompt, isolate/cwd', () => {
  const errorText = (result: { kind: string; text?: string }): string => (result.kind === 'error' ? result.text! : '');
  assert.match(errorText(planLaunchValidation({ prompt: 'x' }, false)), /herdr-core terminal/);
  assert.match(errorText(planLaunchValidation({ prompt: '   ' }, true)), /prompt/);
  assert.match(errorText(planLaunchValidation({ prompt: 'x', isolate: true, cwd: '/tmp' }, true)), /mutually exclusive/);

  const ok = planLaunchValidation({
    description: 'scan',
    prompt: 'do it',
    run_in_background: true,
    tab: 'feat',
  }, true);
  assert.equal(ok.kind, 'ok');
  if (ok.kind !== 'ok') return;
  assert.equal(ok.spec.description, 'scan');
  assert.equal(ok.background, true);
  assert.equal(ok.tab, 'feat');
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

test('tabNameForTask: collapse, truncate, fall back', () => {
  assert.equal(tabNameForTask('  网络调研   现状  '), '网络调研 现状');
  assert.equal(tabNameForTask('a'.repeat(30)), 'a'.repeat(TAB_NAME_MAX));
  assert.equal(tabNameForTask('   '), 'task');
});

test('planTabPlacement: no tab means no pane; a named tab gets a stable app tab; main joins the master', () => {
  const cases: Array<[string, Parameters<typeof planTabPlacement>[0], unknown]> = [
    ['no tab: no pane', {}, { tabName: '', tabId: null }],
    ['a null tab: no pane', { desiredTab: null }, { tabName: '', tabId: null }],
    ['a whitespace-only tab name counts as absent', { desiredTab: '   ' }, { tabName: '', tabId: null }],
    ['an explicit tab is its own tab', { desiredTab: '调研' }, { tabName: '调研', tabId: 'tbpier-' + fnvSlug('调研') }],
    ['the same tab name always maps to the same app tab', { desiredTab: 'Spike Two' }, { tabName: 'Spike Two', tabId: 'tbpier-spike-two' }],
    ['a tab literally named main joins the master tab', { desiredTab: 'Main' }, { tabName: MAIN_TAB_NAME, tabId: null }],
  ];
  for (const [name, input, expected] of cases) assert.deepEqual(planTabPlacement(input), expected, name);
});

/** Mirrors the id derivation in subagent-core for non-ASCII names (FNV-1a over code points). */
function fnvSlug(name: string): string {
  let hash = 0x811c9dc5;
  for (const ch of name) {
    hash ^= ch.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

test('classifyWorktreeZone: main checkout, sibling worktree, unrelated dir, prefix trap', () => {
  const worktrees = ['F:/repo', 'F:/wt/hotfix-2', 'F:/wt/hotfix-3'];
  const cases: Array<[string, string, unknown]> = [
    ['the main checkout and its children', 'F:\\repo\\packages', { zone: 'main' }],
    ['a sibling worktree', 'F:\\wt\\hotfix-2\\src', { zone: 'worktree' }],
    ['case-insensitive matching', 'f:/WT/HOTFIX-3', { zone: 'worktree' }],
    ['an unrelated directory is main', 'C:\\temp', { zone: 'main' }],
    ['a name prefix is not a parent (/repo-x vs /repo)', 'F:/repo-x', { zone: 'main' }],
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

test('subagent plugin: help returns the manual, and a missing action normalizes to spawn', async () => {
  const { root, pi } = await mountSubagent();
  const def = pi.tools.get('subagent')!;
  const help = await runSubagent(pi, { action: 'help' });
  assert.match(help.content[0]!.text, /^subagent manual/);
  for (const topic of ['isolate', 'wait', 'resume', 'history.jsonl']) assert.ok(help.content[0]!.text.includes(topic), topic);
  assert.equal(String(def.description).includes('history.jsonl'), false, 'ledger detail rides help, not every request');
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
      getTerminal: async (id) => (id === 'p-1'
        ? terminalInfo({ id: 'p-1', status: 'working', labels: { 'herdr.tab': 't-1' }, foreground: { pid: 1, name: 'pi', argv: [], cwd: '/workspace/repo/packages/sub' } })
        : terminalInfo({ id: 'p-2', status: 'working', labels: { 'herdr.tab': 't-1' }, foreground: { pid: 2, name: 'pi', argv: [], cwd: '/workspace/repo' } })),
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

test('subagent plugin: list prints the isolate worktree path, not the branch', async () => {
  const isolate = {
    worktreePath: '/Users/dev/.herdr/worktrees/apnv3-backend/pier-implement-20680',
    branch: 'pier/implement-20680',
    baseSha: 'abc1234',
    releasedAt: null,
    retainNotified: false,
  };
  const { root, pi } = await mountSubagent({
    client: {
      available: false,
      getTerminal: async () => terminalInfo({ id: 'wA:p5D', status: 'idle', labels: { 'herdr.tab': 't-1' } }),
    },
    subs: [subEntry({
      paneId: 'wA:p5D', taskId: 'task-iso', tabId: 't-1', tabName: 'pier-implement-20680',
      cwd: isolate.worktreePath, description: 'implement 20680', createdAt: 1, isolate,
    })],
  });
  try {
    const text = (await runSubagent(pi, { action: 'list' })).content[0]!.text;
    assert.match(text, /\[wt: \/Users\/dev\/\.herdr\/worktrees\/apnv3-backend\/pier-implement-20680\]/);
    assert.ok(!text.includes('[wt: pier/implement-20680]'), 'a branch is not a directory the master can enter');
  } finally {
    await root.fiber.dispose();
  }
});

/* ── Phase 2 task slugs (RFC rfc-delegation-identity §3.1) ──────── */

test('slugifyTask / allocateSubSlug / subRef: kebab-case, CJK fallback, dedupe numbering, display form', () => {
  assert.equal(slugifyTask('Fix Auth Flow!'), 'fix-auth-flow');
  assert.equal(slugifyTask('  read--me  '), 'read-me');
  assert.equal(slugifyTask('a'.repeat(40)), 'a'.repeat(24), 'slug caps at 24 chars');
  assert.equal(slugifyTask('探查'), '', 'non-ASCII sanitizes to nothing');
  const taken = new Set(['fix-auth']);
  assert.equal(allocateSubSlug('fix auth', 'taskid', taken), 'fix-auth-2');
  assert.equal(allocateSubSlug('fix auth', 'taskid', new Set(['fix-auth', 'fix-auth-2'])), 'fix-auth-3');
  assert.equal(allocateSubSlug('探查', '9faaa0e5-rest', new Set()), 'task-9faaa0', 'CJK falls back to a taskId prefix');
  assert.equal(subRef({ paneId: 'p2', slug: 'fix-auth' }), 'fix-auth@p2');
  assert.equal(subRef({ paneId: 'p2' }), 'p2', 'slug-less rows keep the bare paneId (back-compat)');
});

test('foldSubsRegistry: slug parses, survives replay, and old rows without it stay undefined', () => {
  const entries = [
    { type: 'custom', customType: SUBS_CUSTOM_TYPE, data: { version: 2, subs: [{ paneId: 'p2', taskId: 't1' }] } },
    { type: 'custom', customType: SUBS_CUSTOM_TYPE, data: { version: 2, subs: [{ paneId: 'p2', taskId: 't1', slug: 'fix-auth' }, { paneId: 'p3', taskId: 't2' }] } },
  ];
  const registry = foldSubsRegistry(entries);
  assert.equal(registry.subs.find((s) => s.paneId === 'p2')?.slug, 'fix-auth');
  assert.equal(registry.subs.find((s) => s.paneId === 'p3')?.slug, undefined);
});
