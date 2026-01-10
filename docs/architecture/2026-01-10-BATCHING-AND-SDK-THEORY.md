# Claude-Mem Batching and SDK Architecture

This document explains the internal architecture of claude-mem's observation processing, batching system, and SDK agent behavior.

## Overview

Claude-mem uses a **separate Claude session (SDK agent)** to compress tool usage observations. This SDK agent runs independently from your main Claude Code session.

```
┌─────────────────────────────────────────────────────────────────┐
│                     Main Claude Code Session                     │
│  User ←→ Claude (tools: Read, Edit, Bash, etc.)                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ PostToolUse hooks
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Worker Service (port 37777)                 │
│  ┌─────────────┐    ┌─────────────┐    ┌───────────────────┐   │
│  │   Queue     │ →  │ SDK Agent   │ →  │  SQLite Database  │   │
│  │(observations)│    │(compression)│    │  (observations)   │   │
│  └─────────────┘    └─────────────┘    └───────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## What the SDK Agent Does

The SDK agent receives tool usage events and asks Claude to **compress** them into semantic observations:

**Input (raw tool event):**
```
Tool: Read
Input: {"file_path": "/src/auth.ts"}
Response: [500 lines of code...]
```

**Output (compressed observation):**
```json
{
  "title": "Auth module uses JWT with 24h expiry",
  "narrative": "The authentication system in auth.ts implements...",
  "type": "discovery",
  "concepts": ["authentication", "jwt", "security"]
}
```

## Per-Turn Processing

Each user turn triggers the following SDK API calls:

| Without Batching | With Batching |
|------------------|---------------|
| 1 call per tool use | 1 call for all tools (batched) |
| + 1 call for summary | + 1 call for summary |
| = N+1 calls | = 2 calls |

### Summary Call

At the end of each turn, the SDK generates a **session summary**:
- Groups all observations from the turn
- Creates high-level description of what was accomplished
- Stored as a session record for future context injection

## Batching System

### Configuration

```json
{
  "CLAUDE_MEM_BATCHING_ENABLED": "true",
  "CLAUDE_MEM_BATCH_MAX_SIZE": "20"
}
```

### How Batching Works

**Without Batching (default):**
```
Tool 1 → SDK API call #1 (immediate)
Tool 2 → SDK API call #2 (immediate)
Tool 3 → SDK API call #3 (immediate)
Turn ends → SDK API call #4 (summary)
Total: 4 API calls
```

**With Batching:**
```
Tool 1 → queued
Tool 2 → queued
Tool 3 → queued
Turn ends → flush → SDK API call #1 (3 obs in one prompt)
         → SDK API call #2 (summary)
Total: 2 API calls
```

### Batch Flush Triggers

1. **Turn end** (Stop hook) - Normal flush point
2. **Overflow** - Queue reaches `BATCH_MAX_SIZE` → immediate flush
3. **Next turn start** - Flush any leftover from previous turn

### MAX_SIZE Behavior

`BATCH_MAX_SIZE` is overflow protection, not "batch every N":

| Turn Tools | MAX_SIZE=3 | Result |
|------------|------------|--------|
| 2 tools | Wait for turn end | 1 batch of 2 |
| 5 tools | Overflow at 3 | 1 batch of 3 + 1 batch of 2 |
| 10 tools | Multiple overflows | 3 + 3 + 3 + 1 = 4 batches |

**Recommendation:** Set `MAX_SIZE` high (20-100) to minimize overflow flushes.

## SDK Session Lifecycle

The SDK agent uses Claude's `--resume` flag to maintain a persistent conversation:

```
Main Claude Session A (contentSessionId: "abc-123")
├── Turn 1 → SDK: fresh start → creates memorySessionId "sdk-456"
├── Turn 2 → SDK: resume="sdk-456"
├── Turn 3 → SDK: resume="sdk-456"
└── Session ends

Main Claude Session B (contentSessionId: "xyz-789")
├── Turn 1 → SDK: fresh start → creates NEW memorySessionId
└── ...
```

**Key rules:**
- First prompt of any main session → SDK fresh start
- Subsequent prompts → SDK resumes same memorySessionId
- New main session → New SDK session

## Context Accumulation Issue

**Main Claude** has auto-compact. **SDK Claude** does not.

```
Main Claude (with auto-compact):
├── Turns 1-20: context fills
├── [COMPACT] → context reduced ✓
├── Turns 21-40: context fills
├── [COMPACT] → context reduced ✓
└── Continues indefinitely...

SDK Claude (no auto-compact):
├── Turn 1: context grows
├── Turn 2: context grows
...
├── Turn 50: CONTEXT EXCEEDED 💥
```

### Error When Exceeded

```json
{
  "error": {
    "message": "Prompt exceed max tokens error!",
    "type": "PromptExceedMaxTokens",
    "code": "511"
  }
}
```

### Planned Solution: SDK Auto-Compact

See `SDK-AUTO-COMPACT-PLAN.md` for implementation details.

## Token Tracking

The SDK already tracks token usage per session:

```typescript
session.cumulativeInputTokens   // Total input tokens used
session.cumulativeOutputTokens  // Total output tokens used
```

This data comes from Claude API response `usage` field after each request.

## Timing Observations

The SDK agent is **asynchronous**. Its responses may arrive during the next turn:

```
Turn N ends     → summarize queued → SDK processing...
Turn N+1 starts → User sends prompt
                → SDK response arrives (from turn N!)
```

This is not a bug - it's the SDK finishing previous work. The "immediate SDK call on prompt" is actually leftover processing.

## Files Reference

| File | Purpose |
|------|---------|
| `src/services/worker/SDKAgent.ts` | SDK agent implementation |
| `src/services/worker/SessionManager.ts` | Queue and batch management |
| `src/services/worker/http/routes/SessionRoutes.ts` | HTTP endpoints for hooks |
| `src/shared/SettingsDefaultsManager.ts` | Batching settings |
| `src/sdk/prompts.ts` | Batch observation prompt builder |
