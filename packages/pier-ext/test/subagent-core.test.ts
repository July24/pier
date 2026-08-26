/**
 * subagent-core 纯逻辑单测（v1.1：交互式子 pane，rpc 遗产已删）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Semaphore,
  buildLaunchLine,
  buildLaunchParts,
  foldSubsRegistry,
  formatSubagentResult,
  makeProgressUpdate,
  psQuote,
  shQuote,
} from '../src/subagent-core.ts';

test('psQuote: 单引号翻倍转义', () => {
  assert.equal(psQuote("it's"), "'it''s'");
  assert.equal(psQuote('plain'), "'plain'");
});

test('shQuote: POSIX 单引号引出转义（\'\\\'\'）', () => {
  assert.equal(shQuote("it's"), `'it'\\''s'`);
  assert.equal(shQuote('plain'), "'plain'");
  assert.equal(shQuote('/a b/c d.ts'), `'/a b/c d.ts'`);
});

test('buildLaunchLine: win32=PowerShell & 语法，POSIX=sh 直启（platform 参数双分支）', () => {
  const parts = ['/usr/local/bin/node', '/opt/pi/dist/cli.js', '-e', '/ext/index.ts'];
  assert.equal(
    buildLaunchLine(parts, 'win32'),
    `& '/usr/local/bin/node' '/opt/pi/dist/cli.js' '-e' '/ext/index.ts'`,
  );
  assert.equal(
    buildLaunchLine(parts, 'darwin'),
    `'/usr/local/bin/node' '/opt/pi/dist/cli.js' '-e' '/ext/index.ts'`,
  );
  assert.equal(
    buildLaunchLine(parts, 'linux'),
    buildLaunchLine(parts, 'darwin'),
    '非 win32 全部走 sh 分支',
  );
  // 引号内特殊字符在两种语法下都保持单字面量
  assert.equal(
    buildLaunchLine(["it's a path"], 'darwin'),
    `'it'\\''s a path'`,
  );
  assert.equal(
    buildLaunchLine(["it's a path"], 'win32'),
    `& 'it''s a path'`,
  );
});

const RT = { nodePath: '/usr/local/bin/node', cliPath: '/opt/pi/dist/cli.js', extPath: '/ext/index.ts' };

test('buildLaunchParts: 默认 --tui-mode fullscreen（D97 静帧前提）；PI_HERDR_TUI=regular 逃生', () => {
  assert.deepEqual(
    buildLaunchParts(RT, {}, {}),
    ['/usr/local/bin/node', '/opt/pi/dist/cli.js', '-e', '/ext/index.ts', '--tui-mode', 'fullscreen'],
  );
  assert.deepEqual(
    buildLaunchParts(RT, {}, { PI_HERDR_TUI: 'regular' }),
    ['/usr/local/bin/node', '/opt/pi/dist/cli.js', '-e', '/ext/index.ts'],
  );
  // approve / roleModel / resume 全组合
  assert.deepEqual(
    buildLaunchParts(RT, { approve: true, roleModel: 'zai/glm-4.7', resumeFile: '/s.jsonl' }, {}),
    [
      '/usr/local/bin/node', '/opt/pi/dist/cli.js', '-a', '-e', '/ext/index.ts',
      '--tui-mode', 'fullscreen', '--provider', 'zai', '--model', 'glm-4.7', '--session', '/s.jsonl',
    ],
  );
});

const mk = (over: Record<string, unknown>) => ({
  taskId: 't1', kind: 'short', paneId: 'w1:p1', tabId: 'w1:t9', cwd: 'F:\\herdr-pi',
  description: 'task', background: true, status: 'running', sessionFile: null,
  launchCommand: ['x'], createdAt: 1, ...over,
});

test('foldSubsRegistry: last-wins 折叠 custom 条目（v2 形状）', () => {
  const entries = [
    { type: 'session' },
    { type: 'custom', customType: 'other', data: { x: 1 } },
    { type: 'custom', customType: 'pi-herdr.subs', data: { version: 2, subs: [mk({ paneId: 'w1:p1', status: 'settled' })] } },
    { type: 'custom', customType: 'pi-herdr.subs', data: { version: 2, subs: [mk({ paneId: 'w1:p2', status: 'consumed', kind: 'resident' })] } },
  ];
  const reg = foldSubsRegistry(entries as never);
  assert.equal(reg.version, 2);
  assert.equal(reg.subs.length, 1);
  assert.equal(reg.subs[0].paneId, 'w1:p2');
  assert.equal(reg.subs[0].status, 'consumed');
  assert.equal(reg.subs[0].kind, 'task');
});

test('foldSubsRegistry: 未知 role 名原样保留', () => {
  const entries = [
    { type: 'custom', customType: 'pi-herdr.subs', data: { version: 2, subs: [mk({ paneId: 'w1:p3', kind: 'advisor' })] } },
  ];
  const reg = foldSubsRegistry(entries as never);
  assert.equal(reg.subs[0].kind, 'advisor');
});

test('foldSubsRegistry: v1 条目迁移补齐（taskId=paneId、kind=task）', () => {
  const entries = [
    { type: 'custom', customType: 'pi-herdr.subs', data: { version: 1, subs: [{ paneId: 'w1:p9', description: 'old', background: true, status: 'settled', createdAt: 5 }] } },
  ];
  const reg = foldSubsRegistry(entries as never);
  assert.equal(reg.subs[0].taskId, 'w1:p9');
  assert.equal(reg.subs[0].kind, 'task');
  assert.equal(reg.subs[0].cwd, '');
  assert.deepEqual(reg.subs[0].launchCommand, []);
});

test('foldSubsRegistry: 无条目 → 空注册表', () => {
  const reg = foldSubsRegistry([{ type: 'session' }] as never);
  assert.deepEqual(reg, { version: 2, subs: [] });
});

test('foldSubsRegistry: D94 新字段正确读取（userTakeover + observationStartedAt + lastAgentStatus）', () => {
  const entries = [
    {
      type: 'custom',
      customType: 'pi-herdr.subs',
      data: {
        version: 2,
        subs: [
          mk({
            paneId: 'w1:p1',
            status: 'running',
            userTakeover: true,
            observationStartedAt: 1234567890,
            lastAgentStatus: 'working',
          }),
        ],
      },
    },
  ];
  const reg = foldSubsRegistry(entries as never);
  assert.equal(reg.subs[0].userTakeover, true);
  assert.equal(reg.subs[0].observationStartedAt, 1234567890);
  assert.equal(reg.subs[0].lastAgentStatus, 'working');
});

test('foldSubsRegistry: D94 字段缺失时正确补齐默认值（向后兼容旧条目）', () => {
  const entries = [
    {
      type: 'custom',
      customType: 'pi-herdr.subs',
      data: {
        version: 2,
        subs: [mk({ paneId: 'w1:p1', status: 'settled' })], // 无 D94 字段
      },
    },
  ];
  const reg = foldSubsRegistry(entries as never);
  assert.equal(reg.subs[0].userTakeover, undefined);
  assert.equal(reg.subs[0].observationStartedAt, null);
  assert.equal(reg.subs[0].lastAgentStatus, null);
});

test('makeProgressUpdate: 必须是 AgentToolResult 形状（pi 0.84.2 TUI 崩溃回归）', () => {
  // 回归背景：onUpdate 传字符串 → interactive TUI 展开 {0:'s',...} → getTextOutput
  // 读 undefined.filter → pi 整个退出（用户实测崩溃）。本测试锁死合法形状。
  const update = makeProgressUpdate('subagent running…');
  assert.ok(Array.isArray(update.content), 'content 必须是数组');
  assert.equal(update.content.length, 1);
  assert.equal(update.content[0].type, 'text');
  assert.equal(update.content[0].text, 'subagent running…');
  assert.equal(typeof update.details, 'object');
  // 模拟 TUI 的展开 + 渲染路径：必须存在 content 且可 filter
  const spread = { ...update, isError: false };
  const texts = spread.content.filter((c) => c.type === 'text');
  assert.equal(texts.length, 1);
});

test('Semaphore: cap 内直接放行、超出排队、释放补位', async () => {
  const sem = new Semaphore(2);
  const rel1 = await sem.acquire();
  const rel2 = await sem.acquire();
  assert.equal(sem.activeCount, 2);
  let got = false;
  let rel3: (() => void) | null = null;
  const p3 = sem.acquire().then((r) => {
    got = true;
    rel3 = r;
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(got, false, '第三个 acquire 必须在 cap 满时排队');
  rel1();
  await p3;
  assert.equal(got, true, '释放后队首立即补位');
  assert.equal(sem.activeCount, 2);
  rel2();
  assert.equal(sem.activeCount, 1);
  rel3!();
  assert.equal(sem.activeCount, 0);
  const rel4 = await sem.acquire();
  assert.equal(sem.activeCount, 1);
  rel4();
  assert.equal(sem.activeCount, 0);
});

test('Semaphore: 释放后可继续放行', async () => {
  const sem = new Semaphore(1);
  const r1 = await sem.acquire();
  let second = false;
  const p = sem.acquire().then(() => { second = true; });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(second, false);
  r1();
  await p;
  assert.equal(second, true);
});

test('formatSubagentResult: 五种结局（含 blocked 人类闸门）', () => {
  assert.equal(formatSubagentResult({ kind: 'completed', text: 'DONE' }, 't'), 'DONE');
  assert.equal(
    formatSubagentResult({ kind: 'completed', text: '' }, 't'),
    'Subagent finished but produced no output.',
  );
  const t = formatSubagentResult({ kind: 'timeout', text: 'partial' }, 't');
  assert.match(t, /timed out/);
  assert.match(t, /partial/);
  const b = formatSubagentResult({ kind: 'blocked', text: 'waiting' }, 't');
  assert.match(b, /blocked/);
  assert.match(b, /human decision/);
  const n = formatSubagentResult({ kind: 'no-output', text: '' }, 't');
  assert.match(n, /no readable output/);
  const s = formatSubagentResult({ kind: 'spawn-failed', text: 'boom' }, 't');
  assert.match(s, /boom/);
});
