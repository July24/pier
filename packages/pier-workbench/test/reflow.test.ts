/** Heat reflow: hook event parsing, the runReflow dispatch table and gates, and the plugin state file. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { askFlagsFromListResult, parseEventEnv, readJsonSafe, runReflow, writeJsonAtomic } from '../src/reflow.ts';
import { layoutFingerprint, unwrapLayout } from '../src/heat-layout.ts';
import { OLD_PANE, OLD_TAB, REFLOW_LAYOUT, callRatioOps, calledRpc, makeReflowDeps, piTabIds, type ReflowDepsOpts } from './heat-fixtures.ts';

/** Build the deps harness and run one reflow pass; returns it for call/state assertions. */
const reflow = async (opts: ReflowDepsOpts = {}) => {
  const h = makeReflowDeps(opts);
  await runReflow(h.deps);
  return h;
};

test('parseEventEnv：真实钩子两形状（d84 dump 实证）', () => {
  // pane_created nested (data.pane.pane_id); pane_focused flat; manual/test flat + cause
  const created = parseEventEnv({ HERDR_PLUGIN_EVENT: 'pane.created',
    HERDR_PLUGIN_EVENT_JSON: JSON.stringify({ event: 'pane_created', data: { type: 'pane_created', pane: { pane_id: 'w6:pCD', workspace_id: 'w6', tab_id: 'w6:t81' } } }) });
  assert.equal(created.paneId, 'w6:pCD', '嵌套 data.pane.pane_id 可读');
  assert.equal(created.tabId, 'w6:t81');
  const focused = parseEventEnv({ HERDR_PLUGIN_EVENT: 'pane.focused',
    HERDR_PLUGIN_EVENT_JSON: JSON.stringify({ event: 'pane_focused', data: { type: 'pane_focused', pane_id: 'w6:pCG', workspace_id: 'w6' } }) });
  assert.equal(focused.paneId, 'w6:pCG');
  assert.equal(focused.cause, null);
  const manual = parseEventEnv({ HERDR_PLUGIN_EVENT_JSON: JSON.stringify({ type: 'pane.focused', data: { pane_id: 'pB', cause: 'user' } }) });
  assert.equal(manual.paneId, 'pB');
  assert.equal(manual.cause, 'user');
});

test('runReflow：pane.focused 全链——零 swap 原地分级 + 状态回写', async () => {
  const h = await reflow({ state: { panes: { 'pane-a': OLD_PANE, 'pane-b': OLD_PANE } } });
  assert.ok(calledRpc(h.calls, 'layout.export'), '取布局');
  assert.ok(!calledRpc(h.calls, 'pane.swap'), '网格原地热力：不换位');
  const r2 = Math.sqrt(0.72); // focus path root(second)→stack(first), depth 2; siblings are single panes → no extra ops
  assert.deepEqual(callRatioOps(h.calls), [['', 1 - r2], ['1', r2]]);
  assert.equal(h.state.tabs['tab-1'].lastFocusPaneId, 'pane-b', '状态回写');
});

test('runReflow：pane.created → 记账龄 + 数量重排（D95；首次创建也重排）', async () => {
  const h = await reflow({ ev: { hook: 'pane.created', paneId: 'pane-new' } });
  assert.ok(h.state.panes['pane-new'], '账龄已记');
  assert.equal(h.state.panes['pane-new'].tabId, 'tab-1', 'pane→tab 反查映射已记');
  assert.ok(calledRpc(h.calls, 'layout.export'), '首次创建也重排（D95：数量变化即重排）');
  assert.ok(calledRpc(h.calls, 'layout.set_split_ratio'), 'ratio 应用');
  assert.ok(h.state.tabs['tab-1'].lastApplyAt, 'tab 状态已更新');
});

test('runReflow：pane.closed（D95）→ 按 pane→tab 映射触发数量重排', async () => {
  const h = await reflow({ ev: { hook: 'pane.closed', paneId: 'pane-c', tabId: null, cause: null },
    state: { tabs: { 'tab-1': OLD_TAB }, panes: { 'pane-c': { tabId: 'tab-1' } } } });
  assert.deepEqual(h.calls.find(([m]) => m === 'layout.export')?.[1], { tab_id: 'tab-1' }, '关闭事件反查 tab');
  assert.ok(calledRpc(h.calls, 'layout.set_split_ratio'), '关闭重排应用 ratio');
});

