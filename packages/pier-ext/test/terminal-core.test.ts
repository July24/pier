/** Terminal domain: the pure terminal-core planners (registry/validation/ANSI/increments/
 *  summarization/folding/idle nudge) + plugins/terminal.ts wiring through a real Context + PiSurface
 *  over the herdr-core client seam. */
import { test, mock, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { cordisProvide } from '../src/cordis-services.ts';
import terminalPlugin from '../src/plugins/terminal.ts';
import {
  MAX_TERMINALS, POSIX_PROMPT, POWERSHELL_PROMPT, SHELL_INIT_COMMAND, SIGNAL_KEYS, TERMINALS_CUSTOM_TYPE, TERM_REMINDERS_MAX,
  TERM_REMINDER_CUSTOM_TYPE, closeTerminal, compilePattern, computeIncrement, detectContinuationPrompt, detectFullscreenTUI,
  echoSafeWaitSuggestion, foldTerminalsRegistry, foregroundIsShell, hashPaneText,
  makeTerminalsRegistry, nextTerminalId, planTerminalReminder, planShellInit, promptStrategyFor, registerTerminal,
  classifyWaitMatch, parseExitSentinel, redirectedSentinel, regexLiteralPrefix, sentinelEchoHazard, stripAnsi, summarizeSessions, terminalIdleMs, validateSendText, validateSignal,
  withExitSentinel,
  type PromptStrategy, type TerminalEntry,
} from '../src/terminal-core.ts';
import { PiSurface } from '../src/pi-surface.ts';
import { DisposeLedger } from '../src/ledger.ts';
import { CoreError, type CoreClientLike } from '../src/core-client.ts';
import { fakeCore, fakePi, fire, terminalInfo, withCleanup, type FakePi } from './test-utils.ts';

const base = { paneId: 'pane-a', tabId: 'tab-1', cwd: 'F:/work', label: 'dev server', createdAt: 1000, lastActivityAt: 1000 };

const mkEntry = (over: Partial<TerminalEntry> = {}): TerminalEntry => ({
  terminalId: 'term-1', status: 'open', closedAt: null, nudges: 0, nudgedAt: null, readLen: 0, readTail: '', readTextLen: 0, readTextHash: 0, ...base, ...over,
}) as TerminalEntry;

test('registry: 取最大号 +1、默认 label = cwd 尾段、到达上限拒绝；closeTerminal 幂等', () => {
  assert.equal(nextTerminalId([]), 'term-1'); assert.equal(nextTerminalId(['term-1', 'term-3']), 'term-4');

  const r = registerTerminal([], { ...base, label: undefined as unknown as string });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.entry.terminalId, 'term-1'); assert.equal(r.entry.label, 'work');
  assert.equal(r.entries.length, 1);

  const existing = Array.from({ length: MAX_TERMINALS }, (_, i) => mkEntry({ terminalId: `term-${i + 1}`, paneId: `p${i}` }));
  const full = registerTerminal(existing, base);
  assert.equal(full.ok, false);
  if (full.ok) return;
  assert.match(full.error, /max/i); assert.match(full.error, /8/);

  const once = closeTerminal([mkEntry()], 'term-1', 2000);
  assert.equal(once.entries[0].status, 'closed'); assert.equal(once.entries[0].closedAt, 2000);
  assert.equal(closeTerminal(once.entries, 'term-1', 3000).entries[0].closedAt, 2000, 'idempotent: an existing closedAt is kept');
  assert.equal(closeTerminal([], 'term-x', 1).entries.length, 0);
});

test('registry: 请求的 terminal_id 被采纳（trim），占用/非法 id 拒绝，省略时自动编号不受影响', () => {
  const named = registerTerminal([mkEntry()], { ...base, terminalId: ' spike ' });
  assert.equal(named.ok, true);
  if (!named.ok) return;
  assert.equal(named.entry.terminalId, 'spike', 'requested id wins after trim');
  // 自动编号以最大 term-N 为基准，自定义 id 不挤压后续默认 id
  assert.equal(nextTerminalId(named.entries.map((e) => e.terminalId)), 'term-2');

  const taken = registerTerminal(named.entries, { ...base, terminalId: 'term-1' });
  assert.equal(taken.ok, false);
  if (taken.ok) return;
  assert.match(taken.error, /already used/);

  const stale = registerTerminal([mkEntry({ status: 'closed' })], { ...base, terminalId: 'term-1' });
  assert.equal(stale.ok, false, 'closed ids stay reserved: close/list still address them');

  // 空/纯空白 id 视同未提供（自动编号）；带内部空白或超长的 id 拒绝
  for (const omitted of ['', '   ']) {
    const res = registerTerminal([], { ...base, terminalId: omitted });
    assert.equal(res.ok, true, JSON.stringify(omitted));
    if (res.ok) assert.equal(res.entry.terminalId, 'term-1');
  }
  for (const bad of ['a b', 'x'.repeat(65)]) {
    const res = registerTerminal([], { ...base, terminalId: bad });
    assert.equal(res.ok, false, JSON.stringify(bad));
    if (!res.ok) assert.match(res.error, /invalid terminal_id/);
  }
  assert.equal(registerTerminal([], { ...base, terminalId: null }).ok, true, 'null → auto id');
});

test('validateSendText/validateSignal：拒 ANSI 与控制字符、剥尾部换行；信号白名单原样通过', () => {
  assert.deepEqual(validateSendText('npm run dev'), { ok: true, text: 'npm run dev' }); assert.deepEqual(validateSendText('dir\r\n'), { ok: true, text: 'dir' });
  const esc = validateSendText('echo \x1b[31mred');
  assert.equal(esc.ok, false);
  if (esc.ok) return;
  assert.match(esc.error, /ANSI|escape/i); assert.equal(validateSendText('a\x07b').ok, false);

  for (const k of SIGNAL_KEYS) assert.deepEqual(validateSignal(k), { ok: true, key: k });
  const bad = validateSignal('ctrl+a');
  assert.equal(bad.ok, false);
  if (bad.ok) return;
  assert.match(bad.error, /signal/i);
});

test('detectFullscreenTUI/stripAnsi：识别 alternate screen 序列，去 CSI/OSC 与剩余控制字符', () => {
  assert.equal(detectFullscreenTUI('ok output').detected, false); assert.equal(detectFullscreenTUI('starting\r\n\x1b[?1049h vim').detected, true);
  assert.equal(detectFullscreenTUI('\x1b[?47h old less').detected, true); assert.equal(detectFullscreenTUI('\x1b[2J\x1b[Hclear').detected, true);
  assert.equal(stripAnsi('\x1b[32mgreen\x1b[0m plain'), 'green plain'); assert.equal(stripAnsi('\x1b]0;title\x07tail'), 'tail');
  assert.equal(stripAnsi('a\x00b\x07c'), 'abc');
});

