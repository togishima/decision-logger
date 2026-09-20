# decision-logger

> Your AI already watches you make meaningful decisions while you work.
>
> **decision-logger remembers them automatically.**
>
> Occasionally run `/distill`. It finds recurring patterns and suggests what
> should become a principle, a procedure, or a reusable operation.

Local-first. SQLite. No telemetry. No cloud.

```text
work
  ↓
decisions
  ↓
accumulated evidence
  ↓
distillation
  ↓
better work system
```

Software engineering is the first supported domain, **not the limit of the
system**. The core knows nothing about code — categories, extraction guidance
and output targets all come from a domain profile, and adding product
management, design, marketing or research is a single JSON file with no schema
migration and no core change.

---

## What it is not

- **Not an ADR manager.** You never write anything down. There is no document,
  no template, no numbering scheme, no review meeting.
- **Not a notes app.** You cannot add a note. Only decisions detected during
  real work are stored.
- **Not generic AI memory.** It does not try to remember your work. It
  remembers one thing — judgments whose rationale may matter again — and throws
  away everything else.
- **Not a knowledge base.** Nothing is organised for browsing. The store exists
  to be distilled, not read.
- **Not a task manager**, not RAG, not a hosted platform, not an autonomous
  agent that edits your config.

---

## How it works

You work normally. A hook hands each finished turn to the CLI, which runs in
the background and never blocks you.

1. A **deterministic gate** rejects most sessions before any model is called —
   too few turns, too little new content, nothing new since last time.
2. Sessions that pass are **redacted**, then handed to an **analyzer** (your
   existing Claude Code or Codex CLI — no extra API key needed).
3. Candidate decisions are **validated** against the active domain profile,
   **deduplicated** against what is stored, and linked when one **refines**,
   **contradicts**, or **supersedes** another.
4. They are persisted **silently**. Most sessions record nothing. That is the
   intended behaviour.

When enough decisions accumulate, you get one non-blocking line at the start of
a session:

```text
23 unreviewed decisions.
Recurring work patterns may be ready for review.

Run /distill when convenient.
```

You run `/distill` when convenient. It proposes **principles**, **procedures**,
and **operations**, each traceable to the exact decisions that produced it. You
accept, reject, or defer. Accepted patterns never come back as new ideas.
Rejected ones lower the priority of similar proposals, and only genuinely
strong new evidence can revive a rejected theme.

**"No meaningful pattern yet" is a valid and expected result.**

---

## Install

Requires **Node 22.18+** (for `node:sqlite` and native TypeScript). There are
no runtime dependencies, so nothing is installed alongside it.

### Claude Code (recommended)

It is a plugin. Hooks, slash commands and configuration come with it:

```shell
/plugin marketplace add togishima/decision-logger
/plugin install decision-logger@decision-logger
```

Then `/reload-plugins` if it asks, and:

```shell
/decision-logger:doctor      # is automatic capture actually going to work?
/decision-logger:configure   # see and change settings
```

That is the whole setup. Capture starts on your next turn.

The plugin provides:

| Command | What it does |
|---|---|
| `/decision-logger:decisions` | What has been recorded — for trust and debugging |
| `/decision-logger:distill` | Review accumulated decisions, propose patterns |
| `/decision-logger:configure` | Show and adjust every setting |

And three hooks: a non-blocking reminder on `SessionStart`, and incremental
ingestion on `Stop` and `SessionEnd`, both detached so a turn never waits.

### Standalone CLI

For use outside an agent, or with Cursor and Codex:

```bash
git clone https://github.com/togishima/decision-logger
cd decision-logger
npm install        # typescript + @types/node, both dev-only
npm link           # or: npm install -g .
decision-logger doctor
```

`doctor` tells you whether automatic capture will actually work here — whether
an analyzer is available, whether `node` is resolvable from a hook shell, and
which agents it can read.

To wire up Claude Code hooks without the plugin:

```bash
decision-logger init --target claude-code          # prints what it would add
decision-logger init --target claude-code --apply  # writes it, keeps a .bak
```

### Cursor

Cursor imports Claude Code hooks from `.claude/settings.json`, so the step
above usually covers it. For native Cursor hooks:

```bash
decision-logger init --target cursor --apply
```

### Codex

```bash
decision-logger init --target codex --apply
```

Then run `/hooks` **inside Codex** and trust the hook. Codex binds trust to a
hash of the exact command string and will not run untrusted hooks — this step
is not optional.

See [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) for the full capability matrix
and the caveats of each environment.

