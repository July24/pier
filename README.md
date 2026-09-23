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
- **Subagent output preview**: `subagent(action: "output", agentId)` returns what a running background subagent has printed since the previous call — an in-memory per-pane cursor computes the delta (`agent.read`, falling back to `pane.read` on older herdr), and the result carries status, revision, truncation and a `restart` flag for scrolled/cleared buffers, so the master can notice a stuck worker instead of waiting for settlement
- **Soft write-locks**: per-pane lock beacons on `write`/`edit` paths; cross-pane conflicts warn (default) or block (`PI_HERDR_WRITE_LOCK=1`). The warning lists every holder; `/locks` is the human view of the same table (`herdr agent list` exposes the raw tokens to agents)
- **Role profiles**: built-in `master` / `worker-default`; custom roles as `.pi-herdr/roles/<name>.json`; toolset converges per role (deny rules are not bypassable)
- **Human gate**: subagent `ask_user_question` → sidebar blocked marker + notification; manual takeover (ESC-interrupt then typing) is heuristically detected so the master pauses/returns management automatically
- **Ask picker**: every choice question renders through one pier-owned picker in the TUI — single-select (arrows + enter/space pick the highlighted row) and `multi: true` toggle list (checkboxes: space toggles, `a` toggles all, live selection count) share the same framed chrome, `recommended` seeds the cursor (and pre-checks in multi), and the free-text row stays last; `allowOther: false` gives pure choice. The host select dialog and typed-index prompts remain the fallbacks for RPC mode and older pi
- **Blocking dialogs mark the pane**: pi's `ui_prompt_start` / `ui_prompt_end` events cover the inherently blocking `ctx.ui` dialogs (`select` / `confirm` / `input` / `editor`), so a dialog from *any* extension marks the pane blocked and emits the `herdr:blocked` edge; nested gates coalesce, and the ask tool no longer needs its 5s refresh heartbeat. `custom` is deliberately excluded — pi routes resident overlays through it too (pier's own slim-frame overlay never calls `done()`), which used to leave a working pane marked blocked for the whole session
- **Role gate stops early**: a denied worker tool call returns `terminate`, so a batch whose results are all terminating ends without another model round trip
- **Transcript cards**: pier's own session entries (todo edits, subagent/terminal registries, role manifests, soft approvals) and its reminder messages render as compact cards instead of raw JSON — entry/message renderers, no pi-tui dependency
- **Isolated worktree subagents (`isolate`)**: heavy parallel writers get a fresh git worktree (branch `pier/<slug>` from your HEAD under `~/.herdr/worktrees/<repo>/`) with commit discipline in the prompt; settlement carries a diff summary (commits since base, files changed, uncommitted count); merge with `git merge --no-ff` and the worktree auto-removes once merged and clean — the branch stays for audit
- **Worktree collection is ownership-scoped**: only worktrees this session registered are collected, and the running process's own directory is never a candidate — the earlier prefix match on `refs/heads/pier/` could delete a parallel session's worktree out from under it. Sweeping branches the session never registered is opt-in (`PIER_ISOLATE_SWEEP_ORPHANS=1`)
- **Ops dashboard + sidebar view (herdr 0.9)**: `herdr plugin pane open --plugin pier.workbench --entrypoint dashboard` opens a live pane/tab/agent board (roles, states, todo progress); the plugin also registers a `Pier` sidebar agent view that lists every detected agent (no harness filter) with attention-first ordering
- **Long-task lifecycle (01a03c0d review)**: observation timeout is now an inactivity budget (working slices renew it — healthy >10min tasks are no longer killed); follow_up messages deliver via steer at tool-call gaps (supplementary contracts arrive in seconds, not after the whole run); GC waits for the settlement notice to be delivered before closing panes; takeover detection attributes recent machine injections first; ledger rows carry a `via` tag, closed rows inherit their outcome, zombie running rows are swept on startup; SUBS snapshots are hash-gated. Tunables: `PIER_SUBAGENT_TIMEOUT_MS` (inactivity ms), `PIER_SETTLEMENT_WINDOW_MS` (ms), `PIER_OBSERVATION_WINDOW_MS` (ms)
- **Settlement notice folding**: subagent settlements no longer flood back when a long main run ends — they inject at turn gaps, up to 3 shown, the rest folded with pointers

