# 架构与设计决策索引 (Design Decisions Index)

> **诚实标注声明 (Honesty Notice)**:
> 本仓库中未包含原始外部设计文档（DESIGN.md / 历史会议纪要），以下条目均从代码注释、单测契约与实际调用方式中严谨反推归纳。
> 无法从代码上下文中 100% 确定原决策完整定义的条目，均如实标注为 `（推断，代码用法见 path:line）`。
> 本索引按编号排序，每条均给出至少一个代码锚点以供追溯。

> **文档边界**：本索引（含代码锚点）入库；单特性设计说明、ADR 与历史归档属本地开发文档
> （`docs/adr/`、`docs/history/`、`docs/rfc-*.md`、`code review.md`，见 `.gitignore`），不入库。

| 编号 (ID) | 决策摘要 (Summary) | 代码锚点 (Anchor) |
|---|---|---|
| WS-D6 | 移除角色档案中的限速约束（`rate_limits`），pier 仅负责权限边界，资源配额由集成方接管 | `packages/pier-ext/src/role-manifest.ts:12` |
| WS-D7 | 主控 pane 自应用其角色档案（master manifest），与子代理走同构的强制权限校验链 | `packages/pier-ext/src/index.ts:66` |
| WS-D8 | 角色清单移除 `roleType` 顶层字段，收敛为版本号 + 三态规则（`allow`/`ask`/`deny`） | `packages/pier-ext/src/manifest-compose.ts:73` |
| WS-D10 | 支持按角色在 manifest 中配置 `provider/model` 模型路由（省略则回退到进程默认模型） | `packages/pier-ext/schemas/role-manifest.schema.json:10` |
| D1 | （推断，代码用法见 `packages/pier-ext/test/roles.test.ts:243`）不在角色 tools 清单内的工具直接判定为 deny（测试决策断言） | `packages/pier-ext/test/roles.test.ts:243` |
| D2 | （推断，代码用法见 `packages/pier-ext/test/roles.test.ts:244`）受限工作角色对 subagent 等高危派活工具的权限阻断（测试决策断言） | `packages/pier-ext/test/roles.test.ts:244` |
| D3 | 基于 herdr 事件驱动模型，禁止轮询（零新协议，状态通过 `pane.agent_status_changed` 等事件即时推送） | `packages/pier-workbench/src/reflow.ts:163` |
| D10 | （推断，代码用法见 `packages/pier-ext/src/subagent-core.ts:1`）子代理核心生命周期契约与向后兼容基线 | `packages/pier-ext/src/subagent-core.ts:1` |
| D11 | 内置角色（master / worker-default）直接读取内置档案，无视 workspace/user 目录诱饵以防角色劫持 | `packages/pier-ext/src/role-loader.ts:75` |
| D25 | （推断，代码用法见 `packages/pier-ext/src/subagent-core.ts:158`）子代理任务 tab 放置决策纯逻辑规划 | `packages/pier-ext/src/subagent-core.ts:158` |
| D26 | 子代理派发互斥锁（mutex），防止并发创建 tab 与 pane 时产生竞态 | `packages/pier-ext/src/subagent-spawn.ts:287` |
| D28 | （已废弃 → D110）workspace 打开时主 tab 自动引导及会话恢复后布局重放（herdr 插件 `[[events]]` 与 `[[startup]]` 钩子） | `packages/pier-workbench/herdr-plugin.toml` |
| D29 | 任务 tab 垃圾回收（GC）纯判定矩阵（消费完成后关闭 pane，取消 resident 豁免） | `packages/pier-ext/src/gc-core.ts:2` |
| D34 | Todo 五态模型（pending/in_progress/completed/blocked/abandoned，blocked 必须带原因且不计入 completed） | `packages/pier-ext/src/vocab.ts:8` |
| D35 | Todo 列表内容未变化时跳过持久化与镜像同步，避免无谓 I/O | `packages/pier-ext/src/plugins/todo.ts:297` |
| D36 | 结算与推进反馈中向调用方显式呈现任务完成过渡与回归状态 | `packages/pier-ext/src/plugins/todo.ts:322` |
| D37 | 任务完成状态不可逆（completed 状态不可在后续自动状态流转中静默回退为 open） | `packages/pier-ext/src/plugins/todo.ts:322` |
| D38 | 人类 `/todos` 命令编辑以会话 JSONL custom entry（`pi-herdr.todo-edit`）持久化，保证分支回放权威一致 | `packages/pier-ext/src/plugins/todo.ts:357` |
| D39 | 轮次开始前阅读钩子（before_agent_start + display:false），注入未完成催办与陈旧列表解冻警告 | `packages/pier-ext/src/plugins/todo.ts:150` |
| D41 | stop 停止时未完成 todo 提醒纯决策核心（二修：频率限制、封顶提醒、ESC 中止抑制） | `packages/pier-ext/src/todo-reminder-core.ts:2` |
| D42 | （推断，代码用法见 `packages/pier-ext/src/todo-core.ts:91`）Todo 工具调用入参的格式归一化与校验契约 | `packages/pier-ext/src/todo-core.ts:91` |
| D43 | Todo 条目支持可选的分组阶段字段 `phase`（≤30 字符）与 `blocker`（无固定 id，last-write-wins） | `packages/pier-ext/src/vocab.ts:13` |
| D45 | 区分人机通道（M11）：扩展间专用 pipe-channel 传输层与确定性命名契约 | `packages/pier-ext/src/pipe-channel.ts:2` |
| D46 | follow_up 经由扩展 pipe 投递，并在工具间隙通过 steer 机制送达长任务工作代理 | `packages/pier-ext/src/plugins/subagent.ts:496` |
| D47 | PTY 通道 100% 归人类独占交互，机器交互走扩展 pipe，保障会话历史干净 | `packages/pier-ext/src/pipe-channel.ts:9` |
| D48 | （推断，代码用法见 `packages/pier-ext/src/index.ts:331`）对等双向消息管道，每 pane 监听自身独立名称，消除主从硬编码假设 | `packages/pier-ext/src/index.ts:331` |
| D49 | 消息回复地址沿用发送方声明的 pipe 名称，不硬编码 controller/child 角色路由 | `packages/pier-ext/src/pipe-channel.ts:45` |
| D50 | 追踪 pane 最新机器请求状态，用于打断认领、轮询去重与结算结果快路径推送 | `packages/pier-ext/src/index.ts:314` |
| D62 | 将 pane 当前 todo 快照投影至 herdr 窗格标题栏与侧边栏 | `packages/pier-ext/src/pane-title.ts:2` |
| D65 | （推断，代码用法见 `packages/pier-ext/src/todos-service.ts:1`）TodosService 服务化封装，承载 todo 运行时状态与事件生命周期 | `packages/pier-ext/src/todos-service.ts:1` |
| D67 | 焦点热力布局档 1（历史方案：swap-to-first + 0.65 缩放，已被 D91 档 3 原地热力取代） | `packages/pier-workbench/herdr-plugin.toml:52` |
| D68 | 窗格标题看板化投影公式（统一渲染 `▶i ○p ■b ✓c (N/M)`） | `packages/pier-ext/src/pane-title.ts:2` |
| D69 | 将 todo 阅读钩子挂载于 `before_agent_start` 事件（设置 `display: false` 静默注入） | `packages/pier-ext/src/todo-read-hook.ts:2` |
| D71 | 常驻交互式终端工具族（open/send/read/signal/close/list），由 herdr pane 承载 | `packages/pier-ext/src/plugins/terminal.ts:57` |
| D75 | TodosService 运行时配置提取与 strict/parallel 执行模式分流 | `packages/pier-ext/src/plugins/todo.ts:304` |
| D76 | 角色档案规范 v2（role manifest v2）及规则校验器（三态规则系统） | `packages/pier-ext/schemas/role-manifest.schema.json:4` |
| D77 | 可见层裁剪：session_start 时将角色 manifest 以外的工具从模型工具集视野中隐藏 | `packages/pier-ext/src/index-roles.ts:116` |
| D78 | 树边界 = 进程边界（master pi 扩展与 herdr workbench 运行于独立 Cordis 服务树） | `packages/pier-ext/src/bootstrap.ts:2` |
| D79 | pi 扩展注册面代理（`pi-surface`）与 tombstone 补偿，保障重载/退出时幂等清理 | `packages/pier-ext/src/pi-surface.ts:2` |
| D80 | Cordis 生态接入：Loader group builtins、HMR fiber effect 销毁补偿与优雅降级 | `packages/pier-ext/src/bootstrap.ts:2` |
| D81 | 架构三分法裁剪（entry loader / pure core / platform adapter），worker 进程旁路跳过 Cordis 树 | `packages/pier-ext/src/bootstrap.ts:7` |
| D82 | 未知工具姿态（`unknownTools: allow/deny`）：用户安装扩展走信任关系轴，区分显式规则与默认可见性 | `packages/pier-ext/schemas/role-manifest.schema.json:30` |
| D83 | 角色继承制：`worker-default` 严格继承 `master.tools` 扣除 subagent 与 terminal 族，防止配置漂移 | `packages/pier-ext/src/role-loader.ts:9` |
| D84 | 事件环境变量载荷双形态兼容（适配直接字符串与嵌套 JSON 信封两类 dump 载荷） | `packages/pier-workbench/src/reflow.ts:222` |
| D86 | 子代理按 git worktree 分组放置（主检出进 main tab，worktree 进同名 tab；main tab 永不整关） | `packages/pier-ext/src/subagent-core.ts:301` |
| D87 | HMR 重载边界管理：保留重载边界之后的新代注册，仅清理老代遗留 | `packages/pier-ext/src/bootstrap.ts:80` |
| D90 | 热力布局档 2 修正：未入账老 pane 直接放行，避免误判为新生 pane 而错误触发账龄拦截 | `packages/pier-workbench/src/reflow.ts:131` |
| D91 | 网格原地热力布局（档 3：零 swap，仅调整 split ratio）及状态四分象形图标（`▶○■✓`） | `packages/pier-workbench/src/heat-layout.ts:2` |
| D92 | 结算通知缓冲折叠器（notice-buffer）：主控忙碌期间缓冲子代理通知，防止连续打断风暴 | `packages/pier-ext/src/index-notices.ts:2` |
| D93 | 侧边栏角色身份展示（`display_agent`）与 `$pi-todo` 独立 token 批次上报（与 stale 清理批次解耦） | `packages/pier-ext/src/herdr-client.ts:157` |
| D94 | 子代理同会话复用已存在 pane，检测人类打断接管状态（`userTakeover`/`observationStartedAt`） | `packages/pier-ext/src/subagent-spawn.ts:492` |
| D95 | 热力权重表（`blocked: 3 > ask: 2.5 > working: 1.4 > idle: 1`）、非焦点窄条衰减与数量变化重排 | `packages/pier-workbench/src/heat-layout.ts:24` |
| D96 | 主控空闲但后台子代理在跑时的结算催办提醒（按运行集去重、10 分钟冷却、abort 抑制） | `packages/pier-ext/src/settle-wake-core.ts:12` |
| D97 | 网格分裂拓扑一律向下拆（全宽横条）、默认 fullscreen TUI 模式及超小 pane 窄格静帧 overlay | `packages/pier-ext/src/plugins/grid-shape.ts:2` |
| D98 | isolate worktree 隔离写并发互斥防泄漏，以及 PTY resize watchdog（SIGWINCH + 1s 轮询兜底） | `packages/pier-ext/src/plugins/subagent.ts:122` |
| D100 | 待办驱动的在线上下文压缩（OCC）：以 todo.completed {source: 'tool'} 为进度边界，结合 KV-Cache 增量成本与窗口保护机会式压缩 | `packages/pier-ext/src/compact-economics-core.ts:130` |
| D101 | 观察结果冷热分级（ObservationPack）：整行切片安全折叠长工具输出，受前缀缓存经济学与角色门禁约束 | `packages/pier-ext/src/observation-core.ts:192` |
| D102 | 进程内测试日志保真提炼（EPR）：基于未截断输出逐字节引文验真，替换前强制归档原文且支持密钥过滤 | `packages/pier-ext/src/reducer-core.ts:117` |
| D103 | 能效多级配置与独立遥测闭环：支持环境变量覆盖、项目信任安全门控与细粒度 JSONL 审计流水 | `packages/pier-ext/src/efficiency-config-core.ts:368` |
| D104 | 配置说明只读命令与 agent 引导式改配置（4 平面目录、生效值+来源、schema 漂移守卫；boot 平面随 D110 移除） | `packages/pier-ext/src/config-catalog-core.ts:1` |
| D105 | Pier 侧边栏 agent 视图不设 harness 过滤（`filter: null`，任何 agent 都显示），只保留 attention-first 排序：`agent.view.set` 全局替换 herdr 内置 Agents 投影，任何过滤都会静默隐藏未列入的 harness | `packages/pier-workbench/src/agent-view.ts:48` |
| D106 | pi 0.86 基线升级：动态工具集走 transcript 持久化（`setActiveTools` delta 存活于 resume/branch），删除 feature-detect 兼容层；`pi.on()` 原生 unsubscribe 真摘除退休世代监听（tombstone 保留给 tool/command） | `packages/pier-ext/src/pi-surface.ts:1` |
| D107 | 会话中角色切换（P0）：roleState 可变状态 + `/pier-role`（人，放宽需 confirm）+ pipe `role` 请求（master 自由）；切换以注册全集为论域重算 active（可找回被 D77 裁掉的工具）；resume 从最后一条 role-manifest entry 重放 gate manifest（变更才写防覆盖）；per-role `guidelines` 作为 `pier-role` prompt section 幂等注入 | `packages/pier-ext/src/role-state.ts:1` |
| D108 | Master 自身永不成为子代理目标（会话 01a0bd3a 自杀链）：sessionFile 归因同时排除自身会话与他人活 pane 占用（`bareSessionId` 统一比较，单一 `agent.list` 同时产出上报与占用集）；resume 命中 master pane 硬失败、revive 视中毒 sessionFile 为缺失；pane 级 GC 无条件跳过 `env.paneId`（D94 复用与 D86 主 tab 保护的补口） | `packages/pier-ext/src/subagent-session.ts:234` |
| D109 | 报告必达与会话恢复（01a0bd3a 后续批次）：worker 经 pipe 自报的会话 id 为权威（裸 id 映射为路径后可覆盖中毒 sessionFile；worker settle push 同样按 id 解析自读 transcript）；结算文本候选以 entry.sessionFile 为 preferred；null 收尾文本经 jev 双 Noul（尾巴归属/最终答案）分类 attribution-suspect / extraction-failed / silent，jev 不可用回落旧措辞；master resume 后对存活 running 子代理重建 poller（requestId `recover-*`）并重放 branch fold（todos/OCC 债务）；OCC 压缩失败进入指数退避（封顶 4）+ 可见失败消息 + 指令限长 | `packages/pier-ext/src/subagent-session.ts:143` |
| D110 | 移除 workspace 自动引导与重启重放（废弃 D28）：新 workspace 不再自动注入 pi 启动命令、herdr 重启不再重放主 tab，pi 一律由人手动在 pane 启动；连带删除 boot-config 生成/校验全链（install.mjs 探测写入、/pier-config boot 平面、herdr-rpc 启动命令拼装与 boot.jsonl） | `packages/pier-workbench/herdr-plugin.toml:1` |
| D111 | 委托身份一等公民化（RFC rfc-delegation-identity Phase 1，借鉴 pi-subagent-manager）：spawn 经 `PI_HERDR_DELEGATION` 下发 DelegationContext（parentPaneId/parentSessionId/taskId/description/role），worker 侧 env > worker marker > branch fold 三级解析；`before_agent_start` 注入 `pier-delegation` prompt section（身份+统一交付契约）；首帧 `pi-herdr.delegation` custom entry 渲染为委托卡片；herdr `tokens['pi-parent'/'pi-task']` 独立批次上报（D96 纪律）；worker pane title `↳` 前缀（无 todo 时以任务描述独立成题）；master subs 卡片 worker 行 `↳`；dashboard 按 pi-parent 分组缩进树化、blocked 告警带 `worker ← master` 归属 | `packages/pier-ext/src/delegation-core.ts:1` |
| D112 | 任务 slug 与主动进度上报（RFC rfc-delegation-identity Phase 2）：spawn 分配 `slug`（description kebab-case，≤24 字符；CJK/空描述回落 `task-<taskId前6>`；冲突加 `-2/-3` 序号，revive/history 稳定携带）；工具输出一律 `slug@paneId`，`agentId` 参数接受裸 slug / 裸 paneId / `slug@paneId`（revive 换 pane 后按 slug 部分兜底解析）；DelegationContext 增 `parentPipe`（master 管道名随 spawn/revive 下发）；worker 注册 `report_progress` 工具（仅 worker，worker-default v1.5.0 显式放行，master 永不注册）经 pipe `progress` 请求回 master，master 以 `pi-herdr.progress` custom message 注入（display:false + triggerTurn:false，不刷屏不唤起），渲染为 `⤴ progress` 卡片；revive 委托角色 `kind==='task'` 对齐为 worker-default | `packages/pier-ext/src/subagent-core.ts:259` |
| D113 | 统一 TUI 状态条（RFC rfc-unified-widget）：常驻 widget 一行一 agent——自己一行 `▶ 当前条 ✓d/n`（活动锚定多行窗口退役），每个 running subagent 一行 `↳ slug ▶ 当前条 ✓d/n`（blocked 显示任务内容+blocker 括注；settled 不占行）；闸门折叠/归档降级保留；>9 worker 折计数指路。数据通道：worker `todo_write` 后经 `parentPipe` 推 `todo_sync` 全量清单（~1-2KB/次，事件驱动零轮询），master `workerTodos` 内存缓存 + 到达即重渲染；master resume 用 herdr `pi-todo` token 重建摘要兜底。新命令 `/pier-tree`（master）渲染完整委托树：自己的全量 todo + 每个 worker 全量清单 + settled 节点（年龄）；`/dashboard` 保持 ops 面板职责不变 | `packages/pier-ext/src/tree-view.ts:1` |
| D114 | 统一 Pier panel + 完成态静默：Herdr `popup` 是会话级单例（`popup.close` 无参数），`overlay` 是可并存的普通 pane。`/dashboard` 与 `/pier-tree` 默认打开同一个 `panel` popup，`PIER_PANEL` 只决定初始 `Dashboard` / `Tree` tab（popup 会话模态，打开期间无法再执行 slash command；面板内 `1`/`2`/`Tab` 切换）；`ui_busy` 不再误退化成新 tab，`overlay` 仅保留为显式 escape hatch。pi 侧把渲染树写入 `PIER_TREE_FILE` 快照（todo/worker 推送即刷新），裸 pi / 插件缺失回退 `ui.notify`。dashboard 按 PTY 实际宽高渲染：自由文本软换行、表格描述列吃剩余宽度、超屏进入 j/k/PgUp/PgDn 视口；popup 90% × 80%。进程退出即由 Herdr 关闭 popup（不再显式发 `popup.close`，避免误关其它 modal）。全完成（无 ▶/■/○）的自态不再输出 `✓N/N`，widget 直接隐藏；archived 降级与 worker 行保留 | `packages/pier-ext/src/panel-open.ts:1` |
| D115 | settle 归因遥测校准字段：`settle-attribution` 的 ask 经 `enrich` 落 `tailMatchesTaskNoul`/`tailHasFinalAnswerNoul`/`settleVerdict`（noul 答案无 confidence，概率与组合裁决才是 SETTLE_*_MIN_NOUL 调参依据） | `packages/pier-ext/src/subagent-poller.ts:376` |
| D116 | pi 原生 `ModelRuntime.classify()` 评估后不采纳，jev 保留直连 HTTP 传输。题型不是缺口（`system-one-shared.js` 把公开 `bool` 在 wire 层改写为 `noul`，`probability ↔ noul` 一一对应，阈值无需重调）；真缺口是 `typesafe` 目录仅 `jev-latest`（pinned `jev-1.13.0` 防漂移失效，自注册 classifier 条目又等于换壳保留传输）与 `ClassifierOptions` 无 baseUrl 覆盖；复评触发 = 上游支持 pinned 目录 + 端点覆盖（RFC rfc-upstream-absorption-2026-10 §8.1） | `packages/pier-ext/src/jev-client.ts:1` |
| D117 | 结算通知不再丢失于 OCC 压缩窗口：notice buffer 的 `isBusy` 计入 `compactionInFlight`，压缩落定后 flush；poller 先 claim+inject、通知被接受后才 `consumed`（拒收则行保持 running、下个 tick 重试）。worker transcript 已有终稿且 pane 空闲时当 tick 结算（无文本/working pane 仍走观察窗口，保留 D94 接管判定）；`subagent list` 与 isolate spawn 结果给出 worktree 绝对路径而非分支名 | `packages/pier-ext/src/index.ts:386` |
| D118 | 停止分类：`stopReason:"error"`（provider 失败，pi 会自动重试）与 `agent_settled.aborted` 不触发 stop 提醒，也不推 settle reply（保留 machine request）；重试的 `turn_start` 取消待发提醒。归档重写窗口持久化为 `pi-herdr.todo-archive-window`（按列表哈希折叠，resume 后不重复），窗口给过后下一次运行即终态通知+清空；复读行经 `todoLine()` 带 blocker；完结计划切新计划不报 reverted 警告 | `packages/pier-ext/src/settle-wake-core.ts:11` |
| D119 | OCC 不再只在 todo 边界评估：deferred 后 toolUse 回合每 `DEFERRED_REEVALUATION_REQUESTS` 次请求复评；horizon = 先验收缩均值 × 剩余边界（blocked 不计），以本段已观察请求数为下限、上限 100；debt/摘要 token 取 `CompactionResult.usage`，留存量取 `estimatedTokensAfter`，未还 debt 结转并随 efficiency-state 持久化；不可启动的 selectedCompaction 丢弃、`turn_start` 清除 | `packages/pier-ext/src/compact-coordinator.ts:34` |
| D120 | terminal：wait/echo 正则统一 `compilePattern`（`m` 旗标，文档推荐的 `^X_[0-9]` 才能命中缓冲中段且 stale 判定生效）；shell init 兼容 zsh（`setopt NO_BANG_HIST`），init 成功才标记、停在 `dquote>` 等续行提示时 send 报错；后续 open 从最近终端 pane 向下拆分，非 agent pane 混合拆分保底 0.25（workbench 与 spawn 镜像锁步）；read 以全文 len+hash 判 none；耗尽预算的 wait 记为 timeout。ask：`prepareAskArguments` 解析字符串化 options/questions，失败结果 `isError`，取消保留已答，multi+Other 保留勾选 | `packages/pier-ext/src/terminal-core.ts:210` |
| D121 | EPR 诊断闸门先判 confidence：低于 `minConfidence` 的拒绝不再否决 regex 命中（回落 `regexHit`）。ObservationPack 跨进程幂等：内容寻址对象已存在即复用占位符，不再重打包/重问 jev/重计 `grossSavedTokens`。`obs_recall` 非数字 offset 报错，行中 offset 对齐到下一行首并回报实际 offset | `packages/pier-ext/src/jev-core.ts:156` |
| D122 | EPR 诊断门撤回 2026-09-19 的「jev 优先」翻转（RFC P0-1）：候选集 = 正则清单，jev 只能否决不能提拔。依据：一周 18 会话 437 次门调用 0 次改变判定（清单外提拔 0、清单内否决 0），却在工具结果关键路径上阻塞累计 369s 并外发 ~106KB 清单外命令行。提炼路径所有 fail-open 出口均落 reason 行（`no-reducer-model`/`empty-output`/`invoke-failed`（含 pi `complete()` 返回的 error stopReason）/`receipt-not-smaller`）。jev 客户端熔断：连续 2 次传输失败（超时/网络/5xx）后 60s 本地回退、不发请求不写行，网络错误行带 `errorCode` | `packages/pier-ext/src/reducer-invoker.ts:149` |
| D123 | OBS 摘录选窗：只对有失败信号窗（first_signal/densest）的输出问 jev——只有 `mid` 候选时一周 10 次中 8 次保留头尾或失败；压缩批量打包的所有候选合成一次请求（`outputs[i]` ↔ `excerpt_${i}_window`，原 6–20 路并发在 jev 宕机时一起失败）；seam 改为批量 `PickMiddleExcerpts`，单条打包即一条的批。jev 行带 `items[{obsId, windows[{id,startLine}]}]` 与逐条 `picked`，可与打包对象和 `obs_recall` 关联 | `packages/pier-ext/src/jev-core.ts:345` |
| D124 | `subagent output` 去重：pane 读数先剥 TUI 外框（纯框线行、侧边框、右填充、空行串、pi 的 cwd + `↑/↓/$` 页脚，实测 4000→2493 字符）再算 delta；附带 transcript 终稿时，pane 里渲染出的终稿副本（markdown 被剥、长行按 pane 宽截断，有损）按开头 24 个归一化字符定位并截掉，只留完整 transcript 版。完整交付的终稿把尾部指纹写入 subs 行 `reportDelivered`（随 resume 折叠，也作为无 cursor 时的去重种子）；poller 结算时 closing 指纹一致则通知只指向那次 output 交付而不重复全文（ledger 仍记全文）。pipe reply 路径不变（只应答 send/follow-up） | `packages/pier-ext/src/subagent-session.ts:41` |
| D125 | 删除 worker 侧 `report_progress`（D112 Phase 2）：所有会话 0 次调用，却在每个 worker 请求里占一个工具位 + ~380 字符 schema；同时删 pipe `progress` 消息、`pi-herdr.progress` 类型与渲染卡片，`worker-default` 角色升 1.6.0（`parentPipe` 保留给 `todo_sync`）。替代：后台 worker 运行期间 master 的 bash 结果若含 `sleep ≥ 60`，追加一句「结算通知会在下一个工具边界自动到达，不必 sleep 等待」——针对 master 用 `sleep 120…840` 空等 660–840s 的观测；措辞保留 sleep 等其它工作（构建、日志）的情形 | `packages/pier-ext/src/subagent-core.ts:344` |
| D126 | `terminal wait` 支持 `file:`：进程内每秒读日志尾部 1MB，用同一 `m` 旗标匹配器测 pattern（相对路径按终端 cwd、`~/` 展开；文件未出现也继续等；可被 ESC 中止）；等待开始时已存在的命中立即返回并标注「already present」，提示旧 run 遗留；文件不含键入回显，故不走 echo 守卫。send 时若命令把 `$?` 哨兵追加进文件（`echo RUN_EXIT_$? >> run.log`），结果附上可直接复制的 `wait file:` 调用——针对 71 会话中 ~20h 的 bash sleep 轮询日志（`01a15c88` 单会话 4843s） | `packages/pier-ext/src/plugins/terminal.ts:556` |
| D127 | Pier 工具静态负载瘦身：master 每请求 19,697→10,391 字符（≈−2.3k token），worker 6,125→4,302。`subagent` 10,044→3,588：参考细节（isolate 机制、role 合成、ledger 格式、各 action 细则）移入新增 `subagent(action:"help")` 返回的手册，常驻描述只留调用所需（含 ~5 分钟前台阻塞与「通知自动到达，勿 sleep」）；各工具去掉描述/参数/指引之间的重复句（ask 保留两种形状的规范示例——`]}` 缓解所需；todo 收工对账规则只留在指引）。测量：挂载真实 master/worker 组合根统计 description + 参数 JSON + snippet/guidelines | `packages/pier-ext/src/plugins/subagent.ts:88` |
| D128 | OCC 摘要 thinking 等级上限 `onlineContextCompact.summaryThinkingLevel`（`inherit`/`off`…`max`，默认 `low`）：pi 的摘要请求沿用会话 thinking 等级，`max` 会话中摘要输出 67% 是推理、单次压缩 144s。会话等级高于上限时仅在 `ctx.compact` 期间经 `pi.setThinkingLevel` 降级，`finally` 中恢复（成功/失败/取消都恢复）；低于上限时不升。代价：每次降级在 transcript 写两条 `thinking_level_change`。新增配置字段类型 `enum` | `packages/pier-ext/src/compact-coordinator.ts:403` |
| D129 | OCC 经济学计入前缀缓存未命中：此前每个后续请求都按 cache-read 计价，但 22 个会话中前缀命中率 98.6%（缓存 TTL 过期导致 1.2% 请求整段 miss、占花费 14%），miss 时归档前缀按 write/input 价计费（deepseek 50×）。coordinator 在 `turn_end` 读 assistant `usage`，累计「上一请求 prompt 大小」与其中 `cacheRead`（会话首请求与压缩后首请求不计——后者是债务已计价的冷重写），按 1M 全命中伪 token 平滑、超 20M 减半，随 state marker 持久化。`savingTokensPerRequest = saving × (hit + (1−hit) × max(1, ratio))` 同时用于 breakeven 与债务偿还速率；决策日志记录 `prefixCacheHitRate`/`savingTokensPerRequest` | `packages/pier-ext/src/compact-economics-core.ts:186` |
