/**
 * renderers: ANSI-aware clipping and the transcript line builders, exercised through the public
 * seam (`installRenderers` registers them on the host) plus best-effort registration behavior.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { charWidth, styledWidth, truncateStyled } from '../src/ansi-text.ts';
import {
  APPROVAL_NEEDED_CUSTOM_TYPE,
  ROLE_MANIFEST_CUSTOM_TYPE,
  installRenderers,
  type RenderComponent,
  type RenderTheme,
} from '../src/renderers.ts';
import { TODO_EDIT_CUSTOM_TYPE } from '../src/todo-core.ts';
import { SUBS_CUSTOM_TYPE } from '../src/subagent-core.ts';
import { TERMINALS_CUSTOM_TYPE, TERM_REMINDER_CUSTOM_TYPE } from '../src/terminal-core.ts';
import { TODO_REMINDER_CUSTOM_TYPE } from '../src/todo-reminder-core.ts';

/** Plain theme: styling is identity, so assertions read the raw text. */
const plain: RenderTheme = { fg: (_c, t) => t, bold: (t) => t };
/** Marker theme: exposes which colors the builders request. */
const marker: RenderTheme = { fg: (c, t) => `[${c}]${t}`, bold: (t) => `**${t}**` };

type EntryRenderer = (entry: unknown, options: { expanded: boolean }, theme: RenderTheme) => RenderComponent;
type MessageRenderer = (message: unknown, options: { expanded: boolean }, theme: RenderTheme) => RenderComponent;

interface Harness {
  entries: Map<string, EntryRenderer>;
  messages: Map<string, MessageRenderer>;
  registered: string[];
}

function install(): Harness {
  const entries = new Map<string, EntryRenderer>();
  const messages = new Map<string, MessageRenderer>();
  const registered = installRenderers({
    registerEntryRenderer: (type: string, renderer: EntryRenderer) => { entries.set(type, renderer); },
    registerMessageRenderer: (type: string, renderer: MessageRenderer) => { messages.set(type, renderer); },
  });
  return { entries, messages, registered };
}

/** Render one entry card; `expanded` mirrors pi's ctrl+o state. */
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
});

test('truncateStyled: passthrough when it fits, ellipsis otherwise, escapes survive the cut', () => {
  assert.equal(truncateStyled('short', 10), 'short');
  assert.equal(styledWidth(truncateStyled('0123456789', 5)), 5);
  assert.equal(truncateStyled('anything', 0), '');
  assert.equal(styledWidth(truncateStyled('中中中中中', 5)), 5);
  const styled = `\x1b[32m${'ab'.repeat(20)}\x1b[0m`;
  const clipped = truncateStyled(styled, 8);
  assert.equal(styledWidth(clipped), 8);
  assert.equal(clipped.startsWith('\x1b[32m'), true);
});

test('every card clips its lines to the requested width', () => {
  const data = { edits: [{ op: 'done', content: 'x'.repeat(200) }] };
  const lines = entryLines(TODO_EDIT_CUSTOM_TYPE, data, true, plain, 12);
  assert.ok(lines.length > 1);
  assert.ok(lines.every((line) => styledWidth(line) <= 12), JSON.stringify(lines));
});

/* ── line builders ─────────────────────────────────────────────────── */

test('todo edit card: collapsed shows the summary, expanded adds one line per edit', () => {
  const data = {
    edits: [{ op: 'done', content: 'ship it' }, { op: 'done', content: 'again' }, { op: 'rm', content: 'stale' }],
  };
  const collapsed = entryLines(TODO_EDIT_CUSTOM_TYPE, data, false, marker);
  assert.equal(collapsed.length, 1);
  assert.match(collapsed[0]!, /\[accent\]\*\*todo\*\*/);
  assert.match(collapsed[0]!, /3 edits/);
  assert.match(collapsed[0]!, /✓ done ×2 · ✗ removed/, 'verbs and repeats are mapped');

  const expanded = entryLines(TODO_EDIT_CUSTOM_TYPE, data, true);
  assert.equal(expanded.length, 4);
  assert.match(expanded[1]!, /done — ship it/);
  assert.match(expanded[3]!, /removed — stale/);

  const single = entryLines(TODO_EDIT_CUSTOM_TYPE, { edits: [{ op: 'done', content: 'ship it' }] });
  assert.match(single[0]!, /1 edit\b/);
});

test('todo edit card: malformed payloads render a single placeholder line', () => {
  for (const data of [undefined, {}, { edits: [] }, { edits: 'nope' }]) {
    const lines = entryLines(TODO_EDIT_CUSTOM_TYPE, data, true);
    assert.equal(lines.length, 1, JSON.stringify(data));
    assert.match(lines[0]!, /no edits/);
  }
});

