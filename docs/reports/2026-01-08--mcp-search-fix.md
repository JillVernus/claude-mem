# MCP Search Fix Report - 2026-01-08

## Issue

After installing claude-mem from JillVernus marketplace, MCP tools were not visible to Claude Code.

When attempting to use the search tool in another session, received error:
```
Error: Error calling Worker API: Worker API error (500): {"error":"Either query or filters required for search"}
```

## Root Causes Found

### 1. Empty `.mcp.json` at Root Level

**Problem**: The root-level `.mcp.json` was empty:
```json
{ "mcpServers": {} }
```

But the actual MCP config existed in `plugin/.mcp.json`:
```json
{
  "mcpServers": {
    "mcp-search": {
      "type": "stdio",
      "command": "${CLAUDE_PLUGIN_ROOT}/scripts/mcp-server.cjs"
    }
  }
}
```

When the marketplace clones the full repo (not just the `plugin/` folder), Claude Code reads from the root `.mcp.json` which was empty.

**Fix**: Updated root `.mcp.json` to point to correct path:
```json
{
  "mcpServers": {
    "mcp-search": {
      "type": "stdio",
      "command": "${CLAUDE_PLUGIN_ROOT}/plugin/scripts/mcp-server.cjs"
    }
  }
}
```

### 2. Search API Throws on Empty Parameters

**Problem**: When Claude calls the MCP `search` tool without any arguments (just `{}`), the Worker API throws:
```
Either query or filters required for search
```

The error originates from `src/services/sqlite/SessionSearch.ts:252`:
```typescript
if (!filterClause) {
  throw new Error('Either query or filters required for search');
}
```

**Fix**: Modified `src/services/worker/SearchManager.ts` to handle the no-query-no-filters case by returning recent results instead of throwing:

```typescript
// Check if we have any filters - if not, return recent results
const hasFilters = Object.keys(options).some(k =>
  !['limit', 'offset', 'orderBy', 'format'].includes(k) && options[k] !== undefined
) || obs_type || concepts || files;

if (!hasFilters) {
  // No query and no filters - return recent results instead of throwing
  logger.debug('SEARCH', 'No query or filters provided, returning recent results');
  if (searchObservations) {
    observations = this.sessionSearch.getRecentObservations(options.limit || 20);
  }
  // ... similar for sessions and prompts
}
```

Also added three new methods to `src/services/sqlite/SessionSearch.ts`:
- `getRecentObservations(limit)`
- `getRecentSessions(limit)`
- `getRecentPrompts(limit)`

## Files Modified

1. **`.mcp.json`** - Added MCP server config with correct path
2. **`.gitignore`** - Removed `.mcp.json` from ignore list, added local dev reports
3. **`src/services/worker/SearchManager.ts`** - Handle empty search params gracefully
4. **`src/services/sqlite/SessionSearch.ts`** - Added getRecent* methods

## Commits

1. `1b8297d9` - fix: configure MCP server path for marketplace installation
2. `9104ca1a` - fix: handle empty search params by returning recent results

## Verification Steps

After reinstalling from marketplace:
1. MCP tools should be visible to Claude Code
2. Calling `search()` without parameters should return recent results
3. Calling `search(query="...")` should perform semantic search

## Related Documentation

- `docs/reports/LOCAL-FORK-CHANGES-REPORT.md` - Documents all fork changes (Category D: MCP Schema)
- The MCP schema fix (explicit property definitions) was already merged correctly
