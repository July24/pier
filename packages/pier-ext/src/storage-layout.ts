/**
 * Storage path layout (history, session dirs, role dirs).
 *
 * Why: sessionDirName / historyFilePath / userRolesDir were duplicated across
 * history-store, session-tail, and role-loader. One module owns the encoding
 * so path conventions cannot drift.
 *
 * Encoding is the observed pi convention (`--F--herdr-pi--`). Collision-resistant
 * encoding is intentionally not applied here — changing it would orphan existing
 * history and session directories.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

/** pi session directory name: cwd → `--F--herdr-pi--` (observed naming). */
export function sessionDirName(cwd: string): string {
  const flat = cwd.replace(/[\\/]/g, '-').replace(/:/g, '-');
  return `--${flat}--`;
}

export function historyFilePath(agentRoot: string, cwd: string): string {
  return join(agentRoot, 'herdr-pi', 'history', sessionDirName(cwd), 'history.jsonl');
}

/** User-global roles directory (`~/.pi/agent/herdr-pi/roles/`). */
export function userRolesDir(): string {
  return join(homedir(), '.pi', 'agent', 'herdr-pi', 'roles');
}

/** Workspace-level roles directory (`<base>/.pi-herdr/roles/`). */
export function workspaceRolesDir(baseDir: string): string {
  return join(baseDir, '.pi-herdr', 'roles');
}
