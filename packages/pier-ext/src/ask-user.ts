/**
 * ask_user_question I/O: normalize params, select+Other dialog, result envelope. The herdr gate
 * (blocked / pi-ask / widget collapse) stays in index.ts; this module owns the questionnaire — authored
 * options plus a runtime Other row, so the model cannot forget a free-text escape and Esc is a real decline.
 */
import { Type } from 'typebox';
import { OTHER_ROW_LABEL, numberedOptionLine, runSelectDialog } from './ask-dialog.ts';

export const ASK_TOOL_NAME = 'ask_user_question';
export const OTHER_OPTION = OTHER_ROW_LABEL;

export const DECLINE_TEXT =
  'User declined to answer the questions. Continue with your best judgment, or ask different questions.';
export const NO_UI_TEXT =
  'Error: UI not available (running in non-interactive mode). The user never saw the questions — do NOT treat this as a decline. Ask the questions as plain chat text instead, without using this tool.';

/** Answer kind reported for the free-text row (the questions themselves are the detail). */
const OTHER_ANSWER = 'Other';
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 5;
const MAX_QUESTIONS = 4;
const MAX_LABEL_CHARS = 60;

const CUSTOM_ANSWER_TITLE = 'Type your answer:';
const MULTI_INSTRUCTIONS =
  'Enter the numbers of all that apply, comma-separated (e.g. "1,3"), or type a custom answer as plain text.';
const MULTI_NO_OTHER_INSTRUCTIONS =
  'Enter the numbers of all that apply, comma-separated (e.g. "1,3"). There is no free-text answer for this question.';
const NUMBERED_HINT = 'Enter a number, or type a custom answer.';

const RESERVED_LOWER: Record<string, true> = {
  [OTHER_OPTION.toLowerCase()]: true,
  other: true,
  'type something.': true,
  next: true,
  'next →': true,
};

const OptionSchema = Type.Object({
  label: Type.String({ description: 'Short display label (1-5 words)' }),
  description: Type.Optional(Type.String({ description: 'Tradeoff / meaning of this choice' })),
});

export const ASK_PARAMETERS = Type.Object({
  question: Type.Optional(Type.String({ description: 'The question to ask the human. Required unless questions is set.' })),
  options: Type.Optional(Type.Array(OptionSchema, {
    description: '2-5 authored choices. Do NOT include Other; the UI appends it.',
  })),
  multi: Type.Optional(Type.Boolean({ description: 'Allow multiple selections (default false). In the TUI this opens an interactive toggle list (space toggles, enter confirms, esc declines).' })),
  allowOther: Type.Optional(Type.Boolean({ description: 'Set false to offer the authored choices only, with no free-text row (default true).' })),
  recommended: Type.Optional(Type.Number({ description: '0-based index of the recommended option; UI adds (Recommended)' })),
  questions: Type.Optional(Type.Array(
    Type.Object({
      id: Type.Optional(Type.String({ description: 'Stable id for mapping answers' })),
      question: Type.String({ description: 'Question text' }),
      options: Type.Array(OptionSchema, {
        description: '2-5 authored choices. Do NOT include Other; the UI appends it unless allowOther is false.',
      }),
      multi: Type.Optional(Type.Boolean({ description: 'Allow multiple selections (default false). In the TUI this opens an interactive toggle list (space toggles, enter confirms).' })),
      allowOther: Type.Optional(Type.Boolean({ description: 'Set false to offer the authored choices only, with no free-text row (default true).' })),
      recommended: Type.Optional(Type.Number({ description: '0-based recommended option index' })),
    }),
    { description: '1-4 related questions in one call. Wins over top-level question/options when set.' },
  )),
});

