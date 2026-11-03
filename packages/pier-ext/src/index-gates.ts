/**
 * Human-gate tracking: coalesces every blocking prompt (pier's ask tool, pi's own ctx.ui dialogs)
 * into one gate depth that collapses the todo widget while a person is being asked something.
 *
 * Status reporting belongs entirely to pi's native OSC 7501 reporter: pi ≥ 1.5 reports pier's
 * `ui.custom` ask dialog as blocked through its `blocked` option (`ask-dialog.ts`), so pier writes
 * no status itself.
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/** Only inherently human-blocking kinds open the gate; `custom` covers resident overlays too (D97). */
const GATING_PROMPT_KINDS: Record<string, true> = { select: true, confirm: true, input: true, editor: true };

export interface GateRuntimeDeps {
  pi: ExtensionAPI;
  /** Collapse the todo widget to one line while a gate is open; restore on release. */
  rerenderWidget: () => void;
}

export interface GateRuntime {
  depth(): number;
  /** Open/close pier's own ask gate for the whole ask, across its dialogs and fallbacks. */
  hold(active: boolean): void;
}

export function createGateRuntime(d: GateRuntimeDeps): GateRuntime {
  let blockedDepth = 0;
  /** Depth contributed by pier's own gates, so an unmatched release cannot close pi's dialogs' gates. */
  let ownDepth = 0;

  function enter(): void {
    blockedDepth += 1;
    if (blockedDepth === 1) d.rerenderWidget();
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
    hold(active: boolean): void {
      if (active) {
        ownDepth += 1;
        enter();
        return;
      }
      if (ownDepth === 0) return;
      ownDepth -= 1;
      exit();
    },
  };
}
