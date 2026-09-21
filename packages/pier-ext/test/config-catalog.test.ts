/**
 * D104 config catalog + `/pier-config` probe tests: the pure catalog (provenance, rendering, drift
 * guards against the JSON schema and the runtime env readers) and the command-side probe, which runs
 * against temp dirs and an injected env so the developer's real ~/.pi/agent and .pi-herdr are never read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONFIG_KNOBS, checkEnvKnobs, formatValue, readDotted, redactValue, renderCheck,
  renderIndex, renderPlane, renderReport, resolveConfigKnobs, resolveEnvKnobs, summarizePlane,
  type RawConfigLayers,
} from '../src/config-catalog-core.ts';
import { PIER_OPTIONS } from '../src/pier-options.ts';
import {
  CONFIG_GUIDANCE_PROMPT, collectConfigSnapshot, defaultHerdrPluginConfigDirs, guideReportMarkdown,
  renderGuide, type ConfigGuideDeps, type ConfigGuideSnapshot,
} from '../src/config-command.ts';
import { withCleanup, type CleanupContext } from './test-utils.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const knobsOfPlane = (plane: string): string[] => CONFIG_KNOBS.filter((k) => k.plane === plane).map((k) => k.key);
const planeReport = (snapshot: ConfigGuideSnapshot, plane: string) => snapshot.reports.find((r) => r.plane === plane)!;

/** Effective value + source of one knob, exactly as `show` reports it. */
const knobValue = (snapshot: ConfigGuideSnapshot, plane: string, key: string): string => {
  const entry = snapshot.entries.find((e) => e.knob.plane === plane && e.knob.key === key);
  return entry ? `${entry.value} [${entry.source}]` : '(unset)';
};

function schemaPropertyPaths(file: string): string[] {
  const schema = JSON.parse(readFileSync(join(repoRoot, 'packages', 'pier-ext', 'schemas', file), 'utf8'));
  const out: string[] = [];
  const walk = (node: Record<string, unknown>, prefix: string): void => {
    const props = node.properties as Record<string, unknown> | undefined;
    if (!props) return;
    for (const [key, value] of Object.entries(props)) {
      const path = prefix ? `${prefix}.${key}` : key;
      out.push(path);
      walk((value ?? {}) as Record<string, unknown>, path);
    }
  };
  walk(schema as Record<string, unknown>, '');
  return out;
}

/* ── drift guards ───────────────────────────────────────────────────────── */

test('drift guards: the catalog matches the JSON schema and the runtime env reads', () => {
  const schemaKeys = schemaPropertyPaths('efficiency-config.schema.json').filter(
    (k) => k !== 'version' && !/^onlineContextCompact$|^observationPack$|^evidencePreservingReducer$|^jev$/.test(k),
  );
  const catalog = new Set(knobsOfPlane('efficiency'));
  for (const key of schemaKeys) assert.equal(catalog.has(key), true, `schema key "${key}" is missing from the catalog`);
  // No stale entries: every catalog key must still exist in the schema.
  for (const key of catalog) assert.equal(schemaKeys.includes(key), true, `catalog key "${key}" no longer exists in the schema`);

  // Runtime env reads must be registered either as an option or as an efficiency knob.
  const sources = ['src/runtime-policy.ts', 'src/terminal-core.ts', 'src/todo-reminder-core.ts', 'src/efficiency-config-core.ts', 'src/config-command.ts']
    .map((rel) => readFileSync(join(repoRoot, 'packages', 'pier-ext', rel), 'utf8'))
    .join('\n');
  const found = new Set((sources.match(/\bPI(_HERDR)?_[A-Z0-9_]+\b/g) ?? []).filter((n) => !n.endsWith('_')));
  // Internal/pi-owned names that are not user configuration.
  const allowlist = new Set(['PI_HERDR_ROLE_MANIFEST', 'PI_HERDR_SUBAGENT', 'PI_SESSION_FILE', 'PI_SESSION_ID', 'PI_CODING_AGENT_DIR']);
  const registered = new Set(PIER_OPTIONS.flatMap((o) => [o.name, ...(o.legacy ? [o.legacy] : [])]));
  const efficiencyEnv = new Set(CONFIG_KNOBS.filter((k) => k.plane === 'efficiency' && k.envVar).map((k) => k.envVar!));
  for (const name of found) {
    if (allowlist.has(name)) continue;
    assert.equal(registered.has(name) || efficiencyEnv.has(name), true, `env var ${name} is read by the runtime but missing from the registry`);
  }
});