## Installation

### Requirements

- Node ≥ 22
- pi ≥ 0.86.0 (`@earendil-works/pi-coding-agent`) — dynamic toolset (transcript-backed `setActiveTools` deltas) and role switching require it
- herdr ≥ 0.9.0 (macOS / Linux / Windows; Windows is preview beta)

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
docs/              # install guide, configuration overview, role profile docs, sidebar role config
```

## Testing

```sh
npm install --ignore-scripts
npm test          # node --test, 809 unit tests (planner / todo replay / anti-freeze staleness / session tail / GC / lifecycle / renderers / ask picker / subagent output / jev decision layer: diagnostic gate, notice ranking, excerpt windows)
```

## Configuration

Runtime policies and operational limits are centralized in `runtime-policy.ts` (with terminal read limits in `terminal.ts`). All timeouts use millisecond units unless specified otherwise:

| Variable | Default | Unit | Purpose |
|---|---|---|---|
| `PIER_SUBAGENT_TIMEOUT_MS` | `600000` | ms | Subagent inactivity budget / overall timeout before forced termination |
| `PIER_SETTLEMENT_WINDOW_MS` | `60000` | ms | Settlement notice window, machine injection grace period, and takeover idle threshold |
| `PIER_OBSERVATION_WINDOW_MS` | `30000` | ms | Post-settle observation window before auto-consuming finished subagents |
| `PIER_FOREGROUND_PATIENCE_MS` | `300000` | ms | Foreground execution patience before auto-demoting a subagent to background |
| `PIER_GC_TICK_MS` | `30000` | ms | Subagent garbage collection ticker interval |
| `PIER_POLL_INTERVAL_MS` | `30000` | ms | State observation polling interval for subagent state transitions |
| `PIER_READY_TIMEOUT_MS` | `90000` | ms | Subagent pane pipe readiness wait (exponential backoff; a pane that exited fails immediately with its last output attached) |
| `PIER_SESSION_TTL_SECONDS` | `600` | s | Session retention TTL after subagent exit before GC cleanup |
| `PIER_GIT_TIMEOUT_MS` | `10000` | ms | Execution timeout for git operations (worktree creation, diff summary, cleanup) |
| `PIER_FOCUS_POLL_MS` | `1500` / `0` | ms | Focus sampling for heat layout (`0` disables). Default 1500ms on Herdr <0.9.1; 0 (event-first) on 0.9.1+ |
| `PIER_TERM_READ_MAX` | `8000` | chars | Maximum terminal buffer characters read per operation |
| `PIER_TERM_IDLE_MS` | `1800000` | ms | Idle time before pier nudges about an open terminal |
| `PIER_TODO_GRACE_MS` | `30000` | ms | Settle grace before the unfinished-todo reminder |
| `PIER_TRACE` | – | flag | Write diagnostics (tool renderers, swallowed errors) to stderr |
| `PIER_JEV_ENABLE` | `0` | flag | Jev decision layer (TypeSafe System One classification) master switch; every call site fails open — see `docs/rfc-jev-integration.md` |
| `PIER_JEV_LOG` | `0` | flag | Write `efficiency-logs/jev.jsonl` (metadata + hashes only, never bodies) |
| `PIER_JEV_API_KEY` | – | – | API key; precedence env > config `jev.apiKey` > `TYPESAFE_API_KEY` |
| `PIER_JEV_MODEL` | `jev-1.13.0` | – | Pinned versioned model id (aliases drift silently and skew tuned thresholds) |
| `PIER_JEV_TIMEOUT_MS` | `2000` | ms | Total per-call budget (AbortController hard kill) |
| `PIER_JEV_MIN_CONFIDENCE` | `0.6` | – | Minimum Choice/Score confidence to adopt an answer |
| `PIER_JEV_BASE_URL` | – | – | API root override (relay/gateway) |

**Naming:** `PIER_*` is the canonical namespace for pier options; the historical `PI_HERDR_*` spelling
of the same knob is still read as an alias (an empty value counts as unset). Names handed to child
processes stay as they are (`PI_HERDR_SUBAGENT`, `PI_HERDR_ROLE_MANIFEST`, `PI_HERDR_TUI`,
`PI_HERDR_META_KEY`), because renaming them would split a running worker from its parent.
`/pier-config doctor` lists every option with its effective value and where it came from, plus the
errors pier deliberately swallowed this session.

**Focus heat:** Herdr 0.9.0 resolved mouse focus in the client and did not deliver `pane.focused`
to plugins, so each pane sampled `layout.export → focused_pane_id` and replayed the workbench
event. Herdr 0.9.1+ delivers `pane.focused` natively, so the poller defaults off. Override with
`PIER_FOCUS_POLL_MS`; `PIER_WORKBENCH_ROOT` points at a relocated plugin checkout (otherwise pier uses the
checkout the workbench hooks record in `~/.pi/agent/herdr-pi/workbench-root`).

### Efficiency mechanisms (D100–D103, opt-in)

Three token-saving mechanisms ship **disabled by default** and are safe to try one at a time:

- **ObservationPack** — large tool outputs are projected as placeholders after the first `fullSends` requests, with paged retrieval via `obs_recall` (session JSONL stays untouched).
- **EPR** — long diagnostic (`bash` test/build) logs are reduced in-process to a byte-verified evidence receipt; the raw log is archived first and stays readable.
- **OCC** — `todo_write` boundaries drive pi's native compaction under a KV-cache cost model, carrying unfinished tasks across the compaction.

```bash
PI_HERDR_OBS_PACK_ENABLE=1 PI_HERDR_OBS_PACK_LOG=1 pi   # start here
```

Full quick start, what to watch in `efficiency-logs/*.jsonl`, rollback steps and a feedback template: **[docs/efficiency-trial.md](docs/efficiency-trial.md)**.

Everything above (plus roles, pi settings, boot-config and the `PIER_*`/`PI_HERDR_*` env knobs) is also inspectable in-session:

```text
/pier-config            # 5-plane index; hands a guided change to the agent
/pier-config show all   # effective value + source (env > workspace > user > default) per key
/pier-config check      # validation across planes   ·   /pier-config doc → written report
```

Read-only by design — see **[docs/configuration.md](docs/configuration.md)** for the plane map and the "which plane do I edit?" table.

## Design principles

- **Session JSONL is the single source of truth**: todos, delegations, and registries replay from session branches — restart and branch switches stay correct
- **Event-driven, never poll**: state arrives via herdr event subscriptions (`pane.agent_status_changed` / `pane.closed`); one snapshot is taken only when an event fires
- **Zero position migration**: the herdr BSP layout topology is fixed at creation; pier only adjusts split ratios — panes never move, they size by priority
- **Best-effort projection layer**: reporting failures are silent and never block the pi main flow

## License

MIT

---

> 💡 **For contributors**: `.gitignore` is tracked in the repository. Note that `packages/pier-workbench/scripts/boot-config.json` is machine-local (see the `.example.json` template), and `docs/research/` contains local research notes ignored by `.gitignore`.
>
> **Naming convention**: the brand is **pier** (repo/packages/plugin); runtime protocol identifiers keep the **`pi-herdr`** prefix (`.pi-herdr/roles/` dir, `pi-herdr.subs` session custom entries, `~/.pi/agent/herdr-pi/roles/` user dir) — they persist with user sessions/config files, renaming would break existing data, so they are the compatibility layer.
