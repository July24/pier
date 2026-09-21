/**
 * renderers: ANSI-aware clipping and the transcript line builders, exercised through the public
 * seam (`installRenderers` registers them on the host).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { charWidth, styledWidth, truncateStyled } from '../src/ansi-text.ts';
import {
  APPROVAL_NEEDED_CUSTOM_TYPE, ROLE_MANIFEST_CUSTOM_TYPE, installRenderers, type RenderComponent, type RenderTheme,
} from '../src/renderers.ts';
import { TODO_EDIT_CUSTOM_TYPE } from '../src/todo-core.ts';
import { SUBS_CUSTOM_TYPE } from '../src/subagent-core.ts';
import { TERMINALS_CUSTOM_TYPE, TERM_REMINDER_CUSTOM_TYPE } from '../src/terminal-core.ts';
import { TODO_REMINDER_CUSTOM_TYPE } from '../src/todo-reminder-core.ts';

/** Plain theme: styling is identity, so expectations read as the raw text. */
const plain: RenderTheme = { fg: (_c, t) => t, bold: (t) => t };
/** Marker theme: exposes which colors the builders request. */
const marker: RenderTheme = { fg: (c, t) => `[${c}]${t}`, bold: (t) => `**${t}**` };

type EntryRenderer = (entry: unknown, options: { expanded: boolean }, theme: RenderTheme) => RenderComponent;
type MessageRenderer = (message: unknown, options: { expanded: boolean }, theme: RenderTheme) => RenderComponent;

interface Harness { entries: Map<string, EntryRenderer>; messages: Map<string, MessageRenderer> }

function install(): Harness {
  const entries = new Map<string, EntryRenderer>();
  const messages = new Map<string, MessageRenderer>();
  installRenderers({
    registerEntryRenderer: (type: string, renderer: EntryRenderer) => { entries.set(type, renderer); },
    registerMessageRenderer: (type: string, renderer: MessageRenderer) => { messages.set(type, renderer); },
  });
  return { entries, messages };
}

/** Render one card through the installed seam; `expanded` mirrors pi's ctrl+o state. */
function entryLines(type: string, data: unknown, expanded = false, theme = plain, width = 200): string[] {
  const renderer = install().entries.get(type);
  assert.ok(renderer, `${type} should be registered`);
  return renderer({ customType: type, data }, { expanded }, theme).render(width);
}

function messageLines(type: string, message: unknown, expanded = false): string[] {
  const renderer = install().messages.get(type);
  assert.ok(renderer, `${type} should be registered`);
  return renderer(message, { expanded }, plain).render(200);
}

/* ── width handling (ansi-text, reused by the card wrapper) ─────────── */

test('width helpers: escapes are zero-width, wide glyphs take two cells, control/combining take none', () => {
  assert.equal(styledWidth('abc'), 3);
  assert.equal(styledWidth('\x1b[31mred\x1b[0m and \x1b[1mbold\x1b[0m'), 'red and bold'.length);
  assert.equal(charWidth(0x41), 1);
  assert.equal(charWidth(0x4e2d), 2); // 中
  assert.equal(charWidth(0x1f680), 2); // 🚀
  assert.equal(charWidth(0x0301), 0); // combining acute
  assert.equal(charWidth(0x0a), 0);

  // truncateStyled: passthrough when it fits, ellipsis otherwise, escapes survive the cut
  assert.equal(truncateStyled('short', 10), 'short');
  assert.equal(styledWidth(truncateStyled('0123456789', 5)), 5);
  assert.equal(truncateStyled('anything', 0), '');
  assert.equal(styledWidth(truncateStyled('中中中中中', 5)), 5);
  const clipped = truncateStyled(`\x1b[32m${'ab'.repeat(20)}\x1b[0m`, 8);
  assert.equal(styledWidth(clipped), 8);
  assert.equal(clipped.startsWith('\x1b[32m'), true);
});