export const ASK_TOOL_DESCRIPTION = [
  'Ask the human a question and wait for their answer.',
  'Use this when you genuinely need a human decision (approval, direction, trade-off) — not for information you can find yourself.',
  'While waiting, the pane shows as blocked in herdr (the human sees it and can step in).',
  'Prefer 2-5 options with short labels; put tradeoffs in description.',
  'Do NOT include an "Other" option — the UI appends "Other (type your own)" automatically.',
  'Use recommended (0-based) to mark the default; "(Recommended)" is added automatically — do NOT write it in the label.',
  'Use multi: true when several options can apply — the TUI opens an interactive toggle list (space toggles a row, a toggles all, enter confirms, esc declines) instead of making the human type numbers.',
  'Set allowOther: false when the authored choices are exhaustive and a free-text answer would be misleading.',
].join(' ');

export const ASK_PROMPT_GUIDELINES = [
  'Default to action. Ask only when options have materially different tradeoffs the user must decide.',
  'Do NOT include "Other" in options; the UI appends it unless allowOther is false. Group related questions in questions (max 4) rather than calling this tool repeatedly.',
  'For multi questions the human toggles rows in a list and confirms with enter — never instruct them to type indices.',
  'Short option labels; explanatory tradeoffs in description.',
];

export type AskOption = { label: string; description?: string };
export type AskQuestion = {
  id?: string;
  question: string;
  options: AskOption[];
  multi: boolean;
  /** When false the UI offers the authored choices only (no free-text row). */
  allowOther: boolean;
  recommended?: number;
};
export type AskSpec =
  | { mode: 'freeform'; question: string }
  | { mode: 'questionnaire'; questions: AskQuestion[] };

export type AskAnswer = {
  question: string;
  id?: string;
  kind: 'option' | 'custom' | 'multi';
  answer: string | null;
  selected?: string[];
  customInput?: string;
};

export type AskDetails = {
  answers: AskAnswer[];
  cancelled: boolean;
  error?: string;
};

export type AskToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  details: AskDetails;
};

export type AskUi = {
  select?: (title: string, options: string[], opts?: { signal?: AbortSignal }) => Promise<string | undefined>;
  input: (title: string, placeholder?: string, opts?: { signal?: AbortSignal }) => Promise<string | undefined>;
  /** TUI-only: full custom components (absent in RPC mode, where it returns undefined). */
  custom?: (factory: unknown) => Promise<unknown>;
  /** TUI-only helpers from pi's extension UI context; wired for ctrl+o parity with pi's selector. */
  getToolsExpanded?: () => boolean;
  setToolsExpanded?: (expanded: boolean) => void;
};

export type PrepareAskResult =
  | { ok: true; spec: AskSpec }
  | { ok: false; result: AskToolResult };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function fail(text: string, code: string): { ok: false; result: AskToolResult } {
  return { ok: false, result: errorResult(text, code) };
}

function errorResult(text: string, code: string): AskToolResult {
  return {
    content: [{ type: 'text', text }],
    details: { answers: [], cancelled: true, error: code },
  };
}

function okResult(details: AskDetails): AskToolResult {
  return {
    content: [{ type: 'text', text: formatAskContent(details) }],
    details,
  };
}

export function noUiResult(): AskToolResult {
  return errorResult(NO_UI_TEXT, 'no_ui');
}

export function hasAskUi(ui: unknown): ui is AskUi {
  return typeof (ui as { input?: unknown } | null | undefined)?.input === 'function';
}

function parseRecommended(raw: unknown, count: number): number | undefined {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw >= count) return undefined;
  return raw;
}

