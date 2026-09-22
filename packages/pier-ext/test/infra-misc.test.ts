/** Process-level infrastructure: DisposeLedger (HMR/D79), telemetry rows, storage layout, PIER_OPTIONS
 *  + RuntimePolicy, swallow/toolError bookkeeping, and the boot / installer guards. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createCordisApp, detectExposeInternals } from '../src/bootstrap.ts';
import { DisposeLedger } from '../src/ledger.ts';
import { createPlatformPaths } from '../src/platform-paths.ts';
import { PIER_OPTIONS, formatOptionRows, pierOption, pierOptionRows } from '../src/pier-options.ts';
import { createRuntimePolicy, type RuntimePolicy } from '../src/runtime-policy.ts';
import { planDenyHitRow, planSpawnProfileRow, scanRoleAxisUsage, taskFingerprint } from '../src/routing-telemetry.ts';
import {
  historyFilePath, historyFilePathLegacy, preferredHistoryFile, piCoreSessionDirName,
  piSessionDirCandidates, preferredSessionDir, sessionDirName, sessionDirNameLegacy,
} from '../src/storage-layout.ts';
import { SWALLOW_BUFFER_MAX, formatSwallowedErrors, resetSwallowedErrors, swallow, swallowedErrors } from '../src/swallow.ts';
import { POSIX_PROMPT, POWERSHELL_PROMPT, promptStrategyFor, terminalIdleMs, terminalReminderGraceMs } from '../src/terminal-core.ts';
import { ToolError, toolError } from '../src/tool-error.ts';
import { withCleanup, type CleanupContext } from './test-utils.ts';

/* ── DisposeLedger ──────────────────────────────────────────────────────── */

test('ledger: disposeKey only tears down matching keys (hmr compensation), others stay', () => {
  const led = new DisposeLedger(), ran: string[] = [];
  led.add('F:/x/src/a.ts', () => ran.push('a'));
  led.add('F:/x/src/b.ts', () => ran.push('b'));
  led.add('F:/x/src/a.ts', () => ran.push('a2'));
  assert.equal(led.disposeKey('F:\\x\\src\\a.ts'), 2, 'Windows path shape must hit too'); assert.deepEqual(ran.sort(), ['a', 'a2']);
  assert.equal(led.size, 1, 'b is kept');
});

test('ledger: disposeAll is LIFO (cordis effect order) and survives a throwing disposer', () => {
  const led = new DisposeLedger(), ran: string[] = [];
  led.add('a', () => ran.push('1'));
  led.add('b', () => { throw new Error('boom'); });
  led.add('c', () => ran.push('3'));
  assert.equal(led.disposeAll(), 3); assert.deepEqual(ran, ['3', '1'], 'LIFO, the throw is swallowed'); assert.equal(led.size, 0);
});

test('ledger: add returns an undo fn (self-disposing resource is not torn down twice)', () => {
  const led = new DisposeLedger();
  let disposed = 0;
  led.add('a', () => disposed++)();
  assert.equal(led.size, 0); assert.equal(led.disposeKey('a'), 0, 'undone entries never match'); assert.equal(disposed, 0);
});

test('ledger: keys are normalized (file:// URL vs path, backslashes, logical names)', () => {
  for (const [registered, lookup] of [
    [resolve('x.ts'), pathToFileURL(resolve('x.ts')).href], // import.meta.url vs hmr filename
    ['F:\\repo\\pier\\x.ts', 'F:/repo/pier/x.ts'], // Windows hmr filename shape
    ['pi-surface', 'pi-surface'], // D79 logical name, verbatim
  ] as const) {
    const led = new DisposeLedger(), ran: string[] = [];
    led.add(registered, () => ran.push('hit'));
    assert.equal(led.disposeKey(lookup), 1, `${registered} ↔ ${lookup}`); assert.deepEqual(ran, ['hit']);
  }
});

/* ── routing telemetry (docs/rfc-jev-role-routing.md §8) ────────────────── */

