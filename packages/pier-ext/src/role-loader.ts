/**
 * Layer 2 Week 1: load role manifests (2026-08-18); v1.1 (2026-08-22) adds two user-directory layers.
 *
 * Lookup order (v1.1, user-approved):
 *  1. Workspace-level `<cwd>/.pi-herdr/roles/<name>.json` (travels with the clone and is team-shared)
 *  2. User-global `~/.pi/agent/herdr-pi/roles/<name>.json` (personal preference across repositories)
 *  3. Bundled `src/roles/` as the fallback shipped with this package
 *
 * Built-in names remain reserved (master / worker-default): reject collisions in user/workspace layers—D83 mirror.
 * Tests and the D82 stance are anchored to bundled manifests; allowing overrides would break those guarantees.
 *
 * Role names are restricted to [a-z0-9-]—this prevents path traversal and avoids touching disk for invalid names.
 * The manifest role field must match the filename to prevent attaching the wrong manifest.
 * Validation failures are classified as: unreadable = ROLE_NOT_FOUND (reported only after trying every layer);
 * parsed but invalid JSON/validation/name = INVALID_ROLE_CONFIG (report immediately at the hit layer rather than
 * silently falling through, because silence would hide a user editing a manifest incorrectly).
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { validateRoleManifest, type RoleManifest } from './role-manifest.ts';
import { userRolesDir, workspaceRolesDir as layoutWorkspaceRolesDir } from './storage-layout.ts';

export { userRolesDir };

/** Bundled manifest directory (`src/roles/`). */
export const ROLES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'roles');

/** Workspace-level directory (the default base is the process cwd, i.e. the master's working directory). */
export function workspaceRolesDir(baseDir?: string): string {
  return layoutWorkspaceRolesDir(baseDir ?? process.cwd());
}

/** Reserved built-in names (no user layer may override them). */
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
  /** Inject layered readers (v1.1). */
  layerRead?: LayerReader;
  /** Base directory for the workspace layer (defaults to process.cwd()). */
  baseDir?: string;
  /**
   * Direct built-in lookup: used by master's self-application (WS-D7). Reserved names skip user layers and
   * collision checks and always load the bundled manifest. Otherwise, a workspace master.json could cause
   * self-application to fail open and silently lose master's manifest (the boundary caught by d11 live testing).
   */
  builtinDirect?: boolean;
}

/** Resolve lookup layers in order: workspace → user-global → bundled (each layer has {label, dir}). */
export function roleLayers(opts?: { baseDir?: string }): Array<{ label: string; dir: string }> {
  const base = opts?.baseDir && isAbsolute(opts.baseDir) ? opts.baseDir
    : resolve(opts?.baseDir ?? process.cwd());
  return [
    { label: 'workspace (.pi-herdr/roles/)', dir: workspaceRolesDir(base) },
    { label: `user (${'~/.pi/agent/herdr-pi/roles/'})`, dir: userRolesDir() },
    { label: 'builtin (src/roles/)', dir: ROLES_DIR },
  ];
}

export function loadRoleConfig(name: string, opts?: LoadRoleOptions): RoleManifest {
  if (typeof name !== 'string' || !ROLE_NAME_RE.test(name)) {
    throw new RoleLoaderError('ROLE_NOT_FOUND', `role 不存在或名字非法（[a-z0-9-]+）: ${JSON.stringify(name)}`);
  }
  const fileName = `${name}.json`;

  // Legacy single reader: use bundled-layer semantics so existing tests/composer injection paths remain intact.
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

  // Direct built-in lookup (self-application): inspect only the bundled layer, ignoring user-layer bait/collisions.
  if (opts?.builtinDirect && RESERVED_ROLE_NAMES.includes(name)) {
    layers = [layers[2]];
  } else if (RESERVED_ROLE_NAMES.includes(name)) {
    // Reserved built-in name: reject workspace/user collisions instead of silently overriding built-in semantics.
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
  if (!result.ok) {
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
