/**
 * subSessionState must tolerate herdr-reported session paths that do not
 * exist yet (session 01a055c5: spawn-failed on `null.length`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HerdrClientLike } from '../src/herdr-client.ts';
import { createSessionIo } from '../src/subagent-session-io.ts';
import { sessionDirName } from '../src/session-tail.ts';

function io(reported: string | null, sessionsDir: string, ownSession = '') {
  return createSessionIo({
    client: {
      getAgentSessionPath: async () => reported,
    } as unknown as HerdrClientLike,
    getSessionId: () => ownSession,
    sessionsDir: () => sessionsDir,
  });
}

test('subSessionState: missing reported jsonl is skipped (01a055c5 null.length)', async () => {
  const sessionsDir = mkdtempSync(join(tmpdir(), 'pier-session-io-'));
  const ghost = join(sessionsDir, 'not-created-yet.jsonl');
  const state = await io(ghost, sessionsDir).subSessionState('wC:p4', sessionsDir, Date.now());
  assert.deepEqual(state, { text: null, pendingTool: false, activity: false, turnEnded: false, compacting: false });
});

test('subSessionState: readable session after injectTs still settles', async () => {
  const sessionsDir = mkdtempSync(join(tmpdir(), 'pier-session-io-'));
  const file = join(sessionsDir, 'child.jsonl');
  const ts = 1_800_000_000_000;
  writeFileSync(file, JSON.stringify({
    type: 'message',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      timestamp: ts + 10,
      stopReason: 'stop',
    },
  }) + '\n');
  const state = await io(file, sessionsDir).subSessionState('wC:p4', sessionsDir, ts);
  assert.deepEqual(state, { text: 'ok', pendingTool: false, activity: true, turnEnded: true, compacting: false });
});


test('subSessionState (A16): toolResult 已写、下一条 assistant 未到时，回合未结束', async () => {
  const sessionsDir = mkdtempSync(join(tmpdir(), 'pier-session-io-'));
  const file = join(sessionsDir, 'child-midflight.jsonl');
  const ts = 1_800_000_000_000;
  const lines = [
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'task' }], timestamp: ts } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall' }], timestamp: ts + 10, stopReason: 'toolUse' } },
    { type: 'message', message: { role: 'toolResult', content: [{ type: 'text', text: 'ok' }], timestamp: ts + 20 } },
  ];
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const state = await io(file, sessionsDir).subSessionState('wC:p4', sessionsDir, ts);
  // activity=true 但 turnEnded=false —— 旧规则会在这里误判完工。
  assert.deepEqual(state, { text: null, pendingTool: false, activity: true, turnEnded: false, compacting: false });
});

test('subSessionState: 会话追加后必须重新推导（派生结果按 size/mtime 失效）', async () => {
  const sessionsDir = mkdtempSync(join(tmpdir(), 'pier-session-io-'));
  const file = join(sessionsDir, 'child-growing.jsonl');
  const ts = 1_800_000_000_000;
  writeFileSync(file, JSON.stringify({
    type: 'message',
    message: { role: 'assistant', content: [{ type: 'toolCall' }], timestamp: ts + 10, stopReason: 'toolUse' },
  }) + '\n');
  const session = io(file, sessionsDir);

  const mid = await session.subSessionState('wC:p4', sessionsDir, ts);
  assert.deepEqual(mid, { text: null, pendingTool: true, activity: true, turnEnded: false, compacting: false });

  // 追加收尾消息后，同一 sinceTs 必须看到新状态（缓存若失效会导致永久挂着 pendingTool）。
  writeFileSync(file, JSON.stringify({
    type: 'message',
    message: { role: 'assistant', content: [{ type: 'text', text: 'finished' }], timestamp: ts + 20, stopReason: 'stop' },
  }) + '\n', { flag: 'a' });
  const settled = await session.subSessionState('wC:p4', sessionsDir, ts);
  assert.deepEqual(settled, { text: 'finished', pendingTool: false, activity: true, turnEnded: true, compacting: false });
});

test('collectFinalText: 首次未读到收尾文本，追加后重试必须读到（缓存 null 也不能永久命中）', async () => {
  const sessionsDir = mkdtempSync(join(tmpdir(), 'pier-session-io-'));
  const file = join(sessionsDir, 'child-late-text.jsonl');
  const ts = 1_800_000_000_000;
  writeFileSync(file, JSON.stringify({
    type: 'message',
    message: { role: 'assistant', content: [{ type: 'toolCall' }], timestamp: ts + 10, stopReason: 'toolUse' },
  }) + '\n');
  const session = io(file, sessionsDir);

  assert.equal(await session.collectFinalText('wC:p4', sessionsDir, ts, 1), null);

  writeFileSync(file, JSON.stringify({
    type: 'message',
    message: { role: 'assistant', content: [{ type: 'text', text: 'late result' }], timestamp: ts + 30, stopReason: 'stop' },
  }) + '\n', { flag: 'a' });
  assert.equal(await session.collectFinalText('wC:p4', sessionsDir, ts, 1), 'late result');
});

test('probeAlive: pane.list unknown shell exists even when agent.list omits it', async () => {
  const sessionsDir = mkdtempSync(join(tmpdir(), 'pier-session-io-'));
  const session = createSessionIo({
    client: {
      getAgentSessionPath: async () => null,
      listPanes: async () => [{
        paneId: 'wH:p3',
        tabId: 'wH:t1',
        workspaceId: 'wH',
        agentStatus: 'unknown',
        foregroundCwd: '/tmp/work',
      }],
      listAgents: async () => [],
    } as unknown as HerdrClientLike,
    getSessionId: () => '',
    sessionsDir: () => sessionsDir,
  });
  const probe = await session.probeAlive('wH:p3', sessionsDir);
  assert.equal(probe.paneExists, true);
  assert.equal(probe.agentStatus, 'unknown');
  assert.equal(probe.foregroundCwd, '/tmp/work');
});

test('probeAlive: pane.list miss is death; agent.list cannot resurrect it', async () => {
  const sessionsDir = mkdtempSync(join(tmpdir(), 'pier-session-io-'));
  const session = createSessionIo({
    client: {
      getAgentSessionPath: async () => null,
      listPanes: async () => [],
      listAgents: async () => [{ paneId: 'wH:p3', status: 'working' }],
    } as unknown as HerdrClientLike,
    getSessionId: () => '',
    sessionsDir: () => sessionsDir,
  });
  const probe = await session.probeAlive('wH:p3', sessionsDir);
  assert.equal(probe.paneExists, false);
});

/**
 * 01a0bd3a 回归：spawn 竞速时（herdr 对新 pane 的上报滞后 / 上报了别的会话，
 * mtime 兜底又恒选中正在活跃写入的 master transcript），子 pane 的 sessionFile
 * 被归因成 master 自己的会话 → resume 认领了 master pane → GC 把 master 关掉。
 * 断言：无论哪一支产生候选，master 自己的会话与其他活 pane 已占用的会话绝不入选。
 */