test('telemetry rows: task fingerprint, spawn profile (snapshot tool lists, no task text), deny hit', () => {
  const a = taskFingerprint('fix the login bug in auth.ts');
  assert.match(a, /^[0-9a-f]{8}$/); assert.equal(a, taskFingerprint('fix the login bug in auth.ts'), 'same task, same fingerprint (correlatable across spawns)');
  assert.notEqual(a, taskFingerprint('write unit tests for auth.ts'));

  const allowedTools = ['bash'];
  const row = planSpawnProfileRow({ now: 123, roleExplicit: false, role: 'worker-default', allowedTools, manifestTools: ['read', 'bash', 'todo_write'], task: 'secret task text' });
  assert.deepEqual(row, {
    kind: 'spawn', ts: 123, roleExplicit: false, role: 'worker-default', allowedTools: ['bash'],
    manifestTools: ['read', 'bash', 'todo_write'], taskSha8: taskFingerprint('secret task text'),
  });
  allowedTools.push('mutated');
  assert.deepEqual(row.allowedTools, ['bash'], 'the row holds a copy, not the caller array');
  assert.ok(!JSON.stringify(row).includes('secret task text'), 'privacy: task text never lands in the row');
  assert.deepEqual(planDenyHitRow({ now: 7, role: 'worker-default', tool: 'subagent' }), { kind: 'deny', ts: 7, role: 'worker-default', tool: 'subagent' });
});

const ROLE_A = JSON.stringify({ role: 'reviewer', manifest: { unknownTools: 'deny', rules: { '*': 'allow', edit: 'ask', write: 'deny' } } });
const ROLE_B = JSON.stringify({ role: 'worker-default', manifest: { unknownTools: 'allow', rules: { subagent: 'deny', terminal: 'deny', '*': 'allow' } } });

test('axis scan: minimal profiles parse, and ask/stance/explicit-deny counts are exact', () => {
  const minimal = scanRoleAxisUsage({
    now: 1,
    files: [
      { name: 'minimal.json', text: JSON.stringify({ role: 'fast-worker', manifest: { tools: ['read'] } }) },
      { name: 'no-manifest.json', text: JSON.stringify({ role: 'x' }) },
    ],
  });
  assert.equal(minimal.parsed, 1, 'omitted rules ≠ invalid'); assert.equal(minimal.invalid, 1, 'a missing manifest is what makes it invalid');
  assert.equal(minimal.stanceDeny, 1, 'unknownTools defaults to deny (schema contract)'); assert.equal(minimal.askEntries, 0);
  assert.deepEqual(minimal.explicitDenies, []);

  // A wildcard `*: deny` is a stance, not an explicit per-tool deny.
  const row = scanRoleAxisUsage({ now: 1, files: [{ name: 'a.json', text: ROLE_A }, { name: 'b.json', text: ROLE_B }] });
  assert.deepEqual(row, {
    kind: 'axis-usage', ts: 1, files: 2, parsed: 2, invalid: 0, askEntries: 1, stanceAllow: 1, stanceDeny: 1,
    explicitDenies: [['reviewer', 'write'], ['worker-default', 'subagent'], ['worker-default', 'terminal']],
  });
});

/* ── storage-layout / platform-paths ────────────────────────────────────── */

test('sessionDirName: percent-encoded separators (a/b ≠ a-b); legacy flattening kept for dual-read', () => {
  assert.equal(sessionDirName('a/b'), '--a%2Fb--'); assert.equal(sessionDirName('a-b'), '--a-b--');
  assert.notEqual(sessionDirName('a/b'), sessionDirName('a-b')); assert.equal(sessionDirName('F:\\herdr-pi'), '--F%3A%5Cherdr-pi--');
  assert.equal(sessionDirName('/home/u/proj'), '--%2Fhome%2Fu%2Fproj--'); assert.equal(sessionDirName('a%b/c'), '--a%25b%2Fc--');
  // The legacy flattening stays readable for dual-read migration.
  assert.equal(sessionDirNameLegacy('F:\\herdr-pi'), '--F--herdr-pi--'); assert.equal(sessionDirNameLegacy('/home/u/proj'), '---home-u-proj--');
  assert.equal(sessionDirNameLegacy('a/b'), sessionDirNameLegacy('a-b'));
});

