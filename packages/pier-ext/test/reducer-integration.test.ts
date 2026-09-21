/** D102 reducer invoker end to end: gate order (bash → trust → size → jev → archive), the receipt
 * swap and every fail-open path. Archival existing is how a passed gate is observed. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { handleReducerToolResult, type JevEprGateDependency, type ToolResultEventLike } from '../src/reducer-invoker.ts';
import { DEFAULT_EFFICIENCY_CONFIG, type EvidencePreservingReducerConfig } from '../src/efficiency-config-core.ts';
import { efficiencyLogPath, reducerObjectPath, resolveSessionRoot } from '../src/efficiency-store.ts';
import { REDUCER_RECEIPT_PREFIX, REDUCER_RECEIPT_SCHEMA, sha256Hex } from '../src/reducer-core.ts';
import { withCleanup } from './test-utils.ts';
const CONFIG: EvidencePreservingReducerConfig =
  { ...DEFAULT_EFFICIENCY_CONFIG.evidencePreservingReducer, enabled: true, logEnabled: false, minBytes: 512, maxChars: 600_000 };

/** 9000 bytes: clears minBytes, carries no credential shape, is not truncated. */
const BODY = 'out'.repeat(3000);

function bashEvent(command: string, text: string = BODY): ToolResultEventLike {
  return { toolName: 'bash', toolCallId: 't1', input: { command }, content: [{ type: 'text', text }], isError: false };
}

/** A model completion as the reducer prompt reaches it. */
type Completions = Array<{ model: { id?: string }; context: { messages: Array<{ content: Array<{ text: string }> }> } }>;

/** One factory for every test below; only the fields a test cares about are overridden. */
function mockContext(opts: { sessionDir: string; sessionId?: string; isTrusted?: boolean; completeResponse?: unknown; completeError?: Error }): {
  ctx: ExtensionContext; completeCalls: Completions; trustCalls: { count: number };
} {
  const completeCalls: Completions = [];
  const trustCalls = { count: 0 };
  const ctx = {
    isProjectTrusted: () => { trustCalls.count++; return opts.isTrusted ?? true; },
    sessionManager: { getSessionDir: () => opts.sessionDir, getSessionId: () => opts.sessionId ?? 's1' }, model: { id: 'default-test-model', provider: 'test' },
    modelRegistry: {
      find: (provider: string, modelId: string) => ({ id: modelId, provider }),
      complete: async (model: never, context: never) => {
        completeCalls.push({ model, context }); if (opts.completeError) throw opts.completeError;
        return opts.completeResponse ?? { content: [{ type: 'text', text: '{}' }] };
      },
    },
  } as unknown as ExtensionContext;
  return { ctx, completeCalls, trustCalls };
}

/** The receipt for `body` when the model quotes `quote` verbatim. */
function receiptResponse(body: string, quote: string): unknown {
  const receipt = {
    schema: REDUCER_RECEIPT_SCHEMA, source_sha256: sha256Hex(body), status: 'failure', uncertain: false,
    evidence: [{ kind: 'failure', quote }],
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(receipt) }],
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

async function archiveExists(sessionDir: string, body: string, sessionId = 's1'): Promise<boolean> {
  const root = resolveSessionRoot(sessionDir, sessionId);
  if (!root) return false;
  try { await access(reducerObjectPath(root, sha256Hex(body))); return true; } catch { return false; }
}

async function readRows(sessionDir: string, sessionId = 's1'): Promise<string[]> {
  const root = resolveSessionRoot(sessionDir, sessionId);
  assert.ok(root);
  return (await readFile(efficiencyLogPath(root, 'reducer'), 'utf8')).trim().split('\n');
}

