/**
 * D100-D103 efficiency configuration: schema, validation, multi-tier resolution and the
 * two files pier itself reads for it.
 *
 * Contract:
 *  - Unknown keys are rejected (typo guard); all issues are collected in one pass.
 *  - A project-level config requires `isProjectTrusted: true` (security boundary).
 *  - Workspace config shallow-replaces user config; env (`PI_HERDR_*` / `PIER_JEV_*`) wins over both.
 *  - Fail-open: a config that fails validation disables the affected mechanism and warns on one
 *    line instead of crashing the session; an unknown top-level key disables every mechanism.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface OnlineContextCompactConfig {
  enabled: boolean;
  logEnabled: boolean;
  cacheWriteReadRatio: number | 'auto';
  keepRecentTokens?: number;
  firstCompactionRequestScale: number;
  subsequentCompactionMargin: number;
}

export interface ObservationPackConfig {
  enabled: boolean;
  logEnabled: boolean;
  thresholdBytes: number;
  fullSends: number;
  recallChunkBytes: number;
  excerptBytes: number;
}

export interface EvidencePreservingReducerConfig {
  enabled: boolean;
  logEnabled: boolean;
  model?: string;
  minBytes: number;
  maxChars: number;
  maxOutputTokens: number;
  timeoutMs: number;
  localOnly: boolean;
}

/**
 * Jev decision layer (RFC docs/rfc-jev-integration.md). Optional System One classification calls
 * that upgrade hand-written heuristics; every call site fails open to the existing heuristic on
 * any error, timeout, or low confidence.
 */
export interface JevConfig {
  enabled: boolean;
  logEnabled: boolean;
  /** API root override (relay/gateway); default https://api.typesafe.ai. */
  baseUrl?: string;
  /** Pinned versioned model id — aliases (jev-latest) move silently and would skew tuned thresholds. */
  model: string;
  /** Total per-call budget in ms (AbortController hard kill; the SDK has no total-budget mode). */
  timeoutMs: number;
  /** Minimum Choice/Score confidence to accept an answer; below = treat the question as unanswered. */
  minConfidence: number;
  /** Resolution: PIER_JEV_API_KEY env > this value > TYPESAFE_API_KEY env (SDK convention). */
  apiKey?: string;
}

export interface EfficiencyConfig {
  version: 1;
  onlineContextCompact: OnlineContextCompactConfig;
  observationPack: ObservationPackConfig;
  evidencePreservingReducer: EvidencePreservingReducerConfig;
  jev: JevConfig;
}

export const DEFAULT_EFFICIENCY_CONFIG: EfficiencyConfig = Object.freeze({
  version: 1,
  onlineContextCompact: Object.freeze({
    enabled: false, logEnabled: false, cacheWriteReadRatio: 'auto', keepRecentTokens: 20000,
    firstCompactionRequestScale: 2.0, subsequentCompactionMargin: 1.5,
  }),
  observationPack: Object.freeze({
    enabled: false, logEnabled: false, thresholdBytes: 10240, fullSends: 2,
    recallChunkBytes: 16384, excerptBytes: 1024,
  }),
  evidencePreservingReducer: Object.freeze({
    enabled: false, logEnabled: false, minBytes: 4096, maxChars: 600000,
    maxOutputTokens: 2048, timeoutMs: 5000, localOnly: false,
  }),
  jev: Object.freeze({ enabled: false, logEnabled: false, model: 'jev-1.13.0', timeoutMs: 2000, minConfidence: 0.6 }),
});

/* ── schema ─────────────────────────────────────────────────────────────── */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

type FieldKind = 'bool' | 'int' | 'number' | 'ratio' | 'string' | 'optionalString';

interface FieldSpec {
  readonly key: string;
  readonly kind: FieldKind;
  /** Lower bound for `int`/`number`; also printed in the issue message. */
  readonly min?: number;
  /** Upper bound for a bounded `number`. */
  readonly max?: number;
  /** Issue text for a bound that must not be printed as a plain JS number ("1.0"). */
  readonly minText?: string;
}

