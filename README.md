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

Enable batching in `~/.claude-mem/settings.json`:

```json
{
  "CLAUDE_MEM_BATCHING_ENABLED": "true",
  "CLAUDE_MEM_BATCH_MAX_SIZE": "3"
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `CLAUDE_MEM_BATCHING_ENABLED` | `"false"` | Enable/disable observation batching. When enabled, multiple observations are combined into a single API call at turn boundaries. |
| `CLAUDE_MEM_BATCH_MAX_SIZE` | `"20"` | Maximum observations per batch. When reached, batch is flushed immediately (overflow protection). |

Batches are automatically flushed at turn boundaries (when summarize or init hooks fire). No idle timeout is used.

---

## Installation

```
> /plugin marketplace add jillvernus/claude-mem

> /plugin install claude-mem
```

---

## Version Format

Fork versions follow the format `{upstream}-jv.{patch}`:
- `9.0.2-jv.2` = Based on upstream v9.0.2, fork patch version 2

---

## Acknowledgments

Thanks to [Alex Newman (@thedotmack)](https://github.com/thedotmack) for creating claude-mem.

---

## License

Same as upstream: **GNU Affero General Public License v3.0** (AGPL-3.0)

See the [LICENSE](LICENSE) file for details.
