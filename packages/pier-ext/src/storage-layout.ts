/**
 * Storage path layout (history, session dirs, role dirs) — the single owner of the session-dir
 * encoding, so history-store / session-tail / role-loader cannot drift apart.
 *
 * Writes use a collision-resistant encoding (`a/b` ≠ `a-b`); reads try the new name, then the legacy
 * flattened name, and when only the legacy dir exists writes keep appending there (no split ledger).
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Legacy flattening (`--F--herdr-pi--`): `a/b` and `a-b` collide, but on-disk dirs use this form. */
export function sessionDirNameLegacy(cwd: string): string {
  return `--${cwd.replace(/[\\/]/g, '-').replace(/:/g, '-')}--`;
}

/** Collision-resistant name: `%` is escaped first so `/` `\` `:` round-trip (`a/b` → `--a%2Fb--`). */
export function sessionDirName(cwd: string): string {
  const encoded = cwd
    .replace(/%/g, '%25')
    .replace(/\\/g, '%5C')
    .replace(/\//g, '%2F')
    .replace(/:/g, '%3A');
  return `--${encoded}--`;
}

export function sessionDirCandidates(cwd: string): readonly string[] {
  const next = sessionDirName(cwd);
  const prev = sessionDirNameLegacy(cwd);
  return next === prev ? [next] : [next, prev];
}

/**
 * pi core's own session-directory encoding, byte-for-byte: strip ONE leading separator, then flatten
 * `/` `\` `:` — it does NOT escape `%` like `sessionDirName`. `<agentDir>/sessions/` is pi core's
 * directory, so reading pi sessions must match it exactly.
 */
export function piCoreSessionDirName(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}

/**
 * pi core's exact name first, then pier's own encodings (they may hold stray dirs from earlier
 * versions). Read-only: writes to `<agentDir>/sessions/` are pi core's business.
 */
export function piSessionDirCandidates(cwd: string): readonly string[] {
  return [...new Set([piCoreSessionDirName(cwd), ...sessionDirCandidates(cwd)])];
}

/** Directory to read/write under `parent`: an existing legacy dir wins so history is not split. */
export function preferredSessionDir(parent: string, cwd: string): string {
  const names = sessionDirCandidates(cwd);
  return names.map((name) => join(parent, name)).find(existsSync) ?? join(parent, names[0]!);
}

export function historyFilePath(agentRoot: string, cwd: string): string {
  return join(agentRoot, 'herdr-pi', 'history', sessionDirName(cwd), 'history.jsonl');
}

export function historyFilePathLegacy(agentRoot: string, cwd: string): string {
  return join(agentRoot, 'herdr-pi', 'history', sessionDirNameLegacy(cwd), 'history.jsonl');
}

export function preferredHistoryFile(agentRoot: string, cwd: string): string {
  return join(preferredSessionDir(join(agentRoot, 'herdr-pi', 'history'), cwd), 'history.jsonl');
}

export function userRolesDir(): string {
  return join(homedir(), '.pi', 'agent', 'herdr-pi', 'roles');
}

export function workspaceRolesDir(baseDir: string): string {
  return join(baseDir, '.pi-herdr', 'roles');
}
