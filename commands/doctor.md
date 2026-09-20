---
description: Check that decision-logger will actually capture decisions here — analyzer, database, prompts, domain profile, and which agents it can read.
allowed-tools: Bash
disable-model-invocation: true
---

# decision-logger doctor

!`node "${CLAUDE_PLUGIN_ROOT}/bin/decision-logger.js" doctor --verbose`

## What to do

Read the report back in plain language. The question it answers is narrow:
**will decisions actually get recorded on this machine?**

The failures that matter, and what to say about each:

- **No analyzer available** — nothing will ever be recorded. They need the
  Claude Code or Codex CLI on `PATH`, or `ANTHROPIC_API_KEY` set. Offer
  `/decision-logger:configure` with `analyzer heuristic` only as a stopgap, and
  say plainly that it misses most decisions.
- **`node` not resolvable by name** — hooks run in a non-interactive shell that
  often lacks a version manager's `PATH`. The hook will fail silently every
  turn. Suggest `decision-logger init --target claude-code --apply`, which
  writes an absolute `node` path.
- **A prompt or profile is missing** — the install is broken; suggest
  reinstalling the plugin.

For adapters, `✓` means detected here, `·` means not present — that is
information, not a problem. Do not tell them to install Cursor or Codex.

If everything passes, say so in one line and stop. Do not suggest changing
settings that are working.
