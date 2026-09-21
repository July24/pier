/**
 * D102 reducer invoker, end to end: gate order (bash → trust → size → jev → archive), the receipt
 * swap, and every fail-open path. One fixture set drives both the acceptance tests and the gate-order
 * tests; "the archive exists" is how a passed gate is observed (archival is the gate's successor).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { handleReducerToolResult, type JevEprGateDependency, type ToolResultEventLike } from '../src/reducer-invoker.ts';
import { DEFAULT_EFFICIENCY_CONFIG, type EvidencePreservingReducerConfig } from '../src/efficiency-config-core.ts';
import { efficiencyLogPath, reducerObjectPath, resolveSessionRoot } from '../src/efficiency-store.ts';
import { REDUCER_RECEIPT_PREFIX, REDUCER_RECEIPT_SCHEMA, sha256Hex } from '../src/reducer-core.ts';

const CONFIG: EvidencePreservingReducerConfig = {
  ...DEFAULT_EFFICIENCY_CONFIG.evidencePreservingReducer,
  enabled: true,
  logEnabled: false,
  minBytes: 512,
  maxChars: 600_000,
};

/** 9000 bytes: clears minBytes, carries no credential shape, is not truncated. */
const BODY = 'out'.repeat(3000);

function bashEvent(command: string, text = BODY): ToolResultEventLike {
  return { toolName: 'bash', toolCallId: 't1', input: { command }, content: [{ type: 'text', text }], isError: false };
}

interface MockContext {
  ctx: ExtensionContext;
  completeCalls: Array<{ model: { id?: string }; context: { messages: Array<{ content: Array<{ text: string }> }> }; options: unknown }>;
  trustCalls: { count: number };
}

function createMockContext(opts: {
  sessionDir: string;
  sessionId: string;
  isTrusted?: boolean;
  completeResponse?: unknown;
  completeError?: Error;
}): MockContext {
  const completeCalls: MockContext['completeCalls'] = [];
  const trustCalls = { count: 0 };
  const ctx = {
    isProjectTrusted: () => {
      trustCalls.count++;
      return opts.isTrusted ?? true;
    },
    sessionManager: { getSessionDir: () => opts.sessionDir, getSessionId: () => opts.sessionId },
    model: { id: 'default-test-model', provider: 'test' },
    modelRegistry: {
      find: (provider: string, modelId: string) => ({ id: modelId, provider }),
      complete: async (model: never, context: never, options: never) => {
        completeCalls.push({ model, context, options });
        if (opts.completeError) throw opts.completeError;
        return opts.completeResponse ?? { content: [{ type: 'text', text: '{}' }] };
      },
    },
  } as unknown as ExtensionContext;
  return { ctx, completeCalls, trustCalls };
}

async function withSessionDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'pier-reducer-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The receipt for `body` when the model quotes `quote` verbatim. */
function receiptResponse(body: string, quote: string, extra: Record<string, unknown> = {}): unknown {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          schema: REDUCER_RECEIPT_SCHEMA,
          source_sha256: sha256Hex(body),
          status: 'failure',
          uncertain: false,
          evidence: [{ kind: 'failure', quote }],
        }),
      },
    ],
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    ...extra,
  };
}

async function archiveExists(sessionDir: string, body = BODY, sessionId = 's1'): Promise<boolean> {
  const root = resolveSessionRoot(sessionDir, sessionId);
  if (!root) return false;
  try {
    await access(reducerObjectPath(root, sha256Hex(body)));
    return true;
  } catch {
    return false;
  }
}

async function readRows(sessionDir: string, sessionId = 's1'): Promise<string[]> {
  const root = resolveSessionRoot(sessionDir, sessionId);
  assert.ok(root);
  return (await readFile(efficiencyLogPath(root, 'reducer'), 'utf8')).trim().split('\n');
}

/* ── the swap, and the fail-open paths ─────────────────────────────── */

