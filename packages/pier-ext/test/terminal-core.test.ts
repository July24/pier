/**
 * M14：terminal-core 纯规划器（D71 / T1–T6）。
 * 缝：注册表 / 校验 / ANSI / 读增量 / readiness / 会话汇总 / 分支折叠。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_TERMINALS,
  POSIX_PROMPT,
  POWERSHELL_PROMPT,
  PROMPT_TAIL_RE,
  SIGNAL_KEYS,
  TERMINALS_CUSTOM_TYPE,
  classifyReadiness,
  closeTerminal,
  computeIncrement,
  detectFullscreenTUI,
  foldTerminalsRegistry,
  makeTerminalsRegistry,
  nextTerminalId,
  promptStrategyFor,
  registerTerminal,
  stripAnsi,
  summarizeSessions,
  validateSendText,
  validateSignal,
  type TerminalEntry,
} from '../src/terminal-core.ts';

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

/* ── 注册表 ─────────────────────────────────────────────────────── */

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
  assert.equal(again.entries[0].closedAt, 2000); // 幂等：不覆盖
  assert.equal(closeTerminal([], 'term-x', 1).entries.length, 0);
});

/* ── T6 检测：send / signal ────────────────────────────────────── */

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

/* ── T6 检测：全屏 TUI（alternate screen） ─────────────────────── */

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

/* ── 读增量（环形缓冲语义） ─────────────────────────────────────── */

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
  // 再读一次无变化 → none
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

/* ── T3 readiness 两档 + busy ──────────────────────────────────── */

test('classifyReadiness：PS1 尾匹配 → prompt；静默期 → silent；否则 busy', () => {
  assert.equal(classifyReadiness('PS F:\\work> ', { silentMs: 100 }), 'prompt');
  assert.equal(classifyReadiness('user@host:~$ ', { silentMs: 100 }), 'prompt');
  assert.equal(classifyReadiness('compiling...', { silentMs: 3000 }), 'silent');
  assert.equal(classifyReadiness('compiling...', { silentMs: 100 }), 'busy');
  assert.equal(PROMPT_TAIL_RE.test('PS F:\\work> '), true);
});

test('promptStrategyFor: default posix; env selects powershell', () => {
  assert.equal(promptStrategyFor({}).waitPattern, POSIX_PROMPT.waitPattern);
  assert.equal(promptStrategyFor({ PIER_TERMINAL_PROMPT: 'powershell' }), POWERSHELL_PROMPT);
  assert.equal(classifyReadiness('PS F:\\work> ', { silentMs: 100, prompt: POWERSHELL_PROMPT }), 'prompt');
});

/* ── 会话汇总（T6 跨重启边界） ─────────────────────────────────── */

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

/* ── 持久化（custom 条目 last-wins） ───────────────────────────── */

test('makeTerminalsRegistry / foldTerminalsRegistry：往返 + last-wins', () => {
  const entries = [mkEntry({ terminalId: 'term-1' })];
  const payload = makeTerminalsRegistry(entries);
  const branch = [
    { type: 'custom', customType: TERMINALS_CUSTOM_TYPE, data: payload },
    { type: 'custom', customType: TERMINALS_CUSTOM_TYPE, data: makeTerminalsRegistry([]) },
  ];
  const folded = foldTerminalsRegistry(branch);
  assert.equal(folded.length, 0); // 后一条（清空）胜出
  const single = foldTerminalsRegistry([
    { type: 'custom', customType: TERMINALS_CUSTOM_TYPE, data: payload },
  ]);
  assert.equal(single.length, 1);
  assert.equal(single[0].terminalId, 'term-1');
  assert.equal(single[0].cwd, 'F:/work');
});
