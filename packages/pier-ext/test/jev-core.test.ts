/** jev decision layer (RFC docs/rfc-jev-integration.md): the pure core (parsing, the three call-site
 *  decisions, the P0-3 placeholder guard) plus the direct HTTP client and its fail-open surfaces. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DIAGNOSTIC_OUTPUT_MIN_NOUL, NOTICE_RANK_MIN_CONFIDENCE, buildExcerptWindows, composeNoticeRanking,
  diagnosticGateRequest, evaluateDiagnosticGate, evaluateSettleVerdict, evaluateExcerptPick, excerptAskIsSafe,
  excerptPickRequest, isDiagnosticGateUnanswered, noticeRankRequest, parseJevAnswers, type JevAnswer, type JevQuestion,
} from '../src/jev-core.ts';
import { createJevRuntime } from '../src/jev-client.ts';
import type { JevConfig } from '../src/efficiency-config-core.ts';
import { formatObservationPlaceholder } from '../src/observation-core.ts';
import { withCleanup } from './test-utils.ts';
const VALID_RAW = {
  model: 'jev-1.13.0',
  answers: {
    kind: { type: 'choice', choice: 'build_test_run', probabilities: { build_test_run: 0.9, other: 0.1 }, confidence: 0.9 },
    urgent: { type: 'noul', noul: 0.8 },
    grade: { type: 'score', score: 1.5, probabilities: { '0': 0.2, '1': 0.3, '2': 0.5 }, confidence: 0.7 },
  },
  usage: { input_tokens: 120, output_tokens: 12 },
};

test('parseJevAnswers: a valid response parses into typed answers', () => {
  const parsed = parseJevAnswers(VALID_RAW, ['kind', 'urgent', 'grade']);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.model, 'jev-1.13.0');
  assert.equal(parsed.usage.inputTokens, 120);
  assert.equal(parsed.answers.kind!.type, 'choice');
  assert.equal(parsed.answers.urgent!.type, 'noul');
});

/** [case, raw response, requested keys] — every malformed shape must be rejected outright. */
const PARSE_REJECTS: Array<[string, unknown, string[]]> = [
  ['an answer missing from the response', VALID_RAW, ['kind', 'missing']],
  ['noul out of range', { ...VALID_RAW, answers: { ...VALID_RAW.answers, urgent: { type: 'noul', noul: 1.5 } } }, ['urgent']],
  ['negative usage tokens', { ...VALID_RAW, usage: { input_tokens: -1, output_tokens: 0 } }, ['kind']],
  ['a response that is not an object', 'nope', ['kind']],
];

test('parseJevAnswers: rejects missing answers, out-of-range noul, bad usage and non-objects', () => {
  for (const [name, raw, keys] of PARSE_REJECTS) assert.equal(parseJevAnswers(raw, keys).ok, false, name);
});

/* P0-1: diagnostic gate */
test('diagnosticGateRequest: state carries only the command line, questions are a closed set', () => {
  const request = diagnosticGateRequest('deno test --allow-read');
  assert.deepEqual(request.state, { command: 'deno test --allow-read' });
  assert.deepEqual(Object.keys(request.questions).sort(), ['cmd_kind', 'diagnostic_output']);
});

function gateAnswers(choice: string, confidence: number, noul: number): Record<string, JevAnswer> {
  return {
    cmd_kind: { type: 'choice', choice, probabilities: { [choice]: 1 }, confidence },
    diagnostic_output: { type: 'noul', noul },
  };
}

/** [case, answers, verdict] — the reason string is what jev.jsonl records. */
const GATE_CASES: Array<[string, Record<string, JevAnswer>, { hit: boolean; reason: string }]> = [
  ['a diagnostic command with diagnostic output hits', gateAnswers('build_test_run', 0.9, 0.95), { hit: true, reason: 'hit' }],
  ['a non-target command kind does not hit', gateAnswers('install_deps', 0.99, 0.99), { hit: false, reason: 'not-build-test:install_deps' }],
  ['confidence below the gate does not hit', gateAnswers('build_test_run', 0.5, 0.99), { hit: false, reason: 'low-confidence' }],
  ['non-diagnostic output does not hit', gateAnswers('build_test_run', 0.9, DIAGNOSTIC_OUTPUT_MIN_NOUL - 0.01), { hit: false, reason: 'non-diagnostic-output' }],
  ['no answers at all does not hit', {}, { hit: false, reason: 'missing-answer' }],
];

