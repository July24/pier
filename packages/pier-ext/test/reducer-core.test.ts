/**
 * D102 Evidence-Preserving Reducer core: the diagnostic-command list, credential shapes, receipt
 * validation, the receipt text the model reads, truncation-notice parsing and usage merging.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  containsLikelySecret, extractLikelySecretMatch, formatReceiptText, fullOutputPathFromNotice,
  isDiagnosticCommand, mergeUsage, REDUCER_RECEIPT_PREFIX, REDUCER_RECEIPT_SCHEMA, sha256Hex, validateReceipt,
} from '../src/reducer-core.ts';
/** Every top-level alternation plus a leading separator: ; & | ( ) whitespace. */
const DIAGNOSTIC_COMMANDS = [
  'npm test', 'pnpm test --run', 'cargo test --all', 'pytest tests/', 'node --test "test/*.test.ts"',
  'vitest run', 'make build', 'lake build', 'lake env lean Foo.lean', 'lean --run Main.lean', 'coq top',
  'cargo build --release', 'cargo check', 'zig build -Doptimize=ReleaseFast', 'python -m pytest tests',
  'python3 -m unittest discover', 'python3 -m py_compile main.py', 'ctest --output-on-failure',
  'cmake --build build', 'ninja all', 'go test ./...', 'bazel test //pkg:all', 'yarn test --watch=false',
  'make test', 'echo hi && cargo test', 'true; pytest -q', '(npm test)', 'a | jest', 'x&vitest run',
];
const NON_DIAGNOSTIC_COMMANDS = [
  'ls -la', 'git status', 'echo "done"',
  // A diagnostic word must not match inside a longer word.
  'makefile targets', 'makeup kit', 'leaning tower', 'coqtop -q', 'golist all', 'jesting around', 'npm run test',
];

test('isDiagnosticCommand: pins every alternation, separator and word boundary', () => {
  for (const cmd of DIAGNOSTIC_COMMANDS) assert.equal(isDiagnosticCommand(cmd), true, cmd);
  for (const cmd of NON_DIAGNOSTIC_COMMANDS) assert.equal(isDiagnosticCommand(cmd), false, cmd);
});

/** The value shape gates, never the bare keyword. */
const SECRET_TEXTS = [
  'Authorization: Bearer secret_token_12345', 'const api_key = "sk-1234567890abcdef"',
  'access_token: ghp_abcdef123456', '"api_key": "sk-1234567890abcdef123456"',
  // Quoted JSON forms: the opening quote must not shield the value shape.
  '"Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"',
];
const NON_SECRET_TEXTS = [
  'Test failed at line 42: assert.equal(1, 2)', 'Standard compilation output ok',
  // 2026-09-17 trial false positives.
  'containsLikelySecret: detects credential patterns', '"Authorization":[]',
  'secret = require_app_credentials(settings)', 'authorization": "/oauth/v1/device_authorization",',
  'AccessToken      string `json:"accessToken"`',
];

test('containsLikelySecret: detects credential-shaped values, ignores prose shapes', () => {
  for (const text of SECRET_TEXTS) assert.equal(containsLikelySecret(text), true, text);
  for (const text of NON_SECRET_TEXTS) assert.equal(containsLikelySecret(text), false, text);
});

test('extractLikelySecretMatch: masks the value, keeps the keyword shape and a sha8', () => {
  const snippet = extractLikelySecretMatch('Error in run: api_key = "sk-supersecretkey1234567890"');
  assert.ok(snippet);
  assert.ok(snippet!.startsWith('api_key ='));
  assert.ok(snippet!.includes('<redacted:'));
  assert.ok(/sha8=[0-9a-f]{8}/.test(snippet!));
  assert.ok(!snippet!.includes('supersecretkey'));
  // Same secret → same sha8 (correlatable across runs).
  const again = extractLikelySecretMatch('other line\napi_key = sk-supersecretkey1234567890 done');
  assert.ok(again);
  assert.equal(again!.slice(again!.indexOf('sha8=')), snippet!.slice(snippet!.indexOf('sha8=')));
  assert.equal(extractLikelySecretMatch('nothing here'), undefined);
});