test('EPR: replacement keeps every non-log block, backfills usage and archives the raw log', withCleanup(async (cleanup) => {
  const dir = cleanup.tempDir('reducer').path;
  // Large enough that the receipt wins the size comparison (the swap is refused otherwise).
  const rawLog = 'Running cargo test --all\ntest test_auth ... FAILED\nthread "test_auth" panicked at src/auth.rs:120:5:\nok case\n'.repeat(60);
  const { ctx, completeCalls } = mockContext({
    sessionDir: dir, sessionId: 'sess_success', completeResponse: receiptResponse(rawLog, 'thread "test_auth" panicked at src/auth.rs:120:5:'),
  });
  const event: ToolResultEventLike = {
    ...bashEvent('cargo test --all', rawLog), isError: true, usage: { totalTokens: 50 },
    content: [{ type: 'text', text: rawLog }, { type: 'text', text: '⚠️ write lock warning block' }],
  };
  const res = await handleReducerToolResult(event, ctx, { ...CONFIG, logEnabled: true, model: 'test/reducer-model' }, { epoch: 2 });
  assert.ok(res); assert.equal(completeCalls.length, 1);
  assert.equal(completeCalls[0]!.model.id, 'reducer-model', 'the configured reducer model is used');
  assert.equal(res.content!.length, 2, 'block-level replacement'); assert.ok(res.content![0]!.text.includes(REDUCER_RECEIPT_PREFIX));
  assert.match(res.content![0]!.text, /panicked at src\/auth\.rs:120:5/, 'verified evidence is quoted into the receipt');
  assert.equal(res.content![1]!.text, '⚠️ write lock warning block');
  assert.equal(res.usage?.totalTokens, 65, 'reducer usage is added to the tool result usage');
  const root = resolveSessionRoot(dir, 'sess_success');
  assert.ok(root); assert.equal(await readFile(reducerObjectPath(root, sha256Hex(rawLog)), 'utf8'), rawLog);
  const rows = await readRows(dir, 'sess_success');
  assert.equal(rows.length, 1);
  for (const field of ['"action":"applied"', '"verificationOk":true', '"epoch":2', '"sessionId":"sess_success"', '"grossSavedBytes":']) assert.ok(rows[0]!.includes(field), field);
}));

test('EPR: fails open on a model error or an unverifiable quote', withCleanup(async (cleanup) => {
  const dir = cleanup.tempDir('reducer').path;
  const rawLog = 'Running test suite...\nfailure at line 10\n'.repeat(50);
  const failing = mockContext({ sessionDir: dir, sessionId: 'sess_err', completeError: new Error('Rate limit exceeded') });
  assert.equal(await handleReducerToolResult(bashEvent('npm test', rawLog), failing.ctx, CONFIG), undefined);
  // Archival precedes the model call, so a failed reduction still leaves the evidence on disk.
  assert.equal(await archiveExists(dir, rawLog, 'sess_err'), true);
  const hallucinating = mockContext({ sessionDir: dir, sessionId: 'sess_err2', completeResponse: receiptResponse(rawLog, 'hallucinated line not in source') });
  assert.equal(await handleReducerToolResult(bashEvent('npm test', rawLog), hallucinating.ctx, CONFIG), undefined);
}));

test('EPR: localOnly archives the log and never calls the model', withCleanup(async (cleanup) => {
  const dir = cleanup.tempDir('reducer').path;
  const rawLog = 'Diagnostic build log line...\n'.repeat(60);
  const { ctx, completeCalls } = mockContext({ sessionDir: dir, sessionId: 'sess_local' });
  assert.equal(await handleReducerToolResult(bashEvent('make', rawLog), ctx, { ...CONFIG, localOnly: true }), undefined);
  assert.equal(completeCalls.length, 0); assert.equal(await archiveExists(dir, rawLog, 'sess_local'), true);
}));

