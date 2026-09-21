/**
 * Jev decision layer — pure core (RFC docs/rfc-jev-integration.md).
 *
 * Question/answer shapes mirror the closed set of POST /v1/systemone
 * (https://docs.typesafe.ai/api): noul / choice / score. No I/O here; the HTTP client and the
 * jev.jsonl telemetry live in jev-client.ts.
 *
 * RFC design rules: arithmetic, counting and thresholds stay in code; state carries only what each
 * question needs; instructions are English (CJK is handled but weaker, hence the stricter P0-2
 * gate); and any answer below its confidence gate counts as unanswered so callers fail open.
 */
import { containsLikelySecret, FAILURE_SIGNAL } from './reducer-core.ts';

// ---------------------------------------------------------------------------
// Request/response shapes (closed set)
// ---------------------------------------------------------------------------

export type JevQuestion =
  | { readonly type: 'noul'; readonly instructions: string; readonly criteria?: { readonly true?: string; readonly false?: string } }
  | { readonly type: 'choice'; readonly instructions: string; readonly criteria: Record<string, string> }
  | { readonly type: 'score'; readonly instructions: string; readonly criteria: readonly string[] };

export interface JevUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export type JevAnswer =
  | { readonly type: 'noul'; readonly noul: number }
  | { readonly type: 'choice'; readonly choice: string; readonly probabilities: Record<string, number>; readonly confidence: number }
  | { readonly type: 'score'; readonly score: number; readonly probabilities: Record<string, number>; readonly confidence: number };

export interface JevRequest {
  readonly state: unknown;
  readonly questions: Record<string, JevQuestion>;
}