test('computeIncrement：首读 reset；全文相同 none；前缀扩展 append；回卷/清屏 reset；超限截尾', () => {
  const first = computeIncrement(null, { text: 'hello world' }, 1000);
  assert.equal(first.mode, 'reset'); assert.equal(first.text, 'hello world');
  assert.deepEqual(first.cursor, { len: 0, tail: '', textLen: 11, textHash: hashPaneText('hello world') });

  const prev = computeIncrement(null, { text: 'hello\n' }, 1000).cursor;
  assert.equal(computeIncrement(prev, { text: 'hello\n' }, 1000).mode, 'none');
  const app = computeIncrement(prev, { text: 'hello\nworld\n' }, 1000);
  assert.equal(app.mode, 'append'); assert.equal(app.text, 'world\n');

  // the screen buffer rewrites the line-ending \n into a space (observed fixture) — still an append
  const read1 = computeIncrement(null, { text: 'PS F:\\herdr-pi>\n' }, 1000);
  const text2 = 'PS F:\\herdr-pi> echo hi\nhi\nPS F:\\herdr-pi>\n';
  const inc = computeIncrement(read1.cursor, { text: text2 }, 1000);
  assert.equal(inc.mode, 'append'); assert.match(inc.text, /echo hi/);
  assert.equal(computeIncrement(inc.cursor, { text: text2 }, 1000).mode, 'none');

  // a scrolled screen window can keep the same last 64 chars while earlier text changed: not "no new output"
  const stableTail = 'x'.repeat(80) + '\nREADY_0\n';
  const scrolled = computeIncrement(
    computeIncrement(null, { text: `ONE\n${stableTail}` }, 1000).cursor,
    { text: `TWO\n${stableTail}` },
    1000,
  );
  assert.equal(scrolled.mode, 'reset');
  assert.match(scrolled.text, /TWO/);

  // a wrapped/cleared buffer is a reset carrying the truncation marker; oversized output is capped
  const wrapped = computeIncrement({ len: 10, tail: 'xxxxxxxxxx', textLen: 10, textHash: 123 }, { text: 'brand new buffer' }, 1000);
  assert.equal(wrapped.mode, 'reset'); assert.match(wrapped.text, /reset|truncat/i);
  const capped = computeIncrement(null, { text: 'x'.repeat(5000) }, 100);
  assert.ok(capped.text.length <= 200); assert.match(capped.text, /truncat/i);
});

test('foregroundIsShell：空闲 shell 占前台；运行中的任务不算 shell', () => {
  for (const name of ['zsh', '/bin/bash', '-zsh', 'C:\\Windows\\System32\\cmd.exe', 'pwsh', 'nu']) {
    assert.equal(foregroundIsShell({ name }), true, name);
  }
  assert.equal(foregroundIsShell({ name: 'sh', argv: ['-sh'] }), true, 'argv0 fallback');
  assert.equal(foregroundIsShell({ name: 'node', argv: ['/usr/local/bin/node'] }), false);
  assert.equal(foregroundIsShell(null), false, 'no probe is treated as idle, never as a running job');
});