/* ── pure catalog ───────────────────────────────────────────────────────── */

test('readDotted walks parsed JSON layers and tolerates bad shapes', () => {
  const layer = { observationPack: { thresholdBytes: 20480 }, mode: 'x' };
  assert.equal(readDotted(layer, 'observationPack.thresholdBytes'), 20480); assert.equal(readDotted(layer, 'observationPack.missing'), undefined);
  assert.equal(readDotted(layer, 'mode.deeper'), undefined); assert.equal(readDotted(undefined, 'a.b'), undefined);
  assert.equal(readDotted([1, 2], '0'), undefined);
});

const LAYERS: RawConfigLayers = {
  env: { PI_HERDR_OBS_PACK_ENABLE: '1' },
  workspace: { observationPack: { thresholdBytes: 4096 }, evidencePreservingReducer: { enabled: true } },
  user: { observationPack: { thresholdBytes: 8192, fullSends: 5 } },
  workspaceTrusted: true,
};

/** [case, layers, [[knob, "value [source]"], …], note?] */
const KNOB_CASES: Array<{ name: string; layers: RawConfigLayers; expect: Array<[string, string]>; note?: RegExp }> = [
  {
    name: 'env > workspace > user > default, per knob', layers: LAYERS,
    expect: [
      ['observationPack.enabled', '1 [env]'], ['observationPack.thresholdBytes', '4096 [workspace]'],
      ['observationPack.fullSends', '5 [user]'], ['evidencePreservingReducer.localOnly', 'false [default]'],
    ],
  },
  {
    name: 'an untrusted workspace layer is ignored, not merged',
    layers: { ...LAYERS, workspaceTrusted: false },
    expect: [['observationPack.thresholdBytes', '8192 [user]']], note: /untrusted/,
  },
  {
    name: 'pi compaction.enabled=false disables an enabled OCC',
    layers: { env: {}, user: { onlineContextCompact: { enabled: true } }, piSettings: { enabled: false } },
    expect: [['onlineContextCompact.enabled', 'false [user]']], note: /compaction\.enabled=false/,
  },
  {
    name: 'an env force beats pi compaction.enabled=false',
    layers: { env: { PI_HERDR_COMPACT_ENABLE: '1' }, user: { onlineContextCompact: { enabled: true } }, piSettings: { enabled: false } },
    expect: [['onlineContextCompact.enabled', '1 [env]']],
  },
  {
    name: 'pi-owned knobs report source=pi', layers: { piSettings: { keepRecentTokens: 35000 } },
    expect: [['compaction.keepRecentTokens', '35000 [pi]']],
  },
];

test('resolveConfigKnobs: provenance and precedence matrix', async (t) => {
  for (const c of KNOB_CASES) {
    await t.test(c.name, () => {
      const resolved = resolveConfigKnobs(c.layers);
      for (const [key, expected] of c.expect) {
        const entry = resolved.find((r) => r.knob.key === key)!;
        assert.equal(`${entry.value} [${entry.source}]`, expected, key);
      }
      if (c.note) assert.match(resolved.find((r) => r.knob.key === c.expect[0]![0])!.note ?? '', c.note);
    });
  }
});

test('resolveEnvKnobs and checkEnvKnobs only touch registered option keys', () => {
  const env = { PIER_GC_TICK_MS: '5000', PI_HERDR_TERM_IDLE_MS: '0', PIER_SESSION_TTL_SECONDS: 'nope', SECRET_TOKEN: 'x' };
  const resolved = resolveEnvKnobs(env);
  assert.equal(resolved.length, PIER_OPTIONS.length);
  // B10: the legacy spelling supplies the value and the row says so; canonical wins when both are set.
  const idleViaAlias = resolved.find((r) => r.knob.key === 'PIER_TERM_IDLE_MS')!;
  assert.equal(idleViaAlias.value, '0'); assert.equal(idleViaAlias.via, 'PI_HERDR_TERM_IDLE_MS');
  const canonical = resolveEnvKnobs({ PIER_TERM_IDLE_MS: '5', PI_HERDR_TERM_IDLE_MS: '9' }).find((r) => r.knob.key === 'PIER_TERM_IDLE_MS')!;
  assert.equal(canonical.value, '5'); assert.equal(canonical.via, undefined);
  assert.equal(resolved.find((r) => r.knob.key === 'PIER_GC_TICK_MS')!.source, 'env');
  assert.equal(resolved.some((r) => r.knob.key === 'SECRET_TOKEN'), false, 'unknown env keys are never reported');
});

