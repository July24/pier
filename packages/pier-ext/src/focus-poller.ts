/**
 * D-4: herdr 0.9.1+ delivers `pane.focused`, so default polling is off (0 ms) there — a sampler
 * would reflow a second time ~8 s after a click; older servers keep the 1500 ms sampler.
 * `PIER_FOCUS_POLL_MS` overrides either default, 0 disables.
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Poll cadence for older Herdr (< 0.9.1). */
export const FOCUS_POLL_DEFAULT_MS = 1500;
/** Herdr 0.9.1+: native pane.focused is authoritative; default poller off to avoid a delayed second reflow. */
export const FOCUS_POLL_HERDR_091_MS = 0;

export function isHerdr091OrLater(version?: string | null): boolean {
  if (!version) return false;
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  if (major > 0) return true;
  if (minor > 9) return true;
  if (minor === 9 && patch >= 1) return true;
  return false;
}

export function resolveDefaultFocusPollMs(herdrVersion?: string | null): number {
  return isHerdr091OrLater(herdrVersion) ? FOCUS_POLL_HERDR_091_MS : FOCUS_POLL_DEFAULT_MS;
}
/** Min gap between reflow triggers: re-clicking the same pane must not spawn a process per click (the
 *  workbench debounces 150 ms per tab on top of this). */
export const FOCUS_FIRE_MIN_INTERVAL_MS = 700;

export interface FocusSample {
  /** Pane focused in the sampled tab (null when the server reported no focus). */
  readonly focusedPaneId: string | null;
  /** Panes currently in that tab, used to tell a click apart from a spawn auto-focus. */
  readonly paneIds: readonly string[];
}

export interface FocusPollerState {
  readonly lastFocusedPaneId: string | null;
  readonly lastPaneIds: readonly string[];
  readonly lastFireAt: number;
}

/** Minimal flatten of a herdr layout tree (`{type:'pane',pane_id}` / `{type:'split',first,second}`). */
export function collectPaneIds(root: unknown): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    const n = node as { pane_id?: unknown; first?: unknown; second?: unknown };
    if (typeof n.pane_id === 'string') {
      out.push(n.pane_id);
      return;
    }
    walk(n.first);
    walk(n.second);
  };
  walk(root);
  return out;
}

/** `layout.export` payload → sample. `focusedPaneId` is optional for older clients. */
export function parseFocusSample(
  layout: { root: unknown; focusedPaneId?: string | null } | null | undefined,
): FocusSample | null {
  if (!layout || !('root' in layout)) return null;
  const paneIds = collectPaneIds(layout.root);
  const focused = typeof layout.focusedPaneId === 'string' ? layout.focusedPaneId : null;
  return { focusedPaneId: focused, paneIds };
}

export interface FocusTick {
  readonly fire: boolean;
  readonly cause: 'user' | null;
  readonly state: FocusPollerState;
}

/**
 * Decide whether one sample should trigger a reflow: only on a *transition* into "I am focused",
 * and at most once per `minIntervalMs`. `cause` is 'user' when the pane set did not change in the
 * same sample (a click moves focus and nothing else, a spawn auto-focus comes with a new pane), so
 * the workbench can keep its pane-age whitelist. Baseline sample never fires.
 */
export function planFocusTick(opts: {
  myPaneId: string;
  sample: FocusSample;
  prev: FocusPollerState | null;
  now: number;
  minIntervalMs?: number;
}): FocusTick {
  const minInterval = opts.minIntervalMs ?? FOCUS_FIRE_MIN_INTERVAL_MS;
  const prev = opts.prev;
  const next: FocusPollerState = {
    lastFocusedPaneId: opts.sample.focusedPaneId,
    lastPaneIds: opts.sample.paneIds,
    lastFireAt: prev?.lastFireAt ?? 0,
  };
  const noFire = (): FocusTick => ({ fire: false, cause: null, state: next });

  if (opts.myPaneId === '') return noFire();
  // First sample only records the baseline: a pi that starts in the focused pane must not reflow on
  // startup (that is not a click, and it would fight whatever layout the user had).
  if (prev === null) return noFire();
  if (opts.sample.focusedPaneId !== opts.myPaneId) return noFire();
  if (prev.lastFocusedPaneId === opts.myPaneId) return noFire();
  if (opts.now - prev.lastFireAt < minInterval) return noFire();

  const setUnchanged =
    prev.lastPaneIds.length === opts.sample.paneIds.length &&
    prev.lastPaneIds.every((id, i) => id === opts.sample.paneIds[i]);
  return {
    fire: true,
    cause: setUnchanged ? 'user' : null,
    state: { ...next, lastFireAt: opts.now },
  };
}