test('promptStrategyFor/planShellInit：env 优先于 $SHELL；未初始化才注入双壳 init', () => {
  const strategies: Array<[NodeJS.ProcessEnv, PromptStrategy, string]> = [
    [{}, POSIX_PROMPT, 'default'],
    [{ PIER_TERMINAL_PROMPT: 'powershell' }, POWERSHELL_PROMPT, 'powershell'],
    [{ PIER_TERMINAL_PROMPT: 'pwsh' }, POWERSHELL_PROMPT, 'pwsh'],
    [{ PIER_TERMINAL_PROMPT: ' zsh ' }, POSIX_PROMPT, 'padded zsh'],
    [{ PIER_TERMINAL_PROMPT: 'bash' }, POSIX_PROMPT, 'bash'],
    [{ SHELL: '/bin/zsh' }, POSIX_PROMPT, 'zsh shell'],
    [{ SHELL: '/bin/bash' }, POSIX_PROMPT, 'bash shell'],
    [{ SHELL: '/usr/bin/pwsh' }, POWERSHELL_PROMPT, 'pwsh shell'],
    [{ SHELL: 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' }, POWERSHELL_PROMPT, 'powershell shell'],
    [{ PIER_TERMINAL_PROMPT: 'powershell', SHELL: '/bin/zsh' }, POWERSHELL_PROMPT, 'explicit configuration beats $SHELL'],
  ];
  for (const [env, expected, label] of strategies) assert.equal(promptStrategyFor(env), expected, label);

  type PlanOpts = { strategy?: PromptStrategy; initialized?: boolean };
  const init: PlanOpts[] = [{}, { strategy: POSIX_PROMPT }];
  const skip: PlanOpts[] = [{ initialized: true }, { strategy: POWERSHELL_PROMPT }];
  // `set +H` alone leaves zsh history expansion on (`echo "E$!"` wedges at dquote>): the init must
  // select zsh's `setopt NO_BANG_HIST` and keep bash's `set +H`.
  assert.match(SHELL_INIT_COMMAND, /ZSH_VERSION/); assert.match(SHELL_INIT_COMMAND, /setopt NO_BANG_HIST/);
  assert.match(SHELL_INIT_COMMAND, /set \+H/);
  for (const opts of init) assert.deepEqual(planShellInit(opts), { shouldInit: true, command: SHELL_INIT_COMMAND }, JSON.stringify(opts));
  for (const opts of skip) assert.deepEqual(planShellInit(opts), { shouldInit: false, command: null }, JSON.stringify(opts));
});

test('detectContinuationPrompt：只认最后一行的次提示符，普通输出里的 > 不误报', () => {
  assert.equal(detectContinuationPrompt('$ echo "E$!\ndquote> '), 'dquote>');
  assert.equal(detectContinuationPrompt('$ cat <<EOF\n> a\nheredoc> '), 'heredoc>');
  for (const token of ['quote', 'bquote', 'cmdand', 'cmdor', 'cmdsubst', 'then', 'for', 'while', 'brace']) {
    assert.equal(detectContinuationPrompt(`noise\n${token}> `), `${token}>`, token);
  }
  assert.equal(detectContinuationPrompt('$ '), null);
  assert.equal(detectContinuationPrompt('done\n$ '), null);
  assert.equal(detectContinuationPrompt('a > b\n$ '), null, 'ordinary redirection output is not a continuation');
});

test('summarizeSessions：stale pane 标 closed；返回跨重启注记', () => {
  const entries = [mkEntry({ terminalId: 'term-1', paneId: 'live-1' }), mkEntry({ terminalId: 'term-2', paneId: 'gone-2' })];
  const s = summarizeSessions(entries, ['live-1']);
  assert.equal(s.terminals.length, 2); assert.equal(s.terminals.find((t) => t.terminalId === 'term-2')?.live, false);
  assert.deepEqual(s.stalePaneIds, ['gone-2']); assert.equal(s.terminals.find((t) => t.terminalId === 'term-1')?.live, true);
});

test('foldTerminalsRegistry：last-wins 往返、nudgedAt 持久化、readTail 恢复（旧 JSONL 向后兼容）', () => {
  const entry = (data: unknown) => ({ type: 'custom', customType: TERMINALS_CUSTOM_TYPE, data });
  const payload = makeTerminalsRegistry([mkEntry({ terminalId: 'term-1' })]);
  assert.equal(foldTerminalsRegistry([entry(payload), entry(makeTerminalsRegistry([]))]).length, 0, 'the later (clearing) entry wins');
  const single = foldTerminalsRegistry([entry(payload)]);
  assert.equal(single.length, 1); assert.equal(single[0].terminalId, 'term-1');
  assert.equal(single[0].cwd, 'F:/work');

  const nudged = foldTerminalsRegistry([entry(makeTerminalsRegistry([
    { ...mkEntry({ terminalId: 'term-1', paneId: 'p1' }), nudges: 2, nudgedAt: 40 },
    mkEntry({ terminalId: 'term-3', paneId: 'p3' })]))]);
  assert.equal(nudged[0]?.nudges, 2, 'the per-terminal nudge count survives the round trip');
  assert.equal(nudged[0]?.nudgedAt, 40, 'the last nudge timestamp survives the round trip');
  assert.equal(nudged[1]?.nudges, 0, 'a never-nudged terminal defaults to zero');
  assert.equal(nudged[1]?.nudgedAt, null);
  // Old JSONL records have nudgedAt but no nudges field: one nudge already delivered.
  const legacyNudge = foldTerminalsRegistry([entry({ version: 1, terminals: [{ paneId: 'p2', terminalId: 'term-2', nudgedAt: 40 }] })]);
  assert.equal(legacyNudge[0]?.nudges, 1, 'a legacy nudgedAt folds to one nudge');

  // A10: a fold that dropped the tail made the next computeIncrement throw on prev.tail.length, so the
  // round trip is exercised with a cursor the real computeIncrement produced.
  const cursor = computeIncrement(null, { text: 'hello\n' }, 1000).cursor;
  const restored = foldTerminalsRegistry([entry({ version: 1, terminals: [
    mkEntry({ readLen: cursor.len, readTail: cursor.tail, readTextLen: cursor.textLen, readTextHash: cursor.textHash })] })])[0]!;
  assert.equal(restored.readTail, cursor.tail); assert.equal(restored.readTextLen, cursor.textLen);
  assert.equal(restored.readTextHash, cursor.textHash);
  const rev = {
    len: restored.readLen ?? 0,
    tail: restored.readTail ?? '',
    textLen: restored.readTextLen ?? 0,
    textHash: restored.readTextHash ?? 0,
  };
  const inc = computeIncrement(rev, { text: 'hello\nworld\n' }, 1000);
  assert.equal(inc.mode, 'append'); assert.equal(inc.text, 'world\n');

  const legacy = foldTerminalsRegistry([entry({ version: 1, terminals: [mkEntry()] })])[0]!;
  assert.equal(legacy.readTail, ''); assert.equal(legacy.readTextLen, 0);
  assert.equal(legacy.initialized, false);
});

test('planTerminalReminder：回合用过 → 首次提醒；再闲置超阈值 → 第二次；每个 terminal 最多两次', () => {
  const term = (id: string, lastActivityAt: number, over: { nudges?: number; nudgedAt?: number | null; busy?: boolean } = {}) =>
    ({ terminalId: id, cwd: `/w/${id}`, label: id, lastActivityAt, ...over });
  const now = 10_000_000;
  const idleMs = terminalIdleMs();
  const turnStartedAt = now - 10_000;

  // used by the run that just settled, never nudged → first notice
  const used = planTerminalReminder({ open: [term('term-1', turnStartedAt + 1)], now, turnStartedAt });
  assert.equal(used.due, true); assert.deepEqual(used.ids, ['term-1']);
  assert.match(used.content ?? '', /used this turn/); assert.match(used.content ?? '', new RegExp(`nudge 1/${TERM_REMINDERS_MAX}`));
  assert.match(used.content!, /do NOT reply to the user and do NOT send any farewell/);

  // already idle past the threshold, never nudged → first notice with the idle reason
  const idle = planTerminalReminder({ open: [term('term-2', now - idleMs - 1)], now, turnStartedAt });
  assert.equal(idle.due, true); assert.deepEqual(idle.ids, ['term-2']);
  assert.match(idle.content ?? '', /idle \d+m/);

  // recent activity, never nudged, not used this turn → nothing (a dev server in use stays out)
  assert.equal(planTerminalReminder({ open: [term('term-3', now - 1000)], now }).due, false);

  // one nudge already delivered: idle again → second notice; still recently used → nothing
  const second = planTerminalReminder({ open: [term('term-1', now - idleMs - 1, { nudges: 1 })], now });
  assert.equal(second.due, true); assert.match(second.content ?? '', /still idle/); assert.match(second.content ?? '', /nudge 2\/2/);
  assert.equal(planTerminalReminder({ open: [term('term-1', now - 1000, { nudges: 1 })], now, turnStartedAt }).due, false);
  // the second notice waits another full idle window after the first one
  const justNudged = term('term-1', now - idleMs - 1, { nudges: 1, nudgedAt: now - 1000 });
  assert.equal(planTerminalReminder({ open: [justNudged], now }).due, false, 'no back-to-back second nudge');
  const waited = term('term-1', now - idleMs - 1, { nudges: 1, nudgedAt: now - idleMs - 1 });
  assert.equal(planTerminalReminder({ open: [waited], now }).due, true);

  // a foreground job keeps even a just-used or long-idle pane out of the notice
  assert.equal(planTerminalReminder({ open: [term('term-5', turnStartedAt + 1, { busy: true })], now, turnStartedAt }).due, false);
  assert.equal(planTerminalReminder({ open: [term('term-5', now - idleMs - 1, { busy: true })], now }).due, false);

  // per-terminal cap: two nudges is silent even when idle or used
  assert.equal(planTerminalReminder({ open: [term('term-1', now - idleMs - 1, { nudges: 2 })], now }).due, false);
  assert.equal(planTerminalReminder({ open: [term('term-1', turnStartedAt + 1, { nudges: 2 })], now, turnStartedAt }).due, false);

  // legacy records (nudgedAt without nudges) count as one nudge
  assert.equal(planTerminalReminder({ open: [term('term-4', now - 1000, { nudgedAt: 1 })], now, turnStartedAt }).due, false);
  const legacy = planTerminalReminder({ open: [term('term-4', now - idleMs - 1, { nudgedAt: 1 })], now });
  assert.equal(legacy.due, true); assert.match(legacy.content ?? '', /nudge 2\/2/);
});

/* ── plugins/terminal.ts wiring ─────────────────────────────────── */

const TOOL_NAME = 'terminal';
const TERMINAL_ID = 't2';

interface ToolResult { content: Array<{ text: string }>; details: Record<string, unknown> }

const run = (pi: FakePi, params: Record<string, unknown>, toolCtx?: unknown): Promise<ToolResult> =>
  pi.tools.get(TOOL_NAME)!.execute!(null, params, undefined, undefined, toolCtx) as Promise<ToolResult>;

/** Drains pending immediates/microtasks so an async fire-and-forget delivery lands. */
function nextTick(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
}

interface MountedTerminal {
  pi: FakePi;
  deps: { env: unknown; state: { activePaneIds: () => Set<string> } };
  ledger: DisposeLedger;
  client: CoreClientLike;
  calls: {
    run: Array<{ cwd?: string; argv?: readonly string[]; env?: Record<string, string>; labels?: Record<string, string>; noNotify?: boolean }>;
    send: Array<{ id: string; text: string }>;
    keys: Array<{ id: string; keys: readonly string[] }>;
    interrupt: string[];
    read: Array<{ id: string; lines?: number }>;
    waitForOutput: Array<{ id: string; text: string; timeoutMs: number }>;
    kill: string[];
    remove: string[];
  };
}

/** Mounts plugins/terminal.ts through a real cordis Context + PiSurface over fakeCore, optionally
 *  running `action: open` first; returns the recorded client calls the assertions need. */
async function mountTerminal(t: TestContext, opts: { client?: Partial<CoreClientLike>; open?: boolean } = {}): Promise<MountedTerminal> {
  const calls: MountedTerminal['calls'] = {
    run: [], send: [], keys: [], interrupt: [], read: [], waitForOutput: [], kill: [], remove: [],
  };
  const client = fakeCore({
    run: async (options) => {
      calls.run.push(options);
      return terminalInfo({ id: TERMINAL_ID, cwd: options.cwd ?? '/test/cwd', labels: { ...options.labels } });
    },
    waitForOutput: async (id, text, timeoutMs) => { calls.waitForOutput.push({ id, text, timeoutMs }); return { matched: true }; },
    read: async (id, options) => { calls.read.push({ id, lines: options?.lines }); return { text: '$ ', complete: true }; },
    send: async (id, text) => { calls.send.push({ id, text }); },
    keys: async (id, keys) => { calls.keys.push({ id, keys }); },
    interrupt: async (id) => { calls.interrupt.push(id); return 'stopped'; },
    kill: async (id) => { calls.kill.push(id); },
    remove: async (id) => { calls.remove.push(id); },
    listTerminals: async () => [terminalInfo({ id: TERMINAL_ID, title: 'npm run dev', labels: { 'herdr.tab': 'tb0' } })],
    ...opts.client,
  });
  const pi = fakePi();
  const ledger = new DisposeLedger();
  const deps = {
    client,
    env: { socketPath: '/tmp/hc.sock', terminalId: 't1' },
    state: { activePaneIds: (): Set<string> => new Set() },
  };
  const ctx = new Context();
  cordisProvide(ctx, 'pi-herdr.surface', new PiSurface(pi as unknown as object, ledger));
  cordisProvide(ctx, 'pi-herdr.terminal-deps', deps);
  await ctx.plugin(terminalPlugin);
  t.after(() => ctx.fiber.dispose());
  if (opts.open) await run(pi, { action: 'open' }, { cwd: 'F:/w' });
  return { pi, deps, ledger, client, calls };
}

test('plugins/terminal：工具挂载（snippet/guidelines、open/list/GC、core title、未知动作）', async (t) => {
  const { pi, deps, calls } = await mountTerminal(t);
  assert.ok(pi.tools.has(TOOL_NAME), 'terminal should register'); assert.ok(!pi.tools.has('terminal_open'), 'the old split tool names must not register');
  assert.equal(deps.state.activePaneIds().size, 0, 'no terminals yet');

  const open = await run(pi, { action: 'open' }, { cwd: 'F:/w' });
  assert.match(open.content[0].text, /terminal term-1 open \(pane t2\)/);
  assert.equal(open.details.pane_id, TERMINAL_ID);
  assert.deepEqual(calls.send.map((c) => c.text), [SHELL_INIT_COMMAND], 'open sends the bash/zsh history-expansion init through core send');
  const launched = calls.run.at(-1)!;
  assert.equal(launched.cwd, 'F:/w');
  assert.equal(launched.argv, undefined, 'no argv = the machine shell');
  assert.equal(launched.noNotify, true, 'D45: core must not paste notes into the pi terminal');
  assert.deepEqual(launched.labels, { 'herdr.space': 'sp0', 'herdr.tab': 'tb0' }, 'the child lands in this terminal\'s app tab');
  assert.ok(launched.env, 'the caller environment is passed explicitly');
  assert.ok(deps.state.activePaneIds().has(TERMINAL_ID), 'GC slot: an active terminal pane is visible');
  assert.ok(pi.entries.some(([type]) => type === TERMINALS_CUSTOM_TYPE), 'the registry was appended');

  const list = await run(pi, { action: 'list' });
  assert.match(list.content[0].text, /term-1 \[open\] pane=t2/);
  assert.match(list.content[0].text, /title="npm run dev"/, 'the core terminal title shows in the listing');
  await assert.rejects(async () => { await run(pi, { action: 'explode' }); }, /unknown action "explode"/);
});

test('plugins/terminal：wait/send/read 的动作契约（超时尾部、regex 轮询、pane 作用域）', async (t) => {
  const { pi, client, calls } = await mountTerminal(t, { open: true });

  // Substring waits go straight to core; core only reports output printed after the wait starts.
  const hit = await run(pi, { action: 'wait', terminal_id: 'term-1', pattern: 'TERM_DONE_', timeout_ms: 5000 });
  assert.equal(hit.details.matched, true, 'a hit → matched');
  assert.deepEqual(calls.waitForOutput.at(-1), { id: TERMINAL_ID, text: 'TERM_DONE_', timeoutMs: 5000 });

  // A regex wait has no core RPC: it polls read() and must not enter waitForOutput.
  const waitsBeforeRegex = calls.waitForOutput.length;
  client.read = async () => ({ text: 'bug=19820 terminal_result=ok\n$ ', complete: true });
  const regexHit = await run(pi, { action: 'wait', terminal_id: 'term-1', pattern: 'terminal_result=[a-z]+', regex: true, timeout_ms: 3000 });
  assert.equal(regexHit.details.matched, true);
  assert.match(regexHit.content[0].text, /terminal_result=ok/);
  assert.equal(calls.waitForOutput.length, waitsBeforeRegex, 'a regex wait never asks core for a regex');

  // A pattern already returned by read is stale: polling keeps going until the deadline, then says so.
  await run(pi, { action: 'read', terminal_id: 'term-1' });
  const stale = await run(pi, { action: 'wait', terminal_id: 'term-1', pattern: 'terminal_result=', regex: true, timeout_ms: 1000 });
  assert.equal(stale.details.matched, false);
  assert.equal(stale.details.stale, true);
  assert.match(stale.content[0].text, /already-read output/);

  // New output after the cursor is fresh.
  client.read = async () => ({ text: 'bug=19820 terminal_result=ok\nsubmitted bug=19816\n$ ', complete: true });
  const freshWait = await run(pi, { action: 'wait', terminal_id: 'term-1', pattern: 'submitted bug=19816', regex: true, timeout_ms: 2000 });
  assert.equal(freshWait.details.matched, true);
  assert.match(freshWait.content[0].text, /submitted bug=19816/);

  client.waitForOutput = async (id, text, timeoutMs) => {
    calls.waitForOutput.push({ id, text, timeoutMs });
    return { matched: false, reason: 'timeout' };
  };
  client.read = async () => ({ text: 'still compiling src/main.rs', complete: true });
  const miss = await run(pi, { action: 'wait', terminal_id: 'term-1', pattern: 'never-appears', timeout_ms: 5000 });
  assert.equal(miss.details.matched, false); assert.match(miss.content[0].text, /no match within 5000ms \(timeout\)/);
  assert.match(miss.content[0].text, /recent output tail/, 'a timeout returns the recent tail, so no blind re-polling');
  assert.deepEqual(calls.waitForOutput.at(-1), { id: TERMINAL_ID, text: 'never-appears', timeoutMs: 5000 });

  // an RPC that is unavailable reports its own reason; an invalid regex is a hard failure (A1)
  client.waitForOutput = async () => ({ matched: false, reason: 'unavailable' });
  const unavail = await run(pi, { action: 'wait', terminal_id: 'term-1', pattern: 'never-appears', timeout_ms: 3000 });
  assert.equal(unavail.details.matched, false); assert.match(unavail.content[0].text, /no match within 3000ms \(wait unavailable\)/);
  await assert.rejects(async () => { await run(pi, { action: 'wait', terminal_id: 'term-1', pattern: '(', regex: true }); }, /invalid regex/);

  // send: blocked targets refuse with a tool error and nothing is queued
  client.send = async () => { throw new CoreError('terminal.send', 'blocked', 'question: waiting for input', null); };
  await assert.rejects(
    async () => { await run(pi, { action: 'send', terminal_id: 'term-1', text: 'echo next' }); },
    /is blocked .*text was NOT sent/s,
  );

  client.send = async (id, text) => { calls.send.push({ id, text }); };
  const sent = await run(pi, { action: 'send', terminal_id: 'term-1', text: 'echo next' });
  assert.match(sent.content[0].text, /sent to term-1/);

  // ctrl+c is the interrupt action; every other key goes through core keys
  const interrupted = await run(pi, { action: 'signal', terminal_id: 'term-1', key: 'ctrl+c' });
  assert.equal(interrupted.details.outcome, 'stopped');
  assert.deepEqual(calls.interrupt, [TERMINAL_ID]);
  await run(pi, { action: 'signal', terminal_id: 'term-1', key: 'ctrl+d' });
  assert.deepEqual(calls.keys.at(-1), { id: TERMINAL_ID, keys: ['ctrl+d'] });

});

test('plugins/terminal：消耗完预算的 unavailable 等待按 timeout 报告', (t) => withCleanup(async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const { pi, client } = await mountTerminal(t, { open: true });
    client.waitForOutput = async () => {
      mock.timers.tick(2900); // ≥ 95% of the 3000 ms budget
      return { matched: false, reason: 'unavailable' };
    };
    const res = await run(pi, { action: 'wait', terminal_id: 'term-1', pattern: 'never-appears', timeout_ms: 3000 });
    assert.equal(res.details.reason, 'timeout');
    assert.match(res.content[0].text, /\(timeout\)/);
  } finally {
    mock.timers.reset();
  }
})());

