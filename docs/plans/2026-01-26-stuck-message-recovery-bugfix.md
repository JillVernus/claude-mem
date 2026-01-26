# Stuck Message Recovery Bugfix Plan

**Created**: 2026-01-26
**Status**: Planning
**Version**: v9.0.8-jv.2

## Problem Statement

During provider switching (Gemini → Claude → Gemini), sessions can become orphaned with pending messages that are never processed. Investigation revealed 5 interacting bugs that cause this issue.

## Root Cause Analysis

### Bug 1: Stale `claude_resume_session_id` Prevents Recovery
**Severity**: High
**File**: `src/services/worker/SDKAgent.ts`

When the SDK session ends or returns "Claude Code process aborted by user" error, the `claude_resume_session_id` is not cleared in the database. Recovery attempts try to resume the dead session, which fails repeatedly.

**Evidence**:
```
[ERROR] [SDK] Session generator failed {project=cc-bridge} Claude Code process aborted by user
```

### Bug 2: Session Caching Doesn't Refresh `claudeResumeSessionId`
**Severity**: Medium
**File**: `src/services/worker/SessionManager.ts` (lines 62-102)

When `initializeSession` finds a session already in memory, it returns the cached session without reloading `claudeResumeSessionId` from the database. Database fixes don't take effect until the session is manually deleted.

**Evidence**: After clearing resume ID in database, logs still showed the old value being used.

### Bug 3: Crash Recovery setTimeout Lacks Error Handling
**Severity**: Medium
**File**: `src/services/worker/http/routes/SessionRoutes.ts` (lines 326-335)

```javascript
setTimeout(async () => {
  // No try/catch - unhandled promise rejection if this fails
  await this.startGeneratorWithProvider(stillExists, this.getSelectedProvider(), 'crash-recovery');
}, 1000);
```

If `startGeneratorWithProvider` throws, the error is unhandled, and the session is left without a generator.

### Bug 4: No Periodic Recovery for Orphaned Sessions
**Severity**: Medium
**File**: `src/services/worker-service.ts`

`processPendingQueues()` only runs at worker startup. If a session loses its generator mid-operation (hot-reload failure, crash), there's no mechanism to automatically restart it.

### Bug 5: Recovery Uses Hardcoded Claude SDK
**Severity**: Medium
**File**: `src/services/worker-service.ts` (line 366)

```javascript
session.generatorPromise = this.sdkAgent.startSession(session, this)
```

`startSessionProcessor` always uses Claude SDK, ignoring `CLAUDE_MEM_PROVIDER` settings. This causes recovery to use the wrong provider.

## Implementation Plan

### Phase 1: Handle Terminal Session Errors (Bug 1)
**Priority**: Critical - Prevents recovery from working

- [x] In `SDKAgent.ts`, detect terminal errors using a whitelist approach:
  - "Claude Code process aborted by user"
  - "invalid session id" / "unknown session"
  - "cannot resume" / "context lost"
- [x] **Only clear resume ID when a resume was actually attempted** (check if `claudeResumeSessionId` was set before the call)
- [x] **Transient error exclusions take precedence** over whitelist matches:
  - Timeouts, 429 rate limits, DNS failures → do NOT clear resume ID
- [x] Ensure cleanup wraps the `query(...)` / `for await` loop in `SDKAgent.ts:129`
- [x] When terminal error detected during a resume attempt:
  - [x] Clear `claude_resume_session_id` in database
  - [x] Clear `claudeResumeSessionId` in the in-memory session object (prevent cache reuse)
- [x] Log the cleanup action with context: `{ wasResumeAttempt: boolean, error: string }`

**Files to modify**:
- `src/services/worker/SDKAgent.ts`

### Phase 2: Refresh Session State from Database (Bug 2)
**Priority**: High - Ensures database fixes take effect

- [x] In `initializeSession`, when returning cached session:
  - [x] Reload rollover state from database via `getClaudeRolloverState()`
  - [x] Refresh both `claudeResumeSessionId` AND `last_input_tokens` (same DB call)
  - [x] Update cached session if database values differ
  - [x] Log when refresh occurs for debugging

**Files to modify**:
- `src/services/worker/SessionManager.ts`

### Phase 3: Add Error Handling to Crash Recovery + Fix Provider Selection (Bugs 3 & 5)
**Priority**: High - Prevents silent failures, ensures correct provider

**Note**: Provider selection fix moved here since `processPendingQueues()` runs at startup and via manual API - wrong provider would be used without this fix.

#### 3a: Fix Provider Selection (Bug 5)
- [x] Refactor `startSessionProcessor` to accept provider selection
- [x] Create shared helper for provider selection (reuse from SessionRoutes)
- [x] Or: move `getSelectedProvider()` / `getActiveAgent()` to a shared location
- [x] Update `processPendingQueues` to use settings-based provider

#### 3b: Add Error Handling to Crash Recovery (Bug 3)
- [x] Wrap the setTimeout callback in try/catch
- [x] On error, log the failure
- [x] Clear `claude_resume_session_id` (both DB and memory) and retry without resume
- [x] Add retry limit to prevent infinite loops
- [x] Add **per-session** `recoveryInProgress` flag:
  - [x] Store on session object, not global
  - [x] Always clear in `finally` block to prevent deadlocks
  - [x] Crash recovery, periodic recovery, and manual recovery must all check and respect this flag

**Files to modify**:
- `src/services/worker/http/routes/SessionRoutes.ts`
- `src/services/worker-service.ts`
- `src/services/worker-types.ts`