/** A section is `{enabled, ...fields}`; field order fixes the order of reported issues. */
interface SectionSpec {
  readonly name: 'onlineContextCompact' | 'observationPack' | 'evidencePreservingReducer' | 'jev';
  readonly fields: readonly FieldSpec[];
}

const SECTIONS: readonly SectionSpec[] = [
  { name: 'onlineContextCompact', fields: [
    { key: 'enabled', kind: 'bool' },
    { key: 'logEnabled', kind: 'bool' },
    { key: 'cacheWriteReadRatio', kind: 'ratio' },
    { key: 'keepRecentTokens', kind: 'int', min: 1000 },
    { key: 'firstCompactionRequestScale', kind: 'number', min: 1, minText: '1.0' },
    { key: 'subsequentCompactionMargin', kind: 'number', min: 1, minText: '1.0' },
  ] },
  { name: 'observationPack', fields: [
    { key: 'enabled', kind: 'bool' },
    { key: 'logEnabled', kind: 'bool' },
    { key: 'thresholdBytes', kind: 'int', min: 1024 },
    { key: 'fullSends', kind: 'int', min: 1 },
    { key: 'recallChunkBytes', kind: 'int', min: 1024 },
    { key: 'excerptBytes', kind: 'int', min: 128 },
  ] },
  { name: 'evidencePreservingReducer', fields: [
    { key: 'enabled', kind: 'bool' },
    { key: 'logEnabled', kind: 'bool' },
    { key: 'model', kind: 'optionalString' },
    { key: 'minBytes', kind: 'int', min: 512 },
    { key: 'maxChars', kind: 'int', min: 1000 },
    { key: 'maxOutputTokens', kind: 'int', min: 128 },
    { key: 'timeoutMs', kind: 'int', min: 500 },
    { key: 'localOnly', kind: 'bool' },
  ] },
  { name: 'jev', fields: [
    { key: 'enabled', kind: 'bool' },
    { key: 'logEnabled', kind: 'bool' },
    { key: 'baseUrl', kind: 'optionalString' },
    { key: 'model', kind: 'string' },
    { key: 'timeoutMs', kind: 'int', min: 500 },
    { key: 'minConfidence', kind: 'number', min: 0, max: 1 },
    { key: 'apiKey', kind: 'optionalString' },
  ] },
];

function issueFor(section: string, field: FieldSpec): string {
  const path = `${section}.${field.key}`;
  switch (field.kind) {
    case 'bool':
      return `${path} 必须是 boolean`;
    case 'int':
      return `${path} 必须是 >= ${field.min} 的整数`;
    case 'number':
      return field.max === undefined
        ? `${path} 必须是 >= ${field.minText ?? field.min} 的数字`
        : `${path} 必须是 ${field.min} 到 ${field.max} 之间的数字`;
    case 'ratio':
      return `${path} 必须是 "auto" 或非负有限数`;
    default:
      return `${path} 必须是非空字符串`;
  }
}

/** Writes one validated field onto `target`; `undefined` (absent) always counts as valid. */
function applyField(target: Record<string, unknown>, field: FieldSpec, raw: unknown): boolean {
  if (raw === undefined) return true;
  const min = field.min ?? Number.NEGATIVE_INFINITY;
  switch (field.kind) {
    case 'bool':
      if (typeof raw !== 'boolean') return false;
      break;
    case 'int':
      if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min) return false;
      break;
    case 'number':
      if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < min) return false;
      if (field.max !== undefined && raw > field.max) return false;
      break;
    case 'ratio':
      if (raw !== 'auto' && (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0)) return false;
      break;
    case 'string':
      if (typeof raw !== 'string' || !raw.trim()) return false;
      target[field.key] = raw.trim();
      return true;
    case 'optionalString':
      if (raw === '' || raw === null) {
        target[field.key] = undefined;
        return true;
      }
      if (typeof raw !== 'string' || !raw.trim()) return false;
      target[field.key] = raw.trim();
      return true;
  }
  target[field.key] = raw;
  return true;
}

