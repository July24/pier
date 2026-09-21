/**
 * Disposal ledger shared by HMR and session shutdown (D80⑤ + D79).
 *
 * HMR partial reload can skip old fiber effect disposers, so process-level resources (intervals, pipe
 * servers, watchers) would leak without compensation. Modules register those resources by module key;
 * reload disposes matching keys, session_shutdown disposes everything. D79 reuses the same mechanism
 * for pi-surface registration cleanup, where keys need not be file paths.
 */

import { fileURLToPath } from 'node:url';

function normalizeModuleKey(spec: string): string {
  let s = String(spec);
  try {
    if (s.startsWith('file://')) s = fileURLToPath(s);
  } catch {
    // Malformed URL: keep the caller's key so disposal still matches.
  }
  return s.replace(/\\/g, '/');
}

export class DisposeLedger {
  /** LIFO order matches Cordis effect disposal semantics. */
  private order: Array<{ key: string; dispose: () => void }> = [];

  /** Register a resource; the returned cancellation makes self-disposal a no-op. */
  add(spec: string, dispose: () => void): () => void {
    const entry = { key: normalizeModuleKey(spec), dispose };
    this.order.push(entry);
    return () => {
      const i = this.order.indexOf(entry);
      if (i >= 0) this.order.splice(i, 1);
    };
  }

  disposeKey(spec: string | string[]): number {
    const keys = (Array.isArray(spec) ? spec : [spec]).map(normalizeModuleKey);
    let n = 0;
    for (let i = this.order.length - 1; i >= 0; i--) {
      if (!keys.includes(this.order[i]!.key)) continue;
      const { dispose } = this.order.splice(i, 1)[0]!;
      try { dispose(); } catch { /* Compensation must never abort the reload. */ }
      n++;
    }
    return n;
  }

  disposeAll(): number {
    let n = 0;
    while (this.order.length > 0) {
      const { dispose } = this.order.pop()!;
      try { dispose(); } catch { /* Reload/shutdown must survive a broken disposer. */ }
      n++;
    }
    return n;
  }

  get size(): number {
    return this.order.length;
  }
}