test('every card clips its lines to the requested width', () => {
  const cases: Array<[string, unknown]> = [
    [TODO_EDIT_CUSTOM_TYPE, { edits: [{ op: 'done', content: 'x'.repeat(200) }] }],
    [SUBS_CUSTOM_TYPE, { version: 2, subs: [{ paneId: 'wD:p4', status: 'running', description: 'y'.repeat(200) }] }],
    [TERMINALS_CUSTOM_TYPE, { version: 1, terminals: [{ paneId: 'wD:p9', label: 'z'.repeat(200), cwd: '/repo' }] }],
    [ROLE_MANIFEST_CUSTOM_TYPE, { role: 'worker-default', manifestVersion: 'v1', tools: ['read'], permissions: { read: 'allow' } }],
    [APPROVAL_NEEDED_CUSTOM_TYPE, { role: 'worker', tool: 'bash' }],
  ];
  for (const [type, data] of cases) {
    const lines = entryLines(type, data, true, plain, 12);
    assert.ok(lines.every((line) => styledWidth(line) <= 12), `${type}: ${JSON.stringify(lines)}`);
  }
  const wrapped = entryLines(TODO_EDIT_CUSTOM_TYPE, cases[0]![1], true, plain, 12);
  assert.ok(wrapped.length > 1, 'an over-long payload wraps before each row is clipped');
});

/* ── line builders ─────────────────────────────────────────────────── */

interface RenderCase {
  name: string;
  kind: 'entry' | 'message';
  type: string;
  data?: unknown;
  expanded?: boolean;
  theme?: RenderTheme;
  expect: string[];
}

const CASES: RenderCase[] = [
  { name: 'todo edit collapsed (marker theme)', kind: 'entry', type: TODO_EDIT_CUSTOM_TYPE, theme: marker, data: { edits: [{ op: 'done', content: 'ship it' }, { op: 'done', content: 'again' }, { op: 'rm', content: 'stale' }] }, expect: ['[accent]**todo** [dim]· 3 edits ✓ done ×2 · ✗ removed'] },
  { name: 'todo edit expanded', kind: 'entry', type: TODO_EDIT_CUSTOM_TYPE, expanded: true, data: { edits: [{ op: 'done', content: 'ship it' }, { op: 'done', content: 'again' }, { op: 'rm', content: 'stale' }] }, expect: ['todo · 3 edits ✓ done ×2 · ✗ removed', '  ✓ done — ship it', '  ✓ done — again', '  ✗ removed — stale'] },
  { name: 'todo edit singular', kind: 'entry', type: TODO_EDIT_CUSTOM_TYPE, data: { edits: [{ op: 'done', content: 'ship it' }] }, expect: ['todo · 1 edit ✓ done'] },
  { name: 'todo edit malformed: undefined', kind: 'entry', type: TODO_EDIT_CUSTOM_TYPE, expanded: true, expect: ['todo · no edits'] },
  { name: 'todo edit malformed: empty object', kind: 'entry', type: TODO_EDIT_CUSTOM_TYPE, expanded: true, data: {}, expect: ['todo · no edits'] },
  { name: 'todo edit malformed: no edits', kind: 'entry', type: TODO_EDIT_CUSTOM_TYPE, expanded: true, data: { edits: [] }, expect: ['todo · no edits'] },
  { name: 'todo edit malformed: edits not a list', kind: 'entry', type: TODO_EDIT_CUSTOM_TYPE, expanded: true, data: { edits: 'nope' }, expect: ['todo · no edits'] },
  { name: 'subagents collapsed', kind: 'entry', type: SUBS_CUSTOM_TYPE, data: { version: 2, subs: [{ paneId: 'wD:p4', status: 'running', description: 'workbench upgrade' }, { paneId: 'wD:p5', status: 'settled', description: 'poll-loop tests' }] }, expect: ['subagents · 2 tracked 1 running'] },
  { name: 'subagents expanded', kind: 'entry', type: SUBS_CUSTOM_TYPE, expanded: true, data: { version: 2, subs: [{ paneId: 'wD:p4', status: 'running', description: 'workbench upgrade' }, { paneId: 'wD:p5', status: 'settled', description: 'poll-loop tests' }] }, expect: ['subagents · 2 tracked 1 running', '  ● wD:p4 · running · workbench upgrade', '  ○ wD:p5 · settled · poll-loop tests'] },
  { name: 'subagents empty list', kind: 'entry', type: SUBS_CUSTOM_TYPE, data: { version: 2, subs: [] }, expect: ['subagents · none'] },
  { name: 'subagents undefined data', kind: 'entry', type: SUBS_CUSTOM_TYPE, expect: ['subagents · none'] },
  { name: 'terminals collapsed', kind: 'entry', type: TERMINALS_CUSTOM_TYPE, data: { version: 1, terminals: [{ paneId: 'wD:p9', label: 'dev server', cwd: '/repo' }, { paneId: 'wD:p8', cwd: '/tmp' }] }, expect: ['terminals · 2 open'] },
  { name: 'terminals expanded (label, else cwd)', kind: 'entry', type: TERMINALS_CUSTOM_TYPE, expanded: true, data: { version: 1, terminals: [{ paneId: 'wD:p9', label: 'dev server', cwd: '/repo' }, { paneId: 'wD:p8', cwd: '/tmp' }] }, expect: ['terminals · 2 open', '  wD:p9 · dev server', '  wD:p8 · /tmp'] },
  { name: 'terminals empty data', kind: 'entry', type: TERMINALS_CUSTOM_TYPE, data: {}, expect: ['terminals · none'] },
  { name: 'role manifest (marker theme)', kind: 'entry', type: ROLE_MANIFEST_CUSTOM_TYPE, theme: marker, data: { role: 'worker-default', manifestVersion: 'v1', tools: ['read', 'bash', 'write'], permissions: { bash: 'deny', write: 'ask', read: 'allow' } }, expect: ['[accent]**role** worker-default [dim]vv1 · 3 tools[warning] · 2 gated'] },
  { name: 'role manifest switched', kind: 'entry', type: ROLE_MANIFEST_CUSTOM_TYPE, theme: marker, data: { role: 'worker-default', manifestVersion: 'v1', tools: ['read', 'bash', 'write'], permissions: { bash: 'deny', write: 'ask', read: 'allow' }, origin: 'switch', switchedBy: 'p-master' }, expect: ['[accent]**role** worker-default [dim]vv1 · 3 tools[warning] · 2 gated[accent] ⇄ p-master'] },
  { name: 'role manifest missing', kind: 'entry', type: ROLE_MANIFEST_CUSTOM_TYPE, expect: ['role ? v? · 0 tools'] },
  { name: 'approval needed', kind: 'entry', type: APPROVAL_NEEDED_CUSTOM_TYPE, data: { role: 'worker', tool: 'bash' }, expect: ['⚠ approval needed · bash (worker)'] },
  { name: 'approval needed without a tool', kind: 'entry', type: APPROVAL_NEEDED_CUSTOM_TYPE, data: {}, expect: ['⚠ approval needed · ? (?)'] },
  { name: 'todo reminder collapsed', kind: 'message', type: TODO_REMINDER_CUSTOM_TYPE, data: { content: 'Reminder 1/3: you stopped with unfinished todos\nsecond line' }, expect: ['↻ todo reminder', '  Reminder 1/3: you stopped with unfinished todos'] },
  { name: 'todo reminder expanded', kind: 'message', type: TODO_REMINDER_CUSTOM_TYPE, expanded: true, data: { content: 'Reminder 1/3: you stopped with unfinished todos\nsecond line' }, expect: ['↻ todo reminder', 'Reminder 1/3: you stopped with unfinished todos', 'second line'] },
  { name: 'terminal nudge with empty content', kind: 'message', type: TERM_REMINDER_CUSTOM_TYPE, data: {}, expect: ['↻ terminal nudge', '  terminal nudge'] },
];

