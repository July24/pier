/**
 * D100-D103 efficiency configuration tests: fail-open validation, layer precedence, env overrides
 * and the pi-native settings handshake. The per-field type/bound checks are table-driven off
 * DEFAULT_EFFICIENCY_CONFIG, so a new field is covered by adding it to the core.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_EFFICIENCY_CONFIG,
  loadEfficiencyConfigFromDisk,
  loadPiNativeCompactionSettings,
  resolveEfficiencyConfig,
  validateEfficiencyConfig,
  type EfficiencyConfig,
} from '../src/efficiency-config-core.ts';

const SECTIONS = ['onlineContextCompact', 'observationPack', 'evidencePreservingReducer', 'jev'] as const;
type Section = (typeof SECTIONS)[number];

/** Every field the defaults declare, per section: [section, key, default value]. */
const DEFAULT_FIELDS = SECTIONS.flatMap((section) =>
  Object.entries(DEFAULT_EFFICIENCY_CONFIG[section]).map(([key, value]) => ({ section, key, value })),
);

const enabledOf = (config: EfficiencyConfig, section: Section): boolean => config[section].enabled;

/** Reads a section field by name (the table-driven loops walk defaults, so keys are dynamic). */
const sectionValue = (config: EfficiencyConfig, section: Section, key: string): unknown =>
  (config[section] as unknown as Record<string, unknown>)[key];

test('validateEfficiencyConfig: empty object is valid and returns the defaults', () => {
  const res = validateEfficiencyConfig({});
  assert.equal(res.ok, true);
  assert.deepEqual(res.issues, []);
  assert.deepEqual(res.config, {
    version: 1,
    onlineContextCompact: { ...DEFAULT_EFFICIENCY_CONFIG.onlineContextCompact },
    observationPack: { ...DEFAULT_EFFICIENCY_CONFIG.observationPack },
    evidencePreservingReducer: { ...DEFAULT_EFFICIENCY_CONFIG.evidencePreservingReducer },
    jev: { ...DEFAULT_EFFICIENCY_CONFIG.jev },
  });
});

test('validateEfficiencyConfig: non-object disables every mechanism', () => {
  const res = validateEfficiencyConfig('not an object');
  assert.equal(res.ok, false);
  assert.match(res.issues[0]!, /必须是 JSON 对象/);
  for (const section of SECTIONS) assert.equal(enabledOf(res.config, section), false, section);
});

test('validateEfficiencyConfig: unknown top-level key is rejected and disables every mechanism', () => {
  const res = validateEfficiencyConfig({
    version: 1,
    foo: 'bar',
    onlineContextCompact: { enabled: true },
    observationPack: { enabled: true },
    evidencePreservingReducer: { enabled: true },
    jev: { enabled: true },
  });
  assert.equal(res.ok, false);
  assert.ok(res.issues.some((i) => i.includes('未知顶层配置项: "foo"')));
  for (const section of SECTIONS) assert.equal(enabledOf(res.config, section), false, `${section}: 顶层出错必须全关`);
});

test('validateEfficiencyConfig: unknown section keys are rejected (typo guard)', () => {
  const res = validateEfficiencyConfig({
    version: 1,
    onlineContextCompact: { unknownKey: 123 },
    observationPack: { extra: true },
    evidencePreservingReducer: { badProp: 'hello' },
    jev: { naughty: 1 },
  });
  assert.equal(res.ok, false);
  for (const [section, key] of [['onlineContextCompact', 'unknownKey'], ['observationPack', 'extra'], ['evidencePreservingReducer', 'badProp'], ['jev', 'naughty']]) {
    assert.ok(res.issues.some((i) => i.includes(`${section} 未知配置项: "${key}"`)), `${section}.${key}`);
  }
});

