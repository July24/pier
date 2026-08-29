/**
 * Git/worktree I/O used by spawn, isolate, GC, and settlement stat lines.
 *
 * Why: core/subagent mixed adapter calls with tool registration. Centralizing
 * git behind one cache/timeout policy keeps placement and isolate GC consistent.
 */
import { defaultGitAdapter, type GitAdapter } from './git-adapter.ts';
import { formatWorktreeStat, type SubEntry } from './subagent-core.ts';

const WORKTREES_CACHE_MS = 5000;
export interface GitIo {
  listWorktrees(cwd: string): Promise<string[]>;
  runGit(cwd: string, args: string[]): Promise<string | null>;
  worktreeStatLine(entry: SubEntry): Promise<string | null>;
  invalidateWorktreesCache(): void;
}

export function createGitIo(git: GitAdapter = defaultGitAdapter): GitIo {
  let worktreesCache: { at: number; list: string[] } | null = null;
  async function listWorktrees(cwd: string): Promise<string[]> {
    if (worktreesCache && Date.now() - worktreesCache.at < WORKTREES_CACHE_MS) return worktreesCache.list;
    let list: string[] = [];
    try {
      const { stdout } = await git.listWorktrees(cwd);
      for (const line of String(stdout).split('\n')) {
        const m = /^worktree (.+)$/.exec(line.trim());
        if (m) list.push(m[1]);
      }
    } catch {
      list = [];
    }
    worktreesCache = { at: Date.now(), list };
    return list;
  }

  async function runGit(cwd: string, args: string[]): Promise<string | null> {
    try {
      const { stdout } = await git.run(cwd, args);
      return stdout == null ? null : String(stdout);
    } catch {
      return null;
    }
  }

  function lastStatLine(out: string | null): string | null {
    if (!out) return null;
    const lines = out.replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
    return lines.length ? lines[lines.length - 1]! : null;
  }

  async function worktreeStatLine(entry: SubEntry): Promise<string | null> {
    const porcelain = await runGit(entry.cwd, ['status', '--porcelain']);
    if (porcelain === null) return null;
    const dirtyCount = porcelain.split('\n').filter((l) => l.trim() !== '').length;
    if (entry.isolate) {
      const statOut = await runGit(entry.cwd, ['diff', '--stat', `${entry.isolate.baseSha}...HEAD`]);
      const commitsOut = await runGit(entry.cwd, ['rev-list', '--count', `${entry.isolate.baseSha}..HEAD`]);
      const commits = commitsOut != null && /^\d+$/.test(commitsOut.trim()) ? Number(commitsOut.trim()) : null;
      return formatWorktreeStat({ branch: entry.isolate.branch, commits, statLine: lastStatLine(statOut), dirtyCount });
    }
    return formatWorktreeStat({
      branch: null,
      commits: null,
      statLine: lastStatLine(await runGit(entry.cwd, ['diff', '--stat', 'HEAD'])),
      dirtyCount,
    });
  }

  function invalidateWorktreesCache(): void {
    worktreesCache = null;
  }

  return {
    listWorktrees,
    runGit,
    worktreeStatLine,
    invalidateWorktreesCache,
  };
}