test('card renderers: each custom type renders its lines', async (t) => {
  for (const c of CASES) {
    await t.test(c.name, () => {
      const lines = c.kind === 'entry'
        ? entryLines(c.type, c.data, c.expanded ?? false, c.theme ?? plain)
        : messageLines(c.type, c.data, c.expanded ?? false);
      assert.deepEqual(lines, c.expect);
    });
  }
});

/* ── installation ──────────────────────────────────────────────────── */

test('installRenderers: registers every pier custom type when the host API exists', () => {
  const harness = install();
  assert.deepEqual([...harness.entries.keys()], [TODO_EDIT_CUSTOM_TYPE, SUBS_CUSTOM_TYPE, TERMINALS_CUSTOM_TYPE, ROLE_MANIFEST_CUSTOM_TYPE, APPROVAL_NEEDED_CUSTOM_TYPE]);
  assert.deepEqual([...harness.messages.keys()], [TODO_REMINDER_CUSTOM_TYPE, TERM_REMINDER_CUSTOM_TYPE]);
});

test('installRenderers: a missing API registers nothing, a throwing host is contained per type', () => {
  assert.deepEqual(installRenderers({}), []);

  let calls = 0;
  const registered = installRenderers({
    registerEntryRenderer: () => {
      calls += 1;
      throw new Error('boom');
    },
    registerMessageRenderer: () => {
      calls += 1;
    },
  });
  assert.equal(calls, 7, 'one throwing registration must not skip the rest');
  assert.deepEqual(registered, [TODO_REMINDER_CUSTOM_TYPE, TERM_REMINDER_CUSTOM_TYPE]);
});
