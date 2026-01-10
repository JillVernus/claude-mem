# SDK Auto-Compact Feature Implementation Plan

## Problem Statement

The SDK agent uses `--resume` to maintain a persistent Claude conversation. Unlike main Claude Code, the SDK has **no auto-compact capability**. As a session progresses, the SDK context accumulates until it exceeds Claude's token limit:

```json
{
  "error": {
    "message": "Prompt exceed max tokens error!: model max tokens is 200000, request length is 211031",
    "type": "PromptExceedMaxTokens",
    "code": "511"
  }
}
```

## Proposed Solution

Implement auto-compact for the SDK agent by:
1. Tracking cumulative input tokens (already exists)
2. Checking against a configurable threshold before each request
3. When threshold exceeded, summarize SDK history and start fresh

## Existing Infrastructure

### Token Tracking (Already Implemented)

From `SDKAgent.ts`:
```typescript
session.cumulativeInputTokens   // Accumulated from usage.input_tokens
session.cumulativeOutputTokens  // Accumulated from usage.output_tokens
```

### Session State

```typescript
interface ActiveSession {
  sessionDbId: number;
  contentSessionId: string;
  memorySessionId?: string;        // Used for --resume
  cumulativeInputTokens: number;
  cumulativeOutputTokens: number;
  // ... other fields
}
```

## Implementation Steps

### Step 1: Add Configuration Setting

**File:** `src/shared/SettingsDefaultsManager.ts`

```typescript
// Add to SettingsDefaults interface
CLAUDE_MEM_SDK_COMPACT_THRESHOLD: string;  // Token threshold for SDK auto-compact

// Add to DEFAULTS
CLAUDE_MEM_SDK_COMPACT_THRESHOLD: '150000',  // 150k tokens (leave buffer for 200k limit)
```

### Step 2: Add Pre-Request Token Check

**File:** `src/services/worker/SDKAgent.ts`

Before sending any request to Claude, check if we're approaching the limit:

```typescript
// In the message generator, before yielding to Claude
async function* createMessageGenerator(session: ActiveSession, ...): AsyncGenerator {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  const compactThreshold = parseInt(settings.CLAUDE_MEM_SDK_COMPACT_THRESHOLD, 10) || 150000;

  // Check if we need to compact before proceeding
  if (session.cumulativeInputTokens >= compactThreshold) {
    logger.info('SDK', `COMPACT_TRIGGERED | threshold=${compactThreshold} | current=${session.cumulativeInputTokens}`);
    await compactSDKSession(session);
  }

  // ... continue with normal processing
}
```

### Step 3: Implement SDK Compact Function

**File:** `src/services/worker/SDKAgent.ts` (new function)

```typescript
async function compactSDKSession(session: ActiveSession): Promise<void> {
  logger.info('SDK', `COMPACTING | sessionDbId=${session.sessionDbId} | tokens=${session.cumulativeInputTokens}`);

  // Step 3a: Generate summary of what SDK has learned
  // This is a one-shot request (no resume) asking Claude to summarize the session
  const summaryPrompt = buildSDKCompactionPrompt(session);

  // Step 3b: Make a fresh Claude call to generate the summary
  const summaryResponse = await generateCompactionSummary(summaryPrompt);

  // Step 3c: Store the summary for injection into fresh session
  session.compactedContext = summaryResponse;

  // Step 3d: Reset session state (force fresh start on next request)
  session.memorySessionId = undefined;
  session.cumulativeInputTokens = 0;
  session.cumulativeOutputTokens = 0;

  logger.info('SDK', `COMPACT_COMPLETE | sessionDbId=${session.sessionDbId} | summaryLength=${summaryResponse.length}`);
}
```

### Step 4: Create Compaction Prompt Builder

**File:** `src/sdk/prompts.ts` (new function)

```typescript
export function buildSDKCompactionPrompt(session: ActiveSession): string {
  return `
You are a memory compression agent. Your conversation history contains observations
about a coding session. Summarize the key information that should be preserved:

1. Important discoveries about the codebase
2. Decisions that were made
3. Patterns or conventions observed
4. Any context that would be valuable for future observations

Provide a concise summary (under 2000 tokens) that captures the essential context.
Do NOT include individual observation details - focus on high-level knowledge.

Format: Plain text summary, organized by topic.
`.trim();
}
```

### Step 5: Inject Compacted Context into Fresh Session

**File:** `src/services/worker/SDKAgent.ts`

Modify the message generator to include compacted context when starting fresh:

