/**
 * ask-dialog: the unified single/multi selector — state machine, component key
 * handling, the custom-UI bridge and the ask_user_question integration.
 *
 * Why: this is the human gate's most-used interaction, so the transitions
 * (toggle, wrap-around, confirm, free-text row, cancel, abort, recommended
 * seeding) are pinned by tests instead of being verified by hand in a terminal.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { styledWidth } from '../src/ansi-text.ts';
import {
  createDialogComponent,
  createDialogState,
  dialogFooter,
  dialogLines,
  isOtherRow,
  resolveDialogKey,
  rowCount,
  runSelectDialog,
  selectedLabels,
  stepDialog,
  type DialogConfig,
  type DialogOutcome,
  type DialogState,
  type KeybindingsLike,
  type MinimalTheme,
} from '../src/ask-dialog.ts';
import { prepareAsk, runAsk, type AskUi } from '../src/ask-user.ts';

const plain: MinimalTheme = { fg: (_c, t) => t, bold: (t) => t };

const multi = (over: Partial<DialogConfig> = {}): DialogConfig => ({
  options: [{ label: 'alpha' }, { label: 'beta', description: 'second' }, { label: 'gamma' }],
  allowOther: true,
  multi: true,
  ...over,
});

const single = (over: Partial<DialogConfig> = {}): DialogConfig => multi({ multi: false, ...over });

const feed = (state: DialogState, keys: Parameters<typeof stepDialog>[1][], cfg: DialogConfig): DialogState => {
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

/* ── state machine: shared ─────────────────────────────────────────── */

test('rowCount and isOtherRow account for the optional free-text row', () => {
  const cfg = multi();
  assert.equal(rowCount(cfg), 4);
  assert.equal(rowCount(multi({ allowOther: false })), 3);
  assert.equal(isOtherRow({ cursor: 3, selected: [false, false, false] }, cfg), true);
  assert.equal(isOtherRow({ cursor: 2, selected: [false, false, false] }, cfg), false);
});

test('cursor wraps in both directions over choices and the Other row', () => {
  const cfg = multi();
  assert.equal(feed(createDialogState(cfg), ['up'], cfg).cursor, 3);
  const last = feed(createDialogState(cfg), ['up'], cfg);
  assert.equal(stepDialog(last, 'down', cfg).state.cursor, 0);
  assert.equal(stepDialog(createDialogState(cfg), 'down', cfg).state.cursor, 1);
});

test('cursor never reaches the Other row when allowOther is false', () => {
  const cfg = multi({ allowOther: false });
  assert.equal(feed(createDialogState(cfg), ['up'], cfg).cursor, 2);
});

test('escape cancels and empty configurations stay safe', () => {
  const cfg = multi();
  assert.deepEqual(stepDialog(createDialogState(cfg), 'cancel', cfg).outcome, { kind: 'cancel' });
  const noOptions: DialogConfig = { options: [], allowOther: false, multi: true };
  assert.deepEqual(stepDialog(createDialogState(noOptions), 'cancel', noOptions).outcome, { kind: 'cancel' });
  assert.equal(stepDialog(createDialogState(noOptions), 'down', noOptions).outcome, undefined);
});

test('recommended seeds the cursor in both modes and the default check in multi', () => {
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
});

test('out-of-range recommended is ignored', () => {
  const cfg = multi({ recommended: 9 });
  const state = createDialogState(cfg);
  assert.equal(state.cursor, 0);
  assert.deepEqual(selectedLabels(state, cfg), []);
});

/* ── state machine: multi grammar ──────────────────────────────────── */

test('space toggles only the cursor row and keeps selection order', () => {
  const cfg = multi();
  const picked = feed(createDialogState(cfg), ['down', 'down', 'toggle', 'up', 'up', 'toggle'], cfg);
  assert.deepEqual(selectedLabels(picked, cfg), ['alpha', 'gamma']);
  const untoggled = stepDialog(picked, 'toggle', cfg).state;
  assert.deepEqual(selectedLabels(untoggled, cfg), ['gamma']);
});

test('space on the Other row opens the free-text path like enter', () => {
  const cfg = multi();
  const onOther = feed(createDialogState(cfg), ['up'], cfg);
  assert.deepEqual(stepDialog(onOther, 'toggle', cfg).outcome, { kind: 'other' });
  assert.deepEqual(stepDialog(onOther, 'confirm', cfg).outcome, { kind: 'other' });
});

