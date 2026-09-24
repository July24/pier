/** Terminal domain: the pure terminal-core planners (registry/validation/ANSI/increments/readiness/
 *  summarization/folding/idle nudge) + plugins/terminal.ts wiring through a real Context + PiSurface. */
import { test, mock, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import terminalPlugin from '../src/plugins/terminal.ts';
import {
  MAX_TERMINALS, POSIX_PROMPT, POWERSHELL_PROMPT, PROMPT_TAIL_RE, SIGNAL_KEYS, TERMINALS_CUSTOM_TYPE, TERM_REMINDERS_MAX,
  TERM_REMINDER_CUSTOM_TYPE, classifyReadiness, closeTerminal, computeIncrement, detectFullscreenTUI, foldTerminalsRegistry,
  makeTerminalsRegistry, nextTerminalId, planIdleTerminalReminder, planShellInit, promptStrategyFor, registerTerminal,
  classifyWaitMatch, sentinelEchoHazard, stripAnsi, summarizeSessions, terminalIdleMs, validateSendText, validateSignal,
  type PromptStrategy, type ReadinessTier, type TerminalEntry,
} from '../src/terminal-core.ts';
import { PiSurface } from '../src/pi-surface.ts';
import { DisposeLedger } from '../src/ledger.ts';
import type { HerdrClientLike } from '../src/herdr-client.ts';
import { fakeHerdr, fakePi, fire, withCleanup, type FakePi } from './test-utils.ts';

const base = { paneId: 'pane-a', tabId: 'tab-1', cwd: 'F:/work', label: 'dev server', createdAt: 1000, lastActivityAt: 1000 };

const mkEntry = (over: Partial<TerminalEntry> = {}): TerminalEntry => ({
  terminalId: 'term-1', status: 'open', closedAt: null, readRevision: null, readLen: 0, readTail: '', readEoTail: '', ...base, ...over,
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

test('computeIncrement：首读 reset；无新输出 none；前缀扩展 append；回卷/清屏 reset；超限截尾', () => {
  const first = computeIncrement(null, { text: 'hello world', revision: 3 }, 1000);
  assert.equal(first.mode, 'reset'); assert.equal(first.text, 'hello world');
  assert.deepEqual(first.cursor, { revision: 3, len: 0, tail: '', eoTail: 'hello world' });

  // revision is not a change detector (herdr's screen buffer reports a constant 0): the text decides
  const prev = { revision: 3, len: 5, tail: 'hello', eoTail: 'hello' };
  assert.equal(computeIncrement(prev, { text: 'hello', revision: 99 }, 1000).mode, 'none');
  const app = computeIncrement(prev, { text: 'hello world', revision: 4 }, 1000);
  assert.equal(app.mode, 'append'); assert.equal(app.text, ' world');

  // the screen buffer rewrites the line-ending \n into a space (observed fixture) — still an append
  const read1 = computeIncrement(null, { text: 'PS F:\\herdr-pi>\n', revision: 0 }, 1000);
  const text2 = 'PS F:\\herdr-pi> echo hi\nhi\nPS F:\\herdr-pi>\n';
  const inc = computeIncrement(read1.cursor, { text: text2, revision: 0 }, 1000);
  assert.equal(inc.mode, 'append'); assert.match(inc.text, /echo hi/);
  assert.equal(computeIncrement(inc.cursor, { text: text2, revision: 0 }, 1000).mode, 'none');

  // a wrapped/cleared buffer is a reset carrying the truncation marker; oversized output is capped
  const wrapped = computeIncrement({ revision: 3, len: 10, tail: 'xxxxxxxxxx', eoTail: 'xxxxxxxxxx' }, { text: 'brand new buffer', revision: 4 }, 1000);
  assert.equal(wrapped.mode, 'reset'); assert.match(wrapped.text, /reset|truncat/i);
  const capped = computeIncrement(null, { text: 'x'.repeat(5000), revision: 9 }, 100);
  assert.ok(capped.text.length <= 200); assert.match(capped.text, /truncat/i);
});

test('classifyReadiness/PROMPT_TAIL_RE：PS1 尾匹配 → prompt；静默期 → silent；否则 busy', () => {
  assert.equal(classifyReadiness('PS F:\\work> ', { silentMs: 100 }), 'prompt'); assert.equal(classifyReadiness('user@host:~$ ', { silentMs: 100 }), 'prompt');
  assert.equal(classifyReadiness('compiling...', { silentMs: 3000 }), 'silent'); assert.equal(classifyReadiness('compiling...', { silentMs: 100 }), 'busy');
  assert.equal(PROMPT_TAIL_RE.test('PS F:\\work> '), true); assert.equal(classifyReadiness('PS F:\\work> ', { silentMs: 100, prompt: POWERSHELL_PROMPT }), 'prompt');

  // macOS zsh ends its prompt with `%`; the regex is tail-anchored, so ordinary output never matches
  assert.ok(PROMPT_TAIL_RE.test('user@host ~ % ')); assert.ok(new RegExp(POSIX_PROMPT.waitPattern).test('yehaoyu@Mac pier % '));
  assert.ok(PROMPT_TAIL_RE.test('root@host:/# ')); assert.ok(PROMPT_TAIL_RE.test('❯ '));
  assert.equal(PROMPT_TAIL_RE.test('downloaded 50% of 1.2GB'), false);
});

test('promptStrategyFor/planShellInit：env 优先于 $SHELL；未初始化且到提示符才注入 `set +H`', () => {
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

  type PlanOpts = { readiness?: ReadinessTier; strategy?: PromptStrategy; initialized?: boolean };
  const init: PlanOpts[] = [{}, { readiness: 'prompt' }, { strategy: POSIX_PROMPT }];
  const skip: PlanOpts[] = [{ readiness: 'silent' }, { readiness: 'busy' }, { initialized: true }, { strategy: POWERSHELL_PROMPT }];
  for (const opts of init) assert.deepEqual(planShellInit(opts), { shouldInit: true, command: 'set +H' }, JSON.stringify(opts));
  for (const opts of skip) assert.deepEqual(planShellInit(opts), { shouldInit: false, command: null }, JSON.stringify(opts));
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
    { ...mkEntry({ terminalId: 'term-1', paneId: 'p1' }), nudgedAt: 40 }, mkEntry({ terminalId: 'term-2', paneId: 'p2' })]))]);
  assert.equal(nudged[0]?.nudgedAt, 40, 'a nudged timestamp survives the round trip');
  assert.equal(nudged[1]?.nudgedAt, null, 'a never-nudged terminal defaults to null');

  // A10: a fold that dropped the tail made the next computeIncrement throw on prev.tail.length, so the
  // round trip is exercised with a cursor the real computeIncrement produced.
  const cursor = computeIncrement(null, { text: 'hello\n', revision: 7 }, 1000).cursor;
  const restored = foldTerminalsRegistry([entry({ version: 1, terminals: [
    mkEntry({ readRevision: 7, readLen: cursor.len, readTail: cursor.tail, readEoTail: cursor.eoTail })] })])[0]!;
  assert.equal(restored.readTail, cursor.tail); assert.equal(restored.readEoTail, cursor.eoTail);
  assert.equal(restored.readRevision, 7);
  const rev = { revision: restored.readRevision ?? 0, len: restored.readLen ?? 0, tail: restored.readTail ?? '', eoTail: restored.readEoTail ?? '' };
  const inc = computeIncrement(rev, { text: 'hello\nworld\n', revision: 8 }, 1000);
  assert.equal(inc.mode, 'append'); assert.equal(inc.text, 'world\n');

  const legacy = foldTerminalsRegistry([entry({ version: 1, terminals: [mkEntry()] })])[0]!;
  assert.equal(legacy.readTail, ''); assert.equal(legacy.readEoTail, '');
  assert.equal(legacy.initialized, false);
});

