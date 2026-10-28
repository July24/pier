# pier-workbench（herdr 插件半区）

把 pi 工作台接到 herdr：blocked 人类闸门通知、任务 tab 焦点热力布局（聚焦 pane 原地放大，0.72 目标）、运维面板与侧边栏 agent 视图。todo 走窗格 title 投影（`▶i ○p ■b ✓c · 当前任务`），不再开独立看板 pane。

## 组件

- `herdr-plugin.toml`：插件清单（blocked 通知 + 热力重排 + 侧边栏视图注册钩子）。
- `scripts/load-src.mjs`：钩子脚本共享层——优先加载 tsc 预编译的 `src/*.js`（每次事件一个 Node 进程，运行时剥类型要多花 ~150ms），源码更新时回退 `*.ts`。产物由根目录 `npm run build:workbench` 生成并随仓库分发（`npm test` 自动重建，CI 校验不漂移）。
- `scripts/notify-agent-state.mjs`：`pane.agent_status_changed` → blocked 通知。
- `scripts/heat-reflow.mjs` + `src/heat-layout.ts`：焦点热力布局（`pane.focused` / `agent_status_changed` / `pane.created` / `pane.closed` → 原地 ratio 重排；前置数据（agent 状态 / pi-ask 旗标 / pi-tab 集合）合并为单次 `session.snapshot` RPC——herdr socket 每连接只服务一个请求，省两次往返；pi-tab 判定粘性化：成功 reflow 过的 tab 在全部 pi 退回 shell 后仍保留焦点放大，`enabled:false` 可按 tab 关闭）。
- `scripts/panel.mjs` + `src/dashboard-model.ts`：统一 Pier panel（默认 herdr 单例 popup，`1 Dashboard` / `2 Tree` 两个 glance 视图，面板内 `1`/`2`/`Tab` 切换，当前 tab 反色高亮）。`/dashboard` 与 `/pier-tree` 都打开它，只是 `PIER_PANEL` 指定初始 tab；popup 是会话模态，打开期间不会再执行第二条 slash command。dashboard 视图走 `session.snapshot` 实时数据；tree 视图读 `/pier-tree` 写入的 `PIER_TREE_FILE` 快照（master 为根、worker/settled 节点以 `├─`/`└─` 挂接）。按 PTY 宽高软换行 + 视口滚动，窄终端不再截断；tree 行按词换行并悬挂缩进到条目正文下。`/dashboard overlay` 与 `/pier-tree overlay` 复用同一脚本作为独立全窗 pane。
- `scripts/agent-view.mjs` + `src/agent-view.ts`：侧边栏 agent 视图注册（herdr 0.9.0 `agent.view.set`，不过滤 harness——任何 agent 都显示——只把 attention 高的排前面）。

## 安装

```sh
# User mode (reinstall to update)
herdr plugin install July24/pier/packages/pier-workbench --yes
# Dev mode (local link, edits take effect immediately)
herdr plugin link /path/to/pier/packages/pier-workbench   # Windows: F:\path\to\pier\packages\pier-workbench
```


## 依赖

- herdr ≥ 0.9.5（Windows 为 preview beta；原生 `pane.focused`、subagent pane 自报告 resume、关机安全保存）
- Node ≥ 22（跑 scripts）
- 对端：pi ≥ 1.3.0 装有 `pi-pier` 扩展且在该 workspace 的受管 pane 内运行