function parseOptions(raw: unknown): { ok: true; options: AskOption[] } | { ok: false; result: AskToolResult } {
  if (!Array.isArray(raw)) {
    return fail('Error: `options` must be an array of 2-5 choices', 'empty_options');
  }
  if (raw.length < MIN_OPTIONS) {
    return fail(`Error: each question needs ${MIN_OPTIONS}-${MAX_OPTIONS} options`, 'empty_options');
  }
  if (raw.length > MAX_OPTIONS) {
    return fail(`Error: each question needs ${MIN_OPTIONS}-${MAX_OPTIONS} options`, 'too_many_options');
  }
  const options: AskOption[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const rec = asRecord(item);
    const rawLabel = typeof rec?.label === 'string' ? rec.label.trim() : '';
    // B3: models repeat the marker the UI appends ("Redis (Recommended)"); strip only a trailing one.
    const label = rawLabel.replace(/\s*[([]\s*recommended\s*[)\]]\s*$/i, '').trim();
    if (!label) {
      return fail(
        rawLabel
          ? `Error: option label "${rawLabel}" is only the marker the UI appends — give the choice a real name and pass "recommended" instead`
          : 'Error: each option needs a non-empty label',
        'empty_options',
      );
    }
    if (label.length > MAX_LABEL_CHARS) {
      return fail(`Error: option label exceeds ${MAX_LABEL_CHARS} characters`, 'label_too_long');
    }
    if (RESERVED_LOWER[label.toLowerCase()]) {
      return fail(
        `Error: option label "${label}" is reserved — the UI appends "${OTHER_OPTION}" automatically`,
        'reserved_label',
      );
    }
    if (seen.has(label)) {
      return fail(`Error: duplicate option label "${label}"`, 'duplicate_option_label');
    }
    seen.add(label);
    const description = typeof rec?.description === 'string' ? rec.description.replace(/\s+/g, ' ').trim() : '';
    options.push(description ? { label, description } : { label });
  }
  return { ok: true, options };
}

function parseQuestion(raw: unknown): { ok: true; question: AskQuestion } | { ok: false; result: AskToolResult } {
  const rec = asRecord(raw);
  if (!rec) return fail('Error: each questions[] entry must be an object', 'empty_question');
  const question = typeof rec.question === 'string' ? rec.question.trim() : '';
  if (!question) return fail('Error: `question` must be a non-empty string', 'empty_question');
  const parsed = parseOptions(rec.options);
  if (!parsed.ok) return parsed;
  const recommended = parseRecommended(rec.recommended, parsed.options.length);
  const id = typeof rec.id === 'string' && rec.id.trim() ? rec.id.trim() : undefined;
  return {
    ok: true,
    question: {
      question,
      options: parsed.options,
      multi: rec.multi === true,
      allowOther: rec.allowOther !== false,
      ...(id ? { id } : {}),
      ...(recommended !== undefined ? { recommended } : {}),
    },
  };
}

export function prepareAsk(params: unknown): PrepareAskResult {
  const rec = asRecord(params);
  if (!rec) return fail('Error: `question` must be a non-empty string', 'empty_question');

  if ('questions' in rec && rec.questions !== undefined) {
    if (!Array.isArray(rec.questions)) {
      return fail('Error: `questions` must be an array of 1-4 questions', 'no_questions');
    }
    if (rec.questions.length < 1) {
      return fail('Error: `questions` must contain 1-4 entries', 'no_questions');
    }
    if (rec.questions.length > MAX_QUESTIONS) {
      return fail('Error: `questions` must contain 1-4 entries', 'too_many_questions');
    }
    const questions: AskQuestion[] = [];
    const seen = new Set<string>();
    for (const item of rec.questions) {
      const parsed = parseQuestion(item);
      if (!parsed.ok) return parsed;
      if (seen.has(parsed.question.question)) {
        return fail(`Error: duplicate question "${parsed.question.question}"`, 'duplicate_question');
      }
      seen.add(parsed.question.question);
      questions.push(parsed.question);
    }
    return { ok: true, spec: { mode: 'questionnaire', questions } };
  }

  const question = typeof rec.question === 'string' ? rec.question.trim() : '';
  if (!question) return fail('Error: `question` must be a non-empty string', 'empty_question');
  if (rec.options === undefined) {
    return { ok: true, spec: { mode: 'freeform', question } };
  }
  const parsed = parseOptions(rec.options);
  if (!parsed.ok) return parsed;
  const recommended = parseRecommended(rec.recommended, parsed.options.length);
  return {
    ok: true,
    spec: {
      mode: 'questionnaire',
      questions: [{
        question,
        options: parsed.options,
        multi: rec.multi === true,
        allowOther: rec.allowOther !== false,
        ...(recommended !== undefined ? { recommended } : {}),
      }],
    },
  };
}

