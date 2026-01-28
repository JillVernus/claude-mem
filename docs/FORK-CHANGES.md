# JillVernus Fork Merge Guide

This document is a step-by-step guide for merging upstream releases into the JillVernus fork.
Categories are ordered by severity (critical fixes first).

**Current Fork Version**: `9.0.8-jv.5`
**Upstream Base**: `v9.0.8` (commit `bab8f554`)
**Last Merge**: 2026-01-26
**Recent Updates**:
- `9.0.8-jv.5`: Sync Script Dotfile Fix - `cp -r plugin/*` didn't copy dotfiles (`.mcp.json`), causing MCP tools to disappear after updates
- `9.0.8-jv.4`: Provider Switch API Flood Fix - staggered session restarts + idle session cleanup timer prevents orphaned sessions
- `9.0.8-jv.3`: Stuck Message Recovery Bugfix Phase 4 - periodic orphan recovery with configurable interval + jitter
- `9.0.8-jv.2`: Stuck Message Recovery Bugfix Phases 1-3 - terminal error handling, session cache refresh, provider selection fix, crash recovery hardening
- `9.0.8-jv.1`: Merged upstream v9.0.8 - **Category C (Zombie Process Cleanup) REMOVED** - upstream now uses ProcessRegistry with PID tracking, which is superior to our pgrep-based approach
- `9.0.6-jv.8`: Timeout-Based Message Recovery - recover messages stuck from generator failures within current worker lifecycle (5 min timeout + worker_port check)
- `9.0.6-jv.7`: Stuck Message Recovery - recover orphaned "processing" messages after worker crash using storeInitEpoch
- `9.0.6-jv.6`: Memory Leak Fix - clear conversationHistory on Claude rollover to prevent unbounded growth
- `9.0.6-jv.5`: Safe Message Processing - claim→process→delete pattern prevents message loss during restarts/rollover
- `9.0.6-jv.4`: Infinite Rollover Loop Fix - reset lastInputTokens after rollover to prevent immediate re-trigger
- `9.0.6-jv.3`: Claude Session Rollover - restart SDK sessions when context grows too large
- `9.0.6-jv.2`: Context Truncation - prevent runaway context growth for Gemini/OpenAI providers
- `9.0.6-jv.1`: Merged upstream v9.0.6 (Windows console popup fixes, Chroma disabled on Windows)
- `9.0.5-jv.11`: Settings Hot-Reload - apply provider/model changes without worker restart
- `9.0.5-jv.10`: Dynamic Model Selection - URL normalization, dynamic model fetching, OpenRouter→OpenAI rename
- `9.0.5-jv.9`: Fixed Gemini/OpenRouter memorySessionId bug - generate UUID for non-Claude providers
- `9.0.5-jv.8`: Fixed folder CLAUDE.md generation - disabled by default, no empty files created

---

## Quick Reference

### Categories by Severity

| Priority | Category | Purpose | Files | Status |
|----------|----------|---------|-------|--------|
| ~~1~~ | ~~C: Zombie Process Cleanup~~ | ~~Memory leak fix - orphan SDK processes~~ | ~~3~~ | ✅ **UPSTREAM** (v9.0.8) |
| 1 | P: ConversationHistory Memory Leak | Memory leak fix - clear history on rollover | 1 | Active |
| 2 | A: Dynamic Path Resolution | Crash fix - hardcoded `thedotmack` paths | 2 | Active |
| 3 | J: Gemini/OpenAI memorySessionId | Bugfix - non-Claude providers crash without UUID | 2 | Active |
| 4 | M: Context Truncation | Bugfix - prevent runaway context growth for Gemini/OpenAI | 8 | Active |
| 5 | N: Claude Session Rollover | Bugfix - restart SDK sessions when context grows too large | 6 | Active |
| 6 | O: Safe Message Processing | Bugfix - claim→process→delete prevents message loss + orphan recovery + timeout recovery | 8 | Active |
| 7 | Q: Stuck Message Recovery Bugfix | Bugfix - terminal error handling, cache refresh, provider selection, periodic recovery | 5 | Active |
| 8 | R: Idle Session Cleanup | Bugfix - staggered restarts + cleanup orphaned sessions after idle timeout | 3 | Active |
| 9 | S: Sync Script Dotfile Fix | Bugfix - sync script now copies dotfiles (`.mcp.json`) | 1 | Active |
| 10 | E: Empty Search Params Fix | MCP usability - empty search returns results | 2 | Active |
| 10 | D: MCP Schema Enhancement | MCP usability - visible tool parameters | 1 | Active |
| 11 | H: Custom API Endpoints | Feature - configurable Gemini/OpenAI endpoints | 9 | Active |
| 12 | K: Dynamic Model Selection | Feature - URL normalization, model fetching, OpenRouter→OpenAI | 15 | Active |
| 13 | L: Settings Hot-Reload | Feature - apply settings changes without worker restart | 7 | Active |
| 14 | I: Folder CLAUDE.md Optimization | Fix - disable by default, no empty files | 3 | Active |
| 15 | B: Observation Batching | Cost reduction - batch API calls | 5 | ⏸️ ON HOLD |
| 16 | F: Autonomous Execution Prevention | Safety - block SDK autonomous behavior | 3 | ⏸️ ON HOLD |
| 17 | G: Fork Configuration | Identity - version and marketplace config | 4 | Active |

### Files by Category

