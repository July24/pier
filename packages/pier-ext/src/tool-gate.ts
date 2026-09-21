/**
 * Worker execution enforcement (C7, D76/D77/D82) — pure.
 *
 * RuntimeRoleManifest is THE runtime manifest shape: the file-format shape lives in
 * role-manifest.ts, the composed/persisted shapes derive from this one (see
 * manifest-compose.ts and role-state.ts).
 */
import type { PermissionAction, UnknownToolStance } from './role-manifest.ts';

export interface RuntimeRoleManifest {
  role: string;
  version?: string;
  tools: string[];
  permissions: Record<string, PermissionAction>;
  /** D82: stance for tools outside `tools`; 'allow' keeps user-installed extensions visible. */
  unknownTools?: UnknownToolStance;
  services?: {
    todos?: {
      mode?: 'serial' | 'parallel';
    };
  };
  /** P0 per-role guidelines (RFC §4.6): injected as a `pier-role` prompt section each turn. */
  guidelines?: string[];
}

/** Parse the env-carried manifest; malformed input is null (fail-open: no gate) rather than a crash. */
export function parseRuntimeManifest(envValue: string | undefined): RuntimeRoleManifest | null {
  if (!envValue) return null;
  try {
    const m = JSON.parse(envValue) as RuntimeRoleManifest;
    if (!m || typeof m.role !== 'string' || !Array.isArray(m.tools)) return null;
    if (m.unknownTools !== undefined && m.unknownTools !== 'allow' && m.unknownTools !== 'deny') {
      m.unknownTools = 'deny';
    }
    if (m.guidelines !== undefined) {
      m.guidelines = Array.isArray(m.guidelines)
        ? m.guidelines.filter((g) => typeof g === 'string' && g.trim() !== '')
        : undefined;
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
 * Filter `universe` down to what the stance exposes: 'allow' keeps every tool but the explicit
 * deny rules (D82 user-installed-extension axis), 'deny' intersects with the manifest.
 * Shared by planActiveTools (visibility) and role-state's switch planning (all-tools universe).
 */
export function filterToolsByStance(
  manifestTools: readonly string[],
  universe: readonly string[],
  opts?: { unknownTools?: UnknownToolStance; permissions?: Record<string, PermissionAction> },
): string[] {
  if ((opts?.unknownTools ?? 'deny') === 'allow') {
    const denied = new Set(
      Object.entries(opts?.permissions ?? {})
        .filter(([, action]) => action === 'deny')
        .map(([name]) => name),
    );
    return universe.filter((name) => !denied.has(name));
  }
  const wanted = new Set(manifestTools);
  return universe.filter((name) => wanted.has(name));
}

/** Null means "keep the current active set": an empty result must never clear every tool (D77). */
export function planActiveTools(
  manifestTools: readonly string[],
  currentActive: readonly string[],
  opts?: { unknownTools?: UnknownToolStance; permissions?: Record<string, PermissionAction> },
): { next: string[]; changed: boolean } | null {
  if (manifestTools.length === 0 || currentActive.length === 0) return null;
  const next = filterToolsByStance(manifestTools, currentActive, opts);
  if (next.length === 0) return null;
  return { next, changed: next.length !== currentActive.length };
}