const TEST_LOG = [
  'Running test suite...', 'AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
  '+ actual - expected', '+ 404', '- 200', '    at Context.<anonymous> (test/api.test.ts:45:12)',
  '1 failed, 12 passed',
].join('\n');

/** [name, source log, receipt fields, isError, expected reason (absent = accepted), fenced?, evidence lines] */
const RECEIPT_CASES: Array<[string, string, Record<string, unknown>, boolean, string?, boolean?, Array<number | undefined>?]> = [
  ['verifies byte-for-byte quotations and reports their line numbers', TEST_LOG,
    { status: 'failure', evidence: [
      { kind: 'failure', quote: 'AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:' },
      { kind: 'summary', quote: '1 failed, 12 passed' },
    ] }, true, undefined, undefined, [2, 7]],
  ['rejects a slightly altered (hallucinated) quote', TEST_LOG,
    { status: 'failure', evidence: [{ kind: 'failure', quote: 'AssertionError: Expected values to be strictly equal:' }] },
    true, 'unverifiable-quote'],
  // The 2026-09-17 trial lost 3/8 workbench attempts to fenced output.
  ['accepts a receipt wrapped in a Markdown json fence', 'Error: boom\n1 failed, 0 passed',
    { status: 'failure', evidence: [{ kind: 'fatal', quote: 'Error: boom' }] }, true, undefined, true, [1]],
  ['rejects a success claim for an errored result', 'Error: connection refused at port 8080',
    { status: 'success', evidence: [] }, true, 'schema-mismatch'],
  // Only summary evidence is provided for a panic.
  ['demands failure evidence when failure signals are present', 'panic: runtime error in thread main',
    { status: 'failure', evidence: [{ kind: 'summary', quote: 'panic: runtime error' }] }, true, 'missing-failure-evidence'],
];

test('validateReceipt: verifies quotations, accepts fenced output, and names every rejection reason', () => {
  for (const [name, log, fields, isError, reason, fenced, lines] of RECEIPT_CASES) {
    const receipt = JSON.stringify({ schema: REDUCER_RECEIPT_SCHEMA, source_sha256: sha256Hex(log), uncertain: false, ...fields });
    const res = validateReceipt(fenced ? `\`\`\`json\n${receipt}\n\`\`\`` : receipt, sha256Hex(log), log, isError);
    assert.equal(res.ok, !reason, name);
    if (!res.ok) assert.equal(res.reason, reason, name);
    else assert.deepEqual([res.value.status, ...res.value.evidence.map((e) => e.line)], ['failure', ...lines!], name);
  }
});

test('formatReceiptText: banner, per-evidence lines and the readback/authority footer', () => {
  const base = {
    command: 'npm test', sourceHash: 'a'.repeat(64), sourceBytes: 15000, sourceLines: 200,
    sourceArtifactPath: '/tmp/session/objects/a.txt', model: 'gemini-3.8-flash-high',
  };
  const receipt = formatReceiptText({
    ...base,
    totalTokens: 520,
    validated: {
      status: 'failure', uncertain: false,
      evidence: [
        { kind: 'fatal', line: undefined, quote: 'boom', quoteSha256: 'b'.repeat(64) },
        { kind: 'failure', line: 42, quote: 'AssertionError: expected 1 to equal 2', quoteSha256: 'c'.repeat(64) },
      ],
    },
  });
  const lines = receipt.split('\n');
  assert.equal(lines[0], REDUCER_RECEIPT_PREFIX);
  assert.ok(lines.every((line) => !line.includes('\r')), 'receipt stays LF-joined');
  assert.match(receipt, /- kind=fatal line=\? /, 'an unknown line number renders as ?');
  assert.match(receipt, /- kind=failure line=42 /);
  assert.match(receipt, /source_artifact=\/tmp\/session\/objects\/a\.txt/);
  assert.match(receipt, /reducer_model=gemini-3\.8-flash-high/);
  assert.match(receipt, /readback=use bash with explicit range on \/tmp\/session\/objects\/a\.txt/);
  // The receipt is evidence, not a verdict: the model must keep adjudicating.
  assert.match(receipt, /authority=this receipt is verified evidence only.*pass\/fail adjudication/);
  // A known provider is recorded for cost attribution; an unknown one is omitted, not faked.
  assert.equal(receipt.includes('reducer_provider='), false);
  const withProvider = formatReceiptText({ ...base, provider: 'cliproxy', validated: { status: 'success', uncertain: false, evidence: [] } });
  assert.match(withProvider, /reducer_provider=cliproxy/);
});

