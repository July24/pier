/**
 * Heat reflow domain tests: hook event parsing, the runReflow dispatch table, the pi-tab gate, and the
 * plugin state file (no env, no socket).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  askFlagsFromListResult,
  parseEventEnv,
  readJsonSafe,
  runReflow,
  writeJsonAtomic,
  type ReflowDeps,
  type ReflowEvent,
} from '../src/reflow.ts';
import { layoutFingerprint, unwrapLayout } from '../src/heat-layout.ts';

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

const OLD_PANE = { createdAt: Date.now() - 60_000 };
const OLD_TAB = { enabled: true, lastFocusPaneId: 'pane-a', lastApplyAt: 1 };

type Calls = Array<[string, Record<string, unknown>]>;

/** Ratio ops as [boolean-path string, ratio] pairs (path '' = the root split). */
function ratioOps(calls: Calls): Array<[string, number]> {
  return calls
    .filter(([method]) => method === 'layout.set_split_ratio')
    .map(([, params]) => [
      (params.path as boolean[]).map((b) => (b ? '1' : '0')).join(''),
      params.ratio as number,
    ]);
}

const called = (calls: Calls, method: string): boolean => calls.some(([m]) => m === method);
const piTabs = (...ids: string[]) => ({ piTabIds: async () => new Set(ids) });

/** Deps harness: records RPC calls, keeps state in a closure, skips the debounce wait. */
function makeDeps(
  opts: Partial<ReflowDeps> & { ev?: Partial<ReflowEvent>; exported?: unknown; state?: Record<string, any> } = {},
) {
  const { exported = LAYOUT, ev: evOver, state: initialState, ...depsOver } = opts;
  const calls: Calls = [];
  let state: Record<string, any> = initialState ?? { tabs: {}, panes: {}, debounce: null };
  const event = { hook: 'pane.focused', paneId: 'pane-b', workspaceId: 'ws', tabId: 'tab-1', cause: 'user', ...evOver };
  const deps: ReflowDeps = {
    ev: { ...event, type: event.type ?? event.hook },
    request: async (method, params = {}) => {
      calls.push([method, params]);
      return method === 'layout.export' ? exported : {};
    },
    loadState: () => state,
    saveState: (s) => { state = s; },
    sleep: async () => { /* no debounce wait in tests */ },
    ...depsOver,
  };
  return {
    deps,
    calls,
    get state() { return state; },
    set state(next: Record<string, any>) { state = next; },
  };
}

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

test('runReflow：pane.focused 全链——零 swap 原地分级 + 状态回写', async () => {
  const h = makeDeps({ state: { tabs: {}, panes: { 'pane-a': OLD_PANE, 'pane-b': OLD_PANE }, debounce: null } });
  await runReflow(h.deps);

  assert.ok(called(h.calls, 'layout.export'), '取布局');
  assert.ok(!called(h.calls, 'pane.swap'), '网格原地热力：不换位');
  // 焦点 pane-b 路径：root(second)→stack(first)，depth2 → r=√0.72（旁支都是单 pane，无额外 op）
  const r2 = Math.sqrt(0.72);
  assert.deepEqual(ratioOps(h.calls), [['', 1 - r2], ['1', r2]]);
  assert.equal(h.state.tabs['tab-1'].lastFocusPaneId, 'pane-b', '状态回写');
});

test('runReflow：pane.created → 记账龄 + 数量重排（D95；首次创建也重排）', async () => {
  const h = makeDeps({ ev: { hook: 'pane.created', paneId: 'pane-new' } });
  await runReflow(h.deps);

  assert.ok(h.state.panes['pane-new'], '账龄已记');
  assert.equal(h.state.panes['pane-new'].tabId, 'tab-1', 'pane→tab 反查映射已记');
  assert.ok(called(h.calls, 'layout.export'), '首次创建也重排（D95：数量变化即重排）');
  assert.ok(called(h.calls, 'layout.set_split_ratio'), 'ratio 应用');
  assert.ok(h.state.tabs['tab-1'].lastApplyAt, 'tab 状态已更新');
});

test('runReflow：pane.closed（D95）→ 按 pane→tab 映射触发数量重排', async () => {
  const h = makeDeps({
    ev: { hook: 'pane.closed', paneId: 'pane-c', tabId: null, cause: null },
    state: { tabs: { 'tab-1': OLD_TAB }, panes: { 'pane-c': { tabId: 'tab-1' } }, debounce: null },
  });
  await runReflow(h.deps);

  assert.deepEqual(h.calls.find(([m]) => m === 'layout.export')?.[1], { tab_id: 'tab-1' }, '关闭事件反查 tab');
  assert.ok(called(h.calls, 'layout.set_split_ratio'), '关闭重排应用 ratio');
});

test('runReflow：幼龄 pane 无 cause → 跳过（3s 白名单）', async () => {
  const h = makeDeps({
    ev: { cause: null, paneId: 'pane-a' },
    state: { tabs: {}, panes: { 'pane-a': { createdAt: Date.now() } }, debounce: null },
  });
  await runReflow(h.deps);
  assert.equal(h.calls.length, 0, '不发 layout.export');
});

