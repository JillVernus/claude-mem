# Fix: Hardcoded Marketplace Path Causing ENOENT Errors

**Date:** 2026-01-09
**Commit:** f9577769
**Issue:** SessionStart hook failing with ENOENT

## Error

```
ENOENT: no such file or directory, open '/config/.claude/plugins/marketplaces/thedotmack/package.json'
```

## Root Cause

Two source files had hardcoded `thedotmack` marketplace paths:

| File | Line | Hardcoded Code |
|------|------|----------------|
| `src/shared/worker-utils.ts` | 9 | `const MARKETPLACE_ROOT = path.join(homedir(), '.claude', 'plugins', 'marketplaces', 'thedotmack');` |
| `src/services/infrastructure/HealthMonitor.ts` | 99 | `const marketplaceRoot = path.join(homedir(), '.claude', 'plugins', 'marketplaces', 'thedotmack');` |

These paths are used by `getPluginVersion()` and `getInstalledPluginVersion()` to read `package.json` for version checking during worker startup.

The fork is installed under `jillvernus` marketplace, but the code was looking for `thedotmack`.

## Fix

Replaced hardcoded paths with calls to the existing `getPackageRoot()` utility from `src/shared/paths.ts`:

```typescript
// Before (hardcoded)
const MARKETPLACE_ROOT = path.join(homedir(), '.claude', 'plugins', 'marketplaces', 'thedotmack');
const packageJsonPath = path.join(MARKETPLACE_ROOT, 'package.json');

// After (dynamic)
import { getPackageRoot } from "./paths.js";
const packageJsonPath = path.join(getPackageRoot(), 'package.json');
```

The `getPackageRoot()` function uses `__dirname` to dynamically resolve the plugin root, making it work for any marketplace name.

## Files Changed

- `src/shared/worker-utils.ts` - Import `getPackageRoot`, remove hardcoded `MARKETPLACE_ROOT`
- `src/services/infrastructure/HealthMonitor.ts` - Import `getPackageRoot`, use in `getInstalledPluginVersion()`
- Built plugin scripts updated with fix
