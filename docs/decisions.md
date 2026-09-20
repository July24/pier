# 架构与设计决策索引 (Design Decisions Index)

> **诚实标注声明 (Honesty Notice)**:
> 本仓库中未包含原始外部设计文档（DESIGN.md / 历史会议纪要），以下条目均从代码注释、单测契约与实际调用方式中严谨反推归纳。
> 无法从代码上下文中 100% 确定原决策完整定义的条目，均如实标注为 `（推断，代码用法见 path:line）`。
> 本索引按编号排序，每条均给出至少一个代码锚点以供追溯。

> **文档边界**：本索引（含代码锚点）入库；单特性设计说明、ADR 与历史归档属本地开发文档
> （`docs/adr/`、`docs/history/`、`docs/rfc-*.md`、`code review.md`，见 `.gitignore`），不入库。

| 编号 (ID) | 决策摘要 (Summary) | 代码锚点 (Anchor) |
|---|---|---|
| WS-D6 | 移除角色档案中的限速约束（`rate_limits`），pier 仅负责权限边界，资源配额由集成方接管 | `packages/pier-ext/src/index.ts:313` |
| WS-D7 | 主控 pane 自应用其角色档案（master manifest），与子代理走同构的强制权限校验链 | `packages/pier-ext/src/index.ts:66` |
| WS-D8 | 角色清单移除 `roleType` 顶层字段，收敛为版本号 + 三态规则（`allow`/`ask`/`deny`） | `packages/pier-ext/src/manifest-compose.ts:73` |
| WS-D10 | 支持按角色在 manifest 中配置 `provider/model` 模型路由（省略则回退到进程默认模型） | `packages/pier-ext/schemas/role-manifest.schema.json:10` |
| D1 | （推断，代码用法见 `packages/pier-ext/test/tool-gate.test.ts:32`）不在角色 tools 清单内的工具直接判定为 deny（测试决策断言） | `packages/pier-ext/test/tool-gate.test.ts:32` |
| D2 | （推断，代码用法见 `packages/pier-ext/test/tool-gate.test.ts:38`）受限工作角色对 subagent 等高危派活工具的权限阻断（测试决策断言） | `packages/pier-ext/test/tool-gate.test.ts:38` |
| D3 | 基于 herdr 事件驱动模型，禁止轮询（零新协议，状态通过 `pane.agent_status_changed` 等事件即时推送） | `packages/pier-workbench/src/reflow.ts:163` |
| D10 | （推断，代码用法见 `packages/pier-ext/src/subagent-core.ts:1`）子代理核心生命周期契约与向后兼容基线 | `packages/pier-ext/src/subagent-core.ts:1` |
| D11 | 内置角色（master / worker-default）直接读取内置档案，无视 workspace/user 目录诱饵以防角色劫持 | `packages/pier-ext/src/role-loader.ts:75` |
| D25 | （推断，代码用法见 `packages/pier-ext/src/subagent-core.ts:158`）子代理任务 tab 放置决策纯逻辑规划 | `packages/pier-ext/src/subagent-core.ts:158` |
| D26 | 子代理派发互斥锁（mutex），防止并发创建 tab 与 pane 时产生竞态 | `packages/pier-ext/src/subagent-core.ts:270` |
| D28 | workspace 打开时主 tab 自动引导及会话恢复后布局重放（herdr 插件 `[[events]]` 与 `[[startup]]` 钩子） | `packages/pier-workbench/herdr-plugin.toml:29` |
| D29 | 任务 tab 垃圾回收（GC）纯判定矩阵（消费完成后关闭 pane，取消 resident 豁免） | `packages/pier-ext/src/gc-core.ts:2` |
| D34 | Todo 五态模型（pending/in_progress/completed/blocked/abandoned，blocked 必须带原因且不计入 completed） | `packages/pier-ext/src/vocab.ts:8` |
| D35 | Todo 列表内容未变化时跳过持久化与镜像同步，避免无谓 I/O | `packages/pier-ext/src/core/todo.ts:318` |
| D36 | 结算与推进反馈中向调用方显式呈现任务完成过渡与回归状态 | `packages/pier-ext/src/core/todo.ts:322` |
| D37 | 任务完成状态不可逆（completed 状态不可在后续自动状态流转中静默回退为 open） | `packages/pier-ext/src/core/todo.ts:322` |
| D38 | 人类 `/todos` 命令编辑以会话 JSONL custom entry（`pi-herdr.todo-edit`）持久化，保证分支回放权威一致 | `packages/pier-ext/src/core/todo.ts:380` |
| D39 | 轮次开始前阅读钩子（before_agent_start + display:false），注入未完成催办与陈旧列表解冻警告 | `packages/pier-ext/src/core/todo.ts:150` |
| D41 | stop 停止时未完成 todo 提醒纯决策核心（二修：频率限制、封顶提醒、ESC 中止抑制） | `packages/pier-ext/src/todo-reminder-core.ts:2` |
| D42 | （推断，代码用法见 `packages/pier-ext/src/todo-core.ts:122`）Todo 工具调用入参的格式归一化与校验契约 | `packages/pier-ext/src/todo-core.ts:122` |
| D43 | Todo 条目支持可选的分组阶段字段 `phase`（≤30 字符）与 `blocker`（无固定 id，last-write-wins） | `packages/pier-ext/src/vocab.ts:13` |
| D45 | 区分人机通道（M11）：扩展间专用 pipe-channel 传输层与确定性命名契约 | `packages/pier-ext/src/pipe-channel.ts:2` |
| D46 | follow_up 经由扩展 pipe 投递，并在工具间隙通过 steer 机制送达长任务工作代理 | `packages/pier-ext/src/core/subagent.ts:496` |
| D47 | PTY 通道 100% 归人类独占交互，机器交互走扩展 pipe，保障会话历史干净 | `packages/pier-ext/src/pipe-channel.ts:9` |
| D48 | （推断，代码用法见 `packages/pier-ext/src/index.ts:476`）对等双向消息管道，每 pane 监听自身独立名称，消除主从硬编码假设 | `packages/pier-ext/src/index.ts:476` |
| D49 | 消息回复地址沿用发送方声明的 pipe 名称，不硬编码 controller/child 角色路由 | `packages/pier-ext/src/pipe-channel.ts:45` |
| D50 | 追踪 pane 最新机器请求状态，用于打断认领、轮询去重与结算结果快路径推送 | `packages/pier-ext/src/core/subagent.ts:121` |
| D62 | 将 pane 当前 todo 快照投影至 herdr 窗格标题栏与侧边栏 | `packages/pier-ext/src/pane-title.ts:2` |
| D65 | （推断，代码用法见 `packages/pier-ext/src/todos-service.ts:1`）TodosService 服务化封装，承载 todo 运行时状态与事件生命周期 | `packages/pier-ext/src/todos-service.ts:1` |
| D67 | 焦点热力布局档 1（历史方案：swap-to-first + 0.65 缩放，已被 D91 档 3 原地热力取代） | `packages/pier-workbench/src/heat-layout.ts:10` |
| D68 | 窗格标题看板化投影公式（统一渲染 `▶i ○p ■b ✓c (N/M)`） | `packages/pier-ext/src/pane-title.ts:2` |
| D69 | 将 todo 阅读钩子挂载于 `before_agent_start` 事件（设置 `display: false` 静默注入） | `packages/pier-ext/src/todo-read-hook.ts:2` |
| D71 | 常驻交互式终端工具族（open/send/read/signal/close/list），由 herdr pane 承载 | `packages/pier-ext/src/core/terminal.ts:57` |
| D75 | TodosService 运行时配置提取与 strict/parallel 执行模式分流 | `packages/pier-ext/src/core/todo.ts:304` |
| D76 | 角色档案规范 v2（role manifest v2）及规则校验器（三态规则系统） | `packages/pier-ext/schemas/role-manifest.schema.json:4` |
| D77 | 可见层裁剪：session_start 时将角色 manifest 以外的工具从模型工具集视野中隐藏 | `packages/pier-ext/src/index.ts:288` |
| D78 | 树边界 = 进程边界（master pi 扩展与 herdr workbench 运行于独立 Cordis 服务树） | `packages/pier-ext/src/bootstrap.ts:2` |
| D79 | pi 扩展注册面代理（`pi-surface`）与 tombstone 补偿，保障重载/退出时幂等清理 | `packages/pier-ext/src/pi-surface.ts:2` |
| D80 | Cordis 生态接入：Loader group builtins、HMR fiber effect 销毁补偿与优雅降级 | `packages/pier-ext/src/bootstrap.ts:2` |
| D81 | 架构三分法裁剪（entry loader / pure core / platform adapter），worker 进程旁路跳过 Cordis 树 | `packages/pier-ext/src/bootstrap.ts:7` |
| D82 | 未知工具姿态（`unknownTools: allow/deny`）：用户安装扩展走信任关系轴，区分显式规则与默认可见性 | `packages/pier-ext/schemas/role-manifest.schema.json:30` |
| D83 | 角色继承制：`worker-default` 严格继承 `master.tools` 扣除 subagent 与 terminal 族，防止配置漂移 | `packages/pier-ext/src/role-loader.ts:9` |
| D84 | 事件环境变量载荷双形态兼容（适配直接字符串与嵌套 JSON 信封两类 dump 载荷） | `packages/pier-workbench/src/reflow.ts:205` |
| D86 | 子代理按 git worktree 分组放置（主检出进 main tab，worktree 进同名 tab；main tab 永不整关） | `packages/pier-ext/src/core/subagent.ts:655` |
| D87 | HMR 重载边界管理：保留重载边界之后的新代注册，仅清理老代遗留 | `packages/pier-ext/src/bootstrap.ts:80` |
| D90 | 热力布局档 2 修正：未入账老 pane 直接放行，避免误判为新生 pane 而错误触发账龄拦截 | `packages/pier-workbench/src/reflow.ts:131` |
| D91 | 网格原地热力布局（档 3：零 swap，仅调整 split ratio）及状态四分象形图标（`▶○■✓`） | `packages/pier-workbench/src/heat-layout.ts:2` |
| D92 | 结算通知缓冲折叠器（notice-buffer）：主控忙碌期间缓冲子代理通知，防止连续打断风暴 | `packages/pier-ext/src/notice-buffer.ts:2` |
| D93 | 侧边栏角色身份展示（`display_agent`）与 `$pi-todo` 独立 token 批次上报（与 stale 清理批次解耦） | `packages/pier-ext/src/herdr-client.ts:91` |
| D94 | 子代理同会话复用已存在 pane，检测人类打断接管状态（`userTakeover`/`observationStartedAt`） | `packages/pier-ext/src/core/subagent.ts:370` |
| D95 | 热力权重表（`blocked: 3 > ask: 2.5 > working: 1.4 > idle: 1`）、非焦点窄条衰减与数量变化重排 | `packages/pier-workbench/src/heat-layout.ts:24` |
| D96 | 主控空闲但后台子代理在跑时的结算催办提醒（按运行集去重、10 分钟冷却、abort 抑制） | `packages/pier-ext/src/settle-wake-core.ts:12` |
| D97 | 网格分裂拓扑一律向下拆（全宽横条）、默认 fullscreen TUI 模式及超小 pane 窄格静帧 overlay | `packages/pier-ext/src/core/grid-shape.ts:2` |
| D98 | isolate worktree 隔离写并发互斥防泄漏，以及 PTY resize watchdog（SIGWINCH + 1s 轮询兜底） | `packages/pier-ext/src/core/subagent.ts:601` |
| D100 | 待办驱动的在线上下文压缩（OCC）：以 todo.completed {source: 'tool'} 为进度边界，结合 KV-Cache 增量成本与窗口保护机会式压缩 | `packages/pier-ext/src/compact-economics-core.ts:130` |
| D101 | 观察结果冷热分级（ObservationPack）：整行切片安全折叠长工具输出，受前缀缓存经济学与角色门禁约束 | `packages/pier-ext/src/observation-core.ts:192` |
| D102 | 进程内测试日志保真提炼（EPR）：基于未截断输出逐字节引文验真，替换前强制归档原文且支持密钥过滤 | `packages/pier-ext/src/reducer-core.ts:117` |
| D103 | 能效多级配置与独立遥测闭环：支持环境变量覆盖、项目信任安全门控与细粒度 JSONL 审计流水 | `packages/pier-ext/src/efficiency-config-core.ts:368` |
| D104 | 配置说明只读命令与 agent 引导式改配置（5 平面目录、生效值+来源、schema 漂移守卫） | `packages/pier-ext/src/config-catalog-core.ts:1` |
| D105 | Pier 侧边栏 agent 视图不设 harness 过滤（`filter: null`，任何 agent 都显示），只保留 attention-first 排序：`agent.view.set` 全局替换 herdr 内置 Agents 投影，任何过滤都会静默隐藏未列入的 harness | `packages/pier-workbench/src/agent-view.ts:79` |
| D106 | pi 0.86 基线升级：动态工具集走 transcript 持久化（`setActiveTools` delta 存活于 resume/branch），删除 feature-detect 兼容层；`pi.on()` 原生 unsubscribe 真摘除退休世代监听（tombstone 保留给 tool/command） | `packages/pier-ext/src/pi-surface.ts:1` |
| D107 | 会话中角色切换（P0）：roleState 可变状态 + `/pier-role`（人，放宽需 confirm）+ pipe `role` 请求（master 自由）；切换以注册全集为论域重算 active（可找回被 D77 裁掉的工具）；resume 从最后一条 role-manifest entry 重放 gate manifest（变更才写防覆盖）；per-role `guidelines` 作为 `pier-role` prompt section 幂等注入 | `packages/pier-ext/src/role-state.ts:1` |
| D108 | Master 自身永不成为子代理目标（会话 01a0bd3a 自杀链）：sessionFile 归因同时排除自身会话与他人活 pane 占用（`bareSessionId` 统一比较，单一 `agent.list` 同时产出上报与占用集）；resume 命中 master pane 硬失败、revive 视中毒 sessionFile 为缺失；pane 级 GC 无条件跳过 `env.paneId`（D94 复用与 D86 主 tab 保护的补口） | `packages/pier-ext/src/subagent-session-io.ts:109` |
| D109 | 报告必达与会话恢复（01a0bd3a 后续批次）：worker 经 pipe 自报的会话 id 为权威（裸 id 映射为路径后可覆盖中毒 sessionFile；worker settle push 同样按 id 解析自读 transcript）；结算文本候选以 entry.sessionFile 为 preferred；null 收尾文本经 jev 双 Noul（尾巴归属/最终答案）分类 attribution-suspect / extraction-failed / silent，jev 不可用回落旧措辞；master resume 后对存活 running 子代理重建 poller（requestId `recover-*`）并重放 branch fold（todos/OCC 债务）；OCC 压缩失败进入指数退避（封顶 4）+ 可见失败消息 + 指令限长 | `packages/pier-ext/src/subagent-session-io.ts:143` |