export type JevParsed =
  | { readonly ok: true; readonly answers: Record<string, JevAnswer>; readonly model: string; readonly usage: JevUsage }
  | { readonly ok: false; readonly reason: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function finiteNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function unitNumber(v: unknown): number | undefined {
  const n = finiteNumber(v);
  return n !== undefined && n >= 0 && n <= 1 ? n : undefined;
}

type NoulAnswer = Extract<JevAnswer, { type: 'noul' }>;
type ChoiceAnswer = Extract<JevAnswer, { type: 'choice' }>;
type ScoreAnswer = Extract<JevAnswer, { type: 'score' }>;

/** A missing or wrongly-shaped answer counts as unanswered, never as a verdict (RFC fail-open). */
function noulAnswer(answers: Record<string, JevAnswer>, id: string): NoulAnswer | undefined {
  const answer = answers[id];
  return answer?.type === 'noul' ? answer : undefined;
}

function choiceAnswer(answers: Record<string, JevAnswer>, id: string): ChoiceAnswer | undefined {
  const answer = answers[id];
  return answer?.type === 'choice' ? answer : undefined;
}

function scoreAnswer(answers: Record<string, JevAnswer>, id: string): ScoreAnswer | undefined {
  const answer = answers[id];
  return answer?.type === 'score' ? answer : undefined;
}

function parseProbabilities(v: unknown): Record<string, number> | undefined {
  if (!isPlainObject(v)) return undefined;
  const out: Record<string, number> = {};
  for (const [k, raw] of Object.entries(v)) {
    const n = finiteNumber(raw);
    if (n === undefined) return undefined;
    out[k] = n;
  }
  return out;
}

/**
 * Strict validation of one response against the question ids we sent.
 * Extra answer ids are ignored; every expected id must be present and
 * well-formed or the whole call counts as unanswered (fail-open).
 */
export function parseJevAnswers(raw: unknown, expectedIds: readonly string[]): JevParsed {
  if (!isPlainObject(raw)) return { ok: false, reason: 'response-not-object' };
  const model = typeof raw.model === 'string' && raw.model.trim() ? raw.model : undefined;
  if (model === undefined) return { ok: false, reason: 'missing-model' };
  const rawUsage = isPlainObject(raw.usage) ? raw.usage : undefined;
  const inputTokens = finiteNumber(rawUsage?.input_tokens);
  const outputTokens = finiteNumber(rawUsage?.output_tokens);
  if (inputTokens === undefined || inputTokens < 0 || outputTokens === undefined || outputTokens < 0) {
    return { ok: false, reason: 'bad-usage' };
  }
  const rawAnswers = isPlainObject(raw.answers) ? raw.answers : undefined;
  if (rawAnswers === undefined) return { ok: false, reason: 'missing-answers' };

  const answers: Record<string, JevAnswer> = {};
  for (const id of expectedIds) {
    const a = isPlainObject(rawAnswers[id]) ? rawAnswers[id] : undefined;
    if (a === undefined) return { ok: false, reason: `missing-answer:${id}` };
    if (a.type === 'noul') {
      const noul = unitNumber(a.noul);
      if (noul === undefined) return { ok: false, reason: `bad-noul:${id}` };
      answers[id] = { type: 'noul', noul };
      continue;
    }
    if (a.type === 'choice') {
      const choice = typeof a.choice === 'string' ? a.choice : undefined;
      const probabilities = parseProbabilities(a.probabilities);
      const confidence = unitNumber(a.confidence);
      if (choice === undefined || probabilities === undefined || confidence === undefined) {
        return { ok: false, reason: `bad-choice:${id}` };
      }
      answers[id] = { type: 'choice', choice, probabilities, confidence };
      continue;
    }
    if (a.type === 'score') {
      const score = finiteNumber(a.score);
      const probabilities = parseProbabilities(a.probabilities);
      const confidence = unitNumber(a.confidence);
      if (score === undefined || score < 0 || probabilities === undefined || confidence === undefined) {
        return { ok: false, reason: `bad-score:${id}` };
      }
      answers[id] = { type: 'score', score, probabilities, confidence };
      continue;
    }
    return { ok: false, reason: `unknown-answer-type:${id}` };
  }
  return { ok: true, answers, model, usage: { inputTokens, outputTokens } };
}

// ---------------------------------------------------------------------------
// P0-1: EPR diagnostic-command gate
// ---------------------------------------------------------------------------

export const DIAGNOSTIC_OUTPUT_MIN_NOUL = 0.6;

const DIAGNOSTIC_GATE_QUESTIONS: Record<string, JevQuestion> = {
  cmd_kind: {
    type: 'choice',
    instructions: 'What kind of shell command is this?',
    criteria: {
      build_test_run: 'Runs a build, test, lint, or typecheck pipeline whose output is repetitive diagnostic log lines (pass/fail, errors, warnings)',
      install_deps: 'Installs or updates dependencies (npm/pip/cargo fetch); output is progress bars and version lists',
      server_watch: 'Starts a long-running server, watcher, or REPL that stays in the foreground',
      source_inspection: 'Prints or searches source/config (cat, ls, grep, git log, diff)',
      other: 'None of the above',
    },
  },
  diagnostic_output: {
    type: 'noul',
    instructions: 'Will this command produce repetitive test/build diagnostic log output (rather than conversational or interactive output)?',
  },
};

export function diagnosticGateRequest(command: string): JevRequest {
  return { state: { command }, questions: DIAGNOSTIC_GATE_QUESTIONS };
}

export interface DiagnosticGateVerdict {
  readonly hit: boolean;
  readonly reason: string;
  readonly confidence: number | null;
  /** Selected cmd_kind option (telemetry); null when the answer was malformed. */
  readonly choice: string | null;
  /** diagnostic_output noul value (telemetry); null when the answer was malformed. */
  readonly noul: number | null;
}
export function evaluateDiagnosticGate(
  answers: Record<string, JevAnswer>,
  minConfidence: number,
): DiagnosticGateVerdict {
  const kind = choiceAnswer(answers, 'cmd_kind');
  const output = noulAnswer(answers, 'diagnostic_output');
  if (kind === undefined || output === undefined) {
    return { hit: false, reason: 'missing-answer', confidence: null, choice: null, noul: null };
  }
  if (kind.choice !== 'build_test_run') {
    return { hit: false, reason: `not-build-test:${kind.choice}`, confidence: kind.confidence, choice: kind.choice, noul: output.noul };
  }
  if (kind.confidence < minConfidence) {
    return { hit: false, reason: 'low-confidence', confidence: kind.confidence, choice: kind.choice, noul: output.noul };
  }
  if (output.noul < DIAGNOSTIC_OUTPUT_MIN_NOUL) {
    return { hit: false, reason: 'non-diagnostic-output', confidence: kind.confidence, choice: kind.choice, noul: output.noul };
  }
  return { hit: true, reason: 'hit', confidence: kind.confidence, choice: kind.choice, noul: output.noul };
}

/** Flip semantics: jev judges first, the regex list decides only when jev produced no usable answer
 * (failure, malformed, below gate). A confident rejection outranks a regex match. */
export function isDiagnosticGateUnanswered(verdict: DiagnosticGateVerdict): boolean {
  return verdict.reason === 'missing-answer' || verdict.reason === 'low-confidence';
}

// ---------------------------------------------------------------------------
// P0-2: settlement-notice relevance ranking
// ---------------------------------------------------------------------------

/**
 * Stricter than the global default: settlement text is mostly Chinese while English is jev's primary
 * training language, so the initial gate starts at 0.7 and calibrates from jev.jsonl.
 */
export const NOTICE_RANK_MIN_CONFIDENCE = 0.7;
const RANK_SCORE_WEIGHT = 0.6;

const RANK_LEVELS = [
  'Routine completion; the master agent can check it later',
  'The master agent should be aware; it affects planning',
  'Reports a failure, error, or blocked state needing immediate attention',
] as const;

export function noticeRankRequest(input: {
  inProgressTodos: readonly string[];
  notices: readonly string[];
}): JevRequest {
  const questions: Record<string, JevQuestion> = {};
  for (let i = 0; i < input.notices.length; i++) {
    // Question keys are NOT sent to the model, so identical instructions would collapse every
    // notice into one question (observed live: five identical answers). Name the state index.
    questions[`notice_${i}_rank`] = {
      type: 'score',
      instructions: `How urgently does the master agent need to see settlements[${i}] right now, given in_progress_todos?`,
      criteria: RANK_LEVELS,
    };
    questions[`notice_${i}_fail`] = {
      type: 'noul',
      instructions: `Does settlements[${i}] report a failure, error, or blocked state?`,
    };
  }
  return {
    state: {
      in_progress_todos: input.inProgressTodos,
      settlements: input.notices,
    },
    questions,
  };
}

/** A settlement whose fail-noul clears this is pinned to the front regardless of relevance score:
 * score noise on CJK reordered the same failure notice beyond the cap of shown notices. */
const NOTICE_FAIL_PIN_THRESHOLD = 0.7;

/**
 * Display order: pinned failures first, then descending composed relevance (stable on ties ->
 * arrival order). Per-item confidence gate: an item below the gate sinks to the routine bucket
 * instead of voiding the batch (one unsure routine notice must not reorder everything back). All
 * items gated -> null. The fail pin ignores the score gate: noul answers carry no confidence field
 * and failure visibility is the safety property.
 */
export function composeNoticeRanking(
  noticeCount: number,
  answers: Record<string, JevAnswer>,
  minConfidence: number,
): number[] | null {
  const entries: Array<{ pin: number; value: number; index: number }> = [];
  let answered = 0;
  for (let i = 0; i < noticeCount; i++) {
    const rank = scoreAnswer(answers, `notice_${i}_rank`);
    const fail = noulAnswer(answers, `notice_${i}_fail`);
    if (rank === undefined || fail === undefined) return null;
    const gated = rank.confidence < minConfidence;
    if (!gated) answered++;
    const normalizedScore = rank.score / Math.max(1, RANK_LEVELS.length - 1);
    entries.push({
      pin: fail.noul >= NOTICE_FAIL_PIN_THRESHOLD ? 1 : 0,
      value: gated ? 0 : RANK_SCORE_WEIGHT * normalizedScore + (1 - RANK_SCORE_WEIGHT) * fail.noul,
      index: i,
    });
  }
  if (answered === 0) return null;
  entries.sort((a, b) => (b.pin - a.pin) || (b.value - a.value) || (a.index - b.index));
  return entries.map((entry) => entry.index);
}

// ---------------------------------------------------------------------------
// P0-3: OBS excerpt window candidates (head/tail halves miss the middle)
// ---------------------------------------------------------------------------

export type ExcerptWindowId = 'first_signal' | 'densest' | 'mid';

export interface ExcerptWindow {
  readonly id: ExcerptWindowId;
  readonly label: string;
  readonly text: string;
}

interface LineWindow {
  readonly text: string;
  readonly bytes: number;
  readonly signalCount: number;
}

function buildLineWindow(lines: readonly string[], start: number, budgetBytes: number, signalLines: ReadonlySet<number>): LineWindow | null {
  const selected: string[] = [];
  let bytes = 0;
  let signalCount = 0;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!;
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1; // +1 newline
    if (bytes + lineBytes > budgetBytes) {
      if (selected.length === 0) return null; // anchor line alone exceeds the budget
      break;
    }
    selected.push(line);
    bytes += lineBytes;
    if (signalLines.has(i)) signalCount++;
  }
  if (selected.length === 0) return null;
  return { text: selected.join('\n'), bytes, signalCount };
}

