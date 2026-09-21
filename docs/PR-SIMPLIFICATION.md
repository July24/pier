## Massive simplification: −31.4% tracked LOC, god files broken up, one convention everywhere

**40,376 → 27,632 tracked LOC** (src+scripts+tests, measured identically on master and this branch). **710/710 tests green**, typecheck clean, comment-language hook clean, suite runtime **44s → 15s**. File count: 100 src → 77, 91 test files → 36 (+2 shared fixture helpers).

| Area | Before | After | Δ |
|---|---:|---:|---:|
| src + workbench scripts | 21,202 | 17,998 | **−15.1%** |
| tests (incl. helpers) | 19,174 | 9,634 | **−49.8%** |
| **Total** | **40,376** | **27,632** | **−31.4%** |

### Structure (legibility & interpretability)
- **`src/core/` → `src/plugins/`**: the old layout inverted the naming (Cordis plugin *entries* lived in `core/` while the actual pure cores were top-level `*-core.ts`). One directory now means one thing; `index.ts` carries a layout map header.
- **index.ts god file (1,192 lines, one 1,033-line function) → 647 lines** with `index-roles.ts` (role runtime: manifest state, mandatory gate, `/pier-role`, branch replay), `index-gates.ts` (coalesced human-gate/blocked reporting), `index-notices.ts` (absorbed notice-buffer). The four duplicated event registrations (session_start ×2, agent_settled ×3, turn_end ×2, session_shutdown ×2) are now one each.
- **Subagent family: 26 files → 12** (`subagent-core/-spawn/-poller/-session/-gc` + `plugins/subagent`); terminal family merged its test halves; efficiency family folded `config-guide` (a pure forwarding layer) into the catalog+command.
- **Dead code removed with evidence**: herdr client RPCs with zero callsites (`spawnSubPane`, `focusPane`, `tabGet`, `closePopup`), `pingUntilReady`, workbench cordis wrapper + `app.ts`, ~90 test-only exports unexported/deleted, 3 installer regex-pin tests, generated `reports/` (14MB stryker incremental) + local-only trial docs untracked (enforces decisions.md's own boundary note).

### Unification (helpers & methods)
- `toRuntimeManifest` + `listRoleNames` + `filterToolsByStance` replace three/four duplicated projections each; `planActiveTools`/`planSwitchActiveTools` fused; 4 manifest type generations → 2 canonical shapes.
- Subagent family: one `newestPerTaskId`, one ambiguous-id formatter, one param-id extractor, one bare-id→transcript-path resolver (`resolveSessionFileValue`), one claimed-session probe, one `pipeAction` (revive→ready→pipe) path, one `sleep`.
- slim-frame reuses ansi-text width/wrap (deleted its private Unicode-width copy); workbench scripts share one `herdr-rpc.mjs` NDJSON client (was 6 copy-pasted 34-line blocks); `NoopHerdrClient`/read-envelope/option-formatting dedups; `RuntimePolicy` derived from the `PIER_OPTIONS` registry (single source).

### Less if-if-if routing
- Declarative FIELD/ENV tables replace ~320 lines of hand-written validation in `efficiency-config-core` (byte-identical fail-open semantics).
- Action dispatch maps in `plugins/subagent` and `plugins/terminal`; STATUS_RULES table for output classification; table-driven `countTodos`, `nullClosingSentence`, `/todos` verbs, dashboard grouping, prompt strategies, workbench event routing; the 320-line `handleReducerToolResult` god function is now named stages; the 9-way compaction-reason ternary is an ordered guard list.

### Tests (−49.8% with zero behavioral coverage lost)
- Shared fixture library (`test-utils.ts`: `fakePi`, `fakeHerdr`, `mountSubagent`, builders) replaced 9 hand-rolled fake variants; case tables replace N near-identical tests; 55 test files folded into domain files.
- `subagent-spawn.test.ts` 33s → 1.3s — root-caused (uncancellable poller timers left ticking per test, not socket I/O); one real-socket test keeps the wire protocol pinned.
- Deleted: implementation-pinning tests (source-text regex locks, mock call ordering, dead-constant assertions, re-export identity) — every deletion has a named surviving behavioral owner.

### Hygiene
- Comment archaeology compressed (2,388 → 1,773 comment-only src lines, 9.8% density): session-id narratives and dated changelogs out; protocol facts and live invariants kept.
- decisions.md anchors refreshed for renames/merges; stryker mutate list verified; CI (3-OS matrix) runs the same `npm test`.

### Review guide (33 commits, each theme green)
`refactor(layout)` rename → `refactor(herdr-client|terminal|slim-frame|pipe-channel|focus-poller)` terminal pass → `refactor(subagent)*` family merge → `refactor(workbench)*` → `refactor(todo,observation,compact)*` → `refactor(roles|ask|reducer|jev|dashboard)*` → `refactor(options|config|infra)*` → `refactor(index)` breakup → `test(...)` consolidations → `refactor:` second-squeeze + comment triage → `docs:` anchor refresh.

Prefer a PR stack instead of one PR? The commit sequence splits cleanly at the pass boundaries above — say the word and I'll cut it into 8 stacked branches.
