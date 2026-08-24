/**
 * 档1 收尾：M23 热力 reflow 域逻辑插件化（自 scripts/heat-reflow.mjs 迁入）。
 *
 * 形态：cordis 插件（默认导出）+ 依赖全经服务注入（`workbench.deps`）——
 * env/socket/状态文件属宿主（进程边界），规划器在 heat-layout.ts（纯逻辑）。
 * runReflow 独立导出：无 cordis 也能直接单测（插件面只做接线）。
 */
import { Context } from '@deepseek-ai/cordis';
import {
  REFLOW_DEBOUNCE_MS,
  countPanes,
  firstPaneId,
  planGridHeat,
  shouldAcceptFocus,
  shouldFireDebounced,
  unwrapLayout,
  type AgentStatusMap,
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
  /** 注入便于测试（生产 = setTimeout sleep）。 */
  sleep: (ms: number) => Promise<void>;
  /** 档2 语义桥：事件触发时拉一次 agent 状态快照（pane.list；缺省 = 无分级）。 */
  listAgentStatuses?: () => Promise<AgentStatusMap>;
  /** D95：ask_user_question 等待标志（tokens['pi-ask'] 非空）。缺省 = 无 ask。 */
  listAskFlags?: () => Promise<Record<string, boolean>>;
  /**
   * 收紧闸（场景 B 隔离）：含 pi agent pane 的 tab 集合——非 pi tab（claude code /
   * codex / 纯 shell）不 reflow。缺省 = 不过滤（单测/旧接线兼容）。
   */
  piTabIds?: () => Promise<Set<string>>;
}

/** tab 是否归 pier 管（含 pi pane）。dep 缺省放行；快照失败按不在集合处理（保守不动）。 */
async function isPiTab(deps: ReflowDeps, tabId: string): Promise<boolean> {
  if (!deps.piTabIds) return true;
  try { return (await deps.piTabIds()).has(tabId); } catch { return false; }
}
type ReflowState = Record<string, any>;

async function onCreated(deps: ReflowDeps, paneId: string): Promise<void> {
  const state = deps.loadState();
  state.panes = state.panes ?? {};
  if (!state.panes[paneId]) state.panes[paneId] = { createdAt: Date.now() };
  // D95：记录 pane→tab 映射（pane.closed 事件无 tab_id，需反查所属 tab 做关闭重排）
  if (deps.ev.tabId) state.panes[paneId].tabId = deps.ev.tabId;
  deps.saveState(state);
  // D95：数量变化 → 触发数量重排（大小按等级权重重算，位置不动；焦点沿用 lastFocus）
  await onCountChanged(deps);
}

/**
 * D95 共享重排核心：防抖 → layout.export(pane_id) → 焦点沿用 lastFocus（无则 first 兜底）
 * → applyTiered → 记 tab 状态。数量/状态/关闭共用（焦点事件另有 own 路径）。
 */
async function onCountChanged(deps: ReflowDeps): Promise<void> {
  const paneId = deps.ev.paneId;
  const now = Date.now();
  const state0 = deps.loadState() as ReflowState;
  const token = `cnt:${now}:${paneId ?? ''}`;
  state0.debounce = { token, paneId, at: now };
  deps.saveState(state0);
  await deps.sleep(REFLOW_DEBOUNCE_MS);
  const latest = deps.loadState() as ReflowState;
  if (!shouldFireDebounced({ stored: latest.debounce?.token ?? '', incoming: token })) return;

  const evPaneId = deps.ev.paneId;
  const latest0 = deps.loadState() as ReflowState;
  // D95：closed 事件无 tab_id → 反查 pane 归属 tab（onCreated 已记）；仍无 → 借 export 兜底
  const closedTab = evPaneId && (latest0.panes?.[evPaneId] as { tabId?: string } | undefined)?.tabId;
  const exported = await deps.request('layout.export', closedTab
    ? { tab_id: closedTab }
    : (evPaneId ? { pane_id: evPaneId } : {}));
  const { root, tabId: exportedTabId, zoomed } = unwrapLayout(exported);
  const tabId = exportedTabId ?? deps.ev.tabId;
  if (!root || !tabId) return;
  if (!(await isPiTab(deps, tabId))) return;
  const tabCfg = latest.tabs?.[tabId] ?? { enabled: true };
  const lastFocus = typeof (tabCfg as { lastFocusPaneId?: unknown }).lastFocusPaneId === 'string'
    ? (tabCfg as { lastFocusPaneId: string }).lastFocusPaneId
    : null;
  const focusPaneId = lastFocus && flattenIn(root, lastFocus) ? lastFocus : firstPaneId(root);
  const applied = await applyTiered(deps, { root, tabId, focusPaneId, zoomed, tabCfg });
  if (!applied) return;
  latest.tabs = latest.tabs ?? {};
  latest.tabs[tabId] = { ...tabCfg, lastFocusPaneId: focusPaneId, lastApplyAt: Date.now() };
  deps.saveState(latest);
}