test('redirectedSentinel: a `$?` sentinel appended to a log is found with its file; pane sentinels are not', () => {
  assert.deepEqual(redirectedSentinel('python3 run.py > /tmp/mix6-run.log 2>&1; echo RUN_EXIT_$? >> /tmp/mix6-run.log'), { prefix: 'RUN_EXIT_', file: '/tmp/mix6-run.log' });
  assert.deepEqual(redirectedSentinel(`make; echo "DONE_$?" > 'build.log'`), { prefix: 'DONE_', file: 'build.log' });
  assert.equal(redirectedSentinel('make; echo DONE_$?'), null, 'a sentinel printed to the pane needs no file wait');
  assert.equal(redirectedSentinel('echo hello > out.txt'), null, 'no `$?` sentinel, no hint');
});

test('plugins/terminal：wait file: polls the log for a later match, reports an old one, and times out on a missing file', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pier-file-wait-'));
  const log = join(dir, 'run.log');
  writeFileSync(log, 'starting\n');
  const { pi, calls } = await mountTerminal(t, { open: true });
  const sendText = `python3 run.py > ${log} 2>&1; echo RUN_EXIT_$? >> ${log}`;
  const sent = await run(pi, { action: 'send', terminal_id: 'term-1', text: sendText });
  // Literal check: a Windows temp path's backslashes are regex escapes.
  assert.ok(sent.content[0].text.includes(`wait for it with terminal(action: "wait", terminal_id: "term-1", file: "${log}", pattern: "^RUN_EXIT_[0-9]"`), sent.content[0].text);
  calls.waitForOutput.length = 0;

  // Real clock on purpose: the wait polls real file I/O, which mocked timers cannot sequence; the
  // append lands between the first and second ~1 s poll ticks.
  setTimeout(() => appendFileSync(log, 'step 1\nRUN_EXIT_0\n'), 300);
  const later = await run(pi, { action: 'wait', terminal_id: 'term-1', file: log, pattern: '^RUN_EXIT_[0-9]', regex: true, timeout_ms: 5000 });
  assert.equal(later.details.matched, true);
  assert.equal(later.details.alreadyPresent, false);
  assert.match(later.content[0].text, /appeared after \d+s:\n[\s\S]*RUN_EXIT_0/);
  assert.equal(calls.waitForOutput.length, 0, 'a file wait never asks core to watch the terminal');
  assert.equal(calls.send.at(-1)?.text, sendText);

  const old = await run(pi, { action: 'wait', terminal_id: 'term-1', file: log, pattern: 'RUN_EXIT_', timeout_ms: 5000 });
  assert.equal(old.details.alreadyPresent, true, 'the echo guard does not apply: files hold no typed echo');
  assert.match(old.content[0].text, /already present when the wait started/);

  const missing = await run(pi, { action: 'wait', terminal_id: 'term-1', file: join(dir, 'never.log'), pattern: 'x', timeout_ms: 1000 });
  assert.equal(missing.details.matched, false);
  assert.match(missing.content[0].text, /no match in .*never\.log within 1000ms \(timeout\)\.\n.*does not exist/);
});

