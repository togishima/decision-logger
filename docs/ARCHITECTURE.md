# Architecture

## The one idea

Collect meaningful decisions automatically, then periodically distil them into
things that improve future work. Everything below exists to make that loop
reliable and to keep it from degenerating into a note-taking app.

```text
Claude Code ─┐
Cursor ──────┼── Agent / Environment Adapter
Codex ───────┤
Future tools ┘
                  ↓
         normalized work session
                  ↓
          decision-logger core
                  ↓
               SQLite
                  ↓
              /distill
                  ↓
      reusable work-pattern proposals
                  ↓
         domain-specific renderer
```

## Boundaries

Six concerns, deliberately separated. Each boundary is load-bearing; the note
under each one says what breaks if it is crossed.

| Layer | Directory | May know about |
|---|---|---|
| Environment observation | `src/adapters/` | one agent's file formats and hook payloads |
| Domain-independent representation | `src/core/model/` | nothing external |
| Storage and review state | `src/core/storage/` | the models |
| Ingestion and distillation | `src/core/ingestion/`, `src/core/distillation/` | models, storage, the analyzer port, a domain profile |
| Domain interpretation | `src/core/domains/`, `profiles/` | one profession's vocabulary |
| Artifact rendering | `src/renderers/` | one profession's output formats |

The repository root doubles as a Claude Code plugin: `.claude-plugin/` holds
the plugin and marketplace manifests, `commands/` the slash commands, and
`hooks/hooks.json` the hook wiring. Those files only ever invoke
`bin/decision-logger.js` — a slash command is never a second implementation,
which is why `/decision-logger:configure` is a wrapper around
`decision-logger config`.

**Adapters contain no analysis.** They obtain data, normalize it, and hand it
over. If a change to the Cursor adapter would need a matching change in the
Codex adapter, the logic belongs in the core.

**The core contains no profession.** There is no `if (domain === ...)` anywhere
in `src/core/`. Categories, extraction guidance, distillation guidance and
output targets all arrive from a `DomainProfile`.

**Renderers are one-way.** A renderer reads a proposal and produces text. The
core proposal model has no field that exists for a renderer's benefit — no
heading level, no file path, no frontmatter. A test asserts this.

## Normalized work session

The only thing the core accepts. Every non-essential field is optional, because
integrations differ wildly in what they can expose.

```ts
interface NormalizedWorkSession {
  source: string;          // "claude-code" — metadata, never a behaviour switch
  sessionId: string;
  workspaceId: string;
  workspaceLabel?: string;
  startedAt?: string;
  endedAt?: string;
  messages: WorkMessage[]; // { role, text, reasoning?, at? }
  toolCalls?: WorkToolCall[];
  artifacts?: WorkArtifact[];
  changedResources?: ChangedResource[];
  cursor?: number;         // line offset read up to, for incremental ingestion
  metadata?: Record<string, unknown>;
}
```

`changedResources` is deliberately not `changedFiles`. A resource may be a
document, a dataset, or a campaign in a future domain.

## Adapter interface

```ts
interface WorkAdapter {
  getName(): string;
  canHandle(input: CollectInput): boolean;
  collectSession(input: CollectInput): Promise<SessionRef[]>;
  normalizeSession(ref: SessionRef, options?): Promise<NormalizedWorkSession | undefined>;
  describe(): AdapterDescription;   // honest capability + stability notes
}
```

All three agents write JSONL, and **all three document their line schema as
internal and subject to change**. `src/adapters/jsonl-transcript.ts` therefore
recognises *shapes* rather than versions: it looks for a role and some text
wherever they appear, understands Claude/Cursor message objects, Codex rollout
payloads, and flat `{role, content}` lines, and silently skips anything else.
A format change degrades to "no decisions found", never to wrong decisions or
an exception.

## Incremental, idempotent ingestion

Ingestion is keyed on `(source, session_id)` with a stored `cursor`, not on
"the session ended".

This is the decision that de-risks all three integrations. Session-end events
are unreliable everywhere — a closed terminal fires nothing, a multi-day
session never ends, Codex can delay `SessionEnd` by 30 idle minutes, and Cursor
does not fire it for cloud agents. So the per-turn `Stop` event is the real
trigger, `SessionEnd` is a best-effort finalize, and `ingest --catch-up`
rescans anything missed. All three paths run the same pipeline and re-running
any of them is safe.

## The pipeline

```text
gate → redact → analyze → validate → classify → persist
```

The model sits only in the middle. Every guarantee the store makes is enforced
by the deterministic steps around it.

**Gate** (`core/ingestion/gate.ts`) — plain arithmetic, no model call. Too few
user turns, too little new text, or nothing new since the stored cursor means
the session costs nothing. This is what makes the logger invisible: most
sessions decide nothing worth keeping.

**Redact** (`core/ingestion/redact.ts`) — credential shapes are stripped before
any text leaves the process. A safety net, not the main protection; the main
protection is that transcripts are never persisted.

**Analyze** (`core/analysis/`) — the LLM port. One interface, five
implementations: `claude-cli`, `codex-cli`, `anthropic-api`, `heuristic`
(deterministic, offline, low recall), and `fake` (scripted, for tests). `auto`
prefers a local agent CLI because it needs no extra credential, and never
selects `heuristic` on its own — silently degrading to keyword matching would
make the store look healthy while quietly losing decisions.

**Validate** (`core/ingestion/schema.ts`, `pipeline.ts`) — the response is
schema-checked *again* on the way in, because not every analyzer can enforce a
schema and a schema-valid response can still be semantically wrong. Candidates
are dropped for an unknown category, a confidence below threshold, a subject
that is really a paragraph, or no reasoning and no alternatives. Precision over
recall is a product requirement, so this stage throws away plausible output.