test('planIdleTerminalReminder：闲置超阈值且未催过 → due；催过/未闲置/达上限 → 不催', () => {
  const term = (id: string, lastActivityAt: number, nudgedAt: number | null = null) => ({ terminalId: id, cwd: `/w/${id}`, label: id, lastActivityAt, nudgedAt });
  const now = 10_000_000;
  const idleMs = terminalIdleMs();

  // idle past the threshold and never nudged → due, and only the never-nudged terminal is listed
  const due = planIdleTerminalReminder({ open: [term('term-1', now - idleMs - 1), term('term-2', now - idleMs - 1, now - 1000)], now, reminders: 0 });
  assert.equal(due.due, true); assert.deepEqual(due.ids, ['term-1'], 'already-nudged term-2 stays out');
  assert.match(due.content ?? '', /term-1/); assert.doesNotMatch(due.content ?? '', /term-2/);
  // the notice must forbid replying to this internal housekeeping message (or it triggers a farewell turn)
  assert.match(due.content!, /do NOT reply to the user and do NOT send any farewell/); assert.match(due.content!, new RegExp(`nudge 1/${TERM_REMINDERS_MAX}`));

  // everything already nudged → nothing
  assert.equal(planIdleTerminalReminder({ open: [term('term-2', now - idleMs - 1, now - 1000)], now, reminders: 1 }).due, false);
  // below the idle threshold → nothing (a busy, long-running dev server terminal is touched recently)
  assert.equal(planIdleTerminalReminder({ open: [term('term-1', now - 1000)], now, reminders: 0 }).due, false);
  // per-process hard cap
  for (let reminders = 0; reminders < TERM_REMINDERS_MAX + 2; reminders += 1) {
    const plan = planIdleTerminalReminder({ open: [term('term-1', now - idleMs - 1)], now, reminders });
    assert.equal(plan.due, reminders < TERM_REMINDERS_MAX, `reminders=${reminders}`);
  }
});