/** 档3 共用核心：取状态快照 → 网格原地规划 → 应用 → 记 tab 状态。 */
async function applyTiered(
  deps: ReflowDeps,
  opts: { root: ReturnType<typeof unwrapLayout>['root']; tabId: string; focusPaneId: string; zoomed: boolean; tabCfg: Record<string, unknown> },
): Promise<boolean> {
  const statuses = await (deps.listAgentStatuses?.() ?? Promise.resolve({}));
  const askFlags = await (deps.listAskFlags?.() ?? Promise.resolve({}));
  const plan = planGridHeat({
    root: opts.root!,
    focusPaneId: opts.focusPaneId,
    paneCount: countPanes(opts.root!),
    zoomed: opts.zoomed,
    enabled: (opts.tabCfg as { enabled?: boolean }).enabled !== false,
    statuses,
    askFlags,
  });
  if (plan.type !== 'apply') return false;
  // D91 网格原地热力：只发 ratio（零 swap——pane 位置不动，聚焦格原地放大）
  for (const op of plan.ops) {
    await deps.request('layout.set_split_ratio', { tab_id: opts.tabId, path: op.path, ratio: op.ratio });
  }
  return true;
}

async function onFocused(deps: ReflowDeps): Promise<void> {
  const paneId = deps.ev.paneId;
  if (!paneId) return;
  const now = Date.now();
  const state = deps.loadState();
  state.panes = state.panes ?? {};
  // d90 档2 修正：不在账（本插件没见过其 pane.created）= 老 pane → 直接接受。
  // 此前现编 createdAt=now → 3s 白名单内被拒 → 老 pane 所在 tab 永不 reflow
  // （d90 实证：p1/p3F 点击爆发全拒）。已知 pane 才走账龄闸（F1：压 spawn 自动焦点）。
  const known = Boolean(state.panes[paneId]);
  if (known) {
    const age = now - state.panes[paneId].createdAt;
    if (!shouldAcceptFocus({ paneAgeMs: age, cause: deps.ev.cause })) return;
  }

  const token = `${now}:${paneId}`;
  state.debounce = { token, paneId, at: now };
  deps.saveState(state);
  await deps.sleep(REFLOW_DEBOUNCE_MS);
  const latest = deps.loadState() as ReflowState;
  if (!shouldFireDebounced({ stored: latest.debounce?.token ?? '', incoming: token })) return;

  const exported = await deps.request('layout.export', { pane_id: paneId });
  const { root, tabId: exportedTabId, zoomed } = unwrapLayout(exported);
  const tabId = exportedTabId ?? deps.ev.tabId;
  if (!root || !tabId) return;
  if (!(await isPiTab(deps, tabId))) return;
  const tabCfg = latest.tabs?.[tabId] ?? { enabled: true };
  const applied = await applyTiered(deps, { root, tabId, focusPaneId: paneId, zoomed, tabCfg });
  if (!applied) return;
  latest.tabs = latest.tabs ?? {};
  latest.tabs[tabId] = { ...tabCfg, lastFocusPaneId: paneId, lastApplyAt: Date.now() };
  deps.saveState(latest);
}