test('a toggles everything on, then everything off; it is a no-op for pick-one', () => {
  const cfg = multi();
  const all = stepDialog(createDialogState(cfg), 'all', cfg).state;
  assert.deepEqual(selectedLabels(all, cfg), ['alpha', 'beta', 'gamma']);
  const none = stepDialog(all, 'all', cfg).state;
  assert.deepEqual(selectedLabels(none, cfg), []);
  const one = single();
  assert.deepEqual(stepDialog(createDialogState(one), 'all', one).state, createDialogState(one));
});

test('enter on a choice row confirms the toggles, including an empty selection', () => {
  const cfg = multi({ recommended: undefined });
  const empty = stepDialog(createDialogState(cfg), 'confirm', cfg);
  assert.deepEqual(empty.outcome, { kind: 'selected', labels: [] });
  const some = stepDialog(feed(createDialogState(cfg), ['toggle', 'down', 'toggle'], cfg), 'confirm', cfg);
  assert.deepEqual(some.outcome, { kind: 'selected', labels: ['alpha', 'beta'] });
});

test('enter on the Other row requests the free-text path', () => {
  const cfg = multi();
  const onOther = feed(createDialogState(cfg), ['up'], cfg);
  assert.deepEqual(stepDialog(onOther, 'confirm', cfg).outcome, { kind: 'other' });
});

test('a single-option confirm returns that option', () => {
  const cfg = multi({ options: [{ label: 'only' }] });
  assert.deepEqual(stepDialog(createDialogState(cfg), 'confirm', cfg).outcome, {
    kind: 'selected',
    labels: ['only'],
  });
});

/* ── state machine: pick-one grammar ───────────────────────────────── */

test('pick-one enter returns the cursor row, never the toggle set', () => {
  const cfg = single();
  const moved = feed(createDialogState(cfg), ['down', 'down'], cfg);
  assert.deepEqual(stepDialog(moved, 'confirm', cfg).outcome, { kind: 'selected', labels: ['gamma'] });
});

test('pick-one space is an alias for enter', () => {
  const cfg = single();
  assert.deepEqual(stepDialog(createDialogState(cfg), 'toggle', cfg).outcome, {
    kind: 'selected',
    labels: ['alpha'],
  });
});

test('pick-one enter on the Other row requests the free-text path', () => {
  const cfg = single();
  const onOther = feed(createDialogState(cfg), ['up'], cfg);
  assert.deepEqual(stepDialog(onOther, 'confirm', cfg).outcome, { kind: 'other' });
  assert.deepEqual(stepDialog(onOther, 'toggle', cfg).outcome, { kind: 'other' });
});

/* ── key resolution ────────────────────────────────────────────────── */

test('resolveDialogKey understands host bindings, literals and fallback sequences', () => {
  // Host bindings path.
  assert.equal(resolveDialogKey('\x1b[A', kb), 'up');
  assert.equal(resolveDialogKey('\x1b[B', kb), 'down');
  assert.equal(resolveDialogKey('\r', kb), 'confirm');
  assert.equal(resolveDialogKey('\x03', kb), 'cancel');
  // Literals shared with pi's selector: vim keys work in both paths.
  assert.equal(resolveDialogKey('k', kb), 'up');
  assert.equal(resolveDialogKey('j', kb), 'down');
  assert.equal(resolveDialogKey(' ', kb), 'toggle');
  assert.equal(resolveDialogKey('a', kb), 'all');
  // No keybindings manager: the built-in sequences still resolve.
  assert.equal(resolveDialogKey('\x1bOA', undefined), 'up');
  assert.equal(resolveDialogKey('\n', undefined), 'confirm');
  assert.equal(resolveDialogKey('\x1b', undefined), 'cancel');
  assert.equal(resolveDialogKey('k', undefined), 'up');
  assert.equal(resolveDialogKey('x', kb), 'ignore');
});

/* ── rendering ─────────────────────────────────────────────────────── */

test('multi rows mark the cursor, toggles, recommendation and dim description', () => {
  const cfg = multi({ recommended: 1 });
  // Cursor starts on the recommended row, which also starts checked.
  const state = createDialogState(cfg); // cursor starts on the recommended row
  const lines = dialogLines(state, cfg, plain);
  assert.equal(lines.length, 4);
  assert.equal(lines[0], '  [ ] alpha');
  assert.equal(lines[1], '→ [x] beta (Recommended) — second');
  assert.equal(lines[3], '  [ ] Other (type your own)');
});

test('pick-one rows highlight the cursor row and carry no checkboxes', () => {
  const cfg = single({ recommended: 1 });
  const state = feed(createDialogState(cfg), ['down', 'down'], cfg); // cursor on the Other row
  const lines = dialogLines(state, cfg, plain);
  assert.equal(lines.length, 4);
  assert.equal(lines[0], '  alpha');
  assert.equal(lines[1], '  beta (Recommended) — second');
  assert.equal(lines[3], '→ Other (type your own)');
});

