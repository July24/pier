/**
 * 档2 Week1：role manifest 类型 + 校验器（D76 v2；2026-08-18）。
 *
 * 契约镜像 `schemas/role-manifest.schema.json`（JSON Schema 文件是合同文档，
 * 运行时用零依赖手写校验——不引 ajv，worker 侧不背包袱）。
 *
 * 严格契约：未知顶层键报 issue（防 "rulez" 类 typo 静默失效）；
 * 错误收集式（一次报全，便于修档案）。
 */
export type PermissionAction = 'allow' | 'ask' | 'deny';
export type TodosMode = 'serial' | 'parallel';
/** D82：未知工具姿态——可见性=信任关系（用户→master 凭 install；master→被委派凭镜像）。 */
export type UnknownToolStance = 'allow' | 'deny';

export interface RoleManifest {
  role: string;
  /** 语义版本 x.y.z（档案演化追溯；P2）。 */
  version: string;
  /**
   * WS-D10：按角色路由模型——`provider/model` 形态（advisor = 高级别第三方判断）。
   * 可省略 = 跟随进程默认（master/worker 不设）。spawn 时注入 `--provider/--model`。
   */
  model?: string;
  description?: string;
  manifest: {
    /** 基线工具（非空，必含 todo_write + ask_user_question——协调工具）。 */
    tools: string[];
    /** 三态权限；`*` 通配符默认；可省略 = `{"*":"allow"}`。 */
    rules?: Record<string, PermissionAction>;
    /**
     * D82 unknownTools：清单外工具的姿态（缺省 deny = 安全默认）。
     * master/worker = allow（用户安装的扩展默认可见可用——install 即授予）；
     * 自定义角色缺省 deny。与 rules 的 `*` 通配分属两轴：可见性 vs 强制力。
     * 排除族（如 worker 的 subagent/terminal）须显式 deny 才能在 allow 姿态下持禁令。
     */
    unknownTools?: UnknownToolStance;
  };
  services?: {
    todos?: {
      mode?: TodosMode;
    };
  };
}

export type ValidateResult =
  | { ok: true; value: RoleManifest }
  | { ok: false; code: 'INVALID_ROLE_CONFIG'; issues: string[] };

/** 所有角色必需的协调工具（C7 边界约束 1）。 */
export const COORDINATION_TOOLS = ['todo_write', 'ask_user_question'] as const;

const ROLE_NAME_RE = /^[a-z0-9-]+$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const TOOL_KEY_RE = /^[a-z0-9_*-]+$/;
const ACTIONS: readonly PermissionAction[] = ['allow', 'ask', 'deny'];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isPosInt(v: unknown): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

export function validateRoleManifest(input: unknown): ValidateResult {
  const issues: string[] = [];
  if (!isPlainObject(input)) {
    return { ok: false, code: 'INVALID_ROLE_CONFIG', issues: ['role 档案必须是 JSON 对象'] };
  }

  /* ── 顶层键 ── */
  const KNOWN_TOP = new Set(['role', 'version', 'model', 'description', 'manifest', 'services']);
  for (const k of Object.keys(input)) {
    if (!KNOWN_TOP.has(k)) issues.push(`未知顶层键 "${k}"（契约外字段，检查拼写）`);
  }

  /* ── role 名 ── */
  if (typeof input.role !== 'string' || !ROLE_NAME_RE.test(input.role)) {
    issues.push(`role 必须是 [a-z0-9-]+ 字符串，收到 ${JSON.stringify(input.role)}`);
  }

  /* ── version（P2 semver） ── */
  if (typeof input.version !== 'string' || !SEMVER_RE.test(input.version)) {
    issues.push(`version 必须是 x.y.z 三段数字（如 1.0.0），收到 ${JSON.stringify(input.version)}`);
  }

  /* ── model（WS-D10：provider/model 按角色路由；可选） ── */
  if (input.model !== undefined) {
    if (typeof input.model !== 'string' || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(input.model)) {
      issues.push(`model 必须是 provider/model 形态（如 opencode-go/muse-spark-1.2-contributor），收到 ${JSON.stringify(input.model)}`);
    }
  }

  /* ── description 可选 ── */
  if (input.description !== undefined && typeof input.description !== 'string') {
    issues.push('description 必须是字符串');
  }

  /* ── manifest ── */
  const m = input.manifest;
  if (!isPlainObject(m)) {
    issues.push('manifest 必须是对象');
  } else {
    const KNOWN_MANIFEST = new Set(['tools', 'rules', 'unknownTools']);
    for (const k of Object.keys(m)) {
      if (!KNOWN_MANIFEST.has(k)) issues.push(`manifest 内未知键 "${k}"`);
    }

    // D82 unknownTools：enum 校验，缺省 = deny（安全默认）
    if (m.unknownTools !== undefined && m.unknownTools !== 'allow' && m.unknownTools !== 'deny') {
      issues.push(`manifest.unknownTools 必须是 allow/deny，收到 ${JSON.stringify(m.unknownTools)}`);
    }

    // tools：字符串数组、无重复、非空、含协调工具（空数组也要报缺协调工具）
    const tools = m.tools;
    if (!Array.isArray(tools) || !tools.every((t) => typeof t === 'string' && TOOL_KEY_RE.test(t))) {
      issues.push('manifest.tools 必须是非空字符串数组（工具名 [a-z0-9_-]）');
    } else {
      const seen = new Set<string>();
      for (const t of tools) {
        if (seen.has(t)) issues.push(`manifest.tools 重复项 "${t}"`);
        seen.add(t);
      }
      for (const need of COORDINATION_TOOLS) {
        if (!seen.has(need)) issues.push(`基线非空约束：manifest.tools 必须包含 "${need}"（协调工具）`);
      }
    }

    // rules：三态值；键 = 工具名或 *
    if (m.rules !== undefined) {
      if (!isPlainObject(m.rules)) {
        issues.push('manifest.rules 必须是对象');
      } else {
        for (const [k, v] of Object.entries(m.rules)) {
          if (!TOOL_KEY_RE.test(k)) issues.push(`rules 键 "${k}" 不是合法工具名（[a-z0-9_-] 或 *）`);
          if (!ACTIONS.includes(v as PermissionAction)) {
            issues.push(`rules["${k}"] 必须是 ${ACTIONS.join('/')} 之一，收到 ${JSON.stringify(v)}`);
          }
        }
      }
    }
  }

  /* ── services ── */
  if (input.services !== undefined) {
    if (!isPlainObject(input.services)) {
      issues.push('services 必须是对象');
    } else if (input.services.todos !== undefined) {
      const t = input.services.todos;
      if (!isPlainObject(t)) {
        issues.push('services.todos 必须是对象');
      } else {
        if (t.mode !== undefined && t.mode !== 'serial' && t.mode !== 'parallel') {
          issues.push(`services.todos.mode 必须是 serial/parallel，收到 ${JSON.stringify(t.mode)}`);
        }
      }
    }
  }

  if (issues.length > 0) return { ok: false, code: 'INVALID_ROLE_CONFIG', issues };
  return { ok: true, value: input as unknown as RoleManifest };
}
