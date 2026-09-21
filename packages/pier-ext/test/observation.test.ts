/** ObservationPack: the pure helpers (id / excerpt / paging / economics) plus the plugin surface —
 * `obs_recall`, the `context` projection, batch packing and the `onBeforeCompact` hook. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  batchPackObservations, clearObservationMemoForTest, createCompactionBatchPackHook, RECALL_TOOL_NAME, registerObservationPack,
} from '../src/plugins/observation.ts';
import { DEFAULT_EFFICIENCY_CONFIG, type EfficiencyConfig } from '../src/efficiency-config-core.ts';
import {
  completeLineExcerpt, deriveObservationId, isObservationId,
  REDUCER_RECEIPT_PREFIX, shouldPackForCache, sliceBufferChunk,
} from '../src/observation-core.ts';
import type { RuntimeRoleManifest } from '../src/tool-gate.ts';
import { fakePi, withCleanup } from './test-utils.ts';

/* ── pure helpers (observation-core) ───────────────────────────────── */

test('deriveObservationId: deterministic 24-hex ID and handles collisions', () => {
  const hash = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
  const id1 = deriveObservationId('bash', 'call_1', hash);
  const id2 = deriveObservationId('bash', 'call_1', hash);
  const id3 = deriveObservationId('bash', 'call_2', hash);

  assert.equal(id1, id2); assert.notEqual(id1, id3); // different tool call IDs must not collide
  assert.equal(isObservationId(id1), true); assert.equal(isObservationId(id3), true); assert.equal(isObservationId('invalid_id'), false);
});

test('completeLineExcerpt: maintains whole line boundaries', () => {
  const text = 'line 1\nline 2\nline 3\nline 4\n';
  // 'line 1\n' + 'line 2\n' = 14 bytes; the third line would overflow a 15-byte head budget.
  assert.equal(completeLineExcerpt(text, 15, false), 'line 1\nline 2\n');
  assert.equal(completeLineExcerpt(text, 15, true), 'line 3\nline 4\n');
});

test('sliceBufferChunk: pages by line limit and reports eof', () => {
  const buf = Buffer.from('Row 1\nRow 2\nRow 3\nRow 4\nRow 5\n', 'utf8');
  const chunk1 = sliceBufferChunk(buf, 0, { maxBytes: 1024, maxLines: 2 });
  assert.deepEqual([chunk1.text, chunk1.lines, chunk1.eof], ['Row 1\nRow 2\n', 2, false]);
  const chunk2 = sliceBufferChunk(buf, chunk1.nextOffset, { maxBytes: 1024, maxLines: 2 });
  assert.deepEqual([chunk2.text, chunk2.lines, chunk2.eof], ['Row 3\nRow 4\n', 2, false]);
  const chunk3 = sliceBufferChunk(buf, chunk2.nextOffset, { maxBytes: 1024, maxLines: 2 });
  assert.deepEqual([chunk3.text, chunk3.lines, chunk3.eof], ['Row 5\n', 1, true]);
  assert.deepEqual(sliceBufferChunk(buf, buf.length, { maxBytes: 1024, maxLines: 2 }), { text: '', bytes: 0, lines: 0, nextOffset: buf.length, eof: true });
});

test('sliceBufferChunk: never splits a multi-byte character at the byte limit', () => {
  // '中' is 3 bytes (E4 B8 AD); a 4-byte budget would cut the second one in half.
  const chunk = sliceBufferChunk(Buffer.from('中中', 'utf8'), 0, { maxBytes: 4, maxLines: 10 });
  assert.deepEqual([chunk.text, chunk.bytes, chunk.eof], ['中', 3, false]);
});