test('validateEfficiencyConfig: a fully customized config passes and keeps every value', () => {
  const res = validateEfficiencyConfig({
    version: 1,
    onlineContextCompact: { enabled: true, logEnabled: true, cacheWriteReadRatio: 12.5, firstCompactionRequestScale: 2.5, subsequentCompactionMargin: 1.8 },
    observationPack: { enabled: true, logEnabled: true, thresholdBytes: 20480, fullSends: 3, recallChunkBytes: 32768, excerptBytes: 512 },
    evidencePreservingReducer: { enabled: true, logEnabled: true, model: 'cliproxy/gemini-3.8-flash-high', minBytes: 8192, maxChars: 500000, maxOutputTokens: 1024, timeoutMs: 4000, localOnly: true },
    jev: { enabled: true, logEnabled: true, baseUrl: 'https://relay.example/v1', model: 'jev-1.13.1', timeoutMs: 3000, minConfidence: 0.75, apiKey: 'k' },
  });
  assert.deepEqual(res.issues, []);
  assert.equal(res.ok, true);
  assert.equal(res.config.onlineContextCompact.cacheWriteReadRatio, 12.5);
  assert.equal(res.config.observationPack.thresholdBytes, 20480);
  assert.equal(res.config.evidencePreservingReducer.model, 'cliproxy/gemini-3.8-flash-high');
  assert.equal(res.config.evidencePreservingReducer.localOnly, true);
  assert.equal(res.config.jev.baseUrl, 'https://relay.example/v1');
  assert.equal(res.config.jev.enabled, true);
});

test('validateEfficiencyConfig: every default field rejects a wrong-typed value and fails open', () => {
  for (const { section, key, value } of DEFAULT_FIELDS) {
    const wrongType = typeof value === 'boolean' ? 'yes' : typeof value === 'number' ? 'not-a-number' : value === 'auto' ? 'not-auto' : 42;
    const res = validateEfficiencyConfig({ version: 1, [section]: { enabled: true, [key]: wrongType } });
    assert.equal(res.ok, false, `${section}.${key} 应拒绝 ${JSON.stringify(wrongType)}`);
    assert.ok(res.issues.some((i) => i.includes(`${section}.${key} 必须`)), `${section}.${key}：issue 应指出该字段（${res.issues.join('; ')}）`);
    assert.equal(enabledOf(res.config, section), false, `${section}.${key}：校验失败必须把该段 enabled 关掉`);
    if (typeof value === 'boolean') assert.equal(sectionValue(res.config, section, key), value, `${section}.${key}：非法值不写入，保留默认`);
  }
});

test('validateEfficiencyConfig: every numeric field rejects a value below its bound', () => {
  for (const { section, key, value } of DEFAULT_FIELDS.filter((f) => typeof f.value === 'number')) {
    const res = validateEfficiencyConfig({ version: 1, [section]: { [key]: -1 } });
    assert.equal(res.ok, false, `${section}.${key} 应拒绝 -1`);
    assert.ok(res.issues.some((i) => i.includes(`${section}.${key} 必须`)), `${section}.${key}（${res.issues.join('; ')}）`);
    assert.equal(sectionValue(res.config, section, key), value, `${section}.${key}：越界值不写入`);
  }
  // 上界（jev.minConfidence）与版本号同样守得住
  assert.equal(validateEfficiencyConfig({ jev: { minConfidence: 1.5 } }).ok, false);
  assert.equal(validateEfficiencyConfig({ version: 2 }).issues.some((i) => i.includes('version 必须是 1')), true);
  assert.equal(validateEfficiencyConfig({ version: 1, onlineContextCompact: { cacheWriteReadRatio: -5 } }).ok, false);
  assert.equal(validateEfficiencyConfig({ version: 1, onlineContextCompact: { cacheWriteReadRatio: 'auto' } }).ok, true);
});

