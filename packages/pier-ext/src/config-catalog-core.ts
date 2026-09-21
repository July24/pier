/**
 * D104 config catalog core (pure).
 *
 * Single source of truth for the five pier configuration planes: knob descriptors, effective-value
 * provenance (env > workspace > user > default) and text rendering for `/pier-config show|check|doc`.
 * The `env` plane is derived from the `PIER_OPTIONS` registry (pier-options.ts), so the catalog
 * cannot disagree with the runtime readers.
 *
 * No I/O here; reading the real files/env and registering the command live in config-command.ts.
 * test/config-catalog.test.ts diffs the efficiency knobs against schemas/efficiency-config.schema.json.
 */

import { PIER_OPTIONS } from './pier-options.ts';

export type ConfigPlaneId = 'efficiency' | 'roles' | 'pi' | 'boot' | 'env';

export type ConfigKind = 'boolean' | 'number' | 'string' | 'enum';

export interface ConfigKnob {
  readonly plane: ConfigPlaneId;
  /** Dotted path inside the plane's file, or the env var name for the `env` plane. */
  readonly key: string;
  readonly kind: ConfigKind;
  readonly defaultValue?: string | number | boolean;
  /** Highest-precedence env override for a file-plane knob. */
  readonly envVar?: string;
  /** Lower bound for numeric knobs (mirrors the runtime validator). */
  readonly min?: number;
  /** Historical spellings still accepted for an env knob (B10: canonical `PIER_*` first). */
  readonly aliases?: readonly string[];
  /** One-line effect/impact, shown by `show`. */
  readonly impact: string;
  /** Where to read more (docs/schema anchor). */
  readonly docRef?: string;
  /** True when pier only reads the value (owned by pi / herdr). */
  readonly readOnly?: boolean;
}

export interface ConfigPlane {
  readonly id: ConfigPlaneId;
  readonly title: string;
  readonly owner: 'pier' | 'pi' | 'workbench';
  /** Human-facing path templates, in precedence order. */
  readonly files: readonly string[];
  /** What to do to change this plane. */
  readonly editHint: string;
}

export const CONFIG_PLANES: readonly ConfigPlane[] = Object.freeze([
  {
    id: 'efficiency',
    title: 'Efficiency mechanisms (D100-D103)',
    owner: 'pier',
    files: ['<workspace>/.pi-herdr/config.json', '~/.pi/agent/herdr-pi/config.json', 'PI_HERDR_* env'],
    editHint: 'Edit the workspace or user JSON (env wins); see docs/efficiency-trial.md',
  },
  {
    id: 'roles',
    title: 'Role profiles (D82/D11)',
    owner: 'pier',
    files: ['<workspace>/.pi-herdr/roles/<name>.json', '~/.pi/agent/herdr-pi/roles/<name>.json', 'builtin src/roles/'],
    editHint: 'Add or edit a role JSON; builtin names (master/worker-default) cannot be overridden',
  },
  {
    id: 'pi',
    title: "Pi's own settings (read-only here)",
    owner: 'pi',
    files: ['~/.pi/agent/settings.json', '<trusted-project>/.pi/settings.json'],
    editHint: 'Use pi\'s /settings for everything except the OCC-relevant compaction.* keys',
  },
  {
    id: 'boot',
    title: 'Workbench boot-config',
    owner: 'workbench',
    files: ['$HERDR_PLUGIN_CONFIG_DIR/boot-config.json', 'packages/pier-workbench/scripts/boot-config.json'],
    editHint: 'Prefer `npx pier-setup@latest update --force` over hand-editing paths',
  },
  {
    id: 'env',
    title: 'Runtime policy env (PIER_* / PI_HERDR_*)',
    owner: 'pier',
    files: ['process environment (per-process, no file)'],
    editHint: 'Export the variable before starting pi; it applies to new processes only',
  },
] as const);

