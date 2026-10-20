/**
 * Delegation identity (RFC docs/rfc-delegation-identity.md Phase 1): a worker pane knows who
 * delegated it, for what task, and shows that on every surface it already touches — system prompt
 * section, session custom entry (first-frame card), herdr sidebar tokens, and the pane title.
 * Pure builders only; the composition root owns the side effects.
 */

/** Contract env handed to the worker process by the master (PI_HERDR_ prefix per naming rule). */
export const DELEGATION_ENV = 'PI_HERDR_DELEGATION';
/** Worker-session custom entry written once at first boot; replayed on resume. */
export const DELEGATION_CUSTOM_TYPE = 'pi-herdr.delegation';
/** herdr sidebar tokens (pane.report_metadata): parent pane + delegated task. */
export const DELEGATION_PARENT_TOKEN = 'pi-parent';
export const DELEGATION_TASK_TOKEN = 'pi-task';
/** herdr truncates title/token values at 80 chars; clip locally to keep glyphs whole. */
const TOKEN_MAX = 80;

export interface DelegationContext {
  /** Master pane that spawned this worker; '' when the master pane is unknown (tests, RPC). */
  readonly parentPaneId: string;
  /** Master pi session id (cross-locate the parent transcript via /resume). */
  readonly parentSessionId: string;
  /** SubEntry.taskId — stable across revives. */
  readonly taskId: string;
  /** Task short label (SubEntry.description). */
  readonly description: string;
  /** Role manifest name active at spawn. */
  readonly role: string;
  /** Phase 2: the master's pipe name — report_progress dials it directly (D49 reply-address
   * semantics, precomputed because the worker cannot derive the master's session cwd). */
  readonly parentPipe?: string;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** Validate a parsed delegation record (env JSON, marker JSON or custom-entry data); null when malformed. */
export function delegationFromRecord(parsed: unknown): DelegationContext | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const rec = parsed as Record<string, unknown>; // shape-checked field by field below
  const parentPipe = str(rec.parentPipe);
  const taskId = str(rec.taskId);
  const description = str(rec.description);
  if (!taskId || !description) return null;
  return {
    parentPaneId: str(rec.parentPaneId) ?? '',
    parentSessionId: str(rec.parentSessionId) ?? '',
    taskId,
    description,
    role: str(rec.role) ?? 'worker-default',
    ...(parentPipe ? { parentPipe } : {}),
  };
}

/** Parse the spawn env; null when absent or structurally invalid (taskId/description mandatory). */
export function parseDelegationContext(raw: string | undefined | null): DelegationContext | null {
  if (!raw || typeof raw !== 'string') return null;
  try {
    return delegationFromRecord(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** env map for spawnPaneInTaskTab/createTab; JSON like the role manifest next to it. */
export function delegationEnv(ctx: DelegationContext): Record<string, string> {
  return { [DELEGATION_ENV]: JSON.stringify(ctx) };
}

/** Fold `pi-herdr.delegation` branch entries (last one wins) — the /resume replay source. */
export function foldDelegation(
  entries: ReadonlyArray<{ type?: string; customType?: string; data?: unknown }>,
): DelegationContext | null {
  let found: DelegationContext | null = null;
  for (const entry of entries) {
    if (entry.type !== 'custom' || entry.customType !== DELEGATION_CUSTOM_TYPE) continue;
    const next = delegationFromRecord(entry.data);
    if (next) found = next;
  }
  return found;
}

/**
 * System-prompt section text: identity + delivery contract in one stable wording, so the master
 * model does not have to restate it in every spawn prompt (pi-subagent-manager idea A+F).
 */
export function buildDelegationSection(ctx: DelegationContext, ownPaneId: string): string {
  const parent = ctx.parentPaneId || 'unknown pane';
  const session = ctx.parentSessionId || 'unknown session';
  const self = ownPaneId ? ` You are pane ${ownPaneId} (agentId "${ownPaneId}") — cite it when asking questions or reporting errors.`
    : '';
  return [
    `You are a delegated subagent of the master pane ${parent} (session ${session}); you were not started by a human.`,
    `Task: ${ctx.description}. Role: ${ctx.role}.${self}`,
    'Contract: when finished, state your final answer plainly — the master collects it from this pane\'s settlement; do not ask who requested the work. If you cannot finish, say exactly what blocks you instead of stopping silently.',
  ].join('\n');
}

/** Sidebar token patch; empty (no request) when there is no parent pane to attribute. */
export function delegationSidebarTokens(ctx: DelegationContext): Record<string, string> {
  if (!ctx.parentPaneId) return {};
  return {
    [DELEGATION_PARENT_TOKEN]: ctx.parentPaneId.slice(0, TOKEN_MAX),
    [DELEGATION_TASK_TOKEN]: ctx.description.slice(0, TOKEN_MAX),
  };
}

/** Worker pane title marker: `↳ <todo title>`, or `↳ <task>` alone before the first todo_write. */
export function applyWorkerTag(title: string | null, delegatedTask: string | null): string | null {
  if (!delegatedTask) return title;
  const base = title ?? delegatedTask;
  return `↳ ${base.slice(0, TOKEN_MAX - 2)}`;
}

