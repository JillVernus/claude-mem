# Batching Strategy Design: Reduce AI Costs by 70-90%

**Date**: 2026-01-07
**Status**: Design Complete, Implementation Pending
**Issue**: Each PostToolUse triggers a separate AI call (1:1 ratio), causing ~2x expected costs

## Problem Analysis

### Current Behavior
- 21 tool enqueues → 11 AI calls (should be ~3-4 with batching)
- 35% of AI calls produce zero observations (wasted)
- 0% batched calls (>1 observation per call)
- Average tokens per observation: ~19,400

### Cost Impact
- Session with 10 tools = ~10 AI calls = ~200K tokens
- Estimated waste: 50-70% of current spend

## Solution: Hybrid Batching

### Trigger Conditions (flush queue when ANY occurs)

| Trigger | Condition | Rationale |
|---------|-----------|-----------|
| **Turn End** | `UserPromptSubmit` hook fires | Definite signal that previous turn completed |
| **Idle Timeout** | 15s since last tool | Claude probably finished responding |
| **Backlog Limit** | Queue depth > 20 | Prevent unbounded accumulation |

### Flow Diagram

```
Current (wasteful):
  Tool1 → AI call → obs
  Tool2 → AI call → obs
  Tool3 → AI call → obs
  = 3 AI calls

Proposed (batched):
  Tool1 → Queue
  Tool2 → Queue
  Tool3 → Queue
  [15s idle OR next UserPromptSubmit]
  → Single AI call → 3 observations
  = 1 AI call (67% savings)
```

## Implementation Plan

### Phase 1: Queue Accumulation (Worker-side)

**File**: `src/services/worker/SessionManager.ts`

Change `queueMessage()` to NOT trigger immediate processing:
```typescript
// Current: Enqueue + emit 'message' event (wakes SDK agent immediately)
// Change: Enqueue only, no immediate wake
```

### Phase 2: Flush Triggers

**File**: `src/services/worker/http/routes/SessionRoutes.ts`

Add flush triggers:

1. **On UserPromptSubmit** (`/sessions/{id}/init`):
   ```typescript
   // Before starting new turn, flush previous turn's queue
   await this.flushBatchedTools(sessionDbId);
   ```

2. **Idle Timer**:
   ```typescript
   // In SessionManager: Start 15s timer after each enqueue
   // On timeout: emit 'flush' event
   private idleTimers: Map<number, NodeJS.Timeout> = new Map();

   queueMessage(sessionDbId, message) {
     this.resetIdleTimer(sessionDbId);
     // enqueue without immediate processing
   }

   private resetIdleTimer(sessionDbId: number) {
     clearTimeout(this.idleTimers.get(sessionDbId));
     this.idleTimers.set(sessionDbId, setTimeout(() => {
       this.emitFlush(sessionDbId);
     }, 15000));
   }
   ```

### Phase 3: Batch Prompt Construction

**File**: `src/services/worker/SDKAgent.ts` (and Gemini/OpenRouter agents)

Modify message generator to yield batched prompts:
```typescript
// Current: for await (const message of iterator) { yield single }
// Change: Collect messages until flush signal, then yield batch

async *createBatchedMessageGenerator(session) {
  const batch: Message[] = [];

  for await (const message of this.getMessageIterator(session.sessionDbId)) {
    if (message.type === 'flush') {
      if (batch.length > 0) {
        yield this.buildBatchPrompt(batch);
        batch.length = 0;
      }
    } else {
      batch.push(message);
    }
  }
}

private buildBatchPrompt(messages: Message[]): string {
  return messages.map(m => buildObservationPrompt(m)).join('\n---\n');
}
```

### Phase 4: Configuration

**File**: `src/shared/settings-defaults.ts`

Add settings:
```typescript
CLAUDE_MEM_BATCH_IDLE_TIMEOUT: 15000,  // ms before flushing idle queue
CLAUDE_MEM_BATCH_MAX_SIZE: 20,         // max tools before forced flush
CLAUDE_MEM_BATCHING_ENABLED: true,     // feature flag
```

## Files to Modify

| File | Change |
|------|--------|
| `src/services/worker/SessionManager.ts` | Add idle timer, flush logic |
| `src/services/worker/http/routes/SessionRoutes.ts` | Flush on UserPromptSubmit |
| `src/services/worker/SDKAgent.ts` | Batch prompt construction |
| `src/services/worker/GeminiAgent.ts` | Same batch logic |
| `src/services/worker/OpenRouterAgent.ts` | Same batch logic |
| `src/shared/settings-defaults.ts` | Batching config |

## Expected Results

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| AI calls per 10 tools | 10 | 1-2 | 80-90% |
| Zero-observation calls | 35% | ~5% | 30% |
| Tokens per session | 200K | 40-60K | 70% |

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Delayed observations | 15s max delay is acceptable |
| Lost tools on crash | Queue is already persisted to SQLite |
| Prompt too large | Cap batch at 20 tools |

## Testing Plan

1. Enable batching in dev environment
2. Monitor logs for `STORED(N)` where N > 1
3. Compare token usage before/after over 1 day
4. Verify no data loss during crashes
