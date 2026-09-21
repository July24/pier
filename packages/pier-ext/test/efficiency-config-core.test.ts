/** D100-D103 efficiency configuration: fail-open validation, layer precedence, env overrides and the
 * pi-native settings handshake; per-field rejection is a table built from DEFAULT_EFFICIENCY_CONFIG. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEFAULT_EFFICIENCY_CONFIG, loadEfficiencyConfigFromDisk, loadPiNativeCompactionSettings,
  resolveEfficiencyConfig, validateEfficiencyConfig, type EfficiencyConfig,
} from '../src/efficiency-config-core.ts';
import { withCleanup, type CleanupContext } from './test-utils.ts';

const SECTIONS = ['onlineContextCompact', 'observationPack', 'evidencePreservingReducer', 'jev'] as const;
type Section = (typeof SECTIONS)[number];

const enabledOf = (config: EfficiencyConfig, section: Section): boolean => config[section].enabled;

/** Reads a section field by name (the table-driven loop walks defaults, so keys are dynamic). */
const sectionValue = (config: EfficiencyConfig, section: Section, key: string): unknown =>
  (config[section] as unknown as Record<string, unknown>)[key];

/** Every field the defaults declare, per section: [section, key, default value]. */
const DEFAULT_FIELDS = SECTIONS.flatMap((section) =>
  Object.entries(DEFAULT_EFFICIENCY_CONFIG[section]).map(([key, value]) => ({ section, key, value })),
);

const wrongTypeFor = (value: unknown): unknown =>
  typeof value === 'boolean' ? 'yes' : typeof value === 'number' ? 'not-a-number' : value === 'auto' ? 'not-auto' : 42;

interface RejectionCase { name: string; section: Section; key: string; bad: unknown; expected: unknown }

/** Every default field rejects a wrong type; every numeric one also rejects a below-bound value. */
const REJECTION_CASES: RejectionCase[] = DEFAULT_FIELDS.flatMap(({ section, key, value }) => [
  { name: `${section}.${key} rejects a wrong type`, section, key, bad: wrongTypeFor(value), expected: value },
  ...(typeof value === 'number' ? [{ name: `${section}.${key} rejects a value below its bound`, section, key, bad: -1, expected: value }] : []),
]);

interface UnknownKeyCase { name: string; raw: Record<string, unknown>; issue: string; disabled: readonly Section[] }

const UNKNOWN_KEY_CASES: UnknownKeyCase[] = [
  {
    name: 'unknown top-level key disables every mechanism',
    raw: { version: 1, foo: 'bar', onlineContextCompact: { enabled: true }, observationPack: { enabled: true }, evidencePreservingReducer: { enabled: true }, jev: { enabled: true } },
    issue: '未知顶层配置项: "foo"', disabled: SECTIONS,
  },
  ...SECTIONS.map((section) => ({
    name: `unknown key inside ${section}`,
    raw: { version: 1, [section]: { bogus: 1 } },
    issue: `${section} 未知配置项: "bogus"`,
    disabled: [section],
  })),
];

/** Temp checkout + agent dir with pi's own settings.json written; `.pi/settings.json` only when given. */
async function piSettingsFixture(
  cleanup: CleanupContext, agent: unknown, project?: unknown,
): Promise<{ base: string; agentDir: string; projectDir: string }> {
  const base = cleanup.tempDir('pi-settings').path;
  const agentDir = join(base, 'agent');
  const projectDir = join(base, 'project');
  await mkdir(agentDir, { recursive: true }); await mkdir(join(projectDir, '.pi'), { recursive: true });
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify(agent));
  if (project !== undefined) await writeFile(join(projectDir, '.pi', 'settings.json'), JSON.stringify(project));
  return { base, agentDir, projectDir };
}

const PI_SETTINGS = { compaction: { enabled: false, keepRecentTokens: 35000 } };

test('validateEfficiencyConfig: field rejection matrix (wrong type / below bound) fails open', async (t) => {
  for (const c of REJECTION_CASES) {
    await t.test(c.name, () => {
      const res = validateEfficiencyConfig({ version: 1, [c.section]: { enabled: true, [c.key]: c.bad } });
      assert.equal(res.ok, false, `${c.section}.${c.key} must reject ${JSON.stringify(c.bad)}`);
      assert.ok(res.issues.some((i) => i.includes(`${c.section}.${c.key} 必须`)), `${c.section}.${c.key}: the issue must name the field (${res.issues.join('; ')})`);
      assert.equal(enabledOf(res.config, c.section), false, `${c.section}.${c.key}: a failed validation disables the section`);
      assert.equal(sectionValue(res.config, c.section, c.key), c.expected, `${c.section}.${c.key}: the rejected value is never written`);
    });
  }
});

