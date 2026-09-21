/**
 * subagent spawn 行为回归（session 01a03bf0 实证双缺陷）：
 *  1. ecc0bc4 误删 prompt 注入块 → `injectTs is not defined`（spawn-failed）+
 *     台账幽灵 running 条目 + 子 pane 无任务上下文；
 *  2. spawn 中途失败不回收台账/pane → D96 提醒风暴 + send_message 打到空会话。
 * 缝：subagent 工具 execute（真 pipe 服务器 + 全假件 client/env）。
 * 时序关键：子会话定稿文本由 pipe sim 在收到 prompt 后写入（timestamp ≥ injectTs，
 * 过 lastAssistantText 的 sinceTs 过滤）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import { mkdirSync, mkdtempSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import subagentPlugin from '../src/plugins/subagent.ts';
import { PiSurface } from '../src/pi-surface.ts';
import { pipeNameFor, pipePathFor, type PipeRequest } from '../src/pipe-channel.ts';
import type { HerdrClientLike } from '../src/herdr-client.ts';
import { emptySubagentPortBox, type SubagentPortBox } from '../src/subagent-port.ts';
import { appendHistory } from '../src/history-store.ts';
import { preferredHistoryFile } from '../src/storage-layout.ts';
import { SUBS_CUSTOM_TYPE, type SubEntry } from '../src/subagent-core.ts';
import { sessionDirName } from '../src/session-tail.ts';

const SUB_TEXT = 'REPORT: all channel-fee contact points mapped';
const PROMPT = '你在 apnv3-backend 仓库探查渠道费用触点（只读）。输出完整报告。';

interface FakePi {
  tools: Map<string, { execute?: (...a: unknown[]) => unknown }>;
  listeners: Map<string, Array<(...a: unknown[]) => unknown>>;
  entries: Array<[string, unknown]>;
  registerTool(def: { name: string; execute?: (...a: unknown[]) => unknown }): void;
  on(event: string, handler: (...a: unknown[]) => unknown): void;
  appendEntry(customType: string, data: unknown): void;
}



interface Harness {
  closePaneCalls: string[];
  waitAgentCalls: Array<{ paneId: string; states: string[] }>;
  prompts: PipeRequest[];
  /** pipe sim 收到 prompt 时回调（写子会话定稿文本，模拟子代理即时产出）。 */
  onPrompt?: () => void;
}

function fakePi(): FakePi {
  return {
    tools: new Map<string, { execute?: (...a: unknown[]) => unknown }>(),
    listeners: new Map<string, Array<(...a: unknown[]) => unknown>>(),
    entries: [] as Array<[string, unknown]>,
    registerTool(def: { name: string; execute?: (...a: unknown[]) => unknown }) {
      this.tools.set(def.name, def);
    },
    on(event: string, handler: (...a: unknown[]) => unknown) {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), handler]);
    },
    appendEntry(customType: string, data: unknown) {
      this.entries.push([customType, data]);
    },
  };
}

/** 可配置假 client：p0=master（t0）；splitPane → p2。 */
function fakeClient(sessionFile: string, h: Harness): HerdrClientLike {
  return {
    available: true,
    tabList: async () => [{ tabName: 'main', tabId: 't0', workspaceId: 'w1', label: 'main' }],
    listPanes: async () => [
      { paneId: 'p0', tabId: 't0', agentStatus: 'working' },
      { paneId: 'p2', tabId: 't0', agentStatus: 'idle' },
    ],
    listAgents: async () => [],
    waitAgent: async (paneId: string, states: string[]) => {
      h.waitAgentCalls.push({ paneId, states });
      return 'idle';
    },
    getAgentSessionPath: async () => sessionFile,
    createTab: async () => ({ tabId: 't9', paneId: 'p9' }),
    splitPane: async () => 'p2',
    sendPaneText: async () => undefined,
    exportLayout: async () => {
      throw new Error('layout export unavailable in test');
    },
    tabClose: async () => undefined,
    closePane: async (paneId: string) => {
      h.closePaneCalls.push(paneId);
    },
  } as unknown as HerdrClientLike;
}

