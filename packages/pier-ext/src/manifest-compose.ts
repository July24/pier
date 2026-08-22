/**
 * 档2 Week2-3：manifest 三态合成（C7 v2；2026-08-18）。
 *
 * `manifest.tools = (roleBaseline ∪ modelSuggested) \ {tool | rule(tool) = deny}`
 * `manifest.permissions[tool] = rule(tool) ?? rule['*'] ?? 'allow'`
 *
 * 规则最高优先（安全护栏不可被模型建议绕过）；deny 排除、ask 标记、allow 放行；
 * 合成后为空 = 配置错误（EMPTY_MANIFEST，防 deny-all trap，照抄 DSH 纪律）；
 * 基线为空 = INVALID_ROLE_CONFIG（协调工具强制，档案级校验在 role-manifest.ts）。
 * 排序确定（便于测试与缓存比较）。
 */
import type { PermissionAction, RoleManifest, UnknownToolStance } from './role-manifest.ts';
import { loadRoleConfig } from './role-loader.ts';

export interface ManifestSources {
  roleBaseline: readonly string[];
  modelSuggested: readonly string[];
  rulePermissions: Record<string, PermissionAction>;
  /** D82：未知工具姿态（缺省 deny）。 */
  unknownTools?: UnknownToolStance;
}

export interface ComposedManifest {
  tools: string[];
  permissions: Record<string, PermissionAction>;
  /** D82：解析后的未知工具姿态（缺省 deny）。 */
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
  // D82：规则键全量并入 permissions（含 deny 与基线外的排除族）——
  // stance=allow 下闸门/可见层仍能对排除族持禁令（deny 记忆不丢）。
  for (const [k, v] of Object.entries(rules)) {
    if (k === '*') continue; // 通配是默认值不是逐工具记录
    permissions[k] = v;
  }
  for (const tool of candidates) {
    const action = rules[tool] ?? defaultAction;
    permissions[tool] = action;
    if (action === 'deny') continue; // 安全护栏：不进 manifest.tools
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

  tools.sort(); // 确定性
  return { tools, permissions, unknownTools: stance };
}

/**
 * 端到端：档案名 → loadRoleConfig → 合成（显式 tools/rules 即全部语义；
 * roleType 自动约束已随 WS-D8 移除——"不配发即禁止"由 tools 列表本身表达）。
 * master 侧 subagent 工具的调用缝；loadRole 可注入（测试替身）。
 */
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
