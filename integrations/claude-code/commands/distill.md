---
description: Review accumulated decisions and propose reusable principles, procedures, and operations. Run occasionally, when prompted or when convenient.
argument-hint: "[--all-workspaces]"
allowed-tools: Bash
disable-model-invocation: true
---

# Distill

!`node "${CLAUDE_PLUGIN_ROOT}/../../bin/decision-logger.js" distill $ARGUMENTS`

## What to do

Walk the user through the proposals above. This is the one moment the product
asks for their attention, so make it worth it and keep it short.

For each proposal:

1. State the pattern in one sentence, in their own terms.
2. Say what it is grounded in — the evidence decisions are listed, and every
   proposal can point at the exact decisions that produced it. If a proposal's
   evidence looks thin, say so rather than advocating for it.
3. Ask whether they want to accept, reject, or defer it.

Then apply their answer:

- `decision-logger accept <id>` — they agree this is how they work. It will
  not be proposed again, and future supporting decisions attach to it.
- `decision-logger reject <id> --reason <reason>` — they disagree. Similar
  proposals rank lower from now on. Valid reasons: `too_specific`,
  `already_known`, `not_actionable`, `temporary_pattern`, `wrong_abstraction`,
  `not_worth_automating`, `other`. The reason is optional — do not interrogate
  them for one.
- `decision-logger defer <id> --days 30` — not now.

## Important

- **"No meaningful pattern yet" is a real and good answer.** If the command
  reported that, tell the user plainly and stop. Do not invent a pattern to
  fill the silence.
- **Accepting is not applying.** After a proposal is accepted, the user may
  run `decision-logger render <id> --target claude-md` (or `agents-md`,
  `skill`, `checklist`, `script`) to see it as a concrete artifact. That prints
  to stdout and writes nothing.
- **Never edit CLAUDE.md, AGENTS.md, or any skill file on your own initiative
  here.** Changing the files that steer future work is the user's decision,
  separate from agreeing that the pattern is real. Ask first, every time.