| File | P | A | J | M | N | O | Q | R | S | E | D | H | K | L | I | B | F | G |
|------|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `scripts/sync-marketplace.cjs` | | | | | | | | | + | | | | | | | | | |
| `src/services/worker/SDKAgent.ts` | | | | | + | + | + | | | | | | | | | + | + | |
| `src/services/worker/SessionManager.ts` | | | | | + | + | + | + | | | | | | + | | + | | |
| `src/services/worker-service.ts` | | | | | | | + | | | | | | + | + | | | | |
| `src/services/worker-types.ts` | | | | | + | + | + | + | | | | | | + | + | | | | |
| `src/services/sqlite/SessionStore.ts` | | | | | | + | | | | | | | | | | | | |
| `src/services/sqlite/PendingMessageStore.ts` | | | | | | | | | | + | | | | | | | | |
| `src/services/sqlite/transactions.ts` | | | | | | | | | | + | | | | | | | | |
| `src/services/queue/SessionQueueProcessor.ts` | | | | | | | | | | + | | | | | | | | |
| `src/types/database.ts` | | | | | | + | | | | | | | | | | | | |
| `src/shared/worker-utils.ts` | | | + | | | | | | | | | | | | | | | |
| `src/services/infrastructure/HealthMonitor.ts` | | | + | | | | | | | | | | | | | | | |
| `plugin/scripts/worker-cli.js` | | | + | | | | | | | | | | | | | | | |
| `plugin/scripts/smart-install.js` | | | + | | | | | | | | | | | | | | | |
| `src/services/worker/BranchManager.ts` | | | + | | | | | | | | | | | | | | | |
| `src/services/integrations/CursorHooksInstaller.ts` | | | + | | | | | | | | | | | | | | | |
| `src/services/context/ContextBuilder.ts` | | | + | | | | | | | | | | | | | | | |
| `src/services/sync/ChromaSync.ts` | | | + | | | | | | | | | | | | | | | |
| `src/services/worker/GeminiAgent.ts` | | | | + | + | | | | | + | | | + | + | | | | | |
| `src/services/worker/OpenAIAgent.ts` | | | | + | + | | | | | + | | | + | + | | | | | |
| `src/services/worker/SearchManager.ts` | | | | | | | | | | | + | | | | | | | | |
| `src/services/sqlite/SessionSearch.ts` | | | | | | | | | | | + | | | | | | | | |
| `src/servers/mcp-server.ts` | | | | | | | | | | | | + | | | | | | | |
| `src/shared/SettingsDefaultsManager.ts` | | | | | + | + | + | | | | | | + | + | | + | + | + | |
| `src/services/worker/http/routes/SettingsRoutes.ts` | | | | | | | | | | | | | + | + | | | | | |
| `src/services/worker/http/routes/SessionRoutes.ts` | | + | | | | + | + | + | | + | | | | + | + | | | | |
| `src/services/worker/http/middleware.ts` | | | | | | | | | | | | | + | | | | | | |
| `src/ui/viewer/types.ts` | | | | | | | | | | | | | + | + | | | | | |
| `src/ui/viewer/constants/settings.ts` | | | | | | | | | | | | | + | + | | | | | |
| `src/ui/viewer/constants/api.ts` | | | | | | | | | | | | | | + | | | | | |
| `src/ui/viewer/hooks/useSettings.ts` | | | | | | | | | | | | | + | + | | | | | |
| `src/ui/viewer/hooks/useModelFetch.ts` | | | | | | | | | | | | | | + | | | | | |
| `src/ui/viewer/components/ContextSettingsModal.tsx` | | | | | | | | | | | | | + | + | | | | | |
| `src/utils/url-utils.ts` | | | | | | | | | | | | | | + | | | | | |
| `src/services/worker/agents/types.ts` | | | | | + | | | | | | | | | + | | | | | |
| `src/services/worker/agents/FallbackErrorHandler.ts` | | | | | + | | | | | | | | | | | | | | |
| `src/services/worker/agents/index.ts` | | | | | + | | | | | | | | | | | | | | |
| `src/services/worker/utils/HistoryTruncation.ts` | | | | | + | | | | | | | | | | | | | | |
| `src/utils/claude-md-utils.ts` | | | | | | | | | | | | | | | | + | | | |
| `src/services/worker/agents/ResponseProcessor.ts` | | | | | | | | | | + | | | | | + | + | | | |
| `src/sdk/prompts.ts` | | | | | | | | | | | | | | | | | + | | |
| `src/services/worker/settings/SettingsWatcher.ts` | | | | | | | | | | | | | | | + | | | | |
| `src/cli/handlers/session-init.ts` | | | | | | | | | | | | | | | | | | + | |
| `package.json` | | | | | | | | | | | | | | | | | | | + |
| `plugin/package.json` | | | | | | | | | | | | | | | | | | | + |
| `plugin/.claude-plugin/plugin.json` | | | | | | | | | | | | | | | | | | | + |
| `.claude-plugin/marketplace.json` | | | | | | | | | | | | | | | | | | + |
| `README.md` | | | | | | | | | | | | | + | | | | | | |

---

## Merge Procedure

### Step 0: Pre-Merge Assessment (CRITICAL)

Before merging, analyze upstream changes to determine if any fork patches are now redundant:

```bash
# Fetch and view upstream changes
git fetch upstream
git log --oneline v{current}..v{new}
git diff --stat v{current}..v{new}

# For each changed file, check if it overlaps with our patch categories
git show {commit_hash} --stat
```

**Assessment Checklist:**

| Category | Our Patch Purpose | Upstream Fix? | Still Needed? |
|----------|-------------------|---------------|---------------|
| C | Zombie cleanup (pgrep/SIGTERM) | ? | ? |
| A | Dynamic path resolution | ? | ? |
| E | Empty search params ('_' exclusion) | ? | ? |
| D | MCP schema visibility | ? | ? |
| B | Observation batching | ? | ? |
| F | Autonomous prevention | ? | ? |
| G | Fork config | Version bump | Update version |

**Decision Rules:**
- If upstream fixes the SAME problem with SAME approach → Remove our patch
- If upstream fixes the SAME problem with DIFFERENT approach → Evaluate which is better
- If upstream doesn't address the problem → Keep our patch
- If upstream changes the file but not the patched area → Keep our patch (verify after merge)

### Step 1: Prepare

```bash
# Stash any uncommitted changes
git stash push -m "WIP before upstream merge"

# Create backup branch
git checkout -b backup-before-merge-$(date +%Y%m%d)

# Return to main
git checkout main
```

### Step 2: Fetch and Merge

```bash
git fetch upstream
git merge v{new}  # Use tag, not upstream/main (may be behind tag)
```

### Step 4: Resolve Conflicts

> **Key Insight**: After merge, fork patches in `.ts` source files are usually preserved.
> Conflicts mainly occur in built `.cjs` files which get regenerated by `npm run build`.

**Strategy**:
1. For `.ts` source files: Verify fork patches are present
2. For `.cjs` built files: Take either version (`git checkout --theirs <file>`)
3. Rebuild after resolving all conflicts

### Step 5: Verify Each Category

Run these checks to confirm patches survived the merge:

#### Category C: Zombie Process Cleanup (CRITICAL)
```bash
grep -n 'killOrphanSubprocesses' src/services/worker/SDKAgent.ts
grep -n 'onKillOrphanSubprocesses' src/services/worker/SessionManager.ts
grep -n 'killOrphanSubprocesses' src/services/worker-service.ts
```
Expected: All 3 files should have matches.

#### Category A: Dynamic Path Resolution (CRITICAL)
```bash
grep -n 'getPackageRoot' src/shared/worker-utils.ts
grep -n 'getPackageRoot' src/services/infrastructure/HealthMonitor.ts
grep -n 'thedotmack' src/shared/worker-utils.ts  # Should return NOTHING
```
Expected: First two have matches, third returns nothing.

#### Category S: Sync Script Dotfile Fix
```bash
grep -n 'cp -r plugin/\\.' scripts/sync-marketplace.cjs
cat ~/.claude/plugins/marketplaces/jillvernus/.mcp.json  # Should have mcpServers.mcp-search configured
```
Expected: `cp -r plugin/.` syntax (copies dotfiles), and .mcp.json should have proper MCP config.

#### Category E: Empty Search Params Fix
```bash
grep -n "'\\_'" src/services/worker/SearchManager.ts  # Must exclude '_' param
grep -n 'getRecentObservations' src/services/sqlite/SessionSearch.ts
```
Expected: Both should have matches.

#### Category D: MCP Schema Enhancement
```bash
grep -A5 "name: 'search'" src/servers/mcp-server.ts | grep -E 'query|limit|project'
```
Expected: Should show explicit property definitions, NOT empty `properties: {}`.