export interface FocusPollerDeps {
  /** Layout of the caller's own tab (the client already exposes `layout.export`). */
  sample(): Promise<FocusSample | null>;
  /** Replay a pane.focused reflow for `paneId`. Must never throw. */
  fire(paneId: string, cause: 'user' | null): void;
  myPaneId: string;
  intervalMs?: number;
  minIntervalMs?: number;
  now?: () => number;
  /** Diagnostics only: polling failures are expected while herdr restarts. */
  onError?: (err: unknown) => void;
}

export interface FocusPoller {
  /** One sampling pass (exposed for tests; the interval calls the same function). */
  tick(): Promise<void>;
  stop(): void;
}

export function startFocusPoller(deps: FocusPollerDeps): FocusPoller {
  const intervalMs = deps.intervalMs ?? FOCUS_POLL_DEFAULT_MS;
  const now = deps.now ?? Date.now;
  let state: FocusPollerState | null = null;
  let inFlight = false;
  let stopped = false;
  let handle: NodeJS.Timeout | null = null;

  async function tick(): Promise<void> {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const sample = await deps.sample();
      if (sample === null) return;
      const decision = planFocusTick({
        myPaneId: deps.myPaneId,
        sample,
        prev: state,
        now: now(),
        minIntervalMs: deps.minIntervalMs,
      });
      state = decision.state;
      if (decision.fire) deps.fire(deps.myPaneId, decision.cause);
    } catch (err) {
      // A failed sample must not advance the baseline: the next tick re-reads the layout.
      deps.onError?.(err);
    } finally {
      inFlight = false;
    }
  }

  if (intervalMs > 0) {
    handle = setInterval(() => { void tick(); }, intervalMs);
    handle.unref?.(); // never keep pi's event loop alive on our account
  }

  return {
    tick,
    stop(): void {
      stopped = true;
      if (handle !== null) {
        clearInterval(handle);
        handle = null;
      }
    },
  };
}

/** The workbench's reflow entry point; overridable for relocated checkouts. */
export function reflowScriptPath(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.PIER_WORKBENCH_ROOT?.trim();
  if (root) return join(root, 'scripts', 'heat-reflow.mjs');
  // packages/pier-ext/src/focus-poller.ts -> packages/pier-workbench/scripts/heat-reflow.mjs
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'pier-workbench', 'scripts', 'heat-reflow.mjs');
}

export interface SpawnReflowOpts {
  paneId: string;
  cause: 'user' | null;
  env?: NodeJS.ProcessEnv;
  /** Injection seam for tests (defaults to child_process.spawn). */
  spawnFn?: typeof spawn;
}

/** Fire-and-forget replay of the `pane.focused` hook as a child process — exactly how herdr runs it,
 *  so the workbench script keeps its own event parsing, debounce and state file. */
export function spawnReflow(opts: SpawnReflowOpts): void {
  const env = opts.env ?? process.env;
  const spawnFn = opts.spawnFn ?? spawn;
  const payload = JSON.stringify({
    event: 'pane_focused',
    type: 'pane_focused',
    data: { type: 'pane_focused', pane_id: opts.paneId, cause: opts.cause },
  });
  try {
    const child = spawnFn(process.execPath, [reflowScriptPath(env)], {
      env: { ...env, HERDR_PLUGIN_EVENT: 'pane.focused', HERDR_PLUGIN_EVENT_JSON: payload },
      stdio: 'ignore',
    });
    child.on?.('error', () => { /* Missing script / dead exec: polling must never break pi. */ });
    child.unref?.();
  } catch {
  }
}
