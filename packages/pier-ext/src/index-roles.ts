/**
 * Role runtime for the composition root: manifest state, mid-session switching,
 * the mandatory tool gate, `/pier-role`, and branch replay.
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { composeForRole, toRuntimeManifest } from './manifest-compose.ts';
import { planActiveTools, planToolGate, type RuntimeRoleManifest } from './tool-gate.ts';
import {
  initialRoleState,
  latestRoleManifestRecord,
  manifestFromRecord,
  planRoleSwitch,
  planSwitchActiveTools,
  roleRecordDiffers,
  type RoleState,
} from './role-state.ts';
import { RESERVED_ROLE_NAMES, listRoleNames, roleLayers } from './role-loader.ts';
import { TodosService } from './todos-service.ts';
import { APPROVAL_NEEDED_CUSTOM_TYPE, ROLE_MANIFEST_CUSTOM_TYPE } from './renderers.ts';
import { planDenyHitRow, scanRoleAxisUsage, type RoutingTelemetryRecord } from './routing-telemetry.ts';
import type { HerdrClientLike } from './herdr-client.ts';

/**
 * WS-D7: the master pane applies its own manifest through the same mandatory chain as
 * subagents. The builtin `master` role is read directly so a workspace master.json decoy
 * cannot affect self-application; a malformed manifest fails open to no-role state.
 */