/** 真 pipe 服务器（一连接一请求；prompt 可配置 ok/reject，可选 onPrompt 回调）。 */
async function startPipeSim(cwd: string, h: Harness, opts: { rejectPrompt?: boolean }): Promise<net.Server> {
  const sockPath = pipePathFor(pipeNameFor(cwd, 'p2'));
  try {
    if (existsSync(sockPath)) unlinkSync(sockPath);
  } catch { /* 残留清理尽力而为 */ }
  const server = net.createServer((sock) => {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => {
      buf += chunk;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      const req = JSON.parse(buf.slice(0, i)) as PipeRequest;
      buf = '';
      const isPrompt = req.type === 'prompt' || req.type === 'follow_up';
      if (isPrompt) {
        h.prompts.push(req);
        h.onPrompt?.();
      }
      const reject = isPrompt && opts.rejectPrompt;
      const res = reject
        ? { type: 'error' as const, id: req.id, message: 'sim rejected' }
        : { type: 'ok' as const, id: req.id };
      sock.write(JSON.stringify(res) + '\n');
    });
  });
  const { promise, resolve } = Promise.withResolvers<void>();
  server.listen(sockPath, () => resolve());
  await promise;
  return server;
}

async function mountSpawn(pi: FakePi, sessionFile: string, h: Harness): Promise<{ root: Context; port: SubagentPortBox }> {
  const surface = new PiSurface(pi as unknown as object);
  const port = emptySubagentPortBox();
  const root = new Context();
  const deps = {
    client: fakeClient(sessionFile, h),
    env: { paneId: 'p0', tabId: 't0', workspaceId: 'w1' },
    extPath: new URL('../src/index.ts', import.meta.url).pathname,
    sessionRoot: root,
    port,
    getSessionId: () => '',
    reconcileOnSettlement: () => [],
    withReconcileNotes: (b: string) => b,
    claimSettleNotice: () => true,
    terminalState: { activePaneIds: () => new Set<string>() },
  };
  root.provide('pi-herdr.surface', surface);
  root.provide('pi-herdr.subagent-deps', deps);
  await root.plugin(subagentPlugin);
  return { root, port };
}

interface SpawnCtx {
  pi: FakePi;
  port: SubagentPortBox;
  h: Harness;
  cwd: string;
}

async function withSpawnEnv(fn: (ctx: SpawnCtx) => Promise<void>, opts: { rejectPrompt?: boolean; childCwd?: string } = {}): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'pier-spawn-home-'));
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = home; // 台账/会话扫描根重定向（不污染 ~/.pi）
  const cwd = mkdtempSync(join(tmpdir(), 'pier-spawn-cwd-'));
  const sessionFile = join(cwd, 'sub-session.jsonl');
  const h: Harness = {
    closePaneCalls: [],
    waitAgentCalls: [],
    prompts: [],
    // 子代理产出模拟：prompt 注入后写定稿文本（ts ≥ injectTs）
    onPrompt: opts.rejectPrompt ? undefined : () => writeFileSync(sessionFile, JSON.stringify({
      type: 'message',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: SUB_TEXT }],
        timestamp: Date.now(),
        stopReason: 'stop',
      },
    }) + '\n'),
  };
  const server = await startPipeSim(opts.childCwd ?? cwd, h, opts);
  const pi = fakePi();
  const mounted = await mountSpawn(pi, sessionFile, h);
  try {
    await fn({ pi, port: mounted.port, h, cwd });
  } finally {
    await mounted.root.fiber.dispose();
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    await closed.promise;
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
  }
}

