/**
 * M18 file-level write locks (S2: soft veto by default, `PI_HERDR_WRITE_LOCK=1` makes it hard).
 *
 * A lock is a *beacon*, not a mutex: the pane editing a file reports a token
 * (`lock-<hash>` → `paneId|path`, see herdr-client.reportLockTokens) and every other pane reads
 * the token table to warn or block. Tokens must match `^[A-Za-z0-9_-]{1,32}$` with ≤16 keys per
 * report, hence the hashed key and the path inside the value.
 */
import { resolve, sep } from 'node:path';

export const WRITE_LOCK_ENV = 'PI_HERDR_WRITE_LOCK';
export const WRITE_TOOLS = ['write', 'edit'] as const;
export const LOCK_TOKEN_PREFIX = 'lock-';
export const LOCK_BATCH_LIMIT = 16;
export const LOCK_TTL_MS = 60 * 60 * 1000;

export interface LockAgentView {
  paneId: string;
  tokens: Record<string, string | null>;
}

/** Case-folded, separator-unified absolute path: the key every lock lookup agrees on. */
export function normalizeLockPath(p: string, cwd: string): string {
  const abs = resolve(cwd, p);
  const unified = sep === '\\' ? abs.replace(/\\/g, '/') : abs;
  return unified.toLowerCase().replace(/\/+$/, '');
}