test('EPR: evidence rows exist only for commands that reached the reduction path', withCleanup(async (cleanup) => {
  const dir = cleanup.tempDir('reducer').path;
  const logging = { ...CONFIG, logEnabled: true };
  const truncated = (command: string): ToolResultEventLike => ({ ...bashEvent(command), details: { truncation: { truncated: true } } });
  const { ctx, completeCalls } = mockContext({ sessionDir: dir });
  // Rejected by the gate (off-list, no jev): the output is never parsed and no row is written.
  assert.equal(await handleReducerToolResult(truncated('deno test --allow-read'), ctx, logging, {}), undefined);
  await assert.rejects(() => readRows(dir), 'gate-rejected commands must not produce evidence rows');
  // Off-list but jev-approved: the row must exist (the flip's core benefit); a truncated result with
  // no recoverable full log is skipped without paying for the model call.
  const jevHit = makeGate('hit');
  assert.equal(await handleReducerToolResult(truncated('deno test --allow-read'), ctx, logging, { jev: jevHit.dep }), undefined);
  assert.deepEqual(jevHit.asks, ['epr-diagnostic-gate']);
  assert.equal(completeCalls.length, 0);
  const row = (await readRows(dir))[0]!;
  assert.ok(row.includes('"reason":"truncated-source"')); assert.ok(row.includes('"action":"fallback_full_text"'));
  // A listed command without jev writes the same fail-open row.
  assert.equal(await handleReducerToolResult(truncated('cargo test'), ctx, logging, {}), undefined);
  assert.equal((await readRows(dir)).length, 2);
  // Credential-shaped output: the diagnostic gate is asked BEFORE the secret scan, and the row records
  // the shape without the value.
  const secretBody = `${BODY}\napi_key = "sk-supersecretkey1234567890"`;
  const secretGate = makeGate('hit');
  assert.equal(await handleReducerToolResult(bashEvent('cargo test', secretBody), ctx, logging, { jev: secretGate.dep }), undefined);
  assert.deepEqual(secretGate.asks, ['epr-diagnostic-gate']);
  assert.equal(completeCalls.length, 0);
  const rows = await readRows(dir);
  assert.equal(rows.length, 3); assert.ok(rows[2]!.includes('"reason":"likely-secret"')); assert.ok(!rows[2]!.includes('sk-supersecretkey1234567890'));
  // A gate-rejected command never reaches the secret scan.
  const rejected = makeGate('reject-kind');
  assert.equal(await handleReducerToolResult(bashEvent('deno test --allow-read', secretBody), ctx, logging, { jev: rejected.dep }), undefined);
  assert.equal((await readRows(dir)).length, 3, 'gate-rejected commands never reach the secret scan');
}));

test('EPR: recovers the exact log from the inline notice when details omit the path', withCleanup(async (cleanup) => {
  const noticeLog = join(cleanup.tempDir('reducer-notice').path, 'pi-bash-notice.log');
  const dir = cleanup.tempDir('reducer').path;
  const evidence = 'E   assert 1 == 2  (notice-only evidence line)';
  const fullLog = 'Running pytest\ncollected 3 items\n'.repeat(60) + `${evidence}\n`;
  await writeFile(noticeLog, fullLog, 'utf8');
  const preview = `Running pytest\ncollected 3 items\n\n[Showing lines 1-6 of 121. Full output: ${noticeLog}]`;
  const { ctx, completeCalls } = mockContext({ sessionDir: dir, sessionId: 'sess_notice', completeResponse: receiptResponse(fullLog, evidence) });
  const event: ToolResultEventLike = { ...bashEvent('pytest', preview), details: { truncation: { truncated: true } }, isError: true };
  const res = await handleReducerToolResult(event, ctx, { ...CONFIG, logEnabled: true });
  assert.ok(res, 'the notice path must let the full log through instead of failing open');
  const receipt = res.content![0]!.text;
  assert.ok(receipt.includes(`source_bytes=${Buffer.byteLength(fullLog, 'utf8')}`), 'the receipt sizes the full log');
  assert.ok(receipt.includes(evidence), 'evidence comes from the archived full log');
  assert.ok(completeCalls[0]!.context.messages[0]!.content[0]!.text.includes(evidence), 'the model saw the full log');
  assert.ok((await readRows(dir, 'sess_notice'))[0]!.includes('"fullOutputSource":"notice"'));
}));

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
          ok: true, model: 'jev-1.13.0', usage: { inputTokens: 10, outputTokens: 2 }, latencyMs: 1,
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

