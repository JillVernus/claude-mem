# Dynamic Model Selection & Universal Custom Endpoints

**Created**: 2026-01-22
**Status**: Planning
**Priority**: Medium
**Related Issues**: Settings sync bug (fixed in v9.0.5-jv.7)

---

## Background

The current implementation has three AI providers:
- **Claude** (Anthropic Messages API)
- **Gemini** (Google Gemini v1beta API)
- **OpenRouter** (OpenAI Chat Completions API)

Each represents an **API format**, not just a specific service. The upstream repo hardcodes base URLs, forcing users to use official endpoints only. Our fork added custom base URL support for Gemini (v9.0.5-jv.2), but:

1. The implementation is incomplete (UI doesn't reflect settings properly - fixed in jv.7)
2. Model selection is still a fixed dropdown, not dynamic
3. OpenRouter/Claude don't have the same flexibility yet

---

## Goals

### Phase 1: Fix & Polish Gemini Custom Endpoints (v9.0.5-jv.7)
- [x] Fix `useSettings.ts` missing base URL fields
- [ ] Change base URL format: user provides `http://host:port/`, code appends `v1beta/models/`
- [ ] Add "Fetch Models" button (only visible when custom base URL is set)
- [ ] Use `/v1/models` endpoint for fetching (OpenAI-compatible standard)
- [ ] Fallback to text input if fetch fails
- [ ] Cache model list in localStorage

### Phase 2: Rename & Extend OpenRouter → OpenAI Compatible
- [ ] Rename settings keys:
  - `CLAUDE_MEM_OPENROUTER_*` → `CLAUDE_MEM_OPENAI_*`
- [ ] Update UI labels: "OpenRouter" → "OpenAI Compatible"
- [ ] Add `CLAUDE_MEM_OPENAI_BASE_URL` with default to OpenRouter
- [ ] Same dynamic model fetching as Gemini
- [ ] Update README with migration notes

### Phase 3: Add Claude Custom Endpoints
- [ ] Add `CLAUDE_MEM_CLAUDE_BASE_URL`
- [ ] Support Anthropic-compatible endpoints (AWS Bedrock, Azure, local proxies)
- [ ] Dynamic model fetching for custom endpoints

---

## Technical Design

### Base URL Format Change

**Current** (user must include full path):
```
CLAUDE_MEM_GEMINI_BASE_URL = "http://proxy:3000/v1beta/models"
```

**Proposed** (user provides base only, code appends standard path):
```
CLAUDE_MEM_GEMINI_BASE_URL = "http://proxy:3000/"
```

Code changes in `GeminiAgent.ts`:
```typescript
// Current:
const url = `${baseUrl}/${model}:generateContent?key=${apiKey}`;

// Proposed:
const geminiPath = 'v1beta/models';
const url = `${baseUrl}/${geminiPath}/${model}:generateContent?key=${apiKey}`;
```

### Model Fetching

**Endpoint**: `GET [base_url]/v1/models`

**Response format** (OpenAI standard):
```json
{
  "data": [
    { "id": "gemini-3-flash", "object": "model", ... },
    { "id": "gemini-2.5-flash", "object": "model", ... }
  ]
}
```

**UI Component**:
```tsx
{customBaseUrl && (
  <button onClick={fetchModels} disabled={isFetching}>
    {isFetching ? 'Fetching...' : 'Fetch Models'}
  </button>
)}

{/* If fetch successful, show dropdown */}
{availableModels.length > 0 ? (
  <select value={model} onChange={...}>
    {availableModels.map(m => <option key={m} value={m}>{m}</option>)}
  </select>
) : (
  /* Fallback to text input */
  <input type="text" value={model} onChange={...} />
)}
```

**Caching**:
```typescript
const CACHE_KEY = 'claude-mem-models-cache';
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

interface ModelsCache {
  [baseUrl: string]: {
    models: string[];
    timestamp: number;
  };
}
```

### Settings Key Rename

| Old Key | New Key |
|---------|---------|
| `CLAUDE_MEM_OPENROUTER_API_KEY` | `CLAUDE_MEM_OPENAI_API_KEY` |
| `CLAUDE_MEM_OPENROUTER_MODEL` | `CLAUDE_MEM_OPENAI_MODEL` |
| `CLAUDE_MEM_OPENROUTER_BASE_URL` | `CLAUDE_MEM_OPENAI_BASE_URL` |
| `CLAUDE_MEM_OPENROUTER_SITE_URL` | `CLAUDE_MEM_OPENAI_SITE_URL` |
| `CLAUDE_MEM_OPENROUTER_APP_NAME` | `CLAUDE_MEM_OPENAI_APP_NAME` |

**Files to update**:
- `src/shared/SettingsDefaultsManager.ts`
- `src/services/worker/OpenRouterAgent.ts` → rename to `OpenAIAgent.ts`
- `src/services/worker/http/routes/SettingsRoutes.ts`
- `src/ui/viewer/types.ts`
- `src/ui/viewer/constants/settings.ts`
- `src/ui/viewer/hooks/useSettings.ts`
- `src/ui/viewer/components/ContextSettingsModal.tsx`

---

## Files Changed

### Phase 1 (Gemini Polish)

| File | Change |
|------|--------|
| `src/ui/viewer/hooks/useSettings.ts` | Add missing base URL fields (DONE) |
| `src/services/worker/GeminiAgent.ts` | Change base URL handling, add path auto-append |
| `src/ui/viewer/components/ContextSettingsModal.tsx` | Add fetch models button, dynamic dropdown |
| `src/ui/viewer/hooks/useModelFetch.ts` | New hook for model fetching with caching |

### Phase 2 (OpenRouter → OpenAI)

| File | Change |
|------|--------|
| `src/services/worker/OpenRouterAgent.ts` | Rename to OpenAIAgent.ts, update base URL handling |
| All settings-related files | Rename OPENROUTER → OPENAI |
| `README.md` | Document the rename |

### Phase 3 (Claude Custom Endpoints)

| File | Change |
|------|--------|
| `src/shared/SettingsDefaultsManager.ts` | Add CLAUDE_MEM_CLAUDE_BASE_URL |
| `src/services/worker/SDKAgent.ts` | Support custom Anthropic endpoints |

---

## Testing Plan

1. **Default behavior unchanged**: Official endpoints work without configuration
2. **Custom Gemini**: Set base URL, fetch models, select model, verify API calls
3. **Custom OpenAI**: Same as above with OpenAI-compatible endpoint
4. **Fetch failure**: Verify fallback to text input
5. **Cache**: Verify models are cached and reused
6. **Settings sync**: Web UI reflects settings.json, saves update settings.json

---

## Version Plan

- **v9.0.5-jv.7**: Fix useSettings.ts bug (immediate)
- **v9.0.5-jv.8**: Phase 1 - Gemini polish (base URL format, fetch models)
- **v9.0.6-jv.1**: Phase 2 - OpenRouter rename + custom endpoints
- **v9.0.6-jv.2**: Phase 3 - Claude custom endpoints

---

## Notes

- User confirmed no backwards compatibility concerns (single user)
- Settings keys can be renamed freely
- Document changes in README
- Model validation in SettingsRoutes.ts should be removed/relaxed for custom endpoints
