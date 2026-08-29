/** Why: Preserve the established compatibility and safety behavior (D10). */
import { normalizeEntryKind } from './history-store.ts';

export interface SubagentSpec {
  description: string;
  prompt: string;
}

/** Why: Preserve the established compatibility and safety behavior. */
export function psQuote(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/** Why: Preserve the established compatibility and safety behavior. */
export function shQuote(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** Why: Preserve the established compatibility and safety behavior. */
export function buildLaunchLine(parts: readonly string[], platform: NodeJS.Platform = process.platform): string {
  const quoted = platform === 'win32'
    ? parts.map((s) => psQuote(s))
    : parts.map((s) => shQuote(s));
  return (platform === 'win32' ? '& ' : '') + quoted.join(' ');
}

/** Why: Preserve the established compatibility and safety behavior. */
export class Semaphore {
  private active = 0;
  private queue: Array<() => void> = [];
  private readonly cap: number;

  constructor(cap: number) {
    if (cap < 1) throw new Error('semaphore cap must be >= 1');
    this.cap = cap;
  }

  get activeCount(): number {
    return this.active;
  }

  acquire(): Promise<() => void> {
    if (this.active < this.cap) {
      this.active++;
      return Promise.resolve(this.release.bind(this));
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.active++;
        resolve(this.release.bind(this));
      });
    });
  }

  private release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

export interface SubagentOutcome {
  kind: 'completed' | 'timeout' | 'no-output' | 'blocked' | 'spawn-failed';
  /** Why: Preserve the established compatibility and safety behavior. */
  text: string;
}

/** Why: Preserve the established compatibility and safety behavior. */
export function formatSubagentResult(outcome: SubagentOutcome, description: string): string {
  switch (outcome.kind) {
    case 'completed': {
      const text = outcome.text;
      return text ? text : 'Subagent finished but produced no output.';
    }
    case 'timeout':
      return `Error: subagent "${description}" timed out. Partial output:\n${outcome.text || '(none)'}`;
    case 'blocked':
      return `Subagent "${description}" is blocked in its pane and needs a human decision. Partial output:\n${outcome.text || '(none)'}`;
    case 'no-output':
      return `Error: subagent "${description}" produced no readable output.`;
    case 'spawn-failed':
      return `Error: failed to spawn subagent "${description}": ${outcome.text}`;
  }
}

/** Why: Preserve the established compatibility and safety behavior (A2, B1). */

/** Why: Preserve the established compatibility and safety behavior. */
export interface AliveProbe {
  paneExists: boolean;
  agentStatus: string | null;
  /** Why: Preserve the established compatibility and safety behavior. */
  lastActivityMs: number | null;
}

/** Why: Preserve the established compatibility and safety behavior. */
export function isAlive(probe: AliveProbe, nowMs: number, staleAfterMs = 120_000): boolean {
  if (!probe.paneExists) return false;
  if (probe.agentStatus === 'working' || probe.agentStatus === 'blocked') return true;
  // Why: Preserve the established compatibility and safety behavior.
  return probe.lastActivityMs != null && nowMs - probe.lastActivityMs < staleAfterMs;
}