/* ── plugins/terminal.ts wiring ─────────────────────────────────── */

const TOOL_NAME = 'terminal';
const PANE_2 = { paneId: 'pane-2', tabId: 't1', workspaceId: 'w1', agentStatus: 'idle' };

interface ToolResult { content: Array<{ text: string }>; details: Record<string, unknown> }

const run = (pi: FakePi, params: Record<string, unknown>, toolCtx?: unknown): Promise<ToolResult> =>
  pi.tools.get(TOOL_NAME)!.execute!(null, params, undefined, undefined, toolCtx) as Promise<ToolResult>;

/** Mounts plugins/terminal.ts through a real cordis Context + PiSurface over fakeHerdr, optionally
 *  running `action: open` first; returns the recorded client calls the assertions need. */
async function mountTerminal(t: TestContext, opts: { client?: Partial<HerdrClientLike>; open?: boolean } = {}) {
  const calls = { waitForOutput: [] as Array<{ paneId: string; match: unknown; timeoutMs: number }>, sendPaneText: [] as string[], closePane: [] as string[] };
  const client = fakeHerdr({
    splitPane: async () => 'pane-2',
    waitForOutput: async (paneId, match, timeoutMs) => { calls.waitForOutput.push({ paneId, match, timeoutMs }); return { matched: true }; },
    readPane: async () => ({ text: '$ ', revision: 1, truncated: false }),
    sendPaneText: async (_paneId, text) => { calls.sendPaneText.push(text); },
    closePane: async (paneId) => { calls.closePane.push(paneId); },
    listPanes: async () => [PANE_2], ...opts.client,
  });
  const pi = fakePi();
  const ledger = new DisposeLedger();
  const deps = { client, env: { paneId: 'p1', tabId: 't1' }, state: { activePaneIds: (): Set<string> => new Set() } };
  const ctx = new Context();
  ctx.provide('pi-herdr.surface', new PiSurface(pi as unknown as object, ledger));
  ctx.provide('pi-herdr.terminal-deps', deps);
  await ctx.plugin(terminalPlugin);
  t.after(() => ctx.fiber.dispose());
  if (opts.open) await run(pi, { action: 'open' }, { cwd: 'F:/w' });
  return { pi, deps, ledger, client, calls };
}

