# pi-pier

**pier** = **pi** × h**erdr** — a [pi](https://pi.dev/) extension that fuses coding agent sessions with the [herdr](https://herdr.dev/) pane/tab orchestrator.

`pi-pier` is the **pi extension half** of the [pier monorepo](https://github.com/July24/pier). It fills two gaps pi deliberately leaves open — the **todo list loop** and **interactive subagents** — using herdr panes/tabs as the visual and interaction substrate. It degrades gracefully outside herdr.

## Install

```sh
pi install npm:pi-pier
```

Or from git:

```sh
pi install git:github.com/July24/pier
```

> The companion **herdr plugin half** (`pier.workbench`: main-tab bootstrap, blocked-gate notifications, focus-heat layout) is installed separately via `herdr plugin install July24/pier/packages/pier-workbench`, or all at once with the one-shot installer in the [repo](https://github.com/July24/pier): `node install.mjs`.

## What you get

### Tools

| Tool | Purpose |
|---|---|
| `todo_write` | Full-replacement todo list. Session JSONL is the single source of truth; correct rollback on branch switches. Projected live onto the pane title (`▶i ○p ■b ✓c (N/M) · current task`). `/todos` command to view/edit/unblock |
| `subagent` | Delegate self-contained subtasks to an isolated pi session in its own herdr pane (separate context window). Foreground / parallel / background modes |
| `list_agents` | Live state of background subagents (running / idle + panes) |
| `send_message` | Follow-up work for a subagent (queued if busy, wakes if idle) |
| `interrupt_agent` | Stop a subagent's current turn; it stays alive for more messages |

### Behaviors

- **Human-in-the-loop**: every subagent is a visible, interactive TUI pane — step into it anytime to talk directly (fix bugs, take over, answer its `ask_user_question`). Blocked gates raise sidebar markers + notifications
- **Soft locks**: write paths lock per-pane; conflicts warn/block instead of racing
- **Role profiles**: built-in `master` / `worker-default`; custom roles mount from `.pi-herdr/roles/<name>.json`. Toolsets converge per role — deny rules cannot be bypassed
- **Settlement notices folded**: background subagent completions inject between turns (max 3 shown, rest collapsed) instead of flood-filling at run end

## Scope & degradation

Outside a herdr environment the extension auto-degrades: herdr reporting costs nothing, `subagent` / terminal tools return "requires a herdr-managed pane" hints, while `todo_write` / `ask_user_question` keep working (session JSONL as authority, no herdr dependency).

## Requirements

- Node ≥ 22
- pi ≥ 0.84 (`@earendil-works/pi-coding-agent`)
- herdr ≥ 0.8.0 for the full pane experience (optional)

## Development

```sh
git clone https://github.com/July24/pier && cd pier
npm install --ignore-scripts
npm test   # node --test, ~250 unit tests
```

See the [monorepo README](https://github.com/July24/pier) for design principles, the herdr-plugin half, and the one-shot installer.

## License

MIT
