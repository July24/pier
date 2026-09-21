/**
 * D104 `/pier-config`: probes the five configuration planes (real files + process env), renders
 * `show|check|doc|doctor`, and registers the command.
 *
 * Read-only by design: the command reports effective values with their provenance and hands the
 * actual edit to the agent under the existing write-lock + diff-confirmation flow; only the opt-in
 * `doc` report writes a file. Fail-open: every read is wrapped, so a broken plane degrades to a
 * reported issue instead of throwing into pi's command pipeline. All paths are injectable, so tests
 * never touch the developer's real home directory.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION as piVersion, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  CONFIG_PLANES,
  checkEnvKnobs,
  readDotted,
  renderCheck,
  renderIndex,
  renderPlane,
  renderReport,
  resolveConfigKnobs,
  resolveEnvKnobs,
  type CheckReport,
  type ConfigPlaneId,
  type ResolvedKnob,
} from './config-catalog-core.ts';
import {
  defaultUserEfficiencyConfigFile,
  defaultWorkspaceEfficiencyConfigFile,
  loadPiNativeCompactionSettings,
  validateEfficiencyConfig,
} from './efficiency-config-core.ts';
import { RESERVED_ROLE_NAMES, listRoleNames, loadRoleConfig, roleLayers } from './role-loader.ts';
import { formatOptionRows } from './pier-options.ts';
import { formatSwallowedErrors } from './swallow.ts';
import { HERDR_PROTOCOL_EXPECTED } from './herdr-client.ts';

export const CONFIG_GUIDANCE_PROMPT = [
  '[PIER-CONFIG] The user wants to inspect or change pier configuration. Follow this workflow strictly:',
  '',
  '1. Ground yourself first: run `/pier-config show all` (or read the files) and use the reported EFFECTIVE VALUE and SOURCE',
  '   (env > workspace > user > default). Only entries whose source is `default` are worth changing; an ignored workspace file',
  '   (untrusted project) must be reported as such instead of edited blindly.',
  '2. Route by plane:',
  '   - efficiency (D100-D103): read `docs/efficiency-trial.md` before proposing values.',
  '   - roles: read `docs/sidebar-role-config.md` and `schemas/role-manifest.schema.json`; builtin role names cannot be overridden.',
  "   - pi (settings.json): recommend pi's own `/settings`; the only OCC-relevant keys here are `compaction.enabled` and",
  '     `compaction.keepRecentTokens` (read-only from our side).',
  '   - boot (boot-config.json): manual edits are risky; prefer `npx pier-setup@latest update --force`, and only patch paths when asked.',
  '   - env (PIER_* / PI_HERDR_*): affects new processes only; state that explicitly.',
  '3. Explain before changing: 2-3 sentences on what the knob controls, its cost/benefit (tokens, latency, safety, blast radius),',
  '   and 2-3 recommended values for common scenarios. Then ask what the user actually wants to achieve.',
  '4. Before writing: show a precise diff (file path, current -> proposed value) and the activation path',
  '   (hot / needs `/reload` / needs a new session or process restart). Wait for explicit confirmation. Change ONE plane at a time.',
  '5. Apply with the normal `edit`/`write` tools (write locks apply), then run `/pier-config check` and report the result back.',
  '6. If a change cannot take effect in the current process, say so and tell the user exactly what to restart.',
  '',
  'Forbidden: dumping `process.env`; writing secrets or tokens into any config file; editing multiple planes before confirmation;',
  'touching `.pi-herdr/` of an untrusted project.',
].join('\n');

export interface ConfigPlaneFile {
  readonly path: string;
  readonly label: string;
  readonly exists: boolean;
  readonly ignored?: boolean;
}

export interface ConfigGuideDeps {
  cwd?: string;
  env?: Record<string, string | undefined>;
  isProjectTrusted?: boolean;
  /** Pi agent dir holding settings.json (defaults to ~/.pi/agent; mirrors PI_CODING_AGENT_DIR). */
  agentDir?: string;
  /** User-level efficiency config path (defaults to ~/.pi/agent/herdr-pi/config.json). */
  userConfigPath?: string;
  /** herdr plugin config dir holding the user-mode boot-config.json. */
  herdrPluginConfigDir?: string;
  /** Repository root used to probe the dev-mode boot-config.json. */
  repoRoot?: string;
  /** User-level roles dir override (defaults to ~/.pi/agent/herdr-pi/roles). */
  rolesUserDir?: string;
}