test('checkEnvKnobs flags only unparsable/out-of-range registered values', () => {
  const issues = checkEnvKnobs({ PIER_GC_TICK_MS: '30000', PIER_SESSION_TTL_SECONDS: 'nope', PI_HERDR_TERM_IDLE_MS: '0' });
  assert.equal(issues.length, 2, issues.join(' | ')); assert.ok(issues.some((i) => i.includes('PIER_SESSION_TTL_SECONDS')));
  assert.ok(issues.some((i) => i.includes('PI_HERDR_TERM_IDLE_MS'))); assert.deepEqual(checkEnvKnobs({ PIER_GC_TICK_MS: '30000' }), []);
});

test('secret-shaped keys are redacted and never rendered verbatim', () => {
  // Deliberately narrower than a bare `token` match: keepRecentTokens must stay readable.
  assert.equal(redactValue('compaction.keepRecentTokens', 35000), '35000'); assert.equal(redactValue('jev.apiKey', 'sk-live-123'), '***');
  assert.equal(redactValue('observationPack.fullSends', 2), '2'); assert.equal(formatValue(undefined), '(unset)');

  const entries = resolveConfigKnobs({ env: {}, user: { jev: { apiKey: 'sk-live' } } });
  assert.equal(entries.find((e) => e.knob.key === 'jev.apiKey')!.value, '***');
  const report = renderReport(entries, { generatedAt: 'now', cwd: '/w', workspaceTrusted: true });
  assert.match(report, /# pier config report/); assert.match(report, /Precedence: env > workspace \(trusted\) > user > default\./);
  assert.ok(!report.includes('sk-live'), 'the key never reaches the report');
});

test('renderers cover the five planes and stay compact', () => {
  const resolved = [...resolveConfigKnobs({ env: {}, user: { observationPack: { enabled: true } }, workspaceTrusted: false }), ...resolveEnvKnobs({})];
  const planeEntries = (id: string) => resolved.filter((r) => r.knob.plane === id);
  const index = renderIndex({
    efficiency: planeEntries('efficiency'), pi: planeEntries('pi'), env: planeEntries('env'),
    roleSummary: '2 role(s)', bootSummary: 'missing',
  });
  assert.match(index[0]!, /5 planes/); assert.ok(index.length <= 8, 'index stays a short summary');
  assert.ok(index.some((l) => l.includes('OCC off / OBS on / EPR off')));

  assert.ok(renderPlane(planeEntries('efficiency')).some((l) => l.includes('observationPack.enabled = true'))); assert.deepEqual(renderPlane([]), []);
  assert.equal(summarizePlane([]), 'all defaults');
  assert.equal(summarizePlane([{ knob: CONFIG_KNOBS[0]!, value: 'true', source: 'env' }]), '1 set (env 1)');

  const check = renderCheck([{ plane: 'env', ok: false, issues: ['bad value'] }, { plane: 'pi', ok: true, issues: [] }]);
  assert.ok(check.some((l) => l.includes('FAIL env'))); assert.ok(check.some((l) => l.includes('- bad value')));
  assert.ok(check.some((l) => l.includes('ok   pi')));
});

/* ── command-side probe ─────────────────────────────────────────────────── */

interface Fixture {
  base: string;
  deps: ConfigGuideDeps;
  paths: { cwd: string; agentDir: string; userConfigPath: string; workspaceConfigPath: string; herdrDir: string };
}

function makeFixture(cleanup: CleanupContext, opts: { brokenRole?: boolean; reservedRole?: boolean; trustWorkspace?: boolean } = {}): Fixture {
  const base = cleanup.tempDir('cfg-guide').path;
  const cwd = join(base, 'repo');
  const agentDir = join(base, 'agent');
  const herdrDir = join(base, 'herdr-plugin');
  const rolesDir = join(cwd, '.pi-herdr', 'roles');
  const userRolesDir = join(base, 'user-roles');
  const userConfigPath = join(base, 'user-efficiency.json');
  const workspaceConfigPath = join(cwd, '.pi-herdr', 'config.json');
  for (const dir of [userRolesDir, agentDir, herdrDir, rolesDir, join(cwd, '.pi')]) mkdirSync(dir, { recursive: true });

  // pi owns settings.json; OCC reads compaction.* only. The user config enables OCC (pi's
  // compaction.enabled=false wins unless env forces it); the workspace config enables OBS at 4096.
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ compaction: { enabled: false, keepRecentTokens: 35000 } }));
  writeFileSync(userConfigPath, JSON.stringify({ version: 1, onlineContextCompact: { enabled: true } }));
  writeFileSync(workspaceConfigPath, JSON.stringify({ version: 1, observationPack: { enabled: true, thresholdBytes: 4096 } }));
  // Real paths on disk: the boot plane verifies piNode/piCli/extPath exist.
  const bootPaths = { piNode: join(base, 'node'), piCli: join(base, 'cli.js'), extPath: join(base, 'ext.ts') };
  for (const target of Object.values(bootPaths)) writeFileSync(target, '');
  writeFileSync(join(herdrDir, 'boot-config.json'), JSON.stringify({ mainTabLabel: 'main', ...bootPaths }));
  const role = (role: string, version: string) => JSON.stringify({ role, version, manifest: { tools: ['read', 'todo_write', 'ask_user_question'], rules: {}, unknownTools: 'allow' } });
  writeFileSync(join(rolesDir, 'auditor.json'), role('auditor', '1.0.0'));
  if (opts.brokenRole) writeFileSync(join(rolesDir, 'broken.json'), JSON.stringify({ role: 'broken' }));
  if (opts.reservedRole) writeFileSync(join(rolesDir, 'master.json'), role('master', '9.9.9'));

  return {
    base,
    paths: { cwd, agentDir, userConfigPath, workspaceConfigPath, herdrDir },
    deps: {
      rolesUserDir: userRolesDir, cwd, env: { HERDR_PLUGIN_CONFIG_DIR: herdrDir },
      isProjectTrusted: opts.trustWorkspace ?? true, agentDir, userConfigPath, herdrPluginConfigDir: herdrDir, repoRoot: base,
    },
  };
}