test('runReflow：焦点年龄闸（F1 白名单 / d90 修正）', async (t) => {
  await t.test('幼龄 pane 无 cause → 跳过（3s 白名单）', async () => {
    const h = await reflow({ ev: { cause: null, paneId: 'pane-a' }, state: { panes: { 'pane-a': { createdAt: Date.now() } } } });
    assert.equal(h.calls.length, 0, '不发 layout.export');
  });
  await t.test('不在账的老 pane → 直接接受，不再现编 createdAt 误判新生', async () => {
    const h = await reflow({ ev: { cause: null, paneId: 'pane-old' } });
    assert.ok(calledRpc(h.calls, 'layout.export'), '老 pane 无条件过闸 → 发起 reflow');
    assert.ok(h.state.debounce, '防抖 token 已写');
  });
});

test('runReflow：agent_status_changed（档3 语义桥）', async (t) => {
  await t.test('焦点沿用 lastFocus + 原地分级', async () => {
    const h = await reflow({ ev: { hook: 'pane.agent_status_changed', paneId: 'pane-c', cause: null }, state: { tabs: { 'tab-1': OLD_TAB } },
      listAgentStatuses: async () => ({ 'pane-c': 'blocked', 'pane-b': 'idle', 'pane-a': 'idle' }) });
    assert.ok(!calledRpc(h.calls, 'pane.swap'), '零 swap：位置不动');
    // focus pane-a (root first, depth 1), blocked in a sibling → root=0.60; sibling stack b(1) vs c(3) → first share 0.25
    assert.deepEqual(callRatioOps(h.calls), [['', 0.6], ['1', 0.25]]);
    assert.ok(h.state.tabs['tab-1'].lastApplyAt > 1, 'tab 状态已更新');
  });
  await t.test('无 lastFocus 的 count/status 重排 → 退化 first pane 为焦点', async () => {
    const h = await reflow({ ev: { hook: 'pane.agent_status_changed', paneId: 'pane-b', cause: null },
      state: { tabs: { 'tab-1': { enabled: true } } }, listAgentStatuses: async () => ({}) });
    assert.equal(h.state.tabs['tab-1'].lastFocusPaneId, 'pane-a', 'first pane 兜底');
  });
});

test('runReflow：防抖期被更新 token 顶掉 → 不应用', async () => {
  const h = makeReflowDeps();
  let first = true; // a concurrent focus overwrites the stored token → shouldFireDebounced mismatch
  const baseLoad = h.deps.loadState;
  h.deps.loadState = () => (first ? (first = false, baseLoad()) : { tabs: {}, panes: {}, debounce: { token: 'later:x' } });
  await runReflow(h.deps);
  assert.equal(h.calls.length, 0, '被顶掉的聚焦不应用');
});

// Scenario B isolation: default piTabIds pass through, a snapshot failure stays inert, status/created gated too
type GateCase = { name: string; opts: ReflowDepsOpts; ratio: boolean; msg: string; exports?: boolean };
const GATE_CASES: GateCase[] = [
  { name: 'piTabIds 缺省（旧接线/单测）→ 不过滤，行为不变', opts: {}, ratio: true, msg: '缺省放行' },
  { name: 'tab 不在 pi 集合（claude code / codex / 纯 shell 的 tab）→ export 后止步', opts: piTabIds('tab-other'), ratio: false, msg: '非 pi tab 零 ratio', exports: true },
  { name: 'tab 含 pi pane → 正常 reflow', opts: piTabIds('tab-1'), ratio: true, msg: 'pi tab 照常' },
  { name: 'piTabIds 快照抛错 → 保守不动（空集合语义）', opts: { piTabIds: async () => { throw new Error('socket down'); } }, ratio: false, msg: '快照失败零 ratio' },
  { name: 'status 路径受闸：非 pi tab 的 blocked 不触发重排', ratio: false, msg: '非 pi tab 的 blocked 不触发重排', opts: { ...piTabIds('tab-other'), ev: { hook: 'pane.agent_status_changed', paneId: 'pane-c', cause: null }, state: { tabs: { 'tab-old': OLD_TAB } }, listAgentStatuses: async () => ({ 'pane-c': 'blocked' }) } },
  { name: 'created 路径受闸：非 pi tab 的数量变化不触发重排', ratio: false, msg: '非 pi tab 的数量变化不触发重排', opts: { ...piTabIds('tab-other'), ev: { hook: 'pane.created', paneId: 'pane-new' } } },
];

test('runReflow：收紧闸——只有含 pi pane 的 tab 参与重排', async (t) => {
  for (const c of GATE_CASES) {
    await t.test(c.name, async () => {
      const h = await reflow(c.opts);
      assert.equal(calledRpc(h.calls, 'layout.set_split_ratio'), c.ratio, c.msg);
      if (c.exports) assert.ok(calledRpc(h.calls, 'layout.export'), 'export 仍发生（tabId 解析来源）');
    });
  }
});

