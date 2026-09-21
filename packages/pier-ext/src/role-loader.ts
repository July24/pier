/**
 * Role manifest loading, three layers in order: workspace `<cwd>/.pi-herdr/roles/` (travels with the clone)
 * → user `~/.pi/agent/herdr-pi/roles/` → bundled `src/roles/`.
 *
 * Reserved built-in names (master / worker-default) may not be overridden by a user layer: tests and the D82
 * stance are anchored to the bundled manifests.
 *
 * Role names are restricted to [a-z0-9-] (no path traversal; invalid names never touch disk) and the manifest
 * `role` field must match the filename. Errors: unreadable = ROLE_NOT_FOUND (only after every layer missed);
 * parsed-but-invalid JSON/validation/name = INVALID_ROLE_CONFIG at the hit layer — falling through would
 * silently hide a user editing a manifest incorrectly.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { validateRoleManifest, type RoleManifest } from './role-manifest.ts';
import { userRolesDir, workspaceRolesDir as layoutWorkspaceRolesDir } from './storage-layout.ts';

export { userRolesDir };

export const ROLES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'roles');

/** Workspace-level directory (the default base is the process cwd, i.e. the master's working directory). */
export function workspaceRolesDir(baseDir?: string): string {
  return layoutWorkspaceRolesDir(baseDir ?? process.cwd());
}

export const RESERVED_ROLE_NAMES: readonly string[] = ['master', 'worker-default'];

const ROLE_NAME_RE = /^[a-z0-9-]+$/;

export class RoleLoaderError extends Error {
  readonly code: 'ROLE_NOT_FOUND' | 'INVALID_ROLE_CONFIG' | 'ROLE_RESERVED';
  readonly issues: readonly string[];
  constructor(
    code: 'ROLE_NOT_FOUND' | 'INVALID_ROLE_CONFIG' | 'ROLE_RESERVED',
    message: string,
    issues: readonly string[] = [],
  ) {
    super(message);
    this.name = 'RoleLoaderError';
    this.code = code;
    this.issues = issues;
  }
}

export type RoleReader = (fileName: string) => string;

/** Single-layer reader (injectable; production uses existsSync + readFileSync for that directory). */
export type LayerReader = (dir: string, fileName: string) => string | null;

const defaultLayerRead: LayerReader = (dir, fileName) => {
  const p = resolve(dir, fileName);
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf8');
};

export interface LoadRoleOptions {
  /** Inject one reader (legacy shape: only the bundled layer is hit, for test compatibility). */
  read?: RoleReader;
  layerRead?: LayerReader;
  /** Base directory for the workspace layer (defaults to process.cwd()). */
  baseDir?: string;
  /** Direct built-in lookup (master self-application, WS-D7): reserved names skip user layers and
   *  collision checks and always load the bundled manifest — otherwise a workspace master.json could make
   *  self-application fail open and silently lose master's manifest. */
  builtinDirect?: boolean;
}

export function roleLayers(opts?: { baseDir?: string; userDir?: string }): Array<{ label: string; dir: string }> {
  const base = opts?.baseDir && isAbsolute(opts.baseDir) ? opts.baseDir
    : resolve(opts?.baseDir ?? process.cwd());
  return [
    { label: 'workspace (.pi-herdr/roles/)', dir: workspaceRolesDir(base) },
    // userDir lets tests isolate from the real ~/.pi.
    { label: `user (${'~/.pi/agent/herdr-pi/roles/'})`, dir: opts?.userDir ?? userRolesDir() },
    { label: 'builtin (src/roles/)', dir: ROLES_DIR },
  ];
}

  /** User-layer role names (workspace → user), deduped and sorted; built-ins are not listed — they are
   *  exactly RESERVED_ROLE_NAMES, which no user layer may override. */
export function listRoleNames(baseDir?: string, userDir?: string): string[] {
  const names = new Set<string>();
  for (const layer of roleLayers({ baseDir, userDir }).slice(0, 2)) {
    let entries: string[];
    try {
      entries = readdirSync(layer.dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.endsWith('.json')) names.add(entry.slice(0, -'.json'.length));
    }
  }
  return [...names].sort();
}

export function loadRoleConfig(name: string, opts?: LoadRoleOptions): RoleManifest {
  if (typeof name !== 'string' || !ROLE_NAME_RE.test(name)) {
    throw new RoleLoaderError('ROLE_NOT_FOUND', `role 不存在或名字非法（[a-z0-9-]+）: ${JSON.stringify(name)}`);
  }
  const fileName = `${name}.json`;

  if (opts?.read && !opts.layerRead) {
    let text: string;
    try {
      text = opts.read(fileName);
    } catch (err) {
      const code = (err as { code?: unknown })?.code;
      throw new RoleLoaderError('ROLE_NOT_FOUND', `role "${name}" 不存在（读 ${fileName} 失败: ${typeof code === 'string' ? code : 'error'}）`);
    }
    return parseAndValidate(name, fileName, text, 'builtin (src/roles/)');
  }

  const layerRead = opts?.layerRead ?? defaultLayerRead;
  let layers = roleLayers({ baseDir: opts?.baseDir });

  if (opts?.builtinDirect && RESERVED_ROLE_NAMES.includes(name)) {
    layers = [layers[2]];
  } else if (RESERVED_ROLE_NAMES.includes(name)) {
    for (const layer of layers.slice(0, 2)) {
      if (layerRead(layer.dir, fileName) != null) {
        throw new RoleLoaderError(
          'ROLE_RESERVED',
          `role "${name}" 是内置保留名，不能在 ${layer.label} 层定义（内置档案优先；请删除该档案或改名）`,
        );
      }
    }
  }

  for (const layer of layers) {
    const text = layerRead(layer.dir, fileName);
    if (text == null) continue; // No manifest in this layer; try the next layer.
    return parseAndValidate(name, fileName, text, layer.label); // At the hit layer, report errors immediately.
  }
  throw new RoleLoaderError(
    'ROLE_NOT_FOUND',
    `role "${name}" 不存在（查找层：${layers.map((l) => l.label).join(' → ')}）`,
  );
}

function parseAndValidate(name: string, fileName: string, text: string, layerLabel: string): RoleManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new RoleLoaderError('INVALID_ROLE_CONFIG', `role "${name}"（${layerLabel}）不是合法 JSON: ${(err as Error).message}`);
  }
  const result = validateRoleManifest(parsed);
  // `ok === false` (instead of `!ok`) is required to narrow without strictNullChecks.
  if (result.ok === false) {
    throw new RoleLoaderError(
      'INVALID_ROLE_CONFIG',
      `role "${name}"（${layerLabel}）校验失败:\n${result.issues.map((i) => `  - ${i}`).join('\n')}`,
      result.issues,
    );
  }
  if (result.value.role !== name) {
    throw new RoleLoaderError(
      'INVALID_ROLE_CONFIG',
      `role 档案名不符：${layerLabel} 的 ${fileName} 内 role="${result.value.role}"`,
      [`role 字段 "${result.value.role}" 与请求的 "${name}" 不一致`],
    );
  }
  return result.value;
}
