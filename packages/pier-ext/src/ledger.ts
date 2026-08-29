/**
 * Disposal ledger shared by HMR and session shutdown (D80⑤ + D79).
 *
 * HMR partial reload can skip old fiber effect disposers, so process-level resources
 * such as intervals, pipe servers, and watchers would leak without compensation.
 * Core modules register those resources by module key; reload disposes matching keys,
 * while session_shutdown disposes everything.
 *
 * D79 reuses this mechanism for pi-surface registration cleanup; logical keys need not
 * be file paths. The ledger stays dependency-free and connects through bootstrap/index.
 */

import { fileURLToPath } from 'node:url';

/** Normalize file URLs and paths to comparable absolute keys for HMR matching. */
export function normalizeModuleKey(spec: string): string {
  let s = String(spec);
  try {
    if (s.startsWith('file://')) s = fileURLToPath(s);
  } catch {
    /* Keep malformed URLs unchanged so disposal can still use the caller's key. */
  }
  return s.replace(/\\/g, '/');
}

export class DisposeLedger {
  /** LIFO order matches Cordis effect disposal semantics. */
  private order: Array<{ key: string; dispose: () => void }> = [];

  /** Register a resource and return cancellation so self-disposal cannot run twice. */
  add(spec: string, dispose: () => void): () => void {
    const entry = { key: normalizeModuleKey(spec), dispose };
    this.order.push(entry);
    return () => {
      const i = this.order.indexOf(entry);
      if (i >= 0) this.order.splice(i, 1);
    };
  }

  /** HMR compensation disposes only matching keys in LIFO order. */
  disposeKey(spec: string | string[]): number {
    const keys = new Set((Array.isArray(spec) ? spec : [spec]).map(normalizeModuleKey));
    let n = 0;
    for (let i = this.order.length - 1; i >= 0; i--) {
      if (keys.has(this.order[i].key)) {
        const { dispose } = this.order[i];
        this.order.splice(i, 1);
        try { dispose(); } catch { /* Compensation failures are non-fatal. */ }
        n++;
      }
    }
    return n;
  }

  /** Dispose every entry in LIFO order during session_shutdown. */
  disposeAll(): number {
    let n = 0;
    while (this.order.length > 0) {
      const { dispose } = this.order.pop()!;
      try { dispose(); } catch { /* Compensation failures are non-fatal. */ }
      n++;
    }
    return n;
  }

  get size(): number {
    return this.order.length;
  }
}
