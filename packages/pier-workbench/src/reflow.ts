/**
 * Heat reflow domain logic for the pane.focused / created / closed / agent_status_changed hooks.
 * All herdr access is injected via `ReflowDeps`; the planner lives in heat-layout.ts. Hook processes
 * deliberately do not use cordis — a user-mode GitHub checkout has no node_modules.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  REFLOW_DEBOUNCE_MS,
  applyHeatOps,
  containsPane,
  countPanes,
  firstPaneId,
  layoutFingerprint,
  planGridHeat,
  shouldAcceptFocus,
  shouldFireDebounced,
  shouldHoldHeat,
  unwrapLayout,
  type AgentStatusMap,
  type AskFlagMap,
  type LayoutNode,
  type SplitFingerprint,
} from './heat-layout.ts';

export interface ReflowEvent {
  hook: string;
  type: string;
  paneId: string | null;
  workspaceId: string | null;
  tabId: string | null;
  cause: string | null;
}

export interface ReflowDeps {
  ev: ReflowEvent;
  request: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  loadState: () => Record<string, unknown>;
  saveState: (state: Record<string, unknown>) => void;
  /** Injected for testing (production = setTimeout sleep). */
  sleep: (ms: number) => Promise<void>;
  /** Tier 2 semantic bridge: agent status snapshot per event (pane.list; default = unranked). */
  listAgentStatuses?: () => Promise<AgentStatusMap>;
  /** D95: ask_user_question waiting flag (tokens['pi-ask'] non-empty). Default = no ask. */
  listAskFlags?: () => Promise<AskFlagMap>;
  /** Tightening gate (Scenario B): only tabs containing pi panes reflow; non-pi tabs are left alone. */
  piTabIds?: () => Promise<Set<string>>;
}

/** Plugin state file: tabs (per-tab config + last apply), panes (age + tab mapping), debounce token. */
type ReflowState = Record<string, any>;

/** Which event asked for the reflow — only the status mode consults the drag hold. */
type ReflowMode = 'focus' | 'count' | 'status';

/** Read JSON, returning `fallback` for a missing/partial/invalid file (never throws). */
export function readJsonSafe<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/**
 * F15: hook processes run concurrently (one per event), so a plain writeFileSync can interleave and
 * leave truncated JSON behind — which reads back as "the plugin forgot every tab". Write a unique temp
 * file in the same directory and rename over the target: rename is atomic, readers see a whole document.
 */
export function writeJsonAtomic(file: string, value: unknown): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  const json = JSON.stringify(value);
  fs.writeFileSync(tmp, json);
  try {
    fs.renameSync(tmp, file);
  } catch {
    // Windows can refuse the replace while another process holds the file: fall back to a direct write.
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    fs.writeFileSync(file, json);
  }
}

/**
 * Whether the tab belongs to pier. Passes through when the dep is omitted; a snapshot failure counts as
 * not in set (conservative no-op).
 *
 * Sticky war-room tabs: `state.tabs[tabId]` is written only after a pi-gated apply succeeded, so a
 * recorded tab stays in the set after every pi process exits back to a shell — an all-shell main tab
 * keeps its focus zoom instead of being reclassified as foreign (Scenario B).
 */
async function isPiTab(deps: ReflowDeps, tabId: string): Promise<boolean> {
  if (!deps.piTabIds) return true;
  if (deps.loadState().tabs?.[tabId]) return true;
  try { return (await deps.piTabIds()).has(tabId); } catch { return false; }
}

/**
 * The one reflow path shared by all four events: publish the debounce token (a newer event overwrites it
 * and cancels this run), export the layout, apply the pi-tab gate, then plan and apply the ratio ops.
 *
 * Count/status reflows inherit the tab's last focused pane as the focus; a focus event passes its own.
 */
