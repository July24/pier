/**
 * ask_user_question questionnaire: normalize, Other row, envelope, dialog paths.
 * herdr:blocked wrapping stays in index-integration.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RECOMMENDED_SUFFIX } from '../src/ask-dialog.ts';
import {
  DECLINE_TEXT,
  OTHER_OPTION,
  formatAskContent,
  gateLabel,
  hasAskUi,
  noUiResult,
  optionLines,
  parseChoice,
  prepareAsk,
  runAsk,
  type AskQuestion,
  type AskUi,
} from '../src/ask-user.ts';

const REDIS = { label: 'Redis', description: 'In-memory' };
const POSTGRES = { label: 'Postgres', description: 'Relational' };

function q(over: Partial<AskQuestion> = {}): AskQuestion {
  return {
    question: 'Which database?',
    options: [REDIS, POSTGRES],
    multi: false,
    allowOther: true,
    ...over,
  };
}

test('prepareAsk：无 options → freeform；空 question 拒绝且带 error', () => {
  const ok = prepareAsk({ question: '  deploy staging?  ' });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.deepEqual(ok.spec, { mode: 'freeform', question: 'deploy staging?' });

  const empty = prepareAsk({ question: '   ' });
  assert.equal(empty.ok, false);
  if (!empty.ok) {
    assert.equal(empty.result.details.error, 'empty_question');
    assert.match(empty.result.content[0]?.text ?? '', /must be a non-empty string/);
  }
});

test('prepareAsk：question+options 包成单题；questions 覆盖顶层', () => {
  const wrapped = prepareAsk({ question: 'Which database?', options: [REDIS, POSTGRES], recommended: 0 });
  assert.equal(wrapped.ok, true);
  if (wrapped.ok && wrapped.spec.mode === 'questionnaire') {
    assert.equal(wrapped.spec.questions.length, 1);
    assert.equal(wrapped.spec.questions[0]?.recommended, 0);
    assert.equal(wrapped.spec.questions[0]?.multi, false);
  }

  const batched = prepareAsk({
    question: 'ignored?',
    options: [REDIS, POSTGRES],
    questions: [
      { question: 'Cache?', options: [REDIS, POSTGRES] },
      { question: 'SQL?', options: [POSTGRES, REDIS], multi: true },
    ],
  });
  assert.equal(batched.ok, true);
  if (batched.ok && batched.spec.mode === 'questionnaire') {
    assert.deepEqual(batched.spec.questions.map((item) => item.question), ['Cache?', 'SQL?']);
    assert.equal(batched.spec.questions[1]?.multi, true);
  }
});

test('prepareAsk：保留 Other / 过少选项 / 重复 label / 重复题 / 超 4 题', () => {
  const reserved = prepareAsk({ question: 'Q?', options: [REDIS, { label: 'Other', description: 'x' }] });
  assert.equal(reserved.ok, false);
  if (!reserved.ok) {
    assert.equal(reserved.result.details.error, 'reserved_label');
    assert.match(reserved.result.content[0]?.text ?? '', /reserved/);
  }

  const few = prepareAsk({ question: 'Q?', options: [REDIS] });
  assert.equal(few.ok, false);
  if (!few.ok) assert.equal(few.result.details.error, 'empty_options');

  const dup = prepareAsk({ question: 'Q?', options: [REDIS, REDIS] });
  assert.equal(dup.ok, false);
  if (!dup.ok) assert.equal(dup.result.details.error, 'duplicate_option_label');

  const dupQ = prepareAsk({
    questions: [
      { question: 'Same?', options: [REDIS, POSTGRES] },
      { question: 'Same?', options: [REDIS, POSTGRES] },
    ],
  });
  assert.equal(dupQ.ok, false);
  if (!dupQ.ok) assert.equal(dupQ.result.details.error, 'duplicate_question');

  const many = prepareAsk({
    questions: [
      { question: 'A?', options: [REDIS, POSTGRES] },
      { question: 'B?', options: [REDIS, POSTGRES] },
      { question: 'C?', options: [REDIS, POSTGRES] },
      { question: 'D?', options: [REDIS, POSTGRES] },
      { question: 'E?', options: [REDIS, POSTGRES] },
    ],
  });
  assert.equal(many.ok, false);
  if (!many.ok) assert.equal(many.result.details.error, 'too_many_questions');
});

test('gateLabel：单题原文；多题 first (+N)', () => {
  assert.equal(gateLabel({ mode: 'freeform', question: 'deploy?' }), 'deploy?');
  assert.equal(gateLabel({ mode: 'questionnaire', questions: [q()] }), 'Which database?');
  assert.equal(
    gateLabel({ mode: 'questionnaire', questions: [q(), q({ question: 'SQL?' })] }),
    'Which database? (+1)',
  );
});

test('optionLines：作者项 + 末行 Other；recommended 后缀；parseChoice 认整行和数字', () => {
  const lines = optionLines(q({ recommended: 0 }));
  assert.equal(lines.length, 3);
  assert.equal(lines[0], `1. Redis${RECOMMENDED_SUFFIX} — In-memory`);
  assert.equal(lines[1], '2. Postgres — Relational');
  assert.equal(lines[2], `3. ${OTHER_OPTION}`);
  assert.equal(parseChoice(lines[0]!, lines), 0);
  assert.equal(parseChoice('2', lines), 1);
  assert.equal(parseChoice('3.', lines), 2);
  assert.equal(parseChoice('nope', lines), null);
});

test('formatAskContent：选项 / Other notes / 多选空 / 拒绝', () => {
  assert.match(
    formatAskContent({
      answers: [{ question: 'Which database?', kind: 'option', answer: 'Redis' }],
      cancelled: false,
    }),
    /"Which database\?"="Redis"/,
  );
  assert.match(
    formatAskContent({
      answers: [{ question: 'Which database?', kind: 'custom', answer: 'Other', customInput: 'SQLite' }],
      cancelled: false,
    }),
    /"Which database\?"="Other" user notes: SQLite/,
  );
  assert.match(
    formatAskContent({
      answers: [{ question: 'Which database?', kind: 'multi', answer: null, selected: [] }],
      cancelled: false,
    }),
    /"Which database\?"="\(none\)"/,
  );
  assert.equal(formatAskContent({ answers: [], cancelled: true }), DECLINE_TEXT);
});

test('hasAskUi / noUiResult：无 input 不当成拒绝', () => {
  assert.equal(hasAskUi({ input: async () => 'x' }), true);
  assert.equal(hasAskUi({ select: async () => 'x' }), false);
  assert.equal(hasAskUi(undefined), false);
  const none = noUiResult();
  assert.equal(none.details.error, 'no_ui');
  assert.match(none.content[0]?.text ?? '', /never saw/);
  assert.match(none.content[0]?.text ?? '', /NOT treat this as a decline/);
});

test('runAsk freeform：作答信封；Esc 为拒绝', async () => {
  const answered = await runAsk(
    { mode: 'freeform', question: 'deploy staging?' },
    { input: async () => '  ok  ' },
  );
  assert.equal(answered.details.cancelled, false);
  assert.match(answered.content[0]?.text ?? '', /"deploy staging\?"="ok"/);
  assert.equal(answered.details.answers[0]?.kind, 'custom');

  const declined = await runAsk(
    { mode: 'freeform', question: 'deploy staging?' },
    { input: async () => undefined },
  );
  assert.equal(declined.details.cancelled, true);
  assert.equal(declined.content[0]?.text, DECLINE_TEXT);
});

test('runAsk select：选作者项不进 input；选 Other 再 input', async () => {
  const question = q();
  const lines = optionLines(question);
  let inputCalls = 0;
  const picked = await runAsk(
    { mode: 'questionnaire', questions: [question] },
    {
      select: async (_title, options) => options[0],
      input: async () => {
        inputCalls += 1;
        return 'should not run';
      },
    },
  );
  assert.equal(inputCalls, 0);
  assert.deepEqual(picked.details.answers[0], {
    question: 'Which database?',
    kind: 'option',
    answer: 'Redis',
  });

  const custom = await runAsk(
    { mode: 'questionnaire', questions: [question] },
    {
      select: async () => lines[2],
      input: async () => 'SQLite',
    },
  );
  assert.equal(custom.details.answers[0]?.kind, 'custom');
  assert.equal(custom.details.answers[0]?.customInput, 'SQLite');
  assert.match(custom.content[0]?.text ?? '', /user notes: SQLite/);
});

test('runAsk：无 select 时编号 input；非数字即自定义', async () => {
  const titles: string[] = [];
  const numbered = await runAsk(
    { mode: 'questionnaire', questions: [q()] },
    {
      input: async (title) => {
        titles.push(title);
        return '2';
      },
    },
  );
  assert.equal(numbered.details.answers[0]?.answer, 'Postgres');
  assert.match(titles[0] ?? '', /3\. Other \(type your own\)/);

  const typed = await runAsk(
    { mode: 'questionnaire', questions: [q()] },
    { input: async () => 'just sqlite' },
  );
  assert.equal(typed.details.answers[0]?.kind, 'custom');
  assert.equal(typed.details.answers[0]?.customInput, 'just sqlite');
});

test('runAsk multi：逗号编号去重；非编号当自定义；空提交 none', async () => {
  const multi = q({ multi: true });
  const picked = await runAsk(
    { mode: 'questionnaire', questions: [multi] },
    { input: async () => '2, 2, 1' },
  );
  assert.deepEqual(picked.details.answers[0]?.selected, ['Postgres', 'Redis']);

  const custom = await runAsk(
    { mode: 'questionnaire', questions: [multi] },
    { input: async () => 'both, via a sidecar' },
  );
  assert.equal(custom.details.answers[0]?.kind, 'custom');

  const empty = await runAsk(
    { mode: 'questionnaire', questions: [multi] },
    { input: async () => '  ' },
  );
  assert.deepEqual(empty.details.answers[0]?.selected, []);
  assert.match(empty.content[0]?.text ?? '', /\(none\)/);
});

test('runAsk：第二题 Esc 整次拒绝，第一题留在 details', async () => {
  let n = 0;
  const ui: AskUi = {
    select: async (_title, options) => {
      n += 1;
      return n === 1 ? options[0] : undefined;
    },
    input: async () => 'unused',
  };
  const result = await runAsk(
    { mode: 'questionnaire', questions: [q(), q({ question: 'SQL?' })] },
    ui,
  );
  assert.equal(result.details.cancelled, true);
  assert.equal(result.content[0]?.text, DECLINE_TEXT);
  assert.equal(result.details.answers.length, 1);
  assert.equal(result.details.answers[0]?.answer, 'Redis');
});

test('parseOptions (B3): 剥掉模型重复写的 "(Recommended)" 标记', () => {
  const spec = prepareAsk({
    question: 'Which store?',
    required: true,
    options: [
      { label: 'Redis (Recommended)', description: 'In-memory' },
      { label: 'Postgres' },
    ],
    recommended: 0,
  });
  assert.equal(spec.ok, true);
  if (!spec.ok || spec.spec.mode !== 'questionnaire') return;
  assert.equal(spec.spec.questions[0]!.options[0]!.label, 'Redis');
  // 渲染时标记只出现一次
  const lines = optionLines(spec.spec.questions[0]!);
  assert.equal(lines[0], `1. Redis${RECOMMENDED_SUFFIX} — In-memory`);
  // 方括号 / 大小写变体同样处理
  const bracket = prepareAsk({
    question: 'q',
    options: [{ label: 'Pick me [recommended]' }, { label: 'Or me' }],
  });
  assert.equal(bracket.ok, true);
  if (!bracket.ok || bracket.spec.mode !== 'questionnaire') return;
  assert.equal(bracket.spec.questions[0]!.options[0]!.label, 'Pick me');
});

test('parseOptions (B3): 只在结尾剥离，正常提到 recommended 的标签不动；纯标记标签报错', () => {
  const keep = prepareAsk({
    question: 'q',
    options: [{ label: 'Recommended approach' }, { label: 'not recommended at all' }],
  });
  assert.equal(keep.ok, true);
  if (!keep.ok || keep.spec.mode !== 'questionnaire') return;
  assert.deepEqual(keep.spec.questions[0]!.options.map((o) => o.label), ['Recommended approach', 'not recommended at all']);

  const only = prepareAsk({ question: 'q', options: [{ label: ' (Recommended) ' }, { label: 'B' }] });
  assert.equal(only.ok, false);
  if (only.ok) return;
  assert.equal(only.result.details?.error, 'empty_options');
  assert.match(String(only.result.content?.[0]?.text ?? ''), /marker the UI appends/);
});
