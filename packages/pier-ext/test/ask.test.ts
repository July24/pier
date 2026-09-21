/**
 * ask_user_question: param normalization and its model-visible error text, the unified pier dialog
 * (state machine, rendering, key handling, the ui.custom bridge) and the runAsk envelope paths.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { styledWidth } from '../src/ansi-text.ts';
import {
  OTHER_ROW_LABEL, RECOMMENDED_SUFFIX, createDialogComponent, createDialogState, dialogFooter,
  dialogLines, isOtherRow, resolveDialogKey, rowCount, runSelectDialog, selectedLabels, stepDialog,
  type DialogConfig, type DialogOutcome, type DialogState, type KeybindingsLike, type MinimalTheme,
} from '../src/ask-dialog.ts';
import {
  DECLINE_TEXT, formatAskContent, gateLabel, hasAskUi, noUiResult, optionLines, parseChoice,
  prepareAsk, runAsk, type AskAnswer, type AskQuestion, type AskSpec, type AskUi,
} from '../src/ask-user.ts';

const plain: MinimalTheme = { fg: (_c, t) => t, bold: (t) => t };

const multi = (over: Partial<DialogConfig> = {}): DialogConfig => ({
  options: [{ label: 'alpha' }, { label: 'beta', description: 'second' }, { label: 'gamma' }],
  allowOther: true, multi: true, ...over,
});
const single = (over: Partial<DialogConfig> = {}): DialogConfig => multi({ multi: false, ...over });

type Key = Parameters<typeof stepDialog>[1];

const feed = (state: DialogState, keys: Key[], cfg: DialogConfig): DialogState => {
  let current = state;
  for (const key of keys) current = stepDialog(current, key, cfg).state;
  return current;
};

/** Keybindings stub mirroring pi's defaults for the tui.select.* actions. */
const kb: KeybindingsLike = {
  matches: (data, id) => {
    switch (id) {
      case 'tui.select.up': return ['\x1b[A', '\x1bOA'].includes(data);
      case 'tui.select.down': return ['\x1b[B', '\x1bOB'].includes(data);
      case 'tui.select.confirm': return data === '\r';
      case 'tui.select.cancel': return data === '\x1b' || data === '\x03';
      default: return false;
    }
  },
  getKeys: (id) => (id === 'tui.select.confirm' ? ['enter'] : id === 'tui.select.cancel' ? ['escape', 'ctrl+c'] : []),
};

test('rowCount/isOtherRow count the Other row only while it is offered', () => {
  const cfg = multi();
  assert.equal(rowCount(cfg), 4);
  assert.equal(rowCount(multi({ allowOther: false })), 3);
  assert.equal(isOtherRow({ cursor: 3, selected: [false, false, false] }, cfg), true);
  assert.equal(isOtherRow({ cursor: 2, selected: [false, false, false] }, cfg), false);
});

test('cursor wraps in both directions and never reaches a hidden Other row', () => {
  const cfg = multi();
  const top = feed(createDialogState(cfg), ['up'], cfg);
  assert.equal(top.cursor, 3);
  assert.equal(stepDialog(top, 'down', cfg).state.cursor, 0);
  assert.equal(stepDialog(createDialogState(cfg), 'down', cfg).state.cursor, 1);
  const hidden = multi({ allowOther: false });
  assert.equal(feed(createDialogState(hidden), ['up'], hidden).cursor, 2);
});

test('escape cancels and an empty configuration stays inert', () => {
  const noOptions: DialogConfig = { options: [], allowOther: false, multi: true };
  const cfg = multi();
  assert.deepEqual(stepDialog(createDialogState(cfg), 'cancel', cfg).outcome, { kind: 'cancel' });
  assert.deepEqual(stepDialog(createDialogState(noOptions), 'cancel', noOptions).outcome, { kind: 'cancel' });
  assert.equal(stepDialog(createDialogState(noOptions), 'down', noOptions).outcome, undefined);
});