test('subagent registry card: tracked/running counts, then one row per entry', () => {
  const data = {
    version: 2,
    subs: [
      { paneId: 'wD:p4', status: 'running', description: 'workbench upgrade' },
      { paneId: 'wD:p5', status: 'settled', description: 'poll-loop tests' },
    ],
  };
  const head = entryLines(SUBS_CUSTOM_TYPE, data);
  assert.equal(head.length, 1);
  assert.match(head[0]!, /2 tracked/);
  assert.match(head[0]!, /1 running/);

  const expanded = entryLines(SUBS_CUSTOM_TYPE, data, true);
  assert.equal(expanded.length, 3);
  assert.match(expanded[1]!, /● wD:p4 · running/);
  assert.match(expanded[2]!, /○ wD:p5 · settled/);

  assert.match(entryLines(SUBS_CUSTOM_TYPE, { version: 2, subs: [] })[0]!, /none/);
  assert.match(entryLines(SUBS_CUSTOM_TYPE, undefined)[0]!, /none/);
});

test('terminal registry card: open count and label/cwd per pane', () => {
  const data = { version: 1, terminals: [{ paneId: 'wD:p9', label: 'dev server', cwd: '/repo' }, { paneId: 'wD:p8', cwd: '/tmp' }] };
  assert.match(entryLines(TERMINALS_CUSTOM_TYPE, data)[0]!, /2 open/);
  const expanded = entryLines(TERMINALS_CUSTOM_TYPE, data, true);
  assert.match(expanded[1]!, /wD:p9 · dev server/);
  assert.match(expanded[2]!, /wD:p8 · \/tmp/, 'a pane without a label falls back to its cwd');
  assert.match(entryLines(TERMINALS_CUSTOM_TYPE, {})[0]!, /none/);
});

test('role manifest card: role, version, tool count, gated count and switch provenance', () => {
  const theme = marker;
  const plainRole = { role: 'worker-default', manifestVersion: 'v1', tools: ['read', 'bash', 'write'], permissions: { bash: 'deny', write: 'ask', read: 'allow' } };
  const line = entryLines(ROLE_MANIFEST_CUSTOM_TYPE, plainRole, false, theme)[0]!;
  assert.match(line, /\[accent\]\*\*role\*\*/);
  assert.match(line, /worker-default/);
  assert.match(line, /v1 · 3 tools/);
  assert.match(line, /\[warning\] · 2 gated/);

  const switched = entryLines(ROLE_MANIFEST_CUSTOM_TYPE, { ...plainRole, origin: 'switch', switchedBy: 'p-master' }, false, theme)[0]!;
  assert.match(switched, /⇄ p-master/);
  assert.equal(entryLines(ROLE_MANIFEST_CUSTOM_TYPE, plainRole, false, theme)[0]!.includes('⇄'), false);

  assert.match(entryLines(ROLE_MANIFEST_CUSTOM_TYPE, undefined)[0]!, /role \? v\? · 0 tools/);
});

test('approval card and reminder cards: tool/role pair, collapsed preview, expanded body', () => {
  assert.match(entryLines(APPROVAL_NEEDED_CUSTOM_TYPE, { role: 'worker', tool: 'bash' })[0]!, /approval needed · bash \(worker\)/);
  assert.match(entryLines(APPROVAL_NEEDED_CUSTOM_TYPE, {})[0]!, /· \? \(\?\)/);

  const message = { content: 'Reminder 1/3: you stopped with unfinished todos\nsecond line' };
  const collapsed = messageLines(TODO_REMINDER_CUSTOM_TYPE, message);
  assert.equal(collapsed.length, 2);
  assert.match(collapsed[0]!, /↻ todo reminder/);
  assert.match(collapsed[1]!, /Reminder 1\/3/);
  const expanded = messageLines(TODO_REMINDER_CUSTOM_TYPE, message, true);
  assert.equal(expanded.length, 3);
  assert.match(expanded[2]!, /second line/);

  // Empty content falls back to the label so the row is never blank.
  assert.match(messageLines(TERM_REMINDER_CUSTOM_TYPE, {})[1]!, /terminal nudge/);
});

/* ── installation ──────────────────────────────────────────────────── */

test('installRenderers: registers every pier custom type when the host API exists', () => {
  const harness = install();
  assert.deepEqual([...harness.entries.keys()], [
    TODO_EDIT_CUSTOM_TYPE,
    SUBS_CUSTOM_TYPE,
    TERMINALS_CUSTOM_TYPE,
    ROLE_MANIFEST_CUSTOM_TYPE,
    APPROVAL_NEEDED_CUSTOM_TYPE,
  ]);
  assert.deepEqual([...harness.messages.keys()], [TODO_REMINDER_CUSTOM_TYPE, TERM_REMINDER_CUSTOM_TYPE]);
  assert.equal(harness.registered.length, 7);
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
