<div align="center">

# pier · pi × herdr 工作台融合

[English](README.md) · **中文**

**pier** = **pi** × h**erdr** 的融合体（码头/桥，对接、停泊、分发）。

[pi](https://pi.dev/)（`@earendil-works/pi-coding-agent`）是 coding agent 载体，[herdr](https://herdr.dev/) 是终端工作区管理器。pier 补上 pi 刻意不内置的两项能力——**todo list 闭环**与**交互式子代理**——并让它们以 herdr 的 pane/tab 为视觉与交互底座。

</div>

---

## 是什么

pier 由**两个半区**组成，各装一处：

| 半区 | 包 | 作用 |
|---|---|---|
| **pi 扩展** | `packages/pier-ext`（npm: [`pi-pier`](https://www.npmjs.com/package/pi-pier)，[pi.dev 市场](https://pi.dev/packages/pi-pier)） | 在 pi 会话里注入 `todo_write` / `subagent` / `list_agents` / `send_message` / `interrupt_agent` 工具 + 经 herdr socket API 上报 pane 状态 |
| **herdr 插件** | `packages/pier-workbench`（`pier.workbench`） | 主 tab 引导、blocked 人类闸门通知、焦点热力布局（聚焦 pane 原地放大） |

### 核心能力

- **todo 闭环**：`todo_write` 全量替换语义、会话 JSONL 权威、分支正确回滚；窗格标题实时投影 `▶i ○p ■b ✓c (N/M) · 当前任务`；`/todos` 命令（含 unblock）可查看/编辑
- **todo 反冻结**：全完成列表 ≥6 轮未写 → 读钩复读改为改写警告；≥1h 未写 → 归档（明细不再注入，标题降权为 `✓N done <age>`）；`/todos` 永远可查全量，会话 JSONL 权威不动
- **交互式子代理**：每个子代理 = 独立 pane 的隔离 pi 会话（独立上下文窗口）；**人类可随时进入该 pane 直接对话**（修 bug、接管、回答 ask_user_question）
- **软锁防争抢**（写路径按 pane 粒度锁 token，冲突时警告/阻止）
- **角色档案**：`master` / `worker-default` 内置，自定义 role 按 `.pi-herdr/roles/<name>.json` 挂载；工具集按角色收敛（deny 规则不可绕过）
- **人类闸门**：子代理 `ask_user_question` → 侧边栏 blocked 标记 + 通知；用户手动接管（ESC 打断后输入）→ 启发式检测自动暂停/归还 master 管理
- **焦点热力布局**：聚焦 pane 原地放大（0.72 目标），blocked / ask / working / idle 按权重分大小，多余 pane 自动压成 title 条
- **横条拓扑 + 窄格静帧（防闪）**：新 pane 一律上下拆成全宽横条；master 与 worker 均以 `--tui-mode fullscreen` 启动（备用屏行级差分；手动 `pi` 跟随全局 `tuiMode` 设置）；pane 长宽放不下最小可用 TUI（<24 列或 <12 行）时覆盖一张 pane title 同源静帧——流式 thinking 不再让横条闪烁，点击聚焦放大即见真 TUI。逃生口：`PI_HERDR_TUI=regular`、`PI_HERDR_SLIM_FRAME=0`
- **结算通知折叠**：后台子代理结算不再攒到 run 结束洪水回填——turn 间隙注入，最多 3 条逐条展示、其余折叠指路

## 安装

### 环境要求

- Node ≥ 22
- pi ≥ 0.84（`@earendil-works/pi-coding-agent`）
- herdr ≥ 0.8.0（macOS / Linux / Windows；Windows 为 preview beta）

### 一键安装（推荐）

无需克隆仓库，直接用 npm 包运行：

```sh
npx pier-setup            # 用户模式：pi install npm:pi-pier + herdr plugin install + 自动生成引导配置
npm i -g pier-setup       # 或全局安装后直接跑 pier-setup
```

开发模式仍需克隆仓库：

```sh
git clone https://github.com/July24/pier && cd pier
node install.mjs install --dev   # 本地路径 pi install + herdr plugin link，改码即生效
```

脚本自动校验环境（node / pi / herdr 版本）、探测 pi 的 node 与 cli.js 绝对路径、
生成 boot-config.json（用户模式落 herdr 插件配置目录，重装不丢），并注册两半区。

其他命令：`pier-setup update`（卸载+重装，重探测路径）、`pier-setup uninstall --purge`。
发行规格可用 `--pi-spec=` / `--herdr-spec=` 覆盖（npm 发布或 fork 场景）。

### 手动安装（等价步骤）

```sh
# pi 侧扩展（任选其一；npm 源 = 用户模式推荐，git 源 = 跟随仓库最新，本地路径 = 开发模式）
pi install npm:pi-pier                # 用户模式（npm 发布版，自动出现在 pi.dev/packages 市场）
pi install git:github.com/July24/pier # 用户模式（跟随 main 最新）
pi install ./packages/pier-ext        # 开发期

# herdr 侧插件
herdr plugin install July24/pier/packages/pier-workbench --yes   # 用户模式（重装即更新）
herdr plugin link ./packages/pier-workbench                        # 开发期
```

扩展在非 herdr 环境下自动降级（详见下节"作用域"）。

### 作用域（只影响 herdr × pi 交叉场景）

- **非 herdr 环境用 pi**：扩展自动降级——herdr 上报零成本，`subagent` / 终端族
  工具返回"requires a herdr-managed pane"提示；`todo_write` / `ask_user_question`
  照常可用（以会话 JSONL 为权威，无 herdr 依赖）。
- **herdr 中用其他 agent（claude code / codex 等）**：不含 pi pane 的 tab 不参与
  热力布局；blocked 通知只发给 pi；主 tab 自动引导可用 boot-config 的
  `autoBootstrap: false` 关闭。

### 引导配置（workbench 半区）

master 主 tab 引导需要本机 node / pi 路径：`node install.mjs` 自动生成；手动可复制模板
`packages/pier-workbench/scripts/boot-config.example.json`（含 macOS / Windows 双平台占位）。
用户模式配置在 `herdr plugin config-dir pier.workbench`；开发模式在 `packages/pier-workbench/scripts/boot-config.json`。

### 使用

1. 在 herdr workspace 里开 pane 跑 pi（pane 内 `pi`），扩展检测 `HERDR_ENV` 自动开始上报
2. 模型可调用 `todo_write`（窗格头实时投影）、`subagent`（前台/并行/后台）、`list_agents` / `send_message` / `interrupt_agent`
3. 每个子代理 = 独立 pane（可观察、可进入交互、blocked 时触发通知）
4. 重启恢复：herdr session 恢复自动重建 pane（子代理 rpc 会话文件已上报）；父 pi 会话用 `/resume` 恢复

## 仓库结构

```
packages/
  pier-ext/        # pi 扩展（npm: pi-pier）：todo/subagent 工具、herdr 客户端、vocab 权威、skill
  pier-workbench/  # herdr 插件（pier.workbench）：主 tab 引导 + blocked 通知 + 热力布局
docs/              # 安装手册、role 档案说明、侧边栏 role 配置
```

## 测试

```sh
npm install --ignore-scripts
npm test          # node --test，278 项单测（规划器 / todo 重放 / 反冻结陈旧度 / 会话尾 / GC / 生命周期）
```

## 设计原则

- **会话 JSONL 是唯一权威**：todo / 委派 / 注册表全部回放自会话分支，重启与分支切换正确
- **事件驱动，不轮询**：状态经 herdr 事件订阅（`pane.agent_status_changed` / `pane.closed`）推送，仅事件触发时拉一次快照
- **零位置迁移**：herdr BSP 布局拓扑创建时定死，pier 只调 split ratio——pane 位置永不动，大小按优先级重算
- **尽力而为的投影层**：上报失败静默，绝不影响 pi 主流程

## License

MIT

---

> 💡 **开发说明**：`.gitignore` 刻意**不提交**到本仓库（本地资产忽略规则属个人环境）。贡献者请基于 `README.md` / `README_ZH.md` 自行维护忽略规则；`packages/pier-workbench/scripts/boot-config.json` 亦为本机配置（模板见 `.example.json`）。
>
> **命名约定**：品牌名 **pier**（仓库/包/插件），运行时协议标识保留 **`pi-herdr`** 前缀（`.pi-herdr/roles/` 目录、`pi-herdr.subs` 等会话 custom 条目、`~/.pi/agent/herdr-pi/roles/` 用户目录）——它们随用户会话/配置文件持久化，改动会破坏既有数据，属兼容层。