/** Efficiency knobs: mirrors schemas/efficiency-config.schema.json (guarded by the catalog test). */
const EFFICIENCY_KNOBS: readonly ConfigKnob[] = [
  { plane: 'efficiency', key: 'onlineContextCompact.enabled', kind: 'boolean', defaultValue: false, envVar: 'PI_HERDR_COMPACT_ENABLE', impact: 'Todo-driven online compaction (OCC) master switch', docRef: 'docs/efficiency-trial.md' },
  { plane: 'efficiency', key: 'onlineContextCompact.logEnabled', kind: 'boolean', defaultValue: false, envVar: 'PI_HERDR_COMPACT_LOG', impact: 'Write compact.jsonl decisions', docRef: 'docs/efficiency-trial.md' },
  { plane: 'efficiency', key: 'onlineContextCompact.cacheWriteReadRatio', kind: 'string', defaultValue: 'auto', envVar: 'PI_HERDR_CACHE_RATIO', impact: 'KV cache write/read cost ratio; auto = model cost, then input/cacheRead, then provider family (gemini 4 / grok+deepseek 10), then token-account 2.0 — never disables OCC', docRef: 'docs/efficiency-trial.md' },
  { plane: 'efficiency', key: 'onlineContextCompact.firstCompactionRequestScale', kind: 'number', defaultValue: 2.0, min: 1.0, impact: 'First-compaction horizon relaxation', docRef: 'docs/efficiency-trial.md' },
  { plane: 'efficiency', key: 'onlineContextCompact.subsequentCompactionMargin', kind: 'number', defaultValue: 1.5, min: 1.0, impact: 'Safety margin required for later compactions', docRef: 'docs/efficiency-trial.md' },
  { plane: 'efficiency', key: 'onlineContextCompact.keepRecentTokens', kind: 'number', defaultValue: 20000, min: 1000, impact: 'Native compaction tail window; inherited from pi unless set here', docRef: 'docs/configuration.md' },
  { plane: 'efficiency', key: 'observationPack.enabled', kind: 'boolean', defaultValue: false, envVar: 'PI_HERDR_OBS_PACK_ENABLE', impact: 'Project large tool outputs as placeholders (observationPack)', docRef: 'docs/efficiency-trial.md' },
  { plane: 'efficiency', key: 'observationPack.logEnabled', kind: 'boolean', defaultValue: false, envVar: 'PI_HERDR_OBS_PACK_LOG', impact: 'Write observation.jsonl packed/recall records', docRef: 'docs/efficiency-trial.md' },
  { plane: 'efficiency', key: 'observationPack.thresholdBytes', kind: 'number', defaultValue: 10240, min: 1024, impact: 'Minimum output size before packing applies', docRef: 'docs/efficiency-trial.md' },
  { plane: 'efficiency', key: 'observationPack.fullSends', kind: 'number', defaultValue: 2, min: 1, impact: 'Provider requests that keep the full text before packing', docRef: 'docs/efficiency-trial.md' },
  { plane: 'efficiency', key: 'observationPack.recallChunkBytes', kind: 'number', defaultValue: 16384, min: 1024, impact: 'obs_recall page size', docRef: 'docs/efficiency-trial.md' },
  { plane: 'efficiency', key: 'observationPack.excerptBytes', kind: 'number', defaultValue: 1024, min: 128, impact: 'Whole-line head/tail excerpt kept in the placeholder', docRef: 'docs/efficiency-trial.md' },
  { plane: 'efficiency', key: 'evidencePreservingReducer.enabled', kind: 'boolean', defaultValue: false, envVar: 'PI_HERDR_REDUCER_ENABLE', impact: 'Reduce long bash diagnostic logs to a verified receipt (EPR)', docRef: 'docs/efficiency-trial.md' },
  { plane: 'efficiency', key: 'evidencePreservingReducer.logEnabled', kind: 'boolean', defaultValue: false, envVar: 'PI_HERDR_REDUCER_LOG', impact: 'Write reducer.jsonl attempts and fallback reasons', docRef: 'docs/efficiency-trial.md' },
  { plane: 'efficiency', key: 'evidencePreservingReducer.model', kind: 'string', envVar: 'PI_HERDR_REDUCER_MODEL', impact: 'Cheap model used for reduction (provider/model); defaults to the session model', docRef: 'docs/efficiency-trial.md' },
  { plane: 'efficiency', key: 'evidencePreservingReducer.minBytes', kind: 'number', defaultValue: 4096, min: 512, impact: 'Minimum log size before reduction is attempted', docRef: 'docs/efficiency-trial.md' },
  { plane: 'efficiency', key: 'evidencePreservingReducer.maxChars', kind: 'number', defaultValue: 600000, min: 1000, impact: 'Skip reduction above this log size', docRef: 'docs/efficiency-trial.md' },
  { plane: 'efficiency', key: 'evidencePreservingReducer.maxOutputTokens', kind: 'number', defaultValue: 2048, min: 128, impact: 'Reduction output token budget', docRef: 'docs/efficiency-trial.md' },
  { plane: 'efficiency', key: 'evidencePreservingReducer.timeoutMs', kind: 'number', defaultValue: 5000, min: 500, impact: 'Synchronous reduction budget; timeout falls back to the full log', docRef: 'docs/efficiency-trial.md' },
  { plane: 'efficiency', key: 'evidencePreservingReducer.localOnly', kind: 'boolean', defaultValue: false, impact: 'Archive the raw log but never call a model', docRef: 'docs/efficiency-trial.md' },
  { plane: 'efficiency', key: 'jev.enabled', kind: 'boolean', defaultValue: false, envVar: 'PIER_JEV_ENABLE', impact: 'Jev decision layer (System One classification) master switch; every call site fails open', docRef: 'docs/rfc-jev-integration.md' },
  { plane: 'efficiency', key: 'jev.logEnabled', kind: 'boolean', defaultValue: false, envVar: 'PIER_JEV_LOG', impact: 'Write jev.jsonl question outcomes (no request/response bodies)', docRef: 'docs/rfc-jev-integration.md' },
  { plane: 'efficiency', key: 'jev.baseUrl', kind: 'string', envVar: 'PIER_JEV_BASE_URL', impact: 'API root override (relay/gateway); default https://api.typesafe.ai', docRef: 'docs/rfc-jev-integration.md' },
  { plane: 'efficiency', key: 'jev.model', kind: 'string', defaultValue: 'jev-1.13.0', envVar: 'PIER_JEV_MODEL', impact: 'Pinned versioned model id; aliases drift silently and skew tuned thresholds', docRef: 'docs/rfc-jev-integration.md' },
  { plane: 'efficiency', key: 'jev.timeoutMs', kind: 'number', defaultValue: 2000, min: 500, envVar: 'PIER_JEV_TIMEOUT_MS', impact: 'Total per-call budget via AbortController hard kill', docRef: 'docs/rfc-jev-integration.md' },
  { plane: 'efficiency', key: 'jev.minConfidence', kind: 'number', defaultValue: 0.6, min: 0, envVar: 'PIER_JEV_MIN_CONFIDENCE', impact: 'Minimum Choice/Score confidence to adopt an answer; below counts as unanswered', docRef: 'docs/rfc-jev-integration.md' },
  { plane: 'efficiency', key: 'jev.apiKey', kind: 'string', envVar: 'PIER_JEV_API_KEY', impact: 'API key; PIER_JEV_API_KEY env > config value > TYPESAFE_API_KEY env', docRef: 'docs/rfc-jev-integration.md' },
];

