# pier 配置总览（4 个平面）

> **一句话**：`/pier-config` 会按平面列出**当前生效值 + 来源**（`env` > 工作区 > 用户 > 默认），无参调用则把"改配置"这件事交给 agent 引导完成。
> 本文件讲**为什么这样分层**与**每层改哪里**；机器真值（当前值/来源/校验）请直接跑命令：`/pier-config show all`、`/pier-config check`、`/pier-config doc`。
> 试用与反馈流程见 [`docs/efficiency-trial.md`](efficiency-trial.md)。

---

## 0. 先跑这些

```text
/pier-config                 # 4 平面索引（≤10 行）+ 把引导交给 agent
/pier-config show all        # 每个键的 生效值 / 来源 / 默认 / 影响一句话
/pier-config check           # 未知键、类型越界、未受信被忽略、JSON 损坏、env 非法
/pier-config doc             # 生成机器真值报告 → <repo>/.pi-herdr/config-report.md（建议把该文件加进 .gitignore）
```

命令**只读**：它不会写任何配置文件。改动由 agent 在讲解影响、展示 diff 并得到确认后用普通 `edit`/`write` 完成（写锁照常生效）。

---

## 1. 四个平面与优先级

| 平面 | 文件 / 来源 | 优先级 | 受信门控 | 谁拥有 |
|---|---|---|---|---|
| `efficiency` | `<repo>/.pi-herdr/config.json`、`~/.pi/agent/herdr-pi/config.json`、`PI_HERDR_*` env | env > 工作区 > 用户 > 默认 | ✅ 工作区需项目受信 | pier（D100–D103） |
| `roles` | `<repo>/.pi-herdr/roles/<name>.json`、`~/.pi/agent/herdr-pi/roles/<name>.json`、内置 `src/roles/` | 工作区/用户层覆盖（内置名不可劫持，D11） | 加载期校验（schema） | pier（D82/D11） |
| `pi` | `~/.pi/agent/settings.json`（+ 受信项目 `.pi/settings.json`） | 项目 > 全局 | ✅ | pi 本体 |
| `env` | `PIER_*`（runtime policy）、`PI_HERDR_*`（终端/待办/诊断/能效覆盖） | env 唯一（无文件） | — | pier |

**为什么这么分层**：能效与角色是 pier 的**行为策略**，所以放在 pier 自己的目录（用户级 + 工作区级），并用 env 提供最高优先级的临时覆盖；而 pi 的模型/压缩等属于**宿主设置**，pier 只读其中与 OCC 有关的 `compaction.*`，其余引导用户走 pi 的 `/settings`。

### 优先级与覆盖语义（试用期最容易踩的四条）

1. **env 最高**：`PI_HERDR_OBS_PACK_ENABLE=1` 会压过任何文件里的 `false`。
2. **工作区整体覆盖用户层**（浅替换，不深合并）：工作区只写一行 `enabled:false` 就能关掉该机制，不会被用户层的默认值穿透。
3. **未受信项目的工作区配置整份忽略**：`/pier-config show` 会把它标成 `IGNORED: untrusted project`，`check` 会给出一条 issue。
4. **未知键 / 类型非法 → 该机制强制 `enabled:false`**（一次收集全部问题并打印单行 stderr 警告，不中断会话）。

---

## 2. 改哪个平面？按需求查表

