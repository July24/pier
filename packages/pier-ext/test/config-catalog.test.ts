/**
 * D104 config catalog + `/pier-config` probe tests.
 *
 * Two layers, one file: the pure catalog (provenance, rendering, drift guards against the JSON
 * schemas and the runtime env readers) and the command-side probe, which runs against temp
 * directories and an injected env so the developer's real ~/.pi/agent and .pi-herdr are never read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONFIG_KNOBS,
  CONFIG_PLANES,
  checkEnvKnobs,
  formatValue,
  readDotted,
  redactValue,
  renderCheck,
  renderIndex,
  renderPlane,
  renderReport,
  resolveConfigKnobs,
  resolveEnvKnobs,
  summarizePlane,
} from '../src/config-catalog-core.ts';
import { PIER_OPTIONS } from '../src/pier-options.ts';
import {
  CONFIG_GUIDANCE_PROMPT,
  collectConfigSnapshot,
  defaultHerdrPluginConfigDirs,
  guideReportMarkdown,
  renderGuide,
  type ConfigGuideDeps,
  type ConfigGuideSnapshot,
} from '../src/config-command.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');

const knobsOfPlane = (plane: string): string[] => CONFIG_KNOBS.filter((k) => k.plane === plane).map((k) => k.key);

/** Effective value + source of one knob, as `show` reports it. */
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

test('catalog covers every efficiency-config schema key (drift guard)', () => {
  const efficiencySchema = schemaPropertyPaths('efficiency-config.schema.json').filter(
    (k) => k !== 'version' && !/^onlineContextCompact$|^observationPack$|^evidencePreservingReducer$|^jev$/.test(k),
  );
  const efficiencyCatalog = new Set(knobsOfPlane('efficiency'));
  for (const key of efficiencySchema) {
    assert.equal(efficiencyCatalog.has(key), true, `schema key "${key}" is missing from the catalog`);
  }
  // No stale entries: every catalog key must still exist in the schema.
  for (const key of efficiencyCatalog) {
    assert.equal(efficiencySchema.includes(key), true, `catalog key "${key}" no longer exists in the schema`);
  }

});

test('every env name the runtime reads is registered in PIER_OPTIONS (drift guard)', () => {
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
  assert.equal(readDotted(layer, 'observationPack.thresholdBytes'), 20480);
  assert.equal(readDotted(layer, 'observationPack.missing'), undefined);
  assert.equal(readDotted(layer, 'mode.deeper'), undefined);
  assert.equal(readDotted(undefined, 'a.b'), undefined);
  assert.equal(readDotted([1, 2], '0'), undefined);
});

test('resolveConfigKnobs applies env > workspace > user > default and marks untrusted workspaces', () => {
  const layers = {
    env: { PI_HERDR_OBS_PACK_ENABLE: '1' },
    workspace: { observationPack: { thresholdBytes: 4096 }, evidencePreservingReducer: { enabled: true } },
    user: { observationPack: { thresholdBytes: 8192, fullSends: 5 } },
    workspaceTrusted: true,
  };
  const resolved = resolveConfigKnobs(layers);
  const get = (key: string) => resolved.find((r) => r.knob.key === key)!;

  assert.equal(get('observationPack.enabled').value, '1', 'env wins');
  assert.equal(get('observationPack.enabled').source, 'env');
  assert.equal(get('observationPack.thresholdBytes').value, '4096', 'workspace beats user');
  assert.equal(get('observationPack.thresholdBytes').source, 'workspace');
  assert.equal(get('observationPack.fullSends').value, '5', 'falls back to the user layer');
  assert.equal(get('observationPack.fullSends').source, 'user');
  assert.equal(get('evidencePreservingReducer.localOnly').value, 'false', 'default layer');
  assert.equal(get('evidencePreservingReducer.localOnly').source, 'default');

  const threshold = resolveConfigKnobs({ ...layers, workspaceTrusted: false })
    .find((r) => r.knob.key === 'observationPack.thresholdBytes')!;
  assert.equal(threshold.value, '8192', 'untrusted workspace value is ignored');
  assert.equal(threshold.source, 'user');
  assert.match(threshold.note ?? '', /untrusted/);
});

