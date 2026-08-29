# Optimization Work Continuation Plan

## Context
Following the initial optimization (commit 9444b52), systematic improvements are underway following the recommended execution path from `docs/REFACTORING_SUMMARY.md`.

## Phase 1: Stabilize Test Foundation (In Progress)

### Completed ✅
- Test isolation utilities (`test-utils.ts`)
- Cleanup hooks (TempDir, EnvSnapshot)
- MockTimers support
- Pipe-channel boundary tests

### In Progress ⏸️
- herdr-client test coverage (framework created, needs completion)
- Foundation module application (created but not yet used in core code)

## Next Immediate Actions (Priority Order)

### 1. Apply Foundation Modules (Est. 2-3 days) 🔥
**Why First**: Already created, low risk, high value realization

**Tasks**:
```bash
# A. core/subagent.ts
- Lines 105-106: Replace hardcoded ~/.pi paths with platformPaths
- Lines 1256: Replace ~/.herdr/worktrees with platformPaths.worktreeBaseDir
- Lines 94-109: Replace timeout literals with runtimePolicy
- Lines 763-785: Replace git execFile calls with gitAdapter

# B. history-store.ts
- Line 62-64: Use platformPaths for history file location

# C. terminal.ts
- Line 101: Use runtimePolicy.terminalReadMaxBytes
```

**Verification**: Run full test suite after each file change

### 2. Complete herdr-client Tests (Est. 3-4 days)
**Why Deferred**: Requires deep protocol understanding, more complex

**Approach**:
- Study existing herdr protocol documentation (WIRE.md)
- Implement FakeHerdrServer for all 20+ RPC methods
- Test platform-specific behavior (Windows named pipes)
- Test error paths (connection failure, timeout, malformed responses)

**Entry Point**: `packages/pier-ext/src/herdr-client.ts` lines 1-582

## Phase 2: Quick Wins (Est. 1-2 weeks)

### A. Storage Layout Consolidation (1 day)
Create `src/storage-layout.ts`:
```typescript
// Centralize:
- historyFilePath() from history-store.ts:62-64
- sessionDirName() from session-tail.ts:115-118  
- rolesDir() from role-loader.ts
- Collision-resistant path encoding
```

### B. Fix TodosService Boundary (1 day)
`src/todos-service.ts`:
- Privatize `items` array (line 21-28)
- Add `getSnapshot()` returning readonly copy
- `replace/applyEdits` return `{ changed: boolean }`
- No-op detection before clock update

### C. index.ts Integration Tests (5-7 days)
Create `test/index-integration.test.ts`:
- Test master/worker mode switching
- Test herdr unavailable degradation
- Test tool execution lifecycle
- Test notice buffering

## Phase 3: Architecture Improvements (3-4 weeks)

### Extract pollLoop Pure Functions
`src/core/subagent.ts:446-672` → `src/subagent-poller.ts`

### Replace Callback Slots with Ports
Define typed event interfaces, remove reverse dependencies

## Command Reference

```bash
# Run specific test file
npm test -- packages/pier-ext/test/FILE.test.ts

# Run all tests
npm test

# Run mutation testing
npm run test:mutation

# Check current status
git status
git diff packages/pier-ext/src/
```

## Success Criteria

**Phase 1 Complete When**:
- All foundation modules applied and tests pass
- herdr-client >80% coverage
- Test isolation utilities in use

**Phase 2 Complete When**:
- Storage layout centralized
- TodosService state safe
- index.ts lifecycle tested

## Recovery Points

If blocked on herdr-client complexity:
1. Document specific protocol questions
2. Skip to Phase 2 Quick Wins
3. Return to herdr-client with better understanding

If test failures occur:
1. Revert last change: `git checkout -- FILE`
2. Run tests in isolation
3. Check test-utils.ts usage patterns

## Reference Documents

- `docs/OPTIMIZATION_2026.md` - Full analysis
- `docs/REFACTORING_SUMMARY.md` - Completed work summary
- `docs/PHASE1_PROGRESS.md` - Current phase status

Last Updated: 2026-08-29