---

## Commands

```text
decision-logger status              Where things stand
decision-logger list [filter]       Recorded decisions
decision-logger show <id>           One decision, with relations
decision-logger search <query>      Full-text search
decision-logger distill             Find reusable patterns
decision-logger accept <id>
decision-logger reject <id> [--reason ...]
decision-logger defer  <id> [--days 30]
decision-logger render <id> [--target claude-md|skill|checklist|...]
decision-logger doctor
decision-logger ingest [--catch-up | --file <path>]

decision-logger config list         Every setting, and which are non-default
decision-logger config get <key>
decision-logger config set <key> <value> [--project]
decision-logger config unset <key>
```

Every command takes `--json`. Slash commands are thin wrappers around this CLI,
never a second implementation.

---

## Configuration

Nothing is required. In Claude Code, run `/decision-logger:configure`. From a
terminal:

```bash
decision-logger config list
decision-logger config set notifications.unreviewedThreshold 10
decision-logger config set analyzer heuristic --project
decision-logger config unset notifications.unreviewedThreshold
```

Only real settings can be set — a typo is rejected rather than silently
ignored, and a value of the wrong type is refused before it is written.

The settings that matter day to day:

| Setting | Default | What it changes |
|---|---|---|
| `notifications.unreviewedThreshold` | `20` | How many decisions before you are reminded |
| `notifications.enabled` | `true` | Reminders on or off |
| `domain` | `software-engineering` | Which profession's vocabulary is used |
| `analyzer` | `auto` | `claude-cli`, `codex-cli`, `anthropic-api`, `heuristic` (offline), `none` |
| `ingestion.minConfidence` | `0.6` | Higher means fewer, surer decisions |
| `distillation.minDecisions` | `5` | How much evidence before `/distill` will run |
| `privacy.sendReasoningToAnalyzer` | `true` | Whether thinking blocks are forwarded |

Changes take effect on the next session; nothing needs restarting. Everything
is written to plain JSON you can also edit by hand —
`~/.config/decision-logger/config.json`:

```json
{
  "domain": "software-engineering",
  "analyzer": "auto",
  "notifications": { "unreviewedThreshold": 20, "reviewAgeDays": 14 },
  "ingestion": { "minConfidence": 0.6, "maxDecisionsPerSession": 8 },
  "privacy": { "sendReasoningToAnalyzer": true, "redactPatterns": [] }
}
```

Per-workspace overrides go in `.decision-logger/config.json`. The database is
**never** written into your project — it lives in
`~/.local/state/decision-logger/decisions.db` so it cannot pollute source
control, and decisions from every workspace live together because evidence
spanning several projects is what makes a pattern convincing.

### The prompts are files

`prompts/extract-decisions.md` and `prompts/distill-patterns.md` are plain
Markdown you can read and change. Drop a file of the same name into
`~/.config/decision-logger/prompts/` to override one. Nothing important is
hidden in code.

---

## Adding a domain

Copy `profiles/product-management.json`, change the categories and guidance,
and drop it in `~/.config/decision-logger/profiles/`. Then:

```bash
decision-logger --domain your-domain status
```

No migration, no code. That constraint is enforced by the test suite.

---

## Privacy

This tool observes AI-assisted work sessions, so it is built to keep as little
as possible. See [docs/PRIVACY.md](docs/PRIVACY.md) for exactly what is read,
what is sent, and what is stored.

- Local-first; nothing leaves your machine except the analyzer call you
  configured.
- No telemetry, ever.
- Transcripts are **never** stored — only structured decisions.
- Assistant reasoning is forwarded to the analyzer but never persisted.
- Credentials are redacted before any text leaves the process.

---

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — boundaries, models, schema,
  and why each one is where it is
- [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) — capability matrix per agent
- [docs/PRIVACY.md](docs/PRIVACY.md) — data handling

## Development

```bash
npm test        # 75 tests, no model and no network
npm run typecheck
```

The whole core is tested against an in-memory database and a scripted
analyzer, because the model is the only non-deterministic part of the system
and it sits behind a single port.

```bash
claude plugin validate .     # validates the marketplace manifest
```

Note: when both manifests are present, `plugin validate` checks the
**marketplace** one and stops. To validate the plugin itself — including
`hooks/hooks.json`, whose events must sit under a `hooks` key — validate a copy
with `marketplace.json` removed:

```bash
cp -R . /tmp/p && rm /tmp/p/.claude-plugin/marketplace.json
claude plugin validate /tmp/p
```

## License

MIT