async function reflowTab(
  deps: ReflowDeps,
  opts: {
    token: string;
    /** Export params, derived from the state read after the debounce window. */
    exportParams: (state: ReflowState) => Record<string, unknown>;
    mode: ReflowMode;
    focusPaneId?: string;
  },
): Promise<void> {
  const state = deps.loadState() as ReflowState;
  state.debounce = { token: opts.token, paneId: deps.ev.paneId, at: Date.now() };
  deps.saveState(state);
  await deps.sleep(REFLOW_DEBOUNCE_MS);
  const latest = deps.loadState() as ReflowState;
  if (!shouldFireDebounced({ stored: latest.debounce?.token ?? '', incoming: opts.token })) return;

  const exported = await deps.request('layout.export', opts.exportParams(latest));
  const { root, tabId: exportedTabId, zoomed } = unwrapLayout(exported);
  const tabId = exportedTabId ?? deps.ev.tabId;
  if (!root || !tabId || !(await isPiTab(deps, tabId))) return;

  const last = latest.tabs?.[tabId]?.lastFocusPaneId;
  const focusPaneId = opts.focusPaneId
    ?? (typeof last === 'string' && containsPane(root, last) ? last : firstPaneId(root));
  const tabCfg = latest.tabs?.[tabId] ?? { enabled: true };
  // Status reflow must not fight a manual drag: hold while the pane set is unchanged and ratios drifted.
  if (opts.mode === 'status' && shouldHoldHeat({
    prior: tabCfg.lastFingerprint as SplitFingerprint | undefined,
    current: layoutFingerprint(root),
    acceptedFocus: false,
  }).hold) return;

  const plan = planGridHeat({
    root,
    focusPaneId,
    paneCount: countPanes(root),
    zoomed,
    enabled: tabCfg.enabled !== false,
    statuses: await (deps.listAgentStatuses?.() ?? Promise.resolve({})),
    askFlags: await (deps.listAskFlags?.() ?? Promise.resolve({})),
  });
  if (plan.type !== 'apply') return;
  for (const op of plan.ops) {
    await deps.request('layout.set_split_ratio', { tab_id: tabId, path: op.path, ratio: op.ratio });
  }
  // Recording the fingerprint is what lets a later status reflow hold a user drag.
  latest.tabs = latest.tabs ?? {};
  latest.tabs[tabId] = {
    ...tabCfg,
    lastFocusPaneId: focusPaneId,
    lastApplyAt: Date.now(),
    lastFingerprint: layoutFingerprint(applyHeatOps(root, plan.ops)),
  };
  deps.saveState(latest);
}

async function onCreated(deps: ReflowDeps, paneId: string): Promise<void> {
  const state = deps.loadState() as ReflowState;
  state.panes = state.panes ?? {};
  if (!state.panes[paneId]) state.panes[paneId] = { createdAt: Date.now() };
  // D95: record the pane -> tab mapping (pane.closed carries no tab_id, so close needs the reverse lookup).
  if (deps.ev.tabId) state.panes[paneId].tabId = deps.ev.tabId;
  deps.saveState(state);
  // A new pane changes the pane count -> reflow (positions stay, dimensions are recomputed by tier weight).
  await onCountChanged(deps);
}

/** Pane set changed (created/closed): re-sort dimensions, keep positions, inherit the last focus. */
async function onCountChanged(deps: ReflowDeps): Promise<void> {
  const evPaneId = deps.ev.paneId;
  await reflowTab(deps, {
    token: `cnt:${Date.now()}:${evPaneId ?? ''}`,
    exportParams: (state) => {
      // D95: a closed event has no tab_id -> reverse-lookup the tab recorded by onCreated, else export by pane.
      const closedTab = evPaneId ? state.panes?.[evPaneId]?.tabId : null;
      if (closedTab) return { tab_id: closedTab };
      return evPaneId ? { pane_id: evPaneId } : {};
    },
    mode: 'count',
  });
}

