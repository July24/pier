/**
 * Phase 0 routing telemetry (RFC docs/rfc-jev-role-routing.md §8): observation only, zero
 * behavior change. Three row kinds answer the decision questions before the grants collapse
 * (phase 1) and the jev router (phase 2) are built:
 *  - spawn profile: how often masters manually route (role param / allowed_tools)
 *  - deny hits: which (role, tool) pairs the gate rejects — clamp-table and escalation data
 *  - axis usage: how role files actually use the three axes (ask / stance / explicit denies)
 *
 * Privacy contract: task text and prompt content NEVER enter telemetry — only taskSha8
 * (correlatable, not reversible; same redaction pattern as reducer's secret matches) and
 * tool/role names. Planners are pure and sessionId-free: the central append stamps it once
 * (index.ts), so threaded call sites never each carry a session-id source. All appends are
 * the caller's best-effort concern.
 */
import { createHash } from 'node:crypto';

type SpawnProfileRecord = {
  kind: 'spawn';
  ts: number;
  /** Whether the model passed an explicit `role` param (manual routing signal). */
  roleExplicit: boolean;
  role: string;
  /** Model-suggested extras (spawn `allowed_tools`) — manual routing signal #2. */
  allowedTools: string[];
  /** Final composed manifest tool list (what the worker actually got). */
  manifestTools: string[];
  /** sha256(task)[0:8] — correlates spawns without persisting the task text. */
  taskSha8: string;
};

type DenyHitRecord = {
  kind: 'deny';
  ts: number;
  role: string;
  tool: string;
};

type AxisUsageRecord = {
  kind: 'axis-usage';
  ts: number;
  files: number;
  parsed: number;
  invalid: number;
  askEntries: number;
  stanceAllow: number;
  stanceDeny: number;
  /** [role, tool] pairs carrying an explicit deny — the clamp-table design data. */
  explicitDenies: Array<[string, string]>;
};
/** sessionId-free union that planners return; the central append stamps it into RoutingTelemetryRow. */
export type RoutingTelemetryRecord = SpawnProfileRecord | DenyHitRecord | AxisUsageRecord;

/** Full row as written to routing.jsonl; sessionId is stamped by the central append. */
export type RoutingTelemetryRow =
  | ({ sessionId: string } & SpawnProfileRecord)
  | ({ sessionId: string } & DenyHitRecord)
  | ({ sessionId: string } & AxisUsageRecord);

/** Correlatable, non-reversible task fingerprint (8 hex chars of sha256). */
export function taskFingerprint(task: string): string {
  return createHash('sha256').update(task).digest('hex').slice(0, 8);
}

export function planSpawnProfileRow(opts: {
  now: number;
  roleExplicit: boolean;
  role: string;
  allowedTools: readonly string[];
  manifestTools: readonly string[];
  task: string;
}): SpawnProfileRecord {
  return {
    kind: 'spawn',
    ts: opts.now,
    roleExplicit: opts.roleExplicit,
    role: opts.role,
    allowedTools: [...opts.allowedTools],
    manifestTools: [...opts.manifestTools],
    taskSha8: taskFingerprint(opts.task),
  };
}

export function planDenyHitRow(opts: {
  now: number;
  role: string;
  tool: string;
}): DenyHitRecord {
  return { kind: 'deny', ts: opts.now, role: opts.role, tool: opts.tool };
}

/**
 * Fold role-file texts into the axis-usage summary. Robust by contract: a malformed file counts
 * as invalid and never fails the scan (the summary must observe reality, not gate on it).
 * Mirrors the validator's shapes only — no schema import, so telemetry never breaks on schema drift.
 */
export function scanRoleAxisUsage(opts: {
  now: number;
  files: ReadonlyArray<{ name: string; text: string }>;
}): AxisUsageRecord {
  let parsed = 0;
  let invalid = 0;
  let askEntries = 0;
  let stanceAllow = 0;
  let stanceDeny = 0;
  const explicitDenies: Array<[string, string]> = [];
  for (const file of opts.files) {
    let doc: {
      role?: unknown;
      manifest?: { unknownTools?: unknown; rules?: Record<string, unknown> | undefined };
    };
    try {
      doc = JSON.parse(file.text) as typeof doc;
    } catch {
      invalid += 1;
      continue;
    }
    if (typeof doc.role !== 'string' || typeof doc.manifest?.rules !== 'object' || doc.manifest?.rules === null) {
      invalid += 1;
      continue;
    }
    parsed += 1;
    if (doc.manifest.unknownTools === 'allow') stanceAllow += 1;
    else if (doc.manifest.unknownTools === 'deny') stanceDeny += 1;
    for (const [tool, action] of Object.entries(doc.manifest.rules)) {
      if (action === 'ask') askEntries += 1;
      else if (action === 'deny' && tool !== '*') explicitDenies.push([doc.role, tool]);
    }
  }
  return {
    kind: 'axis-usage',
    ts: opts.now,
    files: opts.files.length,
    parsed,
    invalid,
    askEntries,
    stanceAllow,
    stanceDeny,
    explicitDenies,
  };
}