export interface ConfigGuideSnapshot {
  readonly entries: readonly ResolvedKnob[];
  readonly reports: readonly CheckReport[];
  readonly files: Readonly<Record<ConfigPlaneId, readonly ConfigPlaneFile[]>>;
  readonly workspaceTrusted: boolean;
  readonly roleSummary: string;
  readonly bootSummary: string;
}

/** Standard herdr plugin config dirs: XDG config on macOS/Linux, LOCALAPPDATA on Windows. */
export function defaultHerdrPluginConfigDirs(env: Record<string, string | undefined> = process.env): string[] {
  const xdg = env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
  const dirs = [join(xdg, 'herdr', 'plugins', 'config', 'pier.workbench')];
  if (env.LOCALAPPDATA?.trim()) dirs.push(join(env.LOCALAPPDATA, 'herdr', 'plugins', 'config', 'pier.workbench'));
  return dirs;
}

function readJsonLayer(path: string): { value: unknown; issue?: string } {
  if (!existsSync(path)) return { value: undefined };
  try {
    return { value: JSON.parse(readFileSync(path, 'utf8')) };
  } catch (err) {
    return { value: undefined, issue: `${path}: invalid JSON (${err instanceof Error ? err.message : String(err)})` };
  }
}

function listJsonFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
}

