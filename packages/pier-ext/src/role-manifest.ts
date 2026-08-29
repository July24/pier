/**
 * Layer 2 Week 1: role manifest types and validator (D76 v2; 2026-08-18).
 *
 * Mirrors the contract in `schemas/role-manifest.schema.json` (the JSON Schema is the contract document;
 * runtime validation is hand-written with zero dependencies so workers carry no ajv overhead).
 *
 * Strict contract: report unknown top-level keys to prevent typos such as "rulez" from silently failing;
 * collect all errors in one pass so manifests can be repaired efficiently.
 */
export type PermissionAction = 'allow' | 'ask' | 'deny';
export type TodosMode = 'serial' | 'parallel';
/** D82: stance for unknown tools—visibility is a trust relationship (user→master via install; master→delegated via mirror). */
export type UnknownToolStance = 'allow' | 'deny';

export interface RoleManifest {
  role: string;
  /** Semantic version x.y.z (for tracing manifest evolution; P2). */
  version: string;
  /**
   * WS-D10: route models by role using `provider/model` (advisor delegates higher-level third-party judgment).
   * Omitted means follow the process default (master/worker leave it unset); spawn injects `--provider/--model`.
   */
  model?: string;
  description?: string;
  manifest: {
    /** Baseline tools (non-empty; must include todo_write + ask_user_question for coordination). */
    tools: string[];
    /** Three-state permissions; `*` supplies the default; omitted means `{"*":"allow"}`. */
    rules?: Record<string, PermissionAction>;
    /**
     * D82 unknownTools: stance for tools outside the manifest (default deny is the safe default).
     * master/worker = allow (user-installed extensions are visible and usable by default—install grants access);
     * custom roles default to deny. `*` in rules and this stance cover separate axes: visibility vs enforcement.
     * Excluded families (such as worker's subagent/terminal) need explicit deny to remain blocked under allow.
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

function isPosInt(v: unknown): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

export function validateRoleManifest(input: unknown): ValidateResult {
  const issues: string[] = [];
  if (!isPlainObject(input)) {
    return { ok: false, code: 'INVALID_ROLE_CONFIG', issues: ['role 档案必须是 JSON 对象'] };
  }

  /* ── Top-level keys ── */
  const KNOWN_TOP = new Set(['role', 'version', 'model', 'description', 'manifest', 'services']);
  for (const k of Object.keys(input)) {
    if (!KNOWN_TOP.has(k)) issues.push(`未知顶层键 "${k}"（契约外字段，检查拼写）`);
  }

  /* ── role name ── */
  if (typeof input.role !== 'string' || !ROLE_NAME_RE.test(input.role)) {
    issues.push(`role 必须是 [a-z0-9-]+ 字符串，收到 ${JSON.stringify(input.role)}`);
  }

  /* ── version (P2 semver) ── */
  if (typeof input.version !== 'string' || !SEMVER_RE.test(input.version)) {
    issues.push(`version 必须是 x.y.z 三段数字（如 1.0.0），收到 ${JSON.stringify(input.version)}`);
  }

  /* ── model (WS-D10: provider/model role routing; optional) ── */
  if (input.model !== undefined) {
    if (typeof input.model !== 'string' || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(input.model)) {
      issues.push(`model 必须是 provider/model 形态（如 opencode-go/muse-spark-1.2-contributor），收到 ${JSON.stringify(input.model)}`);
    }
  }

  /* ── optional description ── */
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

    // D82 unknownTools: enum validation; omitted means deny (safe default).
    if (m.unknownTools !== undefined && m.unknownTools !== 'allow' && m.unknownTools !== 'deny') {
      issues.push(`manifest.unknownTools 必须是 allow/deny，收到 ${JSON.stringify(m.unknownTools)}`);
    }

    // tools must be a unique, non-empty string array containing coordination tools; an empty array also reports the omissions.
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

    // rules accept three-state values; each key must be a tool name or *.
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
