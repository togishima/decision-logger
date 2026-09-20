import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseJsonlTranscript } from "../src/adapters/jsonl-transcript.ts";
import { ClaudeCodeAdapter, projectSlug } from "../src/adapters/claude-code.ts";
import { CursorAdapter } from "../src/adapters/cursor.ts";
import { CodexAdapter } from "../src/adapters/codex.ts";
import { GenericAdapter, parseSessionDocument } from "../src/adapters/generic.ts";
import { allAdapters, selectAdapter } from "../src/adapters/registry.ts";
import { normalizeRemote, identifyWorkspace } from "../src/core/workspace.ts";
import { validateSession } from "../src/core/model/session.ts";

/** Awaits the callback before cleaning up, so async bodies still see the file. */
async function withTempFile<T>(
  name: string,
  content: string,
  fn: (path: string) => T | Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "dl-test-"));
  const path = join(dir, name);
  try {
    writeFileSync(path, content, "utf8");
    return await fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */
/* Transcript parsing                                                  */
/* ------------------------------------------------------------------ */

const CLAUDE_CODE_LINES = [
  { type: "user", message: { role: "user", content: "Should we add Redis?" }, timestamp: "2026-09-01T10:00:00Z", cwd: "/tmp/repo", sessionId: "abc" },
  {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "internal deliberation" },
        { type: "text", text: "The in-process cache already meets the target." },
        { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/tmp/repo/cache.ts" } },
      ],
    },
    timestamp: "2026-09-01T10:01:00Z",
  },
  { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } },
  { type: "summary", summary: "cache discussion" },
].map((o) => JSON.stringify(o)).join("\n");

test("Claude Code shaped lines parse into a normalized session", () => {
  const parsed = parseJsonlTranscript(CLAUDE_CODE_LINES);

  assert.equal(parsed.messages.length, 2);
  assert.equal(parsed.messages[0]!.role, "user");
  assert.equal(parsed.messages[1]!.reasoning, "internal deliberation");
  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0]!.name, "Edit");
  assert.deepEqual(parsed.changedResources, [
    { kind: "file", ref: "/tmp/repo/cache.ts", changeType: "modified" },
  ]);
  assert.equal(parsed.cwd, "/tmp/repo");
  assert.equal(parsed.cursor, 4);
});

test("Codex rollout shaped lines parse into the same model", () => {
  const lines = [
    { timestamp: "2026-09-01T10:00:00Z", type: "session_meta", payload: { session_id: "thr_1", cwd: "/tmp/repo", id: "thr_1" } },
    { timestamp: "2026-09-01T10:00:01Z", type: "event_msg", payload: { type: "user_message", message: "Pick a queue backend." } },
    { timestamp: "2026-09-01T10:00:02Z", type: "response_item", payload: { type: "reasoning", content: "weighing options" } },
    { timestamp: "2026-09-01T10:00:03Z", type: "event_msg", payload: { type: "agent_message", message: "Sticking with the cron drain." } },
    { timestamp: "2026-09-01T10:00:04Z", type: "response_item", payload: { type: "function_call", name: "apply_patch", arguments: { path: "/tmp/repo/queue.ts" } } },
    { timestamp: "2026-09-01T10:00:05Z", type: "token_usage_record", payload: { type: "token_count" } },
  ].map((o) => JSON.stringify(o)).join("\n");

  const parsed = parseJsonlTranscript(lines);

  assert.equal(parsed.sessionId, "thr_1");
  assert.equal(parsed.cwd, "/tmp/repo");
  assert.equal(parsed.messages.length, 2);
  assert.equal(parsed.messages[0]!.role, "user");
  assert.equal(parsed.messages[1]!.role, "assistant");
  assert.equal(parsed.changedResources[0]!.ref, "/tmp/repo/queue.ts");
  assert.equal(parsed.unrecognized, 0, "known rollout entries are understood, not counted as noise");
});

test("a flat role/content transcript parses too", () => {
  const lines = [
    { role: "user", content: "hello" },
    { role: "assistant", content: [{ type: "text", text: "hi" }] },
  ].map((o) => JSON.stringify(o)).join("\n");

  const parsed = parseJsonlTranscript(lines);
  assert.equal(parsed.messages.length, 2);
});

test("unknown line shapes are skipped, never thrown", () => {
  const lines = [
    "not json at all",
    JSON.stringify({ type: "mystery", fields: [1, 2, 3] }),
    JSON.stringify({ role: "user", content: "still works" }),
    '{"truncated": ', // a half-written last line, which happens on live sessions
  ].join("\n");

  const parsed = parseJsonlTranscript(lines);
  assert.equal(parsed.messages.length, 1);
  assert.equal(parsed.unrecognized, 1);
});

test("sidechain traffic is excluded", () => {
  const lines = [
    JSON.stringify({ type: "user", message: { role: "user", content: "main thread" } }),
    JSON.stringify({ type: "user", isSidechain: true, message: { role: "user", content: "subagent thread" } }),
  ].join("\n");

  const parsed = parseJsonlTranscript(lines);
  assert.equal(parsed.messages.length, 1);
  assert.equal(parsed.messages[0]!.text, "main thread");
});

