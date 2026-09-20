---
description: Show the decisions decision-logger has recorded for this workspace. Use for trust and debugging, not daily management.
argument-hint: "[recent|rejected|<category>|<search terms>]"
allowed-tools: Bash
disable-model-invocation: true
---

# Recorded decisions

Argument: `$ARGUMENTS`

!`node "${CLAUDE_PLUGIN_ROOT}/bin/decision-logger.js" status`

!`node "${CLAUDE_PLUGIN_ROOT}/bin/decision-logger.js" list $ARGUMENTS || true`

## What to do

Show the user what was recorded, in plain language. This command exists so they
can check that the logger is capturing the right things — and, just as
importantly, that it is *not* capturing noise.

- If a listed decision looks trivial, say so. Precision matters more than
  volume here, and a bad capture is worth flagging.
- If nothing is recorded yet, that is normal early on. Do not suggest recording
  decisions manually; the tool is meant to be invisible during work.
- For the full record of one decision, run
  `decision-logger show <id>`.
- Do not offer to edit or delete decisions. The store is append-mostly by
  design, and history is never silently removed.
