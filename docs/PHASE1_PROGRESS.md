# Phase 1 Progress Report

## Completed Tasks ✅

### Test Infrastructure (4/6)
1. ✅ **Test isolation - cleanup hooks** 
   - Created `test/test-utils.ts` with `TempDir`, `EnvSnapshot`, `withCleanup` utilities
   - Automated resource cleanup to prevent leaks

2. ✅ **Test isolation - MockTimers support**
   - Added `withMockTimers` wrapper for deterministic timing tests
   - Eliminates Date.now() and setTimeout() dependencies

3. ✅ **Test isolation - process.env restoration**
   - `EnvSnapshot` class automatically restores environment variables
   - Prevents test pollution

4. ⏸️ **herdr-client tests** (infrastructure created, full implementation deferred)
   - Created test framework with `FakeHerdrServer`
   - Identified complexity requiring deeper protocol understanding
   - **Recommendation**: Dedicated effort needed for complete RPC coverage

### Foundation Modules (0/4 application tasks)
- ⏸️ Apply platform-paths in core/subagent.ts
- ⏸️ Apply runtime-policy in core/subagent.ts  
- ⏸️ Apply git-adapter in core/subagent.ts
- ⏸️ Apply foundation modules in history-store.ts

**Status**: Foundation modules created but not yet integrated into core code

## Current State

**Test Suite**: 339/339 passing ✅  
**New Infrastructure**: 
- `test/test-utils.ts` (147 lines)
- `test/pipe-channel-boundary.test.ts` (146 lines) - working
- Test utilities ready for use

## Remaining Phase 1 Work

### High Priority
1. **Apply foundation modules** (4 tasks, est. 2-3 days)
   - Replace hardcoded paths with `platformPaths`
   - Replace scattered timeouts with `runtimePolicy`
   - Replace git commands with `gitAdapter`
   
2. **herdr-client complete test coverage** (est. 3-4 days)
   - Requires protocol expertise
   - 20+ RPC methods to cover
   - Platform-specific behavior (Windows named pipes vs Unix sockets)

## Recommendation

**Immediate Next Steps**:
1. Apply foundation modules to core code (high ROI, low risk)
2. Commit current progress
3. Create detailed herdr-client testing plan before implementation

**Phase 2 Ready**:
- Storage layout consolidation
- TodosService boundary fixes
- index.ts integration tests

## Files Changed This Session
```
M packages/pier-ext/test/test-utils.ts (new, 147 lines)
M packages/pier-ext/test/pipe-channel-boundary.test.ts (working)
```

All tests passing. Infrastructure ready for systematic application.