test('recommended seeds the cursor in both modes, checks the row in multi, and ignores out-of-range values', () => {
  const cfg = multi({ recommended: 1 });
  const state = createDialogState(cfg);
  assert.equal(state.cursor, 1);
  // A bare enter agrees with single mode's "take the recommendation".
  assert.deepEqual(stepDialog(state, 'confirm', cfg).outcome, { kind: 'selected', labels: ['beta'] });
  const one = single({ recommended: 2 });
  const singleState = createDialogState(one);
  assert.equal(singleState.cursor, 2);
  assert.deepEqual(selectedLabels(singleState, one), []);
  assert.deepEqual(stepDialog(singleState, 'confirm', one).outcome, { kind: 'selected', labels: ['gamma'] });
  const outOfRange = multi({ recommended: 9 });
  assert.equal(createDialogState(outOfRange).cursor, 0);
  assert.deepEqual(selectedLabels(createDialogState(outOfRange), outOfRange), []);
});

/** Keys are fed from a fresh state; the last step's outcome plus the resulting labels/cursor are checked. */
type GrammarCase = { name: string; config: DialogConfig; keys: Key[]; outcome?: DialogOutcome; labels?: string[]; cursor?: number };
const GRAMMAR_CASES: GrammarCase[] = [
  { name: 'multi: space toggles only the cursor row and keeps selection order', config: multi(), keys: ['down', 'down', 'toggle', 'up', 'up', 'toggle'], labels: ['alpha', 'gamma'] },
  { name: 'multi: space untoggles the cursor row', config: multi(), keys: ['down', 'down', 'toggle', 'up', 'up', 'toggle', 'toggle'], labels: ['gamma'] },
  { name: 'multi: space on the Other row opens free text like enter', config: multi(), keys: ['up', 'toggle'], outcome: { kind: 'other' } },
  { name: 'multi: enter on the Other row opens free text', config: multi(), keys: ['up', 'confirm'], outcome: { kind: 'other' } },
  { name: 'multi: a toggles everything on', config: multi(), keys: ['all'], labels: ['alpha', 'beta', 'gamma'] },
  { name: 'multi: a toggles everything off again', config: multi(), keys: ['all', 'all'], labels: [] },
  { name: 'pick-one: a is a no-op', config: single(), keys: ['all'], labels: [], cursor: 0 },
  { name: 'multi: enter confirms the toggles, including an empty selection', config: multi({ recommended: undefined }), keys: ['confirm'], outcome: { kind: 'selected', labels: [] } },
  { name: 'multi: enter confirms the toggle set', config: multi({ recommended: undefined }), keys: ['toggle', 'down', 'toggle', 'confirm'], outcome: { kind: 'selected', labels: ['alpha', 'beta'] } },
  { name: 'multi: a single-option confirm returns that option', config: multi({ options: [{ label: 'only' }] }), keys: ['confirm'], outcome: { kind: 'selected', labels: ['only'] } },
  { name: 'pick-one: enter returns the cursor row, never the toggle set', config: single(), keys: ['down', 'down', 'confirm'], outcome: { kind: 'selected', labels: ['gamma'] } },
  { name: 'pick-one: space is an alias for enter', config: single(), keys: ['toggle'], outcome: { kind: 'selected', labels: ['alpha'] } },
  { name: 'pick-one: enter on the Other row opens free text', config: single(), keys: ['up', 'confirm'], outcome: { kind: 'other' } },
  { name: 'pick-one: space on the Other row opens free text', config: single(), keys: ['up', 'toggle'], outcome: { kind: 'other' } },
];

test('stepDialog key grammar', async (t) => {
  for (const c of GRAMMAR_CASES) {
    await t.test(c.name, () => {
      let state = createDialogState(c.config);
      let outcome: DialogOutcome | undefined;
      for (const [i, key] of c.keys.entries()) {
        const step = stepDialog(state, key, c.config);
        state = step.state;
        if (i < c.keys.length - 1) assert.equal(step.outcome, undefined, `key ${i} (${key}) ended the dialog early`);
        outcome = step.outcome;
      }
      assert.deepEqual(outcome, c.outcome);
      if (c.labels) assert.deepEqual(selectedLabels(state, c.config), c.labels);
      if (c.cursor !== undefined) assert.equal(state.cursor, c.cursor);
    });
  }
});