/** [name, text, expected path] — the first four are the shapes pi appends to a large bash result. */
const NOTICE_CASES: Array<[string, string, string | undefined]> = [
  ['plain notice', '[Showing lines 1-2000 of 5000. Full output: /tmp/pi-bash-a1.log]', '/tmp/pi-bash-a1.log'],
  ['byte-limit notice', '[Showing lines 1-2000 of 5000 (50KB limit). Full output: /tmp/pi-bash-b2.log]', '/tmp/pi-bash-b2.log'],
  ['long-line notice', '[Showing last 50KB of line 12 (line is 80KB). Full output: /tmp/pi-bash-c3.log]', '/tmp/pi-bash-c3.log'],
  ['notice after an exit line', 'Command exited with code 1\n\n[Output truncated. Full output: /tmp/pi-bash-d4.log]', '/tmp/pi-bash-d4.log'],
  // The notice is the only source consulted; anything else must yield nothing.
  ['no notice at all', 'plain log without a truncation footer', undefined],
  ['notice without a path', '[Showing lines 1-5 of 10]', undefined],
  ['empty path', 'Full output:   ', undefined],
  ['unbracketed phrase in the log', 'Full output: /tmp/pi-bash-decoy.log\nstill running', undefined],
  // When several bracketed notices appear, the trailing one (pi's own) wins.
  ['trailing notice wins', '[Showing lines 1-2 of 9. Full output: /tmp/pi-bash-early.log]\nmore log\n[Showing lines 1-2 of 90. Full output: /tmp/pi-bash-late.log]', '/tmp/pi-bash-late.log'],
];

test('fullOutputPathFromNotice: recovers the path from every pi truncation notice shape', () => {
  for (const [name, text, expected] of NOTICE_CASES) assert.equal(fullOutputPathFromNotice(text), expected, name);
});

test('mergeUsage: always returns a COMPLETE pi Usage (footer reads cost.total unguarded)', () => {
  // Regression guard: a partial object crashed pi's footer renderer (2026-09-13, subagent pane).
  const empty = mergeUsage();
  assert.deepEqual(Object.keys(empty).sort(), ['cacheRead', 'cacheWrite', 'cost', 'input', 'output', 'totalTokens']);
  assert.deepEqual(Object.keys(empty.cost).sort(), ['cacheRead', 'cacheWrite', 'input', 'output', 'total']);
  for (const [k, v] of Object.entries(empty)) {
    if (k === 'cost') continue;
    assert.equal(typeof v, 'number', `${k} must be numeric`);
  }
  for (const v of Object.values(empty.cost)) assert.equal(typeof v, 'number');
});

test('mergeUsage: sums both sides field by field and tolerates missing cost', () => {
  const merged = mergeUsage(
    { input: 100, output: 10, totalTokens: 110 },
    { input: 5, output: 7, cacheRead: 3, cacheWrite: 2, totalTokens: 17, cost: { total: 0.25, input: 0.1 } },
  );
  assert.deepEqual(merged, {
    input: 105, output: 17, cacheRead: 3, cacheWrite: 2, totalTokens: 127,
    cost: { input: 0.1, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
  });
});
