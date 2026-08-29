/** Why: Preserve the established compatibility and safety behavior (C7). */
import type { PermissionAction, RoleManifest, UnknownToolStance } from './role-manifest.ts';
import { loadRoleConfig } from './role-loader.ts';

export interface ManifestSources {
  roleBaseline: readonly string[];
  modelSuggested: readonly string[];
  rulePermissions: Record<string, PermissionAction>;
  /** Why: Preserve the established compatibility and safety behavior (D82). */
  unknownTools?: UnknownToolStance;
}

export interface ComposedManifest {
  tools: string[];
  permissions: Record<string, PermissionAction>;
  /** Why: Preserve the established compatibility and safety behavior (D82). */
  unknownTools: UnknownToolStance;
}

export class ManifestError extends Error {
  readonly code: 'EMPTY_MANIFEST' | 'INVALID_ROLE_CONFIG';
  constructor(code: 'EMPTY_MANIFEST' | 'INVALID_ROLE_CONFIG', message: string) {
    super(message);
    this.name = 'ManifestError';
    this.code = code;
  }
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
  const stance: UnknownToolStance = sources.unknownTools ?? 'deny';

  const tools: string[] = [];
  const permissions: Record<string, PermissionAction> = {};
  // Why: Preserve the established compatibility and safety behavior (D82).
  // Why: Preserve the established compatibility and safety behavior.
  for (const [k, v] of Object.entries(rules)) {
    if (k === '*') continue; // Why: Preserve the established compatibility and safety behavior.
    permissions[k] = v;
  }
  for (const tool of candidates) {
    const action = rules[tool] ?? defaultAction;
    permissions[tool] = action;
    if (action === 'deny') continue; // Why: Preserve the established compatibility and safety behavior.
    tools.push(tool);
  }

  if (tools.length === 0) {
    throw new ManifestError(
      'EMPTY_MANIFEST',
      `裁剪后 manifest 为空（deny-all trap？）。基线: ${baseline.join(', ') || '(空)'}；` +
        `模型建议: ${sources.modelSuggested.join(', ') || '(无)'}；` +
        `规则: ${JSON.stringify(rules)}`,
    );
  }

  tools.sort(); // Why: Preserve the established compatibility and safety behavior.
  return { tools, permissions, unknownTools: stance };
}

/** Why: Preserve the established compatibility and safety behavior (WS-D8). */
export function composeForRole(
  roleName: string,
  modelSuggested: readonly string[],
  opts?: { loadRole?: typeof loadRoleConfig; loadRoleOpts?: Parameters<typeof loadRoleConfig>[1] },
): { role: RoleManifest; manifest: ComposedManifest } {
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
