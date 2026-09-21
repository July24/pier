/**
 * Role manifest file format + validator; the contract document is `schemas/role-manifest.schema.json`.
 * Validation is hand-written with zero dependencies so workers carry no ajv overhead. Strict: unknown
 * top-level keys are reported (a typo like "rulez" must not silently fail) and every issue is
 * collected in one pass so a manifest can be repaired in one go.
 */
export type PermissionAction = 'allow' | 'ask' | 'deny';
export type TodosMode = 'serial' | 'parallel';
/** D82: stance for unknown tools—visibility is a trust relationship (user→master via install; master→delegated via mirror). */
export type UnknownToolStance = 'allow' | 'deny';

export interface RoleManifest {
  role: string;
  version: string;
  /** WS-D10: `provider/model` routing by role; omitted means follow the process default (spawn injects `--provider/--model`). */
  model?: string;
  description?: string;
  /** P0 per-role guidelines (RFC §4.6): constraints a tool set cannot express; injected as a prompt section. */
  guidelines?: string[];
  manifest: {
    tools: string[];
    /** Three-state permissions; `*` supplies the default; omitted means `{"*":"allow"}`. */
    rules?: Record<string, PermissionAction>;
    /**
     * D82 stance for tools outside the manifest (default deny; master/worker = allow — install grants
     * the user's extension access). Separate axis from `rules['*']`: visibility vs enforcement.
     * Excluded families (worker's subagent/terminal) need an explicit deny to stay blocked under allow.
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

/** Coordination tools required by every role (C7 boundary constraint 1). */
export const COORDINATION_TOOLS = ['todo_write', 'ask_user_question'] as const;

const ROLE_NAME_RE = /^[a-z0-9-]+$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const TOOL_KEY_RE = /^[a-z0-9_*-]+$/;
const ACTIONS: readonly PermissionAction[] = ['allow', 'ask', 'deny'];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function validateRoleManifest(input: unknown): ValidateResult {
  const issues: string[] = [];
  if (!isPlainObject(input)) {
    return { ok: false, code: 'INVALID_ROLE_CONFIG', issues: ['role 档案必须是 JSON 对象'] };
  }

  const KNOWN_TOP = new Set(['role', 'version', 'model', 'description', 'guidelines', 'manifest', 'services']);
  for (const k of Object.keys(input)) {
    if (!KNOWN_TOP.has(k)) issues.push(`未知顶层键 "${k}"（契约外字段，检查拼写）`);
  }

  if (typeof input.role !== 'string' || !ROLE_NAME_RE.test(input.role)) {
    issues.push(`role 必须是 [a-z0-9-]+ 字符串，收到 ${JSON.stringify(input.role)}`);
  }

  if (typeof input.version !== 'string' || !SEMVER_RE.test(input.version)) {
    issues.push(`version 必须是 x.y.z 三段数字（如 1.0.0），收到 ${JSON.stringify(input.version)}`);
  }

  if (input.model !== undefined) {
    if (typeof input.model !== 'string' || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(input.model)) {
      issues.push(`model 必须是 provider/model 形态（如 opencode-go/muse-spark-1.2-contributor），收到 ${JSON.stringify(input.model)}`);
    }
  }

  if (input.description !== undefined && typeof input.description !== 'string') {
    issues.push('description 必须是字符串');
  }

  if (input.guidelines !== undefined) {
    if (!Array.isArray(input.guidelines)) {
      issues.push('guidelines 必须是字符串数组');
    } else if (input.guidelines.length === 0) {
      issues.push('guidelines 为空数组时请直接省略该字段');
    } else if (!input.guidelines.every((g) => typeof g === 'string' && g.trim() !== '')) {
      issues.push('guidelines 的每一项必须是非空字符串');
    } else if (input.guidelines.length > 20) {
      issues.push('guidelines 最多 20 条（prompt 预算保护）');
    }
  }

  const m = input.manifest;
  if (!isPlainObject(m)) {
    issues.push('manifest 必须是对象');
  } else {
    const KNOWN_MANIFEST = new Set(['tools', 'rules', 'unknownTools']);
    for (const k of Object.keys(m)) {
      if (!KNOWN_MANIFEST.has(k)) issues.push(`manifest 内未知键 "${k}"`);
    }

    if (m.unknownTools !== undefined && m.unknownTools !== 'allow' && m.unknownTools !== 'deny') {
      issues.push(`manifest.unknownTools 必须是 allow/deny，收到 ${JSON.stringify(m.unknownTools)}`);
    }

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
