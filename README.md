# JillVernus Fork of Claude-Mem

This is a fork of [thedotmack/claude-mem](https://github.com/thedotmack/claude-mem) - a persistent memory compression system for Claude Code.

For full documentation, features, and installation instructions, please visit the **[upstream repository](https://github.com/thedotmack/claude-mem)**.

---

## Why This Fork?

This fork addresses specific stability and usability issues encountered in our environment. All patches are maintained separately to allow easy merging of upstream updates.

## Fork Patches

### Stability Fixes

| Patch | Description |
|-------|-------------|
| **Zombie Process Cleanup** | SDK child processes were not properly terminated when sessions ended, accumulating over time. Added explicit `SIGTERM` cleanup using process detection. |
| **Dynamic Path Resolution** | Replaced hardcoded marketplace paths with dynamic resolution to prevent crashes on different installations. |

### Usability Improvements

| Patch | Description |
|-------|-------------|
| **MCP Empty Search** | Empty search queries now return recent results instead of throwing errors. Useful for browsing recent activity. |
| **MCP Schema Enhancement** | Added explicit property definitions to MCP tool schemas so parameters are visible to Claude. |

### Optional Features

| Patch | Description |
|-------|-------------|
| **Observation Batching** | Batch multiple observations into single API calls for cost reduction. Disabled by default. See [configuration](#observation-batching-configuration) below. |
| **Autonomous Execution Prevention** | Detect and skip compaction/warmup prompts that might trigger unintended behavior. Experimental. |

---

## Observation Batching Configuration

### How It Works

Claude-mem uses a separate "SDK agent" (another Claude session) to compress your tool usage into semantic observations. By default, each tool triggers an immediate API call. **Batching** collects multiple tool observations and processes them in a single API call at turn end.

```
Without Batching:              With Batching:
Tool 1 → API call #1           Tool 1 → queued
Tool 2 → API call #2           Tool 2 → queued
Tool 3 → API call #3           Tool 3 → queued
Summary → API call #4          Turn end → API call #1 (all 3)
                                        → API call #2 (summary)
= 4 API calls                  = 2 API calls
```

### Configuration

Enable batching in `~/.claude-mem/settings.json`:

```json
{
  "CLAUDE_MEM_BATCHING_ENABLED": "true",
  "CLAUDE_MEM_BATCH_MAX_SIZE": "20"
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `CLAUDE_MEM_BATCHING_ENABLED` | `"false"` | Enable observation batching. Reduces API calls by processing multiple observations together. |
| `CLAUDE_MEM_BATCH_MAX_SIZE` | `"20"` | Overflow protection. If a turn has more tools than this, flush early. Set high (50-100) for best savings. |

### When Batches Flush

- **Turn end** - Normal: all queued observations processed together
- **Overflow** - Queue reaches MAX_SIZE → immediate flush
- **Next turn** - Any leftovers from previous turn

For detailed architecture, see [docs/architecture/2026-01-10-BATCHING-AND-SDK-THEORY.md](docs/architecture/2026-01-10-BATCHING-AND-SDK-THEORY.md).

---

## Installation

```
> /plugin marketplace add jillvernus/claude-mem

> /plugin install claude-mem
```

---

## Version Format

Fork versions follow the format `{upstream}-jv.{patch}`:
- `9.0.3-jv.1` = Based on upstream v9.0.3, fork patch version 1

---

## Acknowledgments

Thanks to [Alex Newman (@thedotmack)](https://github.com/thedotmack) for creating claude-mem.

---

## License

Same as upstream: **GNU Affero General Public License v3.0** (AGPL-3.0)

See the [LICENSE](LICENSE) file for details.