test('the Other row hides when allowOther is false', () => {
  const cfg = multi({ allowOther: false });
  const lines = dialogLines(createDialogState(cfg), cfg, plain);
  assert.equal(lines.length, 3);
  assert.equal(lines.some((l) => /Other/.test(l)), false);
});

test('multi footer lists the toggle grammar and the selection count', () => {
  const cfg = multi();
  const idle = dialogFooter(createDialogState(cfg), cfg, plain, kb);
  assert.equal(idle, '↑↓ navigate  space toggle  a all  enter confirm  escape/ctrl+c cancel');
  const picked = dialogFooter(feed(createDialogState(cfg), ['toggle'], cfg), cfg, plain, kb);
  assert.equal(picked, '↑↓ navigate  space toggle  a all  enter confirm  escape/ctrl+c cancel · 1 selected');
});

test('pick-one footer matches the host selector wording and never counts', () => {
  const cfg = single();
  assert.equal(dialogFooter(createDialogState(cfg), cfg, plain, kb), '↑↓ navigate  enter select  escape/ctrl+c cancel');
});

test('narrow panes shed guessable hints but never the action keys or the count', () => {
  const cfg = multi();
  const state = feed(createDialogState(cfg), ['toggle'], cfg);
  // The component measures hints against width-2 (1-col margin each side), so the
  // pane widths below subtract 2 before reaching dialogFooter.
  // 80-col pane: drops `a all` only; navigate stays.
  const wide = dialogFooter(state, cfg, plain, kb, 80 - 2);
  assert.equal(wide, '↑↓ navigate  space toggle  enter confirm  escape/ctrl+c cancel · 1 selected');
  // 70-col pane: drops `a all` then the navigate hint; cancel and the count stay.
  const narrow = dialogFooter(state, cfg, plain, kb, 70 - 2);
  assert.equal(narrow, 'space toggle  enter confirm  escape/ctrl+c cancel · 1 selected');
  // Pick-one sheds only the navigate hint.
  const one = dialogFooter(createDialogState(single()), single(), plain, kb, 40 - 2);
  assert.equal(one, 'enter select  escape/ctrl+c cancel');
  // 58-col pane (inner 56): a-all, navigate and the cancel hint are gone; the count stays whole.
  assert.equal(dialogFooter(state, cfg, plain, kb, 58 - 2), 'space toggle  enter confirm · 1 selected');
});

/* ── component ─────────────────────────────────────────────────────── */