test('validateEfficiencyConfig: version, upper bound and the ratio escape hatch', () => {
  assert.equal(validateEfficiencyConfig({ jev: { minConfidence: 1.5 } }).ok, false, 'max bound is enforced too');
  assert.equal(validateEfficiencyConfig({ version: 2 }).issues.some((i) => i.includes('version 必须是 1')), true);
  assert.equal(validateEfficiencyConfig({ version: 1, onlineContextCompact: { cacheWriteReadRatio: -5 } }).ok, false);
  assert.equal(validateEfficiencyConfig({ version: 1, onlineContextCompact: { cacheWriteReadRatio: 'auto' } }).ok, true);
});

test('validateEfficiencyConfig: empty object yields the on-disk defaults, a non-object disables everything', () => {
  const res = validateEfficiencyConfig({});
  assert.equal(res.ok, true); assert.deepEqual(res.issues, []); assert.deepEqual(res.config, DEFAULT_EFFICIENCY_CONFIG);
  assert.equal(res.config.jev.model, 'jev-1.13.0', 'pinned versioned id — an alias would drift silently');

  const notObject = validateEfficiencyConfig('not an object');
  assert.equal(notObject.ok, false); assert.match(notObject.issues[0]!, /必须是 JSON 对象/);
  for (const section of SECTIONS) assert.equal(enabledOf(notObject.config, section), false, section);
});

test('validateEfficiencyConfig: unknown keys are rejected (typo guard) and fail open', async (t) => {
  for (const c of UNKNOWN_KEY_CASES) {
    await t.test(c.name, () => {
      const res = validateEfficiencyConfig(c.raw);
      assert.equal(res.ok, false);
      assert.ok(res.issues.some((i) => i.includes(c.issue)), res.issues.join('; '));
      for (const section of c.disabled) assert.equal(enabledOf(res.config, section), false, `${section} must be disabled`);
    });
  }
});

test('validateEfficiencyConfig: a fully customized config passes and keeps every value', () => {
  const custom = {
    version: 1 as const,
    onlineContextCompact: { enabled: true, logEnabled: true, cacheWriteReadRatio: 12.5, keepRecentTokens: 30000, firstCompactionRequestScale: 2.5, subsequentCompactionMargin: 1.8 },
    observationPack: { enabled: true, logEnabled: true, thresholdBytes: 20480, fullSends: 3, recallChunkBytes: 32768, excerptBytes: 512 },
    evidencePreservingReducer: { enabled: true, logEnabled: true, model: 'cliproxy/gemini-3.8-flash-high', minBytes: 8192, maxChars: 500000, maxOutputTokens: 1024, timeoutMs: 4000, localOnly: true },
    jev: { enabled: true, logEnabled: true, baseUrl: 'https://relay.example/v1', model: 'jev-1.13.1', timeoutMs: 3000, minConfidence: 0.75, apiKey: 'k' },
  };
  const res = validateEfficiencyConfig(custom);
  assert.deepEqual(res.issues, []); assert.equal(res.ok, true);
  assert.deepEqual(res.config, custom, 'every supplied value survives validation');
});

test('validateEfficiencyConfig: optional strings clear on ""/null and reject whitespace', () => {
  const cleared = validateEfficiencyConfig({ version: 1, evidencePreservingReducer: { model: null }, jev: { baseUrl: '', apiKey: null } });
  assert.equal(cleared.ok, true); assert.equal(cleared.config.evidencePreservingReducer.model, undefined);
  assert.equal(cleared.config.jev.baseUrl, undefined); assert.equal(cleared.config.jev.apiKey, undefined);

  // Whitespace is neither "unset" nor a legal value.
  const blank = validateEfficiencyConfig({ version: 1, evidencePreservingReducer: { model: '   ' } });
  assert.equal(blank.ok, false); assert.ok(blank.issues.some((i) => i.includes('evidencePreservingReducer.model 必须是非空字符串')));
  // jev.model has no null escape hatch: a missing model id would silently fall back to an alias.
  assert.equal(validateEfficiencyConfig({ version: 1, jev: { model: null } }).ok, false);

  const trimmed = validateEfficiencyConfig({ version: 1, jev: { model: '  m/x  ', apiKey: ' k ' } });
  assert.equal(trimmed.config.jev.model, 'm/x'); assert.equal(trimmed.config.jev.apiKey, 'k');
});

