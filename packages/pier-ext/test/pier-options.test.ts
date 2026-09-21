/**
 * B10：环境变量命名。canonical 是 `PIER_*`，历史 `PI_HERDR_*` 作为别名继续可用；
 * `PI_HERDR_SUBAGENT`/`_ROLE_MANIFEST`/`_TUI`/`_META_KEY` 是父进程交给子进程的契约，不在此列。
 * 同时覆盖 runtime-policy：RuntimePolicy 的每个字段都由同一张 PIER_OPTIONS 表供给。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PIER_OPTIONS, formatOptionRows, pierOption, pierOptionRows } from '../src/pier-options.ts';
import { createRuntimePolicy, type RuntimePolicy } from '../src/runtime-policy.ts';
import {
  POSIX_PROMPT,
  POWERSHELL_PROMPT,
  promptStrategyFor,
  terminalIdleMs,
  terminalReminderGraceMs,
} from '../src/terminal-core.ts';

const POLICY_FIELDS: ReadonlyArray<keyof RuntimePolicy> = [
  'subagentTimeoutMs',
  'gcTickMs',
  'pollIntervalMs',
  'settlementWindowMs',
  'observationWindowMs',
  'foregroundPatienceMs',
  'sessionTtlSeconds',
  'gitTimeoutMs',
  'readinessTimeoutMs',
];

const OPTION_NAMES = PIER_OPTIONS.flatMap((o) => [o.name, o.legacy].filter((n): n is string => Boolean(n)));

/** Runs `fn` with the given process env applied; `undefined` unsets. Restored afterwards. */
function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const saved = new Map(OPTION_NAMES.map((name) => [name, process.env[name]]));
  for (const name of OPTION_NAMES) delete process.env[name];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('pierOption: canonical 优先，legacy 兜底，空串视为未设置', () => {
  assert.equal(pierOption('PIER_GIT_TIMEOUT_MS', { PIER_GIT_TIMEOUT_MS: '5000' }), '5000');
  assert.equal(pierOption('PIER_GIT_TIMEOUT_MS', { PI_HERDR_GIT_TIMEOUT_MS: '7000' }), '7000');
  // canonical 为空串时不算设置（shell 里 export X= 很常见），legacy 仍可救回
  assert.equal(pierOption('PIER_GIT_TIMEOUT_MS', { PIER_GIT_TIMEOUT_MS: '  ', PI_HERDR_GIT_TIMEOUT_MS: '9' }), '9');
  assert.equal(pierOption('PIER_GIT_TIMEOUT_MS', {}), undefined);
  // 目录外的名字按原名读（没有别名可回退）
  assert.equal(pierOption('NOT_AN_OPTION', { NOT_AN_OPTION: 'x' }), 'x');
});

test('pierOptionRows/formatOptionRows: 标出来源（env / env(legacy) / default）', () => {
  const rows = pierOptionRows({ PI_HERDR_SLIM_FRAME: '0' });
  const slim = rows.find((r) => r.name === 'PIER_SLIM_FRAME');
  assert.equal(slim?.value, '0');
  assert.equal(slim?.source, 'legacy-env');
  const rows2 = pierOptionRows({ PIER_SLIM_FRAME: '1', PI_HERDR_SLIM_FRAME: '0' });
  assert.equal(rows2.find((r) => r.name === 'PIER_SLIM_FRAME')?.source, 'env', 'canonical 压过 legacy');
  const lines = formatOptionRows({});
  assert.equal(lines.length, PIER_OPTIONS.length);
  assert.match(lines[0]!, /^\s+PIER_[A-Z_]+ = .+\(default\)/);
});