test('resolveConfigKnobs reports pi-disabled compaction as the effective OCC value', () => {
  const enabled = resolveConfigKnobs({
    env: {},
    user: { onlineContextCompact: { enabled: true } },
    piSettings: { enabled: false },
  }).find((r) => r.knob.key === 'onlineContextCompact.enabled')!;
  assert.equal(enabled.value, 'false');
  assert.match(enabled.note ?? '', /compaction\.enabled=false/);

  const forced = resolveConfigKnobs({
    env: { PI_HERDR_COMPACT_ENABLE: '1' },
    user: { onlineContextCompact: { enabled: true } },
    piSettings: { enabled: false },
  }).find((r) => r.knob.key === 'onlineContextCompact.enabled')!;
  assert.equal(forced.value, '1');
  assert.equal(forced.source, 'env');

  const piKnob = resolveConfigKnobs({ piSettings: { keepRecentTokens: 35000 } })
    .find((r) => r.knob.key === 'compaction.keepRecentTokens')!;
  assert.equal(piKnob.value, '35000');
  assert.equal(piKnob.source, 'pi');
});

test('resolveEnvKnobs and checkEnvKnobs only touch registered option keys', () => {
  const env = { PIER_GC_TICK_MS: '5000', PI_HERDR_TERM_IDLE_MS: '0', PIER_SESSION_TTL_SECONDS: 'nope', SECRET_TOKEN: 'x' };
  const resolved = resolveEnvKnobs(env);
  assert.equal(resolved.length, PIER_OPTIONS.length);
  // B10: legacy spelling supplies the value and the row says so; canonical wins when both are set.
  const idleViaAlias = resolved.find((r) => r.knob.key === 'PIER_TERM_IDLE_MS')!;
  assert.equal(idleViaAlias.value, '0');
  assert.equal(idleViaAlias.via, 'PI_HERDR_TERM_IDLE_MS');
  const canonicalWins = resolveEnvKnobs({ PIER_TERM_IDLE_MS: '5', PI_HERDR_TERM_IDLE_MS: '9' })
    .find((r) => r.knob.key === 'PIER_TERM_IDLE_MS')!;
  assert.equal(canonicalWins.value, '5');
  assert.equal(canonicalWins.via, undefined);
  assert.equal(resolved.find((r) => r.knob.key === 'PIER_GC_TICK_MS')!.source, 'env');
  assert.equal(resolved.some((r) => r.knob.key === 'SECRET_TOKEN'), false, 'unknown env keys are never reported');

  const issues = checkEnvKnobs(env);
  assert.equal(issues.length, 2, issues.join(' | '));
  assert.ok(issues.some((i) => i.includes('PIER_SESSION_TTL_SECONDS')));
  assert.ok(issues.some((i) => i.includes('PI_HERDR_TERM_IDLE_MS')));
  assert.deepEqual(checkEnvKnobs({ PIER_GC_TICK_MS: '30000' }), []);
});