export function gateLabel(spec: AskSpec): string {
  if (spec.mode === 'freeform') return spec.question;
  const first = spec.questions[0]?.question ?? '';
  const extra = spec.questions.length - 1;
  return extra > 0 ? `${first} (+${extra})` : first;
}

/** Typed-prompt list: numbered authored options plus the Other row when it is offered. */
export function optionLines(question: AskQuestion): string[] {
  const lines = question.options.map((option, i) => numberedOptionLine(option, i, question.recommended));
  if (question.allowOther) lines.push(`${question.options.length + 1}. ${OTHER_OPTION}`);
  return lines;
}

export function parseChoice(chosen: string, lines: readonly string[]): number | null {
  const trimmed = chosen.trim();
  const exact = lines.indexOf(trimmed);
  if (exact >= 0) return exact;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed)) return null;
  const idx = parsed - 1;
  return idx >= 0 && idx < lines.length ? idx : null;
}

function withId(question: AskQuestion, answer: AskAnswer): AskAnswer {
  return question.id ? { ...answer, id: question.id } : answer;
}

/** Free-text answer behind the Other row; shared by the dialog and the typed-prompt fallback. */
async function askOtherText(ui: AskUi, question: AskQuestion, signal?: AbortSignal): Promise<AskAnswer | undefined> {
  const typed = await ui.input(`${question.question}\n\n${CUSTOM_ANSWER_TITLE}`, '', signal ? { signal } : undefined);
  if (typed == null || !typed.trim()) return undefined;
  return withId(question, {
    question: question.question,
    kind: 'custom',
    answer: OTHER_ANSWER,
    customInput: typed.trim(),
  });
}

/**
 * Interpret one typed answer. Single-select: a listed line or its number takes that option, the Other
 * number opens the free-text prompt, anything else is a custom answer — but only on the typed fallback,
 * since a real select dialog can only return a listed row. Multi-select: comma/space separated numbers,
 * the Other number alone opens free text, an empty submission is an empty selection. Returns 'other' to
 * ask for free text, undefined to decline.
 */
function parseTypedPicks(
  question: AskQuestion,
  lines: readonly string[],
  raw: string,
  typedFallback: boolean,
): AskAnswer[] | 'other' | undefined {
  const trimmed = raw.trim();
  const otherIndex = question.options.length;
  if (!trimmed) {
    return question.multi
      ? [withId(question, { question: question.question, kind: 'multi', answer: null, selected: [] })]
      : undefined;
  }
  if (!question.multi) {
    const idx = parseChoice(trimmed, lines);
    if (idx === otherIndex) return 'other';
    if (idx != null && idx < otherIndex) {
      return [withId(question, { question: question.question, kind: 'option', answer: question.options[idx]!.label })];
    }
    return typedFallback
      ? [withId(question, { question: question.question, kind: 'custom', answer: OTHER_ANSWER, customInput: trimmed })]
      : undefined;
  }
  // The Other row is numbered like the authored options; typing it alone opens the free-text prompt.
  if (trimmed.split(/[,\s]+/).length === 1 && parseChoice(trimmed, lines) === otherIndex) return 'other';
  const tokens = trimmed.split(/[,\s]+/).filter((tok) => tok.length > 0);
  const indices = tokens.map((tok) => {
    if (!/^\d+\.?$/.test(tok)) return null;
    const idx = Number.parseInt(tok, 10) - 1;
    return idx >= 0 && idx < otherIndex ? idx : null;
  });
  if (indices.every((i): i is number => i != null)) {
    const selected: string[] = [];
    for (const i of indices) {
      const label = question.options[i]!.label;
      if (!selected.includes(label)) selected.push(label);
    }
    return [withId(question, { question: question.question, kind: 'multi', answer: null, selected })];
  }
  return question.allowOther
    ? [withId(question, { question: question.question, kind: 'custom', answer: OTHER_ANSWER, customInput: trimmed })]
    : undefined;
}