test('plugins/terminal：工具挂载（snippet/guidelines、open/list/GC、herdr title、未知动作）', async (t) => {
  const { pi, deps, calls } = await mountTerminal(t, { client: { listPanes: async () => [{ ...PANE_2, terminalTitleStripped: 'npm run dev' }] } });
  assert.ok(pi.tools.has(TOOL_NAME), 'terminal should register'); assert.ok(!pi.tools.has('terminal_open'), 'the old split tool names must not register');
  assert.equal(deps.state.activePaneIds().size, 0, 'no terminals yet');

  // B4: the model-facing prompt contract (when a resident terminal beats bash)
  const def = pi.tools.get(TOOL_NAME)!;
  assert.ok(def.promptSnippet, 'terminal has a snippet'); assert.match(String(def.promptSnippet), /persistent shell in its own pane/);
  const guidelines = (def.promptGuidelines ?? []).join(' ');
  assert.match(guidelines, /Prefer bash for one-shot commands/); assert.match(guidelines, /dev servers|server, REPL/);
  assert.match(guidelines, /Close the terminal/);

  const open = await run(pi, { action: 'open' }, { cwd: 'F:/w' });
  assert.match(open.content[0].text, /terminal term-1 open \(pane pane-2\)/); assert.equal(open.details.readiness, 'prompt');
  assert.deepEqual(calls.sendPaneText, ['set +H'], 'open should send set +H to a POSIX shell');
  assert.ok(deps.state.activePaneIds().has('pane-2'), 'GC slot: an active terminal pane is visible');
  assert.ok(pi.entries.some(([type]) => type === TERMINALS_CUSTOM_TYPE), 'the registry was appended');

  const list = await run(pi, { action: 'list' });
  assert.match(list.content[0].text, /term-1 \[open\] pane=pane-2/);
  assert.match(list.content[0].text, /title="npm run dev"/, 'herdr 0.9.1 terminal title shows in the listing');
  await assert.rejects(async () => { await run(pi, { action: 'explode' }); }, /unknown action "explode"/);
});