### Phase 4: Add Periodic Orphan Recovery (Bug 4)
**Priority**: Medium - Adds safety net

#### 4a: Add Periodic Recovery
- [ ] Create periodic check for sessions with pending messages
- [ ] Make interval configurable via settings (default: 5 minutes)
- [ ] Add jitter/backoff to prevent thundering-herd restarts
- [ ] Only recover sessions that:
  - Have pending messages in DB
  - Are NOT in worker memory OR have no running generator
- [ ] Check per-session `recoveryInProgress` flag before attempting recovery
- [ ] Integrate with existing orphan reaper interval or create new one
- [ ] Add telemetry logging for recovery events

#### 4b: Handle `processing` Messages
- [ ] **Explicit behavior**: Periodic recovery does NOT call `resetStuckMessages()` directly
- [ ] Periodic recovery only triggers `processPendingQueues()` which uses `claim()` to acquire messages
- [ ] The existing `resetStuckMessages()` timeout logic (separate background task) handles stuck `processing` → `pending` transitions
- [ ] This separation prevents double-processing and maintains clear ownership

**Files to modify**:
- `src/services/worker-service.ts`

## Files Changed Summary

| File | Changes |
|------|---------|
| `src/services/worker/SDKAgent.ts` | Handle terminal errors with whitelist, clear stale resume ID (DB + memory) only on resume attempts |
| `src/services/worker/SessionManager.ts` | Refresh claudeResumeSessionId and last_input_tokens from DB on cache hit |
| `src/services/worker/http/routes/SessionRoutes.ts` | Add error handling to crash recovery, add per-session recoveryInProgress flag |
| `src/services/worker-service.ts` | Fix provider selection, add periodic recovery with configurable interval + jitter |

## Testing Plan

### Manual Testing
1. Start session with Gemini provider
2. Switch to Claude provider mid-session
3. Force generator failure (e.g., network issue, invalid resume ID)
4. Verify messages are recovered
5. Verify recovery uses current provider setting
6. Verify periodic recovery catches orphaned sessions
7. Verify transient errors (timeout, 429) do NOT clear resume ID
8. Verify resume ID only cleared when resume was attempted

### Edge Cases
- [ ] Multiple rapid provider switches
- [ ] Worker restart during recovery
- [ ] Generator failure during hot-reload restart
- [ ] Invalid/expired claude_resume_session_id
- [ ] Race between crash recovery and periodic recovery
- [ ] Transient network errors during active session
- [ ] Fresh session (no resume ID) encounters terminal error

## Acceptance Criteria

- [ ] Stuck messages are automatically recovered within configured interval (default 5 min)
- [ ] Recovery respects current `CLAUDE_MEM_PROVIDER` setting
- [ ] Stale `claude_resume_session_id` doesn't prevent recovery
- [ ] Database fixes take effect without manual session deletion
- [ ] Crash recovery errors are logged and handled gracefully
- [ ] No increase in worker memory usage from periodic checks
- [ ] Transient errors preserve resume state for retry
- [ ] No race conditions between recovery paths
- [ ] Resume ID only cleared when resume was actually attempted

## Rollback Plan

If issues arise:
1. Revert to v9.0.8-jv.1
2. Manual recovery via `/api/pending-queue/process` API
3. Manual database cleanup of stale resume IDs

## Version Plan

- v9.0.8-jv.2: Phases 1-3 (critical fixes + provider selection)
- v9.0.8-jv.3: Phase 4 (periodic recovery timer)

## Future Enhancements (Out of Scope)

- **Hanging generator detection**: Add heartbeat/last-activity tracking to detect generators that exist but aren't making progress
- **Cache refresh TTL**: Add throttle to `initializeSession()` DB refresh if called extremely frequently

## Codex Review History

### Review 1 (2026-01-26)

**Reviewer**: Codex

**Feedback Applied**:
1. ✅ Merged Phase 5 into Phase 4 - provider selection must be fixed before periodic recovery starts
2. ✅ Added terminal vs transient error classification in Phase 1
3. ✅ Added requirement to clear resume ID in both DB AND memory
4. ✅ Added `recoveryInProgress` flag to prevent race conditions
5. ✅ Made periodic recovery interval configurable with jitter
6. ✅ Expanded Phase 1 to use error whitelist instead of single string match
7. ✅ Added `last_input_tokens` refresh to Phase 2
8. ✅ Documented interaction with `resetStuckMessages()` in Phase 4

**Feedback Deferred**:
- Hanging generator heartbeat detection - out of scope for this bugfix
- Cache refresh TTL/throttle - premature optimization

### Review 2 (2026-01-26)

**Reviewer**: Codex

**Feedback Applied**:
1. ✅ Moved provider selection fix to Phase 3 (now in v9.0.8-jv.2) - `processPendingQueues()` runs at startup/manual API
2. ✅ Phase 1: Only clear resume ID when resume was actually attempted
3. ✅ Phase 1: Transient error exclusions take precedence over whitelist matches
4. ✅ Phase 1: Log whether resume was attempted in cleanup action
5. ✅ Phase 3: `recoveryInProgress` is per-session (not global)
6. ✅ Phase 3: `recoveryInProgress` always cleared in `finally` block
7. ✅ Phase 3: All recovery paths (crash, periodic, manual) must respect `recoveryInProgress`
8. ✅ Phase 4: Explicit that periodic recovery does NOT call `resetStuckMessages()` - relies on `claim()` reclaim logic