test('validateEfficiencyConfig: optional string fields clear on ""/null and reject whitespace', () => {
  const cleared = validateEfficiencyConfig({ version: 1, evidencePreservingReducer: { model: null }, jev: { baseUrl: '', apiKey: null } });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.config.evidencePreservingReducer.model, undefined);
  assert.equal(cleared.config.jev.baseUrl, undefined);
  assert.equal(cleared.config.jev.apiKey, undefined);

  // Whitespace is not "unset" — it cannot be a legal value either.
  const blank = validateEfficiencyConfig({ version: 1, evidencePreservingReducer: { model: '   ' } });
  assert.equal(blank.ok, false);
  assert.ok(blank.issues.some((i) => i.includes('evidencePreservingReducer.model 必须是非空字符串')));
  // jev.model has no `null` escape hatch: a missing model id would silently fall back to an alias.
  assert.equal(validateEfficiencyConfig({ version: 1, jev: { model: null } }).ok, false);

  const trimmed = validateEfficiencyConfig({ version: 1, jev: { model: '  m/x  ', apiKey: ' k ' } });
  assert.equal(trimmed.config.jev.model, 'm/x');
  assert.equal(trimmed.config.jev.apiKey, 'k');
});

test('validateEfficiencyConfig: section issues force enabled=false (P1-5 fail-open)', () => {
  const res = validateEfficiencyConfig({
    version: 1,
    onlineContextCompact: { enabled: true, logEnabled: true },
    observationPack: { enabled: true, thresholBytes: 1024 }, // typo!
    evidencePreservingReducer: { enabled: true, timeoutMs: 100 }, // bound < 500
  });
  assert.equal(res.ok, false);
  assert.equal(res.config.observationPack.enabled, false);
  assert.equal(res.config.evidencePreservingReducer.enabled, false);
  // A clean section keeps its values and stays untouched.
  assert.equal(res.config.onlineContextCompact.enabled, true);
  assert.equal(res.config.onlineContextCompact.logEnabled, true);
});

test('validateEfficiencyConfig: jev section validation and fail-open', () => {
  const bad = validateEfficiencyConfig({ version: 1, jev: { enabled: true, timeoutMs: 100 } });
  assert.equal(bad.ok, false);
  assert.equal(bad.config.jev.enabled, false, 'section issues force enabled=false');
  assert.ok(bad.issues.some((i) => i.includes('jev.timeoutMs')));

  const good = validateEfficiencyConfig({ version: 1, jev: { enabled: true, apiKey: ' k ', minConfidence: 0.75 } });
  assert.equal(good.ok, true);
  assert.equal(good.config.jev.apiKey, 'k', 'key is trimmed');
  assert.equal(good.config.jev.minConfidence, 0.75);
  assert.equal(good.config.jev.model, 'jev-1.13.0', 'pinned versioned id');
});

test('resolveEfficiencyConfig: workspace config replaces user config if trusted', () => {
  const resolved = resolveEfficiencyConfig({
    userConfig: { version: 1, onlineContextCompact: { enabled: true, cacheWriteReadRatio: 10 } },
    workspaceConfig: { version: 1, onlineContextCompact: { enabled: false } },
    isProjectTrusted: true,
    env: {},
  });
  assert.equal(resolved.onlineContextCompact.enabled, false);
});

test('resolveEfficiencyConfig: workspace config is ignored if the project is untrusted', () => {
  const warnings: string[] = [];
  const resolved = resolveEfficiencyConfig({
    userConfig: { version: 1, onlineContextCompact: { enabled: true } },
    workspaceConfig: { version: 1, onlineContextCompact: { enabled: false }, evidencePreservingReducer: { enabled: true, model: 'malicious/model' } },
    isProjectTrusted: false,
    env: {},
    onWarning: (w) => warnings.push(w),
  });
  assert.equal(resolved.onlineContextCompact.enabled, true);
  assert.equal(resolved.evidencePreservingReducer.enabled, false);
  assert.ok(warnings.some((w) => w.includes('未被信任')));
});

