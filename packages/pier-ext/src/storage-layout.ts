/**
 * Storage path layout (history, session dirs, role dirs) — the single owner of the session-dir
 * encoding, so history-store / session-tail / role-loader cannot drift apart.
 *
 * Writes use a collision-resistant encoding (`a/b` ≠ `a-b`); reads try the new name, then the
 * legacy flattened name, so existing history/session dirs stay reachable — and when only the
 * legacy dir exists, writes keep appending there instead of splitting the ledger.
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

/** New encoding first, then legacy when they differ. */
export function sessionDirCandidates(cwd: string): readonly string[] {
  const next = sessionDirName(cwd);
  const prev = sessionDirNameLegacy(cwd);
  return next === prev ? [next] : [next, prev];
}

/**
 * pi core's own session-directory encoding, byte-for-byte: strip ONE leading separator, then
 * flatten `/` `\` `:` — note it does NOT escape `%` like `sessionDirName` does.
 * `<agentDir>/sessions/` is pi core's directory, so reading pi sessions must match it exactly.
 */
export function piCoreSessionDirName(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}

/**
 * Candidates for reading pi core's session dirs: pi core's exact name first, then pier's own
 * encodings (they may hold stray dirs from earlier versions). Read-only by design: writes to
 * `<agentDir>/sessions/` are pi core's business.
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

/** Dual-read history path: the existing ledger (legacy or new) else the canonical new file. */
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
