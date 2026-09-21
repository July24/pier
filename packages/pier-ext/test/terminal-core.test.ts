/**
 * Terminal domain: the pure terminal-core planners (registry / validation / ANSI / read increments /
 * readiness / summaries / branch folding / idle nudge) plus the plugins/terminal.ts wiring
 * (surface injection, single tool registration, GC slot, ledger tombstone) driven through a real
 * cordis Context and a real PiSurface with a fake pi client.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import terminalPlugin from '../src/plugins/terminal.ts';
import {
  MAX_TERMINALS,
  POSIX_PROMPT,
  POWERSHELL_PROMPT,
  PROMPT_TAIL_RE,
  SIGNAL_KEYS,
  TERMINALS_CUSTOM_TYPE,
  TERM_REMINDERS_MAX,
  classifyReadiness,
  closeTerminal,
  computeIncrement,
  detectFullscreenTUI,
  foldTerminalsRegistry,
  makeTerminalsRegistry,
  nextTerminalId,
  planIdleTerminalReminder,
  planShellInit,
  promptStrategyFor,
  registerTerminal,
  stripAnsi,
  summarizeSessions,
  terminalIdleMs,
  validateSendText,
  validateSignal,
  type TerminalEntry,
} from '../src/terminal-core.ts';
import { PiSurface } from '../src/pi-surface.ts';
import { DisposeLedger } from '../src/ledger.ts';
import type { HerdrClientLike } from '../src/herdr-client.ts';

const base = {
  paneId: 'pane-a',
  tabId: 'tab-1',
  cwd: 'F:/work',
  label: 'dev server',
  createdAt: 1000,
  lastActivityAt: 1000,
};

function mkEntry(over: Partial<TerminalEntry> = {}): TerminalEntry {
  return {
    terminalId: 'term-1',
    status: 'open',
    closedAt: null,
    readRevision: null,
    readLen: 0,
    readTail: '',
    readEoTail: '',
    ...base,
    ...over,
  } as TerminalEntry;
}

/* ── Registry ───────────────────────────────────────────────────── */

test('nextTerminalId 取现存最大号 +1', () => {
  assert.equal(nextTerminalId([]), 'term-1');
  assert.equal(nextTerminalId(['term-1', 'term-3']), 'term-4');
});

test('registerTerminal：默认 label = cwd 尾段；成功注册', () => {
  const r = registerTerminal([], { ...base, label: undefined as unknown as string });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.entry.terminalId, 'term-1');
  assert.equal(r.entry.label, 'work');
  assert.equal(r.entries.length, 1);
});

test('registerTerminal：到达上限拒绝并给清晰错误', () => {
  const existing = Array.from({ length: MAX_TERMINALS }, (_, i) =>
    mkEntry({ terminalId: `term-${i + 1}`, paneId: `p${i}` }));
  const r = registerTerminal(existing, base);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.error, /max/i);
  assert.match(r.error, /8/);
});

test('closeTerminal：幂等；不存在报错', () => {
  const e = mkEntry();
  const once = closeTerminal([e], 'term-1', 2000);
  assert.equal(once.entries[0].status, 'closed');
  assert.equal(once.entries[0].closedAt, 2000);
  const again = closeTerminal(once.entries, 'term-1', 3000);
  assert.equal(again.entries[0].closedAt, 2000); // idempotent: an existing closedAt is kept
  assert.equal(closeTerminal([], 'term-x', 1).entries.length, 0);
});

/* ── T6 detection: send / signal ────────────────────────────────── */

test('validateSendText：拒 ANSI 转义与控制字符；剥尾部换行', () => {
  assert.deepEqual(validateSendText('npm run dev'), { ok: true, text: 'npm run dev' });
  const esc = validateSendText('echo \x1b[31mred');
  assert.equal(esc.ok, false);
  if (esc.ok) return;
  assert.match(esc.error, /ANSI|escape/i);
  const ctrl = validateSendText('a\x07b');
  assert.equal(ctrl.ok, false);
  assert.deepEqual(validateSendText('dir\r\n'), { ok: true, text: 'dir' });
});

