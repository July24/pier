/**
 * Proxy the pi ExtensionAPI registration surface (D79).
 *
 * pi 0.86+ `pi.on()` returns an unsubscribe, so event handlers are truly removed when their generation
 * retires (RFC docs/rfc-pi-0.86-dynamic-tools.md §5). Tools and commands have no unregister API: tools
 * overwrite by name, so retired generations keep tombstoned wrappers there. HMR emits reload after
 * mounting the replacement, so mounting a key retires older generations immediately; the ledger then
 * collects only generations registered through the reload boundary.
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
  unsubscribes: Array<() => void>;
}

/** Flip the tombstone and drain any native unsubscribes; retirement must never throw. */
function retireGroup(group: Group): void {
  group.alive = false;
  for (const off of group.unsubscribes) {
    try {
      off();
    } catch {
    }
  }
  group.unsubscribes.length = 0;
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

  /** Get a module-scoped registration surface; each call creates a new generation, retiring older ones
   *  for the same key. The ledger registers each key once and again only after its entry is consumed. */
  forModule(key: string): ScopedSurface {
    this.epochCounter += 1;
    const epoch = this.epochCounter;
    for (const g of this.generations.get(key) ?? []) retireGroup(g);
    const group: Group = { alive: true, epoch, unsubscribes: [] };
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
              retireGroup(g);
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
        // pi stores commands as Map<name>, so same-name registration replaces safely; the handler
        // tombstone is a symmetry safeguard even though the old handler will no longer be called.
        const handler = options.handler as ((...a: unknown[]) => unknown) | undefined;
        const wrapped = handler
          ? (...a: unknown[]) => (group!.alive ? handler(...a) : undefined)
          : undefined;
        (this.pi as { registerCommand?: (n: string, o: Record<string, unknown>) => void })
          .registerCommand?.(name, wrapped ? { ...options, handler: wrapped } : options);
      },
      on: (event, handler) => {
        // Pass-through while alive, tombstone after retirement; when pi (0.86+) returns an unsubscribe,
        // retirement also removes the registration so HMR churn cannot grow the dispatch list.
        const wrapped = (...a: unknown[]) => (group!.alive ? handler(...a) : undefined);
        const unsubscribe: unknown = (
          this.pi as { on?: (e: string, h: (...a: unknown[]) => unknown) => unknown }
        ).on?.(event, wrapped);
        if (typeof unsubscribe === 'function') {
          group.unsubscribes.push(unsubscribe as () => void);
        }
      },
    };
  }

  disposeModule(key: string): boolean {
    const had = this.groups.has(key);
    for (const g of this.generations.get(key) ?? []) retireGroup(g);
    this.generations.delete(key);
    this.groups.delete(key);
    this.ledgerEntryEpoch.delete(key);
    return had;
  }

  get moduleCount(): number {
    return this.groups.size;
  }
}