test('resolveDialogKey understands host bindings, literals and fallback sequences', () => {
  // Host bindings path; the literals pi's own selector shares work with and without them.
  const HOST: Array<readonly [string, string]> = [
    ['\x1b[A', 'up'], ['\x1b[B', 'down'], ['\r', 'confirm'], ['\x03', 'cancel'], ['k', 'up'], ['j', 'down'], [' ', 'toggle'], ['a', 'all'],
  ];
  for (const [data, key] of HOST) assert.equal(resolveDialogKey(data, kb), key, `host: ${JSON.stringify(data)}`);
  // No keybindings manager: the built-in sequences still resolve.
  for (const [data, key] of [['\x1bOA', 'up'], ['\n', 'confirm'], ['\x1b', 'cancel'], ['k', 'up']] as const) {
    assert.equal(resolveDialogKey(data, undefined), key, `fallback: ${JSON.stringify(data)}`);
  }
  assert.equal(resolveDialogKey('x', kb), 'ignore');
});

const ROW_CASES: Array<{ name: string; config: DialogConfig; keys: Key[]; lines: string[] }> = [
  { name: 'multi rows mark the cursor, toggles, recommendation and description', config: multi({ recommended: 1 }), keys: [],
    lines: ['  [ ] alpha', '→ [x] beta (Recommended) — second', '  [ ] gamma', '  [ ] Other (type your own)'] },
  { name: 'pick-one rows highlight the cursor row and carry no checkboxes', config: single({ recommended: 1 }), keys: ['down', 'down'],
    lines: ['  alpha', '  beta (Recommended) — second', '  gamma', '→ Other (type your own)'] },
  { name: 'the Other row hides when allowOther is false', config: multi({ allowOther: false }), keys: [],
    lines: ['→ [ ] alpha', '  [ ] beta — second', '  [ ] gamma'] },
];

test('dialogLines: cursor, toggles, recommendation and the free-text row', async (t) => {
  for (const c of ROW_CASES) {
    await t.test(c.name, () => {
      assert.deepEqual(dialogLines(feed(createDialogState(c.config), c.keys, c.config), c.config, plain), c.lines);
    });
  }
});

/** `width` is the inner (width-2) the component measures hints against; omitted = unbounded. */
const FOOTER_CASES: Array<{ name: string; config: DialogConfig; keys?: Key[]; width?: number; expected: string }> = [
  { name: 'multi lists the toggle grammar (no count yet)', config: multi(), expected: '↑↓ navigate  space toggle  a all  enter confirm  escape/ctrl+c cancel' },
  { name: 'multi counts the live selection', config: multi(), keys: ['toggle'], expected: '↑↓ navigate  space toggle  a all  enter confirm  escape/ctrl+c cancel · 1 selected' },
  { name: 'pick-one matches the host selector wording and never counts', config: single(), expected: '↑↓ navigate  enter select  escape/ctrl+c cancel' },
  { name: '80-col pane drops a-all only', config: multi(), keys: ['toggle'], width: 80 - 2, expected: '↑↓ navigate  space toggle  enter confirm  escape/ctrl+c cancel · 1 selected' },
  { name: '70-col pane drops a-all then navigate', config: multi(), keys: ['toggle'], width: 70 - 2, expected: 'space toggle  enter confirm  escape/ctrl+c cancel · 1 selected' },
  { name: '58-col pane keeps the action keys and the whole count', config: multi(), keys: ['toggle'], width: 58 - 2, expected: 'space toggle  enter confirm · 1 selected' },
  { name: '40-col pane sheds only the navigate hint for pick-one', config: single(), width: 40 - 2, expected: 'enter select  escape/ctrl+c cancel' },
];

test('dialogFooter: hints, count and the narrow-pane floors', async (t) => {
  for (const c of FOOTER_CASES) {
    await t.test(c.name, () => {
      const state = feed(createDialogState(c.config), c.keys ?? [], c.config);
      assert.equal(dialogFooter(state, c.config, plain, kb, c.width), c.expected);
    });
  }
});

test('component: renders the framed chrome and fits every line to width', () => {
  let outcome: DialogOutcome | null = null;
  const component = createDialogComponent({ title: 'Pick', config: multi(), theme: plain, done: (o) => { outcome = o; } });
  const lines = component.render(40);
  assert.equal(lines.length, 12); // border + gap + title + gap + 4 rows + gap + footer + gap + border
  assert.equal(lines[0], '─'.repeat(40));
  assert.equal(lines[2], ' Pick');
  for (const line of lines) assert.equal(styledWidth(line) <= 40, true);
  component.invalidate();
  assert.equal(outcome, null);
});

