/**
 * 档2 Week4-5：worker 执行期强制（2026-08-18；C7 v2 / D76）。
 *
 * master 合成的 manifest 经 env 下发后，这里是 worker 侧的最后一道闸：
 *  - `planToolGate`：工具不在 manifest / 权限 deny → deny（安全护栏）；
 *    ask → 标记（v1 退化：放行 + APPROVAL_NEEDED 日志，硬审批留 v2 拍板）；
 *  - `planActiveTools`（D77 可见层）：manifest 外的工具从模型视野移除——
 *    不进 system prompt、不诱导尝试（上下文卫生，不止权限）。
 * 限速机制已整体移除（WS-D6）：权限边界是我们的职责，资源配额是
 * 插件引入者/provider 的职责（D79 声明式引入，用户自负责）。
 * 纯逻辑零依赖；接缝在 index.ts 的 tool_call 钩子与 session_start。
 */
import type { PermissionAction, UnknownToolStance } from './role-manifest.ts';

/** env 下发的运行时形态（PI_HERDR_ROLE_MANIFEST JSON）。 */
export interface RuntimeRoleManifest {
  role: string;
  version?: string;
  tools: string[];
  permissions: Record<string, PermissionAction>;
  /** D82：未知工具姿态（缺省 deny = 安全默认）。 */
  unknownTools?: UnknownToolStance;
  services?: {
    todos?: {
      mode?: 'serial' | 'parallel';
    };
  };
}

/** 安全解析 PI_HERDR_ROLE_MANIFEST env（畸形 → null = 不强制，fail-open 到无角色态）。 */
export function parseRuntimeManifest(envValue: string | undefined): RuntimeRoleManifest | null {
  if (!envValue) return null;
  try {
    const m = JSON.parse(envValue) as RuntimeRoleManifest;
    if (!m || typeof m.role !== 'string' || !Array.isArray(m.tools)) return null;
    // D82 硬化：姿态非枚举值 → 收敛为 deny（安全默认），不整个丢弃 manifest
    if (m.unknownTools !== undefined && m.unknownTools !== 'allow' && m.unknownTools !== 'deny') {
      m.unknownTools = 'deny';
    }
    return m;
  } catch {
    return null;
  }
}

export type ToolGatePlan =
  | { kind: 'open' }
  | { kind: 'allow' }
  | { kind: 'ask'; notice: string }
  | { kind: 'deny'; reason: string };

export function planToolGate(toolName: string, manifest: RuntimeRoleManifest | null): ToolGatePlan {
  if (!manifest) return { kind: 'open' };
  const perm = manifest.permissions[toolName] ?? manifest.permissions['*'] ?? 'allow';
  const known = manifest.tools.includes(toolName);
  const stance = manifest.unknownTools ?? 'deny';
  // D82：deny 规则最高优先；未知工具按姿态（deny=拒，allow=按规则走，* 兜底）
  if (perm === 'deny' || (!known && stance === 'deny')) {
    return {
      kind: 'deny',
      reason:
        `role "${manifest.role}" does not permit tool "${toolName}" ` +
        `(manifest tools: ${manifest.tools.join(', ')}). ` +
        `If the task needs it, ask the master to delegate differently or adjust the role profile.`,
    };
  }
  if (perm === 'ask') {
    return { kind: 'ask', notice: `[APPROVAL_NEEDED] ${manifest.role}.${toolName}` };
  }
  return { kind: 'allow' };
}

/**
 * D77 可见层：计算 setActiveTools 的下一状态。
 * 交集语义（而非替换）——空交集返回 null（fail-open 保留现状），
 * 防"manifest 列了但插件没装"把工具集清空（如 web_search 装之前的 websearch 档案）。
 * 保持 currentActive 原顺序；与现状相同 → changed:false（调用方可跳过 set）。
 *
 * D82 姿态分支：unknownTools=allow → 不按 manifest 交集裁剪，只隐藏
 * permissions 中显式 deny 的工具（worker 排除族在继承制下仍不可见）；
 * 未知工具（用户装的扩展）保持可见。deny（缺省）→ 原交集语义。
 */
export function planActiveTools(
  manifestTools: string[],
  currentActive: string[],
  opts?: { unknownTools?: UnknownToolStance; permissions?: Record<string, PermissionAction> },
): { next: string[]; changed: boolean } | null {
  if (manifestTools.length === 0 || currentActive.length === 0) return null;
  if ((opts?.unknownTools ?? 'deny') === 'allow') {
    const denied = new Set(
      Object.entries(opts?.permissions ?? {})
        .filter(([, v]) => v === 'deny')
        .map(([k]) => k),
    );
    const next = currentActive.filter((t) => !denied.has(t));
    if (next.length === 0) return null;
    return { next, changed: next.length !== currentActive.length };
  }
  const wanted = new Set(manifestTools);
  const next = currentActive.filter((t) => wanted.has(t));
  if (next.length === 0) return null;
  const changed = next.length !== currentActive.length;
  return { next, changed };
}