test('validateSignal：白名单原样通过，其余拒绝', () => {
  for (const k of SIGNAL_KEYS) {
    assert.deepEqual(validateSignal(k), { ok: true, key: k });
  }
  const bad = validateSignal('ctrl+a');
  assert.equal(bad.ok, false);
  if (bad.ok) return;
  assert.match(bad.error, /signal/i);
});

/* ── T6 detection: fullscreen TUI (alternate screen) ────────────── */

test('detectFullscreenTUI：识别 alternate screen 序列', () => {
  assert.equal(detectFullscreenTUI('ok output').detected, false);
  assert.equal(detectFullscreenTUI('starting\r\n\x1b[?1049h vim').detected, true);
  assert.equal(detectFullscreenTUI('\x1b[?47h old less').detected, true);
  assert.equal(detectFullscreenTUI('\x1b[2J\x1b[Hclear').detected, true);
});

test('stripAnsi：去 CSI/OSC 序列与剩余控制字符', () => {
  assert.equal(stripAnsi('\x1b[32mgreen\x1b[0m plain'), 'green plain');
  assert.equal(stripAnsi('\x1b]0;title\x07tail'), 'tail');
  assert.equal(stripAnsi('a\x00b\x07c'), 'abc');
});

/* ── Read increments (ring-buffer semantics) ────────────────────── */

test('computeIncrement：首读 = 有界全量（reset）', () => {
  const r = computeIncrement(null, { text: 'hello world', revision: 3 }, 1000);
  assert.equal(r.mode, 'reset');
  assert.equal(r.text, 'hello world');
  assert.deepEqual(r.cursor, { revision: 3, len: 0, tail: '', eoTail: 'hello world' });
});

test('computeIncrement：无新输出 = none（revision 不作变化探测，实测恒 0）；前缀扩展 = append', () => {
  const prev = { revision: 3, len: 5, tail: 'hello', eoTail: 'hello' };
  assert.equal(computeIncrement(prev, { text: 'hello', revision: 99 }, 1000).mode, 'none');
  const app = computeIncrement(prev, { text: 'hello world', revision: 4 }, 1000);
  assert.equal(app.mode, 'append');
  assert.equal(app.text, ' world');
});

test('computeIncrement：屏幕缓冲活动行（行尾 \\n 变空格，实测 fixture）→ 仍判 append', () => {
  const text1 = 'PS F:\\herdr-pi>\n';
  const first = computeIncrement(null, { text: text1, revision: 0 }, 1000);
  const text2 = 'PS F:\\herdr-pi> echo hi\nhi\nPS F:\\herdr-pi>\n';
  const inc = computeIncrement(first.cursor, { text: text2, revision: 0 }, 1000);
  assert.equal(inc.mode, 'append');
  assert.match(inc.text, /echo hi/);
  // one more read without new output → none
  const again = computeIncrement(inc.cursor, { text: text2, revision: 0 }, 1000);
  assert.equal(again.mode, 'none');
});

test('computeIncrement：缓冲回卷/清屏 = reset（带截断标记）；超限截尾', () => {
  const prev = { revision: 3, len: 10, tail: 'xxxxxxxxxx', eoTail: 'xxxxxxxxxx' };
  const r = computeIncrement(prev, { text: 'brand new buffer', revision: 4 }, 1000);
  assert.equal(r.mode, 'reset');
  assert.match(r.text, /reset|truncat/i);
  const long = 'x'.repeat(5000);
  const b = computeIncrement(null, { text: long, revision: 9 }, 100);
  assert.ok(b.text.length <= 200);
  assert.match(b.text, /truncat/i);
});

/* ── T3 readiness: prompt / silent / busy ───────────────────────── */

test('classifyReadiness：PS1 尾匹配 → prompt；静默期 → silent；否则 busy', () => {
  assert.equal(classifyReadiness('PS F:\\work> ', { silentMs: 100 }), 'prompt');
  assert.equal(classifyReadiness('user@host:~$ ', { silentMs: 100 }), 'prompt');
  assert.equal(classifyReadiness('compiling...', { silentMs: 3000 }), 'silent');
  assert.equal(classifyReadiness('compiling...', { silentMs: 100 }), 'busy');
  assert.equal(PROMPT_TAIL_RE.test('PS F:\\work> '), true);
  assert.equal(classifyReadiness('PS F:\\work> ', { silentMs: 100, prompt: POWERSHELL_PROMPT }), 'prompt');
});