/** Why: Preserve the established compatibility and safety behavior. */
export function agoText(ms: number, nowMs: number): string {
  const s = Math.max(0, Math.round((nowMs - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

/** Why: Preserve the established compatibility and safety behavior (A2, B1). */
export function buildAliveNotice(
  opts: { paneId: string; description: string; scenario: 'moved-to-bg' | 'error-alive'; probe: AliveProbe },
  nowMs: number,
): string {
  const { paneId, description, scenario, probe } = opts;
  const status = probe.agentStatus ?? 'unknown';
  const activity = probe.lastActivityMs != null ? `, last session activity ${agoText(probe.lastActivityMs, nowMs)}` : '';
  if (scenario === 'moved-to-bg') {
    return [
      `Subagent "${description}" is still running in pane ${paneId} (agent_status=${status}${activity}).`,
      'The foreground wait has moved it to background so this call returns now.',
      'Do NOT redo its work. When it settles you will receive a notification with its closing output.',
      'Use list_agents to check its live state; send_message to give it follow-up work.',
    ].join(' ');
  }
  return [
    `The subagent "${description}" is ALIVE in pane ${paneId} (agent_status=${status}${activity}) — this "no readable output" result only means its final answer could not be read yet, NOT that the task failed.`,
    'Do NOT redo its work. It is being moved to background; you will be notified when it settles.',
    'Use list_agents to check its live state.',
  ].join(' ');
}

/** Why: Preserve the established compatibility and safety behavior (E1, E2). */
export function buildBlockedGateNotice(opts: { paneId: string; description: string; question: string | null }): string {
  const { paneId, description, question } = opts;
  const q = question ? ` (question: "${question}")` : '';
  return [
    `Subagent "${description}" is BLOCKED waiting for a HUMAN decision in pane ${paneId}${q}.`,
    'It keeps running in background; once the human answers it resumes, and you will be notified when it settles.',
    'Do NOT take over its work and do NOT answer on the human\'s behalf.',
    'Tell the user to open that pane in herdr and answer directly.',
    'Only if the user explicitly authorizes you: relay their decision to the subagent via send_message — do not redo the work yourself.',
  ].join(' ');
}

/** Why: Preserve the established compatibility and safety behavior. */

export const SUBS_CUSTOM_TYPE = 'pi-herdr.subs';

export interface SubEntry {
  taskId: string;
  /** Why: Preserve the established compatibility and safety behavior. */
  kind: string;
  paneId: string;
  tabId: string;
  /** Why: Preserve the established compatibility and safety behavior (D25, D26). */
  tabName: string;
  cwd: string;
  description: string;
  background: boolean;
  status: 'running' | 'settled' | 'consumed' | 'closed';
  /** Why: Preserve the established compatibility and safety behavior. */
  consumedAt?: number | null;
  sessionFile: string | null;
  launchCommand: string[];
  createdAt: number;
  revivedFrom?: string | null;
  /** Why: Preserve the established compatibility and safety behavior (D94). */
  userTakeover?: boolean;
  /** Why: Preserve the established compatibility and safety behavior (D94). */
  observationStartedAt?: number | null;
  /** Why: Preserve the established compatibility and safety behavior (D94). */
  lastAgentStatus?: string | null;
  /** Why: Preserve the established compatibility and safety behavior (D98). */
  isolate?: {
    worktreePath: string;
    branch: string;
    baseSha: string;
    releasedAt: number | null;
    retainNotified: boolean;
  };
}

export interface SubsRegistry {
  version: 2;
  subs: SubEntry[];
}

export function makeRegistry(subs: SubEntry[] = []): SubsRegistry {
  return { version: 2, subs };
}

/** Why: Preserve the established compatibility and safety behavior. */
export function foldSubsRegistry(entries: readonly BranchEntryLike2[]): SubsRegistry {
  let found = makeRegistry();
  for (const entry of entries) {
    if (entry.type !== 'custom' || entry.customType !== SUBS_CUSTOM_TYPE) continue;
    const data = entry.data as {
      subs?: Array<Partial<SubEntry> & { paneId: string }>;
    } | undefined;
    if (!data || !Array.isArray(data.subs)) continue;
    const subs: SubEntry[] = data.subs
      .filter((s) => typeof s?.paneId === 'string')
      .map((s) => ({
        taskId: typeof s.taskId === 'string' ? s.taskId : s.paneId,
        kind: normalizeEntryKind(typeof s.kind === 'string' ? s.kind : undefined),
        paneId: s.paneId,
        tabId: typeof s.tabId === 'string' ? s.tabId : '',
        tabName: typeof s.tabName === 'string' ? s.tabName : '',
        cwd: typeof s.cwd === 'string' ? s.cwd : '',
        description: typeof s.description === 'string' ? s.description : '',
        background: s.background === true,
        status: s.status === 'closed' ? 'closed' : s.status === 'consumed' ? 'consumed' : s.status === 'settled' ? 'settled' : 'running',
        consumedAt: typeof s.consumedAt === 'number' ? s.consumedAt : null,
        sessionFile: typeof s.sessionFile === 'string' ? s.sessionFile : null,
        launchCommand: Array.isArray(s.launchCommand) ? s.launchCommand : [],
        createdAt: typeof s.createdAt === 'number' ? s.createdAt : 0,
        revivedFrom: typeof s.revivedFrom === 'string' ? s.revivedFrom : null,
        userTakeover: s.userTakeover === true ? true : undefined,
        observationStartedAt: typeof s.observationStartedAt === 'number' ? s.observationStartedAt : null,
        lastAgentStatus: typeof s.lastAgentStatus === 'string' ? s.lastAgentStatus : null,
        isolate: s.isolate && typeof s.isolate === 'object'
          && typeof s.isolate.worktreePath === 'string' && typeof s.isolate.branch === 'string'
          && typeof s.isolate.baseSha === 'string'
          ? {
            worktreePath: s.isolate.worktreePath,
            branch: s.isolate.branch,
            baseSha: s.isolate.baseSha,
            releasedAt: typeof s.isolate.releasedAt === 'number' ? s.isolate.releasedAt : null,
            retainNotified: s.isolate.retainNotified === true,
          }
          : undefined,
      }));
    found = { version: 2, subs };
  }
  return found;
}

export interface BranchEntryLike2 {
  type?: string;
  customType?: string;
  data?: unknown;
}

/** Why: Preserve the established compatibility and safety behavior. */

export interface ProgressUpdate {
  content: Array<{ type: 'text'; text: string }>;
  details: Record<string, never>;
}

/** Why: Preserve the established compatibility and safety behavior. */
export function makeProgressUpdate(msg: string): ProgressUpdate {
  return { content: [{ type: 'text', text: msg }], details: {} };
}

/** Why: Preserve the established compatibility and safety behavior (D25, D26). */

export const TAB_NAME_MAX = 20;

/** Why: Preserve the established compatibility and safety behavior. */
export function tabNameForTask(description: string): string {
  const cleaned = String(description ?? '').replace(/\s+/g, ' ').trim();
  const truncated = cleaned.slice(0, TAB_NAME_MAX).trim();
  return truncated || 'task';
}

/** Why: Preserve the established compatibility and safety behavior (D26). */
export function nextTaskTabName(base: string, existingNames: ReadonlySet<string>): string {
  let name = base;
  let n = 2;
  while (existingNames.has(name)) {
    const suffix = `-${n}`;
    name = base.slice(0, TAB_NAME_MAX - suffix.length) + suffix;
    n++;
  }
  return name;
}

export interface TabPlacementPlan {
  /** Why: Preserve the established compatibility and safety behavior. */
  mode: 'append' | 'new';
  tabName: string;
  /** Why: Preserve the established compatibility and safety behavior. */
  tabId: string | null;
}

/** Why: Preserve the established compatibility and safety behavior (D86). */

/** Why: Preserve the established compatibility and safety behavior (D86). */
export function isPathUnder(cwd: string, wt: string): boolean {
  const n = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const a = n(cwd);
  const b = n(wt);
  return a === b || a.startsWith(`${b}/`);
}

export interface WorktreeZone {
  /** Why: Preserve the established compatibility and safety behavior. */
  zone: 'main' | 'worktree';
  /** Why: Preserve the established compatibility and safety behavior. */
  tabName: string | null;
}

/** Why: Preserve the established compatibility and safety behavior (D86). */
export function classifyWorktreeZone(opts: {
  cwd: string;
  masterCwd: string;
  worktrees: readonly string[];
}): WorktreeZone {
  for (const wt of opts.worktrees) {
    if (!isPathUnder(opts.cwd, wt)) continue;
    if (isPathUnder(opts.masterCwd, wt)) return { zone: 'main', tabName: null }; // Why: Preserve the established compatibility and safety behavior.
    const base = wt.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? 'worktree';
    return { zone: 'worktree', tabName: base };
  }
  return { zone: 'main', tabName: null };
}

/** Why: Preserve the established compatibility and safety behavior (D26, D86). */
export function planTabPlacement(opts: {
  desiredTab?: string | null;
  description: string;
  knownTabs: ReadonlyArray<{ tabName: string; tabId: string }>;
  /** Why: Preserve the established compatibility and safety behavior (D86). */
  zone?: WorktreeZone;
  /** Why: Preserve the established compatibility and safety behavior (D86). */
  mainTabId?: string | null;
}): TabPlacementPlan {
  const known = new Map<string, string>();
  for (const t of opts.knownTabs) if (t?.tabName && t?.tabId) known.set(t.tabName, t.tabId);
  if (opts.desiredTab != null && String(opts.desiredTab).trim() !== '') {
    const tabName = tabNameForTask(String(opts.desiredTab));
    const tabId = known.get(tabName) ?? null;
    return tabId ? { mode: 'append', tabName, tabId } : { mode: 'new', tabName, tabId: null };
  }
  const zone = opts.zone;
  if (zone?.zone === 'main' && opts.mainTabId) {
    // Why: Preserve the established compatibility and safety behavior (D86, R1).
    return { mode: 'append', tabName: 'main', tabId: opts.mainTabId };
  }
  if (zone?.zone === 'worktree' && zone.tabName) {
    // Why: Preserve the established compatibility and safety behavior (D86, R1).
    const base = zone.tabName;
    const existing = [...known.keys()].find((k) => k.toLowerCase() === base.toLowerCase());
    if (existing) return { mode: 'append', tabName: existing, tabId: known.get(existing)! };
    const tabName = nextTaskTabName(base, new Set(known.keys()));
    return { mode: 'new', tabName, tabId: null };
  }
  // Why: Preserve the established compatibility and safety behavior.
  const base = tabNameForTask(opts.description);
  const tabName = nextTaskTabName(base, new Set(known.keys()));
  return { mode: 'new', tabName, tabId: null };
}

/** Why: Preserve the established compatibility and safety behavior (D97). */

/** Why: Preserve the established compatibility and safety behavior. */
export interface LaunchRuntime {
  nodePath: string;
  cliPath: string;
  extPath: string;
}

/** Why: Preserve the established compatibility and safety behavior (D97). */
export function buildLaunchParts(
  runtime: LaunchRuntime,
  opts: { resumeFile?: string | null; roleModel?: string | null; approve?: boolean } = {},
  env: Pick<NodeJS.ProcessEnv, 'PI_HERDR_TUI'> = process.env,
): string[] {
  const parts = [runtime.nodePath, runtime.cliPath];
  if (opts.approve) parts.push('-a');
  parts.push('-e', runtime.extPath);
  if (env.PI_HERDR_TUI !== 'regular') parts.push('--tui-mode', 'fullscreen');
  if (opts.roleModel) parts.push('--provider', opts.roleModel.split('/')[0], '--model', opts.roleModel.split('/')[1] ?? opts.roleModel);
  if (opts.resumeFile) parts.push('--session', opts.resumeFile);
  return parts;
}

/** Why: Preserve the established compatibility and safety behavior (D98). */

/** Why: Preserve the established compatibility and safety behavior. */
export interface IsolatePlan {
  branch: string;
  slug: string;
  worktreeDirName: string;
}

/** Why: Preserve the established compatibility and safety behavior. */
export const ISOLATE_SLUG_MAX = 40;

/** Why: Preserve the established compatibility and safety behavior (D98). */
export function planIsolateWorktree(opts: {
  description: string;
  taskHex: string;
  existingPierBranches: ReadonlySet<string>;
}): IsolatePlan {
  const folded = String(opts.description ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, ISOLATE_SLUG_MAX)
    .replace(/-+$/g, '');
  const slug = folded || `task-${opts.taskHex}`;
  let name = slug;
  let n = 2;
  while (opts.existingPierBranches.has(name)) {
    name = `${slug}-${n}`;
    n++;
  }
  return { branch: `pier/${name}`, slug: name, worktreeDirName: `pier-${name}` };
}

/** Why: Preserve the established compatibility and safety behavior (D98). */
export function buildIsolatePreamble(opts: { worktreePath: string; branch: string; baseShort: string }): string {
  return [
    `You are working in an isolated git worktree: ${opts.worktreePath} (branch ${opts.branch}, base ${opts.baseShort}).`,
    'Every file you create or edit must stay inside this worktree.',
    'Commit your work to your branch as you go (git add -A && git commit). NEVER push to any remote.',
    'Do not touch the main checkout or other worktrees; if you find issues outside your task, report them in your final message instead of fixing them.',
    'Before finishing: commit everything, then end with a short summary of what changed and why.',
  ].join('\n');
}

/** Why: Preserve the established compatibility and safety behavior (D98). */
export function formatWorktreeStat(opts: {
  branch: string | null;
  commits: number | null;
  statLine: string | null;
  dirtyCount: number | null;
}): string | null {
  if (opts.dirtyCount == null) return null;
  if (opts.branch != null) {
    if (opts.commits == null || !opts.statLine) return null;
    const dirty = opts.dirtyCount > 0
      ? `${opts.dirtyCount} file(s) (worker should have committed)`
      : `${opts.dirtyCount} file(s)`;
    return `Worktree ${opts.branch}: ${opts.commits} commit(s) since base; ${opts.statLine}; uncommitted: ${dirty}`;
  }
  if (!opts.statLine) return null;
  return `git: ${opts.statLine}; uncommitted: ${opts.dirtyCount} file(s)`;
}

/** Why: Preserve the established compatibility and safety behavior (D98). */
export type ReleaseDecision = { action: 'release' } | { action: 'retain'; reason: 'unmerged' | 'dirty' | 'unknown' };

export function evaluateRelease(opts: { merged: boolean | null; dirtyCount: number | null }): ReleaseDecision {
  if (opts.merged === null || opts.dirtyCount === null) return { action: 'retain', reason: 'unknown' };
  if (!opts.merged) return { action: 'retain', reason: 'unmerged' };
  if (opts.dirtyCount > 0) return { action: 'retain', reason: 'dirty' };
  return { action: 'release' };
}

/** Why: Preserve the established compatibility and safety behavior (D98). */
export function parseWorktreePorcelain(out: string): Map<string, string> {
  const byBranch = new Map<string, string>();
  let curPath: string | null = null;
  for (const line of out.replace(/\r/g, '').split('\n')) {
    const m = /^worktree (.+)$/.exec(line.trim());
    if (m) { curPath = m[1]!; continue; }
    const b = /^branch (.+)$/.exec(line.trim());
    if (b && curPath) byBranch.set(b[1]!.replace(/^refs\/heads\//, ''), curPath);
  }
  return byBranch;
}