test('runReflow：不在账的老 pane（d90 修正）→ 直接接受，不再现编 createdAt 误判新生', async () => {
  const h = makeDeps({ ev: { cause: null, paneId: 'pane-old' } });
  await runReflow(h.deps);
  assert.ok(called(h.calls, 'layout.export'), '老 pane 无条件过闸 → 发起 reflow');
  assert.ok(h.state.debounce, '防抖 token 已写');
});

test('runReflow：agent_status_changed（档3 语义桥）→ 焦点沿用 lastFocus + 原地分级', async () => {
  const h = makeDeps({
    ev: { hook: 'pane.agent_status_changed', paneId: 'pane-c', cause: null },
    state: { tabs: { 'tab-1': OLD_TAB }, panes: {}, debounce: null },
    listAgentStatuses: async () => ({ 'pane-c': 'blocked', 'pane-b': 'idle', 'pane-a': 'idle' }),
  });
  await runReflow(h.deps);

  assert.ok(!called(h.calls, 'pane.swap'), '零 swap：位置不动');
  // 焦点 pane-a（root first，depth1），blocked 在旁支 → root=0.60；旁支栈 b(1) vs c(3) → first 份额 0.25
  assert.deepEqual(ratioOps(h.calls), [['', 0.6], ['1', 0.25]]);
  assert.ok(h.state.tabs['tab-1'].lastApplyAt > 1, 'tab 状态已更新');
});

test('runReflow：无 lastFocus 的 count/status 重排 → 退化 first pane 为焦点', async () => {
  const h = makeDeps({
    ev: { hook: 'pane.agent_status_changed', paneId: 'pane-b', cause: null },
    state: { tabs: { 'tab-1': { enabled: true } }, panes: {}, debounce: null },
    listAgentStatuses: async () => ({}),
  });
  await runReflow(h.deps);
  assert.equal(h.state.tabs['tab-1'].lastFocusPaneId, 'pane-a', 'first pane 兜底');
});

test('runReflow：防抖期被更新 token 顶掉 → 不应用', async () => {
  const h = makeDeps();
  // 防抖后状态里的 token 被并发聚焦覆盖 → shouldFireDebounced 不匹配
  let first = true;
  const baseLoad = h.deps.loadState;
  h.deps.loadState = () => (first ? (first = false, baseLoad()) : { tabs: {}, panes: {}, debounce: { token: 'later:x' } });
  await runReflow(h.deps);
  assert.equal(h.calls.length, 0, '被顶掉的聚焦不应用');
});

test('runReflow：收紧闸（场景 B 隔离）——非 pi tab 不 reflow，pi tab 正常', async () => {
  // piTabIds 缺省（旧接线/单测）→ 不过滤，行为不变
  const unfiltered = makeDeps();
  await runReflow(unfiltered.deps);
  assert.ok(called(unfiltered.calls, 'layout.set_split_ratio'), '缺省放行');

  // tab 不在 pi 集合（claude code / codex / 纯 shell 的 tab）→ export 后止步，不应用 ratio
  const foreign = makeDeps(piTabs('tab-other'));
  await runReflow(foreign.deps);
  assert.ok(called(foreign.calls, 'layout.export'), 'export 仍发生（tabId 解析来源）');
  assert.ok(!called(foreign.calls, 'layout.set_split_ratio'), '非 pi tab 零 ratio');

  // tab 含 pi pane → 正常 reflow
  const own = makeDeps(piTabs('tab-1'));
  await runReflow(own.deps);
  assert.ok(called(own.calls, 'layout.set_split_ratio'), 'pi tab 照常');

  // 快照抛错 → 保守不动（空集合语义）
  const broken = makeDeps({ piTabIds: async () => { throw new Error('socket down'); } });
  await runReflow(broken.deps);
  assert.ok(!called(broken.calls, 'layout.set_split_ratio'), '快照失败零 ratio');

  // status / count 路径同样受闸（粘性门：不预置 tab-1 记账 = 从未 apply 过）
  const status = makeDeps({
    ...piTabs('tab-other'),
    ev: { hook: 'pane.agent_status_changed', paneId: 'pane-c', cause: null },
    state: { tabs: { 'tab-old': OLD_TAB }, panes: {}, debounce: null },
    listAgentStatuses: async () => ({ 'pane-c': 'blocked' }),
  });
  await runReflow(status.deps);
  assert.ok(!called(status.calls, 'layout.set_split_ratio'), '非 pi tab 的 blocked 不触发重排');

  const created = makeDeps({ ...piTabs('tab-other'), ev: { hook: 'pane.created', paneId: 'pane-new' } });
  await runReflow(created.deps);
  assert.ok(!called(created.calls, 'layout.set_split_ratio'), '非 pi tab 的数量变化不触发重排');
});

