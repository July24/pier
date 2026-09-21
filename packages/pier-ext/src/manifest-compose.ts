/**
 * Manifest composition (C7 v2 three-state permissions): role baseline ∪ model suggestion,
 * minus deny rules, with the D82 unknown-tools stance carried through.
 */
import type { PermissionAction, RoleManifest, UnknownToolStance } from './role-manifest.ts';
import type { RuntimeRoleManifest } from './tool-gate.ts';
import { loadRoleConfig } from './role-loader.ts';

export interface ManifestSources {
  roleBaseline: readonly string[];
  modelSuggested: readonly string[];
  rulePermissions: Record<string, PermissionAction>;
  /** D82: stance for tools outside the composed set. */
  unknownTools?: UnknownToolStance;
}

/** What composeManifest produces: the runtime manifest minus the identity/section fields. */
export type ComposedManifest = Omit<RuntimeRoleManifest, 'role' | 'version' | 'services' | 'guidelines'>;

export class ManifestError extends Error {
  readonly code: 'EMPTY_MANIFEST' | 'INVALID_ROLE_CONFIG';
  constructor(code: 'EMPTY_MANIFEST' | 'INVALID_ROLE_CONFIG', message: string) {
    super(message);
    this.name = 'ManifestError';
    this.code = code;
  }
}

export interface ComposedForRole {
  role: RoleManifest;
  manifest: ComposedManifest;
}

export function composeManifest(sources: ManifestSources): ComposedManifest {
  const baseline = sources.roleBaseline.filter((t): t is string => typeof t === 'string' && t.trim() !== '');
  if (baseline.length === 0) {
    throw new ManifestError(
      'INVALID_ROLE_CONFIG',
      'INVALID_ROLE_CONFIG: 基线工具不能为空，至少需包含 todo_write 和 ask_user_question',
    );
  }
  const candidates = new Set<string>([
    ...baseline,
    ...sources.modelSuggested.filter((t): t is string => typeof t === 'string' && t.trim() !== ''),
  ]);
  const rules = sources.rulePermissions ?? {};
  const defaultAction: PermissionAction = rules['*'] ?? 'allow';

  const tools: string[] = [];
  const permissions: Record<string, PermissionAction> = {};
  // Rule keys outside the candidate set stay in permissions: an allow-stance role keeps its
  // deny rules for tools the model never suggested (D82 excluded families).
  for (const [key, action] of Object.entries(rules)) {
    if (key !== '*') permissions[key] = action;
  }
  for (const tool of candidates) {
    const action = rules[tool] ?? defaultAction;
    permissions[tool] = action;
    if (action !== 'deny') tools.push(tool);
  }

  if (tools.length === 0) {
    throw new ManifestError(
      'EMPTY_MANIFEST',
      `裁剪后 manifest 为空（deny-all trap？）。基线: ${baseline.join(', ') || '(空)'}；` +
        `模型建议: ${sources.modelSuggested.join(', ') || '(无)'}；` +
        `规则: ${JSON.stringify(rules)}`,
    );
  }

  tools.sort();
  return { tools, permissions, unknownTools: sources.unknownTools ?? 'deny' };
}

export function composeForRole(
  roleName: string,
  modelSuggested: readonly string[],
  opts?: { loadRole?: typeof loadRoleConfig; loadRoleOpts?: Parameters<typeof loadRoleConfig>[1] },
): ComposedForRole {
  const load = opts?.loadRole ?? loadRoleConfig;
  const role = load(roleName, opts?.loadRoleOpts);
  const manifest = composeManifest({
    roleBaseline: role.manifest.tools,
    modelSuggested,
    rulePermissions: role.manifest.rules ?? { '*': 'allow' },
    unknownTools: role.manifest.unknownTools,
  });
  return { role, manifest };
}

/** Project a composed profile onto the runtime shape — the one place role-file fields become runtime fields. */
export function toRuntimeManifest(composed: ComposedForRole): RuntimeRoleManifest {
  const { role, manifest } = composed;
  return {
    role: role.role,
    version: role.version,
    tools: manifest.tools,
    permissions: manifest.permissions,
    unknownTools: manifest.unknownTools,
    services: role.services ?? {},
    ...(role.guidelines?.length ? { guidelines: role.guidelines } : {}),
  };
}