test('wait 哨兵自匹配：命中自己回显的 pattern 直接拒绝，可区分的 sentinel 照常等待', async (t) => {
  // 纯函数：literal/regex 是否会命中发送文本本身
  const sent = 'for r in 1 2 3; do pi -p "$(cat in_$r.txt)" > out_$r.json; done; echo G3FP_ALL_DONE';
  assert.equal(sentinelEchoHazard({ pattern: 'G3FP_ALL_DONE', lastSentText: sent }), true, 'literal sentinel ⊆ echo');
  assert.equal(sentinelEchoHazard({ pattern: 'G3FP_ALL_DONE', regex: true, lastSentText: sent }), true, 'regex 不锚定也会命中 echo');
  assert.equal(sentinelEchoHazard({ pattern: '^G3FP_ALL_DONE', regex: true, lastSentText: sent }), false, '行首锚定不命中 `echo G3FP…` 回显');
  assert.equal(sentinelEchoHazard({ pattern: 'BUILD SUCCESS', lastSentText: sent }), false, '与命令无关的 pattern 无风险');
  assert.equal(sentinelEchoHazard({ pattern: 'x', lastSentText: null }), false, '本进程没发送过 → 无法判定，放行');

  // 契约：发送过含哨兵的命令后，wait 该哨兵必须拒绝且不发起 core 等待
  const { pi, client, calls } = await mountTerminal(t, { open: true });
  calls.waitForOutput.length = 0;
  await run(pi, { action: 'send', terminal_id: 'term-1', text: sent });
  await assert.rejects(
    async () => { await run(pi, { action: 'wait', terminal_id: 'term-1', pattern: 'G3FP_ALL_DONE', timeout_ms: 5000 }); },
    /matches its own echo|also appears in the command text/,
  );
  await assert.rejects(
    async () => { await run(pi, { action: 'wait', terminal_id: 'term-1', pattern: 'G3FP_ALL_DONE', timeout_ms: 5000 }); },
    /do NOT re-send/,
  );
  assert.equal(calls.waitForOutput.length, 0, 'an echo self-match never reaches core');

  // 可区分的 pattern（锚定正则）照常等待：core 无 regex 等待，走 read 轮询
  client.read = async () => ({ text: 'G3FP_ALL_DONE\n$ ', complete: true });
  const hit = await run(pi, { action: 'wait', terminal_id: 'term-1', pattern: '^G3FP_ALL_DONE', regex: true, timeout_ms: 5000 });
  assert.equal(hit.details.matched, true);
  assert.equal(calls.waitForOutput.length, 0, 'a regex wait is read-polled, not sent to core');
  assert.ok(calls.read.length > 0);

  // close 清掉发送记录后，同 pattern 的 wait 不再被拒（终端已关闭则按未知终端报错）
  await run(pi, { action: 'close', terminal_id: 'term-1' });
  assert.deepEqual(calls.kill, [TERMINAL_ID], 'close kills the terminal');
  assert.deepEqual(calls.remove, [TERMINAL_ID], 'close removes the finished terminal record');
  await assert.rejects(
    async () => { await run(pi, { action: 'wait', terminal_id: 'term-1', pattern: 'G3FP_ALL_DONE' }); },
    /unknown or closed terminal/,
  );
});