test('spawn/send 回归（01a0c282）：跨目录委托时 reply 管道名必须按 master 会话 cwd 作用域', async () => {
  // 实证链：跨仓库 spawn（master=apnv3-backend，worker=CRM）时 from 曾按子 cwd 命名，
  // worker 结算回推进死管道 → 报告丢失 + registry sessionFile 永不纠正。
  const other = mkdtempSync(join(tmpdir(), 'pier-spawn-other-'));
  await withSpawnEnv(async ({ pi, h, cwd }) => {
    const tool = pi.tools.get('subagent');
    assert.ok(tool?.execute);
    const spawned = await tool.execute!(
      'tc_xdir',
      { description: '跨仓库任务', prompt: PROMPT, run_in_background: true, cwd: other },
      undefined,
      undefined,
      { cwd },
    ) as { content: Array<{ text: string }>; details?: { taskId?: string } };
    assert.match(spawned.content[0].text, /^started subagent p2 /);

    const expected = pipeNameFor(cwd, 'p0');
    assert.equal((h.prompts[0] as { from?: string }).from, expected, 'spawn from = master 会话 cwd 作用域');
    assert.notEqual((h.prompts[0] as { from?: string }).from, pipeNameFor(other, 'p0'), '不得按子 cwd 命名');

    // follow_up 同一语义：send 的 from 也必须指向 master 的管道。
    const sendRes = await tool.execute!(
      'tc_xdir_send',
      { action: 'send', agentId: 'p2', message: 'wrap up and report' },
      undefined,
      undefined,
      { cwd },
    ) as { content: Array<{ text: string }> };
    assert.match(sendRes.content[0].text, /Message sent to subagent p2/);
    assert.equal((h.prompts[1] as { from?: string }).from, expected, 'send from = master 会话 cwd 作用域');
  }, { childCwd: other });
});
test('spawn 回归（01a03bf0 缺陷 1）：prompt 必须注入 + 无 ReferenceError + 正常结算', async () => {
  await withSpawnEnv(async ({ pi, port, h, cwd }) => {
    const tool = pi.tools.get('subagent');
    assert.ok(tool?.execute, 'subagent 工具已注册');
    const r = await tool.execute!('tc1', { description: '探查', prompt: PROMPT }, undefined, undefined, { cwd }) as {
      content: Array<{ text: string }>;
    };
    const text = r.content[0].text;
    assert.ok(!/injectTs is not defined/.test(text), `不出现 ReferenceError：${text}`);
    assert.ok(!/failed to spawn/.test(text), `不出现 spawn-failed：${text}`);
    assert.match(text, /REPORT: all channel-fee contact points mapped/);
    assert.equal(h.prompts.length, 1, 'prompt 恰好注入一次');
    assert.equal((h.prompts[0] as { text?: string }).text, PROMPT, 'prompt 全文注入');
    assert.equal((h.prompts[0] as { push?: boolean }).push, false, '前台 push=false');
    assert.deepEqual(port.current?.listRunningSubs() ?? [], [], '无幽灵 running 条目');
  });
});

test('spawn 回归（01a03bf0 缺陷 2）：pipe 拒绝 → 台账回收 + 关 pane + spawn-failed 文案', async () => {
  await withSpawnEnv(async ({ pi, port, h, cwd }) => {
    const tool = pi.tools.get('subagent');
    assert.ok(tool?.execute);
    const r = await tool.execute!('tc2', { description: '探查', prompt: PROMPT }, undefined, undefined, { cwd }) as {
      content: Array<{ text: string }>;
    };
    const text = r.content[0].text;
    assert.match(text, /failed to spawn/);
    assert.match(text, /sim rejected/);
    assert.deepEqual(h.closePaneCalls, ['p2'], '失败 pane 必须关闭');
    assert.deepEqual(port.current?.listRunningSubs() ?? [], [], '台账无幽灵条目');
    const subsEntries = pi.entries.filter(([t]) => t === 'pi-herdr.subs');
    assert.ok(subsEntries.length > 0, '台账有写入');
    const last = subsEntries[subsEntries.length - 1][1] as { subs?: Array<{ paneId: string; status: string }> };
    assert.ok(!last.subs?.some((s) => s.paneId === 'p2'), '最后的台账快照已回收 p2');
  }, { rejectPrompt: true });
});

test('spawn 回归（A7）：run_in_background=true 立即返回，不进入前台 waitAgent 循环', async () => {
  await withSpawnEnv(async ({ pi, port, h, cwd }) => {
    const tool = pi.tools.get('subagent');
    assert.ok(tool?.execute);
    const r = await tool.execute!(
      'tc3',
      { description: '后台探查', prompt: PROMPT, run_in_background: true },
      undefined,
      undefined,
      { cwd },
    ) as {
      content: Array<{ text: string }>;
      details?: { paneId?: string; taskId?: string; background?: boolean; role?: string };
    };
    const text = r.content[0].text;
    assert.match(text, /^started subagent p2 \(task [0-9a-f-]+\)$/);
    assert.equal(r.details?.background, true, 'details.background 应为 true');
    assert.equal(r.details?.paneId, 'p2');
    assert.ok(typeof r.details?.taskId === 'string' && r.details.taskId.length > 0, 'taskId 存在');
    assert.equal(h.waitAgentCalls.length, 0, '后台模式绝不调用 waitAgent 进入前台等待循环');
    assert.equal(h.prompts.length, 1, 'prompt 注入一次');
    assert.equal((h.prompts[0] as { push?: boolean }).push, true, '后台模式 push=true');

    // 检查 running 台账条目正常存在且在 listRunningSubs（background && running）中
    const running = port.current?.listRunningSubs() ?? [];
    assert.equal(running.length, 1, '后台子代理在台账中保持 running 状态');
    assert.equal(running[0].paneId, 'p2');
    assert.equal(running[0].description, '后台探查');
  });
});

