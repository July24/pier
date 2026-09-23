# pier-workbench（herdr 插件半区）

把 pi 工作台接到 herdr：blocked 人类闸门通知、任务 tab 焦点热力布局（聚焦 pane 原地放大，0.72 目标）、运维面板与侧边栏 agent 视图。todo 走窗格 title 投影（`▶i ○p ■b ✓c · 当前任务`），不再开独立看板 pane。

## 组件

- `herdr-plugin.toml`：插件清单（blocked 通知 + 热力重排 + 侧边栏视图注册钩子）。
- `scripts/herdr-rpc.mjs`：钩子脚本共享层（socket 目标解析、NDJSON 请求）。
- `scripts/notify-agent-state.mjs`：`pane.agent_status_changed` → blocked 通知。
- `scripts/heat-reflow.mjs` + `src/heat-layout.ts`：焦点热力布局（`pane.focused` / `agent_status_changed` / `pane.created` / `pane.closed` → 原地 ratio 重排；pi-tab 判定粘性化：成功 reflow 过的 tab 在全部 pi 退回 shell 后仍保留焦点放大，`enabled:false` 可按 tab 关闭）。
- `scripts/dashboard.mjs` + `src/dashboard-model.ts`：运维观察面板（herdr 0.9.0 原生 plugin pane，通过 `session.snapshot` 实时展示 workspace / tab / agent 状态）。
- `scripts/agent-view.mjs` + `src/agent-view.ts`：侧边栏 agent 视图注册（herdr 0.9.0 `agent.view.set`，不过滤 harness——任何 agent 都显示——只把 attention 高的排前面）。

## 安装

```sh
# User mode (reinstall to update)
herdr plugin install July24/pier/packages/pier-workbench --yes
# Dev mode (local link, edits take effect immediately)
herdr plugin link /path/to/pier/packages/pier-workbench   # Windows: F:\path\to\pier\packages\pier-workbench
```


## 依赖

- herdr ≥ 0.9.0（Windows 为 preview beta）
- Node ≥ 22（跑 scripts）
- 对端：pi 0.84+ 装有 `@pier/ext` 扩展且在该 workspace 的受管 pane 内运行