test('resolveEfficiencyConfig: environment variables override file configs', () => {
  const resolved = resolveEfficiencyConfig({
    userConfig: { version: 1 },
    env: {
      PI_HERDR_COMPACT_ENABLE: '1',
      PI_HERDR_COMPACT_LOG: 'true',
      PI_HERDR_CACHE_RATIO: '15.5',
      PI_HERDR_OBS_PACK_ENABLE: '1',
      PI_HERDR_OBS_PACK_LOG: '1',
      PI_HERDR_REDUCER_ENABLE: '1',
      PI_HERDR_REDUCER_LOG: '1',
      PI_HERDR_REDUCER_MODEL: 'custom/fast-model',
    },
  });
  assert.equal(resolved.onlineContextCompact.enabled, true);
  assert.equal(resolved.onlineContextCompact.logEnabled, true);
  assert.equal(resolved.onlineContextCompact.cacheWriteReadRatio, 15.5);
  assert.equal(resolved.observationPack.enabled, true);
  assert.equal(resolved.observationPack.logEnabled, true);
  assert.equal(resolved.evidencePreservingReducer.enabled, true);
  assert.equal(resolved.evidencePreservingReducer.logEnabled, true);
  assert.equal(resolved.evidencePreservingReducer.model, 'custom/fast-model');
  assert.equal(resolveEfficiencyConfig({ env: { PI_HERDR_CACHE_RATIO: 'auto' } }).onlineContextCompact.cacheWriteReadRatio, 'auto');
  // An override always beats the file layer, even against a disabled section default.
  assert.equal(
    resolveEfficiencyConfig({ userConfig: { version: 1, observationPack: { enabled: false } }, env: { PI_HERDR_OBS_PACK_ENABLE: '1' } })
      .observationPack.enabled,
    true,
  );
});

test('resolveEfficiencyConfig: jev env keys outrank the config value, TYPESAFE_API_KEY only fills a hole', () => {
  const byEnv = resolveEfficiencyConfig({
    env: {
      PIER_JEV_ENABLE: '1',
      PIER_JEV_MODEL: 'jev-1.13.1',
      PIER_JEV_TIMEOUT_MS: '1500',
      PIER_JEV_MIN_CONFIDENCE: '0.8',
      PIER_JEV_API_KEY: 'pk',
    },
  });
  assert.deepEqual(
    { enabled: byEnv.jev.enabled, model: byEnv.jev.model, timeoutMs: byEnv.jev.timeoutMs, minConfidence: byEnv.jev.minConfidence, apiKey: byEnv.jev.apiKey },
    { enabled: true, model: 'jev-1.13.1', timeoutMs: 1500, minConfidence: 0.8, apiKey: 'pk' },
  );
  assert.equal(resolveEfficiencyConfig({ env: { PIER_JEV_ENABLE: '1', TYPESAFE_API_KEY: 'fk' } }).jev.apiKey, 'fk', 'SDK-convention env fills a missing key');
  assert.equal(resolveEfficiencyConfig({ env: { PIER_JEV_API_KEY: 'pk', TYPESAFE_API_KEY: 'fk' } }).jev.apiKey, 'pk', 'pier env wins over the foreign convention');

  const byConfig = resolveEfficiencyConfig({ userConfig: { jev: { apiKey: 'ck' } }, env: {} });
  assert.equal(byConfig.jev.apiKey, 'ck');
  assert.equal(byConfig.jev.enabled, false, 'key alone does not enable the layer');
  assert.equal(resolveEfficiencyConfig({ env: {} }).jev.apiKey, undefined);
});

test('resolveEfficiencyConfig: invalid env values warn and keep the previous value', () => {
  const warnings: string[] = [];
  const resolved = resolveEfficiencyConfig({
    userConfig: { version: 1, jev: { timeoutMs: 900, minConfidence: 0.4 }, onlineContextCompact: { cacheWriteReadRatio: 3 } },
    env: { PIER_JEV_TIMEOUT_MS: '100', PIER_JEV_MIN_CONFIDENCE: 'nope', PI_HERDR_CACHE_RATIO: 'fast' },
    onWarning: (w) => warnings.push(w),
  });
  assert.equal(resolved.jev.timeoutMs, 900);
  assert.equal(resolved.jev.minConfidence, 0.4);
  assert.equal(resolved.onlineContextCompact.cacheWriteReadRatio, 3);
  assert.equal(warnings.length, 3, warnings.join(' | '));
});

