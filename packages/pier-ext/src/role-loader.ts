/**
 * 档2 Week1：role 档案加载器（2026-08-18）；v1.1（2026-08-22）两层用户目录。
 *
 * 查找序（v1.1，用户拍板）：
 *  1. workspace 级 `<cwd>/.pi-herdr/roles/<name>.json`（随 clone 走，团队共享）
 *  2. 用户全局 `~/.pi/agent/herdr-pi/roles/<name>.json`（跨仓库个人偏好）
 *  3. 内置 `src/roles/`（本包随附）兜底
 *
 * 内置名保留（master / worker-default）：用户/工作区层撞名直接拒绝——D83 镜像
 * 单测与 D82 姿态锚在内置档案上，被覆盖会破坏这些保证。
 *
 * 角色名白名单 [a-z0-9-]+ —— 防路径穿越（不合法名不触盘）。
 * 档案 role 字段必须与文件名一致（防错挂）。
 * 校验失败分类：读不到 = ROLE_NOT_FOUND（逐层尝试后才报）；读到了但
 * JSON/校验/名字不符 = INVALID_ROLE_CONFIG（**在命中层立即报**，不静默落到
 * 下一层——静默会掩盖用户改了档案却写错的问题）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { validateRoleManifest, type RoleManifest } from './role-manifest.ts';

/** 内置档案目录（src/roles/）。 */
export const ROLES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'roles');

/** workspace 级目录（相对基准默认 = 进程 cwd，即 master 的工作目录）。 */
export function workspaceRolesDir(baseDir?: string): string {
  return join(baseDir ?? process.cwd(), '.pi-herdr', 'roles');
}

/** 用户全局目录（~/.pi/agent/herdr-pi/roles/）。 */
export function userRolesDir(): string {
  return join(homedir(), '.pi', 'agent', 'herdr-pi', 'roles');
}

/** 内置保留名（不可被任何用户层覆盖）。 */
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

/** 单层读取器（注入式；生产 = existsSync + readFileSync 该目录）。 */
export type LayerReader = (dir: string, fileName: string) => string | null;

const defaultLayerRead: LayerReader = (dir, fileName) => {
  const p = resolve(dir, fileName);
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf8');
};

export interface LoadRoleOptions {
  /** 单 reader 注入（旧形态：仅命中内置层——测试兼容用）。 */
  read?: RoleReader;
  /** 多层 reader 注入（v1.1）。 */
  layerRead?: LayerReader;
  /** workspace 层基准目录（默认 process.cwd()）。 */
  baseDir?: string;
  /**
   * 内置名直读：master 自应用（WS-D7）专用——保留名跳过用户层与撞名检查，
   * 永远加载内置档案。否则 workspace 放 master.json 会让自应用 fail-open，
   * master 静默丢失 manifest（d11 活体抓到的边界）。
   */
  builtinDirect?: boolean;
}

/** 解析查找层序：workspace → 用户全局 → 内置（每层 {label, dir}）。 */
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

  // 旧形态单 reader：直接按内置层语义（既有单测/合成器注入路径不破）
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

  // 内置名直读（自应用）：只查内置层，不受用户层诱饵/撞名影响
  if (opts?.builtinDirect && RESERVED_ROLE_NAMES.includes(name)) {
    layers = [layers[2]];
  } else if (RESERVED_ROLE_NAMES.includes(name)) {
    // 内置名保留：workspace/用户层撞名 → 拒绝（spawn 侧响亮报错，不静默覆盖内置语义）
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
    if (text == null) continue; // 本层无此档案 → 下一层
    return parseAndValidate(name, fileName, text, layer.label); // 命中层：错误立即报
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