test("parsing resumes from a cursor for incremental ingestion", () => {
  const lines = Array.from({ length: 6 }, (_, i) =>
    JSON.stringify({ role: "user", content: `message ${i}` }),
  ).join("\n");

  const first = parseJsonlTranscript(lines, 0);
  assert.equal(first.messages.length, 6);
  assert.equal(first.cursor, 6);

  const resumed = parseJsonlTranscript(lines, 4);
  assert.equal(resumed.messages.length, 2);
  assert.equal(resumed.messages[0]!.text, "message 4");
});

/* ------------------------------------------------------------------ */
/* Adapters                                                            */
/* ------------------------------------------------------------------ */

test("the Claude Code adapter normalizes a transcript it was handed", async () => {
  const adapter = new ClaudeCodeAdapter();
  await withTempFile("sess.jsonl", CLAUDE_CODE_LINES, async (path) => {
    const refs = await adapter.collectSession({
      transcriptPath: path,
      sessionId: "abc",
      cwd: "/tmp/repo",
    });
    assert.equal(refs.length, 1);

    const session = await adapter.normalizeSession(refs[0]!);
    assert.ok(session);
    assert.equal(session.source, "claude-code");
    assert.equal(session.sessionId, "abc");
    assert.deepEqual(validateSession(session), []);
  });
});

test("adapters carry no decision logic, only description and normalization", () => {
  for (const adapter of allAdapters()) {
    const keys = Object.getOwnPropertyNames(Object.getPrototypeOf(adapter));
    const allowed = new Set(["constructor", "getName", "canHandle", "collectSession", "normalizeSession", "describe"]);
    for (const key of keys) {
      assert.ok(allowed.has(key), `${adapter.getName()} exposes unexpected method "${key}"`);
    }
  }
});

test("every adapter describes its own limitations honestly", () => {
  for (const adapter of allAdapters()) {
    const description = adapter.describe();
    assert.equal(description.name, adapter.getName());
    assert.ok(description.notes.length > 0, `${description.name} must document its caveats`);
    assert.ok(["documented", "internal", "undocumented"].includes(description.transcriptStability));
  }
});

test("the generic adapter is a fallback, never a shadow", () => {
  const claudePath = "/home/u/.claude/projects/-tmp-repo/x.jsonl";
  const chosen = selectAdapter({ transcriptPath: claudePath });
  assert.equal(chosen?.getName(), "claude-code");

  const unknown = selectAdapter({ transcriptPath: "/tmp/whatever.jsonl" });
  assert.equal(unknown?.getName(), "generic");
});

test("the Cursor adapter refuses to guess a transcript location", async () => {
  const adapter = new CursorAdapter();
  const refs = await adapter.collectSession({ cwd: "/tmp/repo" });
  assert.equal(refs.length, 0, "no transcript path means nothing to read, not a guess");
});

test("the Codex adapter recognises rollout paths", () => {
  const adapter = new CodexAdapter();
  assert.equal(
    adapter.canHandle({ transcriptPath: "/home/u/.codex/sessions/2026/09/18/rollout-x-abc.jsonl" }),
    true,
  );
  assert.equal(adapter.canHandle({ transcriptPath: "/tmp/other.jsonl" }), false);
});

test("the generic adapter reads a normalized session document", () => {
  const document = JSON.stringify({
    source: "my-tool",
    sessionId: "s1",
    workspaceId: "ws_explicit",
    messages: [
      { role: "user", text: "Use D1 rather than Postgres." },
      { role: "assistant", text: "Recorded." },
    ],
  });

  const session = parseSessionDocument(document, { source: "generic", sessionId: "fallback" });
  assert.ok(session);
  assert.equal(session!.source, "my-tool");
  assert.equal(session!.sessionId, "s1");
  assert.equal(session!.messages.length, 2);
  assert.deepEqual(validateSession(session!), []);
});

test("the generic adapter falls back to JSONL when given a transcript", () => {
  const session = parseSessionDocument(CLAUDE_CODE_LINES, { source: "generic", sessionId: "s1" });
  assert.ok(session);
  assert.equal(session!.messages.length, 2);
});

test("a generic adapter instance still satisfies the interface", async () => {
  const adapter = new GenericAdapter();
  assert.equal(adapter.getName(), "generic");
  assert.equal((await adapter.collectSession({})).length, 0);
});

/* ------------------------------------------------------------------ */
/* Workspace identity                                                  */
/* ------------------------------------------------------------------ */

test("git remotes normalize to one identity regardless of protocol", () => {
  assert.equal(normalizeRemote("git@github.com:owner/repo.git"), "github.com/owner/repo");
  assert.equal(normalizeRemote("https://github.com/owner/repo.git"), "github.com/owner/repo");
  assert.equal(normalizeRemote("https://github.com/Owner/Repo"), "github.com/owner/repo");
});

test("workspace identity is stable and not coupled to git", () => {
  const explicit = identifyWorkspace("/tmp/anywhere", "ws_custom", "My workspace");
  assert.equal(explicit.id, "ws_custom");
  assert.equal(explicit.basis, "explicit");

  const dir = mkdtempSync(join(tmpdir(), "dl-ws-"));
  try {
    const a = identifyWorkspace(dir);
    const b = identifyWorkspace(dir);
    assert.equal(a.id, b.id, "the same directory always yields the same id");
    assert.equal(a.basis, "directory", "a non-git directory is still a workspace");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the Claude Code project slug matches the documented derivation", () => {
  assert.equal(projectSlug("/Users/ogi/projects/app"), "-Users-ogi-projects-app");
});