test('secret-shaped keys are redacted and never rendered verbatim', () => {
  // Deliberately narrower than a bare `token` match: keepRecentTokens must stay readable.
  assert.equal(redactValue('compaction.keepRecentTokens', 35000), '35000');
  assert.equal(redactValue('jev.apiKey', 'sk-live-123'), '***');
  assert.equal(redactValue('observationPack.fullSends', 2), '2');
  assert.equal(formatValue(undefined), '(unset)');

  const entries = resolveConfigKnobs({ env: {}, user: { jev: { apiKey: 'sk-live' } } });
  assert.equal(entries.find((e) => e.knob.key === 'jev.apiKey')!.value, '***');
  const report = renderReport(entries, { generatedAt: 'now', cwd: '/w', workspaceTrusted: true });
  assert.match(report, /# pier config report/);
  assert.match(report, /Precedence: env > workspace \(trusted\) > user > default\./);
  assert.ok(!report.includes('sk-live'), 'the key never reaches the report');
});

test('renderers cover the five planes and stay compact', () => {
  const resolved = [
    ...resolveConfigKnobs({ env: {}, user: { observationPack: { enabled: true } }, workspaceTrusted: false }),
    ...resolveEnvKnobs({}),
  ];
  const planeEntries = (id: string) => resolved.filter((r) => r.knob.plane === id);
  const index = renderIndex({
    efficiency: planeEntries('efficiency'),
    pi: planeEntries('pi'),
    env: planeEntries('env'),
    roleSummary: '2 role(s)',
    bootSummary: 'missing',
  });
  assert.match(index[0]!, /5 planes/);
  assert.ok(index.length <= 8, 'index stays a short summary');
  assert.ok(index.some((l) => l.includes('OCC off / OBS on / EPR off')));

  const efficiencyLines = renderPlane(planeEntries('efficiency'));
  assert.ok(efficiencyLines.some((l) => l.includes('observationPack.enabled = true')));
  assert.deepEqual(renderPlane([]), []);

  assert.deepEqual(CONFIG_PLANES.map((p) => p.id), ['efficiency', 'roles', 'pi', 'boot', 'env']);
  assert.equal(summarizePlane([]), 'all defaults');
  assert.equal(summarizePlane([{ knob: CONFIG_KNOBS[0]!, value: 'true', source: 'env' }]), '1 set (env 1)');

  const check = renderCheck([{ plane: 'env', ok: false, issues: ['bad value'] }, { plane: 'pi', ok: true, issues: [] }]);
  assert.ok(check.some((l) => l.includes('FAIL env')));
  assert.ok(check.some((l) => l.includes('- bad value')));
  assert.ok(check.some((l) => l.includes('ok   pi')));
});

/* ── command-side probe ─────────────────────────────────────────────────── */

interface Fixture {
  base: string;
  deps: ConfigGuideDeps;
  paths: { cwd: string; agentDir: string; userConfigPath: string; workspaceConfigPath: string; herdrDir: string };
}

async function makeFixture(opts: { brokenRole?: boolean; reservedRole?: boolean; trustWorkspace?: boolean } = {}): Promise<Fixture> {
  const base = await mkdtemp(join(tmpdir(), 'pier-cfg-guide-'));
  const cwd = join(base, 'repo');
  const agentDir = join(base, 'agent');
  const herdrDir = join(base, 'herdr-plugin');
  const rolesDir = join(cwd, '.pi-herdr', 'roles');
  const userRolesDir = join(base, 'user-roles');
  const userConfigPath = join(base, 'user-efficiency.json');
  const workspaceConfigPath = join(cwd, '.pi-herdr', 'config.json');
  for (const dir of [userRolesDir, agentDir, herdrDir, rolesDir, join(cwd, '.pi')]) {
    await mkdir(dir, { recursive: true });
  }

  // pi owns this file; OCC reads compaction.* only.
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ compaction: { enabled: false, keepRecentTokens: 35000 } }));
  // user-level efficiency config enables OCC (but pi's compaction.enabled=false wins unless env forces it).
  await writeFile(userConfigPath, JSON.stringify({ version: 1, onlineContextCompact: { enabled: true } }));
  // workspace efficiency config enables OBS with a custom threshold.
  await writeFile(workspaceConfigPath, JSON.stringify({ version: 1, observationPack: { enabled: true, thresholdBytes: 4096 } }));
  // Real paths on disk: the boot plane verifies piNode/piCli/extPath exist.
  const bootPaths = { piNode: join(base, 'node'), piCli: join(base, 'cli.js'), extPath: join(base, 'ext.ts') };
  for (const target of Object.values(bootPaths)) await writeFile(target, '');
  await writeFile(join(herdrDir, 'boot-config.json'), JSON.stringify({ mainTabLabel: 'main', ...bootPaths }));
  const role = (name: string, version: string) => JSON.stringify({
    role: name,
    version,
    manifest: { tools: ['read', 'todo_write', 'ask_user_question'], rules: {}, unknownTools: 'allow' },
  });
  await writeFile(join(rolesDir, 'auditor.json'), role('auditor', '1.0.0'));
  if (opts.brokenRole) await writeFile(join(rolesDir, 'broken.json'), JSON.stringify({ role: 'broken' }));
  if (opts.reservedRole) await writeFile(join(rolesDir, 'master.json'), role('master', '9.9.9'));

  return {
    base,
    paths: { cwd, agentDir, userConfigPath, workspaceConfigPath, herdrDir },
    deps: {
      rolesUserDir: userRolesDir,
      cwd,
      env: { HERDR_PLUGIN_CONFIG_DIR: herdrDir },
      isProjectTrusted: opts.trustWorkspace ?? true,
      agentDir,
      userConfigPath,
      herdrPluginConfigDir: herdrDir,
      repoRoot: base,
    },
  };
}