test('subagent action send & resume（B1）：短 taskId 唯一前缀 (>=4)、歧义与未找到解析', async () => {
  await withSpawnEnv(async ({ pi, h, cwd }) => {
    const tool = pi.tools.get('subagent');
    assert.ok(tool?.execute);

    // 启动后台子任务，获得自动生成的完整 UUID taskId
    const spawned = await tool.execute!(
      'tc_spawn',
      { description: '后台任务', prompt: PROMPT, run_in_background: true },
      undefined,
      undefined,
      { cwd },
    ) as {
      content: Array<{ text: string }>;
      details?: { paneId?: string; taskId?: string };
    };
    const fullTaskId = spawned.details?.taskId;
    assert.ok(typeof fullTaskId === 'string' && fullTaskId.length >= 8);
    const short8 = fullTaskId.slice(0, 8);
    const short4 = fullTaskId.slice(0, 4);
    const short3 = fullTaskId.slice(0, 3);

    // 1. send 使用 8 位短前缀 → 成功投递
    const sendRes8 = await tool.execute!(
      'tc_send8',
      { action: 'send', agentId: short8, message: '8-char prefix message' },
      undefined,
      undefined,
      { cwd },
    ) as { content: Array<{ text: string }> };
    assert.match(sendRes8.content[0].text, /Message sent to subagent p2/);
    assert.equal(h.prompts.length, 2);
    assert.equal((h.prompts[1] as { text?: string }).text, '8-char prefix message');

    // 2. send 使用 4 位短前缀 → 成功投递
    const sendRes4 = await tool.execute!(
      'tc_send4',
      { action: 'send', agentId: short4, message: '4-char prefix message' },
      undefined,
      undefined,
      { cwd },
    ) as { content: Array<{ text: string }> };
    assert.match(sendRes4.content[0].text, /Message sent to subagent p2/);
    assert.equal(h.prompts.length, 3);

    // 3. send 使用 <4 字符短前缀且非精确匹配 → 拒绝并提示至少 4 字符（A1：硬失败 = reject）
    await assert.rejects(
      async () => {
        await tool.execute!('tc_send_short', { action: 'send', agentId: short3, message: 'too short' }, undefined, undefined, { cwd });
      },
      /is too short \(minimum 4 characters\)/,
    );

    // 4. send 使用不存在的 id → 报错 unknown subagent id
    await assert.rejects(
      async () => {
        await tool.execute!('tc_send_notfound', { action: 'send', agentId: '00000000', message: 'not found' }, undefined, undefined, { cwd });
      },
      /unknown subagent id "00000000"/,
    );

    // 5. resume 使用 8 位短前缀 → 成功解析历史并恢复 (paneId 匹配 existing 则 reuse)
    const resume8 = await tool.execute!(
      'tc_resume8',
      { action: 'resume', taskId: short8 },
      undefined,
      undefined,
      { cwd },
    ) as { content: Array<{ text: string }>; details?: { taskId?: string } };
    assert.match(resume8.content[0].text, /resumed subagent/);
    assert.equal(resume8.details?.taskId, fullTaskId, '返回详情恢复为完整 taskId');

    // 6. resume 使用 <4 字符前缀 → 提示 too short（A1：硬失败 = reject）
    await assert.rejects(
      async () => {
        await tool.execute!('tc_resume_short', { action: 'resume', taskId: short3 }, undefined, undefined, { cwd });
      },
      /is too short \(minimum 4 characters\)/,
    );

    // 7. resume 使用不存在的前缀 → 提示 no history
    await assert.rejects(
      async () => {
        await tool.execute!('tc_resume_notfound', { action: 'resume', taskId: 'ffffffff' }, undefined, undefined, { cwd });
      },
      /no history for task "ffffffff"/,
    );

    // 8. resume 歧义前缀：追加一条同前缀历史条目后，使用 4 位前缀触发歧义
    const { preferredHistoryFile } = await import('../src/storage-layout.ts');
    const { appendHistory } = await import('../src/history-store.ts');
    const agentRoot = process.env.PI_CODING_AGENT_DIR!;
    const histFile = preferredHistoryFile(agentRoot, cwd);
    const ambiguousTaskId = `${short4}9999-0000-1111-2222-333344445555`;
    appendHistory(histFile, {
      taskId: ambiguousTaskId,
      kind: 'task',
      paneId: 'p3',
      tabId: 't0',
      workspaceId: 'w1',
      cwd,
      description: '歧义冲突任务',
      sessionFile: null,
      launchCommand: ['node', 'cli.js'],
      status: 'settled',
      createdAt: Date.now() + 10,
    });

    const ambiguousText = await (async () => {
      try {
        await tool.execute!('tc_resume_amb', { action: 'resume', taskId: short4 }, undefined, undefined, { cwd });
      } catch (e) {
        return (e as Error).message;
      }
      throw new Error('expected an ambiguous prefix to throw');
    })();
    assert.match(ambiguousText, /ambiguous task id/);
    assert.match(ambiguousText, new RegExp(fullTaskId));
    assert.match(ambiguousText, new RegExp(ambiguousTaskId));
  });
});



