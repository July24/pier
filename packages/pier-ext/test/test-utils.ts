/**
 * Test utilities for isolation and cleanup.
 * 
 * Why: Centralizes test isolation patterns to prevent state pollution,
 * resource leaks, and flaky tests.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Manages temporary directory lifecycle for tests.
 * Automatically cleans up on dispose.
 */
export class TempDir {
  readonly path: string;
  
  constructor(prefix: string) {
    this.path = mkdtempSync(join(tmpdir(), `pier-test-${prefix}-`));
  }
  
  dispose(): void {
    try {
      rmSync(this.path, { recursive: true, force: true });
    } catch {
      // Best effort cleanup
    }
  }
}

/**
 * Manages process.env modifications for tests.
 * Automatically restores on dispose.
 */
export class EnvSnapshot {
  private readonly snapshot = new Map<string, string | undefined>();
  
  set(key: string, value: string): void {
    if (!this.snapshot.has(key)) {
      this.snapshot.set(key, process.env[key]);
    }
    process.env[key] = value;
  }
  
  delete(key: string): void {
    if (!this.snapshot.has(key)) {
      this.snapshot.set(key, process.env[key]);
    }
    delete process.env[key];
  }
  
  dispose(): void {
    for (const [key, originalValue] of this.snapshot) {
      if (originalValue === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalValue;
      }
    }
    this.snapshot.clear();
  }
}

/**
 * Wraps a test function with automatic cleanup.
 * 
 * @example
 * test('my test', withCleanup(async (cleanup) => {
 *   const tempDir = cleanup.tempDir('my-test');
 *   const env = cleanup.env();
 *   env.set('MY_VAR', 'value');
 *   // Test code...
 *   // Cleanup happens automatically
 * }));
 */
export function withCleanup<T>(
  fn: (cleanup: CleanupContext) => T | Promise<T>
): () => T | Promise<T> {
  return async () => {
    const tempDirs: TempDir[] = [];
    const envSnapshots: EnvSnapshot[] = [];
    
    const cleanup: CleanupContext = {
      tempDir: (prefix: string) => {
        const dir = new TempDir(prefix);
        tempDirs.push(dir);
        return dir;
      },
      env: () => {
        const env = new EnvSnapshot();
        envSnapshots.push(env);
        return env;
      },
    };
    
    try {
      return await fn(cleanup);
    } finally {
      // Cleanup in reverse order
      for (const env of envSnapshots.reverse()) {
        env.dispose();
      }
      for (const dir of tempDirs.reverse()) {
        dir.dispose();
      }
    }
  };
}

export interface CleanupContext {
  tempDir(prefix: string): TempDir;
  env(): EnvSnapshot;
}

/**
 * Creates a mock timer context using Node.js MockTimers.
 * 
export function withMockTimers<T>(
  fn: (timers: MockTimersContext) => T | Promise<T>
): () => T | Promise<T> {
  return async () => {
    const timers = {
      advance: async (ms: number) => {
        // Node.js MockTimers API (best-effort access to experimental API)
        const globalSetTimeout = global.setTimeout as typeof setTimeout & { clock?: { tick?: (ms: number) => Promise<void> } };
        const mockTimers = globalSetTimeout.clock;
        if (mockTimers?.tick) {
          await mockTimers.tick(ms);
        }
      },
      setSystemTime: (timestamp: number) => {
        const globalSetTimeout = global.setTimeout as typeof setTimeout & { clock?: { setSystemTime?: (timestamp: number) => void } };
        const mockTimers = globalSetTimeout.clock;
        if (mockTimers?.setSystemTime) {
          mockTimers.setSystemTime(timestamp);
        }
    
    return await fn(timers);
  };
}

export interface MockTimersContext {
  advance(ms: number): Promise<void>;
  setSystemTime(timestamp: number): void;
}