export function fnv1a64(s: string): string {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

export function lockTokenKey(normPath: string): string {
  return `${LOCK_TOKEN_PREFIX}${fnv1a64(normPath)}`;
}

export function lockTokenValue(normPath: string, paneId: string): string {
  return `${paneId}|${normPath}`;
}

export function parseLockTokenValue(v: string): { holderPaneId: string; path: string } | null {
  const i = v.indexOf('|');
  if (i <= 0 || i === v.length - 1) return null;
  return { holderPaneId: v.slice(0, i), path: v.slice(i + 1) };
}

export function isLockTokenKey(key: string): boolean {
  return key.startsWith(LOCK_TOKEN_PREFIX) && key.length > LOCK_TOKEN_PREFIX.length;
}

export function writePathsOfTool(toolName: string, input: unknown): string[] {
  if (!(WRITE_TOOLS as readonly string[]).includes(toolName)) return [];
  const p = (input as { path?: unknown } | null | undefined)?.path;
  return typeof p === 'string' && p.trim() ? [p] : [];
}

/**
 * B7: write-locks only see the write/edit tools, so a `bash` command that redirects into a file
 * bypasses the beacon entirely (`> file`, `>> file`, `tee file`, `sed -i`, `truncate -s 0`).
 * We do not try to parse shell: this extracts the *obvious* targets so the lock layer can raise a
 * soft warning, and the limitation stays documented rather than implied. Unknown syntax yields no
 * paths — a false negative is cheap, a false block is not.
 */
export function bashWriteTargets(command: unknown): string[] {
  if (typeof command !== 'string' || command.trim() === '') return [];
  const found: string[] = [];
  // Quoted or bare targets; stops at shell metacharacters, ignores process substitution.
  const target = String.raw`(?:'([^']+)'|"([^"]+)"|([^\s;|&<>()]+))`;
  const patterns = [
    new RegExp(String.raw`(?:^|[^0-9>])>>?\s*` + target, 'g'), // > file, >> file
    new RegExp(String.raw`\btee\s+(?:-a\s+)?` + target, 'g'), // tee [-a] file
    new RegExp(String.raw`\btruncate\s+-s\s*0\s+` + target, 'g'), // truncate -s 0 file
  ];
  for (const re of patterns) {
    for (const m of command.matchAll(re)) {
      const path = (m[1] ?? m[2] ?? m[3] ?? '').trim();
      const quoted = m[1] !== undefined || m[2] !== undefined;
      if (isObviousPath(path, quoted)) found.push(path);
    }
  }
  // `sed -i '' 's/a/b/' file`: the first argument is the (possibly empty) backup suffix and the
  // second the expression, so the LAST argument is the file.
  for (const m of command.matchAll(/\bsed\s+-i[^\s]*\s+([^|;&\n]+)/g)) {
    const args = splitShellWords(m[1] ?? '');
    for (let i = args.length - 1; i >= 0; i -= 1) {
      const candidate = args[i]!;
      if (candidate.startsWith('-')) continue;
      if (isObviousPath(candidate)) found.push(candidate);
      break;
    }
  }
  return [...new Set(found)];
}

/** Only unquoted, metacharacter-free paths count as "obvious" (anything else is left to the shell). */
function isObviousPath(path: string, quoted = false): boolean {
  if (path === '' || path === '/' || path.startsWith('$')) return false;
  if (/['"`$*?{}()[\]]/.test(path)) return false; // Never a literal path (expansion, glob, nested quotes).
  return quoted ? true : !/\s/.test(path); // An explicitly quoted target may contain spaces.
}

/** Whitespace split that keeps quoted segments together and strips their quotes. */
function splitShellWords(input: string): string[] {
  const out: string[] = [];
  for (const m of input.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out.filter((s) => s !== '');
}

/** Soft hint shown after a bash call that wrote into a path another pane has locked. */
function formatBashLockHint(normPath: string, holders: readonly string[]): string {
  return `Note: this bash command wrote to ${normPath}, which ${holdersLabel(holders)} is editing. `
    + `Write-locks only cover the write/edit tools, so this write was not blocked: re-read the file before your next edit.`;
}

/**
 * Every *other* pane currently holding a beacon for this path (deduped, in list order).
 * Several panes can hold the same path, so callers get the whole list.
 */
export function findLockHolders(
  agents: readonly LockAgentView[],
  ownPaneId: string,
  normPath: string,
): string[] {
  const key = lockTokenKey(normPath);
  const holders: string[] = [];
  for (const a of agents) {
    const v = a.tokens[key];
    if (typeof v !== 'string' || !v) continue;
    const parsed = parseLockTokenValue(v);
    if (parsed && parsed.holderPaneId !== ownPaneId && !holders.includes(parsed.holderPaneId)) {
      holders.push(parsed.holderPaneId);
    }
  }
  return holders;
}

/** Where to look for the full holder table: humans use the slash command, agents read herdr tokens. */
const LOCK_HOLDERS_HINT =
  'holders: /locks (human view in this pane) · herdr agent list → tokens (agent-readable)';

function holdersLabel(holders: readonly string[]): string {
  return holders.length === 1 ? `pane ${holders[0]}` : `panes ${holders.join(', ')}`;
}

function formatConflictWarning(normPath: string, holders: readonly string[]): string {
  return `⚠️ write conflict: ${normPath} is locked by ${holdersLabel(holders)} (edited in another pane that has not settled). This write went through (soft mode) — coordinate to avoid clobbering each other's changes. ${LOCK_HOLDERS_HINT}`;
}

export type WriteGuardPlan =
  | { kind: 'skip' }
  | { kind: 'pass'; paths: string[] }
  | { kind: 'warn'; paths: string[]; holderPaneIds: string[]; warning: string }
  | { kind: 'block'; paths: string[]; holderPaneIds: string[]; reason: string };

export function planWriteGuard(opts: {
  toolName: string;
  input: unknown;
  agents: readonly LockAgentView[];
  ownPaneId: string;
  cwd: string;
  hard: boolean;
}): WriteGuardPlan {
  // B7: bash redirects are invisible to the write tools, so warn (never block) when their obvious
  // targets collide with a lock beacon held by another pane.
  const isBash = opts.toolName === 'bash';
  const raw = isBash
    ? bashWriteTargets((opts.input as { command?: unknown } | null | undefined)?.command)
    : writePathsOfTool(opts.toolName, opts.input);
  if (raw.length === 0) return { kind: 'skip' };
  const paths = raw.map((p) => normalizeLockPath(p, opts.cwd));
  for (const norm of paths) {
    const holders = findLockHolders(opts.agents, opts.ownPaneId, norm);
    if (holders.length === 0) continue;
    if (opts.hard && !isBash) {
      return {
        kind: 'block',
        paths,
        holderPaneIds: holders,
        reason: `file locked by ${holdersLabel(holders)}: ${norm} is being edited in another pane. Wait for it to settle, or coordinate before writing. ${LOCK_HOLDERS_HINT}`,
      };
    }
    return {
      kind: 'warn',
      paths,
      holderPaneIds: holders,
      warning: isBash ? formatBashLockHint(norm, holders) : formatConflictWarning(norm, holders),
    };
  }
  return { kind: 'pass', paths };
}

export function acquireTokensFor(normPaths: readonly string[], paneId: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of normPaths) out[lockTokenKey(p)] = lockTokenValue(p, paneId);
  return out;
}

export function releaseTokensFor(normPaths: readonly string[]): Record<string, null> {
  const out: Record<string, null> = {};
  for (const p of normPaths) out[lockTokenKey(p)] = null;
  return out;
}