#### Category H: Custom API Endpoints
```bash
grep -n 'CLAUDE_MEM_GEMINI_BASE_URL\|CLAUDE_MEM_OPENROUTER_BASE_URL' src/shared/SettingsDefaultsManager.ts
grep -n 'getGeminiBaseUrl' src/services/worker/GeminiAgent.ts
grep -n 'getOpenRouterBaseUrl' src/services/worker/OpenRouterAgent.ts
grep -n 'requireLocalhost' src/services/worker/http/routes/SettingsRoutes.ts | head -5
```
Expected: All 4 should have matches showing custom endpoint implementation.

#### Category B: Observation Batching
```bash
grep -n 'CLAUDE_MEM_BATCHING_ENABLED' src/shared/SettingsDefaultsManager.ts
grep -n 'buildBatchObservationPrompt' src/sdk/prompts.ts
grep -n 'getBatchIterator' src/services/worker/SessionManager.ts
```
Expected: All 3 should have matches.

#### Category F: Autonomous Execution Prevention
```bash
grep -n 'COMPACTION_PATTERN\|WARMUP_PATTERN' src/cli/handlers/session-init.ts
grep -c 'disallowedTools' src/services/worker/SDKAgent.ts  # Should list 18 tools
```
Expected: Detection patterns in session-init.ts, extended disallowedTools in SDKAgent.ts.

### Step 6: Update Version

Bump version in all 4 files (e.g., `9.0.2-jv.2` → `9.0.3-jv.1`):
- `package.json`
- `plugin/package.json`
- `plugin/.claude-plugin/plugin.json`
- `.claude-plugin/marketplace.json`

### Step 7: Build and Test

```bash
npm run build
```

Test critical functionality:
```bash
# Test MCP search with query (Category D)
curl "http://localhost:37777/api/search?query=test&limit=3"

# Test MCP empty search (Category E)
curl "http://localhost:37777/api/search?limit=3"

# Test zombie cleanup (Category C) - should show only 1-2 SDK processes
ps aux | grep 'claude.*resume' | grep -v grep | wc -l
```

### Step 8: Commit and Push

```bash
git add -A
git commit -m "Merge upstream vX.X.X with fork patches (X.X.X-jv.Y)"
git push origin main
```

---

## Category Details

### Category C: Zombie Process Cleanup (Priority 1)

**Problem**: `AbortController.abort()` doesn't kill SDK child processes. They accumulate over time.

**Solution**: Use `pgrep` to find and `SIGTERM` orphan processes by session ID.

**Files**:
| File | Change |
|------|--------|
| `src/services/worker/SDKAgent.ts:495` | `killOrphanSubprocesses()` method using pgrep |
| `src/services/worker/SessionManager.ts:25` | `onKillOrphanSubprocesses` callback |
| `src/services/worker-service.ts:158` | Wires callback to SDKAgent |

**Verification**:
```bash
# After some usage, should see only 1-2 SDK processes, not 5+
ps aux | grep 'claude.*resume' | grep -v grep
```

---

### Category A: Dynamic Path Resolution (Priority 2)

**Problem**: Upstream hardcodes `thedotmack` marketplace path, crashes on other installations.

**Solution**: Use `getPackageRoot()` from `paths.ts` for dynamic resolution, and replace all hardcoded references.

**Files**:
| File | Change |
|------|--------|
| `src/shared/worker-utils.ts` | Import and use `getPackageRoot()` |
| `src/services/infrastructure/HealthMonitor.ts` | Import and use `getPackageRoot()` |
| `plugin/scripts/worker-cli.js` | Replace hardcoded "thedotmack" with "jillvernus" (2 locations) |
| `plugin/scripts/smart-install.js:264` | Use `join(__dirname, 'worker-cli.js')` instead of `join(ROOT, 'plugin', 'scripts', 'worker-cli.js')` |
| `plugin/scripts/smart-install.js:296-312` | Update alias replacement logic to UPDATE existing aliases on upgrade |
| `src/services/worker/BranchManager.ts:14` | Replace hardcoded path with "jillvernus" |
| `src/services/integrations/CursorHooksInstaller.ts` | Replace hardcoded paths (6 locations) |
| `src/services/context/ContextBuilder.ts` | Replace hardcoded path |
| `src/services/sync/ChromaSync.ts:105` | Replace hardcoded GitHub URL |

**Critical Notes**:
- `worker-cli.js` is a standalone minified file (not built from TypeScript)
- `smart-install.js` creates shell aliases during plugin installation
- The alias MUST point to `worker-cli.js` (CLI tool), not `worker-service.cjs` (daemon)
- **v9.0.5-jv.5**: Removed marker file check and added regex-based alias UPDATE logic
  - Previously: skipped if alias existed, leaving old version paths
  - Now: uses regex to find and replace existing aliases on every install/upgrade
- **v9.0.5-jv.6**: Fixed path resolution - worker-cli.js is in `/scripts/`, NOT `/plugin/scripts/`
  - smart-install.js runs from `/scripts/`, so `__dirname` already points to correct location
  - Installed structure: `/scripts/worker-cli.js` exists, `/plugin/scripts/worker-cli.js` is empty

**Verification**:
```bash
# Should find NO hardcoded thedotmack paths in source
grep -r 'thedotmack' src/ plugin/scripts/

# Test CLI alias after installation
claude-mem restart  # Should work without "Module not found" error
```

---

### Category E: Empty Search Params Fix (Priority 3)

**Problem**: Empty MCP search throws error instead of returning recent results.

**Solution**: Check for filters, return recent results if none provided.

**Files**:
| File | Change |
|------|--------|
| `src/services/worker/SearchManager.ts:145` | Exclude `'_'` from hasFilters check |
| `src/services/sqlite/SessionSearch.ts:589-615` | `getRecentObservations/Sessions/Prompts` methods |

**Critical Fix**: MCP schema uses `_: true` as required dummy param. MUST exclude it:
```typescript
// Line 145 - MUST include '_' in exclusion list
!['limit', 'offset', 'orderBy', 'format', '_'].includes(k)
```

---

### Category D: MCP Schema Enhancement (Priority 4)

**Problem**: MCP tools have empty `properties: {}`, parameters invisible to Claude.

**Solution**: Add explicit property definitions for search and timeline tools.

**File**: `src/servers/mcp-server.ts:193-224`

**Verification**:
```bash
# Should show query, limit, project, etc. - NOT empty properties
grep -A15 "name: 'search'" src/servers/mcp-server.ts
```

---

### Category H: Custom API Endpoints (Priority 5)

**Problem**: Users cannot configure custom API endpoints for Gemini/OpenAI-compatible providers (proxies, self-hosted gateways, regional endpoints).

**Solution**: Add configurable base URL settings with validation, security controls, and UI support.