test('resolveSessionFile (01a0bd3a): 兜底分支永不返回 master 自己的 transcript（裸 id 比较修复）', async () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'pier-session-io-own-'));
  const cwd = '/tmp/proj';
  const dir = join(agentDir, sessionDirName(cwd));
  mkdirSync(dir, { recursive: true });
  const master = join(dir, '2026-09-20T05-12-19-942Z_01a0bd3a-c2e5-7569-8d2c-aea4d82630cd.jsonl');
  const stale = join(dir, '2026-09-20T05-05-04-206Z_01a0bd34-1ccd-73e1-a93f-e57e7f124d49.jsonl');
  const sub = join(dir, '2026-09-20T05-21-01-111Z_11111111-2222-3333-4444-555555555555.jsonl');
  writeFileSync(master, '{}\n');
  writeFileSync(stale, '{}\n');
  writeFileSync(sub, '{}\n');
  // mtime：master 最新（活跃写入）——旧缺陷下兜底必中它
  utimesSync(sub, 1_000, 1_000);
  utimesSync(stale, 2_000, 2_000);
  utimesSync(master, 3_000, 3_000);

  const io = createSessionIo({
    client: {
      getAgentSessionPath: async () => null, // 上报滞后
      listAgents: async () => [],
    } as unknown as HerdrClientLike,
    getSessionId: () => '01a0bd3a-c2e5-7569-8d2c-aea4d82630cd',
    sessionsDir: () => agentDir,
  });
  const got = await io.resolveSessionFile('wA:p25', cwd);
  assert.equal(got, stale, 'master 自己的会话被排除，兜底落到下一个候选（旧缺陷返回 master 文件）');
});

