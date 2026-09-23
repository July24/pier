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
| **pi 扩展** | `packages/pier-ext`（npm: [`pi-pier`](https://www.npmjs.com/package/pi-pier)，[pi.dev 市场](https://pi.dev/packages/pi-pier)） | 在 pi 会话里注入 `todo_write` / `subagent` / `terminal` / `ask_user_question` 工具 + 经 herdr socket API 上报 pane 状态 |
| **herdr 插件** | `packages/pier-workbench`（`pier.workbench`） | 主 tab 引导、blocked 人类闸门通知、焦点热力布局（聚焦 pane 原地放大） |

### 核心能力

- **todo 闭环**：`todo_write` 全量替换语义、会话 JSONL 权威、分支正确回滚；窗格标题实时投影 `▶i ○p ■b ✓c (N/M) · 当前任务`；TUI widget 为活动锚定窗口（in_progress 条目及其前后上下文随执行位置滚动可见）；`/todos` 命令（含 unblock）可查看/编辑
- **todo 反冻结**：全完成列表 ≥6 轮未写 → 读钩复读改为改写警告；≥1h 未写 → 归档——先给一次带旧条目参照的重写窗口，无视后终态通知并清空列表（rm 落 JSONL，空守卫接管，多步工作必须重建清单）；`/todos` 永远可查历史，会话 JSONL 权威不动
- **交互式子代理**：每个子代理 = 独立 pane 的隔离 pi 会话（独立上下文窗口）；**人类可随时进入该 pane 直接对话**（修 bug、接管、回答 ask_user_question）
- **子代理输出预览**：`subagent(action: "output", agentId)` 返回后台子代理自上次调用以来的新输出——内存中的 per-pane 游标计算增量（优先 `agent.read`，旧版 herdr 回退 `pane.read`），结果带状态、revision、截断与 `restart` 标记（缓冲回卷/清屏），master 不必等到结算就能发现卡住的 worker
- **软锁防争抢**（写路径按 pane 粒度锁 token，冲突时警告/阻止）
- **角色档案**：`master` / `worker-default` 内置，自定义 role 按 `.pi-herdr/roles/<name>.json` 挂载；工具集按角色收敛（deny 规则不可绕过）
- **人类闸门**：子代理 `ask_user_question` → 侧边栏 blocked 标记 + 通知；用户手动接管（ESC 打断后输入）→ 启发式检测自动暂停/归还 master 管理
- **选择题选择器**：`multi: true` 的问题直接渲染成可勾选列表（空格逐行切换、`a` 全选、回车确认、esc 拒绝，实时显示已选数量），末行固定为自由输入；`allowOther: false` 则纯选择。RPC 模式 / 旧版 pi 自动回退到「输入编号」的文本路径
- **阻塞式对话框会把 pane 标成 blocked**：pi 的 `ui_prompt_start` / `ui_prompt_end` 覆盖真正阻塞的 `ctx.ui` 对话框（`select` / `confirm` / `input` / `editor`），所以**任何扩展**弹出这类对话框时该 pane 会标 blocked 并发 `herdr:blocked` 边沿；嵌套闸门自动合并，ask 工具不再需要 5s 刷新心跳。`custom` 有意排除——pi 也用它跑常驻 overlay（pier 自己的窄格静帧 overlay 从不调用 `done()`），早先的错误归类会让一个正在工作的 pane 整场会话都标成 blocked
- **角色闸门提前终止**：被拒绝的 worker 工具调用返回 `terminate`，整批都是 terminating 时不再多跑一轮模型
- **转写卡片**：pier 自己的会话条目（todo 编辑、子代理/终端注册表、角色清单、软审批）与提醒消息渲染为紧凑卡片，不再是裸 JSON——entry/message renderer，不依赖 pi-tui
- **焦点热力布局**：聚焦 pane 原地放大（0.72 目标），blocked / ask / working / idle 按权重分大小，多余 pane 自动压成 title 条
- **隔离工作树（`isolate`）回收有明确归属**：只回收本会话自己登记过的工作树，且**当前进程所在目录永不作为候选**——此前按 `refs/heads/pier/` 前缀匹配会删掉并行会话正在使用的工作树。清扫本会话未登记的分支需显式开启 `PIER_ISOLATE_SWEEP_ORPHANS=1`
- **运维面板 + 侧边栏视图（herdr 0.9）**：`herdr plugin pane open --plugin pier.workbench --entrypoint dashboard` 打开实时 pane/tab/agent 看板（角色、状态、todo 进度）；插件还注册一个 `Pier` 侧边栏 agent 视图：不做 harness 过滤（任何 agent 都显示），只把 attention 高的排前面
- **长任务生命周期（01a03c0d 复盘）**：观察超时改「无活动预算」（working 心跳续命，>10min 健康任务不再误杀）；follow_up 以 steer 间隙投递（补充契约秒级到达，不再排队整个 run）；GC 等结算通知送达再回收 pane；接管判定先归因机器注入；台账 via 标记 + closed 行 outcome 继承 + 僵尸 running 清扫；SUBS 快照哈希门控。可调：`PIER_SUBAGENT_TIMEOUT_MS`（无活动毫秒数）、`PIER_SETTLEMENT_WINDOW_MS`（ms）、`PIER_OBSERVATION_WINDOW_MS`（ms）
- **结算通知折叠**：后台子代理结算不再攒到 run 结束洪水回填——turn 间隙注入，最多 3 条逐条展示、其余折叠指路

## 安装

### 环境要求

- Node ≥ 22
- pi ≥ 0.86.0（`@earendil-works/pi-coding-agent`）——动态工具集（transcript 持久化的 `setActiveTools` delta）与角色切换依赖此版本
- herdr ≥ 0.9.0（macOS / Linux / Windows；Windows 为 preview beta）

### 一键安装（推荐）

无需克隆仓库，直接用 npm 包运行：

```sh
npx pier-setup@latest            # 用户模式：pi install npm:pi-pier + herdr plugin install
npx pier-setup@latest version    # 本地 vs npm latest（installer / pi-pier / herdr 插件）
npx pier-setup@latest update     # 原地刷新两半区（不先卸载）
npx pier-setup@latest uninstall  # --purge 连 boot-config.json 一起删

npm i -g pier-setup              # 或全局安装后：pier-setup / version / update
```

钉 `@latest`，避免 npx 用到缓存的旧安装器。克隆仓库后 `npm install` 会链上
`node_modules/.bin/pier-setup`，因此仓库根下 `npx pier-setup` 跑的是本地 `./install.mjs`。

开发模式仍需克隆仓库：

```sh
git clone https://github.com/July24/pier && cd pier
node install.mjs install --dev   # 本地路径 pi install + herdr plugin link，改码即生效
node install.mjs version --dev
node install.mjs update --dev    # 只重写 boot-config；代码请自己 git pull
```

脚本自动校验环境（node / pi / herdr 版本）、探测 pi 的 node 与 cli.js 绝对路径、
生成 boot-config.json（用户模式落 herdr 插件配置目录，重装不丢），并注册两半区。

`update` 会跑 `pi update npm:pi-pier`（失败则 `pi install`）和
`herdr plugin install … --yes`，然后重写 boot-config。发行规格可用
`--pi-spec=` / `--herdr-spec=` 覆盖。`pier-setup --help` 列出全部命令。

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

### 作用域（pi 扩展实际改了什么）

装上 `pi-pier` 后，**裸跑 pi 也会改会话**，不是 herdr 休眠插件：

| 表面 | 裸 `pi` | herdr 内 |
|---|---|---|
| `todo_write`、`/todos`、widget、反冻结、停工提醒 | 生效 | 生效 |
| `ask_user_question` | 生效 | 生效 + blocked 标记 |
| 隐藏注入（`before_agent_start` 读钩；停工 reminder） | 生效 | 生效 |
| `subagent`、`terminal` | **不注册** | 生效 |
| `/locks`、写锁、slim-frame、窗格标题、pipe | 不加载 | 生效 |
| `setActiveTools` 角色可见层 | 不加载 | 生效（herdr master） |

会话 JSONL 自定义类型（`pi-herdr.todo-edit`、`.subs`、`.terminals`、`.todo-read`、`.todo-reminder` 等）即使没有 herdr 也会随 `/resume` 回放。

### 插件冲突

pi 对同名 tool/command **后写覆盖**，event listener **累加**。两套 todo 或 subagent 会各写各的 JSONL，表现为列表丢失、问答框不对、spawn 开了别人的 pane。

**不要并装**（同名覆盖）：

- [`@nguyenquangthai/pi-todo`](https://pi.dev/packages/@nguyenquangthai/pi-todo) — `todo_write` + overlay
- [`@josephyoung/pi-ask-user-question`](https://pi.dev/packages/@josephyoung/pi-ask-user-question) — `ask_user_question`
- [`pi-herdr-subagents`](https://pi.dev/packages/pi-herdr-subagents) — 同名 `subagent` + herdr pane

**软冲突**（两套编排/注入，模型会「自己又说一轮」）：

- [`@tintinweb/pi-subagents`](https://pi.dev/packages/@tintinweb/pi-subagents)（`Agent`）
- [`@minhduydev/pi-subagents`](https://pi.dev/packages/@minhduydev/pi-subagents)（`task`）
- 其它调用 `setActiveTools`、`ui.custom` overlay、`before_agent_start`、或 `sendUserMessage`/`sendMessage` followUp 的扩展

**设计上可共存：** herdr 官方 `herdr:pi` 上报器。不要卸——pier 发 `herdr:blocked`，由它当生命周期权威。

- **herdr 中用其他 agent（claude code / codex 等）**：不含 pi pane 的 tab 不参与
  热力布局；blocked 通知只发给 pi；主 tab 自动引导可用 boot-config 的
  `autoBootstrap: false` 关闭。

### 引导配置（workbench 半区）

master 主 tab 引导需要本机 node / pi 路径：`node install.mjs` 自动生成；手动可复制模板
`packages/pier-workbench/scripts/boot-config.example.json`（含 macOS / Windows 双平台占位）。
用户模式配置在 `herdr plugin config-dir pier.workbench`；开发模式在 `packages/pier-workbench/scripts/boot-config.json`。

### 使用

1. 在 herdr workspace 里开 pane 跑 pi（pane 内 `pi`），扩展检测 `HERDR_ENV` 自动开始上报
2. 模型可调用 `todo_write`（窗格头实时投影）、`subagent`（spawn / list / send / interrupt / resume）、`terminal`（open / send / read / signal / close / list）
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
npm test          # node --test，809 项单测（规划器 / todo 重放 / 反冻结陈旧度 / 会话尾 / GC / 生命周期 / 渲染器 / 选择题选择器 / 子代理输出 / jev 决策层：诊断门·结算排序·摘录选窗）
```

## 配置与环境变量

运行策略与超时参数由 `runtime-policy.ts` 集中管理（终端读取上限由 `terminal.ts` 管理）。除特殊标明外，时间单位均为毫秒（ms）：

| 环境变量 | 默认值 | 单位 | 作用 |
|---|---|---|---|
| `PIER_SUBAGENT_TIMEOUT_MS` | `600000` | ms | 子代理无活动超时预算（超时强行终止） |
| `PIER_SETTLEMENT_WINDOW_MS` | `60000` | ms | 结算通知窗口、机器注入宽限期及接管空闲判定阈值 |
| `PIER_OBSERVATION_WINDOW_MS` | `30000` | ms | 结算后观察窗口（超时前自动消费） |
| `PIER_FOREGROUND_PATIENCE_MS` | `300000` | ms | 前台等待耐心阈值（超时自动切入后台） |
| `PIER_GC_TICK_MS` | `30000` | ms | 子代理垃圾回收轮询间隔 |
| `PIER_POLL_INTERVAL_MS` | `30000` | ms | 子代理状态观测轮询间隔 |
| `PIER_READY_TIMEOUT_MS` | `90000` | ms | 子代理 pane 管道就绪等待（指数退避；pane 已退出则立刻失败并附上它的最后输出） |
| `PIER_SESSION_TTL_SECONDS` | `600` | 秒 | 子代理进程退出后会话保留 TTL（超时清理） |
| `PIER_GIT_TIMEOUT_MS` | `10000` | ms | Git 命令超时（worktree 创建、diff 汇总、清理） |
| `PIER_FOCUS_POLL_MS` | `1500` / `0` | ms | 焦点采样间隔（`0` 关闭）。Herdr <0.9.1 默认 1500ms；0.9.1+ 默认 0（事件驱动） |
| `PIER_TERM_READ_MAX` | `8000` | 字符 | 终端单次读取缓冲区字符上限 |
| `PIER_TERM_IDLE_MS` | `1800000` | ms | 终端闲置多久后提醒一次 |
| `PIER_TODO_GRACE_MS` | `30000` | ms | 未完成 todo 提醒前的静默宽限 |
| `PIER_TRACE` | – | 开关 | 把诊断信息（工具渲染器、被吞掉的异常）写到 stderr |
| `PIER_JEV_ENABLE` | `0` | 开关 | jev 决策层(TypeSafe System One 分类)总开关;逐点 fail-open,详见 `docs/rfc-jev-integration.md` |
| `PIER_JEV_LOG` | `0` | 开关 | 写 `efficiency-logs/jev.jsonl`(只记元数据与 hash,不记明文) |
| `PIER_JEV_API_KEY` | – | – | API key;优先级 env > 配置 `jev.apiKey` > `TYPESAFE_API_KEY` |
| `PIER_JEV_MODEL` | `jev-1.13.0` | – | 钉住的版本化模型 id(别名漂移会破坏校准阈值) |
| `PIER_JEV_TIMEOUT_MS` | `2000` | ms | 单次 jev 调用总预算(AbortController 硬杀) |
| `PIER_JEV_MIN_CONFIDENCE` | `0.6` | – | Choice/Score 答案采纳的最低置信度 |
| `PIER_JEV_BASE_URL` | – | – | API 根地址覆盖(中转/网关) |

**命名**：`PIER_*` 是 pier 选项的规范前缀；历史写法 `PI_HERDR_*` 仍作为别名被读取（空值视为未设置）。
交给子进程的**契约**名保持不变（`PI_HERDR_SUBAGENT`、`PI_HERDR_ROLE_MANIFEST`、`PI_HERDR_TUI`、
`PI_HERDR_META_KEY`）——改名会让正在运行的 worker 与父进程对不上。
`/pier-config doctor` 会列出每个选项的生效值与来源，以及本会话被有意吞掉的异常。

**焦点热力**：herdr 0.9.0 把鼠标焦点放在客户端解析，插件收不到 `pane.focused`，因此每个 pane
采样自己 tab 的 `layout.export → focused_pane_id` 再重放 workbench 事件。0.9.1+ 原生派发
`pane.focused`，轮询默认关闭。`PIER_FOCUS_POLL_MS` 可覆盖；`PIER_WORKBENCH_ROOT` 指向迁移后的插件目录（未设置时使用 workbench 钩子记录在 `~/.pi/agent/herdr-pi/workbench-root` 的插件目录）。

## 设计原则

- **会话 JSONL 是唯一权威**：todo / 委派 / 注册表全部回放自会话分支，重启与分支切换正确
- **事件驱动，不轮询**：状态经 herdr 事件订阅（`pane.agent_status_changed` / `pane.closed`）推送，仅事件触发时拉一次快照
- **零位置迁移**：herdr BSP 布局拓扑创建时定死，pier 只调 split ratio——pane 位置永不动，大小按优先级重算
- **尽力而为的投影层**：上报失败静默，绝不影响 pi 主流程

## License

MIT

---

> 💡 **开发说明**：`.gitignore` 目前已入库跟踪。注意 `packages/pier-workbench/scripts/boot-config.json` 属于本机专属配置（模板见 `.example.json`）；`docs/research/` 内为本地调研文档，已被 `.gitignore` 忽略。
>
> **命名约定**：品牌名 **pier**（仓库/包/插件），运行时协议标识保留 **`pi-herdr`** 前缀（`.pi-herdr/roles/` 目录、`pi-herdr.subs` 等会话 custom 条目、`~/.pi/agent/herdr-pi/roles/` 用户目录）——它们随用户会话/配置文件持久化，改动会破坏既有数据，属兼容层。