function defaults(): EfficiencyConfig {
  return {
    version: 1,
    onlineContextCompact: { ...DEFAULT_EFFICIENCY_CONFIG.onlineContextCompact },
    observationPack: { ...DEFAULT_EFFICIENCY_CONFIG.observationPack },
    evidencePreservingReducer: { ...DEFAULT_EFFICIENCY_CONFIG.evidencePreservingReducer },
    jev: { ...DEFAULT_EFFICIENCY_CONFIG.jev },
  };
}

export interface ValidateConfigResult {
  ok: boolean;
  config: EfficiencyConfig;
  issues: string[];
}

export function validateEfficiencyConfig(raw: unknown): ValidateConfigResult {
  const config = defaults();
  if (!isPlainObject(raw)) {
    for (const section of SECTIONS) config[section.name].enabled = false;
    return { ok: false, config, issues: ['efficiency config 必须是 JSON 对象'] };
  }

  const issues: string[] = [];
  for (const key of Object.keys(raw)) {
    if (key !== 'version' && !SECTIONS.some((s) => s.name === key)) issues.push(`未知顶层配置项: "${key}"`);
  }
  if (raw.version !== undefined && raw.version !== 1) {
    issues.push(`version 必须是 1 (当前: ${JSON.stringify(raw.version)})`);
  }
  const topLevelInvalid = issues.length > 0;

  for (const section of SECTIONS) {
    const issueCountBefore = issues.length;
    const target = config[section.name] as unknown as Record<string, unknown>;
    const rawSection = raw[section.name];
    if (rawSection !== undefined) {
      if (!isPlainObject(rawSection)) {
        issues.push(`${section.name} 必须是 JSON 对象`);
      } else {
        for (const key of Object.keys(rawSection)) {
          if (!section.fields.some((f) => f.key === key)) issues.push(`${section.name} 未知配置项: "${key}"`);
        }
        for (const field of section.fields) {
          if (!applyField(target, field, rawSection[field.key])) issues.push(issueFor(section.name, field));
        }
      }
    }
    // Fail-open: an invalid section (or an invalid top level) can never enable a mechanism.
    if (topLevelInvalid || issues.length > issueCountBefore) config[section.name].enabled = false;
  }

  return { ok: issues.length === 0, config, issues };
}

/* ── env overrides ──────────────────────────────────────────────────────── */

function parseEnvBool(val: string): boolean | undefined {
  const s = val.trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'off') return false;
  return undefined;
}

interface EnvOverride {
  readonly env: string;
  readonly section: SectionSpec['name'];
  readonly key: string;
  readonly kind: 'bool' | 'string' | 'ratio' | 'int' | 'unit';
  /** Lower bound for `int` (also printed in the warning). */
  readonly min?: number;
  /** Set only when the config left the key unset (foreign-convention fallback). */
  readonly fallbackOnly?: boolean;
}

/** Highest-precedence layer; an empty value counts as unset everywhere. */
const ENV_OVERRIDES: readonly EnvOverride[] = [
  { env: 'PI_HERDR_COMPACT_ENABLE', section: 'onlineContextCompact', key: 'enabled', kind: 'bool' },
  { env: 'PI_HERDR_COMPACT_LOG', section: 'onlineContextCompact', key: 'logEnabled', kind: 'bool' },
  { env: 'PI_HERDR_CACHE_RATIO', section: 'onlineContextCompact', key: 'cacheWriteReadRatio', kind: 'ratio' },
  { env: 'PI_HERDR_OBS_PACK_ENABLE', section: 'observationPack', key: 'enabled', kind: 'bool' },
  { env: 'PI_HERDR_OBS_PACK_LOG', section: 'observationPack', key: 'logEnabled', kind: 'bool' },
  { env: 'PI_HERDR_REDUCER_ENABLE', section: 'evidencePreservingReducer', key: 'enabled', kind: 'bool' },
  { env: 'PI_HERDR_REDUCER_LOG', section: 'evidencePreservingReducer', key: 'logEnabled', kind: 'bool' },
  { env: 'PI_HERDR_REDUCER_MODEL', section: 'evidencePreservingReducer', key: 'model', kind: 'string' },
  // jev has no legacy spelling: PIER_JEV_* is canonical from the start.
  { env: 'PIER_JEV_ENABLE', section: 'jev', key: 'enabled', kind: 'bool' },
  { env: 'PIER_JEV_LOG', section: 'jev', key: 'logEnabled', kind: 'bool' },
  { env: 'PIER_JEV_MODEL', section: 'jev', key: 'model', kind: 'string' },
  { env: 'PIER_JEV_BASE_URL', section: 'jev', key: 'baseUrl', kind: 'string' },
  { env: 'PIER_JEV_TIMEOUT_MS', section: 'jev', key: 'timeoutMs', kind: 'int', min: 500 },
  { env: 'PIER_JEV_MIN_CONFIDENCE', section: 'jev', key: 'minConfidence', kind: 'unit' },
  { env: 'PIER_JEV_API_KEY', section: 'jev', key: 'apiKey', kind: 'string' },
  // TYPESAFE_API_KEY is a foreign (SDK) convention, so it ranks below the config file too.
  { env: 'TYPESAFE_API_KEY', section: 'jev', key: 'apiKey', kind: 'string', fallbackOnly: true },
];

