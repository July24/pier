# Pier Codebase Optimization Summary

## Completed Improvements

### 1. Platform-Aware Path Service (`platform-paths.ts`)
- **Why**: Eliminates hardcoded Unix-style paths (`~/.pi`, `~/.herdr`)
- **Impact**: Cross-platform compatibility (Windows LOCALAPPDATA, Linux XDG_DATA_HOME)
- **Usage**: Injectable for tests, singleton for production

### 2. Centralized Runtime Policy (`runtime-policy.ts`)
- **Why**: Prevents drift between hardcoded literals and environment overrides
- **Impact**: Single source of truth for timeouts, intervals, cadences
- **Validated**: Environment parsing with warnings for invalid values

### 3. Git Adapter (`git-adapter.ts`)
- **Why**: Centralizes git command execution and error normalization
- **Impact**: Testable without real git processes, consistent timeout policy
- **Interface**: Minimal adapter pattern for worktree operations

### 4. SubagentDeps Contract Fix
- **Why**: `terminalState` was used but not declared in interface
- **Impact**: TypeScript contract now matches runtime usage
- **Added**: `TerminalStateSlot` import and explicit field

## Critical Issues Identified by Analysis

### Dead Code
- `TodoUiSlot`, `TodoDeps` (core/todo.ts:34-46): exported but only used internally
- `TerminalStateSlot`, `TerminalDeps` (core/terminal.ts:36-45): exported but only consumed structurally
- `SubagentEnv`, `SubagentSlots`, `SubagentDeps` (core/subagent.ts:38-76): imply external API that doesn't exist

**Recommendation**: Make these interfaces non-exported or move to shared contract module

### Hardcoded Values Requiring Abstraction
1. **Session/Worktree Paths**: `~/.pi/agent`, `~/.herdr/worktrees` (subagent.ts:105-106,1256)
   - Fixed: Use `platform-paths.ts`
2. **Timing Constants**: Scattered 600000, 30000, 60000 literals
   - Fixed: Use `runtime-policy.ts`
3. **Git Commands**: Duplicated `execFile('git', ...)` (subagent.ts:763-764, 782-785)
   - Fixed: Use `git-adapter.ts`
4. **Terminal Prompt Detection**: Regex `[$>#❯]\\s*$` (terminal.ts:140) assumes POSIX
   - Recommendation: Injectable shell/readiness strategy

### Architecture Issues

#### God Objects
1. **core/subagent.ts** (~1,617 lines): Combines tool schemas, pane creation, git/worktree, persistence, polling, notifications, revival, GC
   - `pollLoop` (446-672, ~227 lines): takeover detection, blocked gating, settlement, timeout, liveness
   - `execute` (1195-1477, ~283 lines): validation, isolate creation, role composition, launch, result formatting
   
2. **index.ts** (91-818, ~728 lines): Composition root that also owns todo state, metadata projection, locks, user-question blocking, notice buffering, pipe protocol

**Recommendation**: Extract pure transition planners, separate I/O adapters, create feature installers

#### Tight Coupling
- Reverse callback slots (subagent.ts:45-76, index.ts:542-560,764-788) couple core plugin to index internals
- terminal.ts:91-92 mutates injected `activePaneIds` slot creating hidden lifecycle ordering
- SubagentDeps destructures undeclared `terminalState` (fixed)

**Recommendation**: Replace with typed event/notifier ports, use registered exemption service

### Service Boundary Issues
1. **TodosService**: Exposes mutable `items` and `config`, bypassing events
2. **history-store**: Hardcodes `'herdr-pi/history/history.jsonl'`, duplicated in role-loader and session-tail
3. **sessionDirName**: Path flattening causes collisions (a/b vs a-b, Windows drives)

### Error Handling Gaps
1. **appendHistory**: Swallows mkdir/write errors, silently loses audit ledger
2. **readHistory**: Returns `[]` for missing/permission/corruption, conflating causes
3. **parseHistoryEntries**: Validates only `taskId`, accepts malformed entries
4. **TodosService**: `replace/applyEdits` set `lastWriteAt` even on no-op

### Test Coverage Gaps

