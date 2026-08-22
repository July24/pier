# 安装与使用手册（pier v0.1.0）

pi × herdr 工作台融合插件的双半区安装。环境要求：Node ≥ 22、pi ≥ 0.84、
herdr ≥ 0.8（Windows 为 preview beta）。

## 1. pi 侧扩展（`pier-ext` / `@pier/ext`）

三种安装方式任选其一（效果相同，扩展在非 herdr 环境下自动降级）：

```sh
# A. pi package 本地路径安装（推荐开发期；注册进 settings.packages，随包自动加载）
pi install F:\path\to\pier\packages\pier-ext

# B. 全局扩展目录（手工）
#    copy packages/pier-ext/src/*.ts → ~/.pi/agent/extensions/pier-ext/

# C. 单次加载（不持久）
pi -e F:\path\to\pier\packages\pier-ext\src\index.ts
```

卸载：`pi remove F:\path\to\pier\packages\pier-ext`。

Skill（渐进式披露的模型手册）随包自动安装：`/skill:pi-herdr-workflow` 或模型按需读取。

## 2. herdr 侧插件（`pier-workbench` / `pier.workbench`）

```sh
herdr plugin link F:\path\to\pier\packages\pier-workbench
```

- 提供主 tab 引导、会话恢复与 blocked 事件通知钩子。
  todo 显示走 pane 标题投影（`▶i ○p ■b ✓c · 当前任务`），不再开独立看板 pane。
- 发布形态：GitHub 仓库 + `herdr-plugin` topic（marketplace 自动索引），
  `herdr plugin install owner/repo/packages/pier-workbench`（subdir 安装）。

## 3. 引导配置（本机）

`packages/pier-workbench/scripts/boot-config.json` 是**本机引导配置**（指定 node / pi /
扩展路径），默认不入库（在 .gitignore 中）。首次使用请复制模板：

```sh
copy packages\pier-workbench\scripts\boot-config.example.json packages\pier-workbench\scripts\boot-config.json
```

填入你的 `piNode` / `piCli` / `extPath` 绝对路径（模板中为占位符）。

## 4. 使用

1. 在 herdr workspace 里开 pane 跑 pi（pane 内 `pi`），扩展自动检测 `HERDR_ENV` 并开始上报；
2. 模型可调用 `todo_write`（窗格头实时投影）、`subagent`（前台/并行/后台）、
   `list_agents` / `send_message` / `interrupt_agent`（后台子代理）；
3. 每个子代理 = 独立 pane（可观察、可进入交互、blocked 时触发通知）；
4. 重启恢复：herdr session 恢复自动重建 pane（`resume_agents_on_restore` 默认开，
   子代理的 rpc 会话文件已上报为 agent_session）；父 pi 会话用 `/resume` 恢复，
   子代理目录经会话分支持久化重建。

## 5. 兼容矩阵与已知问题（herdr 0.8.0-preview / Windows 实测）

| 项 | 状态 | 说明 |
|---|---|---|
| Windows + herdr preview | ⚠️ beta | 全部实测通过，但协议/行为可能随版本变化 |
| WSL2 内跑 herdr + Windows 原生 pi | 未实测 | 推荐整栈同环境（herdr 与 pi 同在 WSL 或同在 Windows），socket 路径约定不同 |
| macOS / Linux | 未实测（理论可用） | socket = Unix domain socket（代码已按平台分支；Windows 的 named pipe 前缀逻辑不适用） |
| herdr pane 命令进程退出 | 已知行为 | pane 被重置为新 shell、输出清空（子 pane 用 powershell 常驻包裹规避） |
| pane.send_input | 不可用 | Windows preview 只产生终端回显、不投递进程 stdin；派活用 pane.send_text+CR（实测） |
| agent.prompt（bracketed-paste） | 对 pi TUI 不可用 | agent_prompt_stalled（实测）；v1.1 派活走 pane.send_text 注入编辑器 |
| agent start --kind pi | Windows npm 安装不可用 | `Start-Process pi` 无法执行 pi.ps1；启动走 layout.apply + powershell 包裹（macOS/Linux standalone 二进制不受影响） |
| herdr title 80 字符截断 | 已规避 | 标题投影本地先裁（TITLE_MAX=80）；明细走 /todos + widget |
| state_labels | 仅合法键 | idle\|working\|blocked\|done\|unknown；blocked 徽标用 `blocked` 键 |
| 子 pane 人机并存 | 软锁 | 派活仅发生在 agent_status=idle；注入为毫秒级原子粘贴；工作期输入进 pi 队列（steer/followUp）；Escape 可恢复 |

## 6. 测试

```sh
npm install --ignore-scripts   # 仓库根（devDeps：pi-coding-agent 类型 + typebox）
npm test                       # 单测（242 项：规划器 / todo 重放 / 会话尾 / GC / 生命周期）
```