function applyEnvOverrides(
  config: EfficiencyConfig,
  env: Record<string, string | undefined>,
  warn: (message: string) => void,
): void {
  for (const override of ENV_OVERRIDES) {
    const raw = env[override.env];
    if (raw === undefined || raw === '') continue;
    const target = config[override.section] as unknown as Record<string, unknown>;
    if (override.fallbackOnly && target[override.key] !== undefined) continue;

    if (override.kind === 'bool') {
      const parsed = parseEnvBool(raw);
      if (parsed !== undefined) target[override.key] = parsed;
      continue;
    }
    if (override.kind === 'string') {
      if (raw.trim()) target[override.key] = raw.trim();
      continue;
    }
    if (override.kind === 'ratio' && raw.trim().toLowerCase() === 'auto') {
      target[override.key] = 'auto';
      continue;
    }
    const num = Number(raw);
    const valid =
      override.kind === 'ratio' ? Number.isFinite(num) && num >= 0
      : override.kind === 'unit' ? Number.isFinite(num) && num >= 0 && num <= 1
      : Number.isInteger(num) && num >= (override.min ?? 0);
    if (valid) {
      target[override.key] = num;
      continue;
    }
    const requirement =
      override.kind === 'unit' ? '（需 0 到 1）'
      : override.kind === 'int' ? `（需 >= ${override.min} 的整数）`
      : '';
    warn(`无效环境变量 ${override.env}="${raw}"${requirement}，忽略`);
  }
}

export interface ResolveConfigOptions {
  workspaceConfig?: unknown;
  userConfig?: unknown;
  env?: Record<string, string | undefined>;
  isProjectTrusted?: boolean;
  onWarning?: (message: string) => void;
}

export function resolveEfficiencyConfig(opts: ResolveConfigOptions = {}): EfficiencyConfig {
  const env = opts.env ?? process.env;
  const warn = opts.onWarning ?? ((msg: string) => console.warn(`[pi-herdr] efficiency config warning: ${msg}`));
  const isTrusted = opts.isProjectTrusted ?? false;

  // An untrusted project's file is ignored wholesale (never merged with the user layer).
  let baseRaw: unknown = opts.userConfig;
  if (opts.workspaceConfig !== undefined) {
    if (isTrusted) baseRaw = opts.workspaceConfig;
    else warn('工作区能效配置未被信任（isProjectTrusted=false），已安全忽略工作区配置');
  }

  let resolved = defaults();
  if (baseRaw !== undefined) {
    const validated = validateEfficiencyConfig(baseRaw);
    if (!validated.ok) warn(`配置存在校验问题，已安全回退默认值: ${validated.issues.join('; ')}`);
    resolved = validated.config;
  }

  applyEnvOverrides(resolved, env, warn);
  return resolved;
}

/* ── files pier reads ───────────────────────────────────────────────────── */

function defaultUserEfficiencyConfigDir(): string {
  return join(homedir(), '.pi', 'agent', 'herdr-pi');
}

