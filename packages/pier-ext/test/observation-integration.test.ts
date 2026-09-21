/**
 * D101 ObservationPack 集成测试：obs_recall 注册与分页、context 投影（角色闸门 / 活跃窗口 / 豁免 /
 * memo 快路径）、批打包（上限、遥测、并发预取）、onBeforeCompact 钩子。
 * 纯算法（excerpt/切片/经济性）见 observation-core.test.ts。
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
  tools: Map<string, { execute: (...a: unknown[]) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }> }>;
  listeners: Map<string, Array<(...a: unknown[]) => unknown>>;
}

function createMockPi(): MockPi & ExtensionAPI {
  const tools = new Map<string, never>();
  const listeners = new Map<string, Array<(...a: unknown[]) => unknown>>();
  return {
    tools,
    listeners,
    registerTool: (def: { name: string }) => { tools.set(def.name, def as never); },
    on: (event: string, handler: (...a: unknown[]) => unknown) => {
      listeners.set(event, [...(listeners.get(event) ?? []), handler]);
    },
  } as unknown as MockPi & ExtensionAPI;
}

const createMockContext = (sessionDir: string, sessionId: string): ExtensionContext => ({
  sessionManager: { getSessionDir: () => sessionDir, getSessionId: () => sessionId },
} as unknown as ExtensionContext);

const obsConfig = (over: Record<string, unknown> = {}) => ({
  ...DEFAULT_EFFICIENCY_CONFIG.observationPack,
  enabled: true,
  thresholdBytes: 500,
  fullSends: 1,
  ...over,
});

const effConfig = (over: Record<string, unknown> = {}): EfficiencyConfig => ({
  ...DEFAULT_EFFICIENCY_CONFIG,
  observationPack: obsConfig(over),
});

const toolResult = (text: string, id = 'tc_1', toolName = 'bash') => ({
  role: 'toolResult',
  toolName,
  toolCallId: id,
  content: [{ type: 'text', text }],
});

/** 一条日志，默认 ~2KB，超过测试阈值。 */
const longLog = (marker = 'INFO: step processing') => `${marker}\n`.repeat(100);

/** 每个测试独立的临时 session 根；回调结束后清理 memo 与目录。 */
async function withSession(fn: (sessionDir: string) => Promise<void>): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), 'pier-obs-test-'));
  clearObservationMemoForTest();
  try {
    await fn(tempDir);
  } finally {
    clearObservationMemoForTest();
    await rm(tempDir, { recursive: true, force: true });
  }
}

test('ObservationPack: 注册 obs_recall；活跃窗口内原样，超窗后投影占位符并可分页召回', async () => {
  await withSession(async (tempDir) => {
    const pi = createMockPi();
    registerObservationPack({ pi, getConfig: () => effConfig() });
    assert.equal(pi.tools.has(RECALL_TOOL_NAME), true);
    const recallTool = pi.tools.get(RECALL_TOOL_NAME)!;
    const ctx = createMockContext(tempDir, 'session_test_01');

    // A1：非法 id 是硬失败（抛错让 pi 标 isError），不是普通结果
    await assert.rejects(
      async () => { await recallTool.execute('call_1', { id: 'bad_id' }, undefined, undefined, ctx); },
      /invalid observation id format/,
    );

    const contextHandler = pi.listeners.get('context')![0]!;
    const log = longLog();

    // 第 1 次 sendCount=0 < fullSends=1 → 全文保留；第 2 次已有 1 条 assistant → 替换
    const first = await contextHandler({ messages: [toolResult(log)] }, ctx) as { messages: Array<{ content: Array<{ text: string }> }> };
    assert.equal(first.messages[0].content[0].text, log);
    const second = await contextHandler({
      messages: [toolResult(log), { role: 'assistant', content: [{ type: 'text', text: 'analyzing...' }] }],
    }, ctx) as { messages: Array<{ content: Array<{ text: string }> }> };
    const replaced = second.messages[0].content[0].text;
    assert.notEqual(replaced, log);
    assert.match(replaced, /\[large tool result replaced after its first 1 provider requests\]/);
    const obsId = replaced.match(/id:\s+(obs_[a-f0-9]{24})/)![1]!;

    const recalled = await recallTool.execute('call_2', { id: obsId, offset: 0 }, undefined, undefined, ctx);
    assert.ok(recalled.content[0].text.includes('[obs_recall id='));
    assert.ok(recalled.content[0].text.includes('INFO: step processing'), '召回原文');
    assert.equal(recalled.details.id, obsId);
    assert.equal(recalled.details.offset, 0);
  });
});

