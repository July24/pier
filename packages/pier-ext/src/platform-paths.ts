import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Platform-aware storage and workspace path resolution: Windows uses LOCALAPPDATA, Linux XDG,
 * macOS keeps `~/.pi` (with XDG override); herdr keeps its worktrees next to the data dir on
 * Windows/Linux but under `~/.herdr` on macOS. Everything is injectable for tests.
 */
export interface PlatformPaths {
  /** Base directory for agent sessions and state */
  readonly agentDataDir: string
  /** Base directory for worktrees */
  readonly worktreeBaseDir: string
  /** Sessions subdirectory under agent data */
  readonly sessionsDir: string
}

const PLATFORM_DEFAULTS: Record<string, {
  /** Env var that overrides the data dir when set. */
  readonly envVar: string
  /** Data dir under $HOME when the env var is unset. */
  readonly homeFallback: readonly string[]
  /** Whether herdr keeps worktrees under the data dir (macOS uses ~/.herdr instead). */
  readonly worktreesUnderData: boolean
}> = {
  win32: { envVar: 'LOCALAPPDATA', homeFallback: ['AppData', 'Local'], worktreesUnderData: true },
  linux: { envVar: 'XDG_DATA_HOME', homeFallback: ['.local', 'share'], worktreesUnderData: true },
  darwin: { envVar: 'XDG_DATA_HOME', homeFallback: ['.pi'], worktreesUnderData: false },
}

export function createPlatformPaths(overrides?: Partial<PlatformPaths>): PlatformPaths {
  const layout = PLATFORM_DEFAULTS[process.platform] ?? PLATFORM_DEFAULTS.darwin!
  const dataDir = process.env[layout.envVar] || join(homedir(), ...layout.homeFallback)
  const agentDataDir = overrides?.agentDataDir || join(dataDir, 'agent')

  return {
    agentDataDir,
    sessionsDir: overrides?.sessionsDir || join(agentDataDir, 'sessions'),
    worktreeBaseDir: overrides?.worktreeBaseDir
      || (layout.worktreesUnderData ? join(dataDir, 'herdr', 'worktrees') : join(homedir(), '.herdr', 'worktrees')),
  }
}

/**
 * Singleton platform paths for production use.
 * Tests should inject via createPlatformPaths().
 */
export const platformPaths = createPlatformPaths()
