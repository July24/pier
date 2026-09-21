/**
 * Subagent domain: registry rows, launch lines, liveness notices, tab/worktree planning,
 * isolate decisions, task-id resolution, execute planners, and the outbound port types.
 * Pure — no Cordis, no herdr client, no fs (planners only decide; adapters do I/O).
 */
import { normalizeEntryKind } from './history-store.ts';

export interface SubagentSpec {
  description: string;
  prompt: string;
}

/** POSIX single-quote escape; win32 PowerShell doubles the quote instead. */
export function buildLaunchLine(parts: readonly string[], platform: NodeJS.Platform = process.platform): string {
  const win = platform === 'win32';
  const quoted = parts.map((s) => (win
    ? `'${String(s).replace(/'/g, "''")}'`
    : `'${String(s).replace(/'/g, `'\\''`)}'`));
  return (win ? '& ' : '') + quoted.join(' ');
}

/** Bounds concurrent delegation spawns (SUBAGENT_CONCURRENCY). */
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
    const { promise, resolve } = Promise.withResolvers<() => void>();
    this.queue.push(() => {
      this.active++;
      resolve(this.release.bind(this));
    });
    return promise;
  }

  private release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

interface SubagentOutcome {
  kind: 'completed' | 'timeout' | 'no-output' | 'blocked' | 'spawn-failed';
  text: string;
}

export function formatSubagentResult(outcome: SubagentOutcome, description: string): string {
  switch (outcome.kind) {
    case 'completed':
      return outcome.text ? outcome.text : 'Subagent finished but produced no output.';
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

export interface AliveProbe {
  paneExists: boolean;
  agentStatus: string | null;
  lastActivityMs: number | null;
  /** Herdr 0.9.1: foreground working directory of the PTY process. */
  foregroundCwd?: string | null;
}

/**
 * A subagent outlives its "no output" result: a working/blocked agent is alive regardless of
 * session age, otherwise recent session writes decide. `paneExists: false` is death — an
 * unavailable probe must be reported as such by the caller, not guessed here.
 */
export function isAlive(probe: AliveProbe, nowMs: number, staleAfterMs = 120_000): boolean {
  if (!probe.paneExists) return false;
  if (probe.agentStatus === 'working' || probe.agentStatus === 'blocked') return true;
  return probe.lastActivityMs != null && nowMs - probe.lastActivityMs < staleAfterMs;
}

export function agoText(ms: number, nowMs: number): string {
  const s = Math.max(0, Math.round((nowMs - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

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
      'Use subagent(action: "list") to check its live state; subagent(action: "send") to give it follow-up work.',
    ].join(' ');
  }
  return [
    `The subagent "${description}" is ALIVE in pane ${paneId} (agent_status=${status}${activity}) — this "no readable output" result only means its final answer could not be read yet, NOT that the task failed.`,
    'Do NOT redo its work. It is being moved to background; you will be notified when it settles.',
    'Use subagent(action: "list") to check its live state.',
  ].join(' ');
}

/** A pane blocked on a human decision keeps running: the master must not take the work over. */
export function buildBlockedGateNotice(opts: { paneId: string; description: string; question: string | null }): string {
  const { paneId, description, question } = opts;
  const q = question ? ` (question: "${question}")` : '';
  return [
    `Subagent "${description}" is BLOCKED waiting for a HUMAN decision in pane ${paneId}${q}.`,
    'It keeps running in background; once the human answers it resumes, and you will be notified when it settles.',
    'Do NOT take over its work and do NOT answer on the human\'s behalf.',
    'Tell the user to open that pane in herdr and answer directly.',
    'Only if the user explicitly authorizes you: relay their decision to the subagent via subagent(action: "send") — do not redo the work yourself.',
  ].join(' ');
}

export const SUBS_CUSTOM_TYPE = 'pi-herdr.subs';

export interface SubEntry {
  taskId: string;
  /** 'task' or a role name; only a display label for GC. */
  kind: string;
  paneId: string;
  tabId: string;
  tabName: string;
  cwd: string;
  description: string;
  background: boolean;
  status: 'running' | 'settled' | 'consumed' | 'closed';
  /** GC grace basis (durable); closed rows keep the original value. */
  consumedAt?: number | null;
  sessionFile: string | null;
  launchCommand: string[];
  createdAt: number;
  revivedFrom?: string | null;
  /** D94: the human took the pane over; observation window judges when to hand control back. */
  userTakeover?: boolean;
  observationStartedAt?: number | null;
  lastAgentStatus?: string | null;
  /** D98: isolate worktree metadata; `releasedAt` set once the worktree is removed. */
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

const SUB_STATUSES: Record<string, true> = { running: true, settled: true, consumed: true, closed: true };

/**
 * Replay `pi-herdr.subs` custom branch entries into a registry; last snapshot wins.
 * Tolerant of v1 rows (missing taskId/kind/tabName) and unknown future fields.
 */
export function foldSubsRegistry(entries: ReadonlyArray<{ type?: string; customType?: string; data?: unknown }>): SubsRegistry {
  let found = makeRegistry();
  for (const entry of entries) {
    if (entry.type !== 'custom' || entry.customType !== SUBS_CUSTOM_TYPE) continue;
    const data = entry.data as { subs?: Array<Partial<SubEntry> & { paneId: string }> } | undefined;
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
        status: typeof s.status === 'string' && SUB_STATUSES[s.status] === true
          ? (s.status as SubEntry['status'])
          : 'running',
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

/** Latest row per taskId (same taskId rows are generations); newest createdAt wins. */
export function newestPerTaskId(entries: Iterable<SubEntry>): Map<string, SubEntry> {
  const byTask = new Map<string, SubEntry>();
  for (const sub of entries) {
    const prev = byTask.get(sub.taskId);
    if (!prev || sub.createdAt >= prev.createdAt) byTask.set(sub.taskId, sub);
  }
  return byTask;
}

/** pi's AgentToolResult shape — a bare string crashes the interactive TUI's getTextOutput. */
export function makeProgressUpdate(msg: string) {
  return { content: [{ type: 'text' as const, text: msg }], details: {} as Record<string, never> };
}

/** First non-empty id parameter, stringified; callers pass their key order. */
export function idParam(params: Record<string, unknown> | undefined, ...keys: string[]): string {
  for (const key of keys) {
    const v = params?.[key];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

/** Shared wording for an ambiguous id prefix, at most five candidates listed. */
export function ambiguousIdError(label: 'task id' | 'subagent id', query: string, candidates: readonly string[]): string {
  const head = candidates.slice(0, 5).join(', ');
  const more = candidates.length > 5 ? `, ... (+${candidates.length - 5} more)` : '';
  return `Error: ambiguous ${label} "${query}" matches ${candidates.length} tasks: ${head}${more}`;
}

export const TAB_NAME_MAX = 20;

export function tabNameForTask(description: string): string {
  const cleaned = String(description ?? '').replace(/\s+/g, ' ').trim();
  const truncated = cleaned.slice(0, TAB_NAME_MAX).trim();
  return truncated || 'task';
}

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
  mode: 'append' | 'new';
  tabName: string;
  tabId: string | null;
}

/** Case/slash-insensitive containment; `/repo-x` is NOT under `/repo`. */
export function isPathUnder(cwd: string, wt: string): boolean {
  const n = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const a = n(cwd);
  const b = n(wt);
  return a === b || a.startsWith(`${b}/`);
}

export interface WorktreeZone {
  zone: 'main' | 'worktree';
  tabName: string | null;
}

/** D86: subagents working in the master's checkout share its tab; another worktree gets its own. */
export function classifyWorktreeZone(opts: {
  cwd: string;
  masterCwd: string;
  worktrees: readonly string[];
}): WorktreeZone {
  for (const wt of opts.worktrees) {
    if (!isPathUnder(opts.cwd, wt)) continue;
    if (isPathUnder(opts.masterCwd, wt)) return { zone: 'main', tabName: null };
    const base = wt.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? 'worktree';
    return { zone: 'worktree', tabName: base };
  }
  return { zone: 'main', tabName: null };
}

/** Explicit `tab` wins; otherwise D86 zone decides, and an unknown zone falls back to the description. */
export function planTabPlacement(opts: {
  desiredTab?: string | null;
  description: string;
  knownTabs: ReadonlyArray<{ tabName: string; tabId: string }>;
  zone?: WorktreeZone;
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
    return { mode: 'append', tabName: 'main', tabId: opts.mainTabId };
  }
  if (zone?.zone === 'worktree' && zone.tabName) {
    const base = zone.tabName;
    const existing = [...known.keys()].find((k) => k.toLowerCase() === base.toLowerCase());
    if (existing) return { mode: 'append', tabName: existing, tabId: known.get(existing)! };
    return { mode: 'new', tabName: nextTaskTabName(base, new Set(known.keys())), tabId: null };
  }
  const base = tabNameForTask(opts.description);
  return { mode: 'new', tabName: nextTaskTabName(base, new Set(known.keys())), tabId: null };
}

/** D97: fullscreen is what makes the pane a static frame the master can read. */
export function buildLaunchParts(
  runtime: { nodePath: string; cliPath: string; extPath: string },
  opts: { resumeFile?: string | null; roleModel?: string | null; approve?: boolean } = {},
  env: { PI_HERDR_TUI?: string | undefined } = process.env,
): string[] {
  const parts = [runtime.nodePath, runtime.cliPath];
  if (opts.approve) parts.push('-a');
  parts.push('-e', runtime.extPath);
  if (env.PI_HERDR_TUI !== 'regular') parts.push('--tui-mode', 'fullscreen');
  if (opts.roleModel) parts.push('--provider', opts.roleModel.split('/')[0]!, '--model', opts.roleModel.split('/')[1] ?? opts.roleModel);
  if (opts.resumeFile) parts.push('--session', opts.resumeFile);
  return parts;
}

const ISOLATE_SLUG_MAX = 40;

/** Branch/dir name for a fresh isolate worktree, ascii-folded from the description. */
export function planIsolateWorktree(opts: {
  description: string;
  taskHex: string;
  existingPierBranches: ReadonlySet<string>;
}) {
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

/** Commit discipline is injected into the prompt: the worktree has no other protection. */
export function buildIsolatePreamble(opts: { worktreePath: string; branch: string; baseShort: string }): string {
  return [
    `You are working in an isolated git worktree: ${opts.worktreePath} (branch ${opts.branch}, base ${opts.baseShort}).`,
    'Every file you create or edit must stay inside this worktree.',
    'Commit your work to your branch as you go (git add -A && git commit). NEVER push to any remote.',
    'Do not touch the main checkout or other worktrees; if you find issues outside your task, report them in your final message instead of fixing them.',
    'Before finishing: commit everything, then end with a short summary of what changed and why.',
  ].join('\n');
}

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

/** D98: only a merged, clean, known worktree may be removed automatically. */
export function evaluateRelease(opts: { merged: boolean | null; dirtyCount: number | null }):
  { action: 'release' } | { action: 'retain'; reason: 'unmerged' | 'dirty' | 'unknown' } {
  if (opts.merged === null || opts.dirtyCount === null) return { action: 'retain', reason: 'unknown' };
  if (!opts.merged) return { action: 'retain', reason: 'unmerged' };
  if (opts.dirtyCount > 0) return { action: 'retain', reason: 'dirty' };
  return { action: 'release' };
}

/** `git worktree list --porcelain` → branch (refs/heads/ stripped) → path. */
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

/* ── execute planners ───────────────────────────────────────────── */

export const FOREGROUND_POLL_MS = 2_000;

type LaunchValidation =
  | { kind: 'error'; text: string }
  | {
    kind: 'ok';
    spec: SubagentSpec;
    background: boolean;
    isolate: boolean;
    cwdParam: string | null;
    roleKind: string;
    suggested: string[];
    manifestRole: string | null;
    tab: string | null;
  };

/**
 * Validate spawn parameters. `role` doubles as the pane label and (when it names a profile) the
 * manifest to compose; unknown names stay labels. `isolate` and `cwd` are mutually exclusive.
 */
export function planLaunchValidation(
  params: {
    description?: unknown;
    prompt?: unknown;
    run_in_background?: unknown;
    cwd?: unknown;
    isolate?: unknown;
    role?: unknown;
    allowed_tools?: unknown;
    tab?: unknown;
  } | null | undefined,
  herdrAvailable: boolean,
): LaunchValidation {
  if (!herdrAvailable) {
    return { kind: 'error', text: 'Error: subagent requires pi to run inside a herdr-managed pane (HERDR_ENV not set).' };
  }
  const spec: SubagentSpec = {
    description: String(params?.description ?? 'subagent'),
    prompt: String(params?.prompt ?? ''),
  };
  if (!spec.prompt.trim()) return { kind: 'error', text: 'Error: `prompt` must be a non-empty string' };
  const cwdParam = typeof params?.cwd === 'string' && params.cwd.trim() ? params.cwd.trim() : null;
  const isolate = params?.isolate === true;
  if (isolate && cwdParam) {
    return {
      kind: 'error',
      text: 'Error: `isolate` and `cwd` are mutually exclusive — isolate creates a new worktree, cwd delegates into an existing one',
    };
  }
  const role = typeof params?.role === 'string' ? params.role.trim() : undefined;
  return {
    kind: 'ok',
    spec,
    background: params?.run_in_background === true,
    isolate,
    cwdParam,
    roleKind: normalizeEntryKind(role),
    suggested: Array.isArray(params?.allowed_tools)
      ? params.allowed_tools.filter((t): t is string => typeof t === 'string' && t.trim() !== '')
      : [],
    manifestRole: role || 'worker-default',
    tab: typeof params?.tab === 'string' ? params.tab : null,
  };
}

export type ForegroundTickPlan =
  | { kind: 'blocked' }
  | { kind: 'settled'; text: string }
  | { kind: 'wait'; delayMs: number }
  | { kind: 'collect-final' }
  | { kind: 'continue' };

/** One foreground-wait iteration: only a human gate or finalized text ends the wait. */
export function planForegroundTick(input: {
  state: string | null;
  session: { text: string | null; pendingTool: boolean; activity: boolean };
}): ForegroundTickPlan {
  if (input.state === 'blocked') return { kind: 'blocked' };
  if (input.state !== 'idle' && input.state !== 'done') return { kind: 'continue' };
  if (input.session.text) return { kind: 'settled', text: input.session.text };
  if (input.session.pendingTool || !input.session.activity) return { kind: 'wait', delayMs: FOREGROUND_POLL_MS };
  return { kind: 'collect-final' };
}

/* ── task-id resolution ─────────────────────────────────────────── */

type TaskIdResolutionResult =
  | { kind: 'resolved'; taskId: string }
  | { kind: 'ambiguous'; query: string; candidates: string[] }
  | { kind: 'too_short'; query: string }
  | { kind: 'not_found'; query: string };

/**
 * Resolve a full or short task ID against known candidates. Exact matches are accepted at any
 * length; prefix matching requires four characters and reports ambiguity with sorted candidates.
 */
export function resolveTaskIdPrefix(
  query: string,
  candidates: Iterable<string>,
): TaskIdResolutionResult {
  const trimmed = query.trim();
  if (!trimmed) return { kind: 'not_found', query: trimmed };

  const unique = Array.from(new Set(candidates));
  const exact = unique.find((candidate) => candidate === trimmed);
  if (exact) return { kind: 'resolved', taskId: exact };

  if (trimmed.length < 4) return { kind: 'too_short', query: trimmed };

  const lower = trimmed.toLowerCase();
  const matches = unique.filter((candidate) => candidate.toLowerCase().startsWith(lower));
  if (matches.length === 1) return { kind: 'resolved', taskId: matches[0]! };
  if (matches.length > 1) {
    matches.sort();
    return { kind: 'ambiguous', query: trimmed, candidates: matches };
  }
  return { kind: 'not_found', query: trimmed };
}

/* ── outbound port (composition root → plugin) ──────────────────── */

/** Bound atomically: a missing bag used to crash at mount when index mutated it field by field. */
export interface SubagentPort {
  applyReplySession(paneId: string, sessionFile: string | null): void;
  reconcileOnReply(paneId: string): string[];
  listRunningSubs(): Array<{ paneId: string; description: string }>;
  settleStatLine(paneId: string): Promise<string | null>;
}

export interface SubagentPortBox {
  current: SubagentPort | null;
}

export function emptySubagentPortBox(): SubagentPortBox {
  return { current: null };
}