test('PROMPT_TAIL_RE / POSIX_PROMPT: 认得 macOS zsh 的 `%` 提示符（同时不误伤普通输出）', () => {
  assert.ok(PROMPT_TAIL_RE.test('user@host ~ % '));
  assert.ok(new RegExp(POSIX_PROMPT.waitPattern).test('yehaoyu@Mac pier % '));
  assert.ok(PROMPT_TAIL_RE.test('root@host:/# '));
  assert.ok(PROMPT_TAIL_RE.test('❯ '));
  // tail-anchored: a percentage inside ordinary output is not a prompt
  assert.equal(PROMPT_TAIL_RE.test('downloaded 50% of 1.2GB'), false);
});

test('promptStrategyFor: bash/zsh/powershell/pwsh（env 优先，其次 $SHELL）', () => {
  assert.equal(promptStrategyFor({}), POSIX_PROMPT);
  assert.equal(promptStrategyFor({ PIER_TERMINAL_PROMPT: 'powershell' }), POWERSHELL_PROMPT);
  assert.equal(promptStrategyFor({ PIER_TERMINAL_PROMPT: 'pwsh' }), POWERSHELL_PROMPT);
  assert.equal(promptStrategyFor({ PIER_TERMINAL_PROMPT: ' zsh ' }), POSIX_PROMPT);
  assert.equal(promptStrategyFor({ PIER_TERMINAL_PROMPT: 'bash' }), POSIX_PROMPT);
  assert.equal(promptStrategyFor({ SHELL: '/bin/zsh' }), POSIX_PROMPT);
  assert.equal(promptStrategyFor({ SHELL: '/bin/bash' }), POSIX_PROMPT);
  assert.equal(promptStrategyFor({ SHELL: '/usr/bin/pwsh' }), POWERSHELL_PROMPT);
  assert.equal(promptStrategyFor({ SHELL: 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' }), POWERSHELL_PROMPT);
  // explicit configuration beats $SHELL
  assert.equal(promptStrategyFor({ PIER_TERMINAL_PROMPT: 'powershell', SHELL: '/bin/zsh' }), POWERSHELL_PROMPT);
});

test('planShellInit: 只在未初始化且已到提示符时注入 `set +H`（PowerShell 不注入）', () => {
  assert.deepEqual(planShellInit({}), { shouldInit: true, command: 'set +H' });
  assert.deepEqual(planShellInit({ readiness: 'prompt' }), { shouldInit: true, command: 'set +H' });
  assert.deepEqual(planShellInit({ readiness: 'silent' }), { shouldInit: false, command: null });
  assert.deepEqual(planShellInit({ readiness: 'busy' }), { shouldInit: false, command: null });
  assert.deepEqual(planShellInit({ initialized: true }), { shouldInit: false, command: null });
  assert.deepEqual(planShellInit({ strategy: POWERSHELL_PROMPT }), { shouldInit: false, command: null });
  assert.deepEqual(planShellInit({ strategy: POSIX_PROMPT }), { shouldInit: true, command: 'set +H' });
});

/* ── Session summary (T6 across restarts) ───────────────────────── */

test('summarizeSessions：stale pane 标 closed；返回跨重启注记', () => {
  const entries = [
    mkEntry({ terminalId: 'term-1', paneId: 'live-1' }),
    mkEntry({ terminalId: 'term-2', paneId: 'gone-2' }),
  ];
  const s = summarizeSessions(entries, ['live-1']);
  assert.equal(s.terminals.length, 2);
  assert.equal(s.terminals.find((t) => t.terminalId === 'term-2')?.live, false);
  assert.deepEqual(s.stalePaneIds, ['gone-2']);
  assert.equal(s.terminals.find((t) => t.terminalId === 'term-1')?.live, true);
});

/* ── Persistence (custom entry, last wins) ──────────────────────── */

test('makeTerminalsRegistry / foldTerminalsRegistry：往返 + last-wins', () => {
  const entries = [mkEntry({ terminalId: 'term-1' })];
  const payload = makeTerminalsRegistry(entries);
  const branch = [
    { type: 'custom', customType: TERMINALS_CUSTOM_TYPE, data: payload },
    { type: 'custom', customType: TERMINALS_CUSTOM_TYPE, data: makeTerminalsRegistry([]) },
  ];
  const folded = foldTerminalsRegistry(branch);
  assert.equal(folded.length, 0); // the later (clearing) entry wins
  const single = foldTerminalsRegistry([
    { type: 'custom', customType: TERMINALS_CUSTOM_TYPE, data: payload },
  ]);
  assert.equal(single.length, 1);
  assert.equal(single[0].terminalId, 'term-1');
  assert.equal(single[0].cwd, 'F:/work');
});

test('foldTerminalsRegistry: nudgedAt 往返持久化，缺省为 null', () => {
  const registry = makeTerminalsRegistry([
    { ...mkEntry({ terminalId: 'term-1', paneId: 'p1' }), nudgedAt: 40 },
    mkEntry({ terminalId: 'term-2', paneId: 'p2' }),
  ]);
  const folded = foldTerminalsRegistry([
    { type: 'custom', customType: TERMINALS_CUSTOM_TYPE, data: registry },
  ]);
  assert.equal(folded[0]?.nudgedAt, 40, 'a nudged timestamp survives the round trip');
  assert.equal(folded[1]?.nudgedAt, null, 'a never-nudged terminal defaults to null');
});

test('foldTerminalsRegistry (A10): 恢复 readTail/readEoTail，紧接 computeIncrement 不再抛错', () => {
  // Build a self-consistent cursor with the real computeIncrement, then push it through the JSONL fold
  // (a fold that dropped the tail made the next computeIncrement throw on prev.tail.length).
  const first = computeIncrement(null, { text: 'hello\n', revision: 7 }, 1000);
  const entry = mkEntry({
    readRevision: 7,
    readLen: first.cursor.len,
    readTail: first.cursor.tail,
    readEoTail: first.cursor.eoTail,
  });
  const folded = foldTerminalsRegistry([
    { type: 'custom', customType: TERMINALS_CUSTOM_TYPE, data: { version: 1, terminals: [entry] } },
  ]);
  assert.equal(folded.length, 1);
  const t = folded[0]!;
  assert.equal(t.readTail, first.cursor.tail);
  assert.equal(t.readEoTail, first.cursor.eoTail);
  assert.equal(t.readRevision, 7);
  const inc = computeIncrement(
    { revision: t.readRevision ?? 0, len: t.readLen ?? 0, tail: t.readTail ?? '', eoTail: t.readEoTail ?? '' },
    { text: 'hello\nworld\n', revision: 8 },
    1000,
  );
  assert.equal(inc.mode, 'append');
  assert.equal(inc.text, 'world\n');
});

test('foldTerminalsRegistry (A10): 缺失 tail 字段时回落空串（旧 JSONL 仍可读）', () => {
  const legacy = mkEntry();
  const folded = foldTerminalsRegistry([
    { type: 'custom', customType: TERMINALS_CUSTOM_TYPE, data: { version: 1, terminals: [legacy] } },
  ]);
  assert.equal(folded[0]!.readTail, '');
  assert.equal(folded[0]!.readEoTail, '');
  assert.equal(folded[0]!.initialized, false);
});

/* ── Idle-terminal nudge planner ────────────────────────────────── */

test('planIdleTerminalReminder：闲置超阈值且未催过 → due；催过/未闲置/达上限 → 不催', () => {
  const term = (id: string, lastActivityAt: number, nudgedAt: number | null = null) => ({
    terminalId: id, cwd: `/w/${id}`, label: id, lastActivityAt, nudgedAt,
  });
  const now = 10_000_000;
  const idleMs = terminalIdleMs();

  // idle past the threshold and never nudged → due, and only the never-nudged terminal is listed
  const due = planIdleTerminalReminder({ open: [term('term-1', now - idleMs - 1), term('term-2', now - idleMs - 1, now - 1000)], now, reminders: 0 });
  assert.equal(due.due, true);
  assert.deepEqual(due.ids, ['term-1'], 'already-nudged term-2 stays out');
  assert.match(due.content ?? '', /term-1/);
  assert.doesNotMatch(due.content ?? '', /term-2/);
  // the notice must forbid replying to this internal housekeeping message (or it triggers a farewell turn)
  assert.match(due.content!, /do NOT reply to the user and do NOT send any farewell/);
  assert.match(due.content!, new RegExp(`nudge 1/${TERM_REMINDERS_MAX}`));

  // everything already nudged → nothing
  assert.equal(planIdleTerminalReminder({ open: [term('term-1', now - idleMs - 1, now - 1000)], now, reminders: 1 }).due, false);
  // below the idle threshold → nothing (a busy, long-running dev server terminal is touched recently)
  assert.equal(planIdleTerminalReminder({ open: [term('term-1', now - 1000)], now, reminders: 0 }).due, false);
  // per-process hard cap
  for (let reminders = 0; reminders < TERM_REMINDERS_MAX + 2; reminders += 1) {
    const plan = planIdleTerminalReminder({ open: [term('term-1', now - idleMs - 1)], now, reminders });
    assert.equal(plan.due, reminders < TERM_REMINDERS_MAX, `reminders=${reminders}`);
  }
});

/* ── plugins/terminal.ts wiring ─────────────────────────────────── */

interface FakePi {
  sent: Array<{ customType: string; content: string; display?: boolean }>;
  entries: Array<[string, unknown]>;
  tools: Map<string, { execute?: (...a: unknown[]) => unknown; promptSnippet?: string; promptGuidelines?: string[] }>;
  listeners: Map<string, Array<(...a: unknown[]) => unknown>>;
  registerTool(def: { name: string; execute?: (...a: unknown[]) => unknown; promptSnippet?: string; promptGuidelines?: string[] }): void;
  on(event: string, handler: (...a: unknown[]) => unknown): void;
  appendEntry(customType: string, data: unknown): void;
  sendMessage(message: { customType: string; content: string; display?: boolean }): Promise<void>;
}

function fakePi(): FakePi {
  // `sent` lives in the closure, not on `this`: the plugin calls sendMessage bare (const send = pi.sendMessage),
  // which would lose a `this` binding.
  const sent = [] as Array<{ customType: string; content: string; display?: boolean }>;
  const entries = [] as Array<[string, unknown]>;
  return {
    sent,
    entries,
    tools: new Map<string, { execute?: (...a: unknown[]) => unknown; promptSnippet?: string; promptGuidelines?: string[] }>(),
    listeners: new Map<string, Array<(...a: unknown[]) => unknown>>(),
    registerTool(def: { name: string; execute?: (...a: unknown[]) => unknown; promptSnippet?: string; promptGuidelines?: string[] }) {
      this.tools.set(def.name, def);
    },
    on(event: string, handler: (...a: unknown[]) => unknown) {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), handler]);
    },
    appendEntry(customType: string, data: unknown) {
      entries.push([customType, data]);
    },
    sendMessage(message: { customType: string; content: string; display?: boolean }) {
      sent.push(message);
      return Promise.resolve();
    },
  };
}