| 我想… | 平面 | 具体怎么做 | 生效方式 |
|---|---|---|---|
| 省 token：折叠大工具输出 | `efficiency` → `observationPack` | 工作区/用户配置里 `observationPack.enabled: true`（可先 `logEnabled: true`） | 新会话（或 `/reload`） |
| 让长测试日志变成收据 | `efficiency` → `evidencePreservingReducer` | 开 `enabled`，并把 `model` 指向一个便宜的模型；只想归档不提炼 → `localOnly: true` | 新会话 |
| 让多步任务自动压缩上下文 | `efficiency` → `onlineContextCompact` | 开 `enabled`；不确定缓存比率时留 `cacheWriteReadRatio: "auto"` | 新会话 |
| 临时开一天观察 | `env` | `PI_HERDR_OBS_PACK_ENABLE=1 PI_HERDR_OBS_PACK_LOG=1 pi` | 仅该进程 |
| 新增一个受限子代理角色 | `roles` | 在 `<repo>/.pi-herdr/roles/<name>.json` 写档案（见 `docs/sidebar-role-config.md`） | 下一次派发 |
| 给某个角色固定模型 | `roles` | 档案里的 `model: "provider/model"`（WS-D10 派发路由） | 下一次派发 |
| 关掉 pi 的自动压缩 | `pi` | 用 pi 的 `/settings`；注意 `compaction.enabled=false` 会连带禁用 OCC（除非 `PI_HERDR_COMPACT_ENABLE=1` 强制） | 新会话 |
| 让 OCC 的保留窗口跟随 pi | `pi` / `efficiency` | 不在效率配置里写 `keepRecentTokens` 即继承 pi 的值；显式写了就以效率配置为准 | 新会话 |
| 调子代理超时/GC/轮询 | `env` | `PIER_SUBAGENT_TIMEOUT_MS`、`PIER_GC_TICK_MS`、`PIER_POLL_INTERVAL_MS` … | 新进程 |
| 终端读多少字符 | `env` | `PI_HERDR_TERM_READ_MAX`（默认 8000） | 新进程 |

---

## 3. 让 agent 引导你改（推荐路径）

直接输入 `/pier-config`（不带参数）：命令打印索引，并把一段**固定流程**注入给 agent —— 先读有效值与来源 → 按平面指向对应文档 → 讲清影响与代价并给候选值 → 问你想达成什么 → 展示 diff 与生效方式并等确认 → 用 `edit`/`write` 落地 → 跑 `/pier-config check` 回读 → 不能即时生效的说明重启方式。

这样做的理由：配置改动牵扯**成本（token/缓存）、安全（信任门控、密钥外发）与生命周期（热生效 vs 重启）**，让模型在"有明确约束的流程"里做，比让用户直接改裸 JSON 更不容易出错；同时命令本身保持只读，写动作仍走既有的写锁与人工确认。

---

## 4. 安全与排障

- **命令绝不 dump `process.env`**：只读取目录中登记的键；密钥形态的键值渲染为 `***`。
- **EPR 会把日志发给模型**：`localOnly: true` 只归档不提炼；命中 `api_key|authorization|bearer|access_token|secret` 特征会直接回退全文。
- **未受信项目**：工作区 `efficiency` / 角色层不被采纳（`roles` 由 schema 校验，`efficiency` 由信任门控），`show` 会标注。
- **常见症状对照**：
  - "改了没生效" → `check` 看是否未知键/类型错误被回退；再确认是否用了工作区层而项目未受信；最后确认是否需要重启进程。
  - "OCC 明明开了却没压" → `show pi` 看 `compaction.enabled`；`show efficiency` 看 `onlineContextCompact.enabled` 的来源与 note。
  - "日志/对象在哪" → `<sessionDir>/herdr-pi/<sessionId>/efficiency-logs/*.jsonl` 与 `*-pack/objects/`（见 `docs/efficiency-trial.md` §3）。

---

## 5. 相关文档

| 文档 | 内容 |
|---|---|
| [`docs/efficiency-trial.md`](efficiency-trial.md) | D100–D103 试用指南（开哪个、看什么、怎么判划算、反馈模板） |
| [`docs/sidebar-role-config.md`](sidebar-role-config.md) | 角色档案与侧边栏排版配置 |
| [`schemas/efficiency-config.schema.json`](../packages/pier-ext/schemas/efficiency-config.schema.json)、[`schemas/role-manifest.schema.json`](../packages/pier-ext/schemas/role-manifest.schema.json) | 契约（键与类型） |