test('component: renders the framed chrome and fits every line to width', () => {
  let outcome: DialogOutcome | null = null;
  const component = createDialogComponent({
    title: 'Pick', config: multi(), theme: plain,
    done: (o) => { outcome = o; },
  });
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
    config: multi({
      options: [{ label: 'alpha', description: 'a long description that keeps going past the edge of the pane' }],
      allowOther: false,
    }),
    theme: plain,
    keybindings: kb,
    done: () => {},
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

test('component: key sequences drive the state machine and finish once', () => {
  const outcomes: DialogOutcome[] = [];
  let renders = 0;
  const component = createDialogComponent({
    title: 'Q', config: multi({ recommended: undefined }), theme: plain,
    keybindings: kb,
    done: (o) => outcomes.push(o),
    requestRender: () => { renders += 1; },
  });
  component.handleInput('x'); // ignored
  component.handleInput(' ');
  component.handleInput('\x1b[B');
  component.handleInput(' ');
  component.handleInput('\r');
  component.handleInput(' '); // ignored after finish
  assert.deepEqual(outcomes, [{ kind: 'selected', labels: ['alpha', 'beta'] }]);
  assert.equal(renders, 4);
});

test('component: enter on the Other row finishes with the other outcome', () => {
  const outcomes: DialogOutcome[] = [];
  const component = createDialogComponent({
    title: 'Q', config: multi(), theme: plain,
    keybindings: kb,
    done: (o) => outcomes.push(o),
  });
  component.handleInput('\x1b[A'); // wrap to the Other row
  component.handleInput('\r');
  assert.deepEqual(outcomes, [{ kind: 'other' }]);
});

test('component: aborting the signal cancels exactly once and later keys are ignored', () => {
  const outcomes: DialogOutcome[] = [];
  const controller = new AbortController();
  const component = createDialogComponent({
    title: 'Q', config: multi(), theme: plain,
    keybindings: kb,
    signal: controller.signal,
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
    title: 'Q', config: multi(), theme: plain,
    keybindings,
    toggleToolsExpanded: () => expansions.push(true),
    done: () => { throw new Error('dialog must not finish'); },
  });
  component.handleInput('\x0f');
  assert.deepEqual(expansions, [true]);
});

/* ── custom-UI bridge ──────────────────────────────────────────────── */

test('runSelectDialog: bridges the component through ui.custom and forwards outcomes', async () => {
  const seen: { step: string }[] = [];
  const custom = async (factory: unknown): Promise<unknown> => {
    const done = (value: unknown): void => { seen.push({ step: JSON.stringify(value) }); };
    const component = (factory as (
      tui: unknown,
      theme: unknown,
      keybindings: unknown,
      done: (value: unknown) => void,
    ) => { handleInput(data: string): void })({ requestRender() {} }, plain, kb, done);
    component.handleInput(' ');
    component.handleInput('\r');
    return { kind: 'selected', labels: ['alpha'] };
  };
  const outcome = await runSelectDialog(custom, 'Q', multi());
  assert.deepEqual(outcome, { kind: 'selected', labels: ['alpha'] });
  assert.deepEqual(seen, [{ step: JSON.stringify({ kind: 'selected', labels: ['alpha'] }) }]);
});

test('runSelectDialog: undefined from ui.custom (RPC mode) degrades to null', async () => {
  assert.equal(await runSelectDialog(async () => undefined, 'Q', multi()), null);
  assert.equal(await runSelectDialog(async () => 'garbage', 'Q', multi()), null);
});

test('runSelectDialog: an already-aborted signal cancels without opening the dialog', async () => {
  let opened = false;
  const outcome = await runSelectDialog(
    async () => { opened = true; return { kind: 'selected', labels: ['alpha'] }; },
    'Q',
    multi(),
    { signal: AbortSignal.abort() },
  );
  assert.deepEqual(outcome, { kind: 'cancel' });
  assert.equal(opened, false);
});

/* ── ask_user_question integration ─────────────────────────────────── */

/** Drive the dialog through `ui.custom` the way pi does: build the component, feed keys, return the outcome. */
function dialogUi(keys: string[], outcome: DialogOutcome, calls: string[], input = 'typed by hand'): AskUi {
  return {
    input: async () => input,
    custom: async (factory) => {
      calls.push('custom');
      const component = (factory as (
        tui: unknown, theme: unknown, keybindings: unknown, done: (value: unknown) => void,
      ) => { handleInput(data: string): void })({}, plain, {}, () => {});
      for (const key of keys) component.handleInput(key);
      return outcome;
    },
  };
}

test('runAsk: the pier dialog drives both modes and its Other row opens free text', async () => {
  const calls: string[] = [];
  const multiSpec = prepareAsk({ question: 'Pick', options: [{ label: 'a' }, { label: 'b' }], multi: true });
  assert.equal(multiSpec.ok, true);
  const selected = await runAsk(
    multiSpec.ok ? multiSpec.spec : { mode: 'freeform', question: '' },
    dialogUi([' ', '\x1b[B', ' ', '\r'], { kind: 'selected', labels: ['a', 'b'] }, calls),
  );
  assert.deepEqual(selected.details.answers[0]!.selected, ['a', 'b']);
  assert.deepEqual(calls, ['custom']);

  const other = await runAsk(
    { mode: 'questionnaire', questions: [{ question: 'Pick', options: [{ label: 'a' }, { label: 'b' }], multi: false, allowOther: true }] },
    dialogUi(['\x1b[A', '\r'], { kind: 'other' }, calls),
  );
  assert.equal(other.details.answers[0]!.kind, 'custom');
  assert.equal(other.details.answers[0]!.customInput, 'typed by hand');
});

test('runAsk: an unusable dialog (RPC mode) and a declined one fall back / cancel correctly', async () => {
  const calls: string[] = [];
  const ui: AskUi = {
    input: async () => '1',
    custom: async () => {
      calls.push('custom');
      return undefined;
    },
  };
  const spec = prepareAsk({ question: 'Pick', options: [{ label: 'a' }, { label: 'b' }] });
  const fallback = await runAsk(spec.ok ? spec.spec : { mode: 'freeform', question: '' }, ui);
  assert.deepEqual(fallback.details.answers[0], { question: 'Pick', kind: 'option', answer: 'a' });

  const declined = await runAsk(
    spec.ok ? spec.spec : { mode: 'freeform', question: '' },
    dialogUi([], { kind: 'cancel' }, calls),
  );
  assert.equal(declined.details.cancelled, true);
});