function fakeClient(overrides: {
  waitForOutput?: HerdrClientLike['waitForOutput'];
} = {}) {
  const calls = {
    waitForOutput: [] as Array<{ paneId: string; match: unknown; timeoutMs: number }>,
    sendPaneText: [] as string[],
  };
  const client = {
    available: true,
    splitPane: async () => 'pane-2',
    waitForOutput: async (paneId: string, match: { type: string; value: string }, timeoutMs: number) => {
      calls.waitForOutput.push({ paneId, match, timeoutMs });
      return { matched: true } as const;
    },
    readPane: async () => ({ text: '$ ', revision: 1, truncated: false }),
    sendPaneText: async (paneId: string, text: string) => { calls.sendPaneText.push(text); },
    sendPaneKeys: async () => undefined,
    closePane: async () => undefined,
    listPanes: async () => [{ paneId: 'pane-2', tabId: 't1', workspaceId: 'w1', agentStatus: 'idle' }],
    ...overrides,
  } as unknown as HerdrClientLike;
  return { client, calls };
}

const TOOL_NAME = 'terminal';

async function mountTerminal(client: HerdrClientLike) {
  const pi = fakePi();
  const ledger = new DisposeLedger();
  const surface = new PiSurface(pi as unknown as object, ledger);
  const deps = {
    client,
    env: { paneId: 'p1', tabId: 't1' },
    state: { activePaneIds: (): Set<string> => new Set() },
  };
  const ctx = new Context();
  ctx.provide('pi-herdr.surface', surface);
  ctx.provide('pi-herdr.terminal-deps', deps);
  await ctx.plugin(terminalPlugin);
  return { pi, deps, ctx, ledger, surface };
}