/** Pi-owned keys pier only reads. */
const PI_KNOBS: readonly ConfigKnob[] = [
  { plane: 'pi', key: 'compaction.enabled', kind: 'boolean', impact: 'When false, OCC is disabled too (unless PI_HERDR_COMPACT_ENABLE=1)', docRef: 'docs/efficiency-trial.md', readOnly: true },
  { plane: 'pi', key: 'compaction.keepRecentTokens', kind: 'number', impact: 'Inherited as the OCC retention window when not set in the efficiency config', docRef: 'docs/efficiency-trial.md', readOnly: true },
];

/** Runtime policy / behaviour env knobs, derived from the `PIER_OPTIONS` registry: `min` decides
 *  whether a knob is numeric, and `fallback`/`description` become its default and impact line. */
const ENV_KNOBS: readonly ConfigKnob[] = PIER_OPTIONS.map((option) => ({
  plane: 'env' as const,
  key: option.name,
  kind: option.min === undefined ? ('string' as const) : ('number' as const),
  defaultValue: option.min === undefined
    ? (option.fallback === '' ? undefined : option.fallback)
    : Number(option.fallback),
  aliases: option.legacy ? [option.legacy] : undefined,
  min: option.min,
  impact: option.description,
}));

/** Every knob the catalog can resolve (roles/boot are per-file planes: their schemas are the reference). */
export const CONFIG_KNOBS: readonly ConfigKnob[] = Object.freeze([...EFFICIENCY_KNOBS, ...PI_KNOBS, ...ENV_KNOBS]);