/** Collects the whole snapshot for the guide/command. */
export function collectConfigSnapshot(deps: ConfigGuideDeps = {}): ConfigGuideSnapshot {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const workspaceTrusted = deps.isProjectTrusted ?? false;
  const agentDir = deps.agentDir ?? env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent');
  const userConfigPath = deps.userConfigPath ?? defaultUserEfficiencyConfigFile();
  const workspaceConfigPath = defaultWorkspaceEfficiencyConfigFile(cwd);
  const herdrPluginConfigDir = deps.herdrPluginConfigDir ?? env.HERDR_PLUGIN_CONFIG_DIR;

  const reports: CheckReport[] = [];
  const files: Record<ConfigPlaneId, ConfigPlaneFile[]> = { efficiency: [], roles: [], pi: [], boot: [], env: [] };

  /* efficiency: workspace layer (trusted projects only) + user layer, JSON issues reported as-is */
  const workspaceLayer = readJsonLayer(workspaceConfigPath);
  const userLayer = readJsonLayer(userConfigPath);
  const efficiencyIssues: string[] = [];
  for (const layer of [workspaceLayer, userLayer]) if (layer.issue) efficiencyIssues.push(layer.issue);
  if (workspaceLayer.value !== undefined) {
    if (workspaceTrusted) {
      for (const issue of validateEfficiencyConfig(workspaceLayer.value).issues) efficiencyIssues.push(`${workspaceConfigPath}: ${issue}`);
    } else {
      efficiencyIssues.push(`${workspaceConfigPath}: ignored — the project is not trusted (values below come from user/default)`);
    }
  }
  if (userLayer.value !== undefined) {
    for (const issue of validateEfficiencyConfig(userLayer.value).issues) efficiencyIssues.push(`${userConfigPath}: ${issue}`);
  }
  files.efficiency.push(
    { path: workspaceConfigPath, label: 'workspace', exists: workspaceLayer.value !== undefined, ignored: !workspaceTrusted },
    { path: userConfigPath, label: 'user', exists: userLayer.value !== undefined },
  );

  /* pi settings (read-only here; only compaction.* matters to pier) */
  const piSettingsPath = join(agentDir, 'settings.json');
  const piSettingsExists = existsSync(piSettingsPath);
  const piSettings = loadPiNativeCompactionSettings({ cwd, isProjectTrusted: workspaceTrusted, agentDir });
  const piIssues = piSettingsExists
    ? []
    : [`${piSettingsPath}: not found (pi defaults apply; use pi's /settings to create it)`];
  files.pi.push({ path: piSettingsPath, label: 'agent', exists: piSettingsExists });

  /* env */
  const envIssues = checkEnvKnobs(env);
  files.env.push({ path: '(process environment)', label: 'env', exists: true });

  /* roles: every layer's JSON must load; builtin names are intentionally shadow-proof */
  const roleIssues: string[] = [];
  const roleNames = new Set<string>();
  const layerCounts: string[] = [];
  for (const layer of roleLayers({ baseDir: cwd, userDir: deps.rolesUserDir })) {
    const names = listJsonFiles(layer.dir);
    const label: ConfigPlaneFile['label'] = layer.label.startsWith('workspace')
      ? 'workspace'
      : layer.label.startsWith('user') ? 'user' : 'builtin';
    files.roles.push({ path: layer.dir, label, exists: names.length > 0 });
    layerCounts.push(`${label} ${names.length}`);
    for (const file of names) roleNames.add(file.replace(/\.json$/, ''));
  }
  for (const name of [...roleNames].sort()) {
    try {
      loadRoleConfig(name, { baseDir: cwd });
    } catch (err) {
      const issues = (err as { issues?: readonly string[] }).issues ?? [];
      roleIssues.push(`role "${name}": ${err instanceof Error ? err.message : String(err)}${issues.length ? ` — ${issues.join('; ')}` : ''}`);
    }
  }
  const shadowed = listRoleNames(cwd, deps.rolesUserDir).filter((name) => RESERVED_ROLE_NAMES.includes(name));
  if (shadowed.length > 0) {
    roleIssues.push(`reserved role name(s) shadowed in a custom layer (ignored for built-ins): ${shadowed.join(', ')}`);
  }
  const roleSummary = `${roleNames.size} role(s): ${layerCounts.join(' / ')}`;

  /* boot-config: herdr plugin config dir → standard plugin dirs → dev checkout */
  const bootIssues: string[] = [];
  const bootCandidates: Array<{ path: string; label: string }> = [];
  if (herdrPluginConfigDir) bootCandidates.push({ path: join(herdrPluginConfigDir, 'boot-config.json'), label: 'herdr plugin config-dir' });
  // herdr does not always export HERDR_PLUGIN_CONFIG_DIR into the pi process, so production also
  // probes the standard plugin config locations. Tests inject env/herdrPluginConfigDir and stay hermetic.
  if (deps.herdrPluginConfigDir === undefined && deps.env === undefined) {
    for (const dir of defaultHerdrPluginConfigDirs(env)) {
      bootCandidates.push({ path: join(dir, 'boot-config.json'), label: 'herdr plugin config (default)' });
    }
  }
  bootCandidates.push({
    path: join(deps.repoRoot ?? defaultRepoRoot(), 'packages', 'pier-workbench', 'scripts', 'boot-config.json'),
    label: 'dev (repo)',
  });
  let bootFound: { path: string; label: string } | null = null;
  for (const candidate of bootCandidates) {
    const exists = existsSync(candidate.path);
    files.boot.push({ path: candidate.path, label: candidate.label, exists });
    if (exists && !bootFound) bootFound = candidate;
  }
  if (!bootFound) {
    bootIssues.push(`boot-config.json not found in: ${bootCandidates.map((c) => c.path).join(' , ')} (run \`npx pier-setup@latest install\`)`);
  } else {
    const parsed = readJsonLayer(bootFound.path);
    if (parsed.issue) {
      bootIssues.push(parsed.issue);
    } else {
      for (const key of ['piNode', 'piCli', 'extPath'] as const) {
        const value = readDotted(parsed.value, key);
        if (typeof value !== 'string' || value === '') {
          bootIssues.push(`${bootFound.path}: missing required key "${key}"`);
        } else if (!existsSync(value)) {
          // A stale absolute path is the most common post-reinstall breakage.
          bootIssues.push(`${bootFound.path}: "${key}" points to a path that does not exist: ${value} (stale after a reinstall? re-run \`npx pier-setup@latest update --force\`)`);
        }
      }
    }
  }
  const bootSummary = bootFound ? `present (${bootFound.label})` : 'missing (run pier-setup)';

  reports.push(
    { plane: 'efficiency', ok: efficiencyIssues.length === 0, issues: efficiencyIssues },
    { plane: 'roles', ok: roleIssues.length === 0, issues: roleIssues },
    { plane: 'pi', ok: true, issues: piIssues },
    { plane: 'boot', ok: bootIssues.length === 0, issues: bootIssues },
    { plane: 'env', ok: envIssues.length === 0, issues: envIssues },
  );
  const entries = [
    ...resolveConfigKnobs({ env, workspace: workspaceLayer.value, user: userLayer.value, workspaceTrusted, piSettings }),
    ...resolveEnvKnobs(env),
  ];
  return { entries, reports, files, workspaceTrusted, roleSummary, bootSummary };
}

/** Repo root of this checkout (works in-repo; in node_modules the probe simply finds nothing). */
function defaultRepoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

/* ── rendering used by the command ──────────────────────────────────────── */

export type GuideView = 'index' | 'check' | ConfigPlaneId | 'all';