test('evaluateDiagnosticGate: hit / not-build-test / low-confidence / non-diagnostic-output', () => {
  for (const [name, answers, expected] of GATE_CASES) {
    const verdict = evaluateDiagnosticGate(answers, 0.6);
    assert.equal(verdict.hit, expected.hit, name);
    assert.equal(verdict.reason, expected.reason, name);
    if (!expected.hit) continue;
    assert.deepEqual({ reason: verdict.reason, confidence: verdict.confidence, choice: verdict.choice, noul: verdict.noul },
      { reason: 'hit', confidence: 0.9, choice: 'build_test_run', noul: 0.95 });
  }
});

/** [case, answers, unanswered] — unanswered means the regex list decides. */
const UNANSWERED_CASES: Array<[string, Record<string, JevAnswer>, boolean]> = [
  ['no answers', {}, true],
  ['low confidence', gateAnswers('build_test_run', 0.5, 0.99), true],
  ['a confident rejection', gateAnswers('install_deps', 0.99, 0.99), false],
  ['a confident hit with non-diagnostic output', gateAnswers('build_test_run', 0.9, 0.2), false],
  ['a confident hit', gateAnswers('build_test_run', 0.9, 0.95), false],
];

test('isDiagnosticGateUnanswered: missing and low-confidence fall back, confident answers do not', () => {
  for (const [name, answers, expected] of UNANSWERED_CASES) {
    assert.equal(isDiagnosticGateUnanswered(evaluateDiagnosticGate(answers, 0.6)), expected, name);
  }
});

/* P0-2: settlement ranking */
function rankAnswers(scores: Array<[number, number, number]>): Record<string, JevAnswer> {
  const answers: Record<string, JevAnswer> = {};
  scores.forEach(([score, confidence, noul], i) => {
    answers[`notice_${i}_rank`] = { type: 'score', score, probabilities: {}, confidence };
    answers[`notice_${i}_fail`] = { type: 'noul', noul };
  });
  return answers;
}

test('noticeRankRequest: state carries the todo texts (D1: sent as-is) and the settlements; instructions bind by index', () => {
  const request = noticeRankRequest({ inProgressTodos: ['wire gate'], notices: ['a', 'b'] });
  assert.deepEqual(request.state, { in_progress_todos: ['wire gate'], settlements: ['a', 'b'] });
  assert.deepEqual(Object.keys(request.questions), ['notice_0_rank', 'notice_0_fail', 'notice_1_rank', 'notice_1_fail']);
  // Regression guard: keys are invisible to the model, so the instructions must reference
  // settlements[i] explicitly or all notices collapse into one question.
  assert.match((request.questions.notice_1_rank as { instructions: string }).instructions, /settlements\[1\]/);
  assert.match((request.questions.notice_0_fail as { instructions: string }).instructions, /settlements\[0\]/);
});

/** [case, notice count, [[score, confidence, noul]], min confidence, expected order (null = fail-open)] */
const RANK_CASES: Array<[string, number, Array<[number, number, number]>, number, number[] | null]> = [
  // Ordering is 0.6×score + 0.4×noul on normalized scores (0→0, 1→0.5, 2→1).
  ['scores and noul decide the order', 3, [[0, 0.9, 0.1], [2, 0.9, 0.9], [0, 0.9, 0.1]], 0.7, [1, 0, 2]],
  ['equal scores keep arrival order', 2, [[1, 0.9, 0.5], [1, 0.9, 0.5]], 0.7, [0, 1]],
  ['one low-confidence answer sinks without voiding the batch', 2, [[1, 0.9, 0.5], [2, 0.5, 0.5]], NOTICE_RANK_MIN_CONFIDENCE, [0, 1]],
  ['all answers low-confidence fails open', 2, [[1, 0.5, 0.5], [1, 0.5, 0.5]], NOTICE_RANK_MIN_CONFIDENCE, null],
  ['a missing answer fails open', 2, [[1, 0.9, 0.5]], 0.7, null],
  ['a low-score failure outranks a high-score routine notice', 2, [[2, 0.9, 0.1], [0, 0.9, 0.9]], 0.7, [1, 0]],
  ['noul exactly at the threshold pins', 2, [[2, 0.9, 0.1], [0, 0.9, 0.7]], 0.7, [1, 0]],
];

test('composeNoticeRanking: score/noul ordering, failure pinning and the fail-open fallbacks', () => {
  for (const [name, count, scores, min, expected] of RANK_CASES) {
    assert.deepEqual(composeNoticeRanking(count, rankAnswers(scores), min), expected, name);
  }
});