```typescript
// When starting a fresh session (no resume)
if (!session.memorySessionId && session.compactedContext) {
  // Include previous context in the system prompt
  systemPrompt = `${baseSystemPrompt}

## Previous Session Context
${session.compactedContext}

Continue processing observations with this context in mind.`;
}
```

### Step 6: Add Error Recovery (Fallback)

**File:** `src/services/worker/SDKAgent.ts`

If compact fails or error 511 still occurs, fall back to hard reset:

```typescript
try {
  // Normal SDK processing
} catch (error: any) {
  if (error.code === '511' || error.type === 'PromptExceedMaxTokens') {
    logger.warn('SDK', 'Context exceeded despite compact, forcing hard reset');

    // Hard reset - lose context but continue functioning
    session.memorySessionId = undefined;
    session.compactedContext = undefined;
    session.cumulativeInputTokens = 0;
    session.cumulativeOutputTokens = 0;

    // Retry the request
    return await retryRequest(...);
  }
  throw error;
}
```

## Configuration

### New Setting

| Setting | Default | Description |
|---------|---------|-------------|
| `CLAUDE_MEM_SDK_COMPACT_THRESHOLD` | `"150000"` | Token count threshold for SDK auto-compact. When cumulative input tokens exceed this, compact before next request. |

### User Configuration Example

```json
{
  "CLAUDE_MEM_SDK_COMPACT_THRESHOLD": "150000"
}
```

**Guidelines:**
- Claude's limit is ~200k tokens
- Set threshold to 150k (75%) for safety margin
- Lower = more frequent compacts but safer
- Higher = fewer compacts but risk of hitting limit

## Data Flow

```
Request #N arrives
       │
       ▼
┌─────────────────────────────┐
│ Check cumulativeInputTokens │
│ vs COMPACT_THRESHOLD        │
└─────────────┬───────────────┘
              │
              ▼
       ┌──────────────┐
       │ Exceeds?     │
       └──────┬───────┘
              │
     ┌────────┴────────┐
     │ YES             │ NO
     ▼                 ▼
┌──────────────┐  ┌──────────────┐
│ Generate     │  │ Normal       │
│ summary of   │  │ processing   │
│ SDK history  │  │ (resume)     │
└──────┬───────┘  └──────────────┘
       │
       ▼
┌──────────────┐
│ Clear        │
│ memorySession│
│ Reset tokens │
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ Start fresh  │
│ with summary │
│ as context   │
└──────────────┘
```

## Testing Plan

### Unit Tests

1. Token threshold detection
2. Compaction prompt generation
3. Session state reset logic
4. Context injection into fresh session

### Integration Tests

1. Simulate long session (many turns) → verify compact triggers
2. Verify observations continue after compact
3. Verify summary quality preserves key context
4. Test error 511 recovery path

### Manual Testing

1. Set low threshold (e.g., 10000) to trigger compact quickly
2. Run several turns with tools
3. Verify logs show `COMPACT_TRIGGERED`
4. Verify observations continue working
5. Check summary quality in logs

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Summary loses important context | Focus summary on patterns/decisions, not individual obs |
| Compact call itself fails | Fall back to hard reset (lose context but continue) |
| Threshold too low = frequent compacts | Default 150k should be safe for most sessions |
| Threshold too high = hit limit | Error recovery falls back to hard reset |

## Files to Modify

| File | Changes |
|------|---------|
| `src/shared/SettingsDefaultsManager.ts` | Add `CLAUDE_MEM_SDK_COMPACT_THRESHOLD` |
| `src/services/worker/SDKAgent.ts` | Add threshold check, compact function, error recovery |
| `src/sdk/prompts.ts` | Add `buildSDKCompactionPrompt()` |
| `docs/architecture/BATCHING-AND-SDK-THEORY.md` | Document the feature |
| `README.md` | Add configuration option |

## Estimated Effort

| Task | Effort |
|------|--------|
| Add setting | 10 min |
| Token check logic | 30 min |
| Compact function | 1 hour |
| Prompt builder | 30 min |
| Context injection | 30 min |
| Error recovery | 30 min |
| Testing | 1-2 hours |
| Documentation | 30 min |

**Total: ~5-6 hours**

## Future Enhancements

1. **Smarter compaction trigger** - Consider output tokens too, or message count
2. **Incremental compaction** - Compact portions rather than all-or-nothing
3. **Persistent compact history** - Store summaries in DB for cross-session context
4. **Configurable summary prompt** - Let users customize what to preserve