/** Ask one question, both modes: the pier dialog, then the host's select dialog (single only), then
 *  the typed prompt. `ui.custom` is absent (or resolves undefined) in RPC mode, hence every rung. */
async function askQuestion(ui: AskUi, question: AskQuestion, signal?: AbortSignal): Promise<AskAnswer | undefined> {
  const { multi } = question;
  if (typeof ui.custom === 'function') {
    const toggleToolsExpanded = ui.getToolsExpanded && ui.setToolsExpanded
      ? (): void => ui.setToolsExpanded!(!ui.getToolsExpanded!())
      : undefined;
    const outcome = await runSelectDialog(
      ui.custom,
      question.question,
      {
        options: question.options,
        allowOther: question.allowOther,
        multi,
        ...(question.recommended !== undefined ? { recommended: question.recommended } : {}),
      },
      { ...(signal ? { signal } : {}), ...(toggleToolsExpanded ? { toggleToolsExpanded } : {}) },
    );
    if (outcome?.kind === 'cancel') return undefined;
    if (outcome?.kind === 'other') return askOtherText(ui, question, signal);
    if (outcome?.kind === 'selected') {
      return withId(
        question,
        multi
          ? { question: question.question, kind: 'multi', answer: null, selected: outcome.labels }
          : { question: question.question, kind: 'option', answer: outcome.labels[0]! },
      );
    }
  }
  const lines = optionLines(question);
  const opts = signal ? { signal } : undefined;
  // A multi question has no single-pick host dialog; its typed prompt is always the fallback.
  const select = multi ? undefined : ui.select;
  const hint = multi
    ? (question.allowOther ? MULTI_INSTRUCTIONS : MULTI_NO_OTHER_INSTRUCTIONS)
    : NUMBERED_HINT;
  const raw = select
    ? await select(question.question, lines, opts)
    : await ui.input(`${question.question}\n\n${lines.join('\n')}\n\n${hint}`, multi ? '1,3' : '1', opts);
  if (raw == null) return undefined;
  const picks = parseTypedPicks(question, lines, raw, select === undefined);
  if (picks === 'other') return askOtherText(ui, question, signal);
  return picks?.[0];
}

export function formatAskContent(details: AskDetails): string {
  if (details.cancelled || details.answers.length === 0) return DECLINE_TEXT;
  const entries = details.answers.map((answer) => {
    if (answer.kind === 'custom' && answer.answer === OTHER_ANSWER) {
      const notes = answer.customInput ? ` user notes: ${answer.customInput}` : '';
      return `"${answer.question}"="${OTHER_ANSWER}"${notes}`;
    }
    if (answer.kind === 'multi') {
      const labels = answer.selected?.length ? answer.selected.join(', ') : '(none)';
      return `"${answer.question}"="${labels}"`;
    }
    return `"${answer.question}"="${answer.answer ?? ''}"`;
  });
  return `User has answered your questions: ${entries.join(', ')}. You can now continue with the user's answers in mind.`;
}

export async function runAsk(spec: AskSpec, ui: AskUi, signal?: AbortSignal): Promise<AskToolResult> {
  if (spec.mode === 'freeform') {
    const answer = await ui.input(spec.question, 'your answer', signal ? { signal } : undefined);
    if (answer == null || !answer.trim()) {
      return okResult({ answers: [], cancelled: true });
    }
    const trimmed = answer.trim();
    return okResult({
      answers: [{ question: spec.question, kind: 'custom', answer: trimmed, customInput: trimmed }],
      cancelled: false,
    });
  }
  const answers: AskAnswer[] = [];
  for (const question of spec.questions) {
    const answer = await askQuestion(ui, question, signal);
    if (!answer) return okResult({ answers, cancelled: true });
    answers.push(answer);
  }
  return okResult({ answers, cancelled: false });
}