test('ObservationPack: 角色被拒 obs_recall 时完全不投影（模型不该拿到不可用的句柄）', async () => {
  await withSession(async (tempDir) => {
    const pi = createMockPi();
    const restrictedRole: RuntimeRoleManifest = {
      role: 'restricted-agent',
      version: '1.0.0',
      tools: ['bash', 'read'],
      permissions: { '*': 'allow' },
      unknownTools: 'deny',
    };
    registerObservationPack({ pi, getConfig: () => effConfig(), getRuntimeManifest: () => restrictedRole });
    const contextHandler = pi.listeners.get('context')![0]!;
    const res = await contextHandler({
      messages: [toolResult(longLog('DEBUG: trace output')), { role: 'assistant', content: [] }],
    }, createMockContext(tempDir, 'session_test_02'));
    assert.equal(res, undefined);
  });
});

test('ObservationPack: 错误结果与 EPR receipt 都不打包', async () => {
  await withSession(async (tempDir) => {
    const pi = createMockPi();
    registerObservationPack({ pi, getConfig: () => effConfig() });
    const contextHandler = pi.listeners.get('context')![0]!;
    const ctx = createMockContext(tempDir, 'session_test_03');

    const errorRes = await contextHandler({
      messages: [{ ...toolResult('FATAL: process crashed\n'.repeat(50)), isError: true }, { role: 'assistant', content: [] }],
    }, ctx) as { messages: Array<{ content: Array<{ text: string }> }> };
    assert.ok(errorRes.messages[0].content[0].text.includes('FATAL: process crashed'));

    const receiptRes = await contextHandler({
      messages: [
        toolResult(`${REDUCER_RECEIPT_PREFIX}\nstatus=failure\n`.repeat(50)),
        { role: 'assistant', content: [] },
      ],
    }, ctx) as { messages: Array<{ content: Array<{ text: string }> }> };
    assert.ok(receiptRes.messages[0].content[0].text.includes(REDUCER_RECEIPT_PREFIX));
  });
});

test('ObservationPack: memo 快路径命中同一占位符；存储丢失时召回自愈', async () => {
  await withSession(async (tempDir) => {
    const pi = createMockPi();
    registerObservationPack({ pi, getConfig: () => effConfig() });
    const ctx = createMockContext(tempDir, 'session_test_04');
    const contextHandler = pi.listeners.get('context')![0]!;
    const event = { messages: [toolResult(longLog('VERBOSE: detailed diagnostic line'), 'tc_memo_1'), { role: 'assistant', content: [] }] };

    const first = await contextHandler(event, ctx) as { messages: Array<{ content: Array<{ text: string }> }> };
    assert.ok(first.messages[0].content[0].text.includes('[large tool result replaced'));
    const second = await contextHandler(event, ctx) as { messages: Array<{ content: Array<{ text: string }> }> };
    assert.equal(second.messages[0].content[0].text, first.messages[0].content[0].text, 'memo 命中：占位符稳定');

    const missing = await pi.tools.get(RECALL_TOOL_NAME)!.execute(
      'call_fail', { id: 'obs_000000000000000000000000' }, undefined, undefined, ctx,
    );
    assert.ok(missing.content[0].text.includes('Error: failed to recall observation'), '缺文件自愈路径');
  });
});