test('runReflow：粘性 pi tab——全部 pi 退回 shell 后记账 tab 仍 reflow（退出命令行仍可焦点放大）', async () => {
  let liveSet = new Set(['tab-1']); // pi still running: visible to the live scan
  let state: Record<string, any> = { tabs: {}, panes: { 'pane-b': OLD_PANE }, debounce: null };
  const bound = { piTabIds: async () => liveSet, loadState: () => state, saveState: (s: Record<string, any>) => { state = s; } };
  const holder = await reflow(bound);
  assert.ok(calledRpc(holder.calls, 'layout.set_split_ratio'), 'live pi tab 照常应用');
  assert.ok(state.tabs['tab-1'], '成功 apply 写入记账（粘性来源）');
  liveSet = new Set(); // both panes left pi: live set empty, but the tab is recorded → sticky pass
  const after = await reflow({ ...bound, ev: { paneId: 'pane-c' } });
  assert.ok(calledRpc(after.calls, 'layout.set_split_ratio'), '全 shell 的记账 tab 仍焦点放大');
  assert.equal(state.tabs['tab-1'].lastFocusPaneId, 'pane-c', '焦点切换生效');
  state.tabs['tab-1'] = { ...state.tabs['tab-1'], enabled: false }; // recorded + enabled:false → escape gate stays shut
  const opted = await reflow(bound);
  assert.ok(!calledRpc(opted.calls, 'layout.set_split_ratio'), 'enabled:false 不再自动重排');
});

test('askFlagsFromListResult：非空 pi-ask 为 true', () => {
  assert.deepEqual(askFlagsFromListResult({
    agents: [{ pane_id: 'p1', tokens: { 'pi-ask': 'q?' } }, { pane_id: 'p2', tokens: { 'pi-ask': '' } }, { pane_id: 'p3' }],
  }), { p1: true });
});

test('runReflow：status 在同 pane 集合上手拖 hold；created 重建基线', async () => {
  const { root } = unwrapLayout(REFLOW_LAYOUT);
  assert.ok(root);
  const prior = layoutFingerprint(root);
  const dragged = { layout: { ...REFLOW_LAYOUT.layout, root: { ...REFLOW_LAYOUT.layout.root, ratio: 0.2 } } };
  const status = await reflow({ exported: dragged, ev: { hook: 'pane.agent_status_changed', paneId: 'pane-c', cause: null },
    state: { tabs: { 'tab-1': { ...OLD_TAB, lastFingerprint: prior } } } });
  assert.ok(calledRpc(status.calls, 'layout.export'), '导出仍发生');
  assert.ok(!calledRpc(status.calls, 'layout.set_split_ratio'), '手拖不被 status 拉回');
  const created = await reflow({ exported: dragged, ev: { hook: 'pane.created', paneId: 'pane-new' },
    state: { tabs: { 'tab-1': { enabled: true, lastFocusPaneId: 'pane-a', lastFingerprint: prior } } } });
  assert.ok(calledRpc(created.calls, 'layout.set_split_ratio'), 'created 即使比例偏离也重建基线');
});

/* ════════ plugin state file (F15: concurrent hook processes) ════════ */

const tempDir = (tag: string) => fs.mkdtempSync(path.join(os.tmpdir(), `pier-${tag}-`));

test('writeJsonAtomic/readJsonSafe: 往返，且目录不存在时会自建', () => {
  const dir = tempDir('state'), file = path.join(dir, 'nested', 'tab-layout.json');
  writeJsonAtomic(file, { tabs: { 'w1:t1': { enabled: true } }, panes: {}, debounce: null });
  assert.deepEqual(readJsonSafe(file, null), { tabs: { 'w1:t1': { enabled: true } }, panes: {}, debounce: null });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeJsonAtomic: 不留下临时文件，覆盖写不产生半截 JSON', () => {
  const dir = tempDir('state2'), file = path.join(dir, 'tab-layout.json');
  for (let i = 0; i < 20; i += 1) writeJsonAtomic(file, { i, blob: 'x'.repeat(500) });
  assert.deepEqual(readJsonSafe(file, null), { i: 19, blob: 'x'.repeat(500) });
  assert.deepEqual(fs.readdirSync(dir), ['tab-layout.json'], '临时文件必须被 rename 消费掉');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readJsonSafe: 半截/非法 JSON 与缺失文件都回退到默认值（不抛）', () => {
  const dir = tempDir('state3'), file = path.join(dir, 'broken.json');
  fs.writeFileSync(file, '{"tabs": {"w1:t1":');
  assert.deepEqual(readJsonSafe(file, { tabs: {} }), { tabs: {} });
  assert.equal(readJsonSafe(path.join(dir, 'missing.json'), 'fallback'), 'fallback');
  fs.rmSync(dir, { recursive: true, force: true });
});