test('classifyWaitMatch: a pattern only in already-read text is stale; new text is fresh', () => {
  const first = computeIncrement(null, { text: 'bug=19820 terminal_result=ok\n' }, 10_000);
  assert.equal(classifyWaitMatch(first.cursor, 'bug=19820 terminal_result=ok\n', 'terminal_result=', false).kind, 'stale');
  const grown = 'bug=19820 terminal_result=ok\nsubmitted bug=19816\n';
  const fresh = classifyWaitMatch(first.cursor, grown, 'submitted bug=19816', false);
  assert.equal(fresh.kind, 'fresh');
  if (fresh.kind === 'fresh') assert.match(fresh.excerpt, /submitted bug=19816/);
  assert.equal(classifyWaitMatch(null, '$ ', 'TERM_DONE_', false).kind, 'absent');
});

test('classifyWaitMatch: line anchors match mid-buffer, so the documented ^SENTINEL_[0-9] form works', () => {
  // An anchored pattern must bind to line starts, not only index 0 of the whole pane buffer.
  assert.equal(compilePattern('^STEP2_[0-9]').test('x\nSTEP2_0'), true);
  const prev = computeIncrement(null, { text: 'boot\nSTEP2_9\n$ ' }, 10_000);
  const pane = 'boot\nSTEP2_9\n$ \nrunning\nSTEP2_0\n$ ';
  const hit = classifyWaitMatch(prev.cursor, pane, '^STEP2_[0-9]', true);
  assert.equal(hit.kind, 'fresh');
  if (hit.kind === 'fresh') assert.match(hit.excerpt, /STEP2_0/);
  // A consumed anchored sentinel is stale, not absent: without the flag the stale guard was unreachable.
  assert.equal(classifyWaitMatch(prev.cursor, 'boot\nSTEP2_9\n$ ', '^STEP2_[0-9]', true).kind, 'stale');
});

test('open 采纳请求的 terminal_id：open/send 用同名 id 直达，不再静默改号', async (t) => {
  const { pi } = await mountTerminal(t);
  const open = await run(pi, { action: 'open', cwd: '/tmp/spike', terminal_id: 'spike' });
  assert.match(open.content[0].text, /terminal spike open/);
  assert.equal(open.details.terminal_id, 'spike');
  const sent = await run(pi, { action: 'send', terminal_id: 'spike', text: 'echo hi' });
  assert.match(sent.content[0].text, /sent to spike/);
  // 占用过的 id 再开 → 明确报错而不是静默换号
  await assert.rejects(
    async () => { await run(pi, { action: 'open', terminal_id: 'spike' }, { cwd: '/tmp/spike' }); },
    /already used/,
  );
  // 未请求 id 时保持原自动编号行为
  const auto = await run(pi, { action: 'open' }, { cwd: '/tmp/spike' });
  assert.match(auto.content[0].text, /terminal term-1 open/);
});

