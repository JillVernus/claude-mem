# Plugin Cache Not Updated During `/plugin update`

**Date**: 2026-01-09
**Status**: Resolved
**Priority**: Medium

## Problem

After running `/plugin update`, the plugin cache at `~/.claude/plugins/cache/{marketplace}/{plugin}/{version}/` is not updated. The worker continues running from the old cached version, causing:

1. Version mismatch detection loops (worker restarts repeatedly)
2. SDK subprocess failures (sessions interrupted mid-process)
3. Observations not being saved

## Root Cause Analysis

### Issue 1: Build-Time Version Injection

The worker version is **baked in at build time** via esbuild's `define` option:

```typescript
// src/services/server/Server.ts
declare const __DEFAULT_PACKAGE_VERSION__: string;
const BUILT_IN_VERSION = typeof __DEFAULT_PACKAGE_VERSION__ !== 'undefined'
  ? __DEFAULT_PACKAGE_VERSION__
  : 'development';
```

**Problem**: If you update `package.json` version and commit without rebuilding, the `.cjs` files still contain the old version string.

**Solution**: Always run `npm run build` before committing version changes.

### Issue 2: How Plugin Loading Works

1. **Marketplace folder**: `~/.claude/plugins/marketplaces/jillvernus/` - Git repo with source
2. **Cache folder**: `~/.claude/plugins/cache/jillvernus/claude-mem/{version}/` - Extracted plugin files
3. **`CLAUDE_PLUGIN_ROOT`**: Set by Claude Code to point to the **cache folder**
4. **Hooks**: Execute from cache folder via `${CLAUDE_PLUGIN_ROOT}/scripts/*`

### Issue 3: Cache Folder Naming

Claude Code does not rename the cache folder when content is updated. The folder may still be named `9.0.1-jv.1` even if the `package.json` inside says `9.0.1-jv.2`. This is confusing but not a functional problem if the content is correct.

## Resolution

### Fix Applied (2026-01-09)

1. Rebuilt worker with correct version:
   ```bash
   npm run build
   git add plugin/scripts/*.cjs
   git commit -m "build: rebuild worker with version 9.0.1-jv.2"
   git push
   ```

2. Commit `61e51e6f` includes the rebuilt `worker-service.cjs` with `9.0.1-jv.2` baked in.

### Correct Release Workflow

When releasing a new version:

1. Update version in `package.json`
2. **Run `npm run build`** (or `npm run build-and-sync`)
3. Commit ALL changed files including `plugin/scripts/*.cjs`
4. Push to GitHub

### Verification

After `/plugin update` and starting a new session:

```bash
curl -s http://localhost:37777/api/version
# Expected: {"version":"9.0.1-jv.2"}
```

## Previous Hypothesis (Partially Correct)

The original hypothesis about file locking preventing cache updates was partially correct but not the primary issue. The main problem was the missing rebuild step.

## Manual Workaround (Still Valid)

If cache update issues persist:

```bash
# 1. Stop the worker
curl -X POST http://localhost:37777/api/admin/shutdown

# 2. Wait for shutdown
sleep 2

# 3. Run plugin update in Claude Code
# /plugin update claude-mem

# 4. Start new session to trigger fresh cache population
```

## Lessons Learned

1. **Always rebuild before committing version changes** - The version is compile-time, not runtime
2. **Check `/api/version` to verify** - This shows the actual baked-in version
3. **Cache folder names are misleading** - Content may be updated even if folder name is old

## Related Files

- `src/services/server/Server.ts` - `BUILT_IN_VERSION` constant (line 22)
- `scripts/build-hooks.js` - esbuild configuration with version injection
- `src/shared/paths.ts` - `getPackageRoot()` function
- `src/shared/worker-utils.ts` - `getPluginVersion()` function
- `plugin/scripts/smart-install.js` - Dependency installation on startup