const run = (pi: FakePi, params: Record<string, unknown>, toolCtx: unknown = undefined) =>
  pi.tools.get(TOOL_NAME)?.execute?.(null, params, undefined, undefined, toolCtx);

test('plugins/terminal：surface 挂载 terminal 工具 + GC 槽回填 + open/list 链路', async () => {
  const { pi, deps, ctx } = await mountTerminal(fakeClient().client);

  assert.ok(pi.tools.has(TOOL_NAME), 'terminal should register');
  assert.ok(!pi.tools.has('terminal_open'), 'the old split tool names must not register');
  assert.equal(deps.state.activePaneIds().size, 0, 'no terminals yet');

  const open = await run(pi, { action: 'open' }, { cwd: 'F:/w' }) as {
    content: Array<{ text: string }>;
    details: { terminal_id: string; pane_id: string; readiness: string };
  };
  assert.match(open.content[0].text, /terminal term-1 open \(pane pane-2\)/);
  assert.equal(open.details.readiness, 'prompt');
  assert.ok(deps.state.activePaneIds().has('pane-2'), 'GC slot: an active terminal pane is visible');
  assert.ok(pi.entries.some(([t]) => t === TERMINALS_CUSTOM_TYPE), 'the registry was appended');

  const list = await run(pi, { action: 'list' }) as { content: Array<{ text: string }> };
  assert.match(list.content[0].text, /term-1 \[open\] pane=pane-2/);

  await assert.rejects(async () => { await run(pi, { action: 'explode' }); }, /unknown action "explode"/);
  await ctx.fiber.dispose();
});