/* P0-3: excerpt windows */
function logWithMiddleFailure(): string {
  const head = Array.from({ length: 60 }, (_, i) => `setup line ${i}`).join('\n');
  const tail = Array.from({ length: 60 }, (_, i) => `cleanup noise ${i}`).join('\n');
  const middle = ['ok case 1', 'ok case 2', 'Error: assertion failed in test_deep', '  at deep.ts:42', 'ok case 3'].join('\n');
  return `${head}\n${middle}\n${tail}`;
}

test('buildExcerptWindows: the first signal line gets a window; signal-free logs still get the mid window', () => {
  const windows = buildExcerptWindows(logWithMiddleFailure(), 512);
  assert.ok(windows.length >= 1);
  assert.equal(windows[0]!.id, 'first_signal');
  assert.ok(windows[0]!.text.includes('Error: assertion failed'));
  // No failure-signal lines (e.g. CJK logs the English regex cannot see): the always-on mid window
  // keeps jev in the loop instead of skipping the call.
  const plain = Array.from({ length: 100 }, (_, i) => `plain ${i}`).join('\n');
  const midOnly = buildExcerptWindows(plain, 512);
  assert.deepEqual(midOnly.map((w) => w.id), ['mid']);
  assert.ok(midOnly[0]!.text.startsWith('plain 50'), 'mid window anchors at the middle line');
});

/** [case, model choice, confidence, expected pick (null = keep the mechanical excerpt)] */
const PICK_CASES: Array<[string, string, number, string | null]> = [
  ['first_signal wins over head/tail', 'first_signal', 0.8, 'first_signal'],
  ['keep_head_tail means no pick', 'keep_head_tail', 0.9, null],
  ['the mid window is pickable', 'mid', 0.8, 'mid'],
  ['low confidence means no pick', 'first_signal', 0.4, null],
];

test('excerptPickRequest/evaluateExcerptPick: candidates become options; keep_head_tail and low confidence yield null', () => {
  const windows = buildExcerptWindows(logWithMiddleFailure(), 512);
  const request = excerptPickRequest(windows, 'head', 'tail');
  assert.ok(request !== null);
  const criteria = (request!.questions.window as { criteria: Record<string, string> }).criteria;
  assert.ok('keep_head_tail' in criteria && 'first_signal' in criteria);
  for (const [name, choice, confidence, expected] of PICK_CASES) {
    const answers: Record<string, JevAnswer> = { window: { type: 'choice', choice, probabilities: {}, confidence } };
    assert.equal(evaluateExcerptPick(answers, 0.6), expected, name);
  }
  assert.equal(excerptPickRequest([], 'h', 't'), null);
});

/** [case, head excerpt, tail excerpt, safe] — every pack is sent out, so the key never leaves the machine. */
const ASK_SAFE_CASES: Array<[string, string, string, boolean]> = [
  ['clean windows and excerpts', 'head', 'tail', true],
  ['a credential in the head excerpt', 'Authorization: Bearer sk-abcdefghijklmnop12', 'tail', false],
  ['a credential in the tail excerpt', 'head', 'api_key=sk-abcdefghij123456', false],
];

test('excerptAskIsSafe: a credential shape in any part of the state stays local', () => {
  const clean = buildExcerptWindows(Array.from({ length: 100 }, (_, i) => `plain ${i}`).join('\n'), 256);
  assert.equal(clean.length > 0, true);
  for (const [name, head, tail, expected] of ASK_SAFE_CASES) assert.equal(excerptAskIsSafe(clean, head, tail), expected, name);
  const secretWindow = [{ id: 'mid' as const, label: 'm', text: 'password: sk-abcdefghij123456789012' }];
  assert.equal(excerptAskIsSafe(secretWindow, 'head', 'tail'), false);
});

/* P0-3: placeholder layout — a missing middle must equal the old bytes */
const PLACEHOLDER_INPUT = { id: 'obs_abc123def456abc123def456', toolName: 'bash', bytes: 65536, lines: 900,
  tokens: 16384, text: logWithMiddleFailure(), fullSends: 2, excerptBudget: 1024 };