test('shouldPackForCache: balances read savings against prefix rewrite cost', () => {
  const cases = [
    // 5000 removed × 10 requests = 50000 saved vs a 2000-token prefix rewritten at ratio 12.5 → 23000
    { name: 'many requests beat a small rewrite', input: { removedTokens: 5000, tailTokensAfter: 2000, expectedRemainingRequests: 10, cacheWriteReadRatio: 12.5 }, expected: true },
    // 500 removed on the last request = 500 saved vs a 10000-token prefix → 115000
    { name: 'one request cannot pay for a huge rewrite', input: { removedTokens: 500, tailTokensAfter: 10000, expectedRemainingRequests: 1, cacheWriteReadRatio: 12.5 }, expected: false },
    { name: 'free cache writes need no savings', input: { removedTokens: 100, tailTokensAfter: 50000, expectedRemainingRequests: 1, cacheWriteReadRatio: 1.0 }, expected: true },
  ];
  for (const c of cases) assert.equal(shouldPackForCache(c.input), c.expected, c.name);
});

/* ── plugin surface (observation.ts) ───────────────────────────────── */

const obsConfig = (over: Record<string, unknown> = {}) => ({ ...DEFAULT_EFFICIENCY_CONFIG.observationPack, enabled: true, thresholdBytes: 500, fullSends: 1, ...over });
const effConfig = (over: Record<string, unknown> = {}): EfficiencyConfig => ({ ...DEFAULT_EFFICIENCY_CONFIG, observationPack: obsConfig(over) });
const ctxFor = (sessionDir: string, sessionId: string) => ({ sessionManager: { getSessionDir: () => sessionDir, getSessionId: () => sessionId } } as unknown as ExtensionContext);
const toolResult = (text: string, id = 'tc_1', toolName = 'bash') => ({ role: 'toolResult', toolName, toolCallId: id, content: [{ type: 'text', text }] });
const assistant = () => ({ role: 'assistant', content: [{ type: 'text', text: 'analyzing...' }] });
/** One log line repeated past the test's byte threshold (~2KB). */
const longLog = (marker = 'INFO: step processing') => `${marker}\n`.repeat(100);
const restrictedRole: RuntimeRoleManifest = { role: 'restricted-agent', version: '1.0.0', tools: ['bash', 'read'], permissions: { '*': 'allow' }, unknownTools: 'deny' };

/** Fresh temp session root plus a memo reset — the memo is module-global and keyed by session root. */
async function inSession(fn: (sessionDir: string) => Promise<void>): Promise<void> {
  await withCleanup(async (cleanup) => {
    clearObservationMemoForTest();
    try { await fn(cleanup.tempDir('pier-obs').path); } finally { clearObservationMemoForTest(); }
  })();
}

type ProjectedEvent = { messages: Array<{ content: Array<{ text: string }> }> };
type RecallResult = { content: Array<{ text: string }>; details: Record<string, unknown> };
interface MountDeps {
  getConfig?: () => EfficiencyConfig;
  getRuntimeManifest?: () => RuntimeRoleManifest | null;
  getRemainingHorizon?: () => number;
  pickMiddleExcerpt?: (text: string, budgetBytes: number) => Promise<{ text: string; label: string } | null>;
}

/** Registers the plugin on a fake pi and exposes its two seams: the `context` projection and `obs_recall`. */
function mountObservation(over: MountDeps = {}) {
  const pi = fakePi();
  registerObservationPack({ getConfig: () => effConfig(), ...over, pi } as unknown as Parameters<typeof registerObservationPack>[0]);
  const project = async (messages: unknown[], ctx: ExtensionContext): Promise<ProjectedEvent> =>
    (await pi.listeners.get('context')![0]!({ messages }, ctx)) as ProjectedEvent;
  const recall = async (params: Record<string, unknown>, ctx: ExtensionContext): Promise<RecallResult> =>
    (await pi.tools.get(RECALL_TOOL_NAME)!.execute!('call', params, undefined, undefined, ctx)) as RecallResult;
  return { pi, project, recall };
}