test('validateEfficiencyConfig: section issues force enabled=false, clean sections stay untouched', () => {
  const res = validateEfficiencyConfig({
    version: 1,
    onlineContextCompact: { enabled: true, logEnabled: true },
    observationPack: { enabled: true, thresholBytes: 1024 }, // typo!
    evidencePreservingReducer: { enabled: true, timeoutMs: 100 }, // below the 500 bound
  });
  assert.equal(res.ok, false); assert.equal(res.config.observationPack.enabled, false);
  assert.equal(res.config.evidencePreservingReducer.enabled, false);
  assert.equal(res.config.onlineContextCompact.enabled, true); assert.equal(res.config.onlineContextCompact.logEnabled, true);
});

test('resolveEfficiencyConfig: the workspace layer replaces the user layer only when trusted', () => {
  const trusted = resolveEfficiencyConfig({
    userConfig: { version: 1, onlineContextCompact: { enabled: true, cacheWriteReadRatio: 10 } },
    workspaceConfig: { version: 1, onlineContextCompact: { enabled: false } },
    isProjectTrusted: true, env: {},
  });
  assert.equal(trusted.onlineContextCompact.enabled, false);

  const warnings: string[] = [];
  const untrusted = resolveEfficiencyConfig({
    userConfig: { version: 1, onlineContextCompact: { enabled: true } },
    workspaceConfig: { version: 1, onlineContextCompact: { enabled: false }, evidencePreservingReducer: { enabled: true, model: 'malicious/model' } },
    isProjectTrusted: false, env: {}, onWarning: (w) => warnings.push(w),
  });
  assert.equal(untrusted.onlineContextCompact.enabled, true, 'the user layer is used instead');
  assert.equal(untrusted.evidencePreservingReducer.enabled, false, 'the workspace layer is ignored wholesale');
  assert.ok(warnings.some((w) => w.includes('未被信任')));
});

test('resolveEfficiencyConfig: environment variables override file configs', () => {
  const resolved = resolveEfficiencyConfig({
    userConfig: { version: 1 },
    env: {
      PI_HERDR_COMPACT_ENABLE: '1', PI_HERDR_COMPACT_LOG: 'true', PI_HERDR_CACHE_RATIO: '15.5', PI_HERDR_OBS_PACK_ENABLE: '1', PI_HERDR_OBS_PACK_LOG: '1',
      PI_HERDR_REDUCER_ENABLE: '1', PI_HERDR_REDUCER_LOG: '1', PI_HERDR_REDUCER_MODEL: 'custom/fast-model',
    },
  });
  const { onlineContextCompact: occ, observationPack: obs, evidencePreservingReducer: epr } = resolved;
  assert.deepEqual({ enabled: occ.enabled, logEnabled: occ.logEnabled, cacheWriteReadRatio: occ.cacheWriteReadRatio }, { enabled: true, logEnabled: true, cacheWriteReadRatio: 15.5 });
  assert.deepEqual({ enabled: obs.enabled, logEnabled: obs.logEnabled }, { enabled: true, logEnabled: true });
  assert.deepEqual({ enabled: epr.enabled, logEnabled: epr.logEnabled, model: epr.model }, { enabled: true, logEnabled: true, model: 'custom/fast-model' });

  assert.equal(resolveEfficiencyConfig({ env: { PI_HERDR_CACHE_RATIO: 'auto' } }).onlineContextCompact.cacheWriteReadRatio, 'auto');
  // An override beats the file layer even when the file disables the section.
  assert.equal(resolveEfficiencyConfig({ userConfig: { version: 1, observationPack: { enabled: false } }, env: { PI_HERDR_OBS_PACK_ENABLE: '1' } }).observationPack.enabled, true);
});

test('resolveEfficiencyConfig: jev env keys outrank the config value, TYPESAFE_API_KEY only fills a hole', () => {
  const env = { PIER_JEV_ENABLE: '1', PIER_JEV_MODEL: 'jev-1.13.1', PIER_JEV_TIMEOUT_MS: '1500', PIER_JEV_MIN_CONFIDENCE: '0.8', PIER_JEV_API_KEY: 'pk' };
  const byEnv = resolveEfficiencyConfig({ env });
  const { enabled, model, timeoutMs, minConfidence, apiKey } = byEnv.jev;
  assert.deepEqual({ enabled, model, timeoutMs, minConfidence, apiKey }, { enabled: true, model: 'jev-1.13.1', timeoutMs: 1500, minConfidence: 0.8, apiKey: 'pk' });
  assert.equal(resolveEfficiencyConfig({ env: { PIER_JEV_ENABLE: '1', TYPESAFE_API_KEY: 'fk' } }).jev.apiKey, 'fk', 'SDK-convention env fills a missing key');
  assert.equal(resolveEfficiencyConfig({ env: { PIER_JEV_API_KEY: 'pk', TYPESAFE_API_KEY: 'fk' } }).jev.apiKey, 'pk', 'pier env wins over the foreign convention');

  const byConfig = resolveEfficiencyConfig({ userConfig: { jev: { apiKey: 'ck' } }, env: {} });
  assert.equal(byConfig.jev.apiKey, 'ck'); assert.equal(byConfig.jev.enabled, false, 'key alone does not enable the layer');
  assert.equal(resolveEfficiencyConfig({ env: {} }).jev.apiKey, undefined);
});