test('plugins/terminal：ledger.disposeKey(本文件) → 工具墓碑 inert（hmr 补偿路径）', async () => {
  const { pi, ctx, ledger } = await mountTerminal(fakeClient().client);

  // hmr/reload reports the plugin file path — the normalized ledger matches the module key
  const n = ledger.disposeKey(new URL('../src/plugins/terminal.ts', import.meta.url).href);
  assert.equal(n, 1, 'the ledger matched the terminal module registration');
  const r = await run(pi, { action: 'list' }) as { content: Array<{ text: string }> };
  assert.match(r.content[0].text, /disposed/, 'the tool is inert after the tombstone');
  await ctx.fiber.dispose();
});

test('plugins/terminal：session_shutdown 关停全部 open terminal（防泄漏）', async () => {
  const closeCalls: string[] = [];
  const client = fakeClient().client;
  client.closePane = async (paneId: string) => { closeCalls.push(paneId); };
  const { pi, deps, ctx } = await mountTerminal(client);

  await run(pi, { action: 'open' }, { cwd: 'F:/w' });
  assert.ok(deps.state.activePaneIds().has('pane-2'), 'precondition: the pane is registered');

  const shutdown = pi.listeners.get('session_shutdown') ?? [];
  assert.ok(shutdown.length >= 1, 'a shutdown handler is registered');
  await shutdown[0]?.(undefined);

  assert.deepEqual(closeCalls, ['pane-2'], 'the resident shell is reclaimed through closePane');
  assert.equal(deps.state.activePaneIds().size, 0, 'the GC slot no longer protects a closed pane');
  const registry = [...pi.entries].reverse().find(([t]) => t === TERMINALS_CUSTOM_TYPE)?.[1] as {
    terminals: Array<{ status: string; closedAt: number | null }>;
  };
  assert.equal(registry.terminals[0].status, 'closed', 'the ledger records closed');
  assert.ok(registry.terminals[0].closedAt != null);
  await ctx.fiber.dispose();
});

