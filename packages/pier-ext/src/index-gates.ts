/**
 * Human-gate reporting: coalesces every blocking prompt (pier's ask tool, pi's
 * own ctx.ui dialogs, external herdr:blocked producers) into ONE blocked edge.
 *
 * Depth semantics: only the 0→1 transition reports blocked (and marks the ask
 * flag); only the 1→0 transition restores working/idle. While the depth is
 * positive, working/idle reports are dropped so the pane stays blocked for the
 * whole dialog.
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { HerdrClientLike } from './herdr-client.ts';

/** pi surface pieces the gate runtime touches (ui_prompt events postdate the pinned devDependency). */
type GatePi = ExtensionAPI & {
  on?: (name: 'ui_prompt_start' | 'ui_prompt_end', handler: (event: unknown) => void) => void;
};

/** Only inherently human-blocking kinds open the gate; `custom` covers resident overlays too (D97). */
const GATING_PROMPT_KINDS = new Set(['select', 'confirm', 'input', 'editor']);

export interface GateRuntimeDeps {
  pi: ExtensionAPI;
  client: HerdrClientLike;
  /** Collapse the todo widget to one line while a gate is open; restore on release. */
  rerenderWidget: () => void;
  /** True while an agent turn is active (drives the state reported on release). */
  isAgentActive: () => boolean;
  /** Idle activity text (idle role badge / current todo) reported with the idle state. */
  idleMessage: () => string | null;
  /** Working activity text (current todo) reported when a gate releases mid-turn. */
  workingMessage: () => string | null;
}

export interface GateRuntime {
  depth(): number;
  /** Gate-aware agent-state report (blocked depth swallows working/idle). */
  report(state: 'working' | 'idle', activity: string | null): void;
  /** Open one gate; true when this call opened the outer one. */
  enter(label: string | null): boolean;
  /** Close one gate; an unmatched release is ignored. True when the outer gate closed. */
  exit(): boolean;
  /** enter/exit + publish the herdr:blocked edge for pier's own gates. */
  publish(active: boolean, label: string | null): void;
}

export function createGateRuntime(d: GateRuntimeDeps): GateRuntime {
  const { client } = d;
  let blockedDepth = 0;

  function report(state: 'working' | 'idle', activity: string | null): void {
    if (!client.available || blockedDepth > 0) return;
    const message = activity ?? (state === 'idle' ? d.idleMessage() : null);
    client.reportAgent(state, message).catch(() => {});
  }

  function enter(label: string | null): boolean {
    blockedDepth += 1;
    if (blockedDepth > 1) return false;
    if (client.available) client.reportAgent('blocked', label).catch(() => {});
    // D95: human-gate marker lets the workbench heatmap distinguish ask from block.
    if (label) void client.reportAskFlag(label).catch(() => {});
    d.rerenderWidget();
    return true;
  }

  function exit(): boolean {
    if (blockedDepth === 0) return false;
    blockedDepth -= 1;
    d.rerenderWidget();
    if (blockedDepth > 0) return false;
    report(d.isAgentActive() ? 'working' : 'idle', d.isAgentActive() ? d.workingMessage() : null);
    void client.reportAskFlag(null).catch(() => {});
    return true;
  }

  // emit() is synchronous; this flag stops our own listener from double-counting depth.
  let publishing = false;
  function emitHerdrBlocked(active: boolean, label: string | null): void {
    publishing = true;
    try {
      d.pi.events.emit(
        'herdr:blocked',
        active ? { active: true, ...(label ? { label } : {}) } : { active: false },
      );
    } finally {
      publishing = false;
    }
  }

  d.pi.events.on('herdr:blocked', (data) => {
    if (publishing) return;
    const active = typeof data === 'object' && data !== null && 'active' in data && data.active === true;
    if (active) {
      enter(typeof data === 'object' && 'label' in data && typeof data.label === 'string' ? data.label : null);
    } else {
      exit();
    }
  });

  const gatePi = d.pi as GatePi;
  gatePi.on?.('ui_prompt_start', (event) => {
    const rec = (event ?? {}) as { kind?: unknown; title?: unknown };
    const title = typeof rec.title === 'string' && rec.title.trim() ? rec.title.trim() : null;
    const kind = typeof rec.kind === 'string' ? rec.kind : 'prompt';
    if (!GATING_PROMPT_KINDS.has(kind)) return;
    const label = title ?? kind;
    // The ask tool opens its own gate first, so this is usually a nested no-op;
    // prompts from other extensions or pi core open the gate here.
    if (enter(label)) emitHerdrBlocked(true, label);
  });
  gatePi.on?.('ui_prompt_end', () => {
    if (exit()) emitHerdrBlocked(false, null);
  });

  return {
    depth: () => blockedDepth,
    report,
    enter,
    exit,
    publish(active: boolean, label: string | null): void {
      if (active) enter(label);
      else exit();
      emitHerdrBlocked(active, label);
    },
  };
}