test('waitSubReady (A14): 子 pane 已消失 → 立刻失败并附上它的最后输出（不再空等 90s）', async () => {
  const { createSpawner } = await import('../src/subagent-spawn.ts');
  const spawner = createSpawner({
    client: {
      listPanes: async () => [], // pane.list miss → 子进程已退出；agent.list 会漏掉 unknown shell
      readPane: async () => ({ text: 'TypeError: boom at footer.render', revision: 1, truncated: false }),
    } as unknown as Parameters<typeof createSpawner>[0]['client'],
    env: { paneId: 'p0', tabId: 't0', workspaceId: 'w1' },
    runtime: { nodePath: '/usr/bin/node', cliPath: '/cli.js', extPath: '/ext.ts' },
    git: { listWorktrees: async () => [] },
  } as unknown as Parameters<typeof createSpawner>[0]);

  const started = Date.now();
  const out = await spawner.waitSubReady('/tmp/pier-a14-nonexistent', 'wA14:p404');
  const elapsed = Date.now() - started;

  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.failure.reason, 'pane-gone');
  assert.match(out.message, /exited before its pipe became ready/);
  assert.match(out.message, /TypeError: boom at footer\.render/);
  assert.ok(elapsed < 10_000, `pane-gone 必须快速失败，实际用了 ${elapsed}ms`);
});

test('waitSubReady (0.9.1): 子 pane 失败时附带 agentExplain 诊断信息', async () => {
  const { createSpawner } = await import('../src/subagent-spawn.ts');
  const spawner = createSpawner({
    client: {
      available: true,
      listPanes: async () => [],
      readPane: async () => ({ text: 'SyntaxError: unexpected token', revision: 1, truncated: false }),
      agentExplain: async () => ({
        matched_rule: 'pi-worker',
        skip_state_reason: 'process_crashed',
      }),
    } as unknown as Parameters<typeof createSpawner>[0]['client'],
    env: { paneId: 'p0', tabId: 't0', workspaceId: 'w1' },
    runtime: { nodePath: '/usr/bin/node', cliPath: '/cli.js', extPath: '/ext.ts' },
    git: { listWorktrees: async () => [] },
  } as unknown as Parameters<typeof createSpawner>[0]);

  const out = await spawner.waitSubReady('/tmp/pier-091-explain', 'wA14:p405');
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.match(out.message, /Herdr detection diagnosis:/);
  assert.match(out.message, /matched rule: pi-worker/);
  assert.match(out.message, /skip reason: process_crashed/);
});