test('resolveSessionFile (01a0bd3a): herdr 上报分支指向 master/他人会话时同样拒绝', async () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'pier-session-io-claim-'));
  const cwd = '/tmp/proj';
  const dir = join(agentDir, sessionDirName(cwd));
  mkdirSync(dir, { recursive: true });
  const master = join(dir, '2026-09-20T05-12-19-942Z_01a0bd3a-c2e5-7569-8d2c-aea4d82630cd.jsonl');
  const stale = join(dir, '2026-09-20T05-05-04-206Z_01a0bd34-1ccd-73e1-a93f-e57e7f124d49.jsonl');
  const sub = join(dir, '2026-09-20T05-21-01-111Z_11111111-2222-3333-4444-555555555555.jsonl');
  writeFileSync(master, '{}\n');
  writeFileSync(stale, '{}\n');
  writeFileSync(sub, '{}\n');
  utimesSync(sub, 1_000, 1_000);

  const io = createSessionIo({
    client: {
      // 上报分支直接把 master 的文件报给目标 pane（会话 01a0bd3a 里 p24 拿到 01a0bd34 即此类）
      getAgentSessionPath: async () => master,
      listAgents: async () => [
        { paneId: 'wA:p1F', status: 'idle', session: master },
        { paneId: 'wA:p24', status: 'idle', session: '01a0bd34-1ccd-73e1-a93f-e57e7f124d49' }, // 裸 id 上报
      ],
    } as unknown as HerdrClientLike,
    getSessionId: () => '01a0bd3a-c2e5-7569-8d2c-aea4d82630cd',
    sessionsDir: () => agentDir,
  });
  const got = await io.resolveSessionFile('wA:p25', cwd);
  assert.equal(got, sub, 'master 会话（own）与他人占用（含裸 id 上报）均排除，只剩真实子会话');
});

test('resolveSessionFile: 正常路径不受影响——上报即目标 pane 自己的会话时原样返回', async () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'pier-session-io-normal-'));
  const cwd = '/tmp/proj';
  const dir = join(agentDir, sessionDirName(cwd));
  mkdirSync(dir, { recursive: true });
  const sub = join(dir, '2026-09-20T05-21-01-111Z_11111111-2222-3333-4444-555555555555.jsonl');
  writeFileSync(sub, '{}\n');

  const io = createSessionIo({
    client: {
      getAgentSessionPath: async () => sub,
      listAgents: async () => [{ paneId: 'wA:p25', status: 'working', session: sub }],
    } as unknown as HerdrClientLike,
    getSessionId: () => '01a0bd3a-c2e5-7569-8d2c-aea4d82630cd',
    sessionsDir: () => agentDir,
  });
  assert.equal(await io.resolveSessionFile('wA:p25', cwd), sub);
});

test('resolveSessionFile (P0-1): preferred（pipe 自报/entry.sessionFile）优先于 herdr 上报', async () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'pier-session-io-pref-'));
  const cwd = '/tmp/proj';
  const dir = join(agentDir, sessionDirName(cwd));
  mkdirSync(dir, { recursive: true });
  const preferred = join(dir, '2026-09-20T05-14-07-064Z_01a0bd3c-6557-746b-adf6-5128f2326c57.jsonl');
  const reported = join(dir, '2026-09-20T05-05-04-206Z_01a0bd34-1ccd-73e1-a93f-e57e7f124d49.jsonl');
  writeFileSync(preferred, '{}\n');
  writeFileSync(reported, '{}\n');
  utimesSync(preferred, 1_000, 1_000);
  utimesSync(reported, 2_000, 2_000); // herdr 上报/兜底都会先于 preferred

  const io = createSessionIo({
    client: {
      getAgentSessionPath: async () => reported, // herdr 仍报错的文件（p24 场景）
      listAgents: async () => [],
    } as unknown as HerdrClientLike,
    getSessionId: () => '22222222-2222-3333-4444-555555555555',
    sessionsDir: () => agentDir,
  });
  assert.equal(await io.resolveSessionFile('wA:p24', cwd, preferred), preferred, 'preferred 必须先于上报候选');
  assert.equal(await io.resolveSessionFile('wA:p24', cwd), reported, '无 preferred 时维持旧行为');
});