test('plugins/terminal：wait/send/read 的动作契约（就绪校验、超时尾部、pane 作用域）', async (t) => {
  const { pi, client, calls } = await mountTerminal(t, { open: true });

  // the matcher the tool hands to herdr is the contract; the open-time readiness probe records its own
  const hit = await run(pi, { action: 'wait', terminal_id: 'term-1', pattern: 'TERM_DONE_', timeout_ms: 5000 });
  assert.equal(hit.details.matched, true, 'a hit → matched'); assert.equal(calls.waitForOutput.at(-1)?.paneId, 'pane-2');
  assert.deepEqual(calls.waitForOutput.at(-1)?.match, { type: 'substring', value: 'TERM_DONE_' });

  client.readPane = async () => ({ text: 'bug=19820 terminal_result=ok\n$ ', revision: 3, truncated: false });
  await run(pi, { action: 'read', terminal_id: 'term-1', max_chars: 7000 });
  const waitsBeforeStale = calls.waitForOutput.length;
  const stale = await run(pi, { action: 'wait', terminal_id: 'term-1', pattern: 'terminal_result=', timeout_ms: 1000 });
  assert.equal(stale.details.matched, false);
  assert.equal(stale.details.stale, true);
  assert.match(stale.content[0].text, /already-read output/);
  assert.equal(calls.waitForOutput.length, waitsBeforeStale + 1, 'a stale hit must not re-enter waitForOutput');
  client.readPane = async () => ({ text: 'bug=19820 terminal_result=ok\nsubmitted bug=19816\n$ ', revision: 4, truncated: false });
  const freshWait = await run(pi, { action: 'wait', terminal_id: 'term-1', pattern: 'submitted bug=19816', timeout_ms: 2000 });
  assert.equal(freshWait.details.matched, true);
  assert.match(freshWait.content[0].text, /submitted bug=19816/);

  client.waitForOutput = async (paneId, match, timeoutMs) => {
    calls.waitForOutput.push({ paneId, match, timeoutMs });
    return { matched: false, reason: 'timeout' };
  };
  const miss = await run(pi, { action: 'wait', terminal_id: 'term-1', pattern: 'never-appears', regex: true, timeout_ms: 5000 });
  assert.equal(miss.details.matched, false); assert.match(miss.content[0].text, /no match within 5000ms \(timeout\)/);
  assert.match(miss.content[0].text, /recent output tail/, 'a timeout returns the recent tail, so no blind re-polling');
  assert.deepEqual(calls.waitForOutput.at(-1)?.match, { type: 'regex', value: 'never-appears' });

  // an RPC that is unavailable reports its own reason; an invalid regex is a hard failure (A1)
  client.waitForOutput = async () => ({ matched: false, reason: 'unavailable' });
  const unavail = await run(pi, { action: 'wait', terminal_id: 'term-1', pattern: 'never-appears', timeout_ms: 3000 });
  assert.equal(unavail.details.matched, false); assert.match(unavail.content[0].text, /no match within 3000ms \(wait unavailable\)/);
  await assert.rejects(async () => { await run(pi, { action: 'wait', terminal_id: 'term-1', pattern: '(', regex: true }); }, /invalid regex/);

  // wait_prompt: refuse while the shell is busy (nothing queued), send once it is back at a prompt
  calls.sendPaneText.length = 0;
  client.waitForOutput = async () => ({ matched: false, reason: 'timeout' });
  client.readPane = async () => ({ text: 'compiling src/main.rs...', revision: 2, truncated: false });
  const busySend = () => run(pi, { action: 'send', terminal_id: 'term-1', text: 'echo next', wait_prompt: true });
  await assert.rejects(busySend, /text was NOT sent/);
  await assert.rejects(busySend, /busy/);
  assert.equal(calls.sendPaneText.length, 0, 'nothing is queued while busy');

  client.waitForOutput = async () => ({ matched: true });
  const sent = await run(pi, { action: 'send', terminal_id: 'term-1', text: 'echo next', wait_prompt: true });
  assert.match(sent.content[0].text, /sent to term-1/); assert.deepEqual(calls.sendPaneText, ['echo next']);

  // a direct pane_id read is limited to own-tab panes and self-created terminal panes
  const own = await run(pi, { action: 'read', pane_id: 'pane-2' });
  assert.equal(own.details.mode, 'reset', 'a self-created terminal pane is readable');
  client.listPanes = async () => [{ paneId: 'pane-9', tabId: 'other', workspaceId: 'w1', agentStatus: 'idle' }];
  await assert.rejects(async () => { await run(pi, { action: 'read', pane_id: 'pane-9' }); }, /limited to panes in this session's own tab/);
});

test('wait 哨兵自匹配：命中自己回显的 pattern 直接拒绝，可区分的 sentinel 照常等待', async (t) => {
  // 纯函数：literal/regex 是否会命中发送文本本身
  const sent = 'for r in 1 2 3; do pi -p "$(cat in_$r.txt)" > out_$r.json; done; echo G3FP_ALL_DONE';
  assert.equal(sentinelEchoHazard({ pattern: 'G3FP_ALL_DONE', lastSentText: sent }), true, 'literal sentinel ⊆ echo');
  assert.equal(sentinelEchoHazard({ pattern: 'G3FP_ALL_DONE', regex: true, lastSentText: sent }), true, 'regex 不锚定也会命中 echo');
  assert.equal(sentinelEchoHazard({ pattern: '^G3FP_ALL_DONE', regex: true, lastSentText: sent }), false, '行首锚定不命中 `echo G3FP…` 回显');
  assert.equal(sentinelEchoHazard({ pattern: 'BUILD SUCCESS', lastSentText: sent }), false, '与命令无关的 pattern 无风险');
  assert.equal(sentinelEchoHazard({ pattern: 'x', lastSentText: null }), false, '本进程没发送过 → 无法判定，放行');

  // 契约：发送过含哨兵的命令后，wait 该哨兵必须拒绝且不发起 herdr 等待
  const { pi, calls } = await mountTerminal(t, { open: true });
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
  assert.equal(calls.waitForOutput.length, 0, 'an echo self-match never reaches herdr');

  // 可区分的 pattern（锚定正则）照常走等待
  const hit = await run(pi, { action: 'wait', terminal_id: 'term-1', pattern: '^G3FP_ALL_DONE', regex: true, timeout_ms: 5000 });
  assert.equal(hit.details.matched, true);
  assert.deepEqual(calls.waitForOutput.at(-1)?.match, { type: 'regex', value: '^G3FP_ALL_DONE' });

  // close 清掉发送记录后，同 pattern 的 wait 不再被拒（终端已关闭则按未知终端报错）
  await run(pi, { action: 'close', terminal_id: 'term-1' });
  await assert.rejects(
    async () => { await run(pi, { action: 'wait', terminal_id: 'term-1', pattern: 'G3FP_ALL_DONE' }); },
    /unknown or closed terminal/,
  );
});

test('classifyWaitMatch: a pattern only in already-read text is stale; new text is fresh', () => {
  const first = computeIncrement(null, { text: 'bug=19820 terminal_result=ok\n', revision: 1 }, 10_000);
  assert.equal(classifyWaitMatch(first.cursor, 'bug=19820 terminal_result=ok\n', 'terminal_result=', false).kind, 'stale');
  const grown = 'bug=19820 terminal_result=ok\nsubmitted bug=19816\n';
  const fresh = classifyWaitMatch(first.cursor, grown, 'submitted bug=19816', false);
  assert.equal(fresh.kind, 'fresh');
  if (fresh.kind === 'fresh') assert.match(fresh.excerpt, /submitted bug=19816/);
  assert.equal(classifyWaitMatch(null, '$ ', 'TERM_DONE_', false).kind, 'absent');
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


test('plugins/terminal：会话生命周期——shutdown 关停全部 open pane，ledger 墓碑让工具 inert', async (t) => {
  const { pi, deps, ledger, calls } = await mountTerminal(t, { open: true });
  assert.ok(deps.state.activePaneIds().has('pane-2'), 'precondition: the pane is registered');
  assert.ok((pi.listeners.get('session_shutdown')?.length ?? 0) >= 1, 'a shutdown handler is registered');

  await fire(pi, 'session_shutdown');
  assert.deepEqual(calls.closePane, ['pane-2'], 'the resident shell is reclaimed through closePane');
  assert.equal(deps.state.activePaneIds().size, 0, 'the GC slot no longer protects a closed pane');
  const registry = pi.entries.filter(([type]) => type === TERMINALS_CUSTOM_TYPE).at(-1)?.[1] as { terminals: Array<{ status: string; closedAt: number | null }> };
  assert.equal(registry.terminals[0].status, 'closed', 'the ledger records closed'); assert.ok(registry.terminals[0].closedAt != null);

  // hmr/reload reports the plugin file path — the normalized ledger matches the module key
  const key = new URL('../src/plugins/terminal.ts', import.meta.url).href;
  assert.equal(ledger.disposeKey(key), 1, 'the ledger matched the terminal module registration');
  const tombstoned = await run(pi, { action: 'list' });
  assert.match(tombstoned.content[0].text, /disposed/, 'the tool is inert after the tombstone');
});

test('plugins/terminal：agent_settled 催办闲置 terminal——每个 terminal 只催一次（告别循环守卫）', (t) => withCleanup(async (cleanup) => {
  // Which terminals are due, and the nudge content itself, is the planner's contract
  // (planIdleTerminalReminder). This test covers the delivery: a queued followUp that never wakes the
  // agent, the persisted nudgedAt, and the absence of a second nudge.
  const env = cleanup.env();
  env.set('PI_HERDR_TERM_IDLE_MS', '1');
  env.set('PI_HERDR_TERM_GRACE_MS', '5');
  // Mock Date as well: the tick creates an exact idle duration, so no real-clock millisecond race.
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const { pi, deps } = await mountTerminal(t, { open: true });
    const settle = async () => {
      mock.timers.tick(50); // produce an idle duration above the threshold
      await fire(pi, 'agent_settled');
      mock.timers.tick(5); // the grace window elapses
      await new Promise<void>((resolve) => setImmediate(resolve)); // drain the async delivery
    };

    await settle();
    assert.equal(pi.sent.length, 1, 'one nudge for the idle terminal'); assert.equal(pi.sent[0]?.msg.customType, TERM_REMINDER_CUSTOM_TYPE);
    assert.equal(pi.sent[0]?.opts?.deliverAs, 'followUp'); assert.equal(pi.sent[0]?.opts?.triggerTurn, undefined, 'a reminder must never wake the agent (goodbye loop)');
    const nudged = pi.entries.filter(([type]) => type === TERMINALS_CUSTOM_TYPE).at(-1)?.[1] as { terminals: Array<{ nudgedAt: number | null }> };
    assert.ok(nudged.terminals[0]!.nudgedAt != null, 'nudgedAt is persisted before the notice is delivered');

    await settle();
    assert.equal(pi.sent.length, 1, 'an already-nudged terminal is never nudged again — no farewell loop');
    assert.deepEqual([...deps.state.activePaneIds()], ['pane-2'], 'a nudge only reminds, it never closes panes');
  } finally {
    mock.timers.reset();
  }
})());
