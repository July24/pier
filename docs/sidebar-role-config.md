# 侧边栏 role 识别配置（D93）

> 目标：通过 herdr 侧边栏分清每个 agent 是哪个角色（master/reviewer/worker…）、都在干嘛。
> 依赖 herdr ≥ 0.8.2（sidebar token 机制）；pi-herdr 扩展 ≥ D93 自动上报，无需配置。

## 自动生效的部分（零配置）

pi-herdr 扩展启动时自动上报：

1. **`display_agent` = role 名**——侧边栏每张 agent 卡的 agent 位直接显示
   `master` / `reviewer` / `worker`（`worker-default` 自动美化），不再千篇一律 `pi`。
   （herdr 侧 `display_agent` 优先于 agent 检测值）
2. **`$pi-todo` custom token = todo 摘要**——与 pane 标题同源同格式：
   `▶1 ○2 ■0 ✓3 (2/5 ~4m) · 正在做的事`。随时变空（todo 清空时同步清）。

## 可选：精细排版（用户 config.toml）

配置文件：`%USERPROFILE%\.config\herdr\config.toml`（Windows）。

### 样例一：所有 agent 统一加 todo 行

```toml
[ui.sidebar.agents]
rows = [
  ["state_icon", "workspace", "tab"],
  ["agent"],
  ["$pi-todo"],
]
```

### 样例二：只给 pi 类 agent 加（其他 agent 保持默认两行）

```toml
[ui.sidebar.agents]
rows = [["state_icon", "workspace", "tab"], ["agent"]]

[ui.sidebar.agents.rows_by_agent]
pi = [
  ["state_icon", "workspace", "tab"],
  ["agent"],
  ["$pi-todo"],
]
```

> 注：`rows_by_agent` 的键是 herdr 检测到的 agent id（`pi`），不是 display_agent 显示名。

### 样例三：带样式（role 名高亮）

```toml
[ui.sidebar.agents]
rows = [
  ["state_icon", "workspace", "tab"],
  [{ token = "agent", fg = "#89b4fa", bold = true }],
  ["$pi-todo"],
]
```

内建 token：`state_icon` `state_text` `workspace` `tab` `pane` `agent` `terminal_title`
`terminal_title_stripped`；自定义 token 以 `$` 开头（我们上报的即 `$pi-todo`）。
样式只支持前景色（`#RGB`/`#RRGGBB`）+ `bold` + `dim`。

## 排序（可选）

侧边栏默认按 workspace 分组。想让阻塞的排前面：

```toml
agent_panel_sort = "agents"
```

## 验证

1. 重启 herdr（config 只在启动时读）
2. master + 任一 worker 启动后，侧边栏应显示不同 role 名
3. worker 做 todo 变更后，`$pi-todo` 行实时刷新