test('waitSubReady: pane.list unknown shell is not pane-gone (agent.list 会漏掉它)', async () => {
  const { createSpawner } = await import('../src/subagent-spawn.ts');
  const paneId = 'wH:p3';
  let readCalls = 0;
  const spawner = createSpawner({
    client: {
      listPanes: async () => [{ paneId, tabId: 'wH:t1', workspaceId: 'wH', agentStatus: 'unknown' }],
      listAgents: async () => [],
      readPane: async () => {
        readCalls += 1;
        return { text: 'TypeError: boom at footer.render', revision: 1, truncated: false };
      },
    },
    env: { paneId: 'p0', tabId: 't0', workspaceId: 'w1' },
    runtime: { nodePath: '/usr/bin/node', cliPath: '/cli.js', extPath: '/ext.ts' },
    git: { listWorktrees: async () => [] },
    readinessTimeoutMs: 1000,
  } as unknown as Parameters<typeof createSpawner>[0]);

  const started = Date.now();
  const out = await spawner.waitSubReady('/tmp/pier-a14-unknown-shell', paneId);
  const elapsed = Date.now() - started;

  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.failure.reason, 'timeout', 'revert to agent.list 会在 0s 报 pane-gone');
  assert.match(out.message, /boom at footer.render/);
  assert.ok(readCalls >= 1, 'alive 时也要采 tail，timeout 才能带上崩溃栈');
  assert.ok(elapsed >= 900, `应等到 short timeout，实际 ${elapsed}ms`);
  assert.ok(elapsed < 10_000, `不得落到 90s 默认上限，实际 ${elapsed}ms`);
});

/**
 * 01a0bd3a 回归：ledger 的 sessionFile 被误归因为 master 自己的 transcript 时，
 * resume 的 D94 复用路径曾按"同 session 的现有 pane"认领 master pane 本身
 * （"reused existing pane with same session"），把 master 注册成自己的 subagent，
 * 后续被 poll 消费、被 GC closePane。断言：指向自身 → 硬失败；指向其他 pane → 复用照常。
 */
test('resume（01a0bd3a）：ledger sessionFile 命中 master 自身会话 → 拒绝认领；命中其他 pane 仍正常复用', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pier-resume-self-'));
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = home; // histFile 落到临时台账根
  const cwd = mkdtempSync(join(tmpdir(), 'pier-resume-self-cwd-'));
  const masterFile = join(cwd, 'master-session.jsonl');
  const otherFile = join(cwd, 'other-session.jsonl');
  writeFileSync(masterFile, '{}\n');
  writeFileSync(otherFile, '{}\n');
  const pi = fakePi();
  const h: Harness = { closePaneCalls: [], waitAgentCalls: [], prompts: [] };
  const surface = new PiSurface(pi as unknown as object);
  const root = new Context();
  const deps = {
    client: {
      ...fakeClient(masterFile, h),
      listPanes: async () => [
        { paneId: 'p0', tabId: 't0', agentStatus: 'idle' },
        { paneId: 'p2', tabId: 't0', agentStatus: 'idle' },
      ],
      listAgents: async () => [
        { paneId: 'p0', status: 'idle', session: masterFile },
        { paneId: 'p2', status: 'idle', session: otherFile },
      ],
    } as unknown as HerdrClientLike,
    env: { paneId: 'p0', tabId: 't0', workspaceId: 'w1' }, // master = p0
    extPath: new URL('../src/index.ts', import.meta.url).pathname,
    sessionRoot: root,
    port: emptySubagentPortBox(),
    getSessionId: () => '',
    reconcileOnSettlement: () => [],
    withReconcileNotes: (b: string) => b,
    claimSettleNotice: () => true,
    terminalState: { activePaneIds: () => new Set<string>() },
  };
  root.provide('pi-herdr.surface', surface);
  root.provide('pi-herdr.subagent-deps', deps);
  await root.plugin(subagentPlugin);
  try {
    const histFile = preferredHistoryFile(home, cwd);
    const base = {
      kind: 'task' as const,
      tabId: 't0',
      workspaceId: 'w1',
      cwd,
      launchCommand: ['node', 'cli.js'],
      status: 'closed' as const,
    };
    appendHistory(histFile, {
      ...base,
      taskId: '8183022d-a733-4292-911b-850e6dffba5a',
      paneId: 'wA:p25',
      description: 'Investigate bug 19812',
      sessionFile: masterFile, // 被污染：指向 master 自己的 transcript
      createdAt: Date.now(),
    });
    appendHistory(histFile, {
      ...base,
      taskId: '937f4abf-0000-4111-8222-333333333333',
      paneId: 'wA:p2old',
      description: 'healthy task',
      sessionFile: otherFile,
      createdAt: Date.now() + 1,
    });

    const tool = pi.tools.get('subagent');
    assert.ok(tool?.execute, 'subagent 工具已注册');

    await assert.rejects(
      async () => {
        await tool!.execute!('tc_self', { action: 'resume', taskId: '8183022d' }, undefined, undefined, { cwd });
      },
      /master's own session/,
    );
    const snap1 = pi.entries.filter(([t]) => t === SUBS_CUSTOM_TYPE).at(-1)?.[1] as { subs: SubEntry[] } | undefined;
    assert.ok(!snap1?.subs.some((s) => s.paneId === 'p0'), 'master pane 不得进入 subagent 注册表');

    const ok = await tool!.execute!(
      'tc_other',
      { action: 'resume', taskId: '937f4abf' },
      undefined,
      undefined,
      { cwd },
    ) as { content: Array<{ text: string }>; details?: { paneId?: string } };
    assert.match(ok.content[0].text, /reused existing pane/);
    assert.equal(ok.details?.paneId, 'p2');
  } finally {
    await root.fiber.dispose();
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
  }
});