test('EPR: replacement keeps every non-log block, backfills usage and archives the raw log', async () => {
  await withSessionDir(async (dir) => {
    // Large enough that the receipt wins the size comparison (the swap is refused otherwise).
    const rawLog = 'Running cargo test --all\ntest test_auth ... FAILED\nthread "test_auth" panicked at src/auth.rs:120:5:\nok case\n'.repeat(60);
    const { ctx, completeCalls } = createMockContext({
      sessionDir: dir,
      sessionId: 'sess_success',
      completeResponse: receiptResponse(rawLog, 'thread "test_auth" panicked at src/auth.rs:120:5:'),
    });
    const event: ToolResultEventLike = {
      ...bashEvent('cargo test --all', rawLog),
      content: [{ type: 'text', text: rawLog }, { type: 'text', text: '⚠️ write lock warning block' }],
      isError: true,
      usage: { totalTokens: 50 },
    };

    const res = await handleReducerToolResult(event, ctx, { ...CONFIG, logEnabled: true, model: 'test/reducer-model' }, { epoch: 2 });
    assert.ok(res);
    assert.equal(completeCalls.length, 1);
    assert.equal(completeCalls[0]!.model.id, 'reducer-model', 'the configured reducer model is used');
    assert.equal(res.content!.length, 2, 'block-level replacement');
    assert.ok(res.content![0]!.text.includes(REDUCER_RECEIPT_PREFIX));
    assert.match(res.content![0]!.text, /panicked at src\/auth\.rs:120:5/, 'verified evidence is quoted into the receipt');
    assert.equal(res.content![1]!.text, '⚠️ write lock warning block');
    assert.equal(res.usage?.totalTokens, 65, 'reducer usage is added to the tool result usage');

    const root = resolveSessionRoot(dir, 'sess_success');
    assert.ok(root);
    assert.equal(await readFile(reducerObjectPath(root, sha256Hex(rawLog)), 'utf8'), rawLog);

    const rows = await readRows(dir, 'sess_success');
    assert.equal(rows.length, 1);
    for (const field of ['"action":"applied"', '"verificationOk":true', '"epoch":2', '"sessionId":"sess_success"', '"grossSavedBytes":']) {
      assert.ok(rows[0]!.includes(field), field);
    }
  });
});

test('EPR: fails open on a model error or a quote that is not in the source, and writes no archive', async () => {
  await withSessionDir(async (dir) => {
    const rawLog = 'Running test suite...\nfailure at line 10\n'.repeat(50);

    const failing = createMockContext({ sessionDir: dir, sessionId: 'sess_err', completeError: new Error('Rate limit exceeded') });
    assert.equal(await handleReducerToolResult(bashEvent('npm test', rawLog), failing.ctx, CONFIG), undefined);

    const hallucinating = createMockContext({
      sessionDir: dir,
      sessionId: 'sess_err2',
      completeResponse: receiptResponse(rawLog, 'hallucinated line not in source'),
    });
    assert.equal(await handleReducerToolResult(bashEvent('npm test', rawLog), hallucinating.ctx, CONFIG), undefined);
  });
});

test('EPR: localOnly archives the log and never calls the model', async () => {
  await withSessionDir(async (dir) => {
    const rawLog = 'Diagnostic build log line...\n'.repeat(60);
    const { ctx, completeCalls } = createMockContext({ sessionDir: dir, sessionId: 'sess_local' });
    assert.equal(await handleReducerToolResult(bashEvent('make', rawLog), ctx, { ...CONFIG, localOnly: true }), undefined);
    assert.equal(completeCalls.length, 0);
    assert.equal(await archiveExists(dir, rawLog, 'sess_local'), true);
  });
});

test('EPR: a truncated result without a recoverable path is skipped and reported', async () => {
  await withSessionDir(async (dir) => {
    const truncatedLog = 'test pass line output in test suite execution...\n'.repeat(30);
    const { ctx, completeCalls } = createMockContext({ sessionDir: dir, sessionId: 'sess_trunc' });
    const event: ToolResultEventLike = { ...bashEvent('npm test', truncatedLog), details: { truncation: { truncated: true } } };
    assert.equal(await handleReducerToolResult(event, ctx, { ...CONFIG, logEnabled: true }), undefined);
    assert.equal(completeCalls.length, 0);

    const row = (await readRows(dir, 'sess_trunc'))[0]!;
    assert.ok(row.includes('"reason":"truncated-source"'));
    assert.ok(row.includes('"action":"fallback_full_text"'));
  });
});