test('historyFilePath/preferredHistoryFile: new encoding is canonical, an existing legacy ledger still wins', withCleanup((cleanup) => {
  assert.equal(historyFilePath('C:\\home\\.pi\\agent', 'F:\\herdr-pi'), join('C:\\home\\.pi\\agent', 'herdr-pi', 'history', '--F%3A%5Cherdr-pi--', 'history.jsonl'));
  const root = cleanup.tempDir('hist-mig').path;
  const cwd = 'F:\\herdr-pi';
  assert.equal(preferredHistoryFile(root, cwd), historyFilePath(root, cwd), 'neither exists → the new encoding');
  assert.equal(preferredSessionDir(root, 'a/b'), join(root, '--a%2Fb--'), 'same rule for session dirs');
  mkdirSync(dirname(historyFilePathLegacy(root, cwd)), { recursive: true });
  writeFileSync(historyFilePathLegacy(root, cwd), '{}\n');
  assert.equal(preferredHistoryFile(root, cwd), historyFilePathLegacy(root, cwd), 'legacy is read until the new dir exists');
  mkdirSync(dirname(historyFilePath(root, cwd)), { recursive: true });
  writeFileSync(historyFilePath(root, cwd), '{}\n');
  assert.equal(preferredHistoryFile(root, cwd), historyFilePath(root, cwd), 'the new dir wins once it exists');
}));

test('piCoreSessionDirName/piSessionDirCandidates: byte-identical to pi core, pier encodings as fallback', () => {
  // pi core (dist/migrations.js:102): `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
  assert.equal(piCoreSessionDirName('/Users/yehaoyu/Documents/pier'), '--Users-yehaoyu-Documents-pier--');
  assert.equal(piCoreSessionDirName('F:\\herdr-pi'), '--F--herdr-pi--', 'a Windows drive has no leading separator');
  assert.equal(piCoreSessionDirName('/a%2Fb'), '--a%2Fb--', '`%` stays literal — why the old POSIX dirs all missed');
  assert.notEqual(piCoreSessionDirName('/home/u/proj'), sessionDirName('/home/u/proj'));
  assert.notEqual(piCoreSessionDirName('/home/u/proj'), sessionDirNameLegacy('/home/u/proj'));
  assert.deepEqual(piSessionDirCandidates('/home/u/proj'), ['--home-u-proj--', '--%2Fhome%2Fu%2Fproj--', '---home-u-proj--']);
  assert.deepEqual(piSessionDirCandidates('F:\\herdr-pi'), ['--F--herdr-pi--', '--F%3A%5Cherdr-pi--'], 'no duplicate on Windows');
});

test('createPlatformPaths: overrides win; sessionsDir defaults under agentDataDir', () => {
  const p = createPlatformPaths({ agentDataDir: '/x/agent', worktreeBaseDir: '/x/wt' });
  assert.equal(p.agentDataDir, '/x/agent'); assert.equal(p.worktreeBaseDir, '/x/wt'); assert.equal(p.sessionsDir, join('/x/agent', 'sessions'));
  assert.equal(createPlatformPaths({ agentDataDir: '/x/agent', sessionsDir: '/custom/sessions' }).sessionsDir, '/custom/sessions');
});

/* ── PIER_OPTIONS registry + RuntimePolicy ──────────────────────────────── */

const POLICY_FIELDS: ReadonlyArray<keyof RuntimePolicy> = [
  'subagentTimeoutMs', 'gcTickMs', 'pollIntervalMs', 'settlementWindowMs', 'observationWindowMs',
  'foregroundPatienceMs', 'sessionTtlSeconds', 'gitTimeoutMs', 'readinessTimeoutMs',
];