test('readSettleTail (P0-1): 返回最佳候选的最后 assistant 文本尾巴（任意 stopReason）', async () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'pier-session-io-tail-'));
  const cwd = '/tmp/proj';
  const dir = join(agentDir, sessionDirName(cwd));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, '2026-09-20T05-30-00-000Z_33333333-3333-4444-5555-666666666666.jsonl');
  writeFileSync(file, JSON.stringify({
    type: 'message',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: '阶段性输出，未定稿'.repeat(200) }],
      timestamp: Date.now(),
      stopReason: 'toolUse',
    },
  }) + '\n');
  const io = createSessionIo({
    client: { getAgentSessionPath: async () => file, listAgents: async () => [] } as unknown as HerdrClientLike,
    getSessionId: () => '',
    sessionsDir: () => agentDir,
  });
  const tail = await io.readSettleTail('wA:p24', cwd);
  assert.ok(tail && tail.length <= 1200 && tail.includes('阶段性输出'), String(tail?.length));
});

test('reattributeStaleSessionFile (01a0c282): accepts a fresh foreign report, rejects own/taken sessions', async () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'pier-session-io-reattr-'));
  const mk = (name: string): string => {
    const file = join(agentDir, name);
    writeFileSync(file, '{}\n');
    return file;
  };
  const ownFile = mk('2026-09-21T06-00-00-000Z_11111111-1111-4111-8111-111111111111.jsonl');
  const takenFile = mk('2026-09-21T06-00-00-000Z_22222222-2222-4222-8222-222222222222.jsonl');
  const foreignFile = mk('2026-09-21T06-05-00-000Z_33333333-3333-4333-8333-333333333333.jsonl');
  const stalePreferred = mk('2026-09-16T07-15-46-751Z_44444444-4444-4444-8444-444444444444.jsonl');
  utimesSync(stalePreferred, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));

  const io = createSessionIo({
    client: {
      listAgents: async () => [
        // The target pane's lagging report points at the MASTER's own transcript (01a0bd3a).
        { paneId: 'wA:pStale', session: ownFile },
        // Another live pane has claimed takenFile.
        { paneId: 'wA:pOther', session: takenFile },
      ],
      getAgentSessionPath: async () => ownFile,
    } as unknown as HerdrClientLike,
    getSessionId: () => ownFile,
    sessionsDir: () => agentDir,
  });

  // Poisoned report (own transcript) must be rejected even though the file is fresh.
  assert.equal(await io.reattributeStaleSessionFile('wA:pStale', "/tmp/proj", Date.now(), stalePreferred), null);

  // A fresh foreign report that no other live pane claims is accepted; a stale preferred is kept when fresh.
  const io2 = createSessionIo({
    client: {
      listAgents: async () => [
        { paneId: 'wA:pStale', session: foreignFile },
        { paneId: 'wA:pOther', session: takenFile },
      ],
      getAgentSessionPath: async () => foreignFile,
    } as unknown as HerdrClientLike,
    getSessionId: () => ownFile,
    sessionsDir: () => agentDir,
  });
  assert.equal(await io2.reattributeStaleSessionFile('wA:pStale', "/tmp/proj", Date.now(), stalePreferred), foreignFile);
  assert.equal(await io2.reattributeStaleSessionFile('wA:pStale', "/tmp/proj", Date.now(), foreignFile), foreignFile, 'fresh preferred kept as-is');

  // 01a0bd3a class (advisor follow-up): a preferred pointing at the MASTER'S OWN transcript is
  // always fresh — the master writes it continuously — so freshness alone must not keep it.
  // Fall through to herdr's report and repair; null would mean "keep the poison".
  assert.equal(
    await io2.reattributeStaleSessionFile('wA:pStale', "/tmp/proj", Date.now(), ownFile),
    foreignFile,
    'poisoned-but-fresh preferred (own transcript) is repaired via the report',
  );
  assert.equal(
    await io2.reattributeStaleSessionFile('wA:pStale', "/tmp/proj", Date.now(), takenFile),
    foreignFile,
    'preferred held by another live pane is repaired via the report',
  );
});