test('plugins/terminal：init 失败不标记 initialized；shell 停在 dquote> 时 send 报“等待输入”', async (t) => {
  let initAttempts = 0;
  const sent: string[] = [];
  const { pi, client } = await mountTerminal(t, {
    client: {
      send: async (_id, text) => {
        if (text === SHELL_INIT_COMMAND) {
          initAttempts += 1;
          if (initAttempts <= 2) throw new Error('shell not ready');
        }
        sent.push(text);
      },
      read: async () => ({ text: '$ ', complete: true }),
    },
  });
  const registry = () => pi.entries.filter(([type]) => type === TERMINALS_CUSTOM_TYPE).at(-1)?.[1] as
    { terminals: Array<{ initialized?: boolean }> } | undefined;

  await run(pi, { action: 'open' }, { cwd: '/tmp' });
  assert.ok(!registry()?.terminals[0]?.initialized, 'a failed open-time init is not marked initialized');

  // The first send retries (and again fails) init: the entry must stay retryable, while the command still goes out.
  await run(pi, { action: 'send', terminal_id: 'term-1', text: 'echo one' });
  assert.ok(!registry()?.terminals[0]?.initialized, 'a failed send-time init must not consume the retry');
  await run(pi, { action: 'send', terminal_id: 'term-1', text: 'echo two' });
  assert.deepEqual(sent, ['echo one', SHELL_INIT_COMMAND, 'echo two'], 'the next send retries init once it succeeds');
  assert.equal(registry()?.terminals[0]?.initialized, true);

  // An incomplete command wedges zsh at a secondary prompt; a bare "sent" success would hide it.
  client.read = async () => ({ text: '$ echo "E$!\ndquote> ', complete: true });
  await assert.rejects(
    async () => { await run(pi, { action: 'send', terminal_id: 'term-1', text: 'echo more' }); },
    /waiting for more input/,
  );
  await assert.rejects(
    async () => { await run(pi, { action: 'send', terminal_id: 'term-1', text: 'echo more' }); },
    /dquote>/,
  );
});

test('plugins/terminal：read 不因尾部相同而漏掉滚动后的新输出', async (t) => {
  const { pi, client } = await mountTerminal(t, { open: true });
  const tail = 'x'.repeat(80) + '\nREADY_0\n';
  client.read = async () => ({ text: `ONE\n${tail}`, complete: true });
  const first = await run(pi, { action: 'read', terminal_id: 'term-1' });
  assert.match(first.content[0].text, /ONE/);
  client.read = async () => ({ text: `TWO\n${tail}`, complete: true });
  const second = await run(pi, { action: 'read', terminal_id: 'term-1' });
  assert.notEqual(second.content[0].text, 'no new output', 'the last 64 chars match but earlier text changed');
  assert.match(second.content[0].text, /TWO/);
});

test('plugins/terminal：core incomplete read 仍返回文本，complete 只作 detail', async (t) => {
  const { pi, client } = await mountTerminal(t, { open: true });
  client.read = async () => ({ text: 'partial screen', complete: false });
  const res = await run(pi, { action: 'read', terminal_id: 'term-1' });
  assert.equal(res.details.error, undefined, 'an incomplete history read is not a fullscreen claim');
  assert.equal(res.details.complete, false);
  assert.match(res.content[0].text, /partial screen/);
});

test('wait 回显前缀：regex 的静态前缀命中命令回显即拒绝，并建议具体的锚定 pattern', async (t) => {
  assert.equal(regexLiteralPrefix('^APN_BUILD2_EXIT_[0-9]'), 'APN_BUILD2_EXIT_');
  assert.equal(regexLiteralPrefix('apn\\.[0-9]'), 'apn.');
  assert.equal(echoSafeWaitSuggestion('APN_BUILD2_EXIT_'), '^APN_BUILD2_EXIT_[0-9]');
  assert.equal(echoSafeWaitSuggestion('APN_BUILD2_EXIT_0'), '^APN_BUILD2_EXIT_[0-9]');
  assert.equal(sentinelEchoHazard({
    pattern: 'APN_BUILD2_EXIT_[0-9]', regex: true, lastSentText: 'run; echo APN_BUILD2_EXIT_$?',
  }), true, 'the literal prefix is in the echo even though `$?` breaks the full regex');
  assert.equal(sentinelEchoHazard({
    pattern: '^APN_BUILD2_EXIT_[0-9]', regex: true, lastSentText: 'run; echo APN_BUILD2_EXIT_$?',
  }), false, 'the derived anchored pattern is safe against its echo');

  const { pi } = await mountTerminal(t, { open: true });
  await run(pi, { action: 'send', terminal_id: 'term-1', text: 'run; echo APN_BUILD2_EXIT_$?' });
  await assert.rejects(
    async () => {
      await run(pi, { action: 'wait', terminal_id: 'term-1', pattern: 'APN_BUILD2_EXIT_0', regex: true, timeout_ms: 5000 });
    },
    /\^APN_BUILD2_EXIT_\[0-9\]/,
  );
});

test('plugins/terminal：前台有任务时不催——dev server 刚启动不会白白消耗 nudge 1', (t) => withCleanup(async (cleanup) => {
  const env = cleanup.env();
  env.set('PI_HERDR_TERM_IDLE_MS', '1');
  env.set('PI_HERDR_TERM_GRACE_MS', '5');
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const { pi, client } = await mountTerminal(t, { open: true });
    client.getTerminal = async () => terminalInfo({
      id: TERMINAL_ID,
      foreground: { pid: 200, name: 'node', argv: ['node'], cwd: '/w' },
    });
    await fire(pi, 'agent_start');
    mock.timers.tick(50);
    await fire(pi, 'agent_settled');
    mock.timers.tick(5);
    await nextTick();
    assert.equal(pi.sent.length, 0, 'a pane running a foreground job is not nudged');

    // The job exits, the shell is back at its prompt: the idle threshold catches the pane.
    client.getTerminal = async () => terminalInfo({
      id: TERMINAL_ID,
      foreground: { pid: 100, name: 'zsh', argv: ['-zsh'], cwd: '/w' },
    });
    mock.timers.tick(50);
    await fire(pi, 'agent_settled');
    mock.timers.tick(5);
    await nextTick();
    assert.equal(pi.sent.length, 1);
    assert.match(String(pi.sent[0]?.msg.content), /idle \d+m/);
  } finally {
    mock.timers.reset();
  }
})());

