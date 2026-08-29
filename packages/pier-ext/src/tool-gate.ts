/** Why: Preserve the established compatibility and safety behavior (C7, D76, D77, D79, WS-D6). */
import type { PermissionAction, UnknownToolStance } from './role-manifest.ts';

/** Why: Preserve the established compatibility and safety behavior. */
export interface RuntimeRoleManifest {
  role: string;
  version?: string;
  tools: string[];
  permissions: Record<string, PermissionAction>;
  /** Why: Preserve the established compatibility and safety behavior (D82). */
  unknownTools?: UnknownToolStance;
  services?: {
    todos?: {
      mode?: 'serial' | 'parallel';
    };
  };
}

/** Why: Preserve the established compatibility and safety behavior. */
export function parseRuntimeManifest(envValue: string | undefined): RuntimeRoleManifest | null {
  if (!envValue) return null;
  try {
    const m = JSON.parse(envValue) as RuntimeRoleManifest;
    if (!m || typeof m.role !== 'string' || !Array.isArray(m.tools)) return null;
    // Why: Preserve the established compatibility and safety behavior (D82).
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
  // Why: Preserve the established compatibility and safety behavior (D82).
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

/** Why: Preserve the established compatibility and safety behavior (D77, D82). */
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