test('collectConfigSnapshot: reports effective values, sources and per-plane checks', withCleanup((cleanup) => {
  const fx = makeFixture(cleanup);
  const snapshot = collectConfigSnapshot(fx.deps);

  // Workspace beats default; pi-disabled compaction overrides an explicitly enabled OCC.
  assert.equal(knobValue(snapshot, 'efficiency', 'observationPack.enabled'), 'true [workspace]');
  assert.equal(knobValue(snapshot, 'efficiency', 'observationPack.thresholdBytes'), '4096 [workspace]');
  assert.equal(knobValue(snapshot, 'efficiency', 'onlineContextCompact.enabled'), 'false [user]');
  assert.match(snapshot.entries.find((e) => e.knob.key === 'onlineContextCompact.enabled')!.note ?? '', /pi compaction\.enabled=false/);
  assert.equal(knobValue(snapshot, 'pi', 'compaction.keepRecentTokens'), '35000 [pi]');

  for (const plane of ['efficiency', 'boot', 'roles', 'env'] as const) {
    assert.equal(planeReport(snapshot, plane).ok, true, planeReport(snapshot, plane).issues.join(' | '));
  }
  assert.equal(snapshot.files.boot.find((f) => f.label === 'herdr plugin config-dir')!.exists, true); assert.equal(snapshot.bootSummary.includes('present'), true);
  assert.equal(snapshot.roleSummary, '3 role(s): workspace 1 / user 0 / builtin 2');

  assert.ok(renderGuide(snapshot, 'index').some((l) => l.includes('/pier-config show')));
  const efficiencyLines = renderGuide(snapshot, 'efficiency');
  assert.ok(efficiencyLines.some((l) => l.includes('observationPack.enabled = true')));
  assert.ok(efficiencyLines.some((l) => l.includes(fx.paths.workspaceConfigPath) && l.includes('present')), 'the plane names its source file');
  assert.ok(renderGuide(snapshot, 'check').some((l) => l.includes('all planes look consistent')));

  const report = guideReportMarkdown(snapshot, { generatedAt: '2026-09-13T00:00:00Z', cwd: fx.paths.cwd, piVersion: 'test' });
  assert.match(report, /# pier config report/); assert.match(report, /## Files observed/);
  assert.match(report, new RegExp(fx.paths.herdrDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}));

interface ProbeCase {
  name: string;
  fixture?: { brokenRole?: boolean; reservedRole?: boolean; trustWorkspace?: boolean };
  setup?: (fx: Fixture) => void;
  deps?: (fx: Fixture) => ConfigGuideDeps;
  /** [plane, issue substring, plane stays ok?] — a missing pi-owned file is reported, not an error. */
  expect: Array<[string, string, boolean?]>;
  extra?: (snapshot: ConfigGuideSnapshot, fx: Fixture) => void;
}

const PROBE_CASES: ProbeCase[] = [
  {
    name: 'untrusted workspace is ignored and marked',
    fixture: { trustWorkspace: false },
    expect: [['efficiency', 'not trusted']],
    extra: (s, fx) => {
      assert.equal(s.workspaceTrusted, false); assert.equal(knobValue(s, 'efficiency', 'observationPack.enabled'), 'false [default]', 'the workspace value must not apply');
      assert.ok(renderGuide(s, 'efficiency').some((l) => l.includes('IGNORED: untrusted project')));
    },
  },
  { name: 'broken workspace JSON is reported as invalid JSON', setup: (fx) => writeFileSync(fx.paths.workspaceConfigPath, '{ not json'), expect: [['efficiency', 'invalid JSON']] },
  { name: 'invalid and reserved roles are flagged', fixture: { brokenRole: true, reservedRole: true }, expect: [['roles', 'broken'], ['roles', 'master']] },
  {
    name: 'a stale boot-config path is reported as an issue',
    setup: (fx) => writeFileSync(
      join(fx.paths.herdrDir, 'boot-config.json'),
      JSON.stringify({ mainTabLabel: 'main', piNode: '/nonexistent/node', piCli: '/nonexistent/cli.js', extPath: '/nonexistent/ext.ts' }),
    ),
    expect: [['boot', 'does not exist'], ['boot', 'pier-setup']],
    extra: (s) => assert.equal(planeReport(s, 'boot').issues.filter((i) => i.includes('does not exist')).length, 3),
  },
  {
    name: 'missing boot-config and pi settings are reported, not thrown',
    deps: (fx) => ({
      ...fx.deps, env: {}, herdrPluginConfigDir: join(fx.base, 'nope'), repoRoot: join(fx.base, 'nope'), agentDir: join(fx.base, 'nope-agent'),
    }),
    expect: [['boot', 'not found'], ['pi', 'not found', true]],
    extra: (s) => {
      assert.equal(s.bootSummary, 'missing (run pier-setup)'); assert.ok(renderGuide(s, 'all').length > 5, 'a missing plane must not break rendering');
    },
  },
];

test('collectConfigSnapshot: every degraded input is reported on its plane', async (t) => {
  for (const c of PROBE_CASES) {
    await t.test(c.name, withCleanup((cleanup) => {
      const fx = makeFixture(cleanup, c.fixture ?? {});
      c.setup?.(fx);
      const snapshot = collectConfigSnapshot(c.deps?.(fx) ?? fx.deps);
      for (const [plane, substring, planeOk] of c.expect) {
        const report = planeReport(snapshot, plane);
        if (planeOk !== true) assert.equal(report.ok, false, `${plane}: ${report.issues.join(' | ')}`);
        assert.ok(report.issues.some((i) => i.includes(substring)), `${plane}: ${substring} (${report.issues.join('; ')})`);
      }
      c.extra?.(snapshot, fx);
    }));
  }
});

test('defaultHerdrPluginConfigDirs follows XDG and LOCALAPPDATA; the guidance prompt stays stable', () => {
  assert.deepEqual(defaultHerdrPluginConfigDirs({ XDG_CONFIG_HOME: '/xdg' }), [join('/xdg', 'herdr', 'plugins', 'config', 'pier.workbench')]);
  const win = defaultHerdrPluginConfigDirs({ XDG_CONFIG_HOME: '/xdg', LOCALAPPDATA: '/local' });
  assert.equal(win.length, 2); assert.equal(win[1], join('/local', 'herdr', 'plugins', 'config', 'pier.workbench'));
  const fallback = defaultHerdrPluginConfigDirs({});
  assert.equal(fallback.length, 1); assert.match(fallback[0]!, /herdr[/\\]plugins[/\\]config[/\\]pier\.workbench$/);

  assert.match(CONFIG_GUIDANCE_PROMPT, /^\[PIER-CONFIG\]/); assert.match(CONFIG_GUIDANCE_PROMPT, /\/pier-config show all/);
  assert.match(CONFIG_GUIDANCE_PROMPT, /Forbidden: dumping `process\.env`/); assert.match(CONFIG_GUIDANCE_PROMPT, /Change ONE plane at a time/);
});