test('ObservationPack: 批打包遵守条数上限并写 packed-batch 遥测', async () => {
  await withSession(async (tempDir) => {
    const packed = await batchPackObservations({
      sessionRoot: tempDir,
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

    const logData = await readFile(join(tempDir, 'efficiency-logs', 'observation.jsonl'), 'utf8');
    assert.ok(logData.includes('"event":"packed-batch"'));
    assert.ok(logData.includes('"source":"compaction"'));
    assert.ok(logData.includes('"sessionId":"session_test_05"'));
    assert.ok(logData.includes('"obsId":"obs_'));
  });
});

test('ObservationPack: 批打包并发预取 middle 窗口，每条候选只 pick 一次', async () => {
  await withSession(async (tempDir) => {
    const messages = [1, 2, 3].map((n) => toolResult(`PARALLEL ${n}: long line...\n`.repeat(50), `tc_parallel_${n}`));
    // 确定性并发探针：每个 pick 都卡在 release 上，只有并发预取才能三条同时在场（无真实计时器）。
    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;
    const release = Promise.withResolvers<void>();
    const tick = async (): Promise<void> => {
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

test('ObservationPack: 多 block 内容按长度做 memoKey；命中后不再评估 horizon', async () => {
  await withSession(async (tempDir) => {
    const pi = createMockPi();
    let horizonCalls = 0;
    registerObservationPack({
      pi,
      getConfig: () => effConfig(),
      getRemainingHorizon: () => { horizonCalls++; return 5; },
    });
    const ctx = createMockContext(tempDir, 'session_test_06');
    const contextHandler = pi.listeners.get('context')![0]!;
    const event = {
      messages: [
        {
          ...toolResult('ignored', 'tc_multi_1'),
          content: [
            { type: 'text', text: 'Block A content line...\n'.repeat(60) },
            { type: 'text', text: 'Block B content line...\n'.repeat(60) },
          ],
        },
        { role: 'assistant', content: [] },
      ],
    };

    const first = await contextHandler(event, ctx) as { messages: Array<{ content: Array<{ text: string }> }> };
    assert.ok(first.messages[0].content[0].text.includes('[large tool result replaced'));
    assert.equal(horizonCalls, 1);
    const second = await contextHandler(event, ctx) as { messages: Array<{ content: Array<{ text: string }> }> };
    assert.equal(second.messages[0].content[0].text, first.messages[0].content[0].text);
    assert.equal(horizonCalls, 1, 'memo 命中即短路，不该再问 horizon');
  });
});

test('ObservationPack: createCompactionBatchPackHook 尊重配置、角色闸门与分支形状', async () => {
  await withSession(async (tempDir) => {
    const objectsDir = join(tempDir, 'observation-pack', 'objects');
    const readObjects = async (): Promise<string[]> => await readdir(objectsDir).catch(() => []);
    const config = obsConfig({ logEnabled: true });
    const branch = [
      {
        type: 'message',
        id: 'm1',
        message: toolResult('OUTPUT: long line...\n'.repeat(50), 'tc_hook_1'),
      },
      { type: 'custom', customType: 'pi-herdr.todo', data: {} }, // 非 message 条目：跳过
      { type: 'message', id: 'm2' }, // 无 payload 的 message 条目：跳过
    ];
    const ctx = { sessionManager: { getBranch: () => branch } };

    await createCompactionBatchPackHook({ getObsConfig: () => ({ ...config, enabled: false }) })(tempDir, ctx);
    assert.deepEqual(await readObjects(), [], '未启用即 no-op');

    const denyingRole = {
      role: 'restricted-agent',
      version: '1.0.0',
      tools: ['bash', 'read'],
      permissions: { '*': 'allow' },
      unknownTools: 'deny',
    } as RuntimeRoleManifest;
    await createCompactionBatchPackHook({
      getObsConfig: () => config,
      getManifest: () => denyingRole,
      getSessionId: () => 'session_hook',
    })(tempDir, ctx);
    assert.deepEqual(await readObjects(), [], '无 obs_recall 权限的角色不该收到预打包占位符');

    const hook = createCompactionBatchPackHook({
      getObsConfig: () => config,
      getManifest: () => null,
      getSessionId: () => 'session_hook',
    });
    await hook(tempDir, ctx);
    assert.equal((await readObjects()).length, 1, '只打包 message 条目');
    const logPath = join(tempDir, 'efficiency-logs', 'observation.jsonl');
    assert.ok((await readFile(logPath, 'utf8')).includes('"source":"compaction"'));

    await hook(tempDir, ctx);
    assert.equal((await readObjects()).length, 1, '第二次命中 memo');
    assert.equal((await readFile(logPath, 'utf8')).trim().split('\n').length, 1, '不重复遥测');
  });
});