async function fireSpawnEvents(pi: FakePi, event: string, ...args: unknown[]): Promise<void> {
  for (const h of pi.listeners.get(event) ?? []) await h(...args);
}

/** P0-1 回归（p24）：worker 经 pipe 自报裸 session id → master 必须映射成路径并纠正误归因。 */
test('applyReplySession：裸 id 自报纠正中毒 sessionFile（.jsonl-only 守卫不再丢弃）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pier-reply-session-'));
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = home;
  const cwd = mkdtempSync(join(tmpdir(), 'pier-reply-cwd-'));
  const dir = join(home, 'sessions', sessionDirName(cwd));
  mkdirSync(dir, { recursive: true });
  const realFile = join(dir, '2026-09-20T05-14-07-064Z_01a0bd3c-6557-746b-adf6-5128f2326c57.jsonl');
  writeFileSync(realFile, '{}\n');
  const poisoned = join(cwd, 'stale-01a0bd34.jsonl');
  writeFileSync(poisoned, '{}\n');
  const pi = fakePi();
  const h: Harness = { closePaneCalls: [], waitAgentCalls: [], prompts: [] };
  const surface = new PiSurface(pi as unknown as object);
  const root = new Context();
  const deps = {
    client: fakeClient(realFile, h),
    env: { paneId: 'p0', tabId: 't0', workspaceId: 'w1' },
    extPath: new URL('../src/index.ts', import.meta.url).pathname,
    sessionRoot: root,
    port: emptySubagentPortBox(),
    getSessionId: () => '99999999-9999-4999-8999-999999999999',
    reconcileOnSettlement: () => [],
    withReconcileNotes: (b: string) => b,
    claimSettleNotice: () => true,
    terminalState: { activePaneIds: () => new Set<string>() },
  };
  root.provide('pi-herdr.surface', surface);
  root.provide('pi-herdr.subagent-deps', deps);
  await root.plugin(subagentPlugin);
  try {
    const entry: SubEntry = {
      taskId: '11111111-2222-4333-8444-555555555555',
      kind: 'task',
      paneId: 'p2',
      tabId: 't0',
      tabName: 'main',
      cwd,
      description: 'Investigate bug 19803',
      status: 'settled',
      background: true,
      sessionFile: poisoned, // 中毒：指向陈旧文件
      launchCommand: [],
      createdAt: Date.now() - 60_000,
      revivedFrom: null,
    };
    await fireSpawnEvents(pi, 'session_start', {}, { sessionManager: { getBranch: () => [
      { type: 'custom', customType: SUBS_CUSTOM_TYPE, data: { subs: [entry] } },
    ] } });
    deps.port.current!.applyReplySession('p2', '01a0bd3c-6557-746b-adf6-5128f2326c57'); // 裸 id
    const snap = pi.entries.filter(([t]) => t === SUBS_CUSTOM_TYPE).at(-1)?.[1] as { subs: SubEntry[] };
    const healed = snap.subs.find((s) => s.paneId === 'p2');
    assert.equal(healed?.sessionFile, realFile, '裸 id 自报必须映射为真实 transcript 路径并覆盖中毒值');
  } finally {
    await root.fiber.dispose();
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
  }
});