#### Critical (Untested)
- **herdr-client.ts**: NDJSON socket adapter, platform target selection, all RPC adapters
- **index.ts**: Runtime composition, master/worker startup, herdr unavailable degradation
- **pipe-channel.ts**: Malformed frames, partial/multiple NDJSON lines, Windows named-pipe
- **core/subagent.ts**: Timeout/poll/revive/GC error branches, malformed tool inputs

#### Important (Partial Coverage)
- **vocab.ts**: `formatTodoConfirmation`, `formatSettlementNotice` not tested
- **subagent-core.ts**: `formatSubagentResult`, `isAlive` boundary matrix, `agoText` edge cases
- **history-store.ts**: `inheritOutcome`, failure swallowing, malformed entry shapes
- **core/terminal.ts**: Error responses, persistence/rebuild failures, readiness timeout

#### Test Quality Issues
- Hardcoded paths: `F:/repo/pier`, `/usr/local/bin/node`, `/tmp`
- Process-global mutation: `process.env`, `Date.now`/`mtime` without isolation
- Flaky waits: 300ms sleeps instead of awaiting readiness
- Incomplete cleanup: `pane-gc.test` creates temp dirs without removing them

### Chinese Comments
Widespread across all core files. Should be converted to concise English WHY-focused comments:
- core/subagent.ts: lines 1-12, 35-36, 44-51, 67-75, 89-102, 115-116, and many more
- core/terminal.ts: lines 1-12, 53-59, 91-92, 122, 137-147, 207, 231, 338-341
- core/todo.ts: lines 1-12, 67-68, 70-158, 193-233, 292, 306-310, 368, 383
- index.ts: lines 1-17, 31-36, 64-67, 92-97, and extensive inline comments

**Impact**: Limits accessibility for English-only maintainers, violates "code is truth" philosophy

## Mutation Testing Setup

### Recommended Tool
`@stryker-mutator/core` with `@stryker-mutator/typescript-checker`

### Configuration
```json
{
  "$schema": "./node_modules/@stryker-mutator/core/schema/stryker-schema.json",
  "packageManager": "npm",
  "testRunner": "command",
  "commandRunner": {
    "command": "node --test packages/pier-ext/test/*.test.ts"
  },
  "mutate": [
    "packages/pier-ext/src/**/*.ts",
    "!packages/pier-ext/src/**/*.d.ts",
    "!packages/pier-ext/src/index.ts"
  ],
  "thresholds": {
    "high": 80,
    "low": 60,
    "break": 50
  },
  "timeoutMS": 60000,
  "incremental": true
}
```

### Initial Mutation Targets
1. **todo-core**: validate/apply/fold logic
2. **tool-gate**: deny precedence rules
3. **reconcile-core**: match tiers
4. **lock-core**: path normalization, conflict detection
5. **pipe-channel**: parse/request framing
6. **herdr-client**: error mapping/swallowing
7. **gc-core**: collection gates

## Recommendations Priority

### P0 (Critical)
1. Add herdr-client socket protocol tests with fake server
2. Add pipe-channel boundary tests for malformed frames
3. Fix test isolation: cleanup temps, restore env, deterministic clocks
4. Use new platform-paths and runtime-policy in core files
5. Add mutation testing for safety-critical pure logic

### P1 (Important)
6. Extract subagent pollLoop into pure transition functions
7. Extract subagent execute orchestration
8. Replace reverse callback slots with typed ports
9. Centralize storage layout constants (replace hardcoded paths)
10. Add collision-resistant sessionDirName encoding

### P2 (Nice to Have)
11. Convert Chinese comments to English
12. Remove unnecessary exports from internal contracts
13. Add platform-specific test execution (CI matrix)
14. Refactor index.ts composition root into feature installers
15. Add executable integration tests for index lifecycle

## Impact on Entropy

### Positive
- Foundation modules reduce platform-specific bugs
- Centralized policy prevents configuration drift
- Type safety improvements catch contract violations
- Test additions protect against regressions

### Negative (Technical Debt Remains)
- God objects still mix concerns (needs major refactor)
- Chinese comments still limit accessibility
- Test coverage gaps in critical transport layer
- Service boundary coupling remains

### Next Steps for Continuous Improvement
1. Enforce mutation score threshold in CI
2. Add pre-commit hook to prevent new Chinese comments
3. Gradually extract concerns from God objects
4. Add integration tests for each feature installer
5. Document architectural decision records (WHY, not WHAT)