test('EPR: recovers the exact log from the inline notice when details omit the path', async () => {
  const noticeLog = join(tmpdir(), `pi-bash-notice-${process.pid}-${Date.now()}.log`);
  await withSessionDir(async (dir) => {
    const evidence = 'E   assert 1 == 2  (notice-only evidence line)';
    const fullLog = 'Running pytest\ncollected 3 items\n'.repeat(60) + `${evidence}\n`;
    await writeFile(noticeLog, fullLog, 'utf8');
    const preview = `Running pytest\ncollected 3 items\n\n[Showing lines 1-6 of 121. Full output: ${noticeLog}]`;
    const { ctx, completeCalls } = createMockContext({
      sessionDir: dir,
      sessionId: 'sess_notice',
      completeResponse: receiptResponse(fullLog, evidence),
    });

    const event: ToolResultEventLike = {
      ...bashEvent('pytest', preview),
      details: { truncation: { truncated: true } },
      isError: true,
    };
    const res = await handleReducerToolResult(event, ctx, { ...CONFIG, logEnabled: true });
    assert.ok(res, 'the notice path must let the full log through instead of failing open');
    const receipt = res.content![0]!.text;
    assert.ok(receipt.includes(`source_bytes=${Buffer.byteLength(fullLog, 'utf8')}`), 'the receipt sizes the full log');
    assert.ok(receipt.includes(evidence), 'evidence comes from the archived full log');
    assert.ok(completeCalls[0]!.context.messages[0]!.content[0]!.text.includes(evidence), 'the model saw the full log');
    assert.ok((await readRows(dir, 'sess_notice'))[0]!.includes('"fullOutputSource":"notice"'));
  });
  await rm(noticeLog, { force: true });
});

test('EPR: credential-shaped output skips reduction and its telemetry masks the value', async () => {
  await withSessionDir(async (dir) => {
    const secretLog = 'Error in run: api_key = "sk-supersecretkey1234567890"\n' + 'stack trace...\n'.repeat(50);
    const { ctx, completeCalls } = createMockContext({ sessionDir: dir, sessionId: 'sess_secret' });
    assert.equal(await handleReducerToolResult(bashEvent('pytest', secretLog), ctx, { ...CONFIG, logEnabled: true }), undefined);
    assert.equal(completeCalls.length, 0);

    const rows = await readRows(dir, 'sess_secret');
    assert.ok(rows[0]!.includes('"reason":"likely-secret"'));
    assert.ok(!rows[0]!.includes('sk-supersecretkey1234567890'));
  });
});

/* ── gate order and jev flip semantics ─────────────────────────────── */

type GateOutcome = 'hit' | 'reject-kind' | 'low-confidence' | 'fail';

function makeGate(outcome: GateOutcome): { dep: JevEprGateDependency; asks: string[]; extras: Array<Record<string, unknown>> } {
  const asks: string[] = [];
  const extras: Array<Record<string, unknown>> = [];
  return {
    asks,
    extras,
    dep: {
      ask: async (_request, meta) => {
        asks.push(meta.questionId);
        extras.push((meta.extra ?? {}) as Record<string, unknown>);
        if (outcome === 'fail') return { ok: false, reason: 'timeout', latencyMs: 1 };
        const choice = outcome === 'reject-kind' ? 'install_deps' : 'build_test_run';
        return {
          ok: true,
          model: 'jev-1.13.0',
          usage: { inputTokens: 10, outputTokens: 2 },
          latencyMs: 1,
          answers: {
            cmd_kind: { type: 'choice', choice, probabilities: { [choice]: 1 }, confidence: outcome === 'low-confidence' ? 0.3 : 0.95 },
            diagnostic_output: { type: 'noul', noul: 0.95 },
          },
        };
      },
      getMinConfidence: () => 0.6,
    },
  };
}

