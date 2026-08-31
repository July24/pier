---
name: pi-herdr-workflow
description: >-
  How to use the pi-herdr workbench fusion: todo_write discipline, subagent
  delegation (foreground/parallel/background via action spawn/list/send/
  interrupt/resume), terminal persistent shells, and how the human watches
  everything in herdr panes.
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

The `subagent` tool has 5 operations controlled by the `action` parameter (default: `spawn`):

### spawn (default action)

Create a subagent in a new pane:
- **Foreground** (default): the call waits for a result. Use when the next step depends on it.
- **Background** (`run_in_background: true`): returns `agentId` immediately; the subagent keeps running in its own pane. Use for long / parallel work. It **persists** (own session). On settle you get a "Background subagent <id> finished..." notice.
- Multiple `subagent` calls (with `action: "spawn"`) in one message run in parallel (cap 4).
- Optional `role` (e.g. `advisor`) matches a profile when found; unknown names are labels only.

**Task-tab grouping** (`tab`):
- Each delegation defaults to a **new tab named from `description`**.
- Related subtasks share one `tab` name (e.g. web research + status probe both `tab: "research"`) so the human sees every related pane in one herdr tab.
- Keep names short (≤20 chars) and obvious; the tab bar *is* the task board.
- Do not cram unrelated work into one tab to "save tabs". One tab = one goal.
- **Task tabs are temporary**: after every subagent in the tab has settled (default grace ~10 minutes) the tab closes. Do not assume those panes last. To review or continue, use `action: "resume"` from history — do not cite a closed pane.

**Prompt discipline**:
- The prompt must be **self-contained**: the subagent cannot see your conversation, only this prompt.
- State inputs (which files / facts), outputs (what to deliver), and bounds (what not to touch).
- Share context via files / artifacts. Do not dump large blobs into the prompt.
- Delegate only independent work; dependent steps go to the same subagent.

### list

Show all background subagents with status (`running` / `idle` / `blocked`), `agentId`, and last activity.

Call: `subagent(action: "list")`

### send

Append follow-up message to background subagent:
- If working: delivered at next tool-gap (steering, seconds).
- If idle: wakes for new turn.
- After settle, `send` to wake it; do not spawn duplicate.

Call: `subagent(action: "send", agentId: "<id>", message: "...")`

### interrupt

Abort subagent's current turn (fire-and-return). Pane stays; can `send` again.

Call: `subagent(action: "interrupt", agentId: "<id>")`

### resume

Revive finished subagent from ledger by `taskId`. Opens saved conversation in new pane; then `send` work.

The ledger is an append-only JSONL file at `~/.pi/agent/herdr-pi/history/<flattened-cwd>/history.jsonl`, one row per status change. Use `list` for live panes from this session; for tasks from earlier sessions or closed panes, read/grep the ledger for the `taskId`.

Call: `subagent(action: "resume", taskId: "<uuid>")`

## 3. Human gate

- For a human decision (approval, tradeoff, direction), use `ask_user_question` (this plugin). While waiting, your pane is **blocked** in herdr so the human can see and intervene. The answer comes back as the tool result, then you continue.
- A human can enter a subagent pane directly. Write the delegation `description` (pane label) so a human understands it at a glance.

## 4. Multi-agent engineering rules

- You are the arbiter: accept each subagent's output, then merge it. Do not outsource arbitration.
- Independent review for critical conclusions (a different subagent as reviewer). Do not trust a single worker blindly.
- Homogeneous parallel workers make the same mistakes: give them different bounds and output shapes.
- After delegating, keep doing your own work. Do not idle-wait (except a foreground call).

## 5. Terminal management (master only)

The `terminal` tool has 6 operations for persistent shell sessions (dev servers, REPLs, stateful work):

### open

Create a persistent interactive terminal (resident shell in its own herdr pane) and return its `terminal_id`.

The shell keeps its cwd, environment variables, and background processes across `terminal` calls — use it for dev servers, REPLs, or multi-step shell work instead of one-shot bash calls.

Call: `terminal(action: "open", cwd: "<path>")`
Returns: `terminal_id` and readiness status (prompt detected or busy).

### send

Send a text command (plain text only, no ANSI escapes) to a persistent terminal; Enter is appended automatically.

Returns after the keystrokes are delivered — poll with `action: "read"` for output (long-running commands keep producing output across reads).

Call: `terminal(action: "send", terminal_id: "<id>", text: "npm run dev")`

### read

Read new output from a persistent terminal since your last read (cursor-based increment; the first read returns the recent buffer).

Parameters:
- `terminal_id`: your terminal from `open`. Alternatively `pane_id`: a pane in this session's own tab (narrow scope by design).
- `max_chars`: output cap for this read.

Output is ANSI-stripped and bounded; if the buffer scrolled past your last read you get a reset marker plus the current tail. Detecting a fullscreen TUI program (vim/less/top) returns an error with suggestions instead of garbage.

Call: `terminal(action: "read", terminal_id: "<id>")`

### signal

Send a control key to a persistent terminal: ctrl+c (interrupt), ctrl+d (EOF), ctrl+z (suspend), esc, enter.

Use ctrl+c to stop a running command; anything beyond this whitelist is outside the terminal seam.

Call: `terminal(action: "signal", terminal_id: "<id>", key: "ctrl+c")`

### close

Close a persistent terminal (kills its shell process tree and removes the pane).

Terminal state does not survive close — persist anything you need to files first.

Call: `terminal(action: "close", terminal_id: "<id>")`

### list

List this session's persistent terminals with open/closed and pane-liveness status.

Entries whose pane is gone (human closed it, restart) are marked closed — terminal sessions do not survive pane closure or restarts; persist state to files instead of relying on terminal reuse.

Call: `terminal(action: "list")`
