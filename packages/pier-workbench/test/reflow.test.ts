/**
 * 档1 收尾：workbench 第二棵树 —— reflow 插件接线 + 域流程单测（无 env/socket）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkbenchApp } from '../src/app.ts';
import reflowPlugin, { parseEventEnv, runReflow, type ReflowDeps } from '../src/reflow.ts';

const LAYOUT = {
  layout: {
    tab_id: 'tab-1',
    zoomed: false,
    root: {
      type: 'split', direction: 'right', ratio: 0.5,
      first: { type: 'pane', pane_id: 'pane-a' },
      second: {
        type: 'split', direction: 'down', ratio: 0.5,
        first: { type: 'pane', pane_id: 'pane-b' },
        second: { type: 'pane', pane_id: 'pane-c' },
      },
    },
  },
};

function makeDeps(over = {}) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  let state = { tabs: {}, panes: { 'pane-a': { createdAt: Date.now() - 60_000 }, 'pane-b': { createdAt: Date.now() - 60_000 } }, debounce: null };
  const deps: ReflowDeps = {
    ev: { hook: 'pane.focused', type: 'pane.focused', paneId: 'pane-b', workspaceId: 'ws', tabId: 'tab-1', cause: 'user' },
    request: async (method, params = {}) => {
      calls.push([method, params]);
      if (method === 'layout.export') return LAYOUT;
      return {};
    },
    loadState: () => state,
    saveState: (s) => { state = s; },
    sleep: async () => { /* 测试免防抖等待 */ },
    ...over,
  };
  return { deps, calls, get state() { return state; } };
}

test('reflow 插件接线：第二棵树挂载 + 服务注入 + 全链应用（零 swap）', async () => {
  const { deps, calls, state } = makeDeps();
  const app = await createWorkbenchApp();
  app.root.provide('workbench.deps', deps);
  await app.root.plugin(reflowPlugin);
  await app.root.fiber.dispose();

  const methods = calls.map(([m]) => m);
  assert.ok(methods.includes('layout.export'));
  assert.ok(!methods.includes('pane.swap'), '网格原地热力：不换位');
  assert.ok(methods.includes('layout.set_split_ratio'), 'ratio 应用');
  // 焦点 pane-b 路径：root(second)→stack(first)，depth2 → r=√0.72（旁支都是单 pane，无额外 op）
  const r2 = Math.sqrt(0.72);
  const ratios = calls.filter(([m]) => m === 'layout.set_split_ratio').map(([, p]) => [p.path.map((b: boolean) => (b ? '1' : '0')).join(''), p.ratio]);
  assert.deepEqual(ratios, [['', 1 - r2], ['1', r2]]);
  assert.equal(state.tabs['tab-1'].lastFocusPaneId, 'pane-b', '状态回写');
});

test('parseEventEnv：真实钩子两形状（d84 dump 实证）', () => {
  // pane_created 嵌套形（旧代码读不到 → 记账从未工作；存量 bug 修复的回归钉）
  const created = parseEventEnv({
    HERDR_PLUGIN_EVENT: 'pane.created',
    HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
      event: 'pane_created',
      data: { type: 'pane_created', pane: { pane_id: 'w6:pCD', workspace_id: 'w6', tab_id: 'w6:t81' } },
    }),
  });
  assert.equal(created.paneId, 'w6:pCD', '嵌套 data.pane.pane_id 可读');
  assert.equal(created.tabId, 'w6:t81');

  // pane_focused 扁平形（无 cause → null，走 3s 年龄白名单）
  const focused = parseEventEnv({
    HERDR_PLUGIN_EVENT: 'pane.focused',
    HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
      event: 'pane_focused',
      data: { type: 'pane_focused', pane_id: 'w6:pCG', workspace_id: 'w6' },
    }),
  });
  assert.equal(focused.paneId, 'w6:pCG');
  assert.equal(focused.cause, null);

  // 手工/测试形态（扁平 + cause=user）
  const manual = parseEventEnv({
    HERDR_PLUGIN_EVENT_JSON: JSON.stringify({ type: 'pane.focused', data: { pane_id: 'pB', cause: 'user' } }),
  });
  assert.equal(manual.paneId, 'pB');
  assert.equal(manual.cause, 'user');
});

test('runReflow：pane.created → 记账龄 + 数量重排（D95；首次创建也重排，first 兜底焦点）', async () => {
  const { deps, calls, state } = makeDeps();
  deps.ev = { ...deps.ev, hook: 'pane.created', type: 'pane.created', paneId: 'pane-new' };
  // makeDeps 默认 tabId='tab-1' 且 LAYOUT 恒成功 → onCountChanged 全链执行（first 兜底焦点）
  let st = { tabs: {}, panes: { 'pane-a': { createdAt: 1 } }, debounce: null };
  deps.loadState = () => st;
  deps.saveState = (s) => { st = s; };
  await runReflow(deps);
  assert.ok(st.panes['pane-new'], '账龄已记');
  assert.ok(calls.some(([m]) => m === 'layout.export'), '首次创建也重排（D95：数量变化即重排）');
  assert.ok(calls.some(([m]) => m === 'layout.set_split_ratio'), 'ratio 应用');
});