test('ObservationPack: 注册 obs_recall；活跃窗口内原样，超窗后投影占位符并可分页召回', async () => {
  await inSession(async (sessionDir) => {
    let horizonCalls = 0;
    const { pi, project, recall } = mountObservation({ getRemainingHorizon: () => { horizonCalls += 1; return 5; } });
    assert.equal(pi.tools.has(RECALL_TOOL_NAME), true);
    const ctx = ctxFor(sessionDir, 'session_test_01');

    // A1: an illegal id is a hard failure (throws so pi flags isError), not a normal result
    await assert.rejects(async () => { await recall({ id: 'bad_id' }, ctx); }, /invalid observation id format/);

    const log = longLog();

    // 1st projection: sendCount=0 < fullSends=1 → full text; 2nd (one assistant turn later) → placeholder
    const first = await project([toolResult(log)], ctx);
    assert.equal(first.messages[0].content[0].text, log);
    const event = [toolResult(log), assistant()];
    const second = await project(event, ctx);
    const replaced = second.messages[0].content[0].text;
    assert.notEqual(replaced, log);
    assert.match(replaced, /\[large tool result replaced after its first 1 provider requests\]/);
    const obsId = replaced.match(/id:\s+(obs_[a-f0-9]{24})/)![1]!;

    // Memo fast path: the same message projects the same placeholder without re-asking the horizon
    const third = await project(event, ctx);
    assert.equal(third.messages[0].content[0].text, replaced, 'memo 命中：占位符稳定'); assert.equal(horizonCalls, 1, 'memo 命中即短路，不该再问 horizon');

    const recalled = await recall({ id: obsId, offset: 0 }, ctx);
    assert.ok(recalled.content[0].text.includes('[obs_recall id=')); assert.ok(recalled.content[0].text.includes('INFO: step processing'), '召回原文');
    assert.equal(recalled.details.id, obsId); assert.equal(recalled.details.offset, 0);

    // Storage gone → an error result instead of a throw, so the model can see the handle went stale
    const missing = await recall({ id: 'obs_000000000000000000000000' }, ctx);
    assert.ok(missing.content[0].text.includes('Error: failed to recall observation'), '缺文件自愈路径');
  });
});

test('ObservationPack: 角色被拒 obs_recall 时完全不投影（模型不该拿到不可用的句柄）', async () => {
  await inSession(async (sessionDir) => {
    const { project } = mountObservation({ getRuntimeManifest: () => restrictedRole });
    const res = await project([toolResult(longLog('DEBUG: trace output')), { role: 'assistant', content: [] }], ctxFor(sessionDir, 'session_test_02'));
    assert.equal(res, undefined);
  });
});

test('ObservationPack: 错误结果与 EPR receipt 都不打包', async () => {
  await inSession(async (sessionDir) => {
    const { project } = mountObservation();
    const ctx = ctxFor(sessionDir, 'session_test_03');
    const cases = [
      { name: 'isError result', message: { ...toolResult('FATAL: process crashed\n'.repeat(50)), isError: true }, needle: 'FATAL: process crashed' },
      { name: 'reducer receipt', message: toolResult(`${REDUCER_RECEIPT_PREFIX}\nstatus=failure\n`.repeat(50)), needle: REDUCER_RECEIPT_PREFIX },
    ];
    for (const c of cases) {
      const res = await project([c.message, { role: 'assistant', content: [] }], ctx);
      assert.ok(res.messages[0].content[0].text.includes(c.needle), c.name);
    }
  });
});

test('ObservationPack: 多 block 内容同样打包（memoKey 按内容长度）', async () => {
  await inSession(async (sessionDir) => {
    const { project } = mountObservation();
    const event = [
      {
        ...toolResult('ignored', 'tc_multi_1'),
        content: [
          { type: 'text', text: 'Block A content line...\n'.repeat(60) },
          { type: 'text', text: 'Block B content line...\n'.repeat(60) },
        ],
      },
      { role: 'assistant', content: [] },
    ];

    const first = await project(event, ctxFor(sessionDir, 'session_test_04'));
    assert.ok(first.messages[0].content[0].text.includes('[large tool result replaced'));
  });
});

