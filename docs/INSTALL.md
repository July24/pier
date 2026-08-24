# 安装与使用手册（pier v0.1.0）

pi × herdr 工作台融合插件的双半区安装。环境要求：Node ≥ 22、pi ≥ 0.84、
herdr ≥ 0.8（macOS / Linux 稳定支持；Windows 为 preview beta）。

## 0. 一键安装（推荐）

```sh
git clone git@github.com:July24/pier.git && cd pier
node install.mjs                 # 用户模式（默认）
node install.mjs install --dev   # 开发模式（本地 link，改码即生效）
```

脚本流程：

1. 校验 node ≥ 22、pi ≥ 0.84、herdr ≥ 0.8.0（缺失给安装指引并退出）；
2. 探测 pi 的 node 解释器（`process.execPath`）与 cli.js 绝对路径
   （`which pi` → symlink realpath → `npm root -g` 兜底）；
3. 生成 boot-config.json：用户模式写 `herdr plugin config-dir pier.workbench`
   （重装插件不丢）；dev 模式写 `packages/pier-workbench/scripts/boot-config.json`；
4. 注册两半区（见下表）。

| | 用户模式（默认） | 开发模式（`--dev`） |
|---|---|---|
| pi 扩展 | `pi install git:github.com/July24/pier`（仓库根 `pi` 字段：扩展 + skill） | `pi install ./packages/pier-ext` |
| herdr 插件 | `herdr plugin install July24/pier/packages/pier-workbench --yes` | `herdr plugin link ./packages/pier-workbench` |
| 更新 | `node install.mjs update`（或 `herdr plugin install` 重装替换 checkout + `pi update`） | 无需操作（link 目录是活的） |
| 卸载 | `node install.mjs uninstall`（`--purge` 连配置删） | 同左（unlink 保留文件） |

发行规格覆盖：`--pi-spec=npm:@pier/ext`（npm 发布场景）或 `--herdr-spec=<owner>/<repo>/…`（fork）。

## 1. 手动安装：pi 侧扩展（`pier-ext` / `@pier/ext`）

```sh
# A. git 源（用户模式；根 package.json 的 pi 字段带扩展 + skill）
pi install git:github.com/July24/pier

# B. 本地路径（开发期；注册进 settings.packages，随包自动加载）
pi install ./packages/pier-ext

# C. 单次加载（不持久）
pi -e ./packages/pier-ext/src/index.ts
```

卸载：`pi remove <同安装源>`。Skill（渐进式披露的模型手册）随包自动安装：
`/skill:pi-herdr-workflow` 或模型按需读取。

## 2. 手动安装：herdr 侧插件（`pier-workbench` / `pier.workbench`）

```sh
herdr plugin install July24/pier/packages/pier-workbench --yes   # 用户模式（subdir 安装）
herdr plugin link ./packages/pier-workbench                        # 开发模式
```

- 提供主 tab 引导、会话恢复与 blocked 事件通知钩子。
  todo 显示走 pane 标题投影（`▶i ○p ■b ✓c · 当前任务`），不再开独立看板 pane。
- 发布形态：GitHub 仓库 + `herdr-plugin` topic（marketplace 自动索引）。

## 3. 引导配置（本机）

master 主 tab 引导需要本机 node / pi 绝对路径（workbench 钩子进程跑在 pi 之外，
无法自探测）。优先用 `node install.mjs` 自动生成；手动可复制模板
`packages/pier-workbench/scripts/boot-config.example.json`（含 macOS / Windows 双平台占位）：

```sh
# macOS / Linux
cp packages/pier-workbench/scripts/boot-config.example.json <配置位置>/boot-config.json
# Windows
copy packages\pier-workbench\scripts\boot-config.example.json <配置位置>\boot-config.json
```

配置位置：用户模式 = `herdr plugin config-dir pier.workbench` 输出的目录；
开发模式 = `packages/pier-workbench/scripts/`。脚本读取顺序
`HERDR_PLUGIN_CONFIG_DIR` → `scripts/`（两半区行为一致）。

## 4. 使用

1. 在 herdr workspace 里开 pane 跑 pi（pane 内 `pi`），扩展自动检测 `HERDR_ENV` 并开始上报；
2. 模型可调用 `todo_write`（窗格头实时投影）、`subagent`（前台/并行/后台）、
   `list_agents` / `send_message` / `interrupt_agent`（后台子代理）；
3. 每个子代理 = 独立 pane（可观察、可进入交互、blocked 时触发通知）；
4. 重启恢复：herdr session 恢复自动重建 pane（`resume_agents_on_restore` 默认开，
   子代理的 rpc 会话文件已上报为 agent_session）；父 pi 会话用 `/resume` 恢复，
   子代理目录经会话分支持久化重建。

## 5. 兼容矩阵与已知问题（herdr 0.8.0-preview / Windows 实测；0.8.2 / macOS 实测）

| 项 | 状态 | 说明 |
|---|---|---|
| Windows + herdr preview | ⚠️ beta | 全部实测通过，但协议/行为可能随版本变化 |
| macOS（herdr 0.8.2） | ✅ 实测通过 | 插件钩子（POSIX 条目）→ 主 tab 引导 → subagent POSIX 启动行全链路冒烟通过 |
| Linux | 未实测（理论可用） | 与 macOS 同走 POSIX 分支（unix socket + sh 引号） |
| WSL2 内跑 herdr + Windows 原生 pi | 未实测 | 推荐整栈同环境（herdr 与 pi 同在 WSL 或同在 Windows），socket 路径约定不同 |
| herdr pane 命令进程退出 | 已知行为 | pane 被重置为新 shell、输出清空（子 pane 用常驻 shell 包裹规避） |
| pane.send_input | 不可用 | Windows preview 只产生终端回显、不投递进程 stdin；派活用 pane.send_text+CR（实测） |
| agent.prompt（bracketed-paste） | 对 pi TUI 不可用 | agent_prompt_stalled（实测）；派活走扩展管道注入（pane.send_text 仅起进程） |
| agent start --kind pi | Windows npm 安装不可用 | `Start-Process pi` 无法执行 pi.ps1；启动走 layout.apply / split + shell 包裹（macOS/Linux 同款路径） |
| herdr title 80 字符截断 | 已规避 | 标题投影本地先裁（TITLE_MAX=80）；明细走 /todos + widget |
| state_labels | 仅合法键 | idle\|working\|blocked\|done\|unknown；blocked 徽标用 `blocked` 键 |
| 子 pane 人机并存 | 软锁 | 派活仅发生在 agent_status=idle；prompt 走扩展管道（毫秒级），PTY 键盘通道 100% 归人 |

## 6. 测试

```sh
npm install --ignore-scripts   # 仓库根（devDeps：pi-coding-agent 类型 + typebox）
npm test                       # 单测（244 项：规划器 / todo 重放 / 会话尾 / GC / 生命周期 / 跨平台引号）
```