/**
 * Code-owned middle-window candidates for a packed observation: failure-signal windows (first hit,
 * densest cluster) when present, plus a plain mid-output window ALWAYS offered, so jev judges every
 * packed output — including logs whose failure lines the English FAILURE_SIGNAL regex cannot see
 * (CJK output, exit-code-only failures). Deterministic, no model.
 */
export function buildExcerptWindows(text: string, halfBudgetBytes: number): ExcerptWindow[] {
  if (halfBudgetBytes <= 0) return [];
  const lines = text.split('\n');
  const signalLines = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (FAILURE_SIGNAL.test(lines[i]!)) signalLines.add(i);
  }

  const out: ExcerptWindow[] = [];
  const seen = new Set<string>();

  if (signalLines.size > 0) {
    const first = Math.min(...signalLines);
    const firstWindow = buildLineWindow(lines, Math.max(0, first - 2), halfBudgetBytes, signalLines);
    if (firstWindow !== null && !seen.has(firstWindow.text)) {
      seen.add(firstWindow.text);
      out.push({ id: 'first_signal', label: 'first failure-signal region', text: firstWindow.text });
    }

    // Densest cluster: anchor at every signal line, extend greedily while in budget.
    let best: LineWindow | null = null;
    for (const anchor of signalLines) {
      const window = buildLineWindow(lines, anchor, halfBudgetBytes, signalLines);
      if (window === null) continue;
      if (best === null || window.signalCount > best.signalCount) best = window;
    }
    if (best !== null && !seen.has(best.text)) {
      seen.add(best.text);
      out.push({ id: 'densest', label: 'densest failure-signal region', text: best.text });
    }
  }

  const midAnchor = Math.min(Math.floor(lines.length / 2), Math.max(0, lines.length - 1));
  const midWindow = buildLineWindow(lines, midAnchor, halfBudgetBytes, signalLines);
  if (midWindow !== null && !seen.has(midWindow.text)) {
    out.push({ id: 'mid', label: 'middle region of the output', text: midWindow.text });
  }
  return out;
}

