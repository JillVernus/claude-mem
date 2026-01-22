# CLAUDE.md Generation Optimization Plan

**Created**: 2026-01-22
**Status**: Phase 1 Complete
**Priority**: Medium
**Related**: folder-context feature, context injection
**Implemented In**: v9.0.5-jv.8

---

## Problem Statement

Claude-mem generates CLAUDE.md files in almost every folder (97 files in the current project). This causes:

1. **Git pollution**: Many tracked CLAUDE.md files change frequently, creating noise in commits
2. **Performance overhead**: Every observation triggers updates to multiple folder CLAUDE.md files
3. **Unclear default behavior**: Documentation says "disabled by default" but code always runs it
4. **Empty placeholder files**: Files with "*No recent activity*" created for folders with no observations

---

## Phase 1: Immediate Fixes (v9.0.5-jv.8) ✅ COMPLETED

### 1.1 Add Missing Setting Default ✅
**File**: `src/shared/SettingsDefaultsManager.ts`
```typescript
CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED: 'false',  // Disabled by default
```

### 1.2 Check Setting Before Generation ✅
**File**: `src/utils/claude-md-utils.ts`
```typescript
// Check if folder CLAUDE.md generation is enabled (default: false)
if (settings.CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED !== 'true') {
  logger.debug('FOLDER_INDEX', 'Folder CLAUDE.md generation disabled');
  return;
}
```

### 1.3 Prevent Empty File Creation ✅
**File**: `src/utils/claude-md-utils.ts`
```typescript
// formatTimelineForClaudeMd() now returns null for empty content
if (observations.length === 0) {
  return null;  // Caller skips writing the file
}
```

### 1.4 Skip Writing When No Content ✅
**File**: `src/utils/claude-md-utils.ts`
```typescript
const formatted = formatTimelineForClaudeMd(result.content[0].text);
if (formatted === null) {
  logger.debug('FOLDER_INDEX', 'No observations for folder, skipping CLAUDE.md');
  continue;
}
```

### Files Modified ✅
| File | Change |
|------|--------|
| `src/shared/SettingsDefaultsManager.ts` | Added `CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED: 'false'` |
| `src/utils/claude-md-utils.ts` | Check setting + return null for empty content |
| `src/services/worker/agents/ResponseProcessor.ts` | Import SettingsDefaultsManager |

---

## Current Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED` | `"false"` | Enable folder-level CLAUDE.md generation |
| `CLAUDE_MEM_CONTEXT_OBSERVATIONS` | `"50"` | Max observations per folder (when enabled) |

---

## Phase 2: Smart Generation (Future)

### 2.1 Project-Scoped Generation
Only generate CLAUDE.md for folders within the current project root, not external paths.

```typescript
function shouldGenerateForFolder(folderPath: string, projectRoot: string): boolean {
  if (!folderPath.startsWith(projectRoot)) return false;

  const skipPatterns = ['/node_modules/', '/dist/', '/.git/', '/coverage/'];
  return !skipPatterns.some(p => folderPath.includes(p));
}
```

### 2.2 Throttled Updates
Don't update on every observation. Options:
- Batch updates at session end
- Update on explicit request (`/refresh-context`)
- Lazy generation when folder is accessed

### 2.3 Configurable Depth
```json
{
  "CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED": "true",
  "CLAUDE_MEM_FOLDER_CLAUDEMD_MAX_DEPTH": "3",
  "CLAUDE_MEM_FOLDER_CLAUDEMD_SKIP_PATTERNS": "node_modules,dist,.git"
}
```

---

## Phase 3: Alternative Approaches (Future)

### 3.1 Single Context File
Instead of per-folder files, use a single `.claude-mem/context.md` file containing all folder summaries.

### 3.2 On-Demand Context Injection
Don't pre-generate any files. Intercept folder reads and inject context dynamically via MCP.

---

## Cleanup Commands

### Remove existing empty CLAUDE.md files
```bash
# Find and delete empty CLAUDE.md files (containing "No recent activity")
find . -name "CLAUDE.md" -exec grep -l "No recent activity" {} \; | xargs rm -f

# Or untrack from git without deleting
git ls-files | grep "CLAUDE.md" | grep -v "^CLAUDE.md$" | xargs git rm --cached
```

---

## Testing Plan

1. **Default disabled**: Fresh install should not generate any folder CLAUDE.md files ✅
2. **Enable setting**: Setting to "true" should start generating files
3. **No empty files**: When enabled, folders without observations get no file ✅
4. **Skip patterns**: (Phase 2) node_modules and dist folders should never get CLAUDE.md
5. **Project scope**: (Phase 2) External paths should not trigger file creation

---

## Notes

- Current behavior is opt-in rather than opt-out (correct approach)
- The feature is zero-cost when disabled (no file operations at all)
- Existing CLAUDE.md files are not automatically deleted - use cleanup commands above
