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
- herdr ≥ 0.8.0 (macOS / Linux / Windows; Windows is preview beta)

### One-shot install (recommended)

After cloning this repo:

```sh
node install.mjs                 # user mode: pi install git:… + herdr plugin install + auto-generated bootstrap config
node install.mjs install --dev   # dev mode: local-path pi install + herdr plugin link; code changes are live
```

The script verifies the environment (node / pi / herdr versions), probes pi's node
and cli.js absolute paths, generates boot-config.json (user mode stores it in the
herdr plugin config dir, so reinstalls don't lose it), and registers both halves.

Other commands: `node install.mjs update` (uninstall + reinstall, re-probes paths),
`node install.mjs uninstall --purge`. Override the distribution specs with
`--pi-spec=` / `--herdr-spec=` (npm publishing or forks).

### Manual install (equivalent steps)

```sh
# pi extension (either one; git source = user mode, local path = dev mode)
pi install git:github.com/July24/pier
pi install ./packages/pier-ext        # development

# herdr plugin
herdr plugin install July24/pier/packages/pier-workbench --yes   # user mode (reinstall = update)
herdr plugin link ./packages/pier-workbench                        # development
```

The extension degrades gracefully outside a herdr environment (see Scope below).

### Scope (only the herdr × pi intersection is affected)

- **pi outside herdr**: the extension degrades — reporting is free, workbench tools
  (`subagent`, terminal family) return a clear "requires a herdr-managed pane" error;
  `todo_write` / `ask_user_question` stay available (session JSONL is the authority,
  no herdr dependency).
- **other agents inside herdr (claude code / codex etc.)**: tabs without a pi pane
  are excluded from heat reflow; blocked notifications are pi-only; master-tab
  auto-bootstrap can be disabled with `autoBootstrap: false` in boot-config.

### Bootstrap config (workbench half)

Master-tab bootstrap needs local node / pi paths: `node install.mjs` generates
them automatically; manually, copy `packages/pier-workbench/scripts/boot-config.example.json`
(placeholders for both macOS and Windows). User mode reads it from
`herdr plugin config-dir pier.workbench`; dev mode from `packages/pier-workbench/scripts/boot-config.json`.

### Usage

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
npm test          # node --test, 244 unit tests (planner / todo replay / session tail / GC / lifecycle)
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