export function defaultWorkspaceEfficiencyConfigFile(cwd: string): string {
  return join(cwd, '.pi-herdr', 'config.json');
}

export function defaultUserEfficiencyConfigFile(): string {
  return join(defaultUserEfficiencyConfigDir(), 'config.json');
}

interface PiCompactionSettings {
  enabled?: boolean;
  keepRecentTokens?: number;
}

function readCompactionSettings(filePath: string): PiCompactionSettings {
  const parsed = readJsonConfig(filePath);
  if (!isPlainObject(parsed) || !isPlainObject(parsed.compaction)) return {};
  const { compaction } = parsed;
  const result: PiCompactionSettings = {};
  if (typeof compaction.enabled === 'boolean') result.enabled = compaction.enabled;
  if (typeof compaction.keepRecentTokens === 'number') result.keepRecentTokens = compaction.keepRecentTokens;
  return result;
}

/** Parse a JSON file, reporting a broken file through `onError` instead of throwing. */
function readJsonConfig(filePath: string, onError?: (error: unknown) => void): unknown {
  if (!existsSync(filePath)) return undefined;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
  } catch (error) {
    onError?.(error);
    return undefined;
  }
}

/** Pi's own compaction settings: global, plus the project file when the project is trusted. */
export function loadPiNativeCompactionSettings(opts: {
  cwd?: string;
  isProjectTrusted?: boolean;
  agentDir?: string;
} = {}): PiCompactionSettings {
  const cwd = opts.cwd ?? process.cwd();
  const agentDir = opts.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent');
  const globalSettings = readCompactionSettings(join(agentDir, 'settings.json'));
  if (!opts.isProjectTrusted) return globalSettings;
  return { ...globalSettings, ...readCompactionSettings(join(cwd, '.pi', 'settings.json')) };
}

export function loadEfficiencyConfigFromDisk(opts: {
  cwd?: string;
  isProjectTrusted?: boolean;
  env?: Record<string, string | undefined>;
  onWarning?: (msg: string) => void;
  /** Override the Pi agent dir used to read native `settings.json` (tests/isolation). */
  agentDir?: string;
  /** Override the user-level efficiency config file path (tests/isolation). */
  userConfigPath?: string;
} = {}): EfficiencyConfig {
  const cwd = opts.cwd ?? process.cwd();
  const wsPath = defaultWorkspaceEfficiencyConfigFile(cwd);
  const userPath = opts.userConfigPath ?? defaultUserEfficiencyConfigFile();
  const warnFile = (label: string, filePath: string, error: unknown): void => {
    opts.onWarning?.(`${label} ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  };
  const workspaceConfig = readJsonConfig(wsPath, (error) => warnFile('无法解析工作区能效配置文件', wsPath, error));
  const userConfig = readJsonConfig(userPath, (error) => warnFile('无法解析用户能效配置文件', userPath, error));
  const resolved = resolveEfficiencyConfig({
    workspaceConfig,
    userConfig,
    isProjectTrusted: opts.isProjectTrusted,
    env: opts.env,
    onWarning: opts.onWarning,
  });

  const piSettings = loadPiNativeCompactionSettings({
    cwd,
    isProjectTrusted: opts.isProjectTrusted,
    agentDir: opts.agentDir,
  });

  // pi's global compaction switch wins over an explicitly enabled OCC — only an env force overrides it.
  const env = opts.env ?? process.env;
  if (piSettings.enabled === false && !env.PI_HERDR_COMPACT_ENABLE) {
    resolved.onlineContextCompact.enabled = false;
  }
  const hasExplicitKeepRecent = [opts.isProjectTrusted ? workspaceConfig : undefined, userConfig].some(
    (config) =>
      isPlainObject(config)
      && isPlainObject(config.onlineContextCompact)
      && config.onlineContextCompact.keepRecentTokens !== undefined,
  );
  // pi's keepRecentTokens is inherited only while the efficiency config does not set its own.
  if (!hasExplicitKeepRecent && typeof piSettings.keepRecentTokens === 'number') {
    resolved.onlineContextCompact.keepRecentTokens = piSettings.keepRecentTokens;
  }
  return resolved;
}