test('runReflow：粘性 pi tab——全部 pi 退回 shell 后记账 tab 仍 reflow（用户退出命令行仍可焦点放大）', async () => {
  let liveSet = new Set(['tab-1']); // pi 还在跑：live 扫描可见
  let state: Record<string, any> = { tabs: {}, panes: { 'pane-b': OLD_PANE }, debounce: null };
  const bound = { piTabIds: async () => liveSet, loadState: () => state, saveState: (s: Record<string, any>) => { state = s; } };

  const holder = makeDeps(bound);
  await runReflow(holder.deps);
  assert.ok(called(holder.calls, 'layout.set_split_ratio'), 'live pi tab 照常应用');
  assert.ok(state.tabs['tab-1'], '成功 apply 写入记账（粘性来源）');

  // 两个 pane 都退出 pi：live 快照为空，但 tab 已记账 → 粘性放行
  liveSet = new Set();
  const after = makeDeps({ ...bound, ev: { paneId: 'pane-c' } });
  await runReflow(after.deps);
  assert.ok(called(after.calls, 'layout.set_split_ratio'), '全 shell 的记账 tab 仍焦点放大');
  assert.equal(state.tabs['tab-1'].lastFocusPaneId, 'pane-c', '焦点切换生效');

  // 记账 + enabled:false → 逃逸闸仍关（plan 在写状态前跳过）
  state.tabs['tab-1'] = { ...state.tabs['tab-1'], enabled: false };
  const opted = makeDeps(bound);
  await runReflow(opted.deps);
  assert.ok(!called(opted.calls, 'layout.set_split_ratio'), 'enabled:false 不再自动重排');
});

test('askFlagsFromListResult：非空 pi-ask 为 true', () => {
  assert.deepEqual(askFlagsFromListResult({
    agents: [
      { pane_id: 'p1', tokens: { 'pi-ask': 'q?' } },
      { pane_id: 'p2', tokens: { 'pi-ask': '' } },
      { pane_id: 'p3' },
    ],
  }), { p1: true });
});

test('runReflow：status 在同 pane 集合上手拖 hold；created 重建基线', async () => {
  const { root } = unwrapLayout(LAYOUT);
  assert.ok(root);
  const prior = layoutFingerprint(root);
  const dragged = { layout: { ...LAYOUT.layout, root: { ...LAYOUT.layout.root, ratio: 0.2 } } };

  const status = makeDeps({
    exported: dragged,
    ev: { hook: 'pane.agent_status_changed', paneId: 'pane-c', cause: null },
    state: { tabs: { 'tab-1': { ...OLD_TAB, lastFingerprint: prior } }, panes: {}, debounce: null },
  });
  await runReflow(status.deps);
  assert.ok(called(status.calls, 'layout.export'), '导出仍发生');
  assert.ok(!called(status.calls, 'layout.set_split_ratio'), '手拖不被 status 拉回');

  const created = makeDeps({
    exported: dragged,
    ev: { hook: 'pane.created', paneId: 'pane-new' },
    state: { tabs: { 'tab-1': { enabled: true, lastFocusPaneId: 'pane-a', lastFingerprint: prior } }, panes: {}, debounce: null },
  });
  await runReflow(created.deps);
  assert.ok(called(created.calls, 'layout.set_split_ratio'), 'created 即使比例偏离也重建基线');
});

/* ════════ 插件状态文件（F15：并发钩子进程） ════════ */

const tempDir = (tag: string) => fs.mkdtempSync(path.join(os.tmpdir(), `pier-${tag}-`));

test('writeJsonAtomic/readJsonSafe: 往返，且目录不存在时会自建', () => {
  const dir = tempDir('state');
  const file = path.join(dir, 'nested', 'tab-layout.json');
  writeJsonAtomic(file, { tabs: { 'w1:t1': { enabled: true } }, panes: {}, debounce: null });
  assert.deepEqual(readJsonSafe(file, null), { tabs: { 'w1:t1': { enabled: true } }, panes: {}, debounce: null });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeJsonAtomic: 不留下临时文件，覆盖写不产生半截 JSON', () => {
  const dir = tempDir('state2');
  const file = path.join(dir, 'tab-layout.json');
  for (let i = 0; i < 20; i += 1) writeJsonAtomic(file, { i, blob: 'x'.repeat(500) });
  assert.deepEqual(readJsonSafe(file, null), { i: 19, blob: 'x'.repeat(500) });
  assert.deepEqual(fs.readdirSync(dir), ['tab-layout.json'], '临时文件必须被 rename 消费掉');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readJsonSafe: 半截/非法 JSON 与缺失文件都回退到默认值（不抛）', () => {
  const dir = tempDir('state3');
  const file = path.join(dir, 'broken.json');
  fs.writeFileSync(file, '{"tabs": {"w1:t1":');
  assert.deepEqual(readJsonSafe(file, { tabs: {} }), { tabs: {} });
  assert.equal(readJsonSafe(path.join(dir, 'missing.json'), 'fallback'), 'fallback');
  fs.rmSync(dir, { recursive: true, force: true });
});
