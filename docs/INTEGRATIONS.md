# Integration capability matrix

Verified against official documentation on **2026-09-19**. Every claim below is
either sourced or explicitly marked as observed-but-undocumented. Nothing here
is invented: where a vendor does not document something, this document says so
rather than guessing.

Legend: **documented** · ⚠️ **undocumented / internal** · ❌ **not supported**

| | Claude Code | Cursor | OpenAI Codex CLI |
|---|---|---|---|
| **Per-turn hook** | `Stop` — documented | `stop` (`status`, `loop_count`) — documented, works for cloud agents | `Stop` (`last_assistant_message`) — documented |
| **Session-end hook** | `SessionEnd`, ~1.5 s budget (extendable to 60 s) | `sessionEnd`, fire-and-forget, timeout undocumented, **does not fire for cloud agents** | `SessionEnd`, **1 s default / 3 s max, always synchronous**, may wait until 30 idle minutes |
| **Hook exposes transcript path** | `transcript_path` on every event; written asynchronously, so the last message of a turn may be missing | `transcript_path` on every event except `workspaceOpen`; `null` when transcripts are disabled | `transcript_path` on every command hook |
| **Stable session id** | `session_id` | `conversation_id` (stable across turns) | `session_id` |
| **Transcript format** | ⚠️ `~/.claude/projects/<slug>/<id>.jsonl` — path documented, **entry format documented as internal and changing between releases** | ⚠️ **entirely undocumented** — location, format and the enable/disable setting are all unpublished | ⚠️ **undocumented** — observed at `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, and parts of Codex state are migrating to SQLite |
| **Hooks run without extra consent** | yes | yes | ❌ **no** — non-managed hooks do not run until trusted once via `/hooks`, and trust is bound to a hash of the exact command string |
| **Non-interactive LLM call** | `claude -p <prompt> --output-format json --json-schema <schema> --bare --no-session-persistence` | `agent -p --output-format json` (alias `cursor-agent`) | `codex exec --json` / `--output-schema <path>` |
| **Custom slash commands** | `.claude/commands/*.md`, `.claude/skills/<n>/SKILL.md` — documented | ⚠️ `.cursor/commands/*.md` documented only in a changelog; plugin `commands/` is documented | ⚠️ `~/.codex/prompts/*.md` — documented but officially **deprecated** in favour of Skills |
| **Skills** | `.claude/skills/<n>/SKILL.md` | `.agents/skills/`, `.cursor/skills/`, **also reads `.claude/skills/`** | `.agents/skills/`, `$HOME/.agents/skills` |
| **Plugin packaging** | `.claude-plugin/plugin.json` + `hooks/hooks.json` | `.cursor-plugin/plugin.json` (and Agent Plugins standard) | `.codex-plugin/plugin.json` |
| **Claude Code hook compatibility** | — | **yes, documented**: reads `.claude/settings.json`, maps `Stop`→`stop`, `SessionStart`→`sessionStart`, etc. | ❌ sets `CLAUDE_PLUGIN_ROOT` for compatibility but does **not** read `.claude/settings.json` |
| **Fallback ingestion needed** | partly — format instability | **yes** — never hard-code a transcript path | **yes** — trust gate plus format migration |

## What this implies for decision-logger

### Never rely on session-end

Every environment's session-end event is compromised in a different way, so
**the per-turn `Stop` event is the primary trigger** and `SessionEnd` is a
best-effort finalize. Both call the same command, and because ingestion is
keyed on `(source, session_id, cursor)`, running it repeatedly is free and
safe.

### Never hard-code a transcript path

All three hand the path over at runtime. Claude Code's layout is documented
well enough for `--catch-up` scanning; Cursor's is not documented at all, so
the Cursor adapter **refuses to guess** and reads only what it was handed (a
test asserts this). Codex's rollout layout is used for catch-up only, and is
expected to break one day — when it does, the hook path and
`ingest --file` still work.

### Never parse a documented-as-internal format strictly

All three say their line schema is internal. `jsonl-transcript.ts` matches
shapes, not versions, and skips what it does not recognise. The worst outcome
of a format change is that nothing is recorded — never a wrong decision, never
a crash.

### Hooks must return in under a second

Codex allows 1–3 seconds and ignores `async`. Claude Code allows ~1.5 seconds
by default. So the hook command is always
`ingest --hook --detach`: it forwards the payload to a detached child and
returns immediately.

### Codex needs one manual step

`decision-logger init --target codex --apply` writes the config, then prints
the instruction to run `/hooks` inside Codex and trust it. Because trust is
bound to the command string, `init` writes an absolute, stable path — changing
it would silently require re-trusting.

### Cursor is usually covered by the Claude Code setup

Cursor imports Claude Code hooks from `.claude/settings.json` by default, so
one hook command serves both. Native `.cursor/hooks.json` installation is
available for users who disabled third-party imports.

### Why node is invoked by absolute path

Hooks run in a non-interactive shell whose `PATH` frequently omits
version-manager directories (nvm, mise, asdf). `init` bakes in the absolute
`node` path, and `doctor` reports when `node` is not resolvable by name.

## Environments with no hooks at all

The CLI stays useful without any integration:

```bash
decision-logger ingest --file session.json     # a normalized session document
cat transcript.jsonl | decision-logger ingest --stdin
decision-logger ingest --catch-up              # rescan what was missed
```

The normalized session model is documented in
[ARCHITECTURE.md](ARCHITECTURE.md); any tool that can emit it can feed
decision-logger.

## Sources

**Claude Code** — <https://code.claude.com/docs/en/hooks>,
`/sessions`, `/headless`, `/slash-commands`, `/skills`, `/plugins`

**Cursor** — <https://cursor.com/docs/hooks>,
`/reference/third-party-hooks`, `/skills`, `/plugins`, `/cli/headless`,
`/cli/reference/output-format`

**Codex** — <https://developers.openai.com/codex/hooks>,
`/noninteractive`, `/config-reference`, `/skills`, `/custom-prompts`