test('createRuntimePolicy: 每个字段都由目录供给；overrides > env > registry fallback', () => {
  withEnv({}, () => {
    const fromRegistry = createRuntimePolicy();
    assert.deepEqual(Object.keys(fromRegistry).sort(), [...POLICY_FIELDS].sort(), 'RuntimePolicy 字段与目录登记一致');
    for (const field of POLICY_FIELDS) {
      const spec = PIER_OPTIONS.find((o) => o.policy === field);
      assert.ok(spec, `${field} 必须由某个 PIER_OPTIONS 条目供给`);
      assert.equal(fromRegistry[field], Number(spec.fallback), `${field} 默认值 = 目录 fallback`);
      assert.equal(PIER_OPTIONS.find((o) => o.policy === field)!.min === undefined, false, `${spec.name} 必须有 min 边界`);
    }
    assert.equal(createRuntimePolicy({ gitTimeoutMs: 42, subagentTimeoutMs: 99 }).gitTimeoutMs, 42, 'overrides 优先');
  });

  withEnv({ PIER_GIT_TIMEOUT_MS: '2500', PI_HERDR_SUBAGENT_TIMEOUT_MS: '8000' }, () => {
    const p = createRuntimePolicy();
    assert.equal(p.gitTimeoutMs, 2500, 'canonical env 生效');
    assert.equal(p.subagentTimeoutMs, 8000, 'legacy 名同样生效');
    assert.equal(createRuntimePolicy({ gitTimeoutMs: 42 }).gitTimeoutMs, 42, 'override 压过 env');
  });
});

test('createRuntimePolicy: 非法/越界 env 告警一次并回落到目录默认值', () => {
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (message?: unknown) => { warnings.push(String(message)); };
  try {
    withEnv({ PIER_GIT_TIMEOUT_MS: 'nope', PIER_SUBAGENT_TIMEOUT_MS: '-1' }, () => {
      const p = createRuntimePolicy();
      assert.equal(p.gitTimeoutMs, 10_000);
      assert.equal(p.subagentTimeoutMs, 600_000);
    });
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(warnings, [
    'Invalid PIER_GIT_TIMEOUT_MS="nope", using default 10000',
    'Invalid PIER_SUBAGENT_TIMEOUT_MS="-1", using default 600000',
  ]);
  // A14: concurrent isolated workers routinely take longer than 30s to boot.
  assert.equal(createRuntimePolicy().readinessTimeoutMs, 90_000);
});

test('terminal prompt 读取点接受 legacy 前缀', () => {
  assert.equal(promptStrategyFor({ PI_HERDR_TERMINAL_PROMPT: 'powershell' }), POWERSHELL_PROMPT);
  assert.equal(promptStrategyFor({ PIER_TERMINAL_PROMPT: 'powershell', PI_HERDR_TERMINAL_PROMPT: 'bash' }), POWERSHELL_PROMPT);
  assert.equal(promptStrategyFor({ PIER_TERMINAL_PROMPT: 'bash' }), POSIX_PROMPT);
});

test('B10 收口：terminal/todo/slim-frame/HMR 的读取点都走 catalog（legacy 名仍生效）', () => {
  // 目录里必须登记这些键，且都带 legacy 别名（旧 shell 脚本不能失效）
  for (const name of ['PIER_TERM_IDLE_MS', 'PIER_TERM_GRACE_MS', 'PIER_TERM_READ_MAX', 'PIER_TODO_GRACE_MS', 'PIER_HMR']) {
    const spec = PIER_OPTIONS.find((o) => o.name === name);
    assert.ok(spec, `${name} 应在目录中`);
    assert.ok(spec!.legacy?.startsWith('PI_HERDR_'), `${name} 应保留 legacy 别名`);
  }
  withEnv({ PI_HERDR_TERM_IDLE_MS: '1234', PIER_TERM_GRACE_MS: '4321' }, () => {
    assert.equal(terminalIdleMs(), 1234, 'legacy 名生效');
    assert.equal(terminalReminderGraceMs(), 4321, 'canonical 名生效');
  });
});

test('B10 护栏：目录命名与数值格式自洽（canonical PIER_* / legacy PI_HERDR_* / 整数 fallback）', () => {
  for (const spec of PIER_OPTIONS) {
    assert.match(spec.name, /^PIER_/, `${spec.name} 应是 canonical 名`);
    if (spec.legacy) assert.match(spec.legacy, /^PI_HERDR_/, `${spec.legacy} 应是 legacy 名`);
    if (spec.min !== undefined) assert.match(spec.fallback, /^\d+$/, `${spec.name} 是整数选项，fallback 必须是数字`);
  }
});