// Independent byte-math recomputation (not a call into completeLineExcerpt):
// head lines are 13/14 bytes -> lines 0..36 fit in the 512 budget (508B);
// tail lines are 16/17 bytes -> lines 30..59 fit (509B).
const EXPECTED_HEAD = `${Array.from({ length: 37 }, (_, i) => `setup line ${i}`).join('\n')}\n`;
const EXPECTED_TAIL = Array.from({ length: 30 }, (_, i) => `cleanup noise ${i + 30}`).join('\n');

const LEGACY_PLACEHOLDER = [
  '[large tool result replaced after its first 2 provider requests]',
  'id: obs_abc123def456abc123def456',
  'tool: bash',
  'original_bytes: 65536',
  'original_lines: 900',
  'estimated_tokens: 16384',
  'retrieve: call obs_recall with {"id":"obs_abc123def456abc123def456","offset":0}; continue with returned next_offset',
  '[first complete lines, up to 512 bytes]',
  EXPECTED_HEAD,
  '[middle omitted; last complete lines, up to 512 bytes]',
  EXPECTED_TAIL,
  '[65536 original bytes omitted; recall via obs_recall]',
].join('\n');

test('formatObservationPlaceholder: a missing middle reproduces the legacy layout byte for byte', () => {
  assert.equal(formatObservationPlaceholder(PLACEHOLDER_INPUT), LEGACY_PLACEHOLDER);
});

test('formatObservationPlaceholder: a middle excerpt replaces the lower-signal half and says so', () => {
  const withMiddle = formatObservationPlaceholder({
    ...PLACEHOLDER_INPUT,
    middle: { text: 'Error: assertion failed in test_deep\n  at deep.ts:42', label: 'first failure-signal region' },
  });
  assert.ok(withMiddle.includes('selected excerpt — first failure-signal region'));
  assert.ok(withMiddle.includes('Error: assertion failed in test_deep'));
  // The head window (setup lines, no signal) is the one that yields.
  assert.ok(!withMiddle.includes('[first complete lines'));
  assert.ok(withMiddle.includes('[middle omitted; last complete lines'));
});

test('evaluateSettleVerdict: the attribution/answer pair yields three states, unparsed answers yield null', () => {
  const noul = (v: number) => ({ type: 'noul' as const, noul: v });
  /** [case, answers, expected verdict (null = the caller keeps its old wording)] */
  const CASES: Array<[string, Record<string, JevAnswer>, string | null]> = [
    ['the tail is another task', { tail_matches_task: noul(0.1), tail_has_final_answer: noul(0.2) }, 'attribution-suspect'],
    ['same task with a complete report', { tail_matches_task: noul(0.9), tail_has_final_answer: noul(0.9) }, 'extraction-failed'],
    ['same task without a final answer', { tail_matches_task: noul(0.9), tail_has_final_answer: noul(0.1) }, 'silent'],
    ['the attribution answer is missing', { tail_has_final_answer: noul(0.9) }, null],
    ['no answers at all', {}, null],
  ];
  for (const [name, answers, expected] of CASES) assert.equal(evaluateSettleVerdict(answers), expected, name);
});

/* ── direct HTTP client: createJevRuntime (RFC §5/§6) ── */
const QUESTIONS: Record<string, JevQuestion> = { kind: { type: 'noul', instructions: 'Is this a test?' } };
const config = (overrides: Partial<JevConfig> = {}): JevConfig =>
  ({ enabled: true, logEnabled: true, model: 'jev-1.13.0', timeoutMs: 500, minConfidence: 0.6, apiKey: 'sk-test', ...overrides });
const okBody = () => ({ model: 'jev-1.13.0', answers: { kind: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 42, output_tokens: 3 } });
const readLog = (root: string): Promise<string> => readFile(join(root, 'efficiency-logs', 'jev.jsonl'), 'utf8');

test('disabled / no-api-key: no request is sent, and both fail open with a reason', withCleanup(async (cleanup) => {
  const root = cleanup.tempDir('jev').path;
  let fetchCalls = 0;
  const runtime = createJevRuntime(() => config({ enabled: false }), {
    fetchImpl: () => { fetchCalls++; return Promise.resolve(new Response('{}')); }, getSessionRoot: () => root,
  });
  assert.equal(runtime.available, false);
  const disabled = await runtime.ask({ state: { command: 'x' }, questions: QUESTIONS }, { questionId: 'q' });
  assert.equal(disabled.ok, false);
  if (!disabled.ok) assert.equal(disabled.reason, 'disabled');
  const keyless = createJevRuntime(() => config({ apiKey: undefined }), { getSessionRoot: () => root });
  const noKey = await keyless.ask({ state: { command: 'x' }, questions: QUESTIONS }, { questionId: 'q' });
  if (!noKey.ok) assert.equal(noKey.reason, 'no-api-key');
  assert.equal(fetchCalls, 0);
  assert.match(await readLog(root), /"reason":"disabled"/);
}));