test('plugins/terminal：agent_settled 催办闲置 terminal——每个 terminal 只催一次（告别循环守卫）', async (t) => {
  const prevIdle = process.env.PI_HERDR_TERM_IDLE_MS;
  const prevGrace = process.env.PI_HERDR_TERM_GRACE_MS;
  process.env.PI_HERDR_TERM_IDLE_MS = '1';
  process.env.PI_HERDR_TERM_GRACE_MS = '5';
  // Mock Date as well: the tick creates an exact idle duration, so no real-clock millisecond race.
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const client = fakeClient().client;
    let splitSeq = 2;
    client.splitPane = async () => `pane-${splitSeq++}`;
    const { pi, deps } = await mountTerminal(client);
    await run(pi, { action: 'open' }, { cwd: 'F:/w' });
    await run(pi, { action: 'open' }, { cwd: 'F:/w' });
    const settled = (pi.listeners.get('agent_settled') ?? [])[0] as (() => Promise<void>) | undefined;
    const settle = async () => {
      t.mock.timers.tick(50); // produce an idle duration above the threshold
      await settled?.();
      t.mock.timers.tick(5); // the grace window elapses
      await new Promise<void>((resolve) => setImmediate(resolve)); // drain the async delivery
    };

    await settle();
    assert.equal(pi.sent.length, 1, 'first round: two idle terminals are covered by one nudge');
    assert.match(pi.sent[0]?.content ?? '', /term-1/);
    assert.match(pi.sent[0]?.content ?? '', /term-2/);

    await settle();
    assert.equal(pi.sent.length, 1, 'an already-nudged terminal is never nudged again — no farewell loop');
    assert.deepEqual([...deps.state.activePaneIds()].sort(), ['pane-2', 'pane-3'], 'a nudge only reminds, it never closes panes');
  } finally {
    t.mock.timers.reset();
    if (prevIdle === undefined) delete process.env.PI_HERDR_TERM_IDLE_MS;
    else process.env.PI_HERDR_TERM_IDLE_MS = prevIdle;
    if (prevGrace === undefined) delete process.env.PI_HERDR_TERM_GRACE_MS;
    else process.env.PI_HERDR_TERM_GRACE_MS = prevGrace;
  }
});

test('plugins/terminal：wait 命中 → matched；超时 → 带尾部输出的 no match', async () => {
  const { client, calls } = fakeClient();
  const { pi, ctx } = await mountTerminal(client);
  await run(pi, { action: 'open' }, { cwd: 'F:/w' });

  // the open readiness probe is the first waitForOutput; the wait hit is the second
  const hit = await run(pi, { action: 'wait', terminal_id: 'term-1', pattern: 'TERM_DONE_', timeout_ms: 5000 }) as {
    content: Array<{ text: string }>; details: { matched: boolean };
  };
  assert.equal(hit.details.matched, true, 'a hit → matched');
  assert.equal(calls.waitForOutput[1]?.paneId, 'pane-2');
  assert.deepEqual(calls.waitForOutput[1]?.match, { type: 'substring', value: 'TERM_DONE_' });

  client.waitForOutput = async (paneId: string, match: { type: string; value: string }, timeoutMs: number) => {
    calls.waitForOutput.push({ paneId, match, timeoutMs });
    return { matched: false, reason: 'timeout' as const };
  };

  const miss = await run(pi, { action: 'wait', terminal_id: 'term-1', pattern: 'never-appears', regex: true, timeout_ms: 5000 }) as {
    content: Array<{ text: string }>; details: { matched: boolean };
  };
  assert.equal(miss.details.matched, false);
  assert.match(miss.content[0].text, /no match within 5000ms \(timeout\)/);
  assert.match(miss.content[0].text, /recent output tail/, 'a timeout returns the recent tail, so no blind re-polling');
  assert.deepEqual(calls.waitForOutput[2]?.match, { type: 'regex', value: 'never-appears' });

  // simulate an RPC that is unavailable
  client.waitForOutput = async () => ({ matched: false, reason: 'unavailable' });
  const unavail = await run(pi, { action: 'wait', terminal_id: 'term-1', pattern: 'never-appears', timeout_ms: 3000 }) as {
    content: Array<{ text: string }>; details: { matched: boolean };
  };
  assert.equal(unavail.details.matched, false);
  assert.match(unavail.content[0].text, /no match within 3000ms \(wait unavailable\)/);

  // A1: an invalid pattern is a hard failure → execute() rejects
  await assert.rejects(
    async () => {
      await run(pi, { action: 'wait', terminal_id: 'term-1', pattern: '(', regex: true });
    },
    /invalid regex/,
  );
  await ctx.fiber.dispose();
});

