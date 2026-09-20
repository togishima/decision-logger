---
description: Show and adjust decision-logger settings — reminder thresholds, domain profile, analyzer, precision, and privacy.
argument-hint: "[<setting> <value>] or blank to see everything"
allowed-tools: Bash
disable-model-invocation: true
---

# Configure decision-logger

!`node "${CLAUDE_PLUGIN_ROOT}/bin/decision-logger.js" config list`

Argument: `$ARGUMENTS`

## What to do

If `$ARGUMENTS` names a setting and a value, apply it:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/decision-logger.js" config set <key> <value>
```

Add `--project` to scope the change to this workspace instead of the user
profile. Report the before → after values the command prints.

If `$ARGUMENTS` is empty, show the settings above and ask what they want to
change. Keep it to the handful that actually matter day to day, in plain
language:

| They want | Setting |
|---|---|
| To be reminded more or less often | `notifications.unreviewedThreshold` (default 20) |
| Reminders off entirely | `notifications.enabled false` |
| A different profession's vocabulary | `domain` — run `decision-logger profiles` to see what exists |
| To work fully offline | `analyzer heuristic` (much lower recall) or `analyzer none` (off) |
| A specific model | `analyzerModel` |
| Fewer, higher-confidence decisions | `ingestion.minConfidence` (default 0.6) |
| Proposals sooner | `distillation.minDecisions` (default 5) |
| Reasoning never sent to the analyzer | `privacy.sendReasoningToAnalyzer false` |

## Notes

- Only real settings can be set; a typo is rejected rather than silently
  ignored. `config list` prints every valid key.
- `*` marks a setting that differs from its default.
- `config unset <key>` returns a setting to its default.
- Changes take effect on the next session — the hooks read config per run, so
  nothing needs restarting.
- If the command reports that the effective value differs from what was just
  written, a project-level file or an environment variable is winning. Say so
  rather than writing it again.
- After changing `domain` or `analyzer`, run
  `decision-logger doctor` to confirm the new setting actually works here.