test('component: long titles and descriptions wrap inside the frame instead of clipping', () => {
  const component = createDialogComponent({
    title: 'A rather long question that cannot fit on a single narrow line',
    config: multi({ options: [{ label: 'alpha', description: 'a long description that keeps going past the edge of the pane' }], allowOther: false }),
    theme: plain, keybindings: kb, done: () => {},
  });
  const lines = component.render(30);
  for (const line of lines) assert.equal(styledWidth(line) <= 30, true, `line too wide: ${JSON.stringify(line)}`);
  const content = lines.slice(0, lines.length - 3).join('\n'); // exclude footer + gap + border
  // Rows and the title lose nothing: no ellipsis, and the description tail survives.
  assert.equal(content.includes('…'), false);
  assert.equal(content.includes('edge of the pane'), true);
  assert.equal(content.includes('narrow line'), true);
  // The wrapped description continues under its row, aligned by the left margin.
  assert.equal(lines.some((l) => l === ' description that keeps going'), true);
});

/** Raw input chunks in, finished outcomes out; keys after the finish must be ignored. */
const KEY_SEQUENCE_CASES: Array<{ name: string; keys: string[]; outcomes: DialogOutcome[] }> = [
  { name: 'toggles two rows, confirms, then ignores further keys', keys: ['x', ' ', '\x1b[B', ' ', '\r', ' '],
    outcomes: [{ kind: 'selected', labels: ['alpha', 'beta'] }] },
  { name: 'wraps to the Other row and finishes with the other outcome', keys: ['\x1b[A', '\r'], outcomes: [{ kind: 'other' }] },
];

test('component: key sequences drive the state machine and finish once', async (t) => {
  for (const c of KEY_SEQUENCE_CASES) {
    await t.test(c.name, () => {
      const outcomes: DialogOutcome[] = [];
      const component = createDialogComponent({ title: 'Q', config: multi(), theme: plain, keybindings: kb, done: (o) => outcomes.push(o) });
      for (const key of c.keys) component.handleInput(key);
      assert.deepEqual(outcomes, c.outcomes);
    });
  }
});

test('component: aborting the signal cancels exactly once and later keys are ignored', () => {
  const outcomes: DialogOutcome[] = [];
  const controller = new AbortController();
  const component = createDialogComponent({
    title: 'Q', config: multi(), theme: plain, keybindings: kb, signal: controller.signal,
    done: (o) => outcomes.push(o),
  });
  controller.abort();
  controller.abort(); // second abort must not double-finish
  component.handleInput('\r');
  assert.deepEqual(outcomes, [{ kind: 'cancel' }]);
});

test('component: ctrl+o toggles tool expansion without touching the state', () => {
  const expansions: boolean[] = [];
  const keybindings: KeybindingsLike = {
    ...kb,
    matches: (data, id) => (id === 'app.tools.expand' ? data === '\x0f' : kb.matches(data, id)),
  };
  const component = createDialogComponent({
    title: 'Q', config: multi(), theme: plain, keybindings,
    toggleToolsExpanded: () => expansions.push(true),
    done: () => { throw new Error('dialog must not finish'); },
  });
  component.handleInput('\x0f');
  assert.deepEqual(expansions, [true]);
});

type ComponentFactory = (
  tui: unknown, theme: MinimalTheme, keybindings: KeybindingsLike, done: (outcome: DialogOutcome) => void,
) => { handleInput(data: string): void };

test('runSelectDialog: bridges the component through ui.custom, whose done() resolves the call', async () => {
  const outcome = await runSelectDialog((factory) => {
    const { promise, resolve } = Promise.withResolvers<DialogOutcome>();
    const component = (factory as ComponentFactory)({}, plain, kb, resolve);
    component.handleInput(' ');
    component.handleInput('\r');
    return promise;
  }, 'Q', multi());
  assert.deepEqual(outcome, { kind: 'selected', labels: ['alpha'] });
});

test('runSelectDialog: undefined or unrecognized returns from ui.custom (RPC mode) degrade to null', async () => {
  assert.equal(await runSelectDialog(async () => undefined, 'Q', multi()), null);
  assert.equal(await runSelectDialog(async () => 'garbage', 'Q', multi()), null);
});

test('runSelectDialog: an already-aborted signal cancels without opening the dialog', async () => {
  let opened = false;
  const custom = async () => { opened = true; return { kind: 'selected', labels: ['alpha'] }; };
  const outcome = await runSelectDialog(custom, 'Q', multi(), { signal: AbortSignal.abort() });
  assert.deepEqual(outcome, { kind: 'cancel' });
  assert.equal(opened, false);
});

