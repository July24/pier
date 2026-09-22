## Massive simplification: −30.1% tracked LOC, god files broken up, one convention everywhere

**40,376 → 28,207 tracked LOC** (src+scripts+tests, measured identically on master and this branch). **727/727 tests green**, typecheck clean, comment-language hook clean, suite runtime **44s → ~18s** (`node --test` on an M1 Pro; the full `npm test` incl. typecheck is ~35s). File count: src `.ts` 94 → 77 (plus the workbench scripts 6 → 7: the new shared `herdr-rpc.mjs`), test files 91 → 37 (+2 shared fixture helpers).

| Area | Before | After | Δ |
|---|---:|---:|---:|
| src + workbench scripts | 21,202 | 18,029 | **−15.0%** |
| tests (incl. helpers) | 19,174 | 10,178 | **−46.9%** |
| **Total** | **40,376** | **28,207** | **−30.1%** |

### Structure (legibility & interpretability)
- **`src/core/` → `src/plugins/`**: the old layout inverted the naming (Cordis plugin *entries* lived in `core/` while the actual pure cores were top-level `*-core.ts`). One directory now means one thing; `index.ts` carries a layout map header.
- **index.ts god file (1,192 lines, one 1,033-line function) → 647 lines** with `index-roles.ts` (role runtime: manifest state, mandatory gate, `/pier-role`, branch replay), `index-gates.ts` (coalesced human-gate/blocked reporting), `index-notices.ts` (absorbed notice-buffer). The four duplicated event registrations (session_start ×2, agent_settled ×3, turn_end ×2, session_shutdown ×2) are now one each.
- **Subagent family: 26 files → 12** (`subagent-core/-spawn/-poller/-session/-gc` + `plugins/subagent`); terminal family merged its test halves; efficiency family folded `config-guide` (a pure forwarding layer) into the catalog+command.
- **Dead code removed with evidence**: herdr client RPCs with zero callsites (`spawnSubPane`, `focusPane`, `tabGet`, `closePopup`), `pingUntilReady`, workbench cordis wrapper + `app.ts`, ~90 test-only exports unexported/deleted, 3 installer regex-pin tests, generated `reports/` (14MB stryker incremental) untracked. Local-only dev docs (`docs/efficiency-review-*.md`, `docs/herdr-0.9.1-optimization-design.md`) are untracked *and* ignored; `docs/efficiency-trial.md` stays tracked because README, `docs/configuration.md`, `config-command.ts` and 21 `docRef`s in `config-catalog-core.ts` point users at it.

### Behavior changes beyond the mechanical rewrite (review-verified)
The pass was *not* behavior-neutral. Listed here instead of being left to the commit messages:
- **Fixes carried in this branch** (`fix(todo,observation,compact)`): `/todos` verb lookup is prototype-safe (`Object.hasOwn`), a synchronous `sendMessage` throw inside the reminder timer is swallowed, `restoreCoordinatorState` skips an invalid newest marker instead of dropping older pacing samples/debt, `buildPlaceholder` returns the content hash it already computed.
- **Fixes found in review and applied**: the stop-reminder cap counter advances on delivery again (pi's
  `sendMessage` returns void, so the old `send(...).then(...)` threw and was swallowed — every settle
  re-sent "Reminder 1/3" and the 3-reminder cap never engaged); every status-keyed table lookup goes
  through the new `isTodoStatus`/`todoMark` guards (`countTodos`, todo window/read hook, dashboard); `reportDisplayAgent` (D93) went back to the herdr client — the pinned `ExtensionAPI` (0.86) has no such method, so the split had silently disabled sidebar identity; the merged `turn_end` handler restores the malformed-event early return.