test('ObservationPack: 批打包遵守条数上限并写 packed-batch 遥测', async () => {
  await inSession(async (sessionDir) => {
    const packed = await batchPackObservations({
      sessionRoot: sessionDir,
      sessionId: 'session_test_05',
      messages: [
        toolResult('OUTPUT 1: long line...\n'.repeat(50), 'tc_batch_1'),
        toolResult('OUTPUT 2: long line...\n'.repeat(50), 'tc_batch_2'),
        toolResult('small text', 'tc_batch_3', 'read'),
      ],
      obsConfig: obsConfig({ logEnabled: true }),
      limits: { maxItems: 1 },
    });
    assert.equal(packed, 1);

    const logData = await readFile(join(sessionDir, 'efficiency-logs', 'observation.jsonl'), 'utf8');
    assert.ok(logData.includes('"event":"packed-batch"')); assert.ok(logData.includes('"source":"compaction"'));
    assert.ok(logData.includes('"sessionId":"session_test_05"')); assert.ok(logData.includes('"obsId":"obs_'));
  });
});

test('ObservationPack: 批打包并发预取 middle 窗口，每条候选只 pick 一次', async () => {
  await inSession(async (sessionDir) => {
    const messages = [1, 2, 3].map((n) => toolResult(`PARALLEL ${n}: long line...\n`.repeat(50), `tc_parallel_${n}`));
    // Deterministic concurrency probe: every pick parks on `release`, so only parallel prefetch can
    // have three in flight at once (no real timers involved).
    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;
    const release = Promise.withResolvers<void>();
    const tick = async (): Promise<void> => {
      const { promise, resolve } = Promise.withResolvers<void>(); setImmediate(resolve); await promise;
    };
    const pickMiddleExcerpt = async () => {
      calls++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await release.promise;
      inFlight--;
      return { text: 'mid window', label: 'test window' };
    };

    const batch = batchPackObservations({
      sessionRoot: sessionDir,
      sessionId: 'session_parallel',
      messages,
      obsConfig: obsConfig(),
      pickMiddleExcerpt,
    });
    for (let i = 0; i < 10; i++) await tick();
    release.resolve();
    assert.equal(await batch, 3);
    assert.equal(maxInFlight, 3, '预取必须并发，否则 onBeforeCompact 会被 jev 延迟线性拖住');
    assert.equal(calls, 3, '预取结果被消费，打包阶段不得重挑');
  });
});

test('ObservationPack: createCompactionBatchPackHook 尊重配置、角色闸门与分支形状', async () => {
  await inSession(async (sessionDir) => {
    const objectsDir = join(sessionDir, 'observation-pack', 'objects');
    const readObjects = async (): Promise<string[]> => await readdir(objectsDir).catch(() => []);
    const config = obsConfig({ logEnabled: true });
    const branch = [
      { type: 'message', id: 'm1', message: toolResult('OUTPUT: long line...\n'.repeat(50), 'tc_hook_1') },
      { type: 'custom', customType: 'pi-herdr.todo', data: {} }, // non-message entry: skipped
      { type: 'message', id: 'm2' }, // message without a payload: skipped
    ];
    const ctx = { sessionManager: { getBranch: () => branch } };

    await createCompactionBatchPackHook({ getObsConfig: () => ({ ...config, enabled: false }) })(sessionDir, ctx);
    assert.deepEqual(await readObjects(), [], '未启用即 no-op');

    await createCompactionBatchPackHook({
      getObsConfig: () => config,
      getManifest: () => restrictedRole,
      getSessionId: () => 'session_hook',
    })(sessionDir, ctx);
    assert.deepEqual(await readObjects(), [], '无 obs_recall 权限的角色不该收到预打包占位符');

    const hook = createCompactionBatchPackHook({
      getObsConfig: () => config,
      getManifest: () => null,
      getSessionId: () => 'session_hook',
    });
    await hook(sessionDir, ctx);
    assert.equal((await readObjects()).length, 1, '只打包 message 条目');
    const logPath = join(sessionDir, 'efficiency-logs', 'observation.jsonl');
    assert.ok((await readFile(logPath, 'utf8')).includes('"source":"compaction"'));

    await hook(sessionDir, ctx);
    assert.equal((await readObjects()).length, 1, '第二次命中 memo'); assert.equal((await readFile(logPath, 'utf8')).trim().split('\n').length, 1, '不重复遥测');
  });
});
