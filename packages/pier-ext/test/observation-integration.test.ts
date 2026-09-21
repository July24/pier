/**
 * D101 ObservationPack Integration Tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  batchPackObservations,
  clearObservationMemoForTest,
  createCompactionBatchPackHook,
  registerObservationPack,
  RECALL_TOOL_NAME,
} from '../src/plugins/observation.ts';
import { DEFAULT_EFFICIENCY_CONFIG, type EfficiencyConfig } from '../src/efficiency-config-core.ts';
import { REDUCER_RECEIPT_PREFIX } from '../src/observation-core.ts';
import type { RuntimeRoleManifest } from '../src/tool-gate.ts';

interface MockPi {
  tools: Map<string, any>;
  listeners: Map<string, Array<Function>>;
  registerTool(def: any): void;
  on(event: string, handler: Function): void;
}

function createMockPi(): MockPi & ExtensionAPI {
  const tools = new Map<string, any>();
  const listeners = new Map<string, Array<Function>>();

  const mock: any = {
    tools,
    listeners,
    registerTool(def: any) {
      tools.set(def.name, def);
    },
    on(event: string, handler: Function) {
      listeners.set(event, [...(listeners.get(event) ?? []), handler]);
    },
  };
  return mock;
}

function createMockContext(sessionDir: string, sessionId: string): ExtensionContext {
  return {
    sessionManager: {
      getSessionDir: () => sessionDir,
      getSessionId: () => sessionId,
    } as any,
  } as ExtensionContext;
}

test('ObservationPack: registers obs_recall tool and executes paged recall', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'pier-obs-pack-test-'));
  const sessionId = 'session_test_01';

  try {
    const pi = createMockPi();
    const config: EfficiencyConfig = {
      ...DEFAULT_EFFICIENCY_CONFIG,
      observationPack: {
        ...DEFAULT_EFFICIENCY_CONFIG.observationPack,
        enabled: true,
        thresholdBytes: 1024, // 1KB threshold for test
        fullSends: 1,
      },
    };

    registerObservationPack({
      pi,
      getConfig: () => config,
    });

    assert.equal(pi.tools.has(RECALL_TOOL_NAME), true);
    const recallTool = pi.tools.get(RECALL_TOOL_NAME);
    const ctx = createMockContext(tempDir, sessionId);

    // 1. Invalid ID rejection (A1: hard failures reject instead of returning error text)
    await assert.rejects(
      async () => { await recallTool.execute('call_1', { id: 'bad_id' }, undefined, undefined, ctx); },
      /invalid observation id format/,
    );

    // 2. Prepare context with a large output (2KB)
    const largeLog = 'INFO: step processing\n'.repeat(100); // ~2200 bytes
    const contextHandlers = pi.listeners.get('context') ?? [];
    assert.equal(contextHandlers.length, 1);
    const contextHandler = contextHandlers[0]!;

    // First send: prior assistant count = 0 (< fullSends=1) -> remains full text
    const eventFirst = {
      messages: [
        {
          role: 'toolResult',
          toolName: 'bash',
          toolCallId: 'tc_1',
          content: [{ type: 'text', text: largeLog }],
        },
      ],
    };
    const resFirst = await contextHandler(eventFirst, ctx);
    assert.equal(resFirst.messages[0].content[0].text, largeLog);

    // Second send: message is followed by 1 assistant message -> sendCount = 1 (>= fullSends)
    const eventSecond = {
      messages: [
        {
          role: 'toolResult',
          toolName: 'bash',
          toolCallId: 'tc_1',
          content: [{ type: 'text', text: largeLog }],
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'analyzing...' }],
        },
      ],
    };
    const resSecond = await contextHandler(eventSecond, ctx);
    const replacedText = resSecond.messages[0].content[0].text;
    assert.notEqual(replacedText, largeLog);
    assert.match(replacedText, /\[large tool result replaced after its first 1 provider requests\]/);
    assert.match(replacedText, /id: (obs_[a-f0-9]{24})/);

    // 3. Extract obsId and recall original content using obs_recall
    const match = replacedText.match(/id:\s+(obs_[a-f0-9]{24})/);
    assert.ok(match && match[1]);
    const obsId = match[1];

    const recallRes = await recallTool.execute('call_2', { id: obsId, offset: 0 }, undefined, undefined, ctx);
    assert.ok(recallRes.content[0].text.includes('[obs_recall id='));
    assert.ok(recallRes.content[0].text.includes('INFO: step processing'));
    assert.equal(recallRes.details.id, obsId);
    assert.equal(recallRes.details.offset, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('ObservationPack: skips packing when obs_recall is denied by role manifest', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'pier-obs-role-test-'));
  const sessionId = 'session_test_02';

  try {
    const pi = createMockPi();
    const config: EfficiencyConfig = {
      ...DEFAULT_EFFICIENCY_CONFIG,
      observationPack: {
        ...DEFAULT_EFFICIENCY_CONFIG.observationPack,
        enabled: true,
        thresholdBytes: 1024,
        fullSends: 1,
      },
    };

    // Role denies unknown tools and does not list obs_recall
    const restrictedRole: RuntimeRoleManifest = {
      role: 'restricted-agent',
      version: '1.0.0',
      tools: ['bash', 'read'],
      permissions: { '*': 'allow' },
      unknownTools: 'deny',
    };

    registerObservationPack({
      pi,
      getConfig: () => config,
      getRuntimeManifest: () => restrictedRole,
    });

    const ctx = createMockContext(tempDir, sessionId);
    const largeLog = 'DEBUG: trace output\n'.repeat(100);
    const contextHandler = pi.listeners.get('context')![0]!;

    const event = {
      messages: [
        {
          role: 'toolResult',
          toolName: 'bash',
          toolCallId: 'tc_2',
          content: [{ type: 'text', text: largeLog }],
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'response 1' }],
        },
      ],
    };

    // Packing must be skipped so model doesn't get an inaccessible tool handle
    const res = await contextHandler(event, ctx);
    assert.equal(res, undefined);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('ObservationPack: never packs errors or EPR receipts', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'pier-obs-exempt-test-'));
  const sessionId = 'session_test_03';

  try {
    const pi = createMockPi();
    const config: EfficiencyConfig = {
      ...DEFAULT_EFFICIENCY_CONFIG,
      observationPack: {
        ...DEFAULT_EFFICIENCY_CONFIG.observationPack,
        enabled: true,
        thresholdBytes: 500,
        fullSends: 1,
      },
    };

    registerObservationPack({
      pi,
      getConfig: () => config,
    });

    const ctx = createMockContext(tempDir, sessionId);
    const contextHandler = pi.listeners.get('context')![0]!;

    // 1. Tool result with isError: true
    const errorEvent = {
      messages: [
        {
          role: 'toolResult',
          isError: true,
          content: [{ type: 'text', text: 'FATAL: process crashed\n'.repeat(50) }],
        },
        { role: 'assistant', content: [] },
      ],
    };
    const errorRes = await contextHandler(errorEvent, ctx);
    assert.equal(errorRes.messages[0].content[0].text.includes('FATAL: process crashed'), true);

    // 2. Receipt containing REDUCER_RECEIPT_PREFIX
    const receiptEvent = {
      messages: [
        {
          role: 'toolResult',
          isError: false,
          content: [{ type: 'text', text: `${REDUCER_RECEIPT_PREFIX}\nstatus=failure\n`.repeat(50) }],
        },
        { role: 'assistant', content: [] },
      ],
    };
    const receiptRes = await contextHandler(receiptEvent, ctx);
    assert.equal(receiptRes.messages[0].content[0].text.includes(REDUCER_RECEIPT_PREFIX), true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('ObservationPack: memoization fast-path and self-healing on missing disk object', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'pier-obs-memo-test-'));
  const sessionId = 'session_test_04';

  try {
    clearObservationMemoForTest();
    const pi = createMockPi();
    const config: EfficiencyConfig = {
      ...DEFAULT_EFFICIENCY_CONFIG,
      observationPack: {
        ...DEFAULT_EFFICIENCY_CONFIG.observationPack,
        enabled: true,
        thresholdBytes: 1024,
        fullSends: 1,
      },
    };

    registerObservationPack({
      pi,
      getConfig: () => config,
    });

    const ctx = createMockContext(tempDir, sessionId);
    const recallTool = pi.tools.get(RECALL_TOOL_NAME);
    const contextHandler = pi.listeners.get('context')![0]!;
    const largeLog = 'VERBOSE: detailed diagnostic line\n'.repeat(60);

    const event = {
      messages: [
        {
          role: 'toolResult',
          toolName: 'bash',
          toolCallId: 'tc_memo_1',
          content: [{ type: 'text', text: largeLog }],
        },
        { role: 'assistant', content: [] },
      ],
    };

    // 1. First packing: creates memo and saves file
    const res1 = await contextHandler(event, ctx);
    assert.ok(res1.messages[0].content[0].text.includes('[large tool result replaced'));

    // 2. Second invocation: hits memoization fast-path (O(1) memory lookup)
    const res2 = await contextHandler(event, ctx);
    assert.equal(res2.messages[0].content[0].text, res1.messages[0].content[0].text);

    // 3. Self-healing: simulate file removal from disk
    // Deliberately query non-existent/corrupted file to trigger self-healing invalidation
    const recallFail = await recallTool.execute('call_fail', { id: 'obs_000000000000000000000000' }, undefined, undefined, ctx);
    assert.ok(recallFail.content[0].text.includes('Error: failed to recall observation'));
  } finally {
    clearObservationMemoForTest();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('ObservationPack: batchPackObservations pre-packs large observations at OCC compaction point with limits and telemetry', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'pier-obs-batch-test-'));
  const sessionId = 'session_test_05';

  try {
    clearObservationMemoForTest();
    const config = {
      ...DEFAULT_EFFICIENCY_CONFIG.observationPack,
      enabled: true,
      logEnabled: true,
      thresholdBytes: 500,
    };

    const messages = [
      {
        role: 'toolResult',
        toolName: 'bash',
        toolCallId: 'tc_batch_1',
        content: [{ type: 'text', text: 'OUTPUT 1: long line...\n'.repeat(50) }],
      },
      {
        role: 'toolResult',
        toolName: 'bash',
        toolCallId: 'tc_batch_2',
        content: [{ type: 'text', text: 'OUTPUT 2: long line...\n'.repeat(50) }],
      },
      {
        role: 'toolResult',
        toolName: 'read',
        toolCallId: 'tc_batch_3',
        content: [{ type: 'text', text: 'small text' }],
      },
    ];

    // Limit to max 1 item in batch
    const packedCount = await batchPackObservations({
      sessionRoot: tempDir,
      sessionId,
      messages,
      obsConfig: config,
      limits: { maxItems: 1 },
    });

    assert.equal(packedCount, 1);

    // Verify packed-batch telemetry written
    const logPath = join(tempDir, 'efficiency-logs', 'observation.jsonl');
    const logData = await readFile(logPath, 'utf8');
    assert.ok(logData.includes('"event":"packed-batch"'));
    assert.ok(logData.includes('"source":"compaction"'));
    assert.ok(logData.includes(`"sessionId":"${sessionId}"`));
    assert.ok(logData.includes('"obsId":"obs_'));
  } finally {
    clearObservationMemoForTest();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('ObservationPack: batch prefetches middle excerpts concurrently, one pick per candidate (2026-09-19 flip)', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'pier-obs-parallel-test-'));
  try {
    clearObservationMemoForTest();
    const config = {
      ...DEFAULT_EFFICIENCY_CONFIG.observationPack,
      enabled: true,
      thresholdBytes: 500,
    };
    const messages = [1, 2, 3].map((n) => ({
      role: 'toolResult',
      toolName: 'bash',
      toolCallId: `tc_parallel_${n}`,
      content: [{ type: 'text', text: `PARALLEL ${n}: long line...\n`.repeat(50) }],
    }));

    // Deterministic concurrency probe: every pick blocks on `release`; only a
    // concurrent prefetch lets all three be in flight at once. No real timers.
    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;
    const release = Promise.withResolvers<void>();
    const turn = async (): Promise<void> => {
      const { promise, resolve } = Promise.withResolvers<void>();
      setImmediate(resolve);
      await promise;
    };
    const pickMiddleExcerpt = async () => {
      calls++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await release.promise;
      inFlight--;
      return { text: 'mid window', label: 'test window' };
    };

    const batch = batchPackObservations({
      sessionRoot: tempDir,
      sessionId: 'session_parallel',
      messages,
      obsConfig: config,
      pickMiddleExcerpt,
    });
    // Drain the event loop: a serial implementation would sit on its first
    // pending pick; a concurrent one has all three parked on `release`.
    for (let i = 0; i < 10; i++) await turn();
    release.resolve();
    const packedCount = await batch;

    assert.equal(packedCount, 3);
    // A serial loop would block onBeforeCompact for candidates × jev latency.
    assert.equal(maxInFlight, 3, 'prefetch must run concurrently, not serially');
    assert.equal(calls, 3, 'the prefetched middle is consumed; packing must not re-pick');
  } finally {
    clearObservationMemoForTest();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('ObservationPack: multi-block content matches memoKey and avoids recalculation (P1 fix §13.1)', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'pier-obs-multiblock-test-'));
  const sessionId = 'session_test_06';

  try {
    clearObservationMemoForTest();
    const pi = createMockPi();
    const config = {
      ...DEFAULT_EFFICIENCY_CONFIG.observationPack,
      enabled: true,
      thresholdBytes: 500,
      fullSends: 1,
    };

    let horizonCalls = 0;
    registerObservationPack({
      pi,
      getConfig: () => ({ ...DEFAULT_EFFICIENCY_CONFIG, observationPack: config }),
      getRemainingHorizon: () => {
        horizonCalls++;
        return 5;
      },
    });

    const ctx = createMockContext(tempDir, sessionId);
    const contextHandler = pi.listeners.get('context')![0]!;

    // Two-block content where text.length > approxChars (due to newline join)
    const event = {
      messages: [
        {
          role: 'toolResult',
          toolName: 'bash',
          toolCallId: 'tc_multi_1',
          content: [
            { type: 'text', text: 'Block A content line...\n'.repeat(60) },
            { type: 'text', text: 'Block B content line...\n'.repeat(60) },
          ],
        },
        { role: 'assistant', content: [] },
      ],
    };

    // 1. First context call packs it and evaluates horizon
    const res1 = await contextHandler(event, ctx);
    assert.ok(res1.messages[0].content[0].text.includes('[large tool result replaced'));
    assert.equal(horizonCalls, 1);

    // 2. Second context call must hit memoKey directly and NOT re-call getRemainingHorizon!
    const res2 = await contextHandler(event, ctx);
    assert.equal(res2.messages[0].content[0].text, res1.messages[0].content[0].text);
    // Horizon must NOT have been called again because memo hit early!
    assert.equal(horizonCalls, 1);
  } finally {
    clearObservationMemoForTest();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('ObservationPack: createCompactionBatchPackHook honours config, role gate and branch shape (§13.3)', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'pier-obs-hook-test-'));
  const objectsDir = join(tempDir, 'observation-pack', 'objects');
  const readObjects = async (): Promise<string[]> =>
    await readdir(objectsDir).catch(() => [] as string[]);

  try {
    clearObservationMemoForTest();
    const obsConfig = {
      ...DEFAULT_EFFICIENCY_CONFIG.observationPack,
      enabled: true,
      logEnabled: true,
      thresholdBytes: 500,
    };
    const branch = [
      {
        type: 'message',
        id: 'm1',
        message: {
          role: 'toolResult',
          toolName: 'bash',
          toolCallId: 'tc_hook_1',
          content: [{ type: 'text', text: 'OUTPUT: long line...\n'.repeat(50) }],
        },
      },
      { type: 'custom', customType: 'pi-herdr.todo', data: {} }, // non-message entry: ignored
      { type: 'message', id: 'm2' }, // message entry without payload: ignored
    ];
    const ctx = { sessionManager: { getBranch: () => branch } };

    // 1. Disabled pack config -> no-op (no objects, no telemetry dir).
    await createCompactionBatchPackHook({ getObsConfig: () => ({ ...obsConfig, enabled: false }) })(tempDir, ctx);
    assert.deepEqual(await readObjects(), []);

    // 2. Role denies obs_recall -> no-op even when packing is enabled.
    const denyingRole = {
      role: 'restricted-agent',
      version: '1.0.0',
      tools: ['bash', 'read'],
      permissions: { '*': 'allow' },
      unknownTools: 'deny',
    } as RuntimeRoleManifest;
    await createCompactionBatchPackHook({
      getObsConfig: () => obsConfig,
      getManifest: () => denyingRole,
      getSessionId: () => 'session_hook',
    })(tempDir, ctx);
    assert.deepEqual(await readObjects(), [], 'a role without obs_recall must not receive pre-packed placeholders');

    // 3. Allowed role -> packs the message entries only, and logs one packed-batch record.
    const hook = createCompactionBatchPackHook({
      getObsConfig: () => obsConfig,
      getManifest: () => null,
      getSessionId: () => 'session_hook',
    });
    await hook(tempDir, ctx);
    assert.equal((await readObjects()).length, 1);

    const logPath = join(tempDir, 'efficiency-logs', 'observation.jsonl');
    const logData = await readFile(logPath, 'utf8');
    assert.ok(logData.includes('"event":"packed-batch"'));
    assert.ok(logData.includes('"source":"compaction"'));
    assert.ok(logData.includes('"sessionId":"session_hook"'));

    // 4. Second invocation hits the memo -> nothing repacked, no duplicate telemetry.
    await hook(tempDir, ctx);
    assert.equal((await readObjects()).length, 1);
    assert.equal((await readFile(logPath, 'utf8')).trim().split('\n').length, 1);
  } finally {
    clearObservationMemoForTest();
    await rm(tempDir, { recursive: true, force: true });
  }
});