/** Renders one `/pier-config` view: the plane index, one/all plane listings, or the check report. */
export function renderGuide(snapshot: ConfigGuideSnapshot, view: GuideView): string[] {
  if (view === 'index') {
    const plane = (id: ConfigPlaneId): readonly ResolvedKnob[] => snapshot.entries.filter((e) => e.knob.plane === id);
    return renderIndex({
      efficiency: plane('efficiency'),
      pi: plane('pi'),
      env: plane('env'),
      roleSummary: snapshot.roleSummary,
      bootSummary: snapshot.bootSummary,
    });
  }
  if (view === 'check') {
    const anyFail = snapshot.reports.some((r) => !r.ok);
    return [
      ...renderCheck(snapshot.reports),
      anyFail ? '  → fix the FAIL planes above (values are still shown by `show`)' : '  → all planes look consistent',
    ];
  }

  const out: string[] = [];
  for (const meta of CONFIG_PLANES) {
    if (view !== 'all' && meta.id !== view) continue;
    out.push(`${meta.id} — ${meta.title}`);
    for (const file of snapshot.files[meta.id]) {
      const status = file.exists ? (file.ignored ? 'present (IGNORED: untrusted project)' : 'present') : 'absent';
      out.push(`  file [${file.label}] ${file.path} — ${status}`);
    }
    out.push(`  hint: ${meta.editHint}`);
    const entries = snapshot.entries.filter((e) => e.knob.plane === meta.id);
    if (entries.length > 0) {
      out.push(...renderPlane(entries));
    } else {
      const report = snapshot.reports.find((r) => r.plane === meta.id);
      out.push(`  (per-file plane: ${!report ? 'no data' : report.ok ? 'no issues' : `${report.issues.length} issue(s) — see /pier-config check`})`);
    }
    out.push('');
  }
  return out;
}

export function guideReportMarkdown(
  snapshot: ConfigGuideSnapshot,
  meta: { generatedAt: string; cwd: string; piVersion?: string },
): string {
  const body = renderReport(snapshot.entries, {
    generatedAt: meta.generatedAt,
    cwd: meta.cwd,
    workspaceTrusted: snapshot.workspaceTrusted,
    piVersion: meta.piVersion,
  });
  const filesSection = ['', '## Files observed', ''];
  for (const plane of CONFIG_PLANES) {
    for (const file of snapshot.files[plane.id]) {
      const status = file.exists ? (file.ignored ? 'present, ignored (untrusted project)' : 'present') : 'absent';
      filesSection.push(`- [${plane.id}] ${file.label}: \`${file.path}\` — ${status}`);
    }
  }
  const checkSection = ['', '## Checks', '', ...renderGuide(snapshot, 'check').map((l) => `- ${l.trim()}`)];
  return `${body}\n${filesSection.join('\n')}\n${checkSection.join('\n')}\n`;
}

/* ── command ────────────────────────────────────────────────────────────── */

export interface ConfigCommandDeps {
  pi: ExtensionAPI;
  /** Injectable for tests; defaults to collectConfigSnapshot. */
  collect?: (deps: ConfigGuideDeps) => ConfigGuideSnapshot;
  /** Overridable so tests can pin the report destination. */
  reportDir?: (cwd: string) => string;
}

const PLANE_IDS: readonly ConfigPlaneId[] = CONFIG_PLANES.map((p) => p.id);
const SUBCOMMANDS = ['show', 'check', 'doc', 'doctor'] as const;

function parseArgs(args: unknown): { sub: (typeof SUBCOMMANDS)[number] | 'index'; rest: string } {
  const raw = typeof args === 'string'
    ? args.split(/\s+/).filter(Boolean)
    : Array.isArray(args) ? args.map(String) : [];
  const [first, ...rest] = raw;
  const sub = (SUBCOMMANDS as readonly string[]).includes(first ?? '')
    ? (first as (typeof SUBCOMMANDS)[number])
    : 'index';
  // `show` accepts an optional plane; an unknown first token is treated as the plane selector for `show`.
  const restJoined = sub === 'index' && first && first !== 'index' ? [first, ...rest].join(' ') : rest.join(' ');
  return { sub, rest: restJoined };
}