**Files**:
| File | Change |
|------|--------|
| `src/shared/SettingsDefaultsManager.ts` | Add `CLAUDE_MEM_GEMINI_BASE_URL` and `CLAUDE_MEM_OPENAI_BASE_URL` settings |
| `src/services/worker/GeminiAgent.ts` | `getGeminiBaseUrl()` method with priority: settings > env > default, trailing slash handling |
| `src/services/worker/OpenAIAgent.ts` | `getOpenAIBaseUrl()` method with priority: settings > env > default |
| `src/services/worker/http/routes/SettingsRoutes.ts` | URL validation (whitespace, credentials, protocol), localhost protection, USER_SETTINGS_PATH consistency |
| `src/services/worker/http/middleware.ts` | CORS restricted to localhost origins only (prevents CSRF attacks) |
| `src/ui/viewer/types.ts` | Add settings to Settings interface |
| `src/ui/viewer/constants/settings.ts` | Add default values (empty strings) |
| `src/ui/viewer/hooks/useSettings.ts` | Load/save base URL fields (fixed in v9.0.5-jv.7) |
| `src/ui/viewer/components/ContextSettingsModal.tsx` | UI fields with provider-specific labels and tooltips |

**Configuration** (`~/.claude-mem/settings.json`):
```json
{
  "CLAUDE_MEM_GEMINI_BASE_URL": "https://my-proxy.com/v1beta/models",
  "CLAUDE_MEM_OPENAI_BASE_URL": "https://my-gateway.com/api/v1/chat/completions"
}
```

Or via environment variables:
```bash
export GEMINI_BASE_URL="https://my-proxy.com/v1beta/models"
export OPENAI_BASE_URL="https://my-gateway.com/api/v1/chat/completions"
```

| Setting | Default | Description |
|---------|---------|-------------|
| `CLAUDE_MEM_GEMINI_BASE_URL` | — | Custom Gemini models base URL (model name appended automatically) |
| `CLAUDE_MEM_OPENAI_BASE_URL` | — | Custom OpenAI-compatible endpoint URL (full chat completions URL) |

**Security Features**:
- Localhost-only access to GET/POST /api/settings (prevents API key exfiltration)
- CORS restricted to localhost origins (prevents browser-based CSRF)
- URL validation: rejects credentials in URLs, requires http/https protocol
- Warning logged when http:// is used (insecure transmission)

**URL Semantics**:
- **Gemini**: Expects "models base" - model name is appended automatically
  - Example: `https://proxy.com/v1beta/models` → `https://proxy.com/v1beta/models/gemini-2.5-flash:generateContent`
- **OpenAI**: Expects full endpoint URL - nothing is appended
  - Example: `https://gateway.com/api/v1/chat/completions` (complete URL)

**Verification**:
```bash
# Check settings schema
grep -n 'CLAUDE_MEM_GEMINI_BASE_URL\|CLAUDE_MEM_OPENAI_BASE_URL' src/shared/SettingsDefaultsManager.ts

# Check agent implementations
grep -n 'getGeminiBaseUrl\|getOpenAIBaseUrl' src/services/worker/GeminiAgent.ts src/services/worker/OpenAIAgent.ts

# Check security controls
grep -n 'requireLocalhost' src/services/worker/http/routes/SettingsRoutes.ts
grep -n 'localhostPatterns' src/services/worker/http/middleware.ts

# Check UI implementation
grep -n 'CLAUDE_MEM_GEMINI_BASE_URL\|CLAUDE_MEM_OPENAI_BASE_URL' src/ui/viewer/components/ContextSettingsModal.tsx
```

**Documentation**:
- `docs/public/usage/gemini-provider.mdx` - Custom API Endpoints section
- `docs/public/usage/openrouter-provider.mdx` - Custom API Endpoints section
- `docs/public/configuration.mdx` - Settings reference updated
- `docs/public/architecture/custom-api-endpoints.mdx` - Full implementation plan

---

### Category K: Dynamic Model Selection (Priority 7)

**Problem**: Users with custom API endpoints couldn't dynamically fetch available models, and the "OpenRouter" naming was too specific for a provider that supports any OpenAI-compatible API.

**Solution**: Three-phase implementation:
1. **Phase 1a: URL Normalization** - Helper functions to handle various URL formats
2. **Phase 1b: Dynamic Model Fetching** - Worker endpoint and UI for fetching available models
3. **Phase 2: OpenRouter → OpenAI Rename** - Generalize naming and add settings migration

**Files**:
| File | Change |
|------|--------|
| `src/utils/url-utils.ts` | NEW - `normalizeBaseUrl()`, `buildGeminiApiUrl()`, `buildOpenAIApiUrl()` helpers |
| `src/services/worker/GeminiAgent.ts` | Use `buildGeminiApiUrl()`, widen `GeminiModel` type, add `DEFAULT_RPM` fallback |
| `src/services/worker/OpenAIAgent.ts` | Renamed from `OpenRouterAgent.ts`, updated all internal references |
| `src/services/worker/http/routes/SettingsRoutes.ts` | Add `GET /api/models` endpoint, update key names to OPENAI |
| `src/services/worker/http/routes/SessionRoutes.ts` | Update `startGeneratorWithProvider()` for `'openai'` provider |
| `src/services/worker-service.ts` | Update `OpenAIAgent` import and instantiation |
| `src/services/worker-types.ts` | Update `ActiveSession.currentProvider` type |
| `src/shared/SettingsDefaultsManager.ts` | Add migration function for OPENROUTER → OPENAI keys |
| `src/ui/viewer/hooks/useModelFetch.ts` | NEW - Hook for model fetching with localStorage caching |
| `src/ui/viewer/constants/api.ts` | Add `MODELS` endpoint constant |
| `src/ui/viewer/types.ts` | Rename OPENROUTER fields to OPENAI |
| `src/ui/viewer/constants/settings.ts` | Rename OPENROUTER constants to OPENAI |
| `src/ui/viewer/hooks/useSettings.ts` | Rename OPENROUTER fields to OPENAI |
| `src/ui/viewer/components/ContextSettingsModal.tsx` | Add "Fetch Models" button, update labels to "OpenAI Compatible" |
| `src/services/worker/agents/types.ts` | Update comments for OpenAI terminology |
| `README.md` | Document the rename and migration |

**Settings Migration** (automatic on first load):
```
CLAUDE_MEM_OPENROUTER_API_KEY    → CLAUDE_MEM_OPENAI_API_KEY
CLAUDE_MEM_OPENROUTER_MODEL      → CLAUDE_MEM_OPENAI_MODEL
CLAUDE_MEM_OPENROUTER_BASE_URL   → CLAUDE_MEM_OPENAI_BASE_URL
CLAUDE_MEM_OPENROUTER_SITE_URL   → CLAUDE_MEM_OPENAI_SITE_URL
CLAUDE_MEM_OPENROUTER_APP_NAME   → CLAUDE_MEM_OPENAI_APP_NAME
CLAUDE_MEM_PROVIDER=openrouter   → CLAUDE_MEM_PROVIDER=openai
```

**Dynamic Model Fetching**:
- `GET /api/models?provider=gemini|openai` - Worker endpoint (localhost-only)
- Fetches from custom base URL configured in settings
- Results cached in localStorage (24h TTL, invalidates on API key change)
- Graceful fallback to text input if fetch fails

