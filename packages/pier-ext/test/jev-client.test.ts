/**
 * jev direct HTTP client (RFC docs/rfc-jev-integration.md §5/§6): fake fetch + a temp session root.
 * Every failure surface (disabled/no-key/429/timeout/network/bad JSON) fails open, and telemetry
 * keeps metadata only — never a request body.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createJevRuntime } from '../src/jev-client.ts';
import type { JevConfig } from '../src/efficiency-config-core.ts';
import type { JevQuestion } from '../src/jev-core.ts';
import { withCleanup } from './test-utils.ts';
const QUESTIONS: Record<string, JevQuestion> = { kind: { type: 'noul', instructions: 'Is this a test?' } };

function config(overrides: Partial<JevConfig> = {}): JevConfig {
  return { enabled: true, logEnabled: true, model: 'jev-1.13.0', timeoutMs: 500, minConfidence: 0.6, apiKey: 'sk-test', ...overrides };
}

const okBody = () => ({
  model: 'jev-1.13.0',
  answers: { kind: { type: 'noul', noul: 0.9 } },
  usage: { input_tokens: 42, output_tokens: 3 },
});

const readLog = (root: string): Promise<string> => readFile(join(root, 'efficiency-logs', 'jev.jsonl'), 'utf8');

test('disabled / no-api-key: no request is sent, and both fail open with a reason', withCleanup(async (cleanup) => {
  const root = cleanup.tempDir('jev').path;
  let fetchCalls = 0;
  const runtime = createJevRuntime(() => config({ enabled: false }), {
    fetchImpl: () => { fetchCalls++; return Promise.resolve(new Response('{}')); },
    getSessionRoot: () => root,
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
    fetchImpl: async () => new Response('{"oops"', { status: 200 }),
    getSessionRoot: () => root,
  });
  const failed = await runtime.ask({ state: 's', questions: QUESTIONS }, {
    questionId: 'q',
    enrich: ({ ok, answers }) => {
      outcomes.push(`${ok}:${answers === null}`);
      return { verdict: 'unparsed' };
    },
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