/** Registers `/pier-config`. Safe to call once per extension load (pi replaces commands by name). */
export function installConfigCommand(deps: ConfigCommandDeps): void {
  const { pi } = deps;
  const collect = deps.collect ?? collectConfigSnapshot;
  const reportDir = deps.reportDir ?? ((cwd: string) => join(cwd, '.pi-herdr'));

  pi.registerCommand('pier-config', {
    description:
      'Show pier configuration (5 planes) with effective values and sources; `check` validates them; `doctor` lists option values and swallowed errors; no argument hands a guided change to the agent',
    getArgumentCompletions: (prefix: string) => {
      const tokens = (prefix ?? '').split(/\s+/);
      const head = tokens[0] ?? '';
      if (tokens.length <= 1) {
        return ['show', 'check', 'doc', 'doctor', 'all', ...PLANE_IDS]
          .filter((c) => c.startsWith(head))
          .map((c) => ({ value: c, label: c, description: c === 'doc' ? 'write a config report file' : undefined }));
      }
      if (head === 'show') {
        const last = tokens[tokens.length - 1] ?? '';
        return ['all', ...PLANE_IDS].filter((c) => c.startsWith(last)).map((c) => ({ value: c, label: c }));
      }
      return null;
    },
    handler: async (args: string, ctx: ExtensionContext) => {
      const ui = (ctx as { ui?: { notify?: (text: string, level?: string) => void } }).ui;
      const emit = (text: string, level: 'info' | 'warning' | 'error' = 'info'): void => {
        if (ui?.notify) ui.notify(text, level);
        else console.log(text); // print/json and test modes have no UI surface
      };

      const cwd = (ctx as { cwd?: string }).cwd ?? process.cwd();
      const isProjectTrusted =
        typeof (ctx as { isProjectTrusted?: () => boolean }).isProjectTrusted === 'function'
          ? (ctx as { isProjectTrusted: () => boolean }).isProjectTrusted()
          : false;

      let snapshot: ConfigGuideSnapshot;
      try {
        snapshot = collect({ cwd, isProjectTrusted });
      } catch (err) {
        emit(`pier-config: failed to read configuration (${err instanceof Error ? err.message : String(err)})`, 'error');
        return;
      }

      const { sub, rest } = parseArgs(args);

      if (sub === 'check') {
        emit([`pier config check (workspace trusted: ${snapshot.workspaceTrusted})`, ...renderGuide(snapshot, 'check')].join('\n'));
        return;
      }

      if (sub === 'doc') {
        const target = rest ? (isAbsolute(rest) ? rest : resolve(cwd, rest)) : join(reportDir(cwd), 'config-report.md');
        try {
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(
            target,
            guideReportMarkdown(snapshot, { generatedAt: new Date().toISOString(), cwd, piVersion }),
            'utf8',
          );
          emit(
            `pier config report written: ${target}`
              + (rest ? '' : '  (add `.pi-herdr/config-report.md` to .gitignore if you do not want it tracked)'),
          );
        } catch (err) {
          emit(`pier-config: could not write report (${err instanceof Error ? err.message : String(err)})`, 'error');
        }
        return;
      }

      if (sub === 'doctor') {
        // B9/B10: one place to see every pier option (canonical name, effective value, source) and the
        // errors that were deliberately swallowed this session. Without it, a silently failing
        // best-effort path stays invisible until something else breaks.
        emit([
          'pier doctor',
          '',
          `wire: herdr protocol ${HERDR_PROTOCOL_EXPECTED} (pinned by test/fixtures/herdr-contract.json)`,
          '',
          'options (canonical PIER_*, legacy PI_HERDR_* alias accepted):',
          ...formatOptionRows(),
          '',
          formatSwallowedErrors(),
        ].join('\n'));
        return;
      }

      if (sub === 'show') {
        const plane = rest.trim();
        const selector = plane === '' || plane === 'all' ? 'all' : PLANE_IDS.find((id) => id === plane);
        if (!selector) {
          emit(`pier-config: unknown plane "${plane}" — expected one of ${PLANE_IDS.join(', ')} or all`, 'warning');
          return;
        }
        emit(renderGuide(snapshot, selector).join('\n'));
        return;
      }

      // Bare `/pier-config`: index + hand the guided change to the agent.
      emit([...renderGuide(snapshot, 'index'), '', 'asking the agent to guide the change...'].join('\n'));
      try {
        // Call on the receiver: the ExtensionAPI method must not be detached from `pi`.
        (pi as { sendMessage?: (msg: unknown, opts: unknown) => void }).sendMessage?.(
          { customType: 'pi-herdr.config-guide', content: CONFIG_GUIDANCE_PROMPT, display: false },
          { triggerTurn: true },
        );
      } catch (err) {
        emit(`pier-config: could not start the guided flow (${err instanceof Error ? err.message : String(err)})`, 'warning');
      }
    },
  });
}
