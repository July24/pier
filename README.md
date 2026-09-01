<div align="center">

# pier · pi × herdr workspace fusion

**English** · [中文](README_ZH.md)

**pier** = **pi** × h**erdr** (a pier/dock — where things moor, dock, and fan out).

[pi](https://pi.dev/) (`@earendil-works/pi-coding-agent`) is the coding-agent carrier; [herdr](https://herdr.dev/) is a terminal workspace manager. pier adds the two capabilities pi deliberately leaves out — a **todo list loop** and **interactive subagents** — and gives them the herdr pane/tab layer as their visual and interactive substrate.

</div>

---

## What it is

pier ships as **two halves**, installed separately:

| Half | Package | Role |
|---|---|---|
| **pi extension** | `packages/pier-ext` (npm: [`pi-pier`](https://www.npmjs.com/package/pi-pier), [pi.dev gallery](https://pi.dev/packages/pi-pier)) | Injects `todo_write` / `subagent` / `terminal` / `ask_user_question` tools into a pi session, and reports pane state over the herdr socket API |
| **herdr plugin** | `packages/pier-workbench` (`pier.workbench`) | Workspace bootstrap, blocked human-gate notifications, focus heat layout (focused pane grows in place) |

### Highlights

- **Todo loop**: `todo_write` with full-replace semantics, session JSONL as source of truth, correct branch rollback; live pane-title projection `▶i ○p ■b ✓c (N/M) · current task`; TUI widget is an activity-anchored window (the in_progress entry and its surrounding context stay visible as work moves down the list); `/todos` command (including unblock)
- **Todo anti-freeze**: an all-completed list unchanged for ≥6 turns flips the read hook from recitation to a rewrite warning; after ≥1h it archives — first offering one rewrite window with old entries as reference, then (if ignored) a final notice that clears the list (rm persisted to JSONL; the empty guard takes over — multi-step work must re-track); `/todos` still shows history, session JSONL untouched
- **Interactive subagents**: every subagent = an isolated pi session in its own pane (separate context window); **a human can enter that pane and talk to it directly** (fix bugs, take over, answer ask_user_question)
- **Soft write-locks**: per-pane lock tokens on write paths; cross-pane conflicts warn or block
- **Role profiles**: built-in `master` / `worker-default`; custom roles as `.pi-herdr/roles/<name>.json`; toolset converges per role (deny rules are not bypassable)
- **Human gate**: subagent `ask_user_question` → sidebar blocked marker + notification; manual takeover (ESC-interrupt then typing) is heuristically detected so the master pauses/returns management automatically
- **Isolated worktree subagents (`isolate`)**: heavy parallel writers get a fresh git worktree (branch `pier/<slug>` from your HEAD under `~/.herdr/worktrees/<repo>/`) with commit discipline in the prompt; settlement carries a diff summary (commits since base, files changed, uncommitted count); merge with `git merge --no-ff` and the worktree auto-removes once merged and clean — the branch stays for audit
- **Long-task lifecycle (01a03c0d review)**: observation timeout is now an inactivity budget (working slices renew it — healthy >10min tasks are no longer killed); follow_up messages deliver via steer at tool-call gaps (supplementary contracts arrive in seconds, not after the whole run); GC waits for the settlement notice to be delivered before closing panes; takeover detection attributes recent machine injections first; ledger rows carry a `via` tag, closed rows inherit their outcome, zombie running rows are swept on startup; SUBS snapshots are hash-gated. Tunables: `PI_HERDR_SUBAGENT_TIMEOUT_MS` (inactivity seconds), `PI_HERDR_INJECT_GRACE_MS`, `PI_HERDR_OBSERVE_MS`
- **Settlement notice folding**: subagent settlements no longer flood back when a long main run ends — they inject at turn gaps, up to 3 shown, the rest folded with pointers

## Installation

### Requirements

- Node ≥ 22
- pi ≥ 0.84 (`@earendil-works/pi-coding-agent`)
- herdr ≥ 0.8.0 (macOS / Linux / Windows; Windows is preview beta)

### One-shot install (recommended)

No clone needed — run the npm package directly:

```sh
npx pier-setup@latest            # user mode: pi install npm:pi-pier + herdr plugin install
npx pier-setup@latest version    # local vs npm latest (installer / pi-pier / herdr plugin)
npx pier-setup@latest update     # refresh both halves in place (does not uninstall first)
npx pier-setup@latest uninstall  # --purge also drops boot-config.json

npm i -g pier-setup              # or install globally, then: pier-setup / version / update
```

Pin `@latest` so npx does not reuse a cached installer. In a clone, `npm install`
links `node_modules/.bin/pier-setup`, so in-repo `npx pier-setup` runs `./install.mjs`.

Dev mode still requires cloning the repo:

```sh
git clone https://github.com/July24/pier && cd pier
node install.mjs install --dev   # local-path pi install + herdr plugin link; code changes are live
node install.mjs version --dev
node install.mjs update --dev    # rewrite boot-config only; pull the repo yourself
```

The script verifies the environment (node / pi / herdr versions), probes pi's node
and cli.js absolute paths, generates boot-config.json (user mode stores it in the
herdr plugin config dir, so reinstalls don't lose it), and registers both halves.

`update` re-runs `pi update npm:pi-pier` (falls back to `pi install`) and
`herdr plugin install … --yes`, then rewrites boot-config. Override sources with
`--pi-spec=` / `--herdr-spec=` (npm publishing or forks). `pier-setup --help`
lists every command.

### Manual install (equivalent steps)

```sh
# pi extension (any one; npm source = recommended user mode, git source = latest main, local path = dev mode)
pi install npm:pi-pier                # user mode (npm release, auto-listed on the pi.dev/packages gallery)
pi install git:github.com/July24/pier # user mode (tracks main)
pi install ./packages/pier-ext        # development

# herdr plugin
herdr plugin install July24/pier/packages/pier-workbench --yes   # user mode (reinstall = update)
herdr plugin link ./packages/pier-workbench                        # development
```

The extension degrades gracefully outside a herdr environment (see Scope below).

### Scope (what the pi extension mutates)

`pi-pier` is not dormant outside herdr. After install it is live in every pi session:

| Surface | Bare `pi` | Inside herdr |
|---|---|---|
| `todo_write`, `/todos`, widget, anti-freeze, stop reminder | live | live |
| `ask_user_question` | live | live + blocked marker |
| Hidden inject (`before_agent_start` todo-read; settle reminder) | live | live |
| `subagent`, `terminal` | **not registered** | live |
| `/locks`, write-lock, slim-frame, pane title, pipe | off | live |
| `setActiveTools` role visible layer | off | on (herdr master) |

Session JSONL custom types (`pi-herdr.todo-edit`, `.subs`, `.terminals`, `.todo-read`, `.todo-reminder`, …) persist across `/resume` even without herdr.

### Plugin conflicts

pi overwrites tools/commands by name; event listeners stack. Two todo or subagent plugins will silently replace each other.

**Do not install alongside** (same-name overwrite → wrong handler, split JSONL):

- [`@nguyenquangthai/pi-todo`](https://pi.dev/packages/@nguyenquangthai/pi-todo) — `todo_write` + overlay
- [`@josephyoung/pi-ask-user-question`](https://pi.dev/packages/@josephyoung/pi-ask-user-question) — `ask_user_question`
- [`pi-herdr-subagents`](https://pi.dev/packages/pi-herdr-subagents) — `subagent` + herdr panes

**Soft conflict** (two orchestrators / two injectors — the agent “talks to itself”):

- [`@tintinweb/pi-subagents`](https://pi.dev/packages/@tintinweb/pi-subagents) (`Agent`)
- [`@minhduydev/pi-subagents`](https://pi.dev/packages/@minhduydev/pi-subagents) (`task`)
- any other extension that calls `setActiveTools`, `ui.custom` overlay, `before_agent_start`, or `sendUserMessage`/`sendMessage` followUp

**Designed coexistence:** herdr’s official `herdr:pi` reporter. Keep it. pier emits `herdr:blocked` so that plugin remains lifecycle authority.

- **other agents inside herdr (claude code / codex etc.)**: tabs without a pi pane
  are excluded from heat reflow; blocked notifications are pi-only; master-tab
  auto-bootstrap can be disabled with `autoBootstrap: false` in boot-config.

### Bootstrap config (workbench half)

Master-tab bootstrap needs local node / pi paths: `pier-setup` generates
them automatically; manually, copy `packages/pier-workbench/scripts/boot-config.example.json`
(placeholders for both macOS and Windows). User mode reads it from
`herdr plugin config-dir pier.workbench`; dev mode from `packages/pier-workbench/scripts/boot-config.json`.

### Usage

1. Run pi inside a herdr workspace pane (`pi` in the pane); the extension detects `HERDR_ENV` and starts reporting
2. The model can call `todo_write` (live pane-title projection), `subagent` (spawn / list / send / interrupt / resume), `terminal` (open / send / read / signal / close / list)
3. Every subagent = its own pane (observable, enterable, blocked notifies)
4. Restart recovery: herdr session restore rebuilds panes automatically (subagent rpc session files are reported); resume the parent pi session with `/resume`

## Repository layout

```
packages/
  pier-ext/        # pi extension (npm: pi-pier): todo/subagent tools, herdr client, vocab authority, skill
  pier-workbench/  # herdr plugin (pier.workbench): workspace bootstrap + blocked notify + heat layout
docs/              # install guide, role profile docs, sidebar role config
```

## Testing

```sh
npm install --ignore-scripts
npm test          # node --test, 278 unit tests (planner / todo replay / anti-freeze staleness / session tail / GC / lifecycle)
```

## Design principles

- **Session JSONL is the single source of truth**: todos, delegations, and registries replay from session branches — restart and branch switches stay correct
- **Event-driven, never poll**: state arrives via herdr event subscriptions (`pane.agent_status_changed` / `pane.closed`); one snapshot is taken only when an event fires
- **Zero position migration**: the herdr BSP layout topology is fixed at creation; pier only adjusts split ratios — panes never move, they size by priority
- **Best-effort projection layer**: reporting failures are silent and never block the pi main flow

## License

MIT

---

> 💡 **For contributors**: `.gitignore` is deliberately **not committed** to this repository (ignore rules are per-environment). Maintain your own rules based on `README.md` / `README_ZH.md`; `packages/pier-workbench/scripts/boot-config.json` is also machine-local (see the `.example.json` template).
>
> **Naming convention**: the brand is **pier** (repo/packages/plugin); runtime protocol identifiers keep the **`pi-herdr`** prefix (`.pi-herdr/roles/` dir, `pi-herdr.subs` session custom entries, `~/.pi/agent/herdr-pi/roles/` user dir) — they persist with user sessions/config files, renaming would break existing data, so they are the compatibility layer.