test('gate: the trust boundary precedes everything — an untrusted project sends nothing and archives nothing', async () => {
  await withSessionDir(async (dir) => {
    const { ctx, trustCalls } = createMockContext({ sessionDir: dir, sessionId: 's1', isTrusted: false });
    const { dep, asks } = makeGate('hit');
    assert.equal(await handleReducerToolResult(bashEvent('cargo test'), ctx, CONFIG, { jev: dep }), undefined);
    assert.equal(asks.length, 0, 'an untrusted project must not reach a third-party API');
    assert.equal(trustCalls.count, 1);
    assert.equal(await archiveExists(dir), false);
  });
});

test('gate: non-bash tools and outputs below minBytes never reach the trust check or the jev call', async () => {
  await withSessionDir(async (dir) => {
    const { ctx, trustCalls } = createMockContext({ sessionDir: dir, sessionId: 's1' });
    const { dep, asks } = makeGate('hit');
    const read = { ...bashEvent('cargo test'), toolName: 'read' };
    assert.equal(await handleReducerToolResult(read, ctx, CONFIG, { jev: dep }), undefined);
    assert.equal(trustCalls.count, 0);

    assert.equal(await handleReducerToolResult(bashEvent('cargo test', 'out'.repeat(100)), ctx, CONFIG, { jev: dep }), undefined);
    assert.equal(asks.length, 0, 'the size gate must short-circuit before the jev call');
  });
});

test('gate: jev decides first, and its confident rejection outranks a regex hit', async () => {
  await withSessionDir(async (dir) => {
    const ctx = createMockContext({ sessionDir: dir, sessionId: 's1' }).ctx;

    // Off-list command + jev hit: gated (the flip's core win); the archive is what proves it passed.
    const viaJev = makeGate('hit');
    assert.equal(await handleReducerToolResult(bashEvent('deno test --allow-read', BODY), ctx, CONFIG, { jev: viaJev.dep }), undefined);
    assert.deepEqual(viaJev.asks, ['epr-diagnostic-gate']);
    assert.equal(await archiveExists(dir, BODY), true);

    // Regex hit + confident rejection: authoritative, so this body is never archived.
    const rejected = makeGate('reject-kind');
    const rejectedBody = `${BODY}rejected`;
    assert.equal(await handleReducerToolResult(bashEvent('cargo test', rejectedBody), ctx, CONFIG, { jev: rejected.dep }), undefined);
    assert.deepEqual(rejected.asks, ['epr-diagnostic-gate'], 'regex hits are no longer a short-circuit');
    assert.equal(await archiveExists(dir, rejectedBody), false);
  });
});

test('gate: an unanswered jev call falls back to the regex list, in both directions', async () => {
  await withSessionDir(async (dir) => {
    const ctx = createMockContext({ sessionDir: dir, sessionId: 's1' }).ctx;

    // Low confidence on a listed command -> the regex list decides: match, so it is gated.
    const low = makeGate('low-confidence');
    const lowBody = `${BODY}low`;
    assert.equal(await handleReducerToolResult(bashEvent('cargo test', lowBody), ctx, CONFIG, { jev: low.dep }), undefined);
    assert.equal(await archiveExists(dir, lowBody), true);

    // Call failure on an off-list command -> the regex list decides: no match, so nothing happens.
    const failed = makeGate('fail');
    const failedBody = `${BODY}failed`;
    assert.equal(await handleReducerToolResult(bashEvent('mix test', failedBody), ctx, CONFIG, { jev: failed.dep }), undefined);
    assert.deepEqual(failed.asks, ['epr-diagnostic-gate']);
    assert.equal(await archiveExists(dir, failedBody), false);

    // No jev dependency at all -> the legacy regex-only path.
    const legacyBody = `${BODY}legacy`;
    assert.equal(await handleReducerToolResult(bashEvent('cargo test', legacyBody), ctx, CONFIG, {}), undefined);
    assert.equal(await archiveExists(dir, legacyBody), true);
    assert.equal(await handleReducerToolResult(bashEvent('deno test --allow-read', `${BODY}offlist`), ctx, CONFIG, {}), undefined);
  });
});