/** Dotted-path getter for parsed JSON layers. */
export function readDotted(obj: unknown, dotted: string): unknown {
  let cursor: unknown = obj;
  for (const part of dotted.split('.')) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

/** Secret-shaped KEY names (not values). Deliberately narrower than a bare `token` match so that
 *  legitimate keys like `compaction.keepRecentTokens` are still shown verbatim. */
const SECRET_LIKE = /(api[_-]?key|apikey|authorization|bearer|access[_-]?token|client[_-]?secret|password|credential)/i;

export function formatValue(value: unknown): string {
  if (value === undefined) return '(unset)';
  if (typeof value === 'string') return value === '' ? '""' : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  return JSON.stringify(value);
}

/** Renders a knob value, masking secret-looking keys. */
export function redactValue(key: string, value: unknown): string {
  if (SECRET_LIKE.test(key) && value !== undefined && value !== '') return '***';
  return formatValue(value);
}

export type ConfigSource = 'env' | 'workspace' | 'user' | 'default' | 'pi';

export interface ResolvedKnob {
  readonly knob: ConfigKnob;
  readonly value: string;
  readonly source: ConfigSource;
  /** Env var that actually supplied the value when it is an alias of `knob.key`. */
  readonly via?: string;
  /** Set when a workspace layer exists but was ignored (untrusted project). */
  readonly note?: string;
}

export interface RawConfigLayers {
  readonly env?: Record<string, string | undefined>;
  /** Parsed workspace efficiency config (untrusted layers are reported, never honored). */
  readonly workspace?: unknown;
  readonly user?: unknown;
  readonly workspaceTrusted?: boolean;
  /** Result of loadPiNativeCompactionSettings (pi-owned values pier reads). */
  readonly piSettings?: { enabled?: boolean; keepRecentTokens?: number };
}

function resolveFileKnob(knob: ConfigKnob, layers: RawConfigLayers): ResolvedKnob {
  const envRaw = knob.envVar ? (layers.env ?? {})[knob.envVar] : undefined;
  if (envRaw !== undefined && envRaw !== '') return { knob, value: redactValue(knob.key, envRaw), source: 'env' };

  const workspaceValue = readDotted(layers.workspace, knob.key);
  const userValue = readDotted(layers.user, knob.key);
  if (workspaceValue !== undefined) {
    if (layers.workspaceTrusted) return { knob, value: redactValue(knob.key, workspaceValue), source: 'workspace' };
    // Untrusted workspace layer exists but is ignored by the loader: surface both facts.
    return userValue === undefined
      ? { knob, value: redactValue(knob.key, knob.defaultValue), source: 'default', note: 'workspace value ignored (untrusted project)' }
      : { knob, value: redactValue(knob.key, userValue), source: 'user', note: 'workspace layer ignored (untrusted project)' };
  }
  if (userValue !== undefined) return { knob, value: redactValue(knob.key, userValue), source: 'user' };
  return { knob, value: redactValue(knob.key, knob.defaultValue), source: 'default' };
}

/** Resolves efficiency + pi knobs from parsed layers. */
export function resolveConfigKnobs(layers: RawConfigLayers): ResolvedKnob[] {
  const out = EFFICIENCY_KNOBS.map((knob) => resolveFileKnob(knob, layers));

  // Effective-value rule from loadEfficiencyConfigFromDisk: pi's compaction.enabled=false
  // disables OCC unless PI_HERDR_COMPACT_ENABLE forces it on.
  const occ = out.find((e) => e.knob.key === 'onlineContextCompact.enabled');
  const envForced = (layers.env?.PI_HERDR_COMPACT_ENABLE ?? '') !== '';
  if (occ && occ.value === 'true' && layers.piSettings?.enabled === false && !envForced) {
    out[out.indexOf(occ)] = { ...occ, value: 'false', note: 'pi compaction.enabled=false disables OCC (set PI_HERDR_COMPACT_ENABLE=1 to force)' };
  }

  for (const knob of PI_KNOBS) {
    const raw = knob.key === 'compaction.enabled' ? layers.piSettings?.enabled : layers.piSettings?.keepRecentTokens;
    out.push(raw === undefined
      ? { knob, value: formatValue(undefined), source: 'pi', note: 'not set in pi settings' }
      : { knob, value: redactValue(knob.key, raw), source: 'pi' });
  }
  return out;
}

/** Resolves the env plane: only catalog keys are ever read. */
export function resolveEnvKnobs(env: Record<string, string | undefined> = {}): ResolvedKnob[] {
  return ENV_KNOBS.map((knob) => {
    // Same precedence as pierOption(): canonical first, then the historical spelling, empty = unset.
    for (const name of [knob.key, ...(knob.aliases ?? [])]) {
      const raw = env[name];
      if (raw === undefined || raw === '') continue;
      return { knob, value: redactValue(knob.key, raw), source: 'env' as const, ...(name === knob.key ? {} : { via: name }) };
    }
    return { knob, value: redactValue(knob.key, knob.defaultValue), source: 'default' as const };
  });
}

/* ── checks ─────────────────────────────────────────────────────────────── */

export interface CheckReport {
  readonly plane: ConfigPlaneId;
  readonly ok: boolean;
  readonly issues: readonly string[];
}

/** Validates env knobs against catalog bounds (mirrors the runtime warn-and-default behaviour). */
export function checkEnvKnobs(env: Record<string, string | undefined> = {}): string[] {
  const issues: string[] = [];
  for (const knob of ENV_KNOBS) {
    if (knob.kind !== 'number') continue;
    for (const name of [knob.key, ...(knob.aliases ?? [])]) {
      const raw = env[name];
      if (raw === undefined || raw === '') continue;
      const parsed = Number.parseInt(raw, 10);
      const min = knob.min ?? 0;
      if (!Number.isFinite(parsed) || parsed < min) {
        issues.push(`${name}="${raw}" is not a valid integer >= ${min} (runtime falls back to ${formatValue(knob.defaultValue)})`);
      }
    }
  }
  return issues;
}

/* ── rendering ──────────────────────────────────────────────────────────── */

function sourceLabel(entry: ResolvedKnob): string {
  const base = entry.via ? `${entry.source} via ${entry.via}` : entry.source;
  return entry.note ? `${base} (${entry.note})` : base;
}

/** Short non-default summary of one plane: "3 set (env 1, workspace 1, user 1)". */
export function summarizePlane(entries: readonly ResolvedKnob[]): string {
  const changed = entries.filter((e) => e.source !== 'default');
  if (changed.length === 0) return 'all defaults';
  const bySource = new Map<ConfigSource, number>();
  for (const e of changed) bySource.set(e.source, (bySource.get(e.source) ?? 0) + 1);
  return `${changed.length} set (${[...bySource].map(([s, n]) => `${s} ${n}`).join(', ')})`;
}

/** Index lines for `/pier-config` (kept short: one line per plane). */
export function renderIndex(lines: {
  efficiency: readonly ResolvedKnob[];
  pi: readonly ResolvedKnob[];
  env: readonly ResolvedKnob[];
  roleSummary: string;
  bootSummary: string;
}): string[] {
  const mechanism = (prefix: string): string =>
    lines.efficiency.some((e) => e.knob.key === `${prefix}.enabled` && e.value === 'true') ? 'on' : 'off';
  return [
    'pier config — 5 planes, env > workspace > user > default',
    `  efficiency  ${summarizePlane(lines.efficiency)} — OCC ${mechanism('onlineContextCompact')} / OBS ${mechanism('observationPack')} / EPR ${mechanism('evidencePreservingReducer')}`,
    `  roles       ${lines.roleSummary}`,
    `  pi          ${summarizePlane(lines.pi)} — OCC reads compaction.* only`,
    `  boot        ${lines.bootSummary}`,
    `  env         ${summarizePlane(lines.env)}`,
    '  show: /pier-config show <efficiency|roles|pi|boot|env|all>   check: /pier-config check   report: /pier-config doc',
  ];
}

/** Full listing of one plane's knobs. */
export function renderPlane(entries: readonly ResolvedKnob[]): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    const { knob } = entry;
    const from = knob.envVar && entry.source === 'env' ? ` (from ${knob.envVar})` : '';
    const flags = [knob.readOnly ? 'read-only' : '', knob.docRef ?? ''].filter(Boolean).join('; ');
    out.push(`  ${knob.key}${from} = ${entry.value}  [${sourceLabel(entry)}]${flags ? `  (${flags})` : ''}`);
    out.push(`      ${knob.impact}`);
  }
  return out;
}