**Verification**:
```bash
# Check URL normalization helper
grep -n 'normalizeBaseUrl' src/utils/url-utils.ts

# Check migration function
grep -n 'openRouterMigrationMap' src/shared/SettingsDefaultsManager.ts

# Check model fetching endpoint
grep -n "GET.*api/models" src/services/worker/http/routes/SettingsRoutes.ts

# Check provider type updated
grep -n "currentProvider" src/services/worker-types.ts
```

**Plan**: `docs/plans/2026-01-22-dynamic-model-selection.md`

---

### Category L: Settings Hot-Reload (Priority 8)

**Problem**: Changing provider/model settings in `~/.claude-mem/settings.json` requires a full worker restart to take effect. This is disruptive during development and testing.

**Solution**: Implement automatic generator restart when settings change, without requiring worker restart.

**Files**:
| File | Change |
|------|--------|
| `src/services/worker/settings/SettingsWatcher.ts` | NEW - Polls settings.json for changes (2s interval, 500ms debounce) |
| `src/services/worker-service.ts` | Integrates SettingsWatcher, handles change events |
| `src/services/worker-types.ts` | Adds hot-reload fields to ActiveSession |
| `src/services/queue/SessionQueueProcessor.ts` | Emits idle/busy events, fixes waitForMessage abort |
| `src/services/worker/SessionManager.ts` | Idle state tracking, restart scheduling, isGeneratorSafeToRestart |
| `src/services/worker/http/routes/SessionRoutes.ts` | Generator identity tracking, restart mutex, tryRestartGeneratorAsync |
| `src/services/worker/agents/ResponseProcessor.ts` | Calls decrementInFlight after processing |

**How It Works**:
1. `SettingsWatcher` polls `~/.claude-mem/settings.json` every 2 seconds
2. When restart-trigger keys change, active sessions are marked for restart
3. Queue processor emits `idle` when waiting for messages, `busy` when processing
4. When a generator becomes idle (queue empty, no in-flight work), it restarts with new settings
5. If already idle when settings change, restart happens immediately

**Restart-Trigger Keys**:
- `CLAUDE_MEM_PROVIDER`
- `CLAUDE_MEM_MODEL`
- `CLAUDE_MEM_GEMINI_MODEL`
- `CLAUDE_MEM_OPENAI_MODEL`
- `CLAUDE_MEM_GEMINI_API_KEY`
- `CLAUDE_MEM_OPENAI_API_KEY`
- `CLAUDE_MEM_GEMINI_BASE_URL`
- `CLAUDE_MEM_OPENAI_BASE_URL`

**Safety Features**:
- Generator identity tracking prevents `.finally()` race conditions
- Restart mutex prevents concurrent restart attempts
- Only restarts when safe: queue empty + generator idle + no in-flight work
- Debounce (500ms) prevents spurious restarts from partial file writes

**Verification**:
```bash
# Check SettingsWatcher is integrated
grep -n 'SettingsWatcher' src/services/worker-service.ts

# Check idle/busy events
grep -n "emit('idle')" src/services/queue/SessionQueueProcessor.ts

# Check restart logic
grep -n 'tryRestartGeneratorAsync' src/services/worker/http/routes/SessionRoutes.ts
```

**Plan**: `docs/plans/2026-01-23-settings-hot-reload.md`

---

### Category M: Context Truncation (Priority 4)

**Problem**: Gemini and OpenAI providers experience runaway context growth:
1. Assistant responses were appended twice (once in agent, once in ResponseProcessor)
2. No truncation mechanism existed for Gemini
3. OpenAI truncation used estimated tokens (chars/4) instead of actual API-reported tokens

**Solution**: Three-part fix:
1. Remove duplicate history appends (centralize in ResponseProcessor)
2. Implement shared truncation utility with pinned message support
3. Add retry-on-context-error with aggressive truncation

**Files**:
| File | Change |
|------|--------|
| `src/services/worker/GeminiAgent.ts` | Remove duplicate appends, add truncation, add `queryWithRetry()` |
| `src/services/worker/OpenAIAgent.ts` | Remove duplicate appends, use shared truncation, add `queryWithRetry()` |
| `src/services/worker/utils/HistoryTruncation.ts` | NEW - Shared truncation utility |
| `src/services/worker/agents/FallbackErrorHandler.ts` | Add `isContextOverflowError()` function |
| `src/services/worker/agents/types.ts` | Add `CONTEXT_OVERFLOW_PATTERNS` constant |
| `src/services/worker/agents/index.ts` | Export new functions |
| `src/services/worker-types.ts` | Add `lastInputTokens` to `ActiveSession` |
| `src/shared/SettingsDefaultsManager.ts` | Add truncation settings for both providers |

**Configuration** (`~/.claude-mem/settings.json`):
```json
{
  "CLAUDE_MEM_GEMINI_MAX_CONTEXT_MESSAGES": "20",
  "CLAUDE_MEM_GEMINI_MAX_TOKENS": "100000",
  "CLAUDE_MEM_GEMINI_TRUNCATION_ENABLED": "true",
  "CLAUDE_MEM_OPENAI_MAX_CONTEXT_MESSAGES": "20",
  "CLAUDE_MEM_OPENAI_MAX_TOKENS": "100000",
  "CLAUDE_MEM_OPENAI_TRUNCATION_ENABLED": "true"
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `CLAUDE_MEM_GEMINI_MAX_CONTEXT_MESSAGES` | `"20"` | Max messages before truncation |
| `CLAUDE_MEM_GEMINI_MAX_TOKENS` | `"100000"` | Max tokens before truncation |
| `CLAUDE_MEM_GEMINI_TRUNCATION_ENABLED` | `"true"` | Enable/disable truncation |
| `CLAUDE_MEM_OPENAI_MAX_CONTEXT_MESSAGES` | `"20"` | Max messages before truncation |
| `CLAUDE_MEM_OPENAI_MAX_TOKENS` | `"100000"` | Max tokens before truncation |
| `CLAUDE_MEM_OPENAI_TRUNCATION_ENABLED` | `"true"` | Enable/disable truncation |

**Key Features**:
- **Pinned messages**: Init/continuation prompts are never dropped (detected by `<user_request>` + `<requested_at>` markers)
- **Safety margin**: Triggers at 90% of max tokens, truncates TO 90%
- **API-reported tokens**: Uses actual `prompt_tokens` from API response as trigger signal
- **Heuristic fallback**: Uses message count + char estimate when API tokens unavailable
- **Error recovery**: On context overflow error, aggressively truncates and retries once
- **Telemetry**: Logs `contextOverflowDetected`, `contextOverflowRetrySucceeded`, `contextOverflowSkipped`

**Verification**:
```bash
# Check truncation utility exists
ls -la src/services/worker/utils/HistoryTruncation.ts

# Check settings are defined
grep -n 'CLAUDE_MEM_GEMINI_MAX_TOKENS\|CLAUDE_MEM_OPENAI_MAX_TOKENS' src/shared/SettingsDefaultsManager.ts