test('loadPiNativeCompactionSettings: missing paths are tolerated, project file gated on trust', async () => {
  const missing = loadPiNativeCompactionSettings({
    cwd: '/tmp/nonexistent-pier-test-dir',
    isProjectTrusted: false,
    agentDir: '/tmp/nonexistent-pier-agent-dir',
  });
  assert.deepEqual(missing, {});

  const tempDir = await mkdtemp(join(tmpdir(), 'pier-pi-settings-unit-'));
  try {
    const agentDir = join(tempDir, 'agent');
    const projectDir = join(tempDir, 'project');
    await mkdir(agentDir, { recursive: true });
    await mkdir(join(projectDir, '.pi'), { recursive: true });
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ compaction: { enabled: false, keepRecentTokens: 35000 } }));
    await writeFile(join(projectDir, '.pi', 'settings.json'), JSON.stringify({ compaction: { keepRecentTokens: 99999 } }));

    const trusted = loadPiNativeCompactionSettings({ cwd: projectDir, isProjectTrusted: true, agentDir });
    assert.equal(trusted.enabled, false);
    assert.equal(trusted.keepRecentTokens, 99999, 'project settings win when the project is trusted');
    assert.equal(loadPiNativeCompactionSettings({ cwd: projectDir, isProjectTrusted: false, agentDir }).keepRecentTokens, 35000, 'untrusted project settings are ignored');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('loadEfficiencyConfigFromDisk: respects Pi native compaction settings and inheritance (A4)', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'pier-pi-settings-test-'));
  try {
    const agentDir = join(tempDir, 'agent');
    const projectDir = join(tempDir, 'project');
    const userConfigPath = join(tempDir, 'user-efficiency-config.json'); // never the developer's real ~/.pi/agent
    await mkdir(agentDir, { recursive: true });
    await mkdir(join(projectDir, '.pi-herdr'), { recursive: true });
    await mkdir(join(projectDir, '.pi'), { recursive: true });
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ compaction: { enabled: false, keepRecentTokens: 35000 } }));
    // Efficiency config explicitly ENABLES OCC — so the assertion below is non-vacuous.
    await writeFile(join(projectDir, '.pi-herdr', 'config.json'), JSON.stringify({ version: 1, onlineContextCompact: { enabled: true } }));

    const base = { cwd: projectDir, isProjectTrusted: true, agentDir, userConfigPath };
    const config1 = loadEfficiencyConfigFromDisk({ ...base, env: {} });
    assert.equal(config1.onlineContextCompact.enabled, false, 'pi compaction.enabled=false disables an explicitly enabled OCC');
    assert.equal(config1.onlineContextCompact.keepRecentTokens, 35000, 'inherits pi keepRecentTokens');

    // Environment explicitly forcing OCC enable wins over pi's disabled state.
    assert.equal(loadEfficiencyConfigFromDisk({ ...base, env: { PI_HERDR_COMPACT_ENABLE: '1' } }).onlineContextCompact.enabled, true);

    // Explicit efficiency keepRecentTokens wins over pi's inherited value.
    await writeFile(join(projectDir, '.pi-herdr', 'config.json'), JSON.stringify({ version: 1, onlineContextCompact: { enabled: true, keepRecentTokens: 12345 } }));
    assert.equal(loadEfficiencyConfigFromDisk({ ...base, env: { PI_HERDR_COMPACT_ENABLE: '1' } }).onlineContextCompact.keepRecentTokens, 12345);

    // Untrusted project .pi/settings.json is ignored (global 35000 wins).
    await writeFile(join(projectDir, '.pi', 'settings.json'), JSON.stringify({ compaction: { keepRecentTokens: 99999 } }));
    assert.equal(loadEfficiencyConfigFromDisk({ ...base, isProjectTrusted: false, env: { PI_HERDR_COMPACT_ENABLE: '1' } }).onlineContextCompact.keepRecentTokens, 35000);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
