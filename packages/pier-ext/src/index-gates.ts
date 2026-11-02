/**
 * Human-gate tracking: coalesces every blocking prompt (pier's ask tool, pi's own ctx.ui dialogs)
 * into one gate depth that collapses the todo widget while a person is being asked something.
 *
 * Status reporting belongs to pi's native OSC 7501 reporter. The single exception is pier's own ask
 * gate: its dialog runs through `ui.custom`, which pi does not report, so `publish` writes
 * `blocked kind=question` on the 0→1 edge and restores working/idle on the 1→0 edge (pi dedups its
 * own reports, so it would not repaint the state after a dialog it never saw).
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { formatProgramStatus } from './program-status.ts';

/** Only inherently human-blocking kinds open the gate; `custom` covers resident overlays too (D97). */
const GATING_PROMPT_KINDS: Record<string, true> = { select: true, confirm: true, input: true, editor: true };

export interface GateRuntimeDeps {
  pi: ExtensionAPI;
  /** Writes a raw OSC sequence to the terminal; null outside a herdr-core terminal. */
  writeStatus: ((sequence: string) => void) | null;
  /** Collapse the todo widget to one line while a gate is open; restore on release. */
  rerenderWidget: () => void;
  /** True while an agent turn is active (drives the state restored on release). */
  isAgentActive: () => boolean;
}

export interface GateRuntime {
  depth(): number;
  /** Open/close pier's own ask gate and report it, since pi does not report `ui.custom` dialogs. */
  publish(active: boolean, label: string | null): void;
}

export function createGateRuntime(d: GateRuntimeDeps): GateRuntime {
  let blockedDepth = 0;
  /** Depth contributed by pier's own gates; only they own a status report. */
  let ownDepth = 0;

  function enter(): boolean {
    blockedDepth += 1;
    if (blockedDepth > 1) return false;
    d.rerenderWidget();
    return true;
  }

  function exit(): void {
    if (blockedDepth === 0) return;
    blockedDepth -= 1;
    d.rerenderWidget();
  }

  d.pi.on('ui_prompt_start', (event) => {
    if (GATING_PROMPT_KINDS[event.kind]) enter();
  });
  d.pi.on('ui_prompt_end', () => exit());

  return {
    depth: () => blockedDepth,
    publish(active: boolean, label: string | null): void {
      if (active) {
        enter();
        ownDepth += 1;
        if (ownDepth === 1) d.writeStatus?.(formatProgramStatus('blocked', label));
        return;
      }
      if (ownDepth === 0) return;
      ownDepth -= 1;
      exit();
      if (ownDepth === 0) d.writeStatus?.(formatProgramStatus(d.isAgentActive() ? 'working' : 'idle'));
    },
  };
}