test('runReflow：pane.created 数量重排（D95）：已有 tab 布局 → 触发重排', async () => {
  const st = makeDeps();
  st.deps.ev = { ...st.deps.ev, hook: 'pane.created', type: 'pane.created', paneId: 'pane-new' };
  // 已有布局 state（lastFocusPaneId）→ onCreated 记账龄后应触发数量重排
  let state: Record<string, unknown> = {
    tabs: { 'tab-1': { enabled: true, lastFocusPaneId: 'pane-a', lastApplyAt: 1 } },
    panes: { 'pane-a': { createdAt: 1 } },
    debounce: null,
  };
  st.deps.loadState = () => state;
  st.deps.saveState = (s) => { state = s; };
  await runReflow(st.deps);
  assert.ok(st.calls.some(([m]) => m === 'layout.export'), '取布局');
  assert.ok(st.calls.some(([m]) => m === 'layout.set_split_ratio'), '数量重排应用 ratio');
  assert.ok((state.tabs as Record<string, any>)['tab-1'].lastApplyAt > 1, 'tab 状态已更新');
});

test('runReflow：pane.closed（D95）→ 触发数量重排', async () => {
  const st = makeDeps();
  st.deps.ev = { ...st.deps.ev, hook: 'pane.closed', type: 'pane.closed', paneId: 'pane-c', cause: null };
  let state: Record<string, unknown> = {
    tabs: { 'tab-1': { enabled: true, lastFocusPaneId: 'pane-a', lastApplyAt: 1 } },
    panes: {},
    debounce: null,
  };
  st.deps.loadState = () => state;
  st.deps.saveState = (s) => { state = s; };
  await runReflow(st.deps);
  assert.ok(st.calls.some(([m]) => m === 'layout.export'), '取布局');
  assert.ok(st.calls.some(([m]) => m === 'layout.set_split_ratio'), '关闭重排应用 ratio');
});

test('runReflow：幼龄 pane 无 cause → 跳过（3s 白名单）', async () => {
  const fresh = makeDeps();
  fresh.deps.ev = { ...fresh.deps.ev, cause: null, paneId: 'pane-a' };
  // pane-a 记为刚刚创建 → 年龄 < 3000ms
  const now = Date.now();
  fresh.deps.loadState = () => ({ tabs: {}, panes: { 'pane-a': { createdAt: now } }, debounce: null });
  await runReflow(fresh.deps);
  assert.equal(fresh.calls.length, 0, '不发 layout.export');
});

test('runReflow：不在账的老 pane（d90 修正）→ 直接接受，不再现编 createdAt 误判新生', async () => {
  // d90 实证场景：p1/p3F 早于 workbench 跟踪、pane.created 没入过账；
  // 旧逻辑现编 createdAt=now → 3s 白名单全拒 → 该 tab 永不 reflow。
  const old = makeDeps();
  old.deps.ev = { ...old.deps.ev, cause: null, paneId: 'pane-old' };
  let state = { tabs: {}, panes: {}, debounce: null }; // 不在账；闭包持有（saveState 可见）
  old.deps.loadState = () => state;
  old.deps.saveState = (s) => { state = s; };
  await runReflow(old.deps);
  assert.ok(old.calls.some(([m]) => m === 'layout.export'), '老 pane 无条件过闸 → 发起 reflow');
  assert.ok(state.debounce, '防抖 token 已写');
});

test('runReflow：agent_status_changed（档3 语义桥）→ 焦点沿用 lastFocus + 原地分级', async () => {
  const st = makeDeps();
  st.deps.ev = { ...st.deps.ev, hook: 'pane.agent_status_changed', type: 'pane.agent_status_changed', paneId: 'pane-c', cause: null };
  let state = { tabs: { 'tab-1': { enabled: true, lastFocusPaneId: 'pane-a', lastApplyAt: 1 } }, panes: {}, debounce: null };
  st.deps.loadState = () => state;
  st.deps.saveState = (s) => { state = s; };
  st.deps.listAgentStatuses = async () => ({ 'pane-c': 'blocked', 'pane-b': 'idle', 'pane-a': 'idle' });
  await runReflow(st.deps);
  assert.ok(st.calls.some(([m]) => m === 'layout.export'), '取布局');
  assert.ok(!st.calls.some(([m]) => m === 'pane.swap'), '零 swap：位置不动');
  // 焦点 pane-a（root first，depth1），blocked 在旁支 → root=0.60；旁支栈 b(1) vs c(3) → first 份额 0.25
  const ratios = st.calls.filter(([m]) => m === 'layout.set_split_ratio').map(([, p]) => [p.path.map((b: boolean) => (b ? '1' : '0')).join(''), p.ratio]);
  assert.deepEqual(ratios, [['', 0.6], ['1', 0.25]]);
  assert.ok(state.tabs['tab-1'].lastApplyAt > 1, 'tab 状态已更新');
});

test('runReflow：agent_status_changed 无 lastFocus → 退化 first pane 为焦点', async () => {
  const st = makeDeps();
  st.deps.ev = { ...st.deps.ev, hook: 'pane.agent_status_changed', type: 'pane.agent_status_changed', paneId: 'pane-b', cause: null };
  let state = { tabs: { 'tab-1': { enabled: true } }, panes: {}, debounce: null };
  st.deps.loadState = () => state;
  st.deps.saveState = (s) => { state = s; };
  st.deps.listAgentStatuses = async () => ({});
  await runReflow(st.deps);
  assert.ok(st.calls.some(([m]) => m === 'layout.export'));
  assert.equal(state.tabs['tab-1'].lastFocusPaneId, 'pane-a', 'first pane 兜底');
});

test('runReflow：防抖期被更新 token 顶掉 → 不应用', async () => {
  const { deps, calls } = makeDeps();
  // 防抖后状态里的 token 被并发聚焦覆盖 → shouldFireDebounced 不匹配
  let first = true;
  const baseLoad = deps.loadState;
  deps.loadState = () => (first ? (first = false, baseLoad()) : { tabs: {}, panes: {}, debounce: { token: 'later:x' } });
  await runReflow(deps);
  assert.equal(calls.length, 0, '被顶掉的聚焦不应用');
});