- **Widened on purpose**: workbench event routing also matches the underscored `pane_agent_status_changed` (master's regex missed it); empty env values (`PI_HERDR_CACHE_RATIO=""`, `PIER_JEV_MIN_CONFIDENCE=""`) now count as unset instead of coercing through `Number('') === 0`.
- **Changed on purpose, accepted**: `tool_call` handlers now run role-gate before write-locks (a denied call no longer acquires locks; a call that is both lock-conflicting and out-of-manifest now reports the deny reason with `terminate`); `slim-frame` inherits `ansi-text` width/wrap semantics, which fixes emoji/combining-mark widths but also changes wrapping of runs of spaces and ZWJ sequences.
- **Not changed** (verified equivalent): the merged `pollLoop` observation window, the efficiency FIELD/ENV tables (byte-identical except the empty-env case above), the subagent helper unification, and the workbench reflow/heat math (differential-tested).

### Unification (helpers & methods)
- `toRuntimeManifest` + `listRoleNames` + `filterToolsByStance` replace three/four duplicated projections each; `planActiveTools`/`planSwitchActiveTools` fused; 4 manifest type generations → 2 canonical shapes.
- Subagent family: one `newestPerTaskId`, one ambiguous-id formatter, one param-id extractor, one bare-id→transcript-path resolver (`resolveSessionFileValue`), one claimed-session probe, one `pipeAction` (revive→ready→pipe) path, one `sleep`.
- slim-frame reuses ansi-text width/wrap (deleted its private Unicode-width copy); workbench scripts share one `herdr-rpc.mjs` NDJSON client (was 6 copy-pasted 34-line blocks); `NoopHerdrClient`/read-envelope/option-formatting dedups; `RuntimePolicy` derived from the `PIER_OPTIONS` registry (single source).

### Less if-if-if routing
- Declarative FIELD/ENV tables replace ~320 lines of hand-written validation in `efficiency-config-core` (same defaults, same issue strings, same fail-open rule; one deliberate divergence: an *empty* env value now counts as unset instead of being coerced by `Number('')`).
- Action dispatch maps in `plugins/subagent` and `plugins/terminal`; STATUS_RULES table for output classification; table-driven `countTodos`, `nullClosingSentence`, `/todos` verbs, dashboard grouping, prompt strategies, workbench event routing; the 320-line `handleReducerToolResult` god function is now named stages; the 9-way compaction-reason ternary is an ordered guard list.

### Tests (−46.9% with every behavioral contract re-owned)
- Shared fixture library (`test-utils.ts`: `fakePi`, `fakeHerdr`, `mountSubagent`, builders) replaced 9 hand-rolled fake variants; case tables replace N near-identical tests; 55 test files folded into domain files.
- `subagent-spawn.test.ts` 33s → 1.3s — root-caused (uncancellable poller timers left ticking per test, not socket I/O); one real-socket test keeps the wire protocol pinned.
- Deleted: implementation-pinning tests (source-text regex locks, mock call ordering, dead-constant assertions, re-export identity). Each deletion must name a surviving behavioral owner; review found eight contracts that had none and they are restored — installer dev-only `EXT_PATH` + update-not-uninstall guards, notice-buffer rank hook (≤cap not consulted / `null` fail-open / rank feeds the collapse), loop-level user-takeover + machine-inject-reset flips, `getRemainingHorizon` sample tiers, three negative ask-gate cases (invalid ask must not open a herdr gate), `PIER_FOCUS_POLL_MS=0` end-to-end, `HerdrClient.readAgent` in the A6 wire-contract guard, and the D98 `subagent-deps` bag (now `satisfies SubagentDeps`, so tsc rejects a dropped key).

### Hygiene
- Comment archaeology compressed (2,388 → 1,773 comment-only src lines, 9.8% density): session-id narratives and dated changelogs out; protocol facts and live invariants kept.
- decisions.md anchors refreshed for renames/merges (path *and* line, including the rows whose line had drifted; `test/doc-anchors.test.ts` now fails on a dangling anchor); stryker mutate list verified; CI (3-OS matrix) runs the same `npm test`.

### Review guide (per-theme commits, each green)
`refactor(layout)` rename → `refactor(herdr-client|terminal|slim-frame|pipe-channel|focus-poller)` terminal pass → `refactor(subagent)*` family merge → `refactor(workbench)*` → `refactor(todo,observation,compact)*` → `refactor(roles|ask|reducer|jev|dashboard)*` → `refactor(options|config|infra)*` → `refactor(index)` breakup → `test(...)` consolidations → `refactor:` second-squeeze + comment triage → `docs:` anchor refresh. Then the review pass, one theme per commit: `fix(index,roles)` D93 sidebar identity + malformed `turn_end` guard → `fix(todo)` prototype-safe `countTodos` → `refactor(index-master)` `satisfies` guard on the deps bag → `test:` re-own the eight unowned contracts → `docs:` anchors + this description → `fix(todo,terminal,index)` reminder cap (`send` is void) → `fix(todo,dashboard)` status-keyed lookups → `docs:` re-measure (`git log --oneline 757091c..master` lists them in order).

Prefer a PR stack instead of one PR? The commit sequence splits cleanly at the pass boundaries above — say the word and I'll cut it into 8 stacked branches.
