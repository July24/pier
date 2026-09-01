# pi-pier

> [!IMPORTANT]
> **This npm package is only the pi-extension half of pier.** pier is a two-half system — this extension plus a **herdr plugin** (`pier.workbench`). Without the herdr side you still get `todo_write` / `ask_user_question`; `subagent` / `terminal` are not registered. Pane integration, notifications, and workspace bootstrap all require herdr. See [Install the herdr half](#install-the-herdr-half-companion-plugin) below.

**pier** = **pi** × h**erdr** — a [pi](https://pi.dev/) extension that fuses coding agent sessions with the [herdr](https://herdr.dev/) pane/tab orchestrator.

`pi-pier` fills two gaps pi deliberately leaves open — the **todo list loop** and **interactive subagents** — using herdr panes/tabs as the visual and interaction substrate. Outside herdr it loads only the todo loop.

## Install (this pi half)

```sh
pi install npm:pi-pier
```

Or from git (monorepo root, same content):

```sh
pi install git:github.com/July24/pier
```

## Install the herdr half (companion plugin)

The herdr plugin `pier.workbench` provides the other half: main-tab bootstrap (auto-start a pi master session per workspace), blocked-gate notifications (system notifications when a subagent waits for a human), and the focus-heat layout (focused pane grows in place). Install it from the same repo:

```sh
herdr plugin install July24/pier/packages/pier-workbench --yes
```

Or install **both halves at once** with the one-shot installer from the monorepo:

```sh
git clone https://github.com/July24/pier && cd pier
node install.mjs        # user mode: installs both halves + generates local bootstrap config
```

The installer also verifies node / pi / herdr versions, probes local paths, and writes the workbench bootstrap config (`boot-config.json`) into herdr's plugin config dir.

## What you get

### Tools

| Tool | Purpose |
|---|---|
| `todo_write` | Full-replacement todo list. Session JSONL is the single source of truth; correct rollback on branch switches. Projected live onto the pane title (`▶i ○p ■b ✓c (N/M) · current task`). `/todos` command to view/edit/unblock |
| `subagent` | Delegate self-contained subtasks to an isolated pi session in its own herdr pane. Actions: `spawn` (default; foreground / parallel / background), `list`, `send`, `interrupt`, `resume` |
| `terminal` | Persistent interactive shells in dedicated herdr panes. Actions: `open`, `send`, `read`, `signal`, `close`, `list` |
| `ask_user_question` | Human gate: pane shows blocked in herdr while waiting |

### Behaviors

- **Human-in-the-loop**: every subagent is a visible, interactive TUI pane — step into it anytime to talk directly (fix bugs, take over, answer its `ask_user_question`). Blocked gates raise sidebar markers + notifications
- **Soft locks**: write paths lock per-pane; conflicts warn/block instead of racing
- **Role profiles**: built-in `master` / `worker-default`; custom roles mount from `.pi-herdr/roles/<name>.json`. Toolsets converge per role — deny rules cannot be bypassed
- **Settlement notices folded**: background subagent completions inject between turns (max 3 shown, rest collapsed) instead of flood-filling at run end

## Scope & degradation

This extension mutates the pi session even outside herdr. After `pi install npm:pi-pier`:

| Surface | Bare `pi` (no `HERDR_ENV`) | Inside herdr |
|---|---|---|
| `todo_write`, `/todos`, widget, anti-freeze, stop reminder | live | live |
| `ask_user_question` | live (TUI input) | live + blocked marker |
| Hidden inject (`before_agent_start` todo-read; settle reminder) | live | live |
| `subagent`, `terminal` | **not registered** | live |
| `/locks`, write-lock on `write`/`edit` | not installed | live |
| slim-frame overlay, pane title, pipe, isolate worktree | off | live |
| `setActiveTools` role visible layer | off | on (herdr master) |

Session JSONL custom types (`pi-herdr.todo-edit`, `.subs`, `.terminals`, `.todo-read`, `.todo-reminder`, …) persist across `/resume` even without herdr.

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

**Designed coexistence:** herdr’s official `herdr:pi` reporter. Keep it. pier emits `herdr:blocked` so that plugin remains lifecycle authority.

## Requirements

- Node ≥ 22
- pi ≥ 0.84 (`@earendil-works/pi-coding-agent`)
- **herdr ≥ 0.8.0** — required for subagents / pane integration / notifications (see the IMPORTANT note above); without it only the todo loop and `ask_user_question` load

## Development

```sh
git clone https://github.com/July24/pier && cd pier
npm install --ignore-scripts
npm test   # node --test, ~250 unit tests
```

See the [monorepo README](https://github.com/July24/pier) for design principles, the herdr-plugin half, and the one-shot installer.

## License

MIT
