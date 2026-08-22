# pier-workbench（herdr 插件半区）

把 pi 工作台接到 herdr：主 tab 引导、blocked 人类闸门通知、任务 tab 焦点热力布局（聚焦 pane 原地放大，0.72 目标）。todo 走窗格 title 投影（`▶i ○p ■b ✓c · 当前任务`），不再开独立看板 pane。

## 组件

- `herdr-plugin.toml`：插件清单（blocked 通知 + workspace 引导 + 会话恢复 + 热力重排钩子）。
- `scripts/notify-agent-state.mjs`：`pane.agent_status_changed` → blocked 通知。
- `scripts/bootstrap.mjs` / `restore-layout.mjs`：主 tab 引导与恢复。
- `scripts/heat-reflow.mjs` + `src/heat-layout.ts`：焦点热力布局（`pane.focused` / `agent_status_changed` / `pane.created` / `pane.closed` → 原地 ratio 重排）。
- `scripts/boot-config.example.json`：本机引导配置模板（真实的 `boot-config.json` 不入库，含个人路径）。

## 安装（开发）

```sh
herdr plugin link F:\path\to\pier\packages\pier-workbench
```

## 依赖

- herdr ≥ 0.8.0（Windows 为 preview beta）
- Node ≥ 22（跑 scripts）
- 对端：pi 0.84+ 装有 `@pier/ext` 扩展且在该 workspace 的受管 pane 内运行
