---
name: pi-herdr-workflow
description: >-
  How to use the pi-herdr workbench fusion: todo_write discipline, subagent
  delegation (foreground/parallel/background), list_agents/send_message/
  interrupt_agent, and how the human watches everything in herdr panes.
  Load when the user asks about multi-step plans, delegating subtasks,
  background work, or checking on running subagents.
license: MIT
---

# pi-herdr 工作台工作流

你在一个 herdr 终端工作区（pane）里运行。本 skill 教你把 `todo_write` 与
`subagent` 工具用好；人类在 herdr 的 TUI 里实时观察：每个 pane 的窗格头
显示 `▶x ○y ■b ✓z · 当前任务`，语义状态（working/blocked/idle）上卷到侧边栏。

## 1. todo 纪律（全量替换语义）

- `todo_write` 每次调用提交**完整列表**（last-wins），没有部分更新。
- 条目 = `content`（非空、唯一、5–10 词的命令式短语，写"做什么"不写"怎么做"，**不带编号前缀**）+ `status`（pending | in_progress | completed | blocked | abandoned）。
  - `blocked` = 在等外部条件（信息、人、别的系统），必须带 `blocker` 说明等什么；`abandoned` = 显式放弃（不删条目，保留计划痕迹）。
  - 多阶段计划用可选 `phase` 分组（≤30 字）；单阶段就不写 phase。
- 保持列表精简（≤15 条）：一条 = 一个有意义的交付单元，不是微步骤。
- 正在推进的标 `in_progress`（真正并行时才允许多条）；**完成立即标 completed**。
- **测试失败/实现不完整/有未解决错误时绝不算 completed**——保持 in_progress，或改成 blocked 并说明 blocker。
- **绝不把 todo_write 当成一轮里的唯一工具调用**——搭着真实工作一起提交。
- 记不清某条任务的原文时，从上一轮 todo_write 结果里找，**不许凭记忆编**（防幻影条目）。
- **不要**把已委派给子代理的工作写进自己的 todo——那是子代理自己的职责；
  你的列表只跟踪你自己的工作。等子代理结果回流后再验收归档。
- 多子代理协作时在 content 里写清**文件所有权**（例如 "重构 auth 模块（只碰 src/auth/）"），
  避免两个 agent 抢同一文件。
- **你是被委派的工作 pane**（`PI_HERDR_SUBAGENT=1`）时，本插件自动执行严格模式：
  你的列表任何时候**至多一条 in_progress**（多写会被归一化），全部完成会自动晋升下一条 pending。
  你是主控 pane 时保持并行语义，纪律由本节承担。

## 2. 子代理委派

子代理 pane 跑的是**交互式 pi TUI**（独立会话）：人类可以随时进入该 pane
直接与子代理对话；你的委派 prompt 会以消息形式出现在它的对话里。

### 选型
- **前台**（默认）：调用后等待结果返回。适合"下一步依赖其结果"的委派。
- **后台**（`run_in_background: true`）：立即返回 `agentId`；子代理在独立
  pane 常驻运行。适合长任务/并行推进。它会**持续存在**（有自己的持久会话），
  结算时你会收到一条 "Background subagent <id> finished..." 通知消息。
- 一条消息里的多个 subagent 调用会并行执行（上限 4 并发）。
- 可选 `role`（如 `advisor`）只是标签：v1 不改工具面、不改生命周期，与普通 task 一样走 TTL；省略 = `task`。复活走 `resume_subagent`，不要假设 pane 会自动补回来。

### 任务 tab 分组（`tab` 参数）
- 每个委派默认开一个**以任务命名的新 tab**（名字取自 `description`）。
- 一组相关的子任务用同一个 `tab` 名字收进同一个 tab（例如网络调研 + 现状
  摸索都用 `tab: "调研"`），人类在 herdr 里一个 tab 内看完全部相关 pane。
- 名字要短（≤20 字）、人类一眼能懂；tab 栏就是任务板。
- 不要为了少开 tab 而把无关任务塞进同一个 tab；一个 tab = 一个任务目标。
- **任务 tab 是临时的**：tab 内全部子代理结算后（默认宽限约 10 分钟）tab
  会自动关闭——不要假设它的 pane 长期存在；需要回看/继续时用
  `resume_subagent(taskId)` 从历史复活，而不是引用已关的 pane。

### prompt 纪律
- prompt 必须**自包含**：子代理看不到你的对话历史，只有这段 prompt。
- 明确输入（哪些文件/事实）、明确产出（交什么）、明确边界（不碰什么）。
- 用文件/工件传递共享上下文，不要把大段内容塞进 prompt。
- 独立任务才委派；互相依赖的工作拆给同一子代理。

### 后台子代理的后续管理
- `list_agents`：查看全部后台子代理与状态（running/idle）。
- `send_message(agentId, message)`：给子代理追加任务（FIFO；已结算的子代理
  会被唤醒继续干）。
- `interrupt_agent(agentId)`：打断子代理当前轮次（它仍驻留，可继续 send_message）。
- 子代理结算后不要重新委派同一个 agentId 之外的新任务时，可再 send_message 唤醒。

## 3. 人类闸门

- 需要人类决策（审批、取舍、方向选择）时，用 `ask_user_question`（本插件提供）——
  等待回答期间，你的 pane 在 herdr 里呈 **blocked** 状态，人类会看到并介入；
  答案会作为工具结果回到你的上下文，然后继续工作。
- 子代理 pane 在 herdr 里可被人类直接进入交互；你的委派描述（pane 标签）
  要写得人类一眼能懂。

## 4. 多 agent 纪律（工程实践映射）

- 你是仲裁者：验收每个子代理的输出，再合入你的工作；不要把仲裁权下放。
- 关键结论安排独立复核（换个子代理 reviewer 复核），不盲信单一子代理。
- 同构的并行子代理会犯同样的错：给不同子代理不同的任务边界与产出格式。
- 委派后继续做你自己的事，不要干等（前台调用除外）。
