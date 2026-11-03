<div align="center">

# pier · pi × herdr-core workspace fusion

**English** · [中文](README_ZH.md)

**pier** = **pi** × h**erdr** (a pier/dock — where things moor, dock, and fan out).

[pi](https://pi.dev/) (`@earendil-works/pi-coding-agent`) is the coding-agent carrier. [herdr-core](https://herdr.dev/) (`hc`) runs terminals that stay alive; the **Herdr app** shows them as spaces, tabs and panes. pier adds the two capabilities pi deliberately leaves out — a **todo list loop** and **interactive subagents** — and uses those core terminals as their visual and interactive substrate. There is no app-side mod: the Herdr app's built-in sidebar and notifications are enough.

</div>

---

## What it is

pier is **one pi extension** plus the two external programs it talks to:

| Piece | Package | Role |
|---|---|---|
| **pi extension** | `packages/pier-ext` (npm: [`pi-pier`](https://www.npmjs.com/package/pi-pier), [pi.dev gallery](https://pi.dev/packages/pi-pier)) | Injects `todo_write` / `subagent` / `terminal` / `ask_user_question` tools into a pi session, and starts/reads worker terminals through herdr-core |
| **herdr-core** | `hc` ≥ 0.1.16 | Terminal server: `terminal.run/read/wait/send/keys/interrupt/label/kill/rm` plus status and events over `HC_TERMINAL_SOCKET` |
| **Herdr app** | `herdr-app` (optional) | Displays core terminals as spaces/tabs/panes; its built-in sidebar shows agents and gives blocked notifications |

### Architecture (what talks to what)

- pier talks to core over the terminal socket it inherits (`HC_TERMINAL_SOCKET`, own address `HC_TERMINAL_ID`).
- A worker is one `terminal.run {argv, cwd, env, parent: master, noNotify: true}` call (D140). Core starts the program; with no placement labels the app lists it as a **sub-agent under the master** (peek to watch or type; closing the master ends it). Only an explicit `tab` adds `herdr.space`/`herdr.tab` labels: the app then adopts it as an unfocused pane of that tab, creating a **new** tab for a new `herdr.tab` id — pier never calls app commands, and never does placement math.
- A worker's program ends with the master's program (`die_with_parent`); pier closes terminals through `terminal.kill` + `terminal.rm`.
- **Status comes only from pi's native OSC 7501 report**, which core stores and the app renders. pier never writes terminal status. `ask_user_question` is the one gap — it is a `ui.custom` overlay that pi does not report — so pier reports `blocked` while that overlay is open and restores `working`/`idle` when it closes.
- Metadata lives in **terminal labels**, and only ones with a reader inside pier: `pier.session` (the worker's own session file), `pier.todo` (worker todo summary, read by the master to rebuild summaries), `pier.lock.<hash>` (write-lock beacons).
- master ↔ worker private messages keep using **pipe-channel** (a private local socket per pair), never PTY injection. Core's parent notes are disabled (`noNotify: true`) because PTY input belongs to humans (D45).

### Highlights

- **Todo loop**: `todo_write` with full-replace semantics, session JSONL as source of truth, correct branch rollback; `/todos` command (including unblock) and the resident status widget show progress. The list is mirrored into a `pier.todo` terminal label only so the master can rebuild a worker's summary; there is no pane-title projection.
- **Todo anti-freeze**: an all-completed list unchanged for ≥6 turns flips the read hook from recitation to a rewrite warning; after ≥1h it archives — first offering one rewrite window with old entries as reference, then (if ignored) a final notice that clears the list (rm persisted to JSONL; the empty guard takes over — multi-step work must re-track); `/todos` still shows history, session JSONL untouched
- **Interactive subagents**: every subagent = an isolated pi session in its own core terminal (separate context window); the app lists it under the master (a pane only with `tab`), and **a human can peek at that terminal and talk to it directly** (fix bugs, answer ask_user_question). Blocked state reaches the app through pi's native OSC 7501 report.
- **Delegation identity** (D111): spawn hands the worker a `PI_HERDR_DELEGATION` context (parent terminal/session, taskId, task, role), replayed from the spawn env and the session's own first-frame entry; the worker's system prompt gains a `pier-delegation` section (identity + one stable delivery contract), and its transcript opens with an "⟵ delegated by master …" card
- **Task slugs** (D112): spawn allocates a task slug (numbered on collision); tool outputs print `slug@paneId` and `agentId` accepts the bare slug, bare terminal id, or the combined form (the slug part survives a revive that changed the terminal). A master bash call that sleeps ≥60 s while background workers run gets a note pointing at `subagent wait` (D125/D144; the earlier `report_progress` tool was never called and is gone)
- **Unified status widget** (D113/D114): the resident widget is one line per agent — self as `▶ current item ✓done/total`, each running subagent as `↳ slug ▶ current item ✓d/n` (blocked shows the task + reason; settled rows never occupy the strip; a fully completed self list hides the widget instead of showing a bare `✓N/N`); workers push their full todo list over the pipe on every `todo_write` (event-driven, no polling), and `/pier-tree` opens the complete delegation tree (your todos + every worker's full list + settled nodes) as a **pi overlay** (`ui.custom`, `esc`/`q` closes, live refresh while open; bare pi / RPC mode falls back to the in-pane notify view)
- **Subagent output preview**: `subagent(action: "output", agentId)` returns what a running background subagent has printed since the previous call — an in-memory per-terminal cursor computes the delta via core `terminal.read`, and the result carries status, revision, truncation and a `restart` flag for scrolled/cleared buffers, so the master can notice a stuck worker instead of waiting for settlement. Once the worker has finished, the complete transcript report replaces the terminal's lossy rendered copy, and a later settlement notice points at that delivery instead of repeating it (D124)
- **Blocking subagent wait** (D144): `subagent(action: "wait", agentId?)` blocks until a worker settles, fails, closes or starts waiting on a human, and returns that notice — final report included — as the tool result; the notice is taken out of the turn-gap buffer so it is never delivered twice. It replaces `sleep` and repeated `list`/`output` polling while the master has nothing else to do
- **Terminal commands with exit codes** (D145): `terminal(action: "send", text, wait: true)` appends a nonce'd exit sentinel itself and returns the exit code plus the command's output; hand-written sentinels and the echo trap they fell into are only needed for output that never ends (a server's "listening on")
- **Soft write-locks**: each terminal publishes lock beacons as `pier.lock.<hash>` labels on `write`/`edit` paths; cross-terminal conflicts warn (default) or block (`PI_HERDR_WRITE_LOCK=1`). The warning lists every holder; `/locks` is the human view of the same table, and `hc get <terminal> --json` exposes the raw labels to agents
- **Role profiles**: built-in `master` / `worker-default`; custom roles as `.pi-herdr/roles/<name>.json`; toolset converges per role (deny rules are not bypassable); `subagent spawn` offers `role` as an enum of the profiles present when pier loads
- **Human gate**: subagent `ask_user_question` → the terminal is reported blocked, so the app shows it and (per its own rules) notifies; the answer returns as the tool result. There is no heuristic "human takeover" detection any more.
- **Ask picker**: every choice question renders through one pier-owned picker in the TUI — single-select (arrows + enter/space pick the highlighted row) and `multi: true` toggle list (checkboxes: space toggles, `a` toggles all, live selection count) share the same framed chrome, `recommended` seeds the cursor (and pre-checks in multi), and the free-text row stays last; `allowOther: false` gives pure choice. `tab` folds the picker to a two-line bar so the transcript above gets the room, and `tab` again unfolds it with cursor and toggles intact; while folded only `tab` acts, so enter/esc cannot answer or decline blind. The host select dialog and typed-index prompts remain the fallbacks for RPC mode and older pi
- **Blocking dialogs report blocked**: pi 1.4's native OSC 7501 reporter covers `select` / `confirm` / `input` / `editor` and permission dialogs from *any* extension; pier only adds the `ui.custom` ask overlay. Nested gates coalesce.
- **Role gate stops early**: a denied worker tool call returns `terminate`, so a batch whose results are all terminating ends without another model round trip
- **Transcript cards**: pier's own session entries (todo edits, subagent/terminal registries, role manifests, soft approvals) and its reminder messages render as compact cards instead of raw JSON — entry/message renderers, no pi-tui dependency
- **Isolated worktree subagents (`isolate`)**: heavy parallel writers get a fresh git worktree (branch `pier/<slug>` from your HEAD under `~/.herdr/worktrees/<repo>/`) with commit discipline in the prompt; settlement carries a diff summary (commits since base, files changed, uncommitted count); merge with `git merge --no-ff` and the worktree auto-removes once merged and clean — the branch stays for audit
- **Worktree collection is ownership-scoped**: only worktrees this session registered are collected, and the running process's own directory is never a candidate — the earlier prefix match on `refs/heads/pier/` could delete a parallel session's worktree out from under it. Sweeping branches the session never registered is opt-in (`PIER_ISOLATE_SWEEP_ORPHANS=1`)
- **Long-task lifecycle (01a03c0d review)**: observation timeout is an inactivity budget (working slices renew it — healthy >10min tasks are no longer killed); follow_up messages deliver via steer at tool-call gaps (supplementary contracts arrive in seconds, not after the whole run); GC waits for the settlement notice to be delivered before closing terminals; ledger rows carry a `via` tag, closed rows inherit their outcome, zombie running rows are swept on startup; SUBS snapshots are hash-gated. Tunables: `PIER_SUBAGENT_TIMEOUT_MS` (inactivity ms), `PIER_SETTLEMENT_WINDOW_MS` (ms), `PIER_OBSERVATION_WINDOW_MS` (ms)
- **Settlement notice folding**: subagent settlements no longer flood back when a long main run ends — they inject at turn gaps, up to 3 shown, the rest folded with pointers

### Removed in the core migration

The TUI backend is gone in one cutover; there is no dual-backend switch:

- **Restart resume**: worker terminals are no longer re-created after a core/app restart. `subagent(action: "resume")` from the ledger still works — it opens a *new* terminal with `pi --session <file>`.
- **Human-takeover detection** (D94): ESC-interrupt-then-typing is no longer heuristically detected.
- **Heat reflow / focus layout**: no focus-based pane resizing or spawn placement math; the app places panes by its own rules.
- **`/dashboard`, the app-side plugin and sidebar token rows**: the whole app-side plugin, `display_agent` / `pi-ask` / `pi-parent` / `pi-task` tokens, and pane-title projection are deleted. `/pier-tree` now renders inside pi as an overlay.
- The **80-character pane-title truncation** and `agentExplain` are gone with the pane-title channel.

**The last Herdr TUI release is 0.4.3** (npm; source at git tag `tui-final`). Still on the Herdr TUI? Stay there with `npx pier-setup@0.4.3`.
Upgrading from it: `install` / `update` / `uninstall` detect the old herdr plugin `pier.workbench` and ask whether to remove it
(`--remove-legacy` / `--keep-legacy` answer up front; non-interactive runs keep it and print the `herdr plugin …` command).

## Installation

### Requirements

- Node ≥ 22
- pi ≥ 1.4.0 (`@earendil-works/pi-coding-agent`) — the native OSC 7501 program-status reporter is the only status source
- herdr-core ≥ 0.1.16 (`hc`) — `curl -fsSL https://releases.herdr.dev/core/install.sh | sh`
- Herdr app (optional) — displays core terminals; without it pi still runs and pier still spawns workers, you just cannot watch them in a window

### One-shot install (recommended)

No clone needed — run the npm package directly:

```sh
npx pier-setup@latest            # user mode: pi install npm:pi-pier (preflights node / pi / hc)
npx pier-setup@latest version    # local vs npm latest (installer / pi-pier / herdr-core)
npx pier-setup@latest update     # refresh the extension in place (does not uninstall first)
npx pier-setup@latest uninstall

npm i -g pier-setup              # or install globally, then: pier-setup / version / update
```

Pin `@latest` so npx does not reuse a cached installer. In a clone, `npm install`
links `node_modules/.bin/pier-setup`, so in-repo `npx pier-setup` runs `./install.mjs`.

Dev mode still requires cloning the repo:

```sh
git clone https://github.com/July24/pier && cd pier
node install.mjs install --dev   # local-path pi install; code changes are live
node install.mjs version --dev
node install.mjs update --dev    # re-check env + versions; pull the repo yourself
```

The script verifies the environment (node / pi / `hc` versions; `herdr-app` is only an
informational line) and registers the extension. pier must be registered in pi from
exactly one source: `install`/`update` drops the legacy `git:github.com/July24/pier`
registration automatically, and stops (exit 1, nothing changed) when pier is already
registered from another source - e.g. a `--dev` checkout before a user-mode install -
printing the `pi remove …` to run. `version` reports the source pi actually loads.
`update` re-runs `pi update npm:pi-pier` (falls back to `pi install`); override the
source with `--pi-spec=` (npm publishing or forks). `pier-setup --help` lists every command.
herdr-core and the Herdr app are independent programs: upgrade core with `hc update`, and
the installer never touches its config.

### Manual install (equivalent steps)

```sh
# herdr-core (once)
curl -fsSL https://releases.herdr.dev/core/install.sh | sh

# pi extension (any one; npm source = recommended user mode, git source = latest main, local path = dev mode)
pi install npm:pi-pier                # user mode (npm release, auto-listed on the pi.dev/packages gallery)
pi install git:github.com/July24/pier # user mode (tracks main)
pi install ./packages/pier-ext        # development
```

The extension degrades gracefully outside a herdr-core terminal (see Scope below).

### Scope (what the pi extension mutates)

`pi-pier` is not dormant outside core. After install it is live in every pi session:

| Surface | Bare `pi` | Inside a herdr-core terminal |
|---|---|---|
| `todo_write`, `/todos`, widget, anti-freeze, stop reminder | live | live |
| `ask_user_question` | live | live + blocked report while open |
| Hidden inject (`before_agent_start` todo-read; settle reminder) | live | live |
| `subagent`, `terminal` | **not registered** | live |
| `/locks`, write-lock, slim-frame, pipe | off | live |
| `setActiveTools` role visible layer | off | on (master) |

Detection is `HC_TERMINAL_ID` + `HC_TERMINAL_SOCKET`, both injected by core. Session JSONL
custom types (`pi-herdr.todo-edit`, `.subs`, `.terminals`, `.todo-read`, `.todo-reminder`, …)
persist across `/resume` even without core.

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

**Status ownership:** pi's native OSC 7501 reporter is the only status source. pier does not
write terminal status, so do not add a second reporter that writes OSC 7501 for the same terminal.
Other agents running in core terminals are visible to the app but are not tracked by pier.

### Usage

1. Start herdr-core and open a terminal (`hc run --bg pi`, or a terminal from the Herdr app), then run `pi` inside it; the extension detects `HC_TERMINAL_ID` / `HC_TERMINAL_SOCKET` and starts talking to core
2. The model can call `todo_write` (progress shown in the resident widget and `/todos`), `subagent` (spawn / wait / list / send / interrupt / resume / output / help), `terminal` (open / send [`wait: true`] / wait / read / signal / close / list)
3. Every subagent = its own core terminal, listed by the app under the master and killed with it; an explicit `tab` makes it an unfocused pane of that tab (a new name gets its own tab automatically)
4. No restart recovery: core keeps terminals alive across app restarts, but if core stops the workers are gone. Resume the master with `/resume`; revive a finished worker with `subagent(action: "resume", taskId)`
5. `/pier-tree` opens the delegation tree as an in-pi overlay

## Repository layout

```
packages/
  pier-ext/        # pi extension (npm: pi-pier): todo/subagent tools, core client, vocab authority
docs/              # install guide, configuration overview, role profile docs, migration RFC
```

## Testing

```sh
npm install --ignore-scripts
npm test          # typecheck + node --test (todo replay / anti-freeze / GC / lifecycle / renderers / ask picker / subagent output / jev decision layer)
```

## Configuration

Runtime policies and operational limits are centralized in `runtime-policy.ts` (with terminal read limits in `terminal.ts`). All timeouts use millisecond units unless specified otherwise:

| Variable | Default | Unit | Purpose |
|---|---|---|---|
| `PIER_SUBAGENT_TIMEOUT_MS` | `600000` | ms | Subagent inactivity budget / overall timeout before forced termination |
| `PIER_OBSERVATION_WINDOW_MS` | `4000` | ms | Debounce after a subagent turn ends before it is settled (a new working turn cancels it); skipped when the transcript already holds a finalized answer |
| `PIER_FOREGROUND_PATIENCE_MS` | `300000` | ms | Foreground execution patience before auto-demoting a subagent to background |
| `PIER_GC_TICK_MS` | `30000` | ms | Subagent garbage collection ticker interval |
| `PIER_POLL_INTERVAL_MS` | `30000` | ms | Safety re-check while no core event arrives; settlement is driven by the `events.subscribe` children watch |
| `PIER_READY_TIMEOUT_MS` | `90000` | ms | Subagent pipe readiness wait (exponential backoff; a terminal that exited fails immediately with its last output attached) |
| `PIER_SESSION_TTL_SECONDS` | `600` | s | Session retention TTL after subagent exit before GC cleanup |
| `PIER_GIT_TIMEOUT_MS` | `10000` | ms | Execution timeout for git operations (worktree creation, diff summary, cleanup) |
| `PIER_TERM_READ_MAX` | `8000` | chars | Maximum terminal buffer characters read per operation |
| `PIER_TERM_IDLE_MS` | `300000` | ms | Idle time before the second terminal-cleanup nudge (one is sent at turn end for a terminal used that turn) |
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
Core's own identity variables (`HC_TERMINAL_ID`, `HC_TERMINAL_SOCKET`) are injected by core and
read-only for pier.
`/pier-config doctor` lists every option with its effective value and where it came from, plus the
errors pier deliberately swallowed this session.

**Status & labels:** status is whatever the program reports through OSC 7501 — pi 1.4 does this
natively, and pier never synthesizes it. Metadata is terminal labels under `pier.*`
(`pier.session`, `pier.todo`, `pier.lock.<hash>`); inspect them with `hc get <terminal> --json`.
The Herdr app renders the sidebar and notifications itself; there is no app-side mod and no
`PIER_WORKBENCH_ROOT` any more.

**Migration design:** the full cutover plan (verified core facts, deletion list, mapping table)
lives in **[docs/rfc-core-app-migration.md](docs/rfc-core-app-migration.md)**.

### Efficiency mechanisms (D100–D103, opt-in)

Three token-saving mechanisms ship **disabled by default** and are safe to try one at a time:

**Origin — credit where due**: the mechanism ideas and names come from NVIDIA's
[SoL-Pi](https://github.com/NVlabs/SoL-Pi) ([paper](https://arxiv.org/abs/2609.20519) ·
[blog](https://nvlabs.github.io/SoL-Pi/)) — four harness-level efficiency mechanisms surfaced by
scaled auto-research loops. pier adopts three of them (ObservationPack / EPR / OCC; the fourth,
Action Fusion, is not adopted) and re-implements them on its own stack, extending the originals
with a jev decision layer (small System One classifications at the diagnostic gate, excerpt-window
pick, and settle attribution — [rfc-jev-integration.md](docs/rfc-jev-integration.md)), role gating,
and the 4-plane efficiency config with per-mechanism JSONL telemetry (D100–D103).

- **ObservationPack** — large tool outputs are projected as placeholders after the first `fullSends` requests, with paged retrieval via `obs_recall` (session JSONL stays untouched).
- **EPR** — long diagnostic (`bash` test/build) logs are reduced in-process to a byte-verified evidence receipt; the raw log is archived first and stays readable.
- **OCC** — `todo_write` boundaries drive pi's native compaction under a KV-cache cost model, carrying unfinished tasks across the compaction.

```bash
PI_HERDR_OBS_PACK_ENABLE=1 PI_HERDR_OBS_PACK_LOG=1 pi   # start here
```

Full quick start, what to watch in `efficiency-logs/*.jsonl`, rollback steps and a feedback template: **[docs/efficiency-trial.md](docs/efficiency-trial.md)**.

Everything above (plus roles, pi settings and the `PIER_*`/`PI_HERDR_*` env knobs) is also inspectable in-session:

```text
/pier-config            # 4-plane index; hands a guided change to the agent
/pier-config show all   # effective value + source (env > workspace > user > default) per key
/pier-config check      # validation across planes   ·   /pier-config doc → written report
```

Read-only by design — see **[docs/configuration.md](docs/configuration.md)** for the plane map and the "which plane do I edit?" table.

## Design principles

- **Session JSONL is the single source of truth**: todos, delegations, and registries replay from session branches — restart and branch switches stay correct
- **Event-driven, never poll**: state arrives through core `events.subscribe` (`status` / `turn` / `finished` / `labels`); a snapshot is pulled only when an event fires or a `missed` event says to resync
- **Zero app-side mod**: pier writes terminals and labels through core; the Herdr app displays them by its own rules. `/pier-tree` lives inside pi, not in a pane
- **PTY input belongs to humans**: machine-to-machine messages use pipe-channel, and core's parent notes are disabled for worker terminals (D45)
- **Best-effort metadata layer**: label/report failures are silent and never block the pi main flow

## License

MIT

---

> 💡 **For contributors**: `.gitignore` is tracked in the repository. `docs/research/` contains local research notes ignored by `.gitignore`.
>
> **Naming convention**: the brand is **pier** (repo/packages/plugin); runtime protocol identifiers keep the **`pi-herdr`** prefix (`.pi-herdr/roles/` dir, `pi-herdr.subs` session custom entries, `~/.pi/agent/herdr-pi/roles/` user dir) — they persist with user sessions/config files, renaming would break existing data, so they are the compatibility layer.
