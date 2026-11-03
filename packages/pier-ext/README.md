# pi-pier

> [!IMPORTANT]
> **This package is the whole of pier**: a pi extension. It talks to **[herdr-core](https://herdr.dev/)** (`hc`) for terminals and status, and the optional **Herdr app** displays those terminals. Without a core terminal (`HC_TERMINAL_ID` / `HC_TERMINAL_SOCKET`) you still get `todo_write` / `ask_user_question`; `subagent` / `terminal` are not registered.

**pier** = **pi** × h**erdr** — a [pi](https://pi.dev/) extension that fuses coding agent sessions with terminals managed by [herdr-core](https://herdr.dev/).

`pi-pier` fills two gaps pi deliberately leaves open — the **todo list loop** and **interactive subagents** — using core terminals as the visual and interaction substrate. Outside a core terminal it loads only the todo loop.

## Install (this pi half)

```sh
pi install npm:pi-pier
```

Or from git (monorepo root, same content):

```sh
pi install git:github.com/July24/pier
```

Then install herdr-core (required for subagents) and, optionally, the Herdr app:

```sh
curl -fsSL https://releases.herdr.dev/core/install.sh | sh   # hc ≥ 0.1.16
# Herdr app: https://herdr.dev/
```

Or install everything at once with the one-shot installer from the monorepo:

```sh
git clone https://github.com/July24/pier && cd pier
node install.mjs        # user mode: installs the pi extension
```

The installer verifies node / pi / `hc` versions and prints an informational line for `herdr-app`.

## What you get

### Tools

| Tool | Purpose |
|---|---|
| `todo_write` | Full-replacement todo list. Session JSONL is the single source of truth; correct rollback on branch switches. Progress shows in the resident widget and `/todos`; the list is mirrored into a `pier.todo` terminal label only so the master can rebuild worker summaries (no pane-title projection). `/todos` command to view/edit/unblock |
| `subagent` | Delegate self-contained subtasks to an isolated pi session in its own herdr-core terminal. Actions: `spawn` (default; foreground / parallel / background), `list`, `send`, `interrupt`, `resume`, `output` (incremental preview of a running subagent's terminal output), `role` (switch that worker's role profile mid-session — pi records the toolset change as a transcript delta, so it applies on the worker's next request and survives resume), `help` (the full manual — placement, isolate, roles, ledger — kept out of the per-request description). Every spawned task gets a stable slug: outputs print `slug@paneId`, and `agentId` accepts the slug, the terminal id, or the combined form |
| `terminal` | Persistent interactive shells in dedicated herdr-core terminals. Actions: `open`, `send`, `read`, `signal`, `close`, `list` |

### Commands

| Command | Purpose |
|---|---|
| `/todos` | Show the todo list, or edit it: `/todos done\|drop\|rm\|unblock <fuzzy match>` |
| `/pier-tree` | Master only: the full delegation tree — your complete todo list plus every running subagent's full list (live-pushed over the pipe) and settled nodes with ages. Opens as an in-pi overlay (`ui.custom`; `esc`/`q` closes, live refresh while open). Bare pi / RPC mode falls back to the in-pane notify view. The resident widget stays one line per agent and hides entirely once the self list is fully completed (D113/D114) |
| `/locks` | Show write locks held by this terminal and by live terminals — the **human/operator view** of the `pier.lock.<hash>` labels (herdr-core only). Agents see the holders inside their own write warnings; raw labels are readable via `hc get <terminal> --json` |
| `/pier-role` | Show the current role + available role names, or switch mid-session: `/pier-role <name>` (widening beyond the current toolset asks for confirmation; the switch lands as a transcript tool delta) |
| `/pier-config` | Read-only configuration guide over four planes: bare call = index + hands a guided change to the agent; `show [plane\|all]` = effective value + source (`env > workspace > user > default`); `check` = validate all planes; `doc [path]` = write a report |

`/dashboard` was removed in the core migration — the app-side plugin and its panels no longer exist.

### Behaviors

- **Human-in-the-loop**: every subagent is a visible terminal the Herdr app lists under its master (a pane only with `tab`) — peek at it anytime to talk directly (fix bugs, answer its `ask_user_question`). Status reaches the app through pi's native OSC 7501 report; pier does not synthesize it.
- **Delegation identity**: the worker knows who delegated it — spawn env (`PI_HERDR_DELEGATION`) replays from the session's own first-frame entry; its system prompt carries a `pier-delegation` section (identity + delivery contract), and the transcript opens with an "⟵ delegated by master …" card
- **Blocking dialogs report blocked**: pi 1.4's native OSC 7501 reporter covers the inherently blocking `ctx.ui` dialogs (`select` / `confirm` / `input` / `editor`) and permission dialogs from any extension. pier adds the `ui.custom` ask overlay — pi does not report it — so pier writes `blocked` while it is open and restores `working`/`idle` when it closes. Nested gates are coalesced.
- **Role gate stops early**: a tool call denied by the role manifest returns `terminate`, so a batch whose results are all terminating ends without another model round trip
- **Readable transcript**: pier's own session entries (todo edits, subagent/terminal registries, role manifests, soft approvals) and its reminder messages render as compact cards instead of raw JSON
- **Soft locks**: write paths publish per-terminal `pier.lock.<hash>` labels; conflicts warn (default) or block (`PI_HERDR_WRITE_LOCK=1`) instead of racing silently. Warnings name **every** holder — the audience split is: agent reads its own tool-result warning, human reads `/locks` (or `hc get <terminal> --json` for the raw label table). `write`/`edit` only — `bash` writes are not covered
- **Role profiles**: built-in `master` / `worker-default`; custom roles mount from `.pi-herdr/roles/<name>.json`. Toolsets converge per role — deny rules cannot be bypassed. A role manifest may carry `guidelines` (behavior constraints a toolset cannot express); they ride the system prompt as a `pier-role` section each turn. `subagent spawn` takes `role` as an enum of the profiles present when pier loads (no invented names); humans switch the terminal they are in via `/pier-role`
- **Settlement notices folded**: background subagent completions inject between turns (max 3 shown, rest collapsed) instead of flood-filling at run end

## Scope & degradation

This extension mutates the pi session even outside a core terminal. After `pi install npm:pi-pier`:

| Surface | Bare `pi` (no `HC_TERMINAL_ID` / `HC_TERMINAL_SOCKET`) | Inside herdr-core |
|---|---|---|
| `todo_write`, `/todos`, widget, anti-freeze, stop reminder | live | live |
| `ask_user_question` | live (TUI picker for single and multi; host select dialog / typed prompts as RPC fallback) | live + blocked report while the overlay is open |
| Blocked reporting for blocking `ctx.ui` dialogs (`select`/`confirm`/`input`/`editor`) | live | live |
| Hidden inject (`before_agent_start` todo-read; settle reminder) | live | live |
| `subagent`, `terminal` | **not registered** | live |
| `/locks`, write-lock on `write`/`edit` | not installed | live |
| `/pier-config` (read-only config guide over 4 planes) | live | live |
| slim-frame overlay, pipe, isolate worktree | off | live |
| `setActiveTools` role visible layer | off | on (master) |

Session JSONL custom types (`pi-herdr.todo-edit`, `.subs`, `.terminals`, `.todo-read`, `.todo-reminder`, …) persist across `/resume` even without core.

## Plugin conflicts

pi overwrites tools/commands by name; event listeners stack.

**Do not install alongside** (same-name overwrite → wrong handler, split JSONL):

- [`@nguyenquangthai/pi-todo`](https://pi.dev/packages/@nguyenquangthai/pi-todo) — `todo_write` + overlay
- [`@josephyoung/pi-ask-user-question`](https://pi.dev/packages/@josephyoung/pi-ask-user-question) — `ask_user_question`
- [`pi-herdr-subagents`](https://pi.dev/packages/pi-herdr-subagents) — `subagent` + herdr panes

**Soft conflict** (two orchestrators / two injectors — the agent “talks to itself”):

- [`@tintinweb/pi-subagents`](https://pi.dev/packages/@tintinweb/pi-subagents) (`Agent`)
- [`@minhduydev/pi-subagents`](https://pi.dev/packages/@minhduydev/pi-subagents) (`task`)
- any other extension that calls `setActiveTools`, `ui.custom` overlay, `before_agent_start`, or `sendUserMessage`/`sendMessage` followUp

**Status ownership:** pi's native OSC 7501 reporter is the only status source; pier never writes terminal status. Do not add a second OSC 7501 reporter for the same terminal.

## Requirements

- Node ≥ 22
- pi ≥ 1.4.0 (`@earendil-works/pi-coding-agent`) — the native OSC 7501 reporter is required
- **herdr-core `hc` ≥ 0.1.16** — required for subagents / terminal integration; `curl -fsSL https://releases.herdr.dev/core/install.sh | sh`
- Herdr app (optional) — display only

**The last TUI-compatible release is 0.4.3.** The core-only cutover is the `feat/core-app-migration` branch.

## Development

```sh
git clone https://github.com/July24/pier && cd pier
npm install --ignore-scripts
npm test   # typecheck + node --test
```

See the [monorepo README](https://github.com/July24/pier) for design principles and the one-shot installer.

## License

MIT