/** Validated-issue lines for `check`. */
export function renderCheck(reports: readonly CheckReport[]): string[] {
  const out: string[] = [];
  for (const report of reports) {
    out.push(`  ${report.ok ? 'ok  ' : 'FAIL'} ${report.plane}`);
    for (const issue of report.issues) out.push(`      - ${issue}`);
  }
  return out;
}

export interface ReportMeta {
  readonly generatedAt: string;
  readonly cwd: string;
  readonly workspaceTrusted: boolean;
  readonly piVersion?: string;
}

/** Machine-truth markdown report (`/pier-config doc`). */
export function renderReport(entries: readonly ResolvedKnob[], meta: ReportMeta): string {
  const lines = [
    '# pier config report',
    '',
    `- generated: ${meta.generatedAt}`,
    `- cwd: ${meta.cwd}`,
    `- workspace trusted: ${meta.workspaceTrusted}`,
    ...(meta.piVersion ? [`- pi: ${meta.piVersion}`] : []),
    '',
    'Precedence: env > workspace (trusted) > user > default.',
    '',
  ];
  const escape = (text: string): string => text.replace(/\|/g, '\\|');
  for (const plane of CONFIG_PLANES) {
    const planeEntries = entries.filter((e) => e.knob.plane === plane.id);
    lines.push(`## ${plane.id} — ${plane.title}`, '', `Files: ${plane.files.map((f) => `\`${f}\``).join(' , ')}`, '', `> ${plane.editHint}`, '');
    if (planeEntries.length === 0) {
      lines.push('(no value-carrying knobs; per-file plane)', '');
      continue;
    }
    lines.push('| key | value | source | impact |', '|---|---|---|---|');
    for (const entry of planeEntries) {
      lines.push(`| \`${entry.knob.key}\` | ${escape(entry.value)} | ${sourceLabel(entry)} | ${escape(entry.knob.impact)} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
