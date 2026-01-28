# Provider Switch API Flood

**Date**: 2026-01-28
**Status**: Fixed
**Version**: 9.0.8-jv.4
**Category**: R (Idle Session Cleanup)

## Problem

When switching AI providers in the web UI, ~10 API requests were fired simultaneously to the new provider, causing high CPU usage and potential server unresponsiveness.

## Root Cause Analysis

### Finding 1: Orphaned Sessions Accumulate

Sessions were kept alive indefinitely in `SessionManager` even after:
- The generator finished with no pending work
- The original Claude Code session ended (user exited, crashed, etc.)

This was intentional (see comment in `SessionRoutes.ts:420-422`):
```typescript
// NOTE: We do NOT delete the session here anymore.
// The generator waits for events, so if it exited, it's either aborted or crashed.
// Idle sessions stay in memory (ActiveSession is small) to listen for future events.
```

Over time, orphaned sessions accumulated (10+ sessions from previous Claude Code sessions).

### Finding 2: All Sessions Restart on Provider Change

When switching providers via the web UI:
1. `SettingsWatcher` detects the file change
2. `handleSettingsChange()` calls `scheduleRestartsForSettingsChange()`
3. ALL active sessions (including orphaned ones) trigger immediate `pending-restart` events
4. Each session restarts with the new provider, making an API call
5. Result: N orphaned sessions = N simultaneous API calls

### Evidence

From API proxy logs, the ~10 sonnet requests had **different session IDs**, confirming multiple claude-mem sessions were active despite only one Claude Code terminal being used.

## Solution

### Fix 1: Staggered Session Restarts

**File**: `src/services/worker/SessionManager.ts`

When multiple sessions need to restart, stagger them with a 2-second delay between each:
- First session restarts immediately (responsiveness)
- Subsequent sessions restart after 2s, 4s, 6s, etc.
- Re-validates session state before each staggered restart

### Fix 2: Idle Session Cleanup Timer

**Files**:
- `src/services/worker-types.ts` - Added `idleCleanupTimer` field to `ActiveSession`
- `src/services/worker/http/routes/SessionRoutes.ts` - Start cleanup timer when generator finishes idle
- `src/services/worker/SessionManager.ts` - Cancel timer on new work, clear on session delete

When a generator finishes with no pending work:
1. Start a 5-minute idle cleanup timer
2. If new observations arrive, cancel the timer
3. If timer expires and session is still idle (no generator, no pending work), delete the session

This ensures orphaned sessions are cleaned up automatically, preventing accumulation.

## Design Decision: Why Not SessionEnd Hook?

Claude Code has a `SessionEnd` hook, but we intentionally don't use it for cleanup because:
- When Claude Code session ends, claude-mem may still have pending observations to process
- The SDK/Gemini session needs to finish processing its queue first
- Only after the queue is empty AND no new work arrives should the session be cleaned up

The idle timer approach respects this flow:
1. Claude Code exits → claude-mem keeps processing pending observations
2. Generator finishes → starts 5-minute idle timer
3. No new work → session cleaned up after timeout

## Files Changed

| File | Change |
|------|--------|
| `src/services/worker-types.ts` | Added `idleCleanupTimer` field |
| `src/services/worker/SessionManager.ts` | Staggered restarts + cancel timer on enqueue + clear timer on delete |
| `src/services/worker/http/routes/SessionRoutes.ts` | Start idle cleanup timer when generator finishes with no work |

## Testing

1. Open web UI settings
2. Switch provider from Gemini to Claude (or vice versa)
3. Observe: Only 1 API call (for current active session)
4. Wait 5+ minutes with no activity
5. Check `activeSessions` in `/api/stats` - should decrease as idle sessions are cleaned up

## Related Issues

- Settings hot-reload (Category L)
- Stuck message recovery (Category Q)
