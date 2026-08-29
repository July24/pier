/**
 * Proxy the pi ExtensionAPI registration surface (D79).
 *
 * pi exposes registration without unregister APIs: tools overwrite by name, but event
 * listeners accumulate. HMR therefore needs tombstoned, generation-scoped wrappers so
 * old listeners become inert while the latest generation remains active.
 *
 * Because HMR emits reload after mounting the replacement (d87), mounting a key retires
 * older generations immediately. The ledger then collects only generations registered
 * through the reload boundary; explicit disposal retires every generation.
 */
import type { DisposeLedger } from './ledger.ts';

/** Minimal pi ToolResult shape used when a disposed tool is invoked. */
const INERT_TOOL_RESULT = {
  content: [{ type: 'text' as const, text: 'Error: tool module disposed (hot-reloaded away); the new version has re-registered it.' }],
  details: {},
};

/** Module-scoped surface: tombstone tools and events, while command replacement is safe because pi stores commands in a Map. */
export interface ScopedSurface {
  registerTool(def: Record<string, unknown> & { name: string }): void;
  registerCommand(name: string, options: Record<string, unknown>): void;
  on(event: string, handler: (...args: unknown[]) => unknown): void;
}

interface Group {
  alive: boolean;
  /** Monotonic mount generation used by the ledger disposer to determine its collection boundary. */
  epoch: number;
}

/** Proxy for pi's registration surface (D79); non-registration methods (append/exec/setActiveTools, etc.) pass through raw. */
export class PiSurface<P extends object> {
  private groups = new Map<string, Group>();
  /** Generation history per key; mounting retires older generations so at most one stays alive until ledger collection. */
  private generations = new Map<string, Group[]>();
  private epochCounter = 0;
  /** Ledger generation boundary; disposal collects epochs up to this value, then the next mount registers again. */
  private ledgerEntryEpoch = new Map<string, number>();
  private readonly pi: P;
  private readonly ledger?: DisposeLedger;

  constructor(pi: P, ledger?: DisposeLedger) {
    this.pi = pi;
    this.ledger = ledger;
  }

  /** Raw pi surface, bypassing wrappers; migrated modules must not use it for registration. */
  get raw(): P {
    return this.pi;
  }

  /**
   * Get a module-scoped registration surface. Each call creates a new generation, retiring older
   * generations for the same key so HMR replacement and manual remounting share one lifecycle.
   * The ledger registers each key once and registers it again only after its entry is consumed.
   */
  forModule(key: string): ScopedSurface {
    this.epochCounter += 1;
    const epoch = this.epochCounter;
    for (const g of this.generations.get(key) ?? []) g.alive = false;
    const group: Group = { alive: true, epoch };
    this.generations.set(key, [group]);
    this.groups.set(key, group);
    if (this.ledger && !this.ledgerEntryEpoch.has(key)) {
      this.ledgerEntryEpoch.set(key, epoch);
      this.ledger.add(key, () => {
        const bound = this.ledgerEntryEpoch.get(key) ?? epoch;
        this.ledgerEntryEpoch.delete(key);
        this.generations.set(
          key,
          (this.generations.get(key) ?? []).filter((g) => {
            if (g.epoch <= bound) {
              g.alive = false;
              return false;
            }
            return true;
          }),
        );
      });
    }
    return {
      registerTool: (def) => {
        const original = def.execute as ((...a: unknown[]) => unknown) | undefined;
        const wrapped = original
          ? async (...a: unknown[]) => {
            if (!group!.alive) return INERT_TOOL_RESULT;
            return original(...a);
          }
          : undefined;
        (this.pi as { registerTool?: (d: unknown) => void }).registerTool?.(
          wrapped ? { ...def, execute: wrapped } : def,
        );
      },
      registerCommand: (name, options) => {
        // pi stores commands as Map<name> (verified in the dist implementation), so same-name
        // registration replaces safely; the handler tombstone is a symmetry safeguard even though
        // replacement means the old handler will no longer be called.
        const handler = options.handler as ((...a: unknown[]) => unknown) | undefined;
        const wrapped = handler
          ? (...a: unknown[]) => (group!.alive ? handler(...a) : undefined)
          : undefined;
        (this.pi as { registerCommand?: (n: string, o: Record<string, unknown>) => void })
          .registerCommand?.(name, wrapped ? { ...options, handler: wrapped } : options);
      },
      on: (event, handler) => {
        const wrapped = (...a: unknown[]) => (group!.alive ? handler(...a) : undefined);
        (this.pi as { on?: (e: string, h: (...a: unknown[]) => unknown) => void }).on?.(event, wrapped);
      },
    };
  }

  /** Retire all generations for a key during explicit disposal; return false when the key is absent. */
  disposeModule(key: string): boolean {
    const had = this.groups.has(key);
    for (const g of this.generations.get(key) ?? []) g.alive = false;
    this.generations.delete(key);
    this.groups.delete(key);
    this.ledgerEntryEpoch.delete(key);
    return had;
  }

  /** Number of live module groups, for tests and diagnostics. */
  get moduleCount(): number {
    return this.groups.size;
  }
}