const OPTION_NAMES = PIER_OPTIONS.flatMap((o) => [o.name, o.legacy].filter((n): n is string => Boolean(n)));

/** Unsets every registry name first so the developer's own PIER_* exports cannot leak in. */
function applyEnv(cleanup: CleanupContext, env: Record<string, string | undefined>): void {
  const snap = cleanup.env();
  for (const name of OPTION_NAMES) snap.delete(name);
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) snap.delete(key);
    else snap.set(key, value);
  }
}

test('pierOption: canonical wins, legacy falls back, empty string counts as unset', () => {
  assert.equal(pierOption('PIER_GIT_TIMEOUT_MS', { PIER_GIT_TIMEOUT_MS: '5000' }), '5000');
  assert.equal(pierOption('PIER_GIT_TIMEOUT_MS', { PI_HERDR_GIT_TIMEOUT_MS: '7000' }), '7000');
  // `export X=` is common in shells; a blank canonical value must not shadow a usable legacy one.
  assert.equal(pierOption('PIER_GIT_TIMEOUT_MS', { PIER_GIT_TIMEOUT_MS: '  ', PI_HERDR_GIT_TIMEOUT_MS: '9' }), '9');
  assert.equal(pierOption('PIER_GIT_TIMEOUT_MS', {}), undefined);
  assert.equal(pierOption('NOT_AN_OPTION', { NOT_AN_OPTION: 'x' }), 'x', 'unregistered names are read verbatim');
});

test('pierOptionRows/formatOptionRows: env / env(legacy) / default provenance', () => {
  const slim = pierOptionRows({ PI_HERDR_SLIM_FRAME: '0' }).find((r) => r.name === 'PIER_SLIM_FRAME');
  assert.equal(slim?.value, '0'); assert.equal(slim?.source, 'legacy-env');
  const both = pierOptionRows({ PIER_SLIM_FRAME: '1', PI_HERDR_SLIM_FRAME: '0' }).find((r) => r.name === 'PIER_SLIM_FRAME');
  assert.equal(both?.source, 'env', 'canonical beats legacy'); assert.equal(formatOptionRows({}).length, PIER_OPTIONS.length);
  assert.match(formatOptionRows({})[0]!, /^\s+PIER_[A-Z_]+ = .+\(default\)/);
});

test('createRuntimePolicy: every field comes from the registry; overrides > env > fallback', withCleanup((cleanup) => {
  applyEnv(cleanup, {});
  const fromRegistry = createRuntimePolicy();
  assert.deepEqual(Object.keys(fromRegistry).sort(), [...POLICY_FIELDS].sort(), 'RuntimePolicy fields match the registry');
  for (const field of POLICY_FIELDS) {
    const spec = PIER_OPTIONS.find((o) => o.policy === field);
    assert.ok(spec, `${field} must be supplied by a PIER_OPTIONS entry`);
    assert.equal(fromRegistry[field], Number(spec.fallback), `${field} default = registry fallback`);
    assert.notEqual(spec.min, undefined, `${spec.name} needs a min bound`);
  }
  assert.equal(createRuntimePolicy({ gitTimeoutMs: 42, subagentTimeoutMs: 99 }).gitTimeoutMs, 42, 'overrides win');

  applyEnv(cleanup, { PIER_GIT_TIMEOUT_MS: '2500', PI_HERDR_SUBAGENT_TIMEOUT_MS: '8000' });
  const p = createRuntimePolicy();
  assert.equal(p.gitTimeoutMs, 2500, 'canonical env applies'); assert.equal(p.subagentTimeoutMs, 8000, 'legacy name applies too');
  assert.equal(createRuntimePolicy({ gitTimeoutMs: 42 }).gitTimeoutMs, 42, 'override beats env');
}));

