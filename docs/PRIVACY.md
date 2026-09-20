# Privacy

decision-logger watches AI-assisted work sessions. That is an unusual amount of
access, so this document states plainly what is read, what leaves your machine,
and what is kept.

## The short version

- **Local-first.** A single SQLite file on your machine.
- **No telemetry.** None, not opt-out — there is no reporting code.
- **Transcripts are never stored.** Only structured decisions.
- **Nothing is uploaded** except the one analyzer call you configured.

## What is read

Only what an agent already exposes to its own hooks:

| Read | Why |
|---|---|
| The transcript file at the path a hook supplies | To find decisions |
| `session_id` / `conversation_id` | To make ingestion idempotent |
| `cwd` / `workspace_roots` | To identify the workspace |
| `.git/config` (`remote "origin"` url only) | To give a workspace a stable identity |

Nothing else on disk is touched. Git plumbing is read directly rather than by
shelling out, so no `git` subprocess ever runs.

Within a transcript, the parser keeps user and assistant message text, tool
**names** and a short summary (a file path or command, truncated), and the
paths of changed resources. **Tool results are skipped entirely** — they are
the bulk of a transcript and rarely carry rationale.

## What leaves your machine

Exactly one thing: the analyzer call.

| Analyzer | Where the text goes |
|---|---|
| `claude-cli` (default) | Your existing Claude Code CLI, under your own login |
| `codex-cli` | Your existing Codex CLI |
| `anthropic-api` | The Claude API, using `ANTHROPIC_API_KEY` |
| `heuristic` | **Nowhere.** Fully offline keyword matching |
| `none` | **Nowhere.** Extraction disabled |

Set `"analyzer": "heuristic"` for a completely offline install. Recall is much
lower — it only fires on explicit comparative or rejection language — and
`status` and `doctor` say when it is in use, so the store never silently looks
healthier than it is.

Before any text is sent it is **redacted** and **truncated** (default 60 000
characters, keeping the tail, where conclusions live).

### The subprocess does not create new transcripts

The Claude CLI analyzer runs with `--no-session-persistence` and
`CLAUDE_CODE_SKIP_PROMPT_HISTORY=1`, so analysing your work does not itself
write another transcript to `~/.claude/projects`. It also runs with `--bare`,
which skips hooks, skills, MCP servers and CLAUDE.md in the subprocess.

## Redaction

Applied to all session text before it leaves the process:

`sk-ant-…` · `sk-…` / `sk-proj-…` · `ghp_/gho_/ghu_/ghs_/ghr_…` ·
`AKIA…` / `ASIA…` · `AIza…` · `xoxb-/xoxp-…` · `Bearer <token>` ·
`-----BEGIN … PRIVATE KEY-----` blocks ·
`*SECRET*=`, `*PASSWORD*=`, `*TOKEN*=`, `*API_KEY*=` assignments

Add your own patterns:

```json
{ "privacy": { "redactPatterns": ["\\bacme-internal-[a-z0-9]+\\b"] } }
```

Redaction is a safety net, not the main protection. **The main protection is
that decision-logger persists structured decisions rather than conversations.**
An invalid custom pattern is ignored rather than breaking ingestion.

## Assistant reasoning

Thinking blocks contain the clearest rationale and are the most sensitive part
of a transcript. So:

- they **are** forwarded to the analyzer (that is where the "why" usually is);
- they are **never written to the database** — a test asserts this.

To stop forwarding them:

```json
{ "privacy": { "sendReasoningToAnalyzer": false } }
```

## What is stored

Per decision: subject, decision, context, reasoning, category, domain,
confidence, status, timestamps, the source agent name, the source session id,
the workspace id, plus alternatives and relations.

The reasoning field holds a one- or two-sentence rationale written by the
analyzer, not quoted conversation. The extraction prompt explicitly forbids
including secrets, credentials or personal data in any field — and the
redaction above runs before the model ever sees the text.

**Not stored:** message text, tool outputs, file contents, thinking blocks,
diffs, or anything else from the conversation.

## Inspecting and deleting

The store is one file you fully control:

```bash
decision-logger status                 # where it is
sqlite3 ~/.local/state/decision-logger/decisions.db .schema
rm ~/.local/state/decision-logger/decisions.db    # delete everything
```

Back it up by copying the file.

## Turning things off

```json
{
  "analyzer": "none",
  "notifications": { "enabled": false },
  "enabledAdapters": []
}
```

Or remove the hooks that `init` added — it keeps a `.bak` of every file it
writes.