test('plugins/terminal：会话生命周期——shutdown 关停全部 open 终端，ledger 墓碑让工具 inert', async (t) => {
  const { pi, deps, ledger, calls } = await mountTerminal(t, { open: true });
  assert.ok(deps.state.activePaneIds().has(TERMINAL_ID), 'precondition: the pane is registered');
  assert.ok((pi.listeners.get('session_shutdown')?.length ?? 0) >= 1, 'a shutdown handler is registered');

  await fire(pi, 'session_shutdown');
  assert.deepEqual(calls.kill, [TERMINAL_ID], 'the resident shell is killed');
  assert.deepEqual(calls.remove, [TERMINAL_ID], 'the finishable terminal record is removed');
  assert.equal(deps.state.activePaneIds().size, 0, 'the GC slot no longer protects a closed pane');
  const registry = pi.entries.filter(([type]) => type === TERMINALS_CUSTOM_TYPE).at(-1)?.[1] as { terminals: Array<{ status: string; closedAt: number | null }> };
  assert.equal(registry.terminals[0].status, 'closed', 'the ledger records closed'); assert.ok(registry.terminals[0].closedAt != null);

  // hmr/reload reports the plugin file path — the normalized ledger matches the module key
  const key = new URL('../src/plugins/terminal.ts', import.meta.url).href;
  assert.equal(ledger.disposeKey(key), 1, 'the ledger matched the terminal module registration');
  const tombstoned = await run(pi, { action: 'list' });
  assert.match(tombstoned.content[0].text, /disposed/, 'the tool is inert after the tombstone');
});

test('plugins/terminal：agent_settled 催办——本回合用过先催一次，闲置超阈值再催一次（每个 terminal 上限两次）', (t) => withCleanup(async (cleanup) => {
  // Which terminals are due, and the nudge content itself, is the planner's contract
  // (planTerminalReminder). This test covers the delivery: a queued followUp that never wakes the
  // agent, the persisted per-terminal count, and the cap.
  const env = cleanup.env();
  env.set('PI_HERDR_TERM_IDLE_MS', '1');
  env.set('PI_HERDR_TERM_GRACE_MS', '5');
  // Mock Date as well: the tick creates an exact idle duration, so no real-clock millisecond race.
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const { pi, deps } = await mountTerminal(t, { open: true });
    await fire(pi, 'agent_start'); // mark the terminal as used by this run
    const settle = async () => {
      mock.timers.tick(50); // produce an idle duration above the threshold
      await fire(pi, 'agent_settled');
      mock.timers.tick(5); // the grace window elapses
      await nextTick(); // drain the async delivery
    };

    await settle();
    assert.equal(pi.sent.length, 1, 'first nudge for the terminal used this turn');
    assert.equal(pi.sent[0]?.msg.customType, TERM_REMINDER_CUSTOM_TYPE);
    assert.equal(pi.sent[0]?.opts?.deliverAs, 'followUp'); assert.equal(pi.sent[0]?.opts?.triggerTurn, undefined, 'a reminder must never wake the agent (goodbye loop)');
    assert.match(String(pi.sent[0]?.msg.content), /used this turn/);
    const nudged = pi.entries.filter(([type]) => type === TERMINALS_CUSTOM_TYPE).at(-1)?.[1] as { terminals: Array<{ nudges: number; nudgedAt: number | null }> };
    assert.equal(nudged.terminals[0]!.nudges, 1, 'the first nudge is persisted before the notice is delivered');
    assert.ok(nudged.terminals[0]!.nudgedAt != null);

    await settle();
    assert.equal(pi.sent.length, 2, 'a second nudge after the idle threshold');
    assert.match(String(pi.sent[1]?.msg.content), /still idle \d+m/);
    const twice = pi.entries.filter(([type]) => type === TERMINALS_CUSTOM_TYPE).at(-1)?.[1] as { terminals: Array<{ nudges: number }> };
    assert.equal(twice.terminals[0]!.nudges, 2);

    await settle();
    assert.equal(pi.sent.length, 2, 'the per-terminal cap stops further nudges — no farewell loop');
    assert.deepEqual([...deps.state.activePaneIds()], [TERMINAL_ID], 'a nudge only reminds, it never closes panes');
  } finally {
    mock.timers.reset();
  }
})());

test('plugins/terminal：nudge 在投递时计数——agent_start 取消宽限定时器不消耗次数', (t) => withCleanup(async (cleanup) => {
  const env = cleanup.env();
  env.set('PI_HERDR_TERM_IDLE_MS', '1');
  env.set('PI_HERDR_TERM_GRACE_MS', '5');
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const { pi } = await mountTerminal(t, { open: true });
    const registry = () => pi.entries.filter(([type]) => type === TERMINALS_CUSTOM_TYPE).at(-1)?.[1] as
      { terminals: Array<{ nudges: number }> } | undefined;
    const nudges = () => registry()?.terminals[0]?.nudges ?? -1;

    await fire(pi, 'agent_start');
    mock.timers.tick(50);
    await fire(pi, 'agent_settled'); // due → grace timer scheduled
    assert.equal(nudges(), 0, 'scheduling a reminder is not delivering it');

    await fire(pi, 'agent_start'); // a new turn cancels the pending reminder
    mock.timers.tick(10);
    await nextTick();
    assert.equal(pi.sent.length, 0, 'a cancelled reminder is never sent');
    assert.equal(nudges(), 0, 'a cancelled reminder must not consume one of the two nudges');

    mock.timers.tick(50);
    await fire(pi, 'agent_settled');
    mock.timers.tick(5);
    await nextTick();
    assert.equal(pi.sent.length, 1, 'the next settle delivers the reminder');
    assert.equal(nudges(), 1, 'the count advances when the notice is actually delivered');
  } finally {
    mock.timers.reset();
  }
})());

test('withExitSentinel: joins with `;` only where that cannot break the command', () => {
  const posix = (text: string) => withExitSentinel(text, 'n1', POSIX_PROMPT);
  assert.equal(posix('make test;  '), `make test; printf '\\n__PIER_n1_%s__\\n' "$?"`, 'trailing separators are dropped');
  for (const text of ['echo a # note', 'npm run dev &', 'echo a\necho b']) {
    assert.match(posix(text), /\nprintf '\\n__PIER_n1_%s__\\n' "\$\?"$/, `${JSON.stringify(text)}: sentinel on its own line`);
  }
  assert.match(posix('a && b'), /^a && b; printf/, '`&&` is not a background job');
  assert.match(withExitSentinel('dotnet build', 'n1', POWERSHELL_PROMPT), /^dotnet build; "`n__PIER_n1_\$\(if \(\$\?\)/);
});

test('parseExitSentinel: exit code and output come from the printed line, never the typed echo', () => {
  const nonce = 'ab12cd34';
  const echo = `% echo hi; printf '\\n__PIER_${nonce}_%s__\\n' "$?"`;
  assert.equal(parseExitSentinel(`${echo}\nhi\n`, nonce), null, 'the echo alone is not a finished run');
  assert.deepEqual(parseExitSentinel(`${echo}\nhi\nerr line\n\n__PIER_${nonce}_2__\n% `, nonce), { exitCode: 2, output: 'hi\nerr line' });
  assert.deepEqual(parseExitSentinel(`__PIER_${nonce}___`, nonce), { exitCode: null, output: '' }, 'PowerShell without an exit code');
  assert.equal(parseExitSentinel(`__PIER_other_0__`, nonce), null, 'another run\'s sentinel does not count');
});