test('createRuntimePolicy: an invalid/out-of-range value warns once and falls back', withCleanup((cleanup) => {
  applyEnv(cleanup, { PIER_GIT_TIMEOUT_MS: 'nope', PIER_SUBAGENT_TIMEOUT_MS: '-1' });
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (message?: unknown) => { warnings.push(String(message)); };
  try {
    const p = createRuntimePolicy();
    assert.equal(p.gitTimeoutMs, 10_000); assert.equal(p.subagentTimeoutMs, 600_000);
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(warnings, ['Invalid PIER_GIT_TIMEOUT_MS="nope", using default 10000', 'Invalid PIER_SUBAGENT_TIMEOUT_MS="-1", using default 600000']);
  // A14: concurrent isolated workers routinely take longer than 30s to boot.
  assert.equal(createRuntimePolicy().readinessTimeoutMs, 90_000);
}));

test('registry: legacy spellings still reach the real readers', withCleanup((cleanup) => {
  applyEnv(cleanup, { PI_HERDR_TERM_IDLE_MS: '1234', PIER_TERM_GRACE_MS: '4321' });
  assert.equal(terminalIdleMs(), 1234, 'legacy name works'); assert.equal(terminalReminderGraceMs(), 4321, 'canonical name works');
  assert.equal(promptStrategyFor({ PI_HERDR_TERMINAL_PROMPT: 'powershell' }), POWERSHELL_PROMPT, 'legacy prompt name');
  assert.equal(promptStrategyFor({ PIER_TERMINAL_PROMPT: 'bash' }), POSIX_PROMPT);
}));

test('registry self-consistency: canonical PIER_*, legacy PI_HERDR_*, integer fallbacks', () => {
  for (const spec of PIER_OPTIONS) {
    assert.match(spec.name, /^PIER_/, `${spec.name} is the canonical name`);
    if (spec.legacy) assert.match(spec.legacy, /^PI_HERDR_/, `${spec.legacy} is the legacy shape`);
    if (spec.min !== undefined) assert.match(spec.fallback, /^\d+$/, `${spec.name} is an integer option`);
  }
  // Readers shipped before the rename must keep their alias — old shell exports cannot break.
  for (const name of ['PIER_TERM_IDLE_MS', 'PIER_TERM_GRACE_MS', 'PIER_TERM_READ_MAX', 'PIER_TODO_GRACE_MS', 'PIER_HMR']) {
    assert.ok(PIER_OPTIONS.find((o) => o.name === name)?.legacy?.startsWith('PI_HERDR_'), `${name} keeps its legacy alias`);
  }
});

/* ── swallow ────────────────────────────────────────────────────────────── */

test('swallow: records tag/cause/time instead of throwing (cleanup must continue)', () => {
  resetSwallowedErrors();
  assert.doesNotThrow(() => swallow('todo.persist-edit', new ReferenceError('persistEdit is not defined'), {}));
  const [entry] = swallowedErrors();
  assert.equal(entry!.tag, 'todo.persist-edit'); assert.match(entry!.message, /ReferenceError: persistEdit is not defined/); assert.ok(entry!.at > 0);
});

test('swallow: the ring buffer is bounded (no unbounded growth per session)', () => {
  resetSwallowedErrors();
  for (let i = 0; i < SWALLOW_BUFFER_MAX + 25; i += 1) swallow('t', new Error(`e${i}`), {});
  const entries = swallowedErrors();
  assert.equal(entries.length, SWALLOW_BUFFER_MAX); assert.match(entries[entries.length - 1]!.message, /e74$/, 'the newest entry is kept');
});

test('swallow: PIER_TRACE / legacy PI_HERDR_TRACE writes to stderr', () => {
  resetSwallowedErrors();
  const seen: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => { seen.push(args.map(String).join(' ')); };
  try {
    swallow('x.y', new Error('loud'), { PIER_TRACE: '1' });
    swallow('x.z', new Error('quiet'), {});
    swallow('x.w', new Error('legacy'), { PI_HERDR_TRACE: '1' });
  } finally {
    console.error = orig;
  }
  assert.equal(seen.length, 2); assert.match(seen[0]!, /swallowed x\.y: Error: loud/); assert.match(seen[1]!, /swallowed x\.w: Error: legacy/);
});

test('formatSwallowedErrors: explicit empty state, otherwise the last 10', () => {
  resetSwallowedErrors();
  assert.match(formatSwallowedErrors(), /none this session/);
  for (let i = 0; i < 12; i += 1) swallow(`tag${i}`, new Error(`m${i}`), {});
  const text = formatSwallowedErrors();
  assert.match(text, /swallowed errors: 12 this session \(last 10\)/); assert.match(text, /tag11: Error: m11/);
  assert.doesNotMatch(text, /tag1: Error: m1$/m, 'the oldest entries are dropped');
});

/* ── tool errors (A1) ───────────────────────────────────────────────────── */

// pi only flags a failed tool result when execute() throws; "Error: …" text in returned content is
// invisible to the model and to hooks keyed on event.isError. Guard the tool modules against it.
test('A1: tool modules never return a hard failure as text', () => {
  const offenders: string[] = [];
  for (const file of ['src/plugins/subagent.ts', 'src/plugins/terminal.ts', 'src/plugins/todo.ts', 'src/plugins/observation.ts']) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    src.split('\n').forEach((line, i) => {
      const code = line.trim();
      if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return;
      if (/content: \[\{ type: 'text', text: (`|')[^`']*Error:/.test(code)
        || /content: \[\{ type: 'text', text: (resolved\.error|launch\.text|isoGuard\.text)/.test(code)) {
        offenders.push(`${file}:${i + 1}: ${code.slice(0, 90)}`);
      }
    });
  }
  assert.deepEqual(offenders, [], `failures still returned as values (the model cannot see isError):\n${offenders.join('\n')}`);
});

test('A1: toolError drops the redundant "Error: " prefix and keeps the cause', () => {
  assert.throws(() => toolError('Error: boom'), (err: unknown) => { assert.ok(err instanceof ToolError); assert.equal((err as Error).message, 'boom');
    return true;
  });
  assert.throws(() => toolError('boom'), (err: unknown) => { assert.equal((err as Error).message, 'boom');
    return true;
  });
});

/* ── boot and installer guards: starting pier outside a dev checkout ─────── */
// Production must not loader.create() .ts files unless HMR is active (Node cannot strip types under
// node_modules; the loader path exists for dev HMR only), and the installer CLI must stay runnable
// from an npx cache (no repo checkout).
const root = fileURLToPath(new URL('../../../', import.meta.url));
const master = readFileSync(fileURLToPath(new URL('../src/index-master.ts', import.meta.url)), 'utf8');

test('bootstrap: Loader mounts, hmr stays off, dispose runs the shutdown hook', async () => {
  let disposed = false;
  const app = await createCordisApp({ onDispose: () => { disposed = true; } });
  assert.equal(app.loaderReady, true);
  const withLoader = app.root as unknown as { loader?: { builtins: Record<string, unknown> } };
  assert.ok(withLoader.loader, 'the loader service is on the tree'); assert.ok(withLoader.loader.builtins.group, 'the cordis:group builtin is registered (D80③)');
  assert.equal(app.hmrActive, false, 'no --expose-internals + PI_HERDR_HMR → hmr is not mounted (zero watchers)');
  assert.equal(typeof detectExposeInternals(), 'boolean');
  assert.equal(detectExposeInternals(), process.execArgv.includes('--expose-internals'), 'the flag is read from the current execArgv');
  await app.root.fiber.dispose();
  assert.equal(disposed, true, 'onDispose runs on tree teardown (session_shutdown path)');
});

test('production mount uses loader.create only when HMR is active', () => {
  assert.match(master, /loaderReady && cordisApp\.hmrActive/); assert.match(master, /loadEntry\(sessionRoot, useLoader,/);
});

test('prepare links node_modules/.bin/pier-setup so in-repo npx finds the CLI', () => {
  const r = spawnSync(process.execPath, [join(root, 'install.mjs'), '--prepare'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout); assert.ok(existsSync(join(root, 'node_modules', '.bin', 'pier-setup')));
});

test('installer CLI: version --json and --help', () => {
  const cli = join(root, 'install.mjs');
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr); assert.match(help.stdout, /pier-setup version/);
  assert.match(help.stdout, /pier-setup update/);
  const ver = spawnSync(process.execPath, [cli, 'version', '--json'], { encoding: 'utf8' });
  assert.equal(ver.status, 0, ver.stderr);
  const data = JSON.parse(ver.stdout);
  assert.equal(data.installer.name, 'pier-setup'); assert.ok(data.installer.version);
  assert.ok('piExt' in data && 'herdr' in data && 'latest' in data);
});

/* The npx cache `npx pier-setup` runs from holds install.mjs + package.json and never
 * packages/pier-ext. The guards below replay a real CLI run against exactly that layout with
 * pi / herdr / npm faked at the process boundary, so the contract is observed through the
 * installer's effects (exit code, the commands it shells out to, boot-config.json) instead of
 * being locked to the installer's source text. */

/** Fake CLI on PATH: records its argv in the call log, then decides its own stdout / exit code. */
function fakeCli(name: string, dirs: { bin: string; fake: string; log: string }, decide: string): void {
  const script = join(dirs.fake, `${name}.cjs`);
  writeFileSync(script, [
    "const { appendFileSync } = require('node:fs');",
    'const args = process.argv.slice(2);',
    `appendFileSync(${JSON.stringify(dirs.log)}, JSON.stringify([${JSON.stringify(name)}, ...args]) + '\\n');`,
    decide,
  ].join('\n') + '\n');
  if (process.platform === 'win32') {
    // npm global bins are .cmd shims on win32; the installer already spawns them through cmd.exe.
    writeFileSync(join(dirs.bin, `${name}.cmd`), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  } else {
    const shim = join(dirs.bin, name);
    writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    chmodSync(shim, 0o755);
  }
}

interface NpxLayoutProbe {
  /** Copy of install.mjs, alone in a cache-shaped dir (install.mjs + package.json, no packages/). */
  installerDir: string;
  /** The pi-installed pi-pier entry user mode must resolve — never the cache path above. */
  extEntry: string;
  /** Where `herdr plugin config-dir` points, i.e. the user-mode boot-config destination. */
  bootConfig: string;
  /** Every command the installer shelled out to, in order. */
  calls(): string[][];
  run(...argv: string[]): { status: number | null; stdout: string; stderr: string };
}

/** PI_CODING_AGENT_DIR keeps the real ~/.pi out of the run; fakes keep networks out of it. */
function npxLayoutProbe(cleanup: CleanupContext): NpxLayoutProbe {
  const dir = cleanup.tempDir('pier-npx-').path;
  const installerDir = join(dir, 'installer');
  const agentDir = join(dir, 'pi-agent');
  const binDir = join(dir, 'bin');
  const fakeDir = join(dir, 'fakes');
  const logFile = join(dir, 'calls.jsonl');
  const configDir = join(dir, 'herdr-config');
  const globalModules = join(dir, 'global-node-modules');
  const piCli = join(globalModules, '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js');
  const extPkg = join(agentDir, 'npm', 'node_modules', 'pi-pier');
  const extEntry = join(extPkg, 'src', 'index.ts');

  for (const d of [installerDir, binDir, fakeDir, configDir, dirname(piCli), dirname(extEntry)]) mkdirSync(d, { recursive: true });
  copyFileSync(join(root, 'install.mjs'), join(installerDir, 'install.mjs'));
  writeFileSync(join(installerDir, 'package.json'), JSON.stringify({ name: 'pier-setup', version: '1.0.0' }));
  writeFileSync(join(extPkg, 'package.json'), JSON.stringify({ name: 'pi-pier', version: '1.0.0' }));
  writeFileSync(extEntry, 'export default {};\n');
  writeFileSync(piCli, ''); // the `npm root -g` fallback probePiRuntime needs to write any boot-config

  fakeCli('pi', { bin: binDir, fake: fakeDir, log: logFile }, "if (args[0] === '--version') console.log('0.90.1');");
  fakeCli('herdr', { bin: binDir, fake: fakeDir, log: logFile }, "if (args[0] === '--version') console.log('0.9.1');\n"
    + `if (args[0] === 'plugin' && args[1] === 'config-dir') console.log(${JSON.stringify(configDir)});`);
  fakeCli('npm', { bin: binDir, fake: fakeDir, log: logFile }, `console.log(args[0] === 'root' ? ${JSON.stringify(globalModules)} : '1.0.0');`);

  const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH'; // win32 spells it Path
  env[pathKey] = `${binDir}${delimiter}${env[pathKey] ?? ''}`;
  const cli = join(installerDir, 'install.mjs');

  return {
    installerDir, extEntry, bootConfig: join(configDir, 'boot-config.json'),
    calls: () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]) : []),
    run: (...argv) => spawnSync(process.execPath, [cli, ...argv], { encoding: 'utf8', env }),
  };
}

test('npx user-mode install never needs the repo layout: install.mjs alone resolves the pi-installed pi-pier', withCleanup((cleanup) => {
  const probe = npxLayoutProbe(cleanup);
  const r = probe.run('install');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.doesNotMatch(r.stderr, /pier-ext entry missing/, 'the repo-layout EXT_PATH check must fire for --dev only');
  const config = JSON.parse(readFileSync(probe.bootConfig, 'utf8')) as { extPath: string; mainTabLabel: string; hmrDev: boolean };
  assert.equal(config.extPath, probe.extEntry, 'boot-config points at the pi-installed pi-pier');
  assert.equal(config.mainTabLabel, 'main'); assert.equal(config.hmrDev, false);
  const calls = probe.calls();
  assert.ok(calls.some((c) => c.join(' ') === 'pi install npm:pi-pier'), `expected \`pi install npm:pi-pier\`, got ${JSON.stringify(calls)}`);
  assert.deepEqual(calls.filter((c) => c.some((a) => a.includes(probe.installerDir))), [], 'the npx cache path must never reach pi');
}));

test('dev-mode install still dies on a missing repo-layout EXT_PATH (the guard stays scoped to --dev)', withCleanup((cleanup) => {
  const probe = npxLayoutProbe(cleanup);
  const r = probe.run('install', '--dev');
  assert.equal(r.status, 1, r.stderr + r.stdout);
  assert.match(r.stderr, /pier-ext entry missing: .+ \(repo layout broken\?\)/);
}));

test('update refreshes the install in place: `pi update` runs and nothing is removed first', withCleanup((cleanup) => {
  const probe = npxLayoutProbe(cleanup);
  // Stale config from the previous release: update must rewrite it, not start from a clean slate.
  writeFileSync(probe.bootConfig, JSON.stringify({ mainTabLabel: 'stale', extPath: join(probe.installerDir, 'gone', 'index.ts') }));
  const r = probe.run('update');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const calls = probe.calls();
  assert.ok(calls.some((c) => c.join(' ') === 'pi update npm:pi-pier'), `expected \`pi update npm:pi-pier\`, got ${JSON.stringify(calls)}`);
  assert.deepEqual(calls.filter((c) => c.some((a) => a === 'remove' || a === 'uninstall')), [], 'update must not uninstall before updating');
  const config = JSON.parse(readFileSync(probe.bootConfig, 'utf8')) as { extPath: string; mainTabLabel: string };
  assert.equal(config.mainTabLabel, 'main', 'the stale boot-config was rewritten in place');
  assert.equal(config.extPath, probe.extEntry);
}));
