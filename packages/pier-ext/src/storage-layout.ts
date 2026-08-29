/**
 * Storage path layout (history, session dirs, role dirs).
 *
 * Why: sessionDirName / historyFilePath / userRolesDir were duplicated across
 * history-store, session-tail, and role-loader. One module owns the encoding
 * so path conventions cannot drift.
 *
 * Writes use a collision-resistant encoding (`a/b` ≠ `a-b`). Reads prefer the
 * new name, then the legacy flattened name, so existing history/session dirs
 * stay reachable. If only the legacy dir exists, writes keep appending there
 * instead of splitting the ledger.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Legacy flattening (`--F--herdr-pi--`).
 * Why kept: `a/b` and `a-b` collide, but on-disk dirs already use this form.
 */
export function sessionDirNameLegacy(cwd: string): string {
  const flat = cwd.replace(/[\\/]/g, '-').replace(/:/g, '-');
  return `--${flat}--`;
}

/**
 * Collision-resistant session directory name.
 * `%` is escaped first so `/` `\` `:` round-trip: `a/b` → `--a%2Fb--`, `a-b` → `--a-b--`.
 */
export function sessionDirName(cwd: string): string {
  const encoded = cwd
    .replace(/%/g, '%25')
    .replace(/\\/g, '%5C')
    .replace(/\//g, '%2F')
    .replace(/:/g, '%3A');
  return `--${encoded}--`;
}

/** New encoding first, then legacy when they differ. */
export function sessionDirCandidates(cwd: string): readonly string[] {
  const next = sessionDirName(cwd);
  const prev = sessionDirNameLegacy(cwd);
  return next === prev ? [next] : [next, prev];
}

/**
 * Directory to read/write under `parent`.
 * Existing legacy dirs win over a missing new dir so history is not split.
 */
export function preferredSessionDir(parent: string, cwd: string): string {
  const names = sessionDirCandidates(cwd);
  for (const name of names) {
    const dir = join(parent, name);
    if (existsSync(dir)) return dir;
  }
  return join(parent, names[0]);
}

export function historyFilePath(agentRoot: string, cwd: string): string {
  return join(agentRoot, 'herdr-pi', 'history', sessionDirName(cwd), 'history.jsonl');
}

export function historyFilePathLegacy(agentRoot: string, cwd: string): string {
  return join(agentRoot, 'herdr-pi', 'history', sessionDirNameLegacy(cwd), 'history.jsonl');
}

/** Dual-read history path: existing ledger (legacy or new) else canonical new file. */
export function preferredHistoryFile(agentRoot: string, cwd: string): string {
  return join(preferredSessionDir(join(agentRoot, 'herdr-pi', 'history'), cwd), 'history.jsonl');
}

/** User-global roles directory (`~/.pi/agent/herdr-pi/roles/`). */
export function userRolesDir(): string {
  return join(homedir(), '.pi', 'agent', 'herdr-pi', 'roles');
}

/** Workspace-level roles directory (`<base>/.pi-herdr/roles/`). */
export function workspaceRolesDir(baseDir: string): string {
  return join(baseDir, '.pi-herdr', 'roles');
}
