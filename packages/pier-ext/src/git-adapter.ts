import { execFile as nodeExecFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFile = promisify(nodeExecFile)

export interface GitResult {
  readonly stdout: string
  readonly stderr: string
}

export interface GitError extends Error {
  readonly code?: string | number
  readonly stdout?: string
  readonly stderr?: string
}

/**
 * Minimal Git adapter for worktree and status operations.
 * 
 * Why: Centralizes platform-specific git executable resolution, timeout policy,
 * and error normalization; makes tests independent of real git processes.
 */
export interface GitAdapter {
  /**
   * List worktrees in porcelain format.
   * Returns stdout containing worktree entries.
   */
  listWorktrees(cwd: string): Promise<GitResult>
  
  /**
   * Get status of worktree in short format.
   * Returns stdout containing status entries.
   */
  status(cwd: string): Promise<GitResult>
}

export class NodeGitAdapter implements GitAdapter {
  constructor(
    private readonly gitExecutable: string = 'git',
    private readonly timeoutMs: number = 10_000,
  ) {}
  
  async listWorktrees(cwd: string): Promise<GitResult> {
    try {
      const { stdout, stderr } = await execFile(
        this.gitExecutable,
        ['-C', cwd, 'worktree', 'list', '--porcelain'],
        { timeout: this.timeoutMs, encoding: 'utf8' },
      )
      return { stdout, stderr }
    } catch (err) {
      throw this.normalizeError(err, 'list worktrees')
    }
  }
  
  async status(cwd: string): Promise<GitResult> {
    try {
      const { stdout, stderr } = await execFile(
        this.gitExecutable,
        ['-C', cwd, 'status', '--short'],
        { timeout: this.timeoutMs, encoding: 'utf8' },
      )
      return { stdout, stderr }
    } catch (err) {
      throw this.normalizeError(err, 'status')
    }
  }
  
  private normalizeError(err: unknown, operation: string): GitError {
    if (err instanceof Error) {
      const gitError = err as GitError
      gitError.message = `Git ${operation} failed: ${gitError.message}`
      return gitError
    }
    return new Error(`Git ${operation} failed: ${String(err)}`) as GitError
  }
}

/**
 * Default production git adapter.
 * Tests should inject fake implementations.
 */
export const defaultGitAdapter = new NodeGitAdapter()