export function excerptPickRequest(
  middleWindows: readonly ExcerptWindow[],
  headExcerpt: string,
  tailExcerpt: string,
): JevRequest | null {
  if (middleWindows.length === 0) return null;
  const criteria: Record<string, string> = {
    keep_head_tail: 'The existing head and tail excerpts are already the most informative; keep them',
  };
  const excerpts: Record<string, string> = { head_excerpt: headExcerpt, tail_excerpt: tailExcerpt };
  for (const window of middleWindows) {
    criteria[window.id] = `${window.label}: excerpt from the middle of the output`;
    excerpts[window.id] = window.text;
  }
  return {
    state: { excerpts },
    questions: {
      window: {
        type: 'choice',
        instructions: 'A large tool output was replaced by a placeholder keeping two short excerpts. Which excerpt set would most help a coding agent locate the problem without recalling the full text?',
        criteria,
      },
    },
  };
}

export function evaluateExcerptPick(
  answers: Record<string, JevAnswer>,
  minConfidence: number,
): ExcerptWindowId | null {
  const picked = choiceAnswer(answers, 'window');
  if (picked === undefined) return null;
  if (picked.confidence < minConfidence) return null;
  return picked.choice === 'first_signal' || picked.choice === 'densest' || picked.choice === 'mid'
    ? picked.choice
    : null;
}

