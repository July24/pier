/**
 * Role manifest file format + validator; the contract document is `schemas/role-manifest.schema.json`.
 * Validation is hand-written with zero dependencies so workers carry no ajv overhead. Strict: unknown
 * top-level keys are reported (a typo like "rulez" must not silently fail) and every issue is
 * collected in one pass so a manifest can be repaired in one go.
 */
import { isPlainObject } from './guards.ts';

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


export function validateRoleManifest(input: unknown): ValidateResult {
  const issues: string[] = [];
  if (!isPlainObject(input)) {
    return { ok: false, code: 'INVALID_ROLE_CONFIG', issues: ['role manifest must be a JSON object'] };
  }

  const KNOWN_TOP = new Set(['role', 'version', 'model', 'description', 'guidelines', 'manifest', 'services']);
  for (const k of Object.keys(input)) {
    if (!KNOWN_TOP.has(k)) issues.push(`unknown top-level key "${k}" (not in the contract; check spelling)`);
  }

  if (typeof input.role !== 'string' || !ROLE_NAME_RE.test(input.role)) {
    issues.push(`role must be a [a-z0-9-]+ string, got ${JSON.stringify(input.role)}`);
  }

  if (typeof input.version !== 'string' || !SEMVER_RE.test(input.version)) {
    issues.push(`version must be three dot-separated numbers x.y.z (e.g. 1.0.0), got ${JSON.stringify(input.version)}`);
  }

  if (input.model !== undefined) {
    if (typeof input.model !== 'string' || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(input.model)) {
      issues.push(`model must be in provider/model form (e.g. opencode-go/muse-spark-1.2-contributor), got ${JSON.stringify(input.model)}`);
    }
  }

  if (input.description !== undefined && typeof input.description !== 'string') {
    issues.push('description must be a string');
  }

  if (input.guidelines !== undefined) {
    if (!Array.isArray(input.guidelines)) {
      issues.push('guidelines must be an array of strings');
    } else if (input.guidelines.length === 0) {
      issues.push('omit guidelines entirely instead of passing an empty array');
    } else if (!input.guidelines.every((g) => typeof g === 'string' && g.trim() !== '')) {
      issues.push('every guidelines entry must be a non-empty string');
    } else if (input.guidelines.length > 20) {
      issues.push('at most 20 guidelines (prompt budget protection)');
    }
  }

  const m = input.manifest;
  if (!isPlainObject(m)) {
    issues.push('manifest must be an object');
  } else {
    const KNOWN_MANIFEST = new Set(['tools', 'rules', 'unknownTools']);
    for (const k of Object.keys(m)) {
      if (!KNOWN_MANIFEST.has(k)) issues.push(`unknown key "${k}" in manifest`);
    }

    if (m.unknownTools !== undefined && m.unknownTools !== 'allow' && m.unknownTools !== 'deny') {
      issues.push(`manifest.unknownTools must be allow/deny, got ${JSON.stringify(m.unknownTools)}`);
    }

    const tools = m.tools;
    if (!Array.isArray(tools) || !tools.every((t) => typeof t === 'string' && TOOL_KEY_RE.test(t))) {
      issues.push('manifest.tools must be a non-empty array of strings (tool names [a-z0-9_-])');
    } else {
      const seen = new Set<string>();
      for (const t of tools) {
        if (seen.has(t)) issues.push(`duplicate entry in manifest.tools "${t}"`);
        seen.add(t);
      }
      for (const need of COORDINATION_TOOLS) {
        if (!seen.has(need)) issues.push(`non-empty baseline constraint: manifest.tools must include "${need}" (coordination tool)`);
      }
    }

    if (m.rules !== undefined) {
      if (!isPlainObject(m.rules)) {
        issues.push('manifest.rules must be an object');
      } else {
        for (const [k, v] of Object.entries(m.rules)) {
          if (!TOOL_KEY_RE.test(k)) issues.push(`rules key "${k}" is not a valid tool name ([a-z0-9_-] or *)`);
          if (!ACTIONS.includes(v as PermissionAction)) {
            issues.push(`rules["${k}"] must be one of ${ACTIONS.join('/')}, got ${JSON.stringify(v)}`);
          }
        }
      }
    }
  }

  if (input.services !== undefined) {
    if (!isPlainObject(input.services)) {
      issues.push('services must be an object');
    } else if (input.services.todos !== undefined) {
      const t = input.services.todos;
      if (!isPlainObject(t)) {
        issues.push('services.todos must be an object');
      } else {
        if (t.mode !== undefined && t.mode !== 'serial' && t.mode !== 'parallel') {
          issues.push(`services.todos.mode must be serial/parallel, got ${JSON.stringify(t.mode)}`);
        }
      }
    }
  }

  if (issues.length > 0) return { ok: false, code: 'INVALID_ROLE_CONFIG', issues };
  return { ok: true, value: input as unknown as RoleManifest };
}