/** Drive the dialog through `ui.custom` the way pi does: build the component, feed keys in, resolve
 *  with whatever finished it — so these tests exercise the real key → outcome path. */
function dialogUi(keys: string[], input = 'typed by hand'): AskUi {
  return {
    input: async () => input,
    custom: async (factory) => {
      let outcome: DialogOutcome | undefined;
      const component = (factory as ComponentFactory)({}, plain, kb, (o) => { outcome = o; });
      for (const key of keys) component.handleInput(key);
      return outcome;
    },
  };
}

test('runAsk: the pier dialog drives both modes and its Other row opens free text', async () => {
  const chosen = specOf({ question: 'Pick', options: [{ label: 'a' }, { label: 'b' }], multi: true });
  const selected = await runAsk(chosen, dialogUi([' ', '\x1b[B', ' ', '\r']));
  assert.deepEqual(selected.details.answers[0]!.selected, ['a', 'b']);

  const questionnaire: AskSpec = { mode: 'questionnaire', questions: [{ question: 'Pick', options: [{ label: 'a' }, { label: 'b' }], multi: false, allowOther: true }] };
  const other = await runAsk(questionnaire, dialogUi(['\x1b[A', '\r']));
  assert.equal(other.details.answers[0]!.kind, 'custom');
  assert.equal(other.details.answers[0]!.customInput, 'typed by hand');
});

test('runAsk: an unusable dialog (RPC mode) falls back to the typed prompt; a declined one cancels', async () => {
  const spec = specOf({ question: 'Pick', options: [{ label: 'a' }, { label: 'b' }] });
  const fallback = await runAsk(spec, { input: async () => '1', custom: async () => undefined });
  assert.deepEqual(fallback.details.answers[0], { question: 'Pick', kind: 'option', answer: 'a' });
  const declined = await runAsk(spec, dialogUi(['\x1b']));
  assert.equal(declined.details.cancelled, true);
});

const REDIS = { label: 'Redis', description: 'In-memory' };
const POSTGRES = { label: 'Postgres', description: 'Relational' };

const q = (over: Partial<AskQuestion> = {}): AskQuestion => ({
  question: 'Which database?', options: [REDIS, POSTGRES], multi: false, allowOther: true, ...over,
});

/** Parse params and return the spec; fails the test when prepareAsk rejects. */
function specOf(params: unknown): AskSpec {
  const parsed = prepareAsk(params);
  if (!parsed.ok) assert.fail(parsed.result.content[0]?.text);
  return parsed.spec;
}

/** Parse a `questions[]` batch, failing the test unless it yields a questionnaire. */
function questionsOf(params: unknown): AskQuestion[] {
  const spec = specOf(params);
  if (spec.mode !== 'questionnaire') assert.fail('expected a questionnaire spec');
  return spec.questions;
}

/** Parse params expecting a rejection; returns the error code plus the model-visible text. */
function failOf(params: unknown): { code: string; text: string } {
  const parsed = prepareAsk(params);
  if (parsed.ok) assert.fail(`expected a validation error, got a ${parsed.spec.mode} spec`);
  return { code: parsed.result.details.error!, text: parsed.result.content[0]!.text };
}

test('prepareAsk: no options → freeform; a blank question is rejected with its error', () => {
  assert.deepEqual(specOf({ question: '  deploy staging?  ' }), { mode: 'freeform', question: 'deploy staging?' });
  const empty = failOf({ question: '   ' });
  assert.equal(empty.code, 'empty_question');
  assert.match(empty.text, /must be a non-empty string/);
});

test('prepareAsk: question+options wrap into one question; questions overrides the top level', () => {
  const wrapped = questionsOf({ question: 'Which database?', options: [REDIS, POSTGRES], recommended: 0 });
  assert.equal(wrapped.length, 1);
  assert.equal(wrapped[0]!.recommended, 0);
  assert.equal(wrapped[0]!.multi, false);

  const batched = questionsOf({
    question: 'ignored?', options: [REDIS, POSTGRES],
    questions: [{ question: 'Cache?', options: [REDIS, POSTGRES] }, { question: 'SQL?', options: [POSTGRES, REDIS], multi: true }],
  });
  assert.deepEqual(batched.map((item) => item.question), ['Cache?', 'SQL?']);
  assert.equal(batched[1]?.multi, true);
});

