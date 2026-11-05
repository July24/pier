<div align="center">

# pier · pi × herdr-core 工作台融合

[English](README.md) · **中文**

**pier** = **pi** × h**erdr** 的融合体（码头/桥，对接、停泊、分发）。

[pi](https://pi.dev/)（`@earendil-works/pi-coding-agent`）是 coding agent 载体；[herdr-core](https://herdr.dev/)（`hc`）运行常驻终端，**Herdr app** 把它们显示为 space / tab / pane。pier 补上 pi 刻意不内置的两项能力——**todo list 闭环**与**交互式子代理**——并以 core 终端为视觉与交互底座。app 侧不需要任何 mod：Herdr app 自带侧边栏与提醒就够了。

</div>

---

## 是什么

pier 是**一个 pi 扩展**，外加它与两个外部程序协作：

| 部件 | 包 | 作用 |
|---|---|---|
| **pi 扩展** | `packages/pier-ext`（npm: [`pi-pier`](https://www.npmjs.com/package/pi-pier)，[pi.dev 市场](https://pi.dev/packages/pi-pier)） | 在 pi 会话里注入 `todo_write` / `subagent` / `terminal` / `ask_user_question` 工具，并经 herdr-core 启动/读取 worker 终端 |
| **herdr-core** | `hc` ≥ 0.1.16 | 终端服务器：`terminal.run/read/wait/send/keys/interrupt/label/kill/rm` 与状态/事件，走 `HC_TERMINAL_SOCKET` |
| **Herdr app** | `herdr-app`（可选） | 把 core 终端显示为 space/tab/pane；自带侧边栏展示 agent 并做 blocked 提醒 |

### 架构（谁和谁说话）

- pier 通过自己继承的终端 socket 与 core 通信（`HC_TERMINAL_SOCKET`，自身地址 `HC_TERMINAL_ID`）。
- 一个 worker 就是一次 `terminal.run {argv, cwd, env, parent: master, noNotify: true}`（D140）。core 启动程序；不带放置 label 时 app 把它列为 **master 下的子 agent**（peek 查看或直接输入；关闭 master 即一并结束）。只有显式 `tab` 才加 `herdr.space`/`herdr.tab` label：app 把它挂成该 tab 的非焦点 pane，**新的** `herdr.tab` id 会自动新建 tab——pier 从不调用 app 命令，也不做放置位置计算。
- worker 的程序随 master 程序结束而结束（`die_with_parent`）；pier 用 `terminal.kill` + `terminal.rm` 收尾。
- **状态只来自 pi 原生 OSC 7501 上报**，core 存储、app 展示。pier 从不写终端状态。唯一缺口是 `ask_user_question`：它是 `ui.custom` overlay，pi 不为其上报状态，所以 pier 在弹窗打开期间上报 `blocked`，关闭时按当前活动状态回写 `working`/`idle`。
- 元数据放在**终端 label**，且只保留 pier 内部有读方的：`pier.session`（worker 自己的会话文件）、`pier.todo`（worker todo 摘要，master 重建摘要时读取）、`pier.lock.<hash>`（写锁 beacon）。
- master ↔ worker 的私有消息继续走 **pipe-channel**（每对进程一条本地专用 socket），绝不注入 PTY。core 的 parent note 对 worker 关闭（`noNotify: true`）——PTY 输入属于人类（D45）。

### 核心能力

- **todo 闭环**：`todo_write` 全量替换语义、会话 JSONL 权威、分支正确回滚；`/todos` 命令（含 unblock）与常驻状态 widget 展示进度。列表会镜像到 `pier.todo` 终端 label，仅用于 master 重建 worker 摘要；不再有窗格标题投影。
- **todo 反冻结**：全完成列表 ≥6 轮未写 → 读钩复读改为改写警告；≥1h 未写 → 归档——先给一次带旧条目参照的重写窗口，无视后终态通知并清空列表（rm 落 JSONL，空守卫接管，多步工作必须重建清单）；`/todos` 永远可查历史，会话 JSONL 权威不动
- **交互式子代理**：每个子代理 = 独立 core 终端里的隔离 pi 会话（独立上下文窗口）；app 把它列在 master 下（仅 `tab` 时为 pane），**人类可随时 peek 该终端直接对话**（修 bug、回答 ask_user_question）。blocked 状态经 pi 原生 OSC 7501 到达 app。
- **委托身份一等公民**（D111）：spawn 时经 `PI_HERDR_DELEGATION` 把委托上下文（父终端/父会话/taskId/任务）下发 worker，由 spawn env 与会话自身首帧条目回放；worker 系统提示注入 `pier-delegation` 段（身份 + 统一交付契约），首帧渲染「⟵ delegated by master …」卡片
- **任务 slug**（D112）：spawn 分配任务 slug（冲突加序号），工具输出一律 `slug@paneId`，`agentId` 接受 slug/终端 id/组合形式（revive 换终端后按 slug 兜底）。后台 worker 运行期间 master 的 bash 若 sleep ≥60s，结果会附一句指向 `subagent wait` 的提示（D125/D144；此前的 `report_progress` 工具一次都没被调用过，已删除）
- **统一状态 widget**（D113/D114）：常驻 widget 一行一 agent——自己一行 `▶ 当前条 ✓d/n`，每个 running 子代理一行 `↳ slug ▶ 当前条 ✓d/n`（blocked 显示任务+原因，settled 不占行；自己的清单全部完成时直接隐藏，不再只剩一个 `✓N/N`）；worker `todo_write` 经 pipe 实时推送全量清单（事件驱动零轮询），`/pier-tree` 把完整委托树（自己 + 各 worker 全量 todo + settled 节点）打开为 **pi 内 overlay**（`ui.custom`，`esc`/`q` 关闭，打开期间实时刷新；裸 pi / RPC 模式回退为 pane 内通知）
- **子代理输出预览**：`subagent(action: "output", agentId)` 返回后台子代理自上次调用以来的新输出——内存中的 per-terminal 游标经 core `terminal.read` 计算增量，结果带状态、revision、截断与 `restart` 标记（缓冲回卷/清屏），master 不必等到结算就能发现卡住的 worker。worker 完成后以完整 transcript 终稿替代终端里有损的渲染副本，之后的结算通知只指向那次交付、不再重复全文（D124）
- **阻塞等待子代理**（D144、D151）：`subagent(action: "wait", agentId?)` 阻塞到某个 worker 结算、失败、关闭或开始等人工，并把那条通知（含终稿）作为工具结果返回；通知从回合间隙缓冲中取出，不会再投递一次。等待单个 worker 时，其他运行中的 worker 有通知也会返回，并点名仍在运行的目标。master 无事可做时用它代替 `sleep` 与反复的 `list`/`output` 轮询
- **终端命令带退出码**（D145）：`terminal(action: "send", text, wait: true)` 由 pier 自己追加带 nonce 的退出哨兵，返回退出码与命令输出；手写哨兵（及其回显陷阱）只剩不会结束的输出需要（服务的 "listening on"）
- **软锁防争抢**：写路径把锁 beacon 作为 `pier.lock.<hash>` label 发布到各自终端；跨终端冲突时警告（默认）或阻止（`PI_HERDR_WRITE_LOCK=1`）。警告列出全部持有者；`/locks` 是人类视图，`hc get <terminal> --json` 暴露原始 label
- **整棵树同一模型**：worker 沿用 master 当前的模型（包括 `/model` 切换后的）；不再有角色档案与按 worker 的工具闸门（D146）
- **人类闸门**：子代理 `ask_user_question` → 终端上报 blocked，app 据此展示（并按自身规则提醒）；答案作为工具结果返回。不再做启发式的「人工接管」检测。
- **选择题选择器**：`multi: true` 的问题直接渲染成可勾选列表（空格逐行切换、`a` 全选、回车确认、esc 拒绝，实时显示已选数量），末行固定为自由输入；`allowOther: false` 则纯选择。`tab` 把选择器折叠成两行横条，把屏幕让给上方对话记录，回看完再按 `tab` 展开，光标与勾选保持不变；折叠期间只有 `tab` 生效，回车/esc 不会盲答或拒绝。RPC 模式 / 旧版 pi 自动回退到「输入编号」的文本路径
- **阻塞式对话框上报 blocked**：pi 原生 OSC 7501 上报覆盖**任何扩展**的 `select` / `confirm` / `input` / `editor` 与权限弹窗；pi 1.5 起 pier 的 `ui.custom` ask 选择器也以 `blocked: { kind: "question" }` 打开、由 pi 上报。pier 自己不写任何状态。
- **转写卡片**：pier 自己的会话条目（todo 编辑、子代理/终端注册表、委托身份）与提醒消息渲染为紧凑卡片，不再是裸 JSON——entry/message renderer，不依赖 pi-tui
- **隔离工作树（`isolate`）回收有明确归属**：只回收本会话自己登记过的工作树，且**当前进程所在目录永不作为候选**——此前按 `refs/heads/pier/` 前缀匹配会删掉并行会话正在使用的工作树。清扫本会话未登记的分支需显式开启 `PIER_ISOLATE_SWEEP_ORPHANS=1`
- **长任务生命周期（01a03c0d 复盘）**：观察超时改「无活动预算」（working 心跳续命，>10min 健康任务不再误杀）；follow_up 以 steer 间隙投递（补充契约秒级到达，不再排队整个 run）；GC 等结算通知送达再回收终端；台账 via 标记 + closed 行 outcome 继承 + 僵尸 running 清扫；SUBS 快照哈希门控。可调：`PIER_SUBAGENT_TIMEOUT_MS`（无活动毫秒数）、`PIER_SETTLEMENT_WINDOW_MS`（ms）、`PIER_OBSERVATION_WINDOW_MS`（ms）
- **结算通知折叠**：后台子代理结算不再攒到 run 结束洪水回填——turn 间隙注入，最多 3 条逐条展示、其余折叠指路

### 迁移中删除的功能

TUI 后端一次性切换，不保留双后端：

- **重启后 resume**：core/app 重启后不再重建 worker 终端。`subagent(action: "resume")` 仍可用——它用 `pi --session <file>` 新开一个终端。
- **人工接管检测**（D94）：不再启发式检测「ESC 打断后输入」。
- **热力布局 / 焦点重排**：不再按焦点缩放 pane，也不再计算 spawn 放置位置；pane 由 app 按自身规则放置。
- **`/dashboard`、app 侧插件与侧边栏 token 行**：整个 app 侧插件、`display_agent` / `pi-ask` / `pi-parent` / `pi-task` token 与窗格标题投影全部删除。`/pier-tree` 改为在 pi 内以 overlay 渲染。
- **80 字符窗格标题截断**与 `agentExplain` 随标题通道一并删除。

**最后一个兼容 Herdr TUI 的版本是 0.4.3**（npm；源码见 git tag `tui-final`）。仍在用 Herdr TUI 请固定 `npx pier-setup@0.4.3`。
从旧版升级：`install` / `update` / `uninstall` 会检测旧的 herdr 插件 `pier.workbench` 并询问是否卸载
（`--remove-legacy` / `--keep-legacy` 预先作答；非交互运行默认保留并打印 `herdr plugin …` 手动命令）。

## 安装

### 环境要求

- Node ≥ 22
- pi ≥ 1.5.0（`@earendil-works/pi-coding-agent`）——原生 OSC 7501 程序状态上报是唯一状态源
- herdr-core ≥ 0.1.16（`hc`）——`curl -fsSL https://releases.herdr.dev/core/install.sh | sh`
- Herdr app（可选）——显示 core 终端；没有它 pi 照常运行、pier 照常 spawn worker，只是看不到窗口

### 一键安装（推荐）

无需克隆仓库，直接用 npm 包运行：

```sh
npx pier-setup@latest            # 用户模式：pi install npm:pi-pier（预检 node / pi / hc）
npx pier-setup@latest version    # 本地 vs npm latest（installer / pi-pier / herdr-core）
npx pier-setup@latest update     # 原地刷新扩展（不先卸载）
npx pier-setup@latest uninstall

npm i -g pier-setup              # 或全局安装后：pier-setup / version / update
```

钉 `@latest`，避免 npx 用到缓存的旧安装器。克隆仓库后 `npm install` 会链上
`node_modules/.bin/pier-setup`，因此仓库根下 `npx pier-setup` 跑的是本地 `./install.mjs`。

开发模式仍需克隆仓库：

```sh
git clone https://github.com/July24/pier && cd pier
node install.mjs install --dev   # 本地路径 pi install，改码即生效
node install.mjs version --dev
node install.mjs update --dev    # 仅重新校验环境与版本；代码请自己 git pull
```

脚本自动校验环境（node / pi / `hc` 版本；`herdr-app` 只作为信息行）并注册扩展。
pi 中 pier 只能从一个来源注册：`install`/`update` 会自动清理旧的 `git:github.com/July24/pier`
注册；若 pier 已从其它来源注册（如先 `--dev` 装了本地 checkout 再跑用户模式），则直接退出（exit 1，
不做任何改动）并给出要执行的 `pi remove …`。`version` 显示 pi 实际加载的来源。
`update` 会跑 `pi update npm:pi-pier`（失败则 `pi install`）；发行规格可用 `--pi-spec=` 覆盖。
`pier-setup --help` 列出全部命令。herdr-core 与 Herdr app 是独立程序：用 `hc update`
升级 core，安装器不碰它的配置。

### 手动安装（等价步骤）

```sh
# herdr-core（一次）
curl -fsSL https://releases.herdr.dev/core/install.sh | sh

# pi 侧扩展（任选其一；npm 源 = 用户模式推荐，git 源 = 跟随仓库最新，本地路径 = 开发模式）
pi install npm:pi-pier                # 用户模式（npm 发布版，自动出现在 pi.dev/packages 市场）
pi install git:github.com/July24/pier # 用户模式（跟随 main 最新）
pi install ./packages/pier-ext        # 开发期
```

扩展在非 herdr-core 终端下自动降级（详见下节「作用域」）。

### 作用域（pi 扩展实际改了什么）

装上 `pi-pier` 后，**裸跑 pi 也会改会话**，不是 core 休眠插件：

| 表面 | 裸 `pi` | herdr-core 终端内 |
|---|---|---|
| `todo_write`、`/todos`、widget、反冻结、停工提醒 | 生效 | 生效 |
| `ask_user_question` | 生效 | 生效 + 弹窗期间上报 blocked |
| 隐藏注入（`before_agent_start` 读钩；停工 reminder） | 生效 | 生效 |
| `subagent`、`terminal` | **不注册** | 生效 |
| `/locks`、写锁、slim-frame、pipe | 不加载 | 生效 |

检测依据是 core 注入的 `HC_TERMINAL_ID` + `HC_TERMINAL_SOCKET`。会话 JSONL 自定义类型
（`pi-herdr.todo-edit`、`.subs`、`.terminals`、`.todo-read`、`.todo-reminder` 等）即使没有 core
也会随 `/resume` 回放。

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

**状态归属：** pi 原生 OSC 7501 上报是唯一状态源。pier 不写终端状态，因此不要为同一个终端再加第二个写 OSC 7501 的上报器。
其它跑在 core 终端里的 agent 对 app 可见，但 pier 不跟踪它们。

### 使用

1. 启动 herdr-core 并打开一个终端（`hc run --bg pi`，或 Herdr app 的「新建终端」），在终端里跑 `pi`；扩展检测到 `HC_TERMINAL_ID` / `HC_TERMINAL_SOCKET` 后开始与 core 通信
2. 模型可调用 `todo_write`（进度显示在常驻 widget 与 `/todos`）、`subagent`（spawn / wait / list / send / interrupt / resume / output / help）、`terminal`（open / send [`wait: true`] / wait / read / signal / close / list）
3. 每个子代理 = 独立 core 终端，app 把它列在 master 下并随 master 关闭而结束；显式 `tab` 时作为该 tab 的非焦点 pane 显示，`tab` 名第一次出现时 app 自动建 tab
4. 没有重启恢复：core 在 app 重启后保留终端，但 core 停止则 worker 消失。父 pi 会话用 `/resume` 恢复；已完成的 worker 用 `subagent(action: "resume", taskId)` 复活
5. `/pier-tree` 以 pi 内 overlay 打开委托树

## 仓库结构

```
packages/
  pier-ext/        # pi 扩展（npm: pi-pier）：todo/subagent 工具、core 客户端、vocab 权威
docs/              # 安装手册、配置总览、迁移 RFC
```

## 测试

```sh
npm install --ignore-scripts
npm test          # typecheck + node --test（todo 重放 / 反冻结 / GC / 生命周期 / 渲染器 / 选择题选择器 / 子代理输出 / jev 决策层）
```

## 配置与环境变量

运行策略与超时参数由 `runtime-policy.ts` 集中管理（终端读取上限由 `terminal.ts` 管理）。除特殊标明外，时间单位均为毫秒（ms）：

| 环境变量 | 默认值 | 单位 | 作用 |
|---|---|---|---|
| `PIER_SUBAGENT_TIMEOUT_MS` | `600000` | ms | 子代理无活动超时预算（超时强行终止） |
| `PIER_OBSERVATION_WINDOW_MS` | `4000` | ms | 子代理一轮结束后的结算去抖（期间重新进入 working 即取消）；transcript 已有终稿时跳过 |
| `PIER_FOREGROUND_PATIENCE_MS` | `300000` | ms | 前台等待耐心阈值（超时自动切入后台） |
| `PIER_GC_TICK_MS` | `30000` | ms | 子代理垃圾回收轮询间隔 |
| `PIER_POLL_INTERVAL_MS` | `30000` | ms | 无 core 事件时的兜底复查间隔；结算由 `events.subscribe` 子终端订阅驱动 |
| `PIER_READY_TIMEOUT_MS` | `90000` | ms | 子代理 pipe 就绪等待（指数退避；终端已退出则立刻失败并附上它的最后输出） |
| `PIER_SESSION_TTL_SECONDS` | `600` | 秒 | 子代理进程退出后会话保留 TTL（超时清理） |
| `PIER_GIT_TIMEOUT_MS` | `10000` | ms | Git 命令超时（worktree 创建、diff 汇总、清理） |
| `PIER_TERM_READ_MAX` | `8000` | 字符 | 终端单次读取缓冲区字符上限 |
| `PIER_TERM_IDLE_MS` | `300000` | ms | 第二次终端清理提醒的闲置阈值（第一轮在回合结束时对本回合用过的终端提醒） |
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
core 自身身份变量（`HC_TERMINAL_ID`、`HC_TERMINAL_SOCKET`）由 core 注入，pier 只读。
`/pier-config doctor` 会列出每个选项的生效值与来源，以及本会话被有意吞掉的异常。

**状态与 label**：状态只来自程序自己发出的 OSC 7501——pi 原生上报，pier 从不合成状态。
元数据是 `pier.*` 下的终端 label（`pier.session`、`pier.todo`、`pier.lock.<hash>`），
用 `hc get <terminal> --json` 查看。Herdr app 自行渲染侧边栏与提醒；app 侧没有 mod，
也不再存在 `PIER_WORKBENCH_ROOT`。

**迁移设计**：完整切换方案（实测 core 事实、删除清单、映射表）见
**[docs/rfc-core-app-migration.md](docs/rfc-core-app-migration.md)**。

### 效率机制（D100–D103，默认关闭）

三个省 token 机制**默认全部关闭**，可逐个安全试用：

- **ObservationPack（观察打包）** —— 大体量工具结果在前 `fullSends` 次请求后投影为占位符，`obs_recall` 分页回捞（会话 JSONL 始终保留原文）。
- **EPR（证据保真提炼）** —— 超长诊断日志（bash 测试/构建）在进程内提炼为逐字节验真的证据 receipt；替换前原文强制归档、始终可读。
- **OCC（机会式上下文压缩）** —— `todo_write` 完成边界在 KV-cache 成本模型下驱动 pi 原生压缩，未完成任务跨越压缩自动续跑。

```bash
PI_HERDR_OBS_PACK_ENABLE=1 PI_HERDR_OBS_PACK_LOG=1 pi   # 从这里开始
```

完整快速开始、`efficiency-logs/*.jsonl` 看什么、回滚步骤与反馈模板见
**[docs/efficiency-trial.md](docs/efficiency-trial.md)**；jev 决策层的配置键（`PIER_JEV_*`）
可经 `/pier-config show efficiency` 在会话内查看。

**出处**：三个机制的思路与命名源自 NVIDIA 的 [SoL-Pi](https://github.com/NVlabs/SoL-Pi)
（[论文](https://arxiv.org/abs/2609.20519) · [博客](https://nvlabs.github.io/SoL-Pi/)）——
其通过规模化自动研究循环发现的四个 harness 级效率机制中的三个（第四个 Action Fusion 未采纳）。
pier 在自有栈上独立实现，并叠加了 jev 决策层（诊断门 / 摘录选窗 / 结算归因的小型
System One 分类，见 [rfc-jev-integration.md](docs/rfc-jev-integration.md)）
与四平面效率配置 + 分机制 JSONL 遥测。

## 设计原则

- **会话 JSONL 是唯一权威**：todo / 委派 / 注册表全部回放自会话分支，重启与分支切换正确
- **事件驱动，不轮询**：状态经 core `events.subscribe`（`status` / `turn` / `finished` / `labels`）推送；仅事件触发时拉一次快照，收到 `missed` 事件时重新对齐
- **app 侧零 mod**：pier 只通过 core 写终端与 label，Herdr app 按自身规则展示；`/pier-tree` 在 pi 内渲染，不占 pane
- **PTY 输入属于人类**：机器间消息走 pipe-channel，worker 终端的 core parent note 关闭（D45）
- **尽力而为的元数据层**：label/上报失败静默，绝不影响 pi 主流程

## License

MIT

---

> 💡 **开发说明**：`.gitignore` 目前已入库跟踪。`docs/research/` 内为本地调研文档，已被 `.gitignore` 忽略。
>
> **命名约定**：品牌名 **pier**（仓库/包/插件），运行时协议标识保留 **`pi-herdr`** 前缀（`.pi-herdr/` 目录、`pi-herdr.subs` 等会话 custom 条目、`~/.pi/agent/herdr-pi/` 用户目录）——它们随用户会话/配置文件持久化，改动会破坏既有数据，属兼容层。
