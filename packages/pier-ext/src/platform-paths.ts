import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Windows uses LOCALAPPDATA, Linux XDG, macOS keeps `~/.pi` (with XDG override); herdr keeps its
 * worktrees next to the data dir on Windows/Linux but under `~/.herdr` on macOS. Injectable for tests.
 */
export interface PlatformPaths {
  readonly agentDataDir: string
  readonly worktreeBaseDir: string
  readonly sessionsDir: string
}

const PLATFORM_DEFAULTS: Record<string, {
  readonly envVar: string
  readonly homeFallback: readonly string[]
  /** macOS keeps worktrees in ~/.herdr instead of under the data dir. */
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

/** Singleton for production; tests inject via createPlatformPaths(). */
export const platformPaths = createPlatformPaths()