/** P0-2 回归（01a0bd3a aftermath）：master resume 后 running 子代理必须重新上哨并发结算通知。 */
test('session_start recovery：running 子代理重建 poller → 结算通知自动送达', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pier-recover-home-'));
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = home;
  const cwd = mkdtempSync(join(tmpdir(), 'pier-recover-cwd-'));
  const dir = join(home, 'sessions', sessionDirName(cwd));
  mkdirSync(dir, { recursive: true });
  const workerFile = join(dir, '2026-09-20T06-10-00-000Z_aaaa1111-2222-4333-8444-555555555555.jsonl');
  writeFileSync(workerFile, JSON.stringify({
    type: 'message',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'RECOVERED_REPORT: fix committed, 199 tests green' }],
      timestamp: Date.now(),
      stopReason: 'stop',
    },
  }) + '\n');
  const pi = fakePi();
  const h: Harness = { closePaneCalls: [], waitAgentCalls: [], prompts: [] };
  const notices: string[] = [];
  const surface = new PiSurface(pi as unknown as object);
  const root = new Context();
  const deps = {
    client: {
      ...fakeClient(workerFile, h),
      listPanes: async () => [{ paneId: 'pAlive', tabId: 't0', agentStatus: 'idle' }],
      listAgents: async () => [{ paneId: 'pAlive', status: 'idle', session: workerFile }],
    } as unknown as HerdrClientLike,
    env: { paneId: 'p0', tabId: 't0', workspaceId: 'w1' },
    extPath: new URL('../src/index.ts', import.meta.url).pathname,
    sessionRoot: root,
    port: emptySubagentPortBox(),
    getSessionId: () => 'bbbb2222-3333-4444-8555-666666666666',
    reconcileOnSettlement: () => [],
    withReconcileNotes: (b: string) => b,
    claimSettleNotice: () => true,
    terminalState: { activePaneIds: () => new Set<string>() },
    deliverNotice: async (content: string) => { notices.push(content); },
  };
  root.provide('pi-herdr.surface', surface);
  root.provide('pi-herdr.subagent-deps', deps);
  await root.plugin(subagentPlugin);
  try {
    const createdAt = Date.now() - 120_000;
    const entry: SubEntry = {
      taskId: 'cccc3333-4444-4555-8666-777777777777',
      kind: 'task',
      paneId: 'pAlive',
      tabId: 't0',
      tabName: 'main',
      cwd,
      description: 'Fix bugs in isolated worktree',
      background: true,
      status: 'running',
      sessionFile: null,
      launchCommand: [],
      createdAt,
      // The worker was idle long before the master restarted; an already-elapsed
      // observation window lets the recovered poller settle on its first tick.
      observationStartedAt: createdAt,
      revivedFrom: null,
    };
    await fireSpawnEvents(pi, 'session_start', {}, { sessionManager: { getBranch: () => [
      { type: 'custom', customType: SUBS_CUSTOM_TYPE, data: { subs: [entry] } },
    ] } });
    // Integration timing: the recovered poller runs on cordis-internal timers with no
    // exposed completion promise, so we poll its observable effect (deliverNotice) —
    // the seeded expired observation window keeps the settle within ~1 tick.
    for (let i = 0; i < 150 && !notices.some((n) => n.includes('closing message')); i++) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 200);
      await promise;
    }
    assert.ok(notices.some((n) => n.includes('settlement watch re-armed')), `恢复通知缺失: ${JSON.stringify(notices)}`);
    const settle = notices.find((n) => n.includes('closing message'));
    assert.ok(settle, `结算通知缺失: ${JSON.stringify(notices)}`);
    assert.match(settle!, /RECOVERED_REPORT/);
    const snap = pi.entries.filter(([t]) => t === SUBS_CUSTOM_TYPE).at(-1)?.[1] as { subs: SubEntry[] };
    assert.equal(snap.subs.find((s) => s.paneId === 'pAlive')?.status, 'consumed', 'ledger 状态收敛为 consumed');
  } finally {
    await root.fiber.dispose();
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
  }
});
