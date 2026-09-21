/**
 * D102 Evidence-Preserving Reducer Core Tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  containsLikelySecret,
  extractLikelySecretMatch,
  formatReceiptText,
  fullOutputPathFromNotice,
  isDiagnosticCommand,
  mergeUsage,
  REDUCER_RECEIPT_PREFIX,
  REDUCER_RECEIPT_SCHEMA,
  sha256Hex,
  validateReceipt,
} from '../src/reducer-core.ts';

test('isDiagnosticCommand: detects test and build commands correctly', () => {
  assert.equal(isDiagnosticCommand('npm test'), true);
  assert.equal(isDiagnosticCommand('pnpm test --run'), true);
  assert.equal(isDiagnosticCommand('cargo test --all'), true);
  assert.equal(isDiagnosticCommand('pytest tests/'), true);
  assert.equal(isDiagnosticCommand('node --test "test/*.test.ts"'), true);
  assert.equal(isDiagnosticCommand('vitest run'), true);
  assert.equal(isDiagnosticCommand('make build'), true);

  assert.equal(isDiagnosticCommand('ls -la'), false);
  assert.equal(isDiagnosticCommand('git status'), false);
  assert.equal(isDiagnosticCommand('echo "done"'), false);
});

test('isDiagnosticCommand: pins every alternation, separator and word boundary', () => {
  // Every top-level alternation of DIAGNOSTIC_COMMAND must be reachable.
  for (const cmd of [
    'lake build',
    'lake env lean Foo.lean',
    'lean --run Main.lean',
    'coq top',
    'cargo build --release',
    'cargo check',
    'zig build -Doptimize=ReleaseFast',
    'python -m pytest tests',
    'python3 -m unittest discover',
    'python3 -m py_compile main.py',
    'ctest --output-on-failure',
    'cmake --build build',
    'ninja all',
    'go test ./...',
    'bazel test //pkg:all',
    'yarn test --watch=false',
  ]) {
    assert.equal(isDiagnosticCommand(cmd), true, cmd);
  }

  // Separators in the leading class: ; & | ( ) whitespace.
  for (const cmd of ['make test', 'echo hi && cargo test', 'true; pytest -q', '(npm test)', 'a | jest', 'x&vitest run']) {
    assert.equal(isDiagnosticCommand(cmd), true, cmd);
  }

  // Word boundaries: a diagnostic word must not match inside a longer word.
  for (const cmd of ['makefile targets', 'makeup kit', 'leaning tower', 'coqtop -q', 'golist all', 'jesting around', 'npm run test']) {
    assert.equal(isDiagnosticCommand(cmd), false, cmd);
  }
});

test('containsLikelySecret: detects credential-shaped values, ignores prose shapes', () => {
  assert.equal(containsLikelySecret('Authorization: Bearer secret_token_12345'), true);
  assert.equal(containsLikelySecret('const api_key = "sk-1234567890abcdef"'), true);
  assert.equal(containsLikelySecret('access_token: ghp_abcdef123456'), true);
  // Quoted JSON forms: the opening quote must not shield the value shape.
  assert.equal(containsLikelySecret('"api_key": "sk-1234567890abcdef123456"'), true);
  assert.equal(containsLikelySecret('"Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"'), true);


  assert.equal(containsLikelySecret('Test failed at line 42: assert.equal(1, 2)'), false);
  assert.equal(containsLikelySecret('Standard compilation output ok'), false);

  // 2026-09-17 trial false positives: value shape must gate, not the keyword.
  assert.equal(containsLikelySecret('containsLikelySecret: detects credential patterns'), false);
  assert.equal(containsLikelySecret('"Authorization":[]'), false);
  assert.equal(containsLikelySecret('secret = require_app_credentials(settings)'), false);
  assert.equal(containsLikelySecret('authorization": "/oauth/v1/device_authorization",'), false);
  assert.equal(containsLikelySecret('AccessToken      string `json:"accessToken"`'), false);
});
test('extractLikelySecretMatch: masks the value, keeps the keyword shape and a sha8', () => {
  const snippet = extractLikelySecretMatch('Error in run: api_key = "sk-supersecretkey1234567890"');
  assert.ok(snippet);
  assert.ok(snippet!.startsWith('api_key ='));
  assert.ok(snippet!.includes('<redacted:'));
  assert.ok(/sha8=[0-9a-f]{8}/.test(snippet!));
  assert.ok(!snippet!.includes('supersecretkey'));
  // Same secret → same sha8 (correlatable across runs), different → different.
  const again = extractLikelySecretMatch('other line\napi_key = sk-supersecretkey1234567890 done');
  assert.ok(again);
  assert.equal(again!.slice(again!.indexOf('sha8=')), snippet!.slice(snippet!.indexOf('sha8=')));
  assert.equal(extractLikelySecretMatch('nothing here'), undefined);
});

test('validateReceipt: accepts receipts wrapped in a Markdown json fence', () => {
  const sourceLog = 'Error: boom\n1 failed, 0 passed';
  const sourceHash = sha256Hex(sourceLog);
  const receipt = JSON.stringify({
    schema: REDUCER_RECEIPT_SCHEMA,
    source_sha256: sourceHash,
    status: 'failure',
    uncertain: false,
    evidence: [{ kind: 'fatal', quote: 'Error: boom' }],
  });

  // The 2026-09-17 trial lost 3/8 workbench attempts to fenced output.
  const res = validateReceipt('```json\n' + receipt + '\n```', sourceHash, sourceLog, true);
  assert.equal(res.ok, true);
});

test('validateReceipt: verifies exact byte-for-byte quotations', () => {
  const sourceLog = [
    'Running test suite...',
    'AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
    '+ actual - expected',
    '+ 404',
    '- 200',
    '    at Context.<anonymous> (test/api.test.ts:45:12)',
    '1 failed, 12 passed',
  ].join('\n');

  const sourceHash = sha256Hex(sourceLog);

  // 1. Valid failure receipt with verbatim quote
  const validReceipt = JSON.stringify({
    schema: REDUCER_RECEIPT_SCHEMA,
    source_sha256: sourceHash,
    status: 'failure',
    uncertain: false,
    evidence: [
      {
        kind: 'failure',
        quote: 'AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
      },
      {
        kind: 'summary',
        quote: '1 failed, 12 passed',
      },
    ],
  });

  const res1 = validateReceipt(validReceipt, sourceHash, sourceLog, true);
  assert.equal(res1.ok, true);
  if (res1.ok) {
    assert.equal(res1.value.status, 'failure');
    assert.equal(res1.value.evidence.length, 2);
    assert.equal(res1.value.evidence[0]!.line, 2);
  }

  // 2. Hallucinated / slightly altered quote must fail
  const alteredReceipt = JSON.stringify({
    schema: REDUCER_RECEIPT_SCHEMA,
    source_sha256: sourceHash,
    status: 'failure',
    uncertain: false,
    evidence: [
      {
        kind: 'failure',
        quote: 'AssertionError: Expected values to be strictly equal:', // missing [ERR_ASSERTION]
      },
    ],
  });

  const res2 = validateReceipt(alteredReceipt, sourceHash, sourceLog, true);
  assert.equal(res2.ok, false);
  assert.equal(res2.reason, 'unverifiable-quote');
});

test('validateReceipt: catches status and schema mismatches', () => {
  const sourceLog = 'Error: connection refused at port 8080';
  const sourceHash = sha256Hex(sourceLog);

  // Status mismatch: isError is true, but receipt claims success
  const mismatchStatus = JSON.stringify({
    schema: REDUCER_RECEIPT_SCHEMA,
    source_sha256: sourceHash,
    status: 'success',
    uncertain: false,
    evidence: [],
  });

  const res = validateReceipt(mismatchStatus, sourceHash, sourceLog, true);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'schema-mismatch');
});

test('validateReceipt: enforces failure evidence when failure signals present', () => {
  const sourceLog = 'panic: runtime error in thread main';
  const sourceHash = sha256Hex(sourceLog);

  // Only summary evidence provided for a panic
  const noFailureEvidence = JSON.stringify({
    schema: REDUCER_RECEIPT_SCHEMA,
    source_sha256: sourceHash,
    status: 'failure',
    uncertain: false,
    evidence: [{ kind: 'summary', quote: 'panic: runtime error' }], // missing fatal/failure kind
  });

  const res = validateReceipt(noFailureEvidence, sourceHash, sourceLog, true);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'missing-failure-evidence');
});

test('formatReceiptText: banner, per-evidence lines and the readback/authority footer', () => {
  const receipt = formatReceiptText({
    command: 'npm test',
    sourceHash: 'a'.repeat(64),
    sourceBytes: 15000,
    sourceLines: 200,
    sourceArtifactPath: '/tmp/session/objects/a.txt',
    model: 'gemini-3.8-flash-high',
    totalTokens: 520,
    validated: {
      status: 'failure',
      uncertain: false,
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
  assert.match(
    formatReceiptText({
      command: 'npm test',
      sourceHash: 'a'.repeat(64),
      sourceBytes: 15000,
      sourceLines: 200,
      sourceArtifactPath: '/tmp/session/objects/a.txt',
      model: 'gemini-3.8-flash-high',
      provider: 'cliproxy',
      validated: { status: 'success', uncertain: false, evidence: [] },
    }),
    /reducer_provider=cliproxy/,
  );
});

test('fullOutputPathFromNotice: recovers the path from every Pi truncation notice shape', () => {
  // Pi appends one of these to a large bash result (core/tools/bash.ts, core/messages.ts).
  assert.equal(
    fullOutputPathFromNotice('[Showing lines 1-2000 of 5000. Full output: /tmp/pi-bash-a1.log]'),
    '/tmp/pi-bash-a1.log',
  );
  assert.equal(
    fullOutputPathFromNotice('[Showing lines 1-2000 of 5000 (50KB limit). Full output: /tmp/pi-bash-b2.log]'),
    '/tmp/pi-bash-b2.log',
  );
  assert.equal(
    fullOutputPathFromNotice('[Showing last 50KB of line 12 (line is 80KB). Full output: /tmp/pi-bash-c3.log]'),
    '/tmp/pi-bash-c3.log',
  );
  assert.equal(
    fullOutputPathFromNotice('Command exited with code 1\n\n[Output truncated. Full output: /tmp/pi-bash-d4.log]'),
    '/tmp/pi-bash-d4.log',
  );
  // The notice is the only source consulted; anything else must yield nothing.
  assert.equal(fullOutputPathFromNotice('plain log without a truncation footer'), undefined);
  assert.equal(fullOutputPathFromNotice('[Showing lines 1-5 of 10]'), undefined);
  assert.equal(fullOutputPathFromNotice('Full output:   '), undefined);
  // A log that merely prints the phrase must not redirect the archive...
  assert.equal(fullOutputPathFromNotice('Full output: /tmp/pi-bash-decoy.log\nstill running'), undefined);
  // ...and when several bracketed notices appear, the trailing one (Pi's own) wins.
  assert.equal(
    fullOutputPathFromNotice(
      '[Showing lines 1-2 of 9. Full output: /tmp/pi-bash-early.log]\nmore log\n[Showing lines 1-2 of 90. Full output: /tmp/pi-bash-late.log]',
    ),
    '/tmp/pi-bash-late.log',
  );
});

test('mergeUsage: always returns a COMPLETE pi Usage (footer reads cost.total unguarded)', () => {
  // Regression guard: returning only { input, output, totalTokens } crashed pi with
  // "TypeError: Cannot read properties of undefined (reading 'total')" (2026-09-13, subagent pane).
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
    input: 105,
    output: 17,
    cacheRead: 3,
    cacheWrite: 2,
    totalTokens: 127,
    cost: { input: 0.1, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
  });
});
