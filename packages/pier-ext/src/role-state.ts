/**
 * P0 (RFC docs/rfc-pi-0.86-dynamic-tools.md §4): mutable role state for mid-session switching. pi
 * 0.86 records `setActiveTools` deltas in the transcript, so a switch survives resume and branch
 * navigation; this module owns pier's half — replaying the gate manifest from the last
 * `pi-herdr.role-manifest` entry and planning the active-set transition.
 */
import type { PermissionAction, UnknownToolStance } from './role-manifest.ts';
import type { RuntimeRoleManifest } from './tool-gate.ts';
import { filterToolsByStance } from './tool-gate.ts';

/**
 * Shape persisted in ROLE_MANIFEST_CUSTOM_TYPE entries: the runtime manifest plus the payload
 * version and the switch provenance. `version` is the payload discriminator and `manifestVersion`
 * the manifest semver — replay must not confuse the two.
 */
export type RoleManifestRecord = Omit<RuntimeRoleManifest, 'version'> & {
  version: 1;
  manifestVersion?: string;
  /** 'switch' records a mid-session switch; the session_start anchor write omits it (env origin). */
  origin?: 'switch';
  switchedBy?: string;
  ts?: number;
};

/** State carried across a process for the armed role system; manifest==null means unarmed (bare pi). */
export interface RoleState {
  manifest: RuntimeRoleManifest | null;
  origin: 'env' | 'switch';
  switchedBy: string | null;
  switchedAt: number | null;
}

export function initialRoleState(manifest: RuntimeRoleManifest | null): RoleState {
  return { manifest, origin: 'env', switchedBy: null, switchedAt: null };
}

/**
 * Last `pi-herdr.role-manifest` record on the branch, or null. Session entries are pi JSONL
 * objects ({ type: 'custom', customType, data }); unknown shapes are skipped, not fatal —
 * replay must never break session startup.
 */
export function latestRoleManifestRecord(entries: readonly unknown[]): RoleManifestRecord | null {
  let found: RoleManifestRecord | null = null;
  for (const raw of entries) {
    const entry = raw as { type?: unknown; customType?: unknown; data?: unknown };
    if (entry?.type !== 'custom' || entry.customType !== 'pi-herdr.role-manifest') continue;
    const data = entry.data as Partial<RoleManifestRecord> | undefined;
    if (
      !data ||
      typeof data.role !== 'string' ||
      !Array.isArray(data.tools) ||
      !data.tools.every((t) => typeof t === 'string')
    ) {
      continue;
    }
    const guidelines = Array.isArray(data.guidelines)
      ? data.guidelines.filter((g): g is string => typeof g === 'string')
      : [];
    const rawPermissions = data.permissions;
    found = {
      version: 1,
      role: data.role,
      manifestVersion: typeof data.manifestVersion === 'string' ? data.manifestVersion : undefined,
      tools: data.tools as string[],
      permissions:
        rawPermissions && typeof rawPermissions === 'object' && !Array.isArray(rawPermissions)
          ? (rawPermissions as RuntimeRoleManifest['permissions'])
          : {},
      unknownTools: data.unknownTools === 'allow' ? 'allow' : 'deny',
      guidelines: guidelines.length > 0 ? guidelines : undefined,
      origin: data.origin === 'switch' ? 'switch' : undefined,
      switchedBy: typeof data.switchedBy === 'string' ? data.switchedBy : undefined,
      ts: typeof data.ts === 'number' ? data.ts : undefined,
    };
  }
  return found;
}

/** Rebuild a runtime manifest from a persisted record (resume replay path). */
export function manifestFromRecord(rec: RoleManifestRecord): RuntimeRoleManifest {
  return {
    role: rec.role,
    version: rec.manifestVersion,
    tools: rec.tools,
    permissions: rec.permissions,
    unknownTools: rec.unknownTools,
    ...(rec.guidelines && rec.guidelines.length > 0 ? { guidelines: rec.guidelines } : {}),
  };
}

/** Whether the record differs from the state that would be written now (drives change-only writes). */
export function roleRecordDiffers(rec: RoleManifestRecord | null, state: RoleState): boolean {
  const m = state.manifest;
  if (!m) return false;
  if (!rec) return true;
  return rec.role !== m.role || JSON.stringify(rec.tools) !== JSON.stringify(m.tools);
}

/** Switch plan: widening (needs human confirm when driven by /pier-role) + diff summary. */
export interface RoleSwitchPlan {
  widening: boolean;
  added: string[];
  removed: string[];
}

export function planRoleSwitch(oldTools: readonly string[], newTools: readonly string[]): RoleSwitchPlan {
  const oldSet = new Set(oldTools);
  const newSet = new Set(newTools);
  const added = newTools.filter((t) => !oldSet.has(t));
  const removed = oldTools.filter((t) => !newSet.has(t));
  return { widening: added.length > 0, added, removed };
}

/**
 * Active set for a switch, over ALL registered tools rather than the current active set: a switch
 * may re-admit tools an earlier session_start prune removed, which intersection semantics would
 * lose. Stance handling is shared with planActiveTools (tool-gate.ts); the empty result is NOT a
 * no-op here — a switch to a role with no overlap is a legitimate shrink.
 */
export function planSwitchActiveTools(
  manifestTools: readonly string[],
  registeredToolNames: readonly string[],
  opts?: { unknownTools?: UnknownToolStance; permissions?: Record<string, PermissionAction> },
): string[] {
  return filterToolsByStance(manifestTools, registeredToolNames, opts);
}
