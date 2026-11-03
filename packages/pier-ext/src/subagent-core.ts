/**
 * Subagent domain: registry rows, launch lines, liveness notices, tab/worktree planning, isolate
 * decisions, task-id resolution, and the outbound port types. Pure: planners decide, adapters do I/O.
 */
import { normalizeEntryKind } from './history-store.ts';
import { Type } from 'typebox';

export function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

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

/** Explicit `tab` name that places the worker as a pane in the master terminal's own tab. */
export const MAIN_TAB_NAME = 'main';

/** App tab addresses must be stable across spawns (a named tab is joined, not recreated) and ASCII. */
function tabIdFor(name: string): string {
  const slug = String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  if (slug) return `tbpier-${slug}`;
  // Non-ASCII task names (CJK descriptions) sanitize to nothing: the hash keeps the id stable.
  let hash = 0x811c9dc5;
  for (const ch of String(name)) {
    hash ^= ch.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `tbpier-${hash.toString(16).padStart(8, '0')}`;
}

/**
 * pi ≥ 0.99 outputSchema for the subagent tool: the `details` each action already produces, stamped
 * with the normalized action. Codemode scripts (and any structured consumer) read this instead of
 * parsing the prose reply; the text content stays authoritative for the transcript. Hard failures
 * throw (toolError), so every returned value is a success and always carries structuredContent.
 */
export const SUBAGENT_OUTPUT_SCHEMA = Type.Object({
  action: Type.Union([
    Type.Literal('spawn'), Type.Literal('resume'), Type.Literal('list'), Type.Literal('wait'),
    Type.Literal('send'), Type.Literal('interrupt'), Type.Literal('output'), Type.Literal('help'),
  ]),
  paneId: Type.Optional(Type.String()),
  taskId: Type.Optional(Type.String()),
  background: Type.Optional(Type.Boolean()),
  alreadyRunning: Type.Optional(Type.Boolean()),
}, { additionalProperties: true });

export function attachSubagentStructuredContent(action: string, result: unknown): unknown {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return result;
  const record = result as Record<string, unknown>;
  const details = record.details !== null && typeof record.details === 'object' && !Array.isArray(record.details)
    ? record.details as Record<string, unknown>
    : {};
  return { ...record, structuredContent: { action, ...details } };
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
  /** Foreground working directory of the terminal's program. */
  foregroundCwd?: string | null;
}

/** Trailing line for isolate spawn results: the branch (`pier/<slug>`) reads like a directory and
 *  masters have cd'd into `<repo>/pier/<slug>`; only the worktree path is an actual directory. */
export function formatIsolateLocation(
  isolate: Pick<NonNullable<SubEntry['isolate']>, 'worktreePath' | 'branch'> | null | undefined,
): string {
  return isolate ? `\nWorktree: ${isolate.worktreePath} (branch ${isolate.branch})` : '';
}

/**
 * A subagent outlives its "no output" result: a working/blocked agent is alive regardless of session
 * age, otherwise recent session writes decide. `paneExists: false` is death — an unavailable probe is
 * the caller's to report, not guessed here.
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
      'Do NOT redo its work and do NOT sleep or poll: when it settles, its result is delivered automatically as a settlement notice at your next turn boundary.',
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
    'Tell the user to open that terminal in the Herdr app and answer directly.',
    'Only if the user explicitly authorizes you: relay their decision to the subagent via subagent(action: "send") — do not redo the work yourself.',
  ].join(' ');
}

export const SUBS_CUSTOM_TYPE = 'pi-herdr.subs';

export interface SubEntry {
  taskId: string;
  /** 'task' or a role name; only a display label for GC. */
  kind: string;
  paneId: string;
  /** Phase 2 task slug (kebab-case of description; RFC rfc-delegation-identity §3.1): tool args
   * accept `slug@paneId` or the bare slug; allocated once at spawn and stable across revives. */
  slug?: string;
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
  /** Observation window start (poller state): settlement waits until the transcript settles. */
  observationStartedAt?: number | null;
  /** The final report `subagent output` already returned (tail fingerprint + time): the settlement
   *  notice then points at that delivery instead of repeating the report. Durable across resume. */
  reportDelivered?: { fingerprint: string; at: number } | null;
  /** D98: isolate worktree metadata; `releasedAt` set once the worktree is removed. */
  isolate?: {
    worktreePath: string;
    branch: string;
    baseSha: string;
    releasedAt: number | null;
    retainNotified: boolean;
  };
}

