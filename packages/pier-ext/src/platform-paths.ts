import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Platform-aware storage and workspace path resolution.
 * 
 * Why: Centralizes platform-specific path logic to support Windows (LOCALAPPDATA),
 * Unix XDG conventions, and testability through injection.
 */

export interface PlatformPaths {
  /** Base directory for agent sessions and state */
  readonly agentDataDir: string
  /** Base directory for worktrees */
  readonly worktreeBaseDir: string
  /** Sessions subdirectory under agent data */
  readonly sessionsDir: string
}

function getDefaultDataDir(): string {
  const platform = process.platform
  
  if (platform === 'win32') {
    // Windows: use LOCALAPPDATA or fallback to homedir
    return process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  }
  
  // Unix: XDG_DATA_HOME or ~/.local/share on Linux, ~/.local/share on macOS
  if (platform === 'linux') {
    return process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  }
  
  // macOS: use ~/.local/share for consistency, but .pi is acceptable legacy
  return process.env.XDG_DATA_HOME || join(homedir(), '.pi')
}

function getDefaultWorktreeDir(): string {
  const platform = process.platform
  
  if (platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    return join(localAppData, 'herdr', 'worktrees')
  }
  
  // Unix: use XDG_DATA_HOME or ~/.local/share
  if (platform === 'linux') {
    const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
    return join(dataHome, 'herdr', 'worktrees')
  }
  
  // macOS legacy: ~/.herdr/worktrees
  return join(homedir(), '.herdr', 'worktrees')
}

export function createPlatformPaths(overrides?: Partial<PlatformPaths>): PlatformPaths {
  const defaultAgentDataDir = join(getDefaultDataDir(), 'agent')
  const agentDataDir = overrides?.agentDataDir || defaultAgentDataDir
  const sessionsDir = overrides?.sessionsDir || join(agentDataDir, 'sessions')
  const worktreeBaseDir = overrides?.worktreeBaseDir || getDefaultWorktreeDir()
  
  return {
    agentDataDir,
    sessionsDir,
    worktreeBaseDir,
  }
}

/**
 * Singleton platform paths for production use.
 * Tests should inject via createPlatformPaths().
 */
export const platformPaths = createPlatformPaths()
