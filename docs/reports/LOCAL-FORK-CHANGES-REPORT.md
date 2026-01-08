# Local Fork Changes Report (9.0.0 → 9.0.1-subprocess-fix)

This document catalogs all changes made to the local fork compared to upstream v9.0.0.
Use this as a guide when merging upstream v9.0.1 to preserve these customizations.

## Summary

| Category | Files | Purpose | Skip if Marketplace? |
|----------|-------|---------|---------------------|
| Local Plugin Mode | 1 | `--plugin-dir` compatibility | YES |
| Feature: Batching | 5 | Cost reduction via batch prompts | NO |
| Bug Fix: Memory Leak | 3 | Zombie process cleanup | NO |
| Enhancement: MCP Schema | 1 | Better tool discoverability | NO |

---

## Category A: Local Plugin Mode Compatibility (SKIPPABLE)

> **Skip this category if**: You publish to a marketplace and users install normally.
> **Keep this category if**: You run with `--plugin-dir` for development/testing.

### File: `src/shared/worker-utils.ts`

**Problem**: Original code has hardcoded `MARKETPLACE_ROOT` path:
```typescript
const MARKETPLACE_ROOT = path.join(homedir(), '.claude', 'plugins', 'marketplaces', 'thedotmack');
```

This crashes when running with `--plugin-dir` because that path doesn't exist.

**Solution**: Dynamic plugin root discovery:

1. Removed hardcoded `MARKETPLACE_ROOT`
2. Added `findPluginRoot()` - walks up directories to find `package.json`
3. Added ESM/CJS compatibility with try-catch around `import.meta.url`
4. `getPluginVersion()` returns `null` if plugin root not found (graceful degradation)
5. `checkWorkerVersion()` skips check when version is null

**Key Code**:
```typescript
let __workerUtilsDirname: string;
try {
  // ESM mode
  __workerUtilsDirname = path.dirname(fileURLToPath(import.meta.url));
} catch {
  // CJS mode fallback
  __workerUtilsDirname = process.cwd();
}

function findPluginRoot(): string | null {
  let current = __workerUtilsDirname;
  for (let i = 0; i < 10; i++) {
    const packagePath = path.join(current, 'package.json');
    if (existsSync(packagePath)) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}
```

---

## Category B: Feature - Batching System (KEEP)

Reduces API costs by batching multiple observations into single prompts.

### Files Modified:

#### 1. `src/shared/SettingsDefaultsManager.ts`
Added batching configuration options:
```typescript
CLAUDE_MEM_BATCHING_ENABLED: 'false'      // Off by default
CLAUDE_MEM_BATCH_IDLE_TIMEOUT: '15000'    // 15 seconds
CLAUDE_MEM_BATCH_MAX_SIZE: '20'           // Max before forced flush
```

#### 2. `src/sdk/prompts.ts`
Added `buildBatchObservationPrompt()` function:
- Combines multiple observations into single XML structure
- Uses `<batch_observations count="N">` wrapper
- Each observation maintains full context

#### 3. `src/services/queue/SessionQueueProcessor.ts`
Added `createBatchIterator()` method:
- Async iterator yielding arrays of messages (batches)
- Drains all available messages after wake-up

#### 4. `src/services/worker/SessionManager.ts`
Added batching infrastructure:
- `idleTimers: Map<number, Timer>` - per-session idle timers
- `resetIdleTimer()`, `clearIdleTimer()`, `flushBatch()` methods
- `getBatchIterator()` - async iterator for batch consumption
- Modified `queueObservation()` for batching mode

#### 5. `src/services/worker/SDKAgent.ts`
Added batching mode in message generator:
- Checks `CLAUDE_MEM_BATCHING_ENABLED` setting
- Uses `getBatchIterator()` when enabled
- Calls `buildBatchObservationPrompt()` for batched observations

---

## Category C: Bug Fix - Memory Leak / Zombie Process Cleanup (KEEP)

Fixes zombie subprocess accumulation when `AbortController.abort()` fails to kill child processes.

### Files Modified:

#### 1. `src/services/worker/SessionManager.ts`
- Added `onKillOrphanSubprocesses` callback (dependency injection)
- Added `setOnKillOrphanSubprocesses()` method
- Modified `deleteSession()` to call orphan cleanup

#### 2. `src/services/worker-service.ts`
Wired up the callback:
```typescript
this.sessionManager.setOnKillOrphanSubprocesses((memorySessionId: string) => {
  return this.sdkAgent.killOrphanSubprocesses(memorySessionId);
});
```

#### 3. `src/services/worker/http/routes/SessionRoutes.ts`
Enhanced generator lifecycle:
- Kill orphan subprocesses BEFORE starting new generator
- Diagnostic logging with unique generator IDs
- Explicit `abort()` call before restart
- **LAZY START**: Removed auto-start on `/init` (saves resources)
- `flushBatch()` call before summarize (end of turn)

---

## Category D: Enhancement - MCP Tool Schema (KEEP)

### File: `src/servers/mcp-server.ts`

**Problem**: MCP tools had empty properties with `additionalProperties: true`, making parameters invisible to Claude.

**Solution**: Added explicit property definitions for `search` and `timeline` tools:
```typescript
properties: {
  _: { type: 'boolean' },
  query: { type: 'string', description: 'Search query string' },
  limit: { type: 'number', description: 'Max results to return' },
  // ... more properties
},
required: ['_']
```

---

## Version Bump

Changed from `9.0.0` to `9.0.1-subprocess-fix` in:
- `package.json`
- `plugin/package.json`
- `plugin/.claude-plugin/plugin.json`

---

## Migration Strategy

### Option 1: Keep Local Plugin Mode (current approach)
Keep all changes. Use `--plugin-dir` for development.

### Option 2: Publish to Marketplace
1. Skip Category A changes (let upstream handle marketplace paths)
2. Keep Categories B, C, D
3. Publish fork as new marketplace entry

### Merge Steps

1. **Backup current state**:
   ```bash
   git checkout -b backup-9.0.1-subprocess-fix
   git add -A && git commit -m "Local changes before upstream merge"
   ```

2. **Add upstream remote**:
   ```bash
   git remote add upstream https://github.com/thedotmack/claude-mem.git
   ```

3. **Fetch and merge**:
   ```bash
   git fetch upstream
   git checkout main
   git merge upstream/main
   ```

4. **Resolve conflicts** (expected files):
   - `src/shared/worker-utils.ts` - Category A decision
   - `src/services/worker/SessionManager.ts` - Keep B + C changes
   - `src/services/worker/SDKAgent.ts` - Keep B changes
   - `src/services/worker/http/routes/SessionRoutes.ts` - Keep C changes

5. **Rebuild and test**:
   ```bash
   npm run build-and-sync
   claude --plugin-dir /config/workspace/claude-mem/plugin
   ```

---

## Quick Reference: Files by Category

| File | A (Local) | B (Batch) | C (Leak) | D (MCP) |
|------|:---------:|:---------:|:--------:|:-------:|
| `src/shared/worker-utils.ts` | ✓ | | | |
| `src/shared/SettingsDefaultsManager.ts` | | ✓ | | |
| `src/sdk/prompts.ts` | | ✓ | | |
| `src/services/queue/SessionQueueProcessor.ts` | | ✓ | | |
| `src/services/worker/SessionManager.ts` | | ✓ | ✓ | |
| `src/services/worker/SDKAgent.ts` | | ✓ | | |
| `src/services/worker-service.ts` | | | ✓ | |
| `src/services/worker/http/routes/SessionRoutes.ts` | | ✓ | ✓ | |
| `src/servers/mcp-server.ts` | | | | ✓ |