test('resolveEfficiencyConfig: invalid env values warn and keep the previous value', () => {
  const warnings: string[] = [];
  const resolved = resolveEfficiencyConfig({
    userConfig: { version: 1, jev: { timeoutMs: 900, minConfidence: 0.4 }, onlineContextCompact: { cacheWriteReadRatio: 3 } },
    env: { PIER_JEV_TIMEOUT_MS: '100', PIER_JEV_MIN_CONFIDENCE: 'nope', PI_HERDR_CACHE_RATIO: 'fast' },
    onWarning: (w) => warnings.push(w),
  });
  assert.equal(resolved.jev.timeoutMs, 900); assert.equal(resolved.jev.minConfidence, 0.4);
  assert.equal(resolved.onlineContextCompact.cacheWriteReadRatio, 3);
  assert.equal(warnings.length, 3, warnings.join(' | '));
});

test('loadPiNativeCompactionSettings: missing paths are tolerated, project file gated on trust', withCleanup(async (cleanup) => {
  const missing = loadPiNativeCompactionSettings({ cwd: '/tmp/nonexistent-pier-test-dir', isProjectTrusted: false, agentDir: '/tmp/nonexistent-pier-agent-dir' });
  assert.deepEqual(missing, {});

  const { agentDir, projectDir } = await piSettingsFixture(cleanup, PI_SETTINGS, { compaction: { keepRecentTokens: 99999 } });
  const trusted = loadPiNativeCompactionSettings({ cwd: projectDir, isProjectTrusted: true, agentDir });
  assert.equal(trusted.enabled, false); assert.equal(trusted.keepRecentTokens, 99999, 'project settings win when the project is trusted');
  assert.equal(loadPiNativeCompactionSettings({ cwd: projectDir, isProjectTrusted: false, agentDir }).keepRecentTokens, 35000, 'untrusted project settings are ignored');
}));

test('loadEfficiencyConfigFromDisk: respects Pi native compaction settings and inheritance (A4)', withCleanup(async (cleanup) => {
  const { base, agentDir, projectDir } = await piSettingsFixture(cleanup, PI_SETTINGS);
  const configFile = join(projectDir, '.pi-herdr', 'config.json');
  await mkdir(join(projectDir, '.pi-herdr'), { recursive: true });
  // The efficiency config explicitly ENABLES OCC, so the assertions below are non-vacuous.
  await writeFile(configFile, JSON.stringify({ version: 1, onlineContextCompact: { enabled: true } }));

  const opts = { cwd: projectDir, isProjectTrusted: true, agentDir, userConfigPath: join(base, 'user-efficiency-config.json') };
  const config = loadEfficiencyConfigFromDisk({ ...opts, env: {} });
  assert.equal(config.onlineContextCompact.enabled, false, 'pi compaction.enabled=false disables an explicitly enabled OCC');
  assert.equal(config.onlineContextCompact.keepRecentTokens, 35000, 'inherits pi keepRecentTokens');
  // An env force wins over pi's disabled state.
  assert.equal(loadEfficiencyConfigFromDisk({ ...opts, env: { PI_HERDR_COMPACT_ENABLE: '1' } }).onlineContextCompact.enabled, true);

  // An explicit efficiency keepRecentTokens wins over pi's inherited value.
  await writeFile(configFile, JSON.stringify({ version: 1, onlineContextCompact: { enabled: true, keepRecentTokens: 12345 } }));
  assert.equal(loadEfficiencyConfigFromDisk({ ...opts, env: { PI_HERDR_COMPACT_ENABLE: '1' } }).onlineContextCompact.keepRecentTokens, 12345);
  // An untrusted project .pi/settings.json is ignored (the global 35000 wins).
  await writeFile(join(projectDir, '.pi', 'settings.json'), JSON.stringify({ compaction: { keepRecentTokens: 99999 } }));
  assert.equal(loadEfficiencyConfigFromDisk({ ...opts, isProjectTrusted: false, env: { PI_HERDR_COMPACT_ENABLE: '1' } }).onlineContextCompact.keepRecentTokens, 35000);
}));