test('gate: the trust boundary precedes everything, and tool/size gates precede the trust check', withCleanup(async (cleanup) => {
  const dir = cleanup.tempDir('reducer').path;
  const { ctx, trustCalls } = mockContext({ sessionDir: dir, isTrusted: false });
  const { dep, asks } = makeGate('hit');
  assert.equal(await handleReducerToolResult(bashEvent('cargo test'), ctx, CONFIG, { jev: dep }), undefined);
  assert.equal(asks.length, 0, 'an untrusted project must not reach a third-party API'); assert.equal(trustCalls.count, 1);
  assert.equal(await archiveExists(dir, BODY), false);
  const read = { ...bashEvent('cargo test'), toolName: 'read' };
  assert.equal(await handleReducerToolResult(read, ctx, CONFIG, { jev: dep }), undefined);
  assert.equal(trustCalls.count, 1, 'non-bash results never reach the trust check');
  assert.equal(await handleReducerToolResult(bashEvent('cargo test', 'out'.repeat(100)), ctx, CONFIG, { jev: dep }), undefined);
  assert.equal(asks.length, 0, 'the size gate must short-circuit before the jev call');
}));

/** [case, command, gate (undefined = no jev dependency), gate is asked, reaches the reduction path] */
const GATE_CASES: Array<{ name: string; command: string; gate?: GateOutcome; ask: boolean; gated: boolean; regexHit?: boolean }> = [
  { name: 'an off-list command approved by jev is gated', command: 'deno test --allow-read', gate: 'hit', ask: true, gated: true, regexHit: false },
  { name: 'a listed command approved by jev is gated', command: 'cargo test', gate: 'hit', ask: true, gated: true, regexHit: true },
  // A confident rejection is authoritative even for a regex-listed command.
  { name: 'a confident rejection outranks a regex hit', command: 'cargo test', gate: 'reject-kind', ask: true, gated: false, regexHit: true },
  { name: 'low confidence falls back to the regex hit', command: 'cargo test', gate: 'low-confidence', ask: true, gated: true, regexHit: true },
  { name: 'low confidence on an off-list command falls back to the regex miss', command: 'deno test --allow-read', gate: 'low-confidence', ask: true, gated: false, regexHit: false },
  { name: 'a failed gate call falls back to the regex miss', command: 'mix test', gate: 'fail', ask: true, gated: false, regexHit: false },
  { name: 'a failed gate call falls back to the regex hit', command: 'cargo test', gate: 'fail', ask: true, gated: true, regexHit: true },
  { name: 'without a gate the regex list decides alone (hit)', command: 'cargo test', ask: false, gated: true },
  { name: 'without a gate the regex list decides alone (miss)', command: 'deno test --allow-read', ask: false, gated: false },
  // Credential-shaped command lines stay local: no third-party call, the regex list alone decides.
  { name: 'a credential-shaped command stays local (regex miss)', command: 'curl -H "Authorization: Bearer sk-abcdefghijklmnop12" https://x', gate: 'hit', ask: false, gated: false },
  { name: 'a credential-shaped command stays local (regex hit)', command: 'pytest --api-key=sk-abcdefghijklmnop12', gate: 'reject-kind', ask: false, gated: true },
];

test('gate: the jev outcome matrix decides reduction, with the regex list as the fallback', async (t) => {
  for (const c of GATE_CASES) {
    await t.test(c.name, withCleanup(async (cleanup) => {
      const dir = cleanup.tempDir('reducer').path;
      const body = `${BODY}${c.name}`;
      const { ctx } = mockContext({ sessionDir: dir });
      const gate = c.gate ? makeGate(c.gate) : undefined;
      assert.equal(await handleReducerToolResult(bashEvent(c.command, body), ctx, CONFIG, gate ? { jev: gate.dep } : {}), undefined);
      assert.equal(gate?.asks.length ?? 0, c.ask ? 1 : 0, 'third-party calls');
      if (gate && c.ask) {
        assert.deepEqual(gate.asks, ['epr-diagnostic-gate']);
        assert.equal(gate.extras[0]!.regexHit, c.regexHit, 'the override direction stays observable in telemetry');
      }
      assert.equal(await archiveExists(dir, body), c.gated, 'archival is how a passed gate is observed');
    }));
  }
});