# Check error detection
grep -n 'isContextOverflowError' src/services/worker/agents/FallbackErrorHandler.ts

# Check agents use truncation
grep -n 'truncateHistory\|queryWithRetry' src/services/worker/GeminiAgent.ts src/services/worker/OpenAIAgent.ts
```

**Plan**: `docs/plans/2026-01-23-plan-1-gemini-openai-context-truncation.md`

---

### Category N: Claude Session Rollover (Priority 5)

**Problem**: Claude provider experiences runaway context growth:
1. `memory_session_id` was used for both DB foreign keys AND Claude SDK resume
2. Restarting Claude session = new SDK session_id = FK error (orphaned observations)
3. Context grows until model hits limit → crash

**Solution**: Decouple DB identity from provider session identity:
1. Generate stable UUID for `memory_session_id` (like Gemini/OpenAI do)
2. Store Claude SDK session_id separately in `claude_resume_session_id`
3. When threshold reached → start fresh SDK session, keep same DB identity

**Files**:
| File | Change |
|------|--------|
| `src/services/sqlite/SessionStore.ts` | Migration 21: add `claude_resume_session_id`, `last_input_tokens` columns |
| `src/types/database.ts` | Add new fields to `SdkSessionRecord` type |
| `src/services/worker-types.ts` | Add `claudeResumeSessionId` to `ActiveSession` |
| `src/services/worker/SDKAgent.ts` | Generate stable UUID, track tokens, schedule mid-session rollover |
| `src/services/worker/SessionManager.ts` | Load rollover state from DB, use `claudeResumeSessionId` for orphan cleanup |
| `src/services/worker/http/routes/SessionRoutes.ts` | Pre-start rollover check, orphan cleanup with saved resume ID |
| `src/shared/SettingsDefaultsManager.ts` | Add `CLAUDE_MEM_CLAUDE_MAX_TOKENS`, `CLAUDE_MEM_CLAUDE_ROLLOVER_ENABLED` |

**Configuration** (`~/.claude-mem/settings.json`):
```json
{
  "CLAUDE_MEM_CLAUDE_MAX_TOKENS": "150000",
  "CLAUDE_MEM_CLAUDE_ROLLOVER_ENABLED": "true"
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `CLAUDE_MEM_CLAUDE_MAX_TOKENS` | `"150000"` | Max tokens before rollover (Claude has larger context) |
| `CLAUDE_MEM_CLAUDE_ROLLOVER_ENABLED` | `"true"` | Enable/disable session rollover |

**Key Features**:
- **Session identity decoupling**: `memorySessionId` (stable UUID for FK) vs `claudeResumeSessionId` (SDK session_id for resume)
- **Token tracking**: Includes `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`
- **Persisted state**: `last_input_tokens` survives worker restarts
- **Safety margin**: Triggers at 90% of max tokens
- **Mid-session rollover**: Schedules restart via `pendingRestart` mechanism when threshold exceeded
- **Orphan cleanup preserved**: Saves `previousResumeIdForCleanup` before clearing
- **Telemetry**: `ROLLOVER_SCHEDULED`, `ROLLOVER_EXECUTED` events

**Verification**:
```bash
# Check migration exists
grep -n 'addClaudeRolloverColumns' src/services/sqlite/SessionStore.ts

# Check settings are defined
grep -n 'CLAUDE_MEM_CLAUDE_MAX_TOKENS\|CLAUDE_MEM_CLAUDE_ROLLOVER_ENABLED' src/shared/SettingsDefaultsManager.ts

# Check rollover logic
grep -n 'CLAUDE_ROLLOVER_TRIGGERED\|CLAUDE_ROLLOVER_SCHEDULED' src/services/worker/SDKAgent.ts src/services/worker/http/routes/SessionRoutes.ts
```

**Plan**: `docs/plans/2026-01-23-plan-2-claude-session-rollover.md`

---

### Category O: Safe Message Processing (Priority 7)

**Problem**: When batching is disabled, the safe `claim()` pattern marks messages as "processing" before yielding them. If the SDK/Claude CLI crashes after claiming but before completing, messages stay stuck in "processing" status indefinitely.

**Solution**: Two-part implementation:
1. **v9.0.6-jv.5**: Safe claim pattern - `claim()` marks as "processing", `markProcessed()` after completion
2. **v9.0.6-jv.7**: Orphan recovery - `storeInitEpoch`-based detection recovers stuck messages on restart

**Files**:
| File | Change |
|------|--------|
| `src/services/sqlite/PendingMessageStore.ts` | `claim()` with safe pattern, `reclaimOrphanedMessage()` for orphan recovery |
| `src/services/sqlite/transactions.ts` | `storeObservationsAndMarkComplete()` atomic transaction |
| `src/services/queue/SessionQueueProcessor.ts` | `createIterator()` uses safe `claim()` pattern |
| `src/services/worker/SDKAgent.ts` | Passes `messageId` to ResponseProcessor for atomic mark-complete |
| `src/services/worker/SessionManager.ts` | Message queue lifecycle management |
| `src/services/worker/agents/ResponseProcessor.ts` | Calls atomic `storeObservationsAndMarkComplete()` |
| `src/services/worker/GeminiAgent.ts` | Uses safe message processing pattern |
| `src/services/worker/OpenAIAgent.ts` | Uses safe message processing pattern |

**Key Features**:
- **Safe claim pattern**: Messages stay in DB with status='processing' until explicitly completed
- **Atomic completion**: `storeObservationsAndMarkComplete()` stores observations AND marks processed in single transaction
- **Orphan detection**: Uses `storeInitEpoch` to identify messages from previous crashed workers
- **Retry safeguard**: `retry_count` incremented on each re-claim, fails after 3 attempts (poison message protection)
- **NULL timestamp handling**: Query includes `IS NULL` check for edge case crashes
- **SDK prefetch safe**: Only reclaims messages with `started_processing_at_epoch < storeInitEpoch`

**How Orphan Recovery Works**:
1. `PendingMessageStore` captures `storeInitEpoch = Date.now()` at construction
2. On `claim()`, first checks for orphaned messages: `status='processing' AND (started_processing_at_epoch IS NULL OR started_processing_at_epoch < storeInitEpoch)`
3. Orphaned messages get re-claimed with `retry_count++` and new timestamp
4. After 3 retries, poison messages are marked 'failed' to prevent infinite loops
5. Only after clearing orphans does it claim new 'pending' messages

**Verification**:
```bash
# Check safe claim pattern
grep -n 'reclaimOrphanedMessage\|storeInitEpoch' src/services/sqlite/PendingMessageStore.ts

# Check atomic transaction
grep -n 'storeObservationsAndMarkComplete' src/services/sqlite/transactions.ts

# Check no stuck processing messages after restart
sqlite3 ~/.claude-mem/claude-mem.db "SELECT COUNT(*) FROM pending_messages WHERE status='processing'"
```

**Plans**:
- `docs/plans/2026-01-26-stuck-message-recovery.md` (orphan recovery)

---

### Category B: Observation Batching (Priority 6) ⏸️ ON HOLD

> **Status**: This feature is on hold. The code exists but is not actively maintained during upstream merges.

**Problem**: Each observation triggers separate API call, expensive at scale.

**Solution**: Batch multiple observations into single prompts, flushed at turn boundaries.

**Files**:
| File | Change |
|------|--------|
| `src/shared/SettingsDefaultsManager.ts` | `CLAUDE_MEM_BATCHING_ENABLED`, `CLAUDE_MEM_BATCH_MAX_SIZE` |
| `src/sdk/prompts.ts` | `buildBatchObservationPrompt()` |
| `src/services/queue/SessionQueueProcessor.ts` | `createBatchIterator()` |
| `src/services/worker/SessionManager.ts` | Batch flush logic (turn-end triggered) |
| `src/services/worker/SDKAgent.ts` | Batch mode in message generator |

**Configuration** (`~/.claude-mem/settings.json`):
```json
{
  "CLAUDE_MEM_BATCHING_ENABLED": "true",
  "CLAUDE_MEM_BATCH_MAX_SIZE": "3"
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `CLAUDE_MEM_BATCHING_ENABLED` | `"false"` | Enable batched observation processing |
| `CLAUDE_MEM_BATCH_MAX_SIZE` | `"20"` | Max observations before overflow flush |

**Note**: Batches are flushed at turn boundaries (summarize/init hooks) or on overflow. No idle timeout.

---

### Category F: Autonomous Execution Prevention (Priority 6) ⏸️ ON HOLD

> **Status**: This feature is on hold. The code exists but is not actively maintained during upstream merges.

**Problem**: SDK agent misinterprets compaction summaries as work instructions.

**Solution**: Detect and skip compaction/warmup prompts, extend disallowedTools list.

**Files**:
| File | Change |
|------|--------|
| `src/cli/handlers/session-init.ts:12-32,88-113` | Detection patterns and early exit |
| `src/services/worker/SDKAgent.ts` | Extended disallowedTools (16 tools) |
| `src/shared/SettingsDefaultsManager.ts` | `CLAUDE_MEM_FILTER_COMPACTION_PROMPTS` setting |

**Configuration** (`~/.claude-mem/settings.json`):
```json
{
  "CLAUDE_MEM_FILTER_COMPACTION_PROMPTS": "true"
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `CLAUDE_MEM_FILTER_COMPACTION_PROMPTS` | `"true"` | Filter compaction/warmup prompts from SDK processing |

**Patterns filtered**:
- `COMPACTION_PATTERN`: `^This session is being continued from a previous conversation`
- `WARMUP_PATTERN`: `^I will start by exploring the repository to understand`

**Note**: Set to `"false"` if you want compaction summaries to be processed by the SDK agent. This may be intended upstream behavior that we were incorrectly blocking.

---

### Category I: Folder CLAUDE.md Optimization (Priority 6)

**Problem**: Upstream generates CLAUDE.md files in every folder, even those with no activity. This causes:
- Git pollution (many auto-generated files tracked)
- Empty placeholder files ("*No recent activity*") created everywhere
- Performance overhead on every observation save

**Solution**:
1. Disable folder CLAUDE.md generation by default
2. When enabled, only create files for folders with actual observations (no empty files)

**Files**:
| File | Change |
|------|--------|
| `src/shared/SettingsDefaultsManager.ts` | Add `CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED` setting (default: false) |
| `src/utils/claude-md-utils.ts` | Check setting before generating; return null for empty content |
| `src/services/worker/agents/ResponseProcessor.ts` | Import SettingsDefaultsManager |

**Configuration** (`~/.claude-mem/settings.json`):
```json
{
  "CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED": "true"
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED` | `"false"` | Enable folder-level CLAUDE.md generation |

**Behavior**:
- **Disabled (default)**: No folder CLAUDE.md files are created or updated
- **Enabled**: Only creates CLAUDE.md for folders with actual observations (no empty files)

**Verification**:
```bash
# Check setting is respected
grep -n 'CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED' src/utils/claude-md-utils.ts

# Confirm no empty files are created (when enabled)
find . -name "CLAUDE.md" -exec grep -l "No recent activity" {} \;  # Should return nothing new
```

---

### Category J: Gemini/OpenAI memorySessionId Fix (Priority 3)

**Problem**: Non-Claude providers (Gemini, OpenAI-compatible) crash with "Cannot store observations: memorySessionId not yet captured" when starting fresh sessions. The ResponseProcessor requires memorySessionId to store observations, but only Claude SDK captures it from its response. Gemini/OpenAI never set it, causing crashes and silent fallback to Claude SDK.

**Solution**: Generate a UUID for memorySessionId at the start of session processing if it's not already set, and save it to the database.

**Files**:
| File | Change |
|------|--------|
| `src/services/worker/GeminiAgent.ts:137-144` | Generate UUID if memorySessionId is null, save to database |
| `src/services/worker/OpenAIAgent.ts:96-103` | Generate UUID if memorySessionId is null, save to database |

**Code Added** (both files):
```typescript
// CRITICAL: Ensure memorySessionId is set for non-Claude providers
// Claude SDK captures this from its response, but Gemini/OpenAI need to generate it
if (!session.memorySessionId) {
  const generatedId = crypto.randomUUID();
  session.memorySessionId = generatedId;
  this.dbManager.getSessionStore().updateMemorySessionId(session.sessionDbId, generatedId);
  logger.info('SDK', `Generated memorySessionId for ${provider} session | sessionDbId=${session.sessionDbId} | memorySessionId=${generatedId}`, {
    sessionId: session.sessionDbId
  });
}
```

**Verification**:
```bash
# Check fix is in place
grep -n 'crypto.randomUUID' src/services/worker/GeminiAgent.ts src/services/worker/OpenAIAgent.ts

# After worker restart, new Gemini sessions should show:
# [SDK] Generated memorySessionId for Gemini session | sessionDbId=X | memorySessionId=UUID
```

---

### Category Q: Stuck Message Recovery Bugfix (Priority 7)

**Problem**: Sessions can become orphaned with pending messages that are never processed. This occurs due to 5 interacting bugs:
1. Stale `claude_resume_session_id` prevents recovery (SDK aborts on invalid resume ID)
2. Session caching doesn't refresh `claudeResumeSessionId` from database
3. Crash recovery setTimeout lacks error handling
4. No periodic recovery for orphaned sessions
5. Recovery uses hardcoded Claude SDK, ignoring `CLAUDE_MEM_PROVIDER`

**Solution**: 4-phase implementation:
- **Phase 1**: Terminal error detection in SDKAgent.ts - clear stale resume ID on terminal errors
- **Phase 2**: Refresh session state from database on cache hit
- **Phase 3**: Add error handling to crash recovery + fix provider selection
- **Phase 4**: Add periodic orphan recovery with configurable interval + jitter

**Files**:
| File | Change |
|------|--------|
| `src/services/worker/SDKAgent.ts` | Terminal error detection with whitelist, clear resume ID (DB + memory), transient error exclusions |
| `src/services/worker/SessionManager.ts` | Refresh `claudeResumeSessionId` and `lastInputTokens` from DB on cache hit |
| `src/services/worker/http/routes/SessionRoutes.ts` | Error handling in crash recovery, `recoveryInProgress` flag |
| `src/services/worker-service.ts` | Fix provider selection in `startSessionProcessor`, add periodic recovery, add source parameter to processPendingQueues |
| `src/shared/SettingsDefaultsManager.ts` | Add `CLAUDE_MEM_PERIODIC_RECOVERY_ENABLED` and `CLAUDE_MEM_PERIODIC_RECOVERY_INTERVAL` settings |

**Configuration** (`~/.claude-mem/settings.json`):
```json
{
  "CLAUDE_MEM_PERIODIC_RECOVERY_ENABLED": "true",
  "CLAUDE_MEM_PERIODIC_RECOVERY_INTERVAL": "300000"
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `CLAUDE_MEM_PERIODIC_RECOVERY_ENABLED` | `"true"` | Enable periodic orphan recovery |
| `CLAUDE_MEM_PERIODIC_RECOVERY_INTERVAL` | `"300000"` | Interval in milliseconds (5 minutes) |

**Phase 1 Implementation** (Completed):
- Terminal error patterns: "aborted by user", "invalid session id", "unknown session", "session timed out", etc.
- Transient error patterns (word-bounded): network timeouts, rate limits, HTTP 429/502/503/504
- Only clears resume ID when: resume was attempted + error is terminal + error is not transient + not intentional abort
- Captures `runAbortController` before query to correctly detect intentional aborts

**Phase 2 Implementation** (Completed):
- In `initializeSession()`, when returning cached session, refreshes `claudeResumeSessionId` and `lastInputTokens` from database
- Logs at INFO level when resume ID changes (high-signal event)
- Logs at DEBUG level when token count changes (frequent event)
- Ensures database fixes take effect without manual session deletion

**Phase 3 Implementation** (Completed):
- **Provider Selection Fix** (`worker-service.ts`):
  - Added `getSelectedProvider()` helper that checks settings and provider availability
  - Updated `startSessionProcessor()` to accept optional provider parameter
  - Routes to correct agent: `sdkAgent.startSession()`, `geminiAgent.startSession()`, or `openAIAgent.startSession()`
  - `processPendingQueues()` now respects `CLAUDE_MEM_PROVIDER` setting
- **Crash Recovery Hardening** (`SessionRoutes.ts`):
  - Wrapped setTimeout callback in async IIFE with `.catch()` to prevent unhandled promise rejections
  - Added per-session `recoveryInProgress` flag to prevent concurrent recovery attempts
  - Added retry logic (maxRetries=2, 500ms delay) with terminal error detection
  - On terminal resume error: clears resume ID in both DB and memory, then retries
  - Always clears `recoveryInProgress` in `finally` block to prevent deadlocks
  - Graceful degradation: logs error and gives up after max retries instead of throwing
- **Type Updates** (`worker-types.ts`):
  - Added `recoveryInProgress?: boolean` field to `ActiveSession` interface

**Phase 4 Implementation** (Completed):
- **Periodic Recovery** (`worker-service.ts`):
  - Added `startPeriodicRecovery()` method with configurable interval (default: 5 minutes)
  - 0-20% additive jitter prevents thundering herd when multiple workers run
  - Uses `processPendingQueues()` which checks both `generatorPromise` and `recoveryInProgress` flags
  - Does NOT call `resetStuckMessages()` - that's handled by separate 5-minute timeout
  - Minimum 1 minute floor on interval, NaN fallback to 5 minutes
  - Added `source` parameter to `processPendingQueues()` for accurate logging
  - Integrated into worker startup/shutdown lifecycle

**Verification**:
```bash
# Phase 1: Check terminal error handling
grep -n 'isTerminalResumeError\|isTransientError' src/services/worker/SDKAgent.ts

# Phase 1: Check resume ID clearing
grep -n 'RESUME_ID_CLEARED_ON_TERMINAL_ERROR' src/services/worker/SDKAgent.ts

# Phase 2: Check cache refresh
grep -n 'ROLLOVER_STATE_REFRESH' src/services/worker/SessionManager.ts

# Phase 3: Check provider selection
grep -n 'getSelectedProvider' src/services/worker-service.ts

# Phase 3: Check crash recovery error handling
grep -n 'recoveryInProgress' src/services/worker/http/routes/SessionRoutes.ts

# Phase 4: Check periodic recovery
grep -n 'startPeriodicRecovery' src/services/worker-service.ts

# Phase 4: Check settings
grep -n 'CLAUDE_MEM_PERIODIC_RECOVERY' src/shared/SettingsDefaultsManager.ts
```

**Plan**: `docs/plans/2026-01-26-stuck-message-recovery-bugfix.md`

---

### Category S: Sync Script Dotfile Fix (Priority 9)

**Problem**: After updating claude-mem, the MCP tools disappear. The sync script uses `cp -r plugin/*` which doesn't copy hidden files (dotfiles) like `.mcp.json`.

**Solution**: Change `cp -r plugin/*` to `cp -r plugin/.` which copies all files including dotfiles.

**Files**:
| File | Change |
|------|--------|
| `scripts/sync-marketplace.cjs:64` | Change `plugin/*` to `plugin/.` for marketplace sync |
| `scripts/sync-marketplace.cjs:81` | Change `plugin/*` to `plugin/.` for cache sync |

**Key Details**:
- `cp -r plugin/*` - shell glob doesn't include dotfiles (`.mcp.json`, `.git`, etc.)
- `cp -r plugin/.` - copies directory contents including all hidden files
- The `.mcp.json` file configures MCP servers for Claude Code
- Without this fix, MCP tools disappear after every marketplace update

**Verification**:
```bash
# Check sync script uses correct syntax
grep -n 'cp -r plugin/\\.' scripts/sync-marketplace.cjs

# After sync, verify MCP config exists
cat ~/.claude/plugins/marketplaces/jillvernus/.mcp.json
# Should show: {"mcpServers":{"mcp-search":{...}}}
```

---

### Category G: Fork Configuration (Priority 10)

**Purpose**: Maintain fork identity and marketplace configuration.

**Files**: Update version in all 4 when releasing:
- `package.json`
- `plugin/package.json`
- `plugin/.claude-plugin/plugin.json`
- `.claude-plugin/marketplace.json`

**Version Format**: `{upstream}-jv.{patch}` (e.g., `9.0.2-jv.2`)

---

## Important Notes

### Version Bumping
When pushing fixes after initial merge, you MUST bump the version, otherwise the marketplace will not update.

### Architecture Changes
Upstream may change file locations. Example from v9.0.2:
- `src/hooks/*.ts` deleted → moved to `src/cli/handlers/*.ts`
- Category F patterns needed migration to new location

### Testing After Install
After marketplace install, restart worker and test:
1. MCP search with query works (Category D)
2. MCP empty search returns recent results (Category E)
3. Only 1-2 SDK processes running after usage (Category C)