/**
 * 档2 语义桥（D90-F）：agent 状态变化（blocked 出现/消失）→ 事件驱动重排。
 * 焦点不动（沿用该 tab 的 lastFocusPaneId），仅从窗带内重排序 + 权重再分配。
 * 不轮询：pane.agent_status_changed 事件即推送（D3 合规零新协议）。
 */
async function onAgentStatusChanged(deps: ReflowDeps): Promise<void> {
  const paneId = deps.ev.paneId;
  if (!paneId) return;
  const now = Date.now();
  const state = deps.loadState() as ReflowState;

  const token = `st:${now}:${paneId}`;
  state.debounce = { token, paneId, at: now };
  deps.saveState(state);
  await deps.sleep(REFLOW_DEBOUNCE_MS);
  const latest = deps.loadState() as ReflowState;
  if (!shouldFireDebounced({ stored: latest.debounce?.token ?? '', incoming: token })) return;

  const exported = await deps.request('layout.export', { pane_id: paneId });
  const { root, tabId: exportedTabId, zoomed } = unwrapLayout(exported);
  const tabId = exportedTabId ?? deps.ev.tabId;
  if (!root || !tabId) return;
  if (!(await isPiTab(deps, tabId))) return;
  const tabCfg = latest.tabs?.[tabId] ?? { enabled: true };
  // 焦点沿用上次；该 pane 不在树或从未 focus 过 → 退化 first pane
  const lastFocus = typeof (tabCfg as { lastFocusPaneId?: unknown }).lastFocusPaneId === 'string'
    ? (tabCfg as { lastFocusPaneId: string }).lastFocusPaneId
    : null;
  const focusPaneId = lastFocus && flattenIn(root, lastFocus) ? lastFocus : firstPaneId(root);
  const applied = await applyTiered(deps, { root, tabId, focusPaneId, zoomed, tabCfg });
  if (!applied) return;
  latest.tabs = latest.tabs ?? {};
  latest.tabs[tabId] = { ...tabCfg, lastFocusPaneId: focusPaneId, lastApplyAt: Date.now() };
  deps.saveState(latest);
}

function flattenIn(root: ReturnType<typeof unwrapLayout>['root'], paneId: string): boolean {
  if (!root) return false;
  const walk = (n: NonNullable<typeof root>): boolean =>
    n.type === 'pane' ? n.pane_id === paneId : walk(n.first) || walk(n.second);
  return walk(root);
}

/**
 * 解析 herdr 钩子事件 env（HERDR_PLUGIN_EVENT / _EVENT_JSON）。
 * 真实载荷两形状（spike d84 dump 实证）：
 *  - pane_focused 扁平：{"event":"pane_focused","data":{"type","pane_id","workspace_id"}}（无 cause）
 *  - pane_created 嵌套：{"event":"pane_created","data":{"type","pane":{pane_id,…}}}
 * 兼容手工/测试的扁平+cause 形态（d84-manual：data.pane_id + cause=user）。
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

/** 域流程（可独立单测）。 */
export async function runReflow(deps: ReflowDeps): Promise<void> {
  const isCreated = /pane\.created|pane_created/i.test(String(deps.ev.hook) + String(deps.ev.type));
  const isFocused = /pane\.focused|pane_focused/i.test(String(deps.ev.hook) + String(deps.ev.type));
  const isStatus = /pane\.agent_status_changed/i.test(String(deps.ev.hook) + String(deps.ev.type));
  const isClosed = /pane\.closed|pane_closed/i.test(String(deps.ev.hook) + String(deps.ev.type));
  if (isClosed) {
    // D95：pane 回收（subagent 完成被 GC）→ 数量重排（树收缩；位置自然，不迁移）
    await onCountChanged(deps);
    return;
  }
  if (isCreated && deps.ev.paneId) {
    await onCreated(deps, deps.ev.paneId);
    return;
  }
  if (isFocused) {
    await onFocused(deps);
    return;
  }
  if (isStatus) {
    await onAgentStatusChanged(deps);
  }
}

export default function reflowPlugin(ctx: Context): Promise<void> {
  const deps = ctx.get('workbench.deps') as ReflowDeps;
  return runReflow(deps);
}