const INVALID_CASES: Array<{ name: string; params: unknown; code: string; text: RegExp }> = [
  { name: 'reserved Other label', params: { question: 'Q?', options: [REDIS, { label: 'Other', description: 'x' }] }, code: 'reserved_label', text: /reserved/ },
  { name: 'fewer than two options', params: { question: 'Q?', options: [REDIS] }, code: 'empty_options', text: /needs 2-5 options/ },
  { name: 'duplicate option label', params: { question: 'Q?', options: [REDIS, REDIS] }, code: 'duplicate_option_label', text: /duplicate option label/ },
  { name: 'duplicate question', params: { questions: [{ question: 'Same?', options: [REDIS, POSTGRES] }, { question: 'Same?', options: [REDIS, POSTGRES] }] }, code: 'duplicate_question', text: /duplicate question/ },
  { name: 'more than four questions', params: { questions: ['A?', 'B?', 'C?', 'D?', 'E?'].map((question) => ({ question, options: [REDIS, POSTGRES] })) }, code: 'too_many_questions', text: /1-4 entries/ },
];

test('prepareAsk: validation errors carry the code and the text the model reads', async (t) => {
  for (const c of INVALID_CASES) {
    await t.test(c.name, () => {
      const failed = failOf(c.params);
      assert.equal(failed.code, c.code);
      assert.match(failed.text, c.text);
    });
  }
});

test('prepareAsk: the (Recommended) marker the model repeats is stripped, only at the end', () => {
  const STRIP_CASES = [{ label: 'Redis (Recommended)', expected: 'Redis' }, { label: 'Pick me [recommended]', expected: 'Pick me' }];
  for (const c of STRIP_CASES) {
    const [question] = questionsOf({ question: 'Which store?', options: [{ label: c.label }, { label: 'Postgres' }] });
    assert.equal(question!.options[0]!.label, c.expected);
  }
  // The marker renders exactly once, on the recommended row.
  const [store] = questionsOf({ question: 'Which store?', options: [{ label: 'Redis (Recommended)', description: 'In-memory' }, { label: 'Postgres' }], recommended: 0 });
  assert.equal(optionLines(store!)[0], `1. Redis${RECOMMENDED_SUFFIX} — In-memory`);

  // Labels that merely mention "recommended" survive; a label that is only the marker is an error.
  const [keep] = questionsOf({ question: 'q', options: [{ label: 'Recommended approach' }, { label: 'not recommended at all' }] });
  assert.deepEqual(keep!.options.map((o) => o.label), ['Recommended approach', 'not recommended at all']);
  const only = failOf({ question: 'q', options: [{ label: ' (Recommended) ' }, { label: 'B' }] });
  assert.equal(only.code, 'empty_options');
  assert.match(only.text, /marker the UI appends/);
});

test('gateLabel: single question verbatim; multiple first (+N)', () => {
  assert.equal(gateLabel({ mode: 'freeform', question: 'deploy?' }), 'deploy?');
  assert.equal(gateLabel({ mode: 'questionnaire', questions: [q()] }), 'Which database?');
  assert.equal(gateLabel({ mode: 'questionnaire', questions: [q(), q({ question: 'SQL?' })] }), 'Which database? (+1)');
});

test('optionLines / parseChoice: authored rows, the Other row, the marker and both answer spellings', () => {
  const lines = optionLines(q({ recommended: 0 }));
  assert.equal(lines.length, 3);
  assert.equal(lines[0], `1. Redis${RECOMMENDED_SUFFIX} — In-memory`);
  assert.equal(lines[1], '2. Postgres — Relational');
  assert.equal(lines[2], `3. ${OTHER_ROW_LABEL}`);
  assert.equal(parseChoice(lines[0]!, lines), 0);
  assert.equal(parseChoice('2', lines), 1);
  assert.equal(parseChoice('3.', lines), 2);
  assert.equal(parseChoice('nope', lines), null);
});

test('formatAskContent: option / Other notes / empty multi / decline', () => {
  const formatted = (answer: AskAnswer): string => formatAskContent({ answers: [answer], cancelled: false });
  assert.match(formatted({ question: 'Which database?', kind: 'option', answer: 'Redis' }), /"Which database\?"="Redis"/);
  assert.match(formatted({ question: 'Which database?', kind: 'custom', answer: 'Other', customInput: 'SQLite' }), /"Which database\?"="Other" user notes: SQLite/);
  assert.match(formatted({ question: 'Which database?', kind: 'multi', answer: null, selected: [] }), /"Which database\?"="\(none\)"/);
  assert.equal(formatAskContent({ answers: [], cancelled: true }), DECLINE_TEXT);
});

