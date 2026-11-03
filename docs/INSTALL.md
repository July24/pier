# 安装与使用手册

pier 的安装：一个 pi 扩展 + 两个外部程序（herdr-core / Herdr app）。
环境要求：Node ≥ 22、pi ≥ 1.5.0（原生 OSC 7501 上报）、herdr-core `hc` ≥ 0.1.16。
Herdr app 可选（只负责显示终端）。**最后一个兼容 Herdr TUI 的版本是 0.4.3**（git tag `tui-final`）。

## 0. 一键安装（推荐）

```sh
npx pier-setup@latest            # 用户模式
npx pier-setup@latest version    # 查看本地 / npm latest
npx pier-setup@latest update     # 原地刷新（不先卸载）

git clone git@github.com:July24/pier.git && cd pier
node install.mjs                 # 用户模式（默认 npm:pi-pier）
node install.mjs install --dev   # 开发模式（本地路径，改码即生效）
node install.mjs version
node install.mjs update          # 用户模式：pi update / install
```

脚本流程：

1. 校验 node ≥ 22、pi ≥ 1.5.0、`hc` ≥ 0.1.16（缺失给安装指引并退出：
   `curl -fsSL https://releases.herdr.dev/core/install.sh | sh`）；
2. 探测 `herdr-app`，只打印一行提示，**不作为硬依赖**；
3. 检测旧的 herdr TUI 插件 `pier.workbench`（0.4.3 及以前），询问是否卸载（`herdr plugin uninstall`，本地 link 则 `unlink`）；
   `--remove-legacy` / `--keep-legacy` 预先作答，非交互运行默认保留；
4. 注册 pi 扩展（见下表）。

| | 用户模式（默认） | 开发模式（`--dev`） |
|---|---|---|
| pi 扩展 | `pi install npm:pi-pier` | `pi install ./packages/pier-ext` |
| 查看版本 | `npx pier-setup@latest version` | `node install.mjs version --dev` |
| 更新 | `npx pier-setup@latest update`（`pi update`，不先卸载） | 仅重新校验环境与版本（本地路径是活的） |
| 卸载 | `npx pier-setup@latest uninstall` | 同左 |

发行规格覆盖：`--pi-spec=`（npm 发布或 fork）。
安装器**不安装、不升级、不配置** herdr-core 与 Herdr app：core 用 `hc update` 升级，
app 从 <https://herdr.dev/> 安装。

## 1. 手动安装：herdr-core 与 Herdr app

```sh
# herdr-core（必需）
curl -fsSL https://releases.herdr.dev/core/install.sh | sh
hc --version                       # 应 ≥ 0.1.16

# Herdr app（可选，显示终端）
# 从 https://herdr.dev/ 安装（基线实测 herdr-app 0.1.11）
```

终端与状态都归 core：pier 通过 `HC_TERMINAL_ID` / `HC_TERMINAL_SOCKET` 找到它。
关掉 app 不影响 core 里的终端；core 停止则终端与 worker 一起结束。

## 2. 手动安装：pi 侧扩展（`pier-ext` / `pi-pier`）

```sh
# A. npm 源（用户模式）
pi install npm:pi-pier

# B. git 源（用户模式；根 package.json 的 pi 字段指向扩展）
pi install git:github.com/July24/pier

# C. 本地路径（开发期；注册进 settings.packages，随包自动加载）
pi install ./packages/pier-ext

# D. 单次加载（不持久）
pi -e ./packages/pier-ext/src/index.ts

# E. 开发期热重载（D87 姿势）：--expose-internals 是 node 旗标（detectExposeInternals 读
#    process.execArgv），必须放在 pi 的 cli.js 之前；与 PI_HERDR_HMR=1 缺一不可，否则零 watcher
PI_HERDR_HMR=1 node --expose-internals "$(readlink -f "$(command -v pi)")" -e ./packages/pier-ext/src/index.ts
```

卸载：`pi remove <同安装源>`。

## 3. 使用

