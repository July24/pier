# Changelog

pi shows the entries newer than your last seen version under "Extension Updates" after `pi update`.

## [0.5.6] - 2026-11-12

### Changed

- The todo list recited at each turn keeps the in-progress item and the earliest open items, which are the next steps, and says how many later items it left out.
- Online compaction keeps re-evaluating every 10 requests after you send a message, and also in sessions that never use `todo_write`.
- `compact.jsonl` records the compaction decision before the run is interrupted, not only after the summary.

### Fixed

- Cancelling `ask_user_question` no longer tells the model to continue with its best judgment; it is told not to assume answers and to ask in chat. An empty multi-select reads `(no option selected)`.
- On fish, `terminal` hints spell the exit status `$status` instead of `$?`.
- The tools ledger no longer counts the time you take to answer `ask_user_question` as tool latency.

## [0.5.5] - 2026-11-09

### Fixed

- A fresh install starts again: since 0.5.4, pi failed on start with `Cannot read properties of undefined (reading 'entry')` because newer cordis plugins were installed alongside the pinned cordis 4.0.1, with npm and with `npmCommand: ["bun"]`.
- `terminal` `send` with `wait: true` no longer times out on fish: pier no longer sends a POSIX init line there and reads the exit status from `$status`. `PIER_TERMINAL_PROMPT` accepts `fish`.

## [0.5.4] - 2026-11-05

### Changed

- Online compaction counts a `todo_write` that completes several items as that many boundaries, so batched completions no longer inflate the remaining-work estimate.
- `terminal` `wait` accepts `file` without `pattern`: it waits until the file exists and is not empty, and does not return its content.
- `subagent` `wait` on one worker now also returns when another running worker settles, and names the worker still running.

### Fixed

- `subagent` `output` returns the final report from the worker's transcript after its terminal was removed.
- Online compaction no longer aborts a run when the only history before the cut is the system prompt.
- Reducer timeouts are logged as `timeout` instead of `empty-output`.
- The notice for a worker moved to background states the `agentId` to use.

## [0.5.3] - 2026-11-03

### Breaking Changes

- Requires pi ≥ 1.5.0. The `ask_user_question` picker now opens with pi's `ui.custom` `blocked` option, so pi itself reports the pane as blocked; pier writes no terminal status of its own any more.
- Removed the role system: `/pier-role`, the `role` and `allowed_tools` spawn parameters, `PI_HERDR_ROLE_MANIFEST` / `PI_HERDR_ROLE_BASE` and the roles plane of `/pier-config`. Workers run the master's current model, so a `/model` switch carries over to later workers.

### Added

- `subagent` `action: "wait"` blocks until a worker settles, fails, closes or waits on a human, and returns that notice as the tool result.
- `terminal` `send` with `wait: true` appends an exit sentinel and returns the exit code and output.
- `ask_user_question` blocked status now also shows in terminals outside herdr-core that support OSC 7501.

### Changed

- Workers get no pane by default (listed under their master, closed with it); pass `tab` for one.
- `tab` folds the ask picker to a two-line bar.

### Fixed

- `ask_user_question` repairs `options` strings that swallowed the following keys.