async function onFocused(deps: ReflowDeps): Promise<void> {
  const paneId = deps.ev.paneId;
  if (!paneId) return;
  const known = (deps.loadState() as ReflowState).panes?.[paneId];
  // d90: an unrecorded pane predates this plugin's tracking -> accept it. Improvising createdAt=now would
  // reject every click on it, while the age gate only exists to suppress spawn auto-focus (F1).
  if (known && !shouldAcceptFocus({ paneAgeMs: Date.now() - known.createdAt, cause: deps.ev.cause })) return;

  await reflowTab(deps, {
    token: `${Date.now()}:${paneId}`,
    exportParams: () => ({ pane_id: paneId }),
    mode: 'focus',
    focusPaneId: paneId,
  });
}

/**
 * Tier 2 semantic bridge (D90-F): an agent status change reflows the secondary panes while the focus
 * stays fixed. Event-driven, never polled (D3).
 */
async function onAgentStatusChanged(deps: ReflowDeps): Promise<void> {
  const paneId = deps.ev.paneId;
  if (!paneId) return;
  await reflowTab(deps, {
    token: `st:${Date.now()}:${paneId}`,
    exportParams: () => ({ pane_id: paneId }),
    mode: 'status',
  });
}

export function askFlagsFromListResult(result: unknown): AskFlagMap {
  const rec = result && typeof result === 'object' ? result as Record<string, unknown> : {};
  const rows = Array.isArray(rec.agents) ? rec.agents : Array.isArray(rec.panes) ? rec.panes : [];
  const map: AskFlagMap = {};
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const o = row as Record<string, unknown>;
    const id = typeof o.pane_id === 'string' ? o.pane_id : null;
    const tokens = o.tokens && typeof o.tokens === 'object' ? o.tokens as Record<string, unknown> : {};
    if (id && typeof tokens['pi-ask'] === 'string' && tokens['pi-ask'] !== '') map[id] = true;
  }
  return map;
}

/**
 * Parses the Herdr hook event environment variables (HERDR_PLUGIN_EVENT / _EVENT_JSON). Real payloads
 * have two shapes (d84 dump): pane_focused flat (data.pane_id) and pane_created nested (data.pane.pane_id).
 * Manual/test flat + cause shapes stay compatible.
 */
export function parseEventEnv(env: Record<string, string | undefined> = process.env): ReflowEvent {
  let event: Record<string, any> = {};
  try { event = JSON.parse(env.HERDR_PLUGIN_EVENT_JSON ?? '{}'); } catch { /* empty */ }
  const hook = env.HERDR_PLUGIN_EVENT ?? event.type ?? '';
  const data = event.data ?? event;
  const pane = data.pane && typeof data.pane === 'object' ? data.pane : {};
  return {
    hook,
    type: event.type ?? hook,
    paneId: data.pane_id ?? pane.pane_id ?? event.pane_id ?? null,
    workspaceId: data.workspace_id ?? pane.workspace_id ?? event.workspace_id ?? null,
    tabId: data.tab_id ?? pane.tab_id ?? event.tab_id ?? null,
    cause: data.cause ?? pane.cause ?? event.cause ?? null,
  };
}

/**
 * Event routing table: hook and payload type both carry the kind ('pane.created', 'pane_created'),
 * normalized to one key. Order matters — closed is matched before created.
 */
const ROUTES: Array<[string, (deps: ReflowDeps) => Promise<void>]> = [
  // D95: pane recycling (subagent finished and GC'd) -> count reflow; the tree contracts, nothing migrates.
  ['paneclosed', onCountChanged],
  ['panecreated', (deps) => (deps.ev.paneId ? onCreated(deps, deps.ev.paneId) : Promise.resolve())],
  ['panefocused', onFocused],
  ['paneagentstatuschanged', onAgentStatusChanged],
];

/** Domain workflow (independently unit testable). */
export async function runReflow(deps: ReflowDeps): Promise<void> {
  const kind = `${deps.ev.hook}${deps.ev.type}`.toLowerCase().replace(/[._]/g, '');
  const route = ROUTES.find(([name]) => kind.includes(name));
  if (route) await route[1](deps);
}