/* ── task slugs (RFC rfc-delegation-identity §3.1) ───────────────── */

/** Slug cap: short enough for tool args and list rows, long enough to stay distinctive. */
const SLUG_MAX = 24;

/** Kebab-case a task description; non-ASCII (CJK descriptions) sanitizes to '' — the allocator
 * then falls back to a taskId-derived ascii slug, because tool args must stay typeable. */
export function slugifyTask(description: string): string {
  return description
    .toLowerCase()
    .replace(/[''']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '');
}

/** Allocate a unique slug among live rows: base, then base-2, base-3, …; a description that
 * sanitizes to nothing (CJK, emoji-only) falls back to `task-<taskId prefix>`. */
export function allocateSubSlug(description: string, taskId: string, taken: ReadonlySet<string>): string {
  const base = slugifyTask(description) || `task-${taskId.slice(0, 6)}`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const next = `${base}-${n}`;
    if (!taken.has(next)) return next;
  }
}

/** Stable display/argument form for a subagent row: `slug@paneId` when a slug exists. */
export function subRef(sub: { paneId: string; slug?: string }): string {
  return sub.slug ? `${sub.slug}@${sub.paneId}` : sub.paneId;
}

/** Identity of a final report across the output action and the settlement notice: its tail. */
export function reportFingerprint(report: string): string {
  return report.slice(-64);
}

/** Shorter sleeps are ordinary polling of builds/logs; from a minute up, they were waits on workers. */
const SLEEP_NOTE_MIN_SECONDS = 60;

/**
 * Note for a master bash call that sleeps ≥ SLEEP_NOTE_MIN_SECONDS while background workers run:
 * masters slept 660-840 s per worker although the settlement notice arrives on its own. Worded so a
 * sleep that waits on something else (a load test, a build) is left alone.
 */
export function sleepWhileSubsRunningNote(
  command: string,
  running: ReadonlyArray<{ paneId: string; slug?: string }>,
): string | null {
  if (running.length === 0) return null;
  const longest = Math.max(0, ...[...command.matchAll(/\bsleep\s+(\d+)s?\b/g)].map((m) => Number(m[1])));
  if (longest < SLEEP_NOTE_MIN_SECONDS) return null;
  return `[pier] ${running.length} background subagent(s) running (${running.map(subRef).join(', ')}): their settlement `
    + 'notice arrives automatically at your next tool boundary, so do not sleep to wait for them — keep working, or call '
    + 'subagent action "wait" to block until one finishes. Sleeping is only needed for other work (builds, logs).';
}

export interface SubsRegistry {
  version: 2;
  subs: SubEntry[];
}

export function makeRegistry(subs: SubEntry[] = []): SubsRegistry {
  return { version: 2, subs };
}

const SUB_STATUSES: Record<string, true> = { running: true, settled: true, consumed: true, closed: true };

/** Replay `pi-herdr.subs` custom branch entries into a registry; last snapshot wins. Tolerant of
 *  v1 rows (missing taskId/kind/tabName) and unknown future fields. */
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
        slug: typeof s.slug === 'string' && s.slug ? s.slug : undefined,
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
        observationStartedAt: typeof s.observationStartedAt === 'number' ? s.observationStartedAt : null,
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
        reportDelivered: s.reportDelivered && typeof s.reportDelivered === 'object'
          && typeof s.reportDelivered.fingerprint === 'string' && typeof s.reportDelivered.at === 'number'
          ? { fingerprint: s.reportDelivered.fingerprint, at: s.reportDelivered.at }
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

/** Re-key a revived entry under its new pane id; the dead id must go, or a later zombie sweep closes the live row. */
export function rekeySub(subs: Map<string, SubEntry>, previousPaneId: string, entry: SubEntry): void {
  if (previousPaneId !== entry.paneId && subs.get(previousPaneId) === entry) subs.delete(previousPaneId);
  subs.set(entry.paneId, entry);
}

/** Split `provider/model` on the first '/' only: model ids such as `moonshotai/kimi-k2` carry their own. */
export function splitModelRef(ref: string): { provider: string | null; model: string } {
  const slash = ref.indexOf('/');
  if (slash <= 0 || slash === ref.length - 1) return { provider: null, model: ref };
  return { provider: ref.slice(0, slash), model: ref.slice(slash + 1) };
}

/** pi's AgentToolResult shape — a bare string crashes the interactive TUI's getTextOutput. */
export function makeProgressUpdate(msg: string) {
  return { content: [{ type: 'text' as const, text: msg }], details: {} as Record<string, never> };
}

/**
 * Models sometimes wrap fields in a `parameters` object (JSON-schema habit). Top-level wins;
 * only missing keys are filled from the nested bag so a real field is never overwritten.
 */
export function flattenToolParams(params: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!params) return params;
  const nested = params.parameters;
  if (nested === null || typeof nested !== 'object' || Array.isArray(nested)) return params;
  const out: Record<string, unknown> = { ...params };
  for (const [key, value] of Object.entries(nested as Record<string, unknown>)) {
    if (key === 'parameters') continue;
    const current = out[key];
    if (current == null || current === '') out[key] = value;
  }
  return out;
}


export function idParam(params: Record<string, unknown> | undefined, ...keys: string[]): string {
  const flat = flattenToolParams(params);
  for (const key of keys) {
    const v = flat?.[key];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

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

export interface TabPlacementPlan {
  /** Display name of the requested tab; `main` = the master's tab; '' = no pane (sub-agent row only). */
  tabName: string;
  /** Address for the `herdr.tab` label; null = the master's tab, or no pane when `tabName` is ''. */
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
}

/** D86 trust: the master's checkout (`main`) or one of its other git worktrees (`worktree`). */
export function classifyWorktreeZone(opts: {
  cwd: string;
  masterCwd: string;
  worktrees: readonly string[];
}): WorktreeZone {
  for (const wt of opts.worktrees) {
    if (!isPathUnder(opts.cwd, wt)) continue;
    return { zone: isPathUnder(opts.masterCwd, wt) ? 'main' : 'worktree' };
  }
  return { zone: 'main' };
}

/** D140: a worker gets no pane unless asked — the app lists it under its parent and peeks at it.
 *  An explicit `tab` joins or creates that app tab (stable id per name); `main` is the master's tab. */
export function planTabPlacement(opts: { desiredTab?: string | null }): TabPlacementPlan {
  const desired = opts.desiredTab != null ? String(opts.desiredTab).replace(/\s+/g, ' ').trim() : '';
  if (!desired) return { tabName: '', tabId: null };
  return placementFor(tabNameForTask(desired));
}

function placementFor(tabName: string): TabPlacementPlan {
  if (tabName.toLowerCase() === MAIN_TAB_NAME) return { tabName: MAIN_TAB_NAME, tabId: null };
  return { tabName, tabId: tabIdFor(tabName) };
}

/** D97: fullscreen is what makes the pane a static frame the master can read. */
export function buildLaunchParts(
  runtime: { nodePath: string; cliPath: string; extPath: string },
  opts: { resumeFile?: string | null; model?: string | null; approve?: boolean } = {},
  env: { PI_HERDR_TUI?: string | undefined } = process.env,
): string[] {
  const parts = [runtime.nodePath, runtime.cliPath];
  if (opts.approve) parts.push('-a');
  parts.push('-e', runtime.extPath);
  if (env.PI_HERDR_TUI !== 'regular') parts.push('--tui-mode', 'fullscreen');
  if (opts.model) {
    const { provider, model } = splitModelRef(opts.model);
    if (provider) parts.push('--provider', provider);
    parts.push('--model', model);
  }
  if (opts.resumeFile) parts.push('--session', opts.resumeFile);
  return parts;
}

const ISOLATE_SLUG_MAX = 40;

/**
 * D-3 (verified 2026-10-20): herdr 0.9.5 `worktree create --workspace <parent>` still opens a new
 * top-level workspace, not a tab inside the parent workspace, so it cannot replace pier's isolate
 * placement. Keep `git worktree add` + the master-workspace tab; native worktree management remains
 * an option only for workflows that accept a separate workspace.
 */
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
    tab: string | null;
  };

/** Validate spawn parameters. `isolate` and `cwd` are mutually exclusive. */
export function planLaunchValidation(
  params: {
    description?: unknown;
    prompt?: unknown;
    run_in_background?: unknown;
    cwd?: unknown;
    isolate?: unknown;
    tab?: unknown;
  } | null | undefined,
  available: boolean,
): LaunchValidation {
  if (!available) {
    return { kind: 'error', text: 'Error: subagent requires pi to run inside a herdr-core terminal (HC_TERMINAL_ID not set).' };
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
  return {
    kind: 'ok',
    spec,
    background: params?.run_in_background === true,
    isolate,
    cwdParam,
    tab: typeof params?.tab === 'string' ? params.tab : null,
  };
}

export type ForegroundTickPlan =
  | { kind: 'blocked' }
  | { kind: 'settled'; text: string }
  | { kind: 'wait'; delayMs: number }
  | { kind: 'collect-final' }
  | { kind: 'continue' };

/** One foreground-wait iteration: only a human gate or finalized text ends the wait. `error` is a
 *  terminal program state like `done`: the transcript decides whether text came out. */
export function planForegroundTick(input: {
  state: string | null;
  session: { text: string | null; pendingTool: boolean; activity: boolean };
}): ForegroundTickPlan {
  if (input.state === 'blocked') return { kind: 'blocked' };
  if (input.state !== 'idle' && input.state !== 'done' && input.state !== 'error') return { kind: 'continue' };
  if (input.session.text) return { kind: 'settled', text: input.session.text };
  if (input.session.pendingTool || !input.session.activity) return { kind: 'wait', delayMs: FOREGROUND_POLL_MS };
  return { kind: 'collect-final' };
}

/* ── task-id resolution ─────────────────────────────────────────── */

export type TaskIdResolutionResult =
  | { kind: 'resolved'; taskId: string }
  | { kind: 'ambiguous'; query: string; candidates: string[] }
  | { kind: 'too_short'; query: string }
  | { kind: 'not_found'; query: string };

/** Resolve a full or short task ID: exact matches at any length, prefix matches need four characters. */
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

/** Error text for a non-resolved `resolveTaskIdPrefix` outcome; null for `resolved` (each caller owns
 * its success path) and `not_found` (each caller words its own unknown-id hint). `rawQuery` keeps
 * the caller's original string in the message even though matching works on the trimmed form. */
export function taskIdResolutionError(
  res: TaskIdResolutionResult,
  label: 'task id' | 'subagent id',
  rawQuery: string,
): string | null {
  if (res.kind === 'too_short') return `Error: ${label} prefix "${rawQuery}" is too short (minimum 4 characters).`;
  if (res.kind === 'ambiguous') return ambiguousIdError(label, rawQuery, res.candidates);
  return null;
}

/* ── outbound port (composition root → plugin) ──────────────────── */

/** Bound atomically at session_start: consumers read `current` and must tolerate null. */
export interface SubagentPort {
  applyReplySession(paneId: string, sessionFile: string | null): void;
  reconcileOnReply(paneId: string): string[];
  listRunningSubs(): Array<{ paneId: string; slug?: string; description: string; kind: string }>;
  /** D113: non-closed rows for the /pier-tree view (settled nodes carry their settle time). */
  listRows(): Array<{ paneId: string; slug?: string; description: string; kind: string; status: SubEntry['status']; settledAt: number | null }>;
  settleStatLine(paneId: string): Promise<string | null>;
  /** Pipe settlement: drop the row out of listRunningSubs before the finish notice wakes the master. */
  consumeReply(paneId: string, outcome: string | null): void;
}

export interface SubagentPortBox {
  current: SubagentPort | null;
}

export function emptySubagentPortBox(): SubagentPortBox {
  return { current: null };
}