/**
 * Local privacy gate for the excerpt-pick request: its state is the head/tail excerpts plus the
 * candidate windows, and it is sent for EVERY packed output — a path the EPR secret gate never
 * covers. Credential-shaped text in any part keeps the whole request local (legacy halves, no call).
 */
export function excerptAskIsSafe(
  middleWindows: readonly ExcerptWindow[],
  headExcerpt: string,
  tailExcerpt: string,
): boolean {
  const parts = [headExcerpt, tailExcerpt, ...middleWindows.map((w) => w.text)];
  return !parts.some((part) => containsLikelySecret(part));
}

// ---------------------------------------------------------------------------
// P0-4: settlement attribution check (p24-class "left no closing message")
//---------------------------------------------------------------------------

/**
 * Noul answers carry no confidence field (unlike choice/score), so this use case gates on the noul
 * probabilities themselves via dedicated constants, like DIAGNOSTIC_OUTPUT_MIN_NOUL.
 */
const SETTLE_MATCH_MIN_NOUL = 0.6;
const SETTLE_FINAL_MIN_NOUL = 0.6;


export type SettleNullVerdict = 'silent' | 'attribution-suspect' | 'extraction-failed';

/** State is the delegated task plus the transcript tail we actually read. */
export function settleVerdictRequest(input: { description: string; tail: string }): JevRequest {
  return {
    state: { task: input.description, transcriptTail: input.tail },
    questions: {
      tail_matches_task: {
        type: 'noul',
        instructions: 'Is this transcript tail from a session working on the described task? Answer false only when the tail is clearly about a different task or conversation.',
        criteria: {
          true: 'The tail discusses, works on, or reports on the described task',
          false: 'The tail is about an unrelated task or a different conversation',
        },
      },
      tail_has_final_answer: {
        type: 'noul',
        instructions: 'Does the transcript tail end with (or contain) a complete final answer or report for the task, rather than only intermediate tool exchanges?',
        criteria: {
          true: 'A complete final answer/report is present',
          false: 'Only intermediate steps, questions, or tool exchanges — no final answer',
        },
      },
    },
  };
}
/**
 * Compose the null-closing verdict. null = unanswered (jev off / failed / wrong shapes) — callers
 * fall back to deterministic signals and the legacy wording, so jev-off stays byte-identical.
 */
export function evaluateSettleVerdict(answers: Record<string, JevAnswer>): SettleNullVerdict | null {
  const match = noulAnswer(answers, 'tail_matches_task');
  const fin = noulAnswer(answers, 'tail_has_final_answer');
  if (match === undefined || fin === undefined) return null;
  if (match.noul < SETTLE_MATCH_MIN_NOUL) return 'attribution-suspect';
  if (fin.noul >= SETTLE_FINAL_MIN_NOUL) return 'extraction-failed';
  return 'silent';
}

/** Privacy gate shared with EPR: never ship credential-shaped tails off-host. */
export function settleAskIsSafe(tail: string): boolean {
  return !containsLikelySecret(tail);
}