**Classify** (`core/dedupe/`) — is this new, a duplicate, a refinement, a
contradiction, or a supersession? Token overlap plus SQLite FTS, no embeddings:
enough at this scale, inspectable, and it never changes behaviour because a
vendor updated a model.

The identity of a decision is its **subject**, not its full text. Comparing
whole records makes two decisions about the same question look unrelated as
soon as their reasoning differs — which is exactly the supersession case.

**Persist** — history is never deleted. A superseded decision keeps its row,
its evidence links and its relations; only its status changes.

## Domain profiles

```json
{
  "domain": "software-engineering",
  "categories": ["architecture", "dependency", "tradeoff", "...", "other"],
  "extractionGuidance": "...",
  "distillationGuidance": "...",
  "examples": [...],
  "outputTargets": [{ "id": "claude-md", "label": "CLAUDE.md rule" }]
}
```

JSON rather than YAML so the tool keeps **zero runtime dependencies**. That is
the trade-off: the product spec sketched YAML, but a YAML parser is either a
dependency or a hand-rolled subset with subtle bugs, and neither is worth it
for a config file the user rarely edits.

`category` is plain `TEXT` in the schema and is validated against the *active
profile* at ingestion time. This is why a new profession needs no migration —
a test asserts that a product-management category stores cleanly with no schema
change.

## Storage

SQLite, single file, `~/.local/state/decision-logger/decisions.db` (honouring
`XDG_STATE_HOME`). User-level rather than per-project for two reasons: a
database inside a repo is a source-control accident waiting to happen, and
evidence spanning several workspaces is exactly what makes a proposal
convincing. Per-workspace isolation is still one config key away.

Tables: `workspaces`, `decisions`, `decision_alternatives`,
`decision_relations`, `proposals`, `proposal_evidence`, `distillation_runs`,
`ingestion_log`, `app_state`, plus FTS5 indexes over decisions and proposals.

Migrations are append-only and tracked in `schema_migrations`, which the
migration runner owns — it is bookkeeping, not schema.

## Review state vs distillation input

Two different things, and conflating them breaks the product in one of two
ways.

- `reviewed_at` records that a decision has been *through* a distillation run.
  It drives the reminder and nothing else.
- Distillation operates on **all active decisions** in the window, not only the
  unreviewed ones — a pattern is usually visible precisely because old and new
  decisions rhyme.
- Every considered decision is marked reviewed, **including on a no-pattern
  run**. Otherwise the reminder would fire forever over the same decisions.

## Reminders

The one moment the tool is allowed to speak during work, so the rules are
strict: never block, once per session, once per cooldown, off by one config
key, and **never on an empty store**. A purely time-based trigger would
otherwise fire forever on day one; both triggers require at least one decision
actually waiting.

## Proposals and review history

Three kinds, deliberately profession-independent:

- **principle** — "How do I tend to decide?"
- **procedure** — "How do I repeatedly approach this kind of problem?"
- **operation** — "What do I repeatedly do that could be reusable?"

Provenance is mandatory. A proposal citing decision ids that do not resolve is
dropped: the model invented its support.

- **Accepted** → new matching evidence *attaches* to it; it is never re-proposed
  as new. Acceptance of a pattern and application of an artifact stay separate
  actions.
- **Rejected** → kept with its evidence, and its theme penalises similar future
  proposals through an explicit ranking factor. Revival requires new evidence
  above a threshold, counted from the rejection.
- **Deferred** → returns after a cooldown.

Theme matching uses statement similarity *or* evidence-set overlap, which
catches a pattern the model has simply reworded.

## Ranking

Deterministic and explainable. Every factor is a named number stored in
`score_breakdown` and printed next to the proposal:

```text
evidence, sessionSpread, sourceSpread, workspaceSpread,
recency, avgConfidence, rejectionPenalty, coveredPenalty, contradictionPenalty
```

No learned weights. If the user cannot see why something ranked high, they
cannot trust the review step — and the review step is the whole product.

## Re-entrancy

The analyzer shells out to `claude -p`, which fires the same hooks that
triggered ingestion. Two guards:

- `--bare` skips hooks, skills, MCP and CLAUDE.md in the subprocess;
- `DECISION_LOGGER_INGEST=1` makes both `ingest` and `remind` no-ops.

`--no-session-persistence` also keeps the analysis out of
`~/.claude/projects`, so observing your work does not itself create
transcripts.

## Hooks must return immediately

Budgets are between 1 and 10 seconds depending on the agent; extraction takes a
model call. `ingest --hook --detach` re-spawns itself detached, forwards the
hook payload to the child's stdin, and returns. Blocking a turn to record a
decision would violate the only rule the product has.

## Testing

75 tests, no model and no network. The whole core runs against an in-memory
database and a scripted analyzer — the payoff of keeping the only
non-deterministic component behind a single port.

Covered: meaningful decision persisted; trivial session costs no model call;
duplicate not re-inserted; refinement linked and merged; supersession preserves
history; source metadata preserved; categories come from the active profile; a
non-engineering category needs no migration; unreviewed count; every reminder
trigger and suppression rule; repeated principle and procedure; no-pattern as a
valid outcome; accepted proposal does not reappear; rejected proposal
deprioritised; strong new evidence revives; provenance intact; renderer output
does not leak into the core model; transcript shapes from all three agents;
malformed and failing analyzer responses; configuration keys derived from the
schema, typo and type rejection, and environment precedence.