1. 启动 herdr-core，打开一个终端（`hc run --bg pi`，或 Herdr app 的「新建终端」），
   在终端里跑 `pi`；扩展检测到 `HC_TERMINAL_ID` / `HC_TERMINAL_SOCKET` 后开始工作；
2. 模型可调用 `todo_write`（进度显示在常驻 widget 与 `/todos`）、
   `subagent`（spawn / wait / list / send / interrupt / resume / output / help）、
   `terminal`（open / send [`wait: true`] / wait / read / signal / close / list）；
3. 每个子代理 = 独立 core 终端，app 把它挂成 master 所在 tab 的非焦点 pane；
   人类可 attach 该终端直接对话；blocked 状态来自 pi 原生 OSC 7501；
4. 没有重启恢复：core 在 app 重启后保留终端，但 core 停止后 worker 结束；
   父 pi 会话用 `/resume` 恢复，已完成的 worker 用 `subagent(action: "resume", taskId)` 复活；
5. `/pier-tree` 在 pi 内以 overlay 打开委托树（`esc`/`q` 关闭）；`/dashboard` 已删除；
6. 安装自检：在终端里跑 `/pier-config check`（4 平面的有效值与来源见 `/pier-config show all`）。

## 4. 兼容矩阵与已知问题

| 项 | 状态 | 说明 |
|---|---|---|
| herdr-core 0.1.16 / macOS | ✅ 实测 | RPC `terminal.run` 起终端、app 自动挂 pane、OSC 7501 状态、`terminal.read/wait/send` 全链路 |
| herdr-core 0.1.16 / Windows | 未实测 | core 走同一 RPC 接口；路径与引号差异按 core 实现为准 |
| Linux | 未实测（理论可用） | 与 macOS 同走 POSIX 分支 |
| 非 herdr-core 环境用 pi | ✅ 实测 | 自动降级：不注册 `subagent`/`terminal`/`/locks`；todo_write / ask_user_question 照常可用 |
| 关闭 Herdr app | ✅ 设计如此 | core 里的终端继续运行；重开 app 后侧边栏状态完整 |
| core 停止 / 重启 | 已知限制 | worker 终端不重建（重启 resume 已删除）；用 ledger 的 `subagent resume` 新开 |
| `ui.custom` 弹窗 | 短期绕行 | pi 原生 reporter 不覆盖 `ui.custom`；pier 在 ask overlay 打开期间自己上报 blocked |
| `terminal.send` | 有人类静默门槛 | 目标 blocked 时拒绝发送（core 返回错误），pier 转成工具错误 |
| 子终端人机并存 | 软锁 | 机器消息走 pipe-channel（毫秒级），PTY 键盘通道归人；core parent note 对 worker 关闭（`noNotify`） |

## 5. 从 TUI 版本迁移（0.4.3 → core）

切换是一次性的，不保留 TUI 双后端：

- 删除**重启后 resume**（core 重启不重建 worker 终端；保留 `subagent resume` 从 ledger 新开）、
  **人工接管检测**（D94）、**热力布局 / 焦点重排**；
- 删除 **`/dashboard`**、整个 app 侧插件与 **sidebar token 行**（`display_agent` / `pi-ask` /
  `pi-parent` / `pi-task`）、窗格标题投影与 80 字符截断；
- 状态只来自 pi 原生 OSC 7501；元数据走 `pier.*` terminal label；机器间消息仍走 pipe-channel；
- **`/pier-tree`** 改为 pi 内 overlay；app 侧零 mod。

**最后一个兼容 TUI 的版本是 0.4.3**（npm `npx pier-setup@0.4.3`；源码 git tag `tui-final`）。
升级时安装器会询问是否卸载旧的 herdr 插件 `pier.workbench`；herdr TUI 本身与其 `config.toml` 不动。

## 6. 测试

```sh
npm install --ignore-scripts   # 仓库根（devDeps：pi-coding-agent 类型 + typebox）
npm test                       # typecheck + node --test（todo 重放 / 会话尾 / GC / 生命周期 / 跨平台引号）
```