test('collectConfigSnapshot: reports effective values, sources and per-plane checks', async () => {
  const fx = await makeFixture();
  try {
    const snapshot = collectConfigSnapshot(fx.deps);

    // workspace beats default; pi-disabled compaction overrides an explicitly enabled OCC.
    assert.equal(knobValue(snapshot, 'efficiency', 'observationPack.enabled'), 'true [workspace]');
    assert.equal(knobValue(snapshot, 'efficiency', 'observationPack.thresholdBytes'), '4096 [workspace]');
    assert.equal(knobValue(snapshot, 'efficiency', 'onlineContextCompact.enabled'), 'false [user]');
    assert.match(snapshot.entries.find((e) => e.knob.key === 'onlineContextCompact.enabled')!.note ?? '', /pi compaction\.enabled=false/);
    assert.equal(knobValue(snapshot, 'pi', 'compaction.keepRecentTokens'), '35000 [pi]');

    const byPlane = new Map(snapshot.reports.map((r) => [r.plane, r]));
    for (const plane of ['efficiency', 'boot', 'roles'] as const) {
      assert.equal(byPlane.get(plane)!.ok, true, byPlane.get(plane)!.issues.join(' | '));
    }
    assert.equal(snapshot.files.boot.find((f) => f.label === 'herdr plugin config-dir')!.exists, true);
    assert.equal(snapshot.bootSummary.includes('present'), true);
    assert.equal(snapshot.roleSummary, '3 role(s): workspace 1 / user 0 / builtin 2');

    assert.ok(renderGuide(snapshot, 'index').some((l) => l.includes('/pier-config show')));
    const efficiencyLines = renderGuide(snapshot, 'efficiency');
    assert.ok(efficiencyLines.some((l) => l.includes('observationPack.enabled = true')));
    assert.ok(efficiencyLines.some((l) => l.includes(fx.paths.workspaceConfigPath) && l.includes('present')));
    assert.ok(renderGuide(snapshot, 'check').some((l) => l.includes('all planes look consistent')));

    const report = guideReportMarkdown(snapshot, { generatedAt: '2026-09-13T00:00:00Z', cwd: fx.paths.cwd, piVersion: 'test' });
    assert.match(report, /# pier config report/);
    assert.match(report, /## Files observed/);
    assert.match(report, new RegExp(fx.paths.herdrDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    await rm(fx.base, { recursive: true, force: true });
  }
});

test('collectConfigSnapshot: untrusted workspace is ignored and marked', async () => {
  const fx = await makeFixture({ trustWorkspace: false });
  try {
    const snapshot = collectConfigSnapshot(fx.deps);
    assert.equal(snapshot.workspaceTrusted, false);
    assert.equal(knobValue(snapshot, 'efficiency', 'observationPack.enabled'), 'false [default]', 'workspace value must not apply');
    const efficiencyReport = snapshot.reports.find((r) => r.plane === 'efficiency')!;
    assert.equal(efficiencyReport.ok, false);
    assert.ok(efficiencyReport.issues.some((i) => i.includes('not trusted')));
    assert.ok(renderGuide(snapshot, 'efficiency').some((l) => l.includes('IGNORED: untrusted project')));
  } finally {
    await rm(fx.base, { recursive: true, force: true });
  }
});

test('collectConfigSnapshot: flags broken JSON, invalid roles and bad env values', async () => {
  const fx = await makeFixture({ brokenRole: true, reservedRole: true });
  try {
    await writeFile(fx.paths.workspaceConfigPath, '{ not json');
    const snapshot = collectConfigSnapshot({ ...fx.deps, env: { ...fx.deps.env, PIER_GC_TICK_MS: 'abc', PI_HERDR_TERM_IDLE_MS: '0' } });

    const efficiency = snapshot.reports.find((r) => r.plane === 'efficiency')!;
    assert.equal(efficiency.ok, false);
    assert.ok(efficiency.issues.some((i) => i.includes('invalid JSON')));

    const roles = snapshot.reports.find((r) => r.plane === 'roles')!;
    assert.equal(roles.ok, false);
    assert.ok(roles.issues.some((i) => i.includes('broken')));
    assert.ok(roles.issues.some((i) => i.includes('master')));

    const envReport = snapshot.reports.find((r) => r.plane === 'env')!;
    assert.equal(envReport.ok, false);
    assert.ok(envReport.issues.some((i) => i.includes('PIER_GC_TICK_MS')));
    assert.ok(envReport.issues.some((i) => i.includes('PI_HERDR_TERM_IDLE_MS')));

    const boot = snapshot.reports.find((r) => r.plane === 'boot')!;
    assert.equal(boot.ok, true, boot.issues.join(' | '));
  } finally {
    await rm(fx.base, { recursive: true, force: true });
  }
});

test('collectConfigSnapshot: a stale boot-config path is reported as an issue', async () => {
  const fx = await makeFixture();
  try {
    await writeFile(
      join(fx.paths.herdrDir, 'boot-config.json'),
      JSON.stringify({ mainTabLabel: 'main', piNode: '/nonexistent/node', piCli: '/nonexistent/cli.js', extPath: '/nonexistent/ext.ts' }),
    );
    const boot = collectConfigSnapshot(fx.deps).reports.find((r) => r.plane === 'boot')!;
    assert.equal(boot.ok, false);
    assert.equal(boot.issues.filter((i) => i.includes('does not exist')).length, 3);
    assert.ok(boot.issues.some((i) => i.includes('pier-setup')));
  } finally {
    await rm(fx.base, { recursive: true, force: true });
  }
});

test('collectConfigSnapshot: missing boot-config and missing pi settings are reported, not thrown', async () => {
  const fx = await makeFixture();
  try {
    const snapshot = collectConfigSnapshot({
      ...fx.deps,
      env: {},
      herdrPluginConfigDir: join(fx.base, 'nope'),
      repoRoot: join(fx.base, 'nope'),
      agentDir: join(fx.base, 'nope-agent'),
    });
    assert.equal(snapshot.bootSummary, 'missing (run pier-setup)');
    const boot = snapshot.reports.find((r) => r.plane === 'boot')!;
    assert.equal(boot.ok, false);
    assert.ok(boot.issues.some((i) => i.includes('not found')));
    assert.ok(snapshot.reports.find((r) => r.plane === 'pi')!.issues.some((i) => i.includes('not found')));
    // A missing plane must not break rendering.
    assert.ok(renderGuide(snapshot, 'all').length > 5);
  } finally {
    await rm(fx.base, { recursive: true, force: true });
  }
});

test('defaultHerdrPluginConfigDirs follows XDG and LOCALAPPDATA', () => {
  assert.deepEqual(defaultHerdrPluginConfigDirs({ XDG_CONFIG_HOME: '/xdg' }), [join('/xdg', 'herdr', 'plugins', 'config', 'pier.workbench')]);
  const win = defaultHerdrPluginConfigDirs({ XDG_CONFIG_HOME: '/xdg', LOCALAPPDATA: '/local' });
  assert.equal(win.length, 2);
  assert.equal(win[1], join('/local', 'herdr', 'plugins', 'config', 'pier.workbench'));
  const fallback = defaultHerdrPluginConfigDirs({});
  assert.equal(fallback.length, 1);
  assert.match(fallback[0]!, /herdr[/\\]plugins[/\\]config[/\\]pier\.workbench$/);
});

test('guidance prompt stays a stable instruction block', () => {
  assert.match(CONFIG_GUIDANCE_PROMPT, /^\[PIER-CONFIG\]/);
  assert.match(CONFIG_GUIDANCE_PROMPT, /\/pier-config show all/);
  assert.match(CONFIG_GUIDANCE_PROMPT, /Forbidden: dumping `process\.env`/);
  assert.match(CONFIG_GUIDANCE_PROMPT, /Change ONE plane at a time/);
});