test('plugins/terminal：send(wait_prompt) 就绪才发；busy 拒发不排队', async () => {
  const { client, calls } = fakeClient();
  const { pi, ctx } = await mountTerminal(client);
  await run(pi, { action: 'open' }, { cwd: 'F:/w' });

  assert.deepEqual(calls.sendPaneText, ['set +H'], 'open should send set +H to a POSIX shell');
  calls.sendPaneText.length = 0;

  // waitForOutput misses and readPane shows no prompt → busy, so the text is refused
  const busy = client as unknown as {
    waitForOutput: HerdrClientLike['waitForOutput'];
    readPane: () => Promise<{ text: string; revision: number; truncated: boolean }>;
  };
  busy.waitForOutput = async () => ({ matched: false, reason: 'timeout' });
  busy.readPane = async () => ({ text: 'compiling src/main.rs...', revision: 2, truncated: false });
  // A1: refusing to send into a busy shell is a hard failure → execute() rejects
  const refusedText = await (async () => {
    try {
      await run(pi, { action: 'send', terminal_id: 'term-1', text: 'echo next', wait_prompt: true });
    } catch (e) {
      return (e as Error).message;
    }
    throw new Error('expected send into a busy shell to throw');
  })();
  assert.match(refusedText, /text was NOT sent/);
  assert.match(refusedText, /busy/);
  assert.equal(calls.sendPaneText.length, 0, 'nothing is queued while busy');

  // prompt ready → the text goes out
  busy.waitForOutput = async () => ({ matched: true });
  const ok = await run(pi, { action: 'send', terminal_id: 'term-1', text: 'echo next', wait_prompt: true }) as {
    content: Array<{ text: string }>;
  };
  assert.match(ok.content[0].text, /sent to term-1/);
  assert.deepEqual(calls.sendPaneText, ['echo next']);
  await ctx.fiber.dispose();
});

test('plugins/terminal：read 直读 pane_id 仅限本 tab / 自有 terminal', async () => {
  const { client } = fakeClient();
  const { pi, ctx } = await mountTerminal(client);
  await run(pi, { action: 'open' }, { cwd: 'F:/w' });

  const own = await run(pi, { action: 'read', pane_id: 'pane-2' }) as { details: { mode: string } };
  assert.equal(own.details.mode, 'reset', 'a self-created terminal pane is readable');

  client.listPanes = async () => [{ paneId: 'pane-9', tabId: 'other', workspaceId: 'w1', agentStatus: 'idle' }];
  await assert.rejects(
    async () => { await run(pi, { action: 'read', pane_id: 'pane-9' }); },
    /limited to panes in this session's own tab/,
  );
  await ctx.fiber.dispose();
});

test('B4：terminal 工具同样有 snippet/guidelines（何时用常驻终端 vs bash）', async () => {
  const { pi, ctx } = await mountTerminal(fakeClient().client);
  const def = pi.tools.get(TOOL_NAME);
  assert.ok(def?.promptSnippet, 'terminal has a snippet');
  assert.match(String(def.promptSnippet), /persistent shell in its own pane/);
  const g = (def.promptGuidelines ?? []).join(' ');
  assert.match(g, /Prefer bash for one-shot commands/);
  assert.match(g, /dev servers|server, REPL/);
  assert.match(g, /Close the terminal/);
  await ctx.fiber.dispose();
});

test('Herdr 0.9.1: terminal list incorporates terminalTitleStripped into listing', async () => {
  const { client } = fakeClient({});
  client.listPanes = async () => [
    { paneId: 'pane-2', tabId: 't1', workspaceId: 'w1', agentStatus: 'idle', terminalTitleStripped: 'npm run dev' },
  ];
  const { pi, ctx } = await mountTerminal(client);
  await run(pi, { action: 'open', cwd: '/test/cwd' });
  const listRes = (await run(pi, { action: 'list' })) as { content: Array<{ text: string }> };
  assert.match(listRes.content[0].text, /title="npm run dev"/);
  await ctx.fiber.dispose();
});