test('enrich hook: failure paths see empty answers, and the decision lands in telemetry', withCleanup(async (cleanup) => {
  const root = cleanup.tempDir('jev').path;
  const outcomes: string[] = [];
  const runtime = createJevRuntime(() => config(), {
    fetchImpl: async () => new Response('{"oops"', { status: 200 }), getSessionRoot: () => root,
  });
  const failed = await runtime.ask({ state: 's', questions: QUESTIONS }, {
    questionId: 'q',
    enrich: ({ ok, answers }) => { outcomes.push(`${ok}:${answers === null}`); return { verdict: 'unparsed' }; },
  });
  assert.equal(failed.ok, false);
  assert.deepEqual(outcomes, ['false:true']);
  assert.match(await readLog(root), /"verdict":"unparsed"/);
}));

test('success path: parses answers; telemetry carries the state hash, never the body', withCleanup(async (cleanup) => {
  const root = cleanup.tempDir('jev').path;
  let seenAuth = '';
  let seenUrl = '';
  const runtime = createJevRuntime(() => config(), {
    fetchImpl: async (input, init) => {
      seenUrl = String(input);
      seenAuth = (init?.headers as Record<string, string>).Authorization ?? '';
      return new Response(JSON.stringify(okBody()), { status: 200 });
    },
    getSessionRoot: () => root,
  });
  const result = await runtime.ask({ state: { command: 'SECRET-CMD-XYZ' }, questions: QUESTIONS }, { questionId: 'epr-gate' });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.answers.kind!.type, 'noul');
    assert.equal(result.model, 'jev-1.13.0');
  }
  assert.ok(seenUrl.endsWith('/v1/systemone'));
  assert.equal(seenAuth, 'Bearer sk-test');
  const log = await readLog(root);
  assert.match(log, /"questionId":"epr-gate"/);
  assert.match(log, /"verdict":"answered"/);
  assert.match(log, /"stateHash":"/);
  // Telemetry discipline: no request bodies, not even command plaintext.
  assert.ok(!log.includes('SECRET-CMD-XYZ'));
  assert.ok(!log.includes('sk-test'));
}));

/** [case, fetch impl, reason the ask fails open with] */
const FAILURE_CASES: Array<[string, typeof fetch, string]> = [
  ['rate limited', async () => new Response('rate limited', { status: 429 }), 'rate-limited'],
  ['network error', async () => { throw new Error('ECONNRESET'); }, 'network-error'],
  ['unparseable body', async () => new Response('not json', { status: 200 }), 'network-error'],
  ['timeout', (_input, init) => {
    const { promise, reject } = Promise.withResolvers<Response>();
    init?.signal?.addEventListener('abort', () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      reject(err);
    });
    return promise;
  }, 'timeout'],
];

test('429 / network / bad JSON / timeout: every one resolves with a fail-open reason', withCleanup(async (cleanup) => {
  const root = cleanup.tempDir('jev').path;
  for (const [name, fetchImpl, expected] of FAILURE_CASES) {
    const runtime = createJevRuntime(() => config(), { fetchImpl, getSessionRoot: () => root });
    const result = await runtime.ask({ state: 's', questions: QUESTIONS }, { questionId: 'q' });
    assert.equal(result.ok, false, name);
    if (!result.ok) assert.equal(result.reason, expected, name);
  }
  assert.match(await readLog(root), /"reason":"rate-limited"/);
}));

test('the available getter follows config reloads, and baseUrl loses its trailing slash', async () => {
  const mutable = config();
  let seenUrl = '';
  const runtime = createJevRuntime(() => mutable, {
    fetchImpl: async (input) => {
      seenUrl = String(input);
      return new Response(JSON.stringify(okBody()), { status: 200 });
    },
  });
  assert.equal(runtime.available, true);
  mutable.enabled = false;
  assert.equal(runtime.available, false, 'config reload must propagate');
  mutable.enabled = true;
  mutable.baseUrl = 'https://relay.example.com/';
  await runtime.ask({ state: 's', questions: QUESTIONS }, { questionId: 'q' });
  assert.equal(seenUrl, 'https://relay.example.com/v1/systemone');
});