export function composeMasterRuntime(): RuntimeRoleManifest | null {
  try {
    return toRuntimeManifest(composeForRole('master', [], { loadRoleOpts: { builtinDirect: true } }));
  } catch (err) {
    console.error(`[pi-herdr] master manifest invalid (fail-open): ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export interface RoleRuntimeDeps {
  pi: ExtensionAPI;
  /** D93 sidebar identity (`display_agent`) is a herdr RPC — pi's ExtensionAPI has no such method. */
  client: HerdrClientLike;
  /** Role-resolution base dir carried by the master at spawn (an isolate worker's own cwd resolves a different checkout). */
  roleBase: string;
  initialManifest: RuntimeRoleManifest | null;
  isSubagent: boolean;
  todos: TodosService;
  /** Best-effort routing telemetry (RFC docs/rfc-jev-role-routing.md §8); observation only, never gates. */
  appendRoutingLog: (row: RoutingTelemetryRecord) => void;
}

export interface RoleRuntime {
  readonly state: RoleState;
  idleBadge(): string | null;
  /** Replay the branch-point role record and re-anchor side effects (D77 visible layer, sidebar identity, badge). */
  syncFromBranch(ctx: unknown): void;
  /** Phase 0 axis scan of the workspace+user role layers (master session_start only). */
  scanRoleUsage(): void;
  /** Mid-session switch: /pier-role (human) and the pipe `role` request (master). */
  applyRoleSwitch(roleName: string, switchedBy: string): Promise<{ ok: boolean; message: string }>;
}

export function createRoleRuntime(d: RoleRuntimeDeps): RoleRuntime {
  const { pi, client, todos, roleBase, appendRoutingLog } = d;
  const roleState = initialRoleState(d.initialManifest);
  let roleBadge: string | null = null;

  /** D93: sidebar identity is the role name; null clears it. Best effort — herdr may be absent. */
  const reportSidebarIdentity = (role: string): void => {
    void client.reportDisplayAgent(role === 'worker-default' ? 'worker' : role).catch(() => {});
  };

  const setBadge = (m: RuntimeRoleManifest): string =>
    (roleBadge = `role ${m.role} v${m.version ?? '?'} (${m.tools.length} tools)`);

  /**
   * Same-origin sync (RFC docs/rfc-pi-0.86-dynamic-tools.md §4.3): reconcile roleState against the CURRENT
   * branch point on session_start (resume) and session_tree — pi's tool deltas revert the loadout at the
   * branch point, so the gate manifest must follow or it would keep the post-switch tools. Replay only
   * when the last record names a DIFFERENT role (name equality tolerates on-disk drift and keeps the env
   * value authoritative on resume); the anchor entry is written only on change so resume replay still works. */
  function syncFromBranch(ctx: unknown): void {
    if (!roleState.manifest) return;
    try {
      const branchEntries =
        (ctx as { sessionManager?: { getBranch?: () => readonly unknown[] } }).sessionManager?.getBranch?.() ?? [];
      const record = latestRoleManifestRecord(branchEntries);
      if (record && record.role !== roleState.manifest.role) {
        roleState.manifest = manifestFromRecord(record);
        roleState.origin = record.origin === 'switch' ? 'switch' : 'env';
        roleState.switchedBy = record.switchedBy ?? null;
        roleState.switchedAt = record.ts ?? null;
        console.error(`[pi-herdr] role replay: ${record.role} (origin ${record.origin ?? 'env'}, switchedBy ${record.switchedBy ?? '?'})`);
      }
      if (roleRecordDiffers(record, roleState)) {
        const m = roleState.manifest;
        pi.appendEntry(ROLE_MANIFEST_CUSTOM_TYPE, {
          version: 1,
          role: m.role,
          manifestVersion: m.version,
          tools: m.tools,
          permissions: m.permissions,
          unknownTools: m.unknownTools ?? 'deny',
          ...(m.guidelines?.length ? { guidelines: m.guidelines } : {}),
          ...(roleState.origin === 'switch'
            ? { origin: 'switch' as const, switchedBy: roleState.switchedBy ?? undefined }
            : {}),
          ts: Date.now(),
        });
      }
    } catch {
      /* Best effort recording; the mandatory layer does not depend on the session log. */
    }
    reportSidebarIdentity(roleState.manifest.role);
    setBadge(roleState.manifest);
    // D77 visible layer: hide tools outside the manifest AFTER all plugins load.
    // Intersection semantics prevent clearing everything; master without a
    // manifest stays full. setActiveTools persists as a tool delta (pi 0.86).
    try {
      const active = pi.getActiveTools();
      const vis = planActiveTools(roleState.manifest.tools, active, {
        unknownTools: roleState.manifest.unknownTools,
        permissions: roleState.manifest.permissions,
      });
      if (vis && vis.changed) {
        pi.setActiveTools(vis.next);
        console.error(`[pi-herdr] D77 visible-layer: role ${roleState.manifest.role} tools ${active.length} → ${vis.next.length}`);
      }
    } catch {
      /* Best effort visible layer; the mandatory layer remains active. */
    }
  }

  /** Axis scan reads file TEXT of the two top layers; per-layer readdir is guarded (workspace layer is commonly absent). */
  function scanRoleUsage(): void {
    try {
      const files: Array<{ name: string; text: string }> = [];
      for (const layer of roleLayers({ baseDir: roleBase }).slice(0, 2)) {
        let names: string[];
        try {
          names = readdirSync(layer.dir);
        } catch {
          continue;
        }
        for (const f of names) {
          if (!f.endsWith('.json')) continue;
          try {
            files.push({ name: f, text: readFileSync(join(layer.dir, f), 'utf8') });
          } catch {
          }
        }
      }
      appendRoutingLog(scanRoleAxisUsage({ now: Date.now(), files }));
    } catch {
    }
  }

  async function applyRoleSwitch(
    roleName: string,
    switchedBy: string,
  ): Promise<{ ok: boolean; message: string }> {
    const current = roleState.manifest;
    if (!current) {
      return { ok: false, message: 'Error: role system not armed (no manifest; bare pi sessions cannot switch roles)' };
    }
    const name = roleName.trim();
    if (name === '') return { ok: false, message: 'Error: role name is required (see /pier-role with no argument)' };
    if (name === current.role) return { ok: true, message: `role is already ${name}` };
    let next: RuntimeRoleManifest;
    try {
      // Resolve against the spawn-inherited base, matching the initial manifest composition.
      next = toRuntimeManifest(composeForRole(name, [], { loadRoleOpts: { baseDir: roleBase } }));
    } catch (err) {
      return { ok: false, message: `Error: role "${name}" unavailable: ${(err as Error).message}` };
    }
    const plan = planRoleSwitch(current.tools, next.tools);
    // Universe = ALL registered tools: a switch may re-admit tools an earlier
    // prune removed, which intersection semantics would lose.
    const registered = pi.getAllTools().map((t) => t.name);
    const nextActive = planSwitchActiveTools(next.tools, registered, {
      unknownTools: next.unknownTools,
      permissions: next.permissions,
    });
    pi.setActiveTools(nextActive);
    // TodosService captured services.todos.mode at startup; a mode switch must reach it.
    todos.config.allowParallelInProgress = TodosService.configFromRuntime(next, d.isSubagent).allowParallelInProgress;
    roleState.manifest = next;
    roleState.origin = 'switch';
    roleState.switchedBy = switchedBy;
    roleState.switchedAt = Date.now();
    setBadge(next);
    try {
      pi.appendEntry(ROLE_MANIFEST_CUSTOM_TYPE, {
        version: 1,
        role: next.role,
        manifestVersion: next.version,
        tools: next.tools,
        permissions: next.permissions,
        unknownTools: next.unknownTools ?? 'deny',
        ...(next.guidelines?.length ? { guidelines: next.guidelines } : {}),
        origin: 'switch' as const,
        switchedBy,
        ts: Date.now(),
      });
    } catch {
    }
    reportSidebarIdentity(next.role);
    const diff = [
      plan.added.length ? `+${plan.added.join(', ')}` : null,
      plan.removed.length ? `-${plan.removed.join(', ')}` : null,
    ]
      .filter(Boolean)
      .join(' ');
    return {
      ok: true,
      message: `role ${current.role} → ${next.role}${diff ? ` (${diff})` : ''}; active tools: ${nextActive.length}`,
    };
  }

  /* Mandatory gate: outside-manifest tool → block + terminate the batch;
   * ask → v1 soft-allow with a durable APPROVAL_NEEDED trace (V56). */
  pi.on('tool_call', async (event: { toolName?: string }) => {
    const manifest = roleState.manifest;
    if (!manifest) return;
    const tool = typeof event?.toolName === 'string' ? event.toolName : '';
    const gate = planToolGate(tool, manifest);
    if (gate.kind === 'deny') {
      appendRoutingLog(planDenyHitRow({ now: Date.now(), role: manifest.role, tool }));
      return { block: true, reason: gate.reason, terminate: true };
    }
    if (gate.kind === 'ask') {
      console.error(`${gate.notice} (v1 soft-approval: allowed, hard gate lands in v2)`);
      try {
        pi.appendEntry(APPROVAL_NEEDED_CUSTOM_TYPE, { role: manifest.role, tool, ts: Date.now() });
      } catch {
      }
    }
    return undefined;
  });

  pi.registerCommand('pier-role', {
    description:
      'Show the current role + available role names, or switch: /pier-role <name> (widening beyond the current toolset asks for confirmation)',
    handler: async (args: unknown, ctx: unknown) => {
      const ui = (ctx as { ui?: { notify?: (t: string, l?: string) => void; confirm?: (t: string, m: string) => Promise<boolean> } }).ui;
      const notify = (text: string, level: 'info' | 'error') => ui?.notify?.(text, level) ?? console.error(text);
      const current = roleState.manifest;
      if (!current) {
        notify('Role system not armed (no manifest).', 'error');
        return;
      }
      const name = typeof args === 'string' ? args.trim() : '';
      if (name === '') {
        const names = new Set<string>(RESERVED_ROLE_NAMES);
        for (const n of listRoleNames(roleBase)) names.add(n);
        notify(
          `Current role: ${current.role} (origin: ${roleState.origin}). Available: ${[...names].sort().join(', ')}`,
          'info',
        );
        return;
      }
      try {
        const preview = toRuntimeManifest(composeForRole(name, [], { loadRoleOpts: { baseDir: roleBase } }));
        const plan = planRoleSwitch(current.tools, preview.tools);
        // Q2: humans may widen after confirm — the human is the final authority in the pane.
        if (plan.widening && ui?.confirm) {
          const okToWiden = await ui.confirm(
            'Widen role toolset',
            `Role "${name}" adds tools beyond the current set (${plan.added.join(', ')}). Switch anyway?`,
          );
          if (!okToWiden) {
            notify('Role switch cancelled.', 'info');
            return;
          }
        }
      } catch (err) {
        notify(`Error: role "${name}" unavailable: ${(err as Error).message}`, 'error');
        return;
      }
      const res = await applyRoleSwitch(name, 'human');
      notify(res.message, res.ok ? 'info' : 'error');
    },
  });

  /* Per-role guidelines ride the before_agent_start prompt-section diff; writing
   * the same string each turn is a no-op (pi diffs sections), removal cleans up. */
  pi.on('before_agent_start', async (event) => {
    const sections = event.systemPromptOptions?.sections;
    if (!sections) return;
    const m = roleState.manifest;
    if (m?.guidelines?.length) {
      const text = `Role "${m.role}" operating constraints:\n${m.guidelines.map((g) => `- ${g}`).join('\n')}`;
      if (sections['pier-role'] !== text) sections['pier-role'] = text;
    } else {
      delete sections['pier-role'];
    }
  });

  return {
    state: roleState,
    idleBadge: () => roleBadge,
    syncFromBranch,
    scanRoleUsage,
    applyRoleSwitch,
  };
}
