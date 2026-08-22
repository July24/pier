<div align="center">

# pier · pi × herdr workspace fusion

**pier** = **pi** × h**erdr** (a pier/dock — where things moor, dock, and fan out).

[pi](https://pi.dev/) (`@earendil-works/pi-coding-agent`) is the coding-agent carrier; [herdr](https://herdr.dev/) is a terminal workspace manager. pier adds the two capabilities pi deliberately leaves out — a **todo list loop** and **interactive subagents** — and gives them the herdr pane/tab layer as their visual and interactive substrate.

</div>

---

## What it is

pier ships as **two halves**, installed separately:

| Half | Package | Role |
|---|---|---|
| **pi extension** | `packages/pier-ext` (`@pier/ext`) | Injects `todo_write` / `subagent` / `list_agents` / `send_message` / `interrupt_agent` tools into a pi session, and reports pane state over the herdr socket API |
| **herdr plugin** | `packages/pier-workbench` (`pier.workbench`) | Workspace bootstrap, blocked human-gate notifications, focus heat layout (focused pane grows in place) |

### Highlights

- **Todo loop**: `todo_write` with full-replace semantics, session JSONL as source of truth, correct branch rollback; live pane-title projection `▶i ○p ■b ✓c (N/M) · current task`; `/todos` command (including unblock)
- **Interactive subagents**: every subagent = an isolated pi session in its own pane (separate context window); **a human can enter that pane and talk to it directly** (fix bugs, take over, answer ask_user_question)
- **Soft write-locks**: per-pane lock tokens on write paths; cross-pane conflicts warn or block
- **Role profiles**: built-in `master` / `worker-default`; custom roles as `.pi-herdr/roles/<name>.json`; toolset converges per role (deny rules are not bypassable)
- **Human gate**: subagent `ask_user_question` → sidebar blocked marker + notification; manual takeover (ESC-interrupt then typing) is heuristically detected so the master pauses/returns management automatically
- **Focus heat layout**: focused pane grows in place (0.72 target); blocked / ask / working / idle sized by weight; surplus panes collapse to title strips
- **Settlement notice folding**: subagent settlements no longer flood back when a long main run ends — they inject at turn gaps, up to 3 shown, the rest folded with pointers

## Installation

### Requirements

- Node ≥ 22
- pi ≥ 0.84 (`@earendil-works/pi-coding-agent`)
- herdr ≥ 0.8.0 (Windows is preview beta)

### 1. pi extension

```sh
# after cloning this repo (replace the path with your actual checkout)
pi install F:\path\to\pier\packages\pier-ext

# or during development, load the extension path directly
pi -e F:\path\to\pier\packages\pier-ext\src\index.ts
```

The extension degrades gracefully outside a herdr environment (tools unregistered, reporting is free).

### 2. herdr plugin

```sh
herdr plugin link F:\path\to\pier\packages\pier-workbench
```

### 3. Bootstrap config (optional)

`packages/pier-workbench/scripts/boot-config.json` is a **machine-local** bootstrap config (node/pi paths) and is not tracked. First use: copy the template and fill in your own absolute paths.

```sh
copy packages\pier-workbench\scripts\boot-config.example.json packages\pier-workbench\scripts\boot-config.json
```

### 4. Usage

1. Run pi inside a herdr workspace pane (`pi` in the pane); the extension detects `HERDR_ENV` and starts reporting
2. The model can call `todo_write` (live pane-title projection), `subagent` (foreground / parallel / background), `list_agents` / `send_message` / `interrupt_agent`
3. Every subagent = its own pane (observable, enterable, blocked notifies)
4. Restart recovery: herdr session restore rebuilds panes automatically (subagent rpc session files are reported); resume the parent pi session with `/resume`

## Repository layout

```
packages/
  pier-ext/        # pi extension (@pier/ext): todo/subagent tools, herdr client, vocab authority, skill
  pier-workbench/  # herdr plugin (pier.workbench): workspace bootstrap + blocked notify + heat layout
docs/              # install guide, role profile docs, sidebar role config
```

## Testing

```sh
npm install --ignore-scripts
npm test          # node --test, 242 unit tests (planner / todo replay / session tail / GC / lifecycle)
```

## Design principles

- **Session JSONL is the single source of truth**: todos, delegations, and registries replay from session branches — restart and branch switches stay correct
- **Event-driven, never poll**: state arrives via herdr event subscriptions (`pane.agent_status_changed` / `pane.closed`); one snapshot is taken only when an event fires
- **Zero position migration**: the herdr BSP layout topology is fixed at creation; pier only adjusts split ratios — panes never move, they size by priority
- **Best-effort projection layer**: reporting failures are silent and never block the pi main flow

## License

MIT

---

> 💡 **For contributors**: `.gitignore` is deliberately **not committed** to this repository (ignore rules are per-environment). Maintain your own rules based on `README.md` / `README.en.md`; `packages/pier-workbench/scripts/boot-config.json` is also machine-local (see the `.example.json` template).
>
> **Naming convention**: the brand is **pier** (repo/packages/plugin); runtime protocol identifiers keep the **`pi-herdr`** prefix (`.pi-herdr/roles/` dir, `pi-herdr.subs` session custom entries, `~/.pi/agent/herdr-pi/roles/` user dir) — they persist with user sessions/config files, renaming would break existing data, so they are the compatibility layer.
