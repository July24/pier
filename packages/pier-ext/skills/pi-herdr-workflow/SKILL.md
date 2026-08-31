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

# pi-herdr workbench workflow

You run inside a herdr terminal pane. This skill is how to use `todo_write` and
`subagent` well. The human watches live in herdr: each pane header shows
`▶x ○y ■b ✓z · current task`, and semantic state (working / blocked / idle)
rolls up to the sidebar.

## 1. Todo discipline (full-replace semantics)

- Every `todo_write` submits the **entire list** (last-wins). There is no partial update.
- An item is `content` (non-empty, unique, 5–10 word imperative phrase: *what*, not *how*, **no numeric prefix**) + `status` (`pending` | `in_progress` | `completed` | `blocked` | `abandoned`).
  - `blocked` = waiting on an external condition (info, a person, another system) and **must** include `blocker` saying what is missing; `abandoned` = explicit drop (keep the row; do not delete the plan trail).
  - Multi-phase plans may group with optional `phase` (≤30 chars). Single-phase: omit `phase`.
- Keep the list small (≤15): one item = one meaningful deliverable, not a micro-step.
- Mark what you are actually doing `in_progress` (multiple only when truly parallel); **mark `completed` the moment it is done**.
- **Never mark completed when tests fail, the implementation is incomplete, or errors remain** — stay `in_progress`, or switch to `blocked` with a blocker.
- **Never make `todo_write` the only tool call in a turn** — batch it with real work.
- If you forget an item's exact wording, copy it from the previous `todo_write` result. **Do not invent from memory** (phantom items).
- **Do not** put work you already delegated to a subagent on *your* todo list — that is the subagent's job. Your list tracks *your* work. Accept and archive after the result comes back.
- When several subagents collaborate, put **file ownership** in `content` (e.g. "refactor auth (only src/auth/)") so two agents do not fight over the same file.
- When **you** are a delegated worker pane (`PI_HERDR_SUBAGENT=1`), this plugin enforces strict mode: **at most one `in_progress`** at a time (extras are normalized), and finishing the current item auto-promotes the next `pending`. The master pane keeps parallel semantics; this section is the discipline.

## 2. Subagent delegation

A subagent pane is an **interactive pi TUI** (independent session). A human can enter that pane and talk to it at any time. Your delegation prompt appears as a message in its conversation.

### Mode

- **Foreground** (default): the call waits for a result. Use when the next step depends on it.
- **Background** (`run_in_background: true`): returns `agentId` immediately; the subagent keeps running in its own pane. Use for long / parallel work. It **persists** (own session). On settle you get a "Background subagent <id> finished..." notice.
- Multiple `subagent` calls in one message run in parallel (cap 4).
- Optional `role` (e.g. `advisor`) is a label only: v1 does not change tools or lifecycle; TTL is the same as `task`. Omit = `task`. Revive with `resume_subagent`; do not assume the pane comes back by itself.

### Task-tab grouping (`tab`)

- Each delegation defaults to a **new tab named from `description`**.
- Related subtasks share one `tab` name (e.g. web research + status probe both `tab: "research"`) so the human sees every related pane in one herdr tab.
- Keep names short (≤20 chars) and obvious; the tab bar *is* the task board.
- Do not cram unrelated work into one tab to "save tabs". One tab = one goal.
- **Task tabs are temporary**: after every subagent in the tab has settled (default grace ~10 minutes) the tab closes. Do not assume those panes last. To review or continue, `resume_subagent(taskId)` from history — do not cite a closed pane.

### Prompt discipline

- The prompt must be **self-contained**: the subagent cannot see your conversation, only this prompt.
- State inputs (which files / facts), outputs (what to deliver), and bounds (what not to touch).
- Share context via files / artifacts. Do not dump large blobs into the prompt.
- Delegate only independent work; dependent steps go to the same subagent.

### After a background spawn

- `list_agents`: all background subagents and status (`running` / `idle`).
- `send_message(agentId, message)`: append work (FIFO; a settled subagent is woken).
- `interrupt_agent(agentId)`: abort the current turn (the pane stays; you can `send_message` again).
- After settle, if you have more work for that same `agentId`, `send_message` to wake it; do not spawn a duplicate.

## 3. Human gate

- For a human decision (approval, tradeoff, direction), use `ask_user_question` (this plugin). While waiting, your pane is **blocked** in herdr so the human can see and intervene. The answer comes back as the tool result, then you continue.
- A human can enter a subagent pane directly. Write the delegation `description` (pane label) so a human understands it at a glance.

## 4. Multi-agent engineering rules

- You are the arbiter: accept each subagent's output, then merge it. Do not outsource arbitration.
- Independent review for critical conclusions (a different subagent as reviewer). Do not trust a single worker blindly.
- Homogeneous parallel workers make the same mistakes: give them different bounds and output shapes.
- After delegating, keep doing your own work. Do not idle-wait (except a foreground call).