test('hasAskUi / noUiResult: a missing input is not a decline', () => {
  assert.equal(hasAskUi({ input: async () => 'x' }), true);
  assert.equal(hasAskUi({ select: async () => 'x' }), false);
  assert.equal(hasAskUi(undefined), false);
  const none = noUiResult();
  assert.equal(none.details.error, 'no_ui');
  assert.match(none.content[0]?.text ?? '', /never saw/);
  assert.match(none.content[0]?.text ?? '', /NOT treat this as a decline/);
});

test('runAsk freeform: answer envelope; Esc declines', async () => {
  const answered = await runAsk({ mode: 'freeform', question: 'deploy staging?' }, { input: async () => '  ok  ' });
  assert.equal(answered.details.cancelled, false);
  assert.match(answered.content[0]?.text ?? '', /"deploy staging\?"="ok"/);
  assert.equal(answered.details.answers[0]?.kind, 'custom');

  const declined = await runAsk({ mode: 'freeform', question: 'deploy staging?' }, { input: async () => undefined });
  assert.equal(declined.details.cancelled, true);
  assert.equal(declined.content[0]?.text, DECLINE_TEXT);
});

test('runAsk: picking an authored option never opens the free-text input; Other does', async () => {
  const question = q();
  const lines = optionLines(question);
  let inputCalls = 0;
  const picked = await runAsk({ mode: 'questionnaire', questions: [question] }, {
    select: async (_title, options) => options[0],
    input: async () => { inputCalls += 1; return 'should not run'; },
  });
  assert.equal(inputCalls, 0);
  assert.deepEqual(picked.details.answers[0], { question: 'Which database?', kind: 'option', answer: 'Redis' });

  const custom = await runAsk({ mode: 'questionnaire', questions: [question] }, {
    select: async () => lines[2],
    input: async () => 'SQLite',
  });
  assert.equal(custom.details.answers[0]?.kind, 'custom');
  assert.equal(custom.details.answers[0]?.customInput, 'SQLite');
  assert.match(custom.content[0]?.text ?? '', /user notes: SQLite/);
});

test('runAsk: numbered input without a select dialog; a non-number becomes a custom answer', async () => {
  const titles: string[] = [];
  const numbered = await runAsk({ mode: 'questionnaire', questions: [q()] }, {
    input: async (title) => { titles.push(title); return '2'; },
  });
  assert.equal(numbered.details.answers[0]?.answer, 'Postgres');
  assert.match(titles[0] ?? '', /3\. Other \(type your own\)/);

  const typed = await runAsk({ mode: 'questionnaire', questions: [q()] }, { input: async () => 'just sqlite' });
  assert.equal(typed.details.answers[0]?.kind, 'custom');
  assert.equal(typed.details.answers[0]?.customInput, 'just sqlite');
});

test('runAsk multi: comma-separated numbers dedupe; non-numeric is custom; an empty submission is (none)', async () => {
  const ask = (input: string) => runAsk({ mode: 'questionnaire', questions: [q({ multi: true })] }, { input: async () => input });
  assert.deepEqual((await ask('2, 2, 1')).details.answers[0]?.selected, ['Postgres', 'Redis']);
  assert.equal((await ask('both, via a sidecar')).details.answers[0]?.kind, 'custom');
  const empty = await ask('  ');
  assert.deepEqual(empty.details.answers[0]?.selected, []);
  assert.match(empty.content[0]?.text ?? '', /\(none\)/);
});

test('runAsk: Esc on the second question declines the whole call and keeps the first answer', async () => {
  let n = 0;
  const ui: AskUi = {
    select: async (_title, options) => { n += 1; return n === 1 ? options[0] : undefined; },
    input: async () => 'unused',
  };
  const result = await runAsk({ mode: 'questionnaire', questions: [q(), q({ question: 'SQL?' })] }, ui);
  assert.equal(result.details.cancelled, true);
  assert.equal(result.content[0]?.text, DECLINE_TEXT);
  assert.equal(result.details.answers.length, 1);
  assert.equal(result.details.answers[0]?.answer, 'Redis');
});