test('gate: telemetry records regex_hit so the direction of jev overrides stays observable', async () => {
  await withSessionDir(async (dir) => {
    const reject = makeGate('reject-kind');
    await handleReducerToolResult(bashEvent('cargo test'), createMockContext({ sessionDir: dir, sessionId: 's1' }).ctx, CONFIG, { jev: reject.dep });
    assert.equal(reject.extras[0]!.regexHit, true);

    const hit = makeGate('hit');
    await handleReducerToolResult(bashEvent('deno test --allow-read'), createMockContext({ sessionDir: dir, sessionId: 's1' }).ctx, CONFIG, { jev: hit.dep });
    assert.equal(hit.extras[0]!.regexHit, false);
  });
});

test('gate: credential-shaped command lines stay local and the regex list decides alone', async () => {
  await withSessionDir(async (dir) => {
    const ctx = createMockContext({ sessionDir: dir, sessionId: 's1' }).ctx;

    const miss = makeGate('hit');
    await handleReducerToolResult(bashEvent('curl -H "Authorization: Bearer sk-abcdefghijklmnop12" https://x'), ctx, CONFIG, { jev: miss.dep });
    assert.equal(miss.asks.length, 0, 'credential-shaped commands must not be sent to jev');
    assert.equal(await archiveExists(dir), false);

    const hit = makeGate('reject-kind');
    await handleReducerToolResult(bashEvent('pytest --api-key=sk-abcdefghijklmnop12'), ctx, CONFIG, { jev: hit.dep });
    assert.equal(hit.asks.length, 0, 'no jev call even though the regex list matches');
    assert.equal(await archiveExists(dir), true, 'the regex list alone decides');
  });
});

test('gate: fail-open evidence rows exist only for commands that reached the reduction path', async () => {
  await withSessionDir(async (dir) => {
    const logging = { ...CONFIG, logEnabled: true };
    const truncated = (command: string): ToolResultEventLike => ({
      ...bashEvent(command),
      details: { truncation: { truncated: true } },
    });
    const ctx = createMockContext({ sessionDir: dir, sessionId: 's1' }).ctx;

    // Rejected by the gate (off-list, no jev): the output is never parsed and no row is written.
    await handleReducerToolResult(truncated('deno test --allow-read'), ctx, logging, {});
    await assert.rejects(() => readRows(dir), 'gate-rejected commands must not produce evidence rows');

    // Off-list but jev-approved: the row must exist (the flip's core benefit).
    const jevHit = makeGate('hit');
    await handleReducerToolResult(truncated('deno test --allow-read'), ctx, logging, { jev: jevHit.dep });
    assert.deepEqual(jevHit.asks, ['epr-diagnostic-gate']);
    assert.equal((await readRows(dir)).length, 1);
    assert.ok((await readRows(dir))[0]!.includes('"reason":"truncated-source"'));

    // Listed command without jev: same fail-open row.
    await handleReducerToolResult(truncated('cargo test'), ctx, logging, {});
    assert.equal((await readRows(dir)).length, 2);

    // Credential-shaped output: the diagnostic gate is asked BEFORE the secret scan.
    const secretBody = `${BODY}\napi_key=sk-abcdefghij123456`;
    const gate = makeGate('hit');
    await handleReducerToolResult(bashEvent('cargo test', secretBody), ctx, logging, { jev: gate.dep });
    assert.deepEqual(gate.asks, ['epr-diagnostic-gate']);
    const rows = await readRows(dir);
    assert.equal(rows.length, 3);
    assert.ok(rows[2]!.includes('"reason":"likely-secret"'));

    // A gate-rejected command never reaches the secret scan.
    const rejected = makeGate('reject-kind');
    await handleReducerToolResult(bashEvent('deno test --allow-read', secretBody), ctx, logging, { jev: rejected.dep });
    assert.equal((await readRows(dir)).length, 3, 'gate-rejected commands never reach the secret scan');
  });
});
