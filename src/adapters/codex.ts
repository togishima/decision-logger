import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type {
  WorkAdapter,
  CollectInput,
  SessionRef,
  NormalizeOptions,
  AdapterDescription,
} from "./adapter.ts";
import type { NormalizedWorkSession } from "../core/model/session.ts";
import { readJsonlTranscript, findFiles } from "./jsonl-transcript.ts";
import { identifyWorkspace } from "../core/workspace.ts";

/**
 * Codex adapter.
 *
 * Codex documents hooks with `session_id` and `transcript_path`, but two things
 * make it the weakest of the three integrations and both are the vendor's
 * design, not an omission here:
 *
 * 1. Hooks do not run until the user reviews and trusts them in `/hooks`, and
 *    trust is bound to a hash of the command string. `init` therefore writes a
 *    stable command and tells the user to trust it once.
 * 2. `SessionEnd` has a 1–3 second budget and can be delayed by up to 30 idle
 *    minutes, so the per-turn `Stop` event is the practical trigger.
 *
 * The rollout JSONL layout below is observed, not documented, and Codex is
 * visibly migrating parts of it to SQLite — so it is used only for catch-up
 * scanning and is expected to stop working one day. When it does, the hook
 * path and `decision-logger ingest --file` still work.
 */
export class CodexAdapter implements WorkAdapter {
  getName(): string {
    return "codex";
  }

  canHandle(input: CollectInput): boolean {
    if (input.transcriptPath) {
      return /rollout-|\.codex\//.test(input.transcriptPath);
    }
    return existsSync(sessionsRoot());
  }

  describe(): AdapterDescription {
    return {
      name: "codex",
      label: "OpenAI Codex CLI",
      automaticIngestion: "supported-with-setup",
      transcriptStability: "undocumented",
      notes: [
        "Hooks are documented, but non-managed hooks do not run until trusted once via /hooks, and trust is bound to the exact command string.",
        "SessionEnd allows only 1–3 seconds and can be delayed until a conversation has been idle for 30 minutes; Stop is the practical trigger.",
        "Rollout files under ~/.codex/sessions are an observed layout, not a documented one, and parts of Codex state are moving to SQLite.",
        "codex exec --json is the one officially stable structured path and is used by the Codex analyzer.",
      ],
    };
  }

  async collectSession(input: CollectInput): Promise<SessionRef[]> {
    if (input.transcriptPath && existsSync(input.transcriptPath)) {
      return [
        {
          source: this.getName(),
          sessionId: input.sessionId ?? basename(input.transcriptPath).replace(/\.jsonl$/, ""),
          path: input.transcriptPath,
          cwd: input.cwd,
        },
      ];
    }

    if (!input.catchUp) return [];

    const found = findFiles(sessionsRoot(), (name) => name.startsWith("rollout-") && name.endsWith(".jsonl"), {
      maxDepth: 5,
      limit: input.limit ?? 20,
    });

    return found
      .filter((f) => !input.since || f.modifiedAt >= input.since)
      .map((f) => ({
        source: this.getName(),
        sessionId: rolloutSessionId(f.path),
        path: f.path,
        cwd: input.cwd,
        modifiedAt: f.modifiedAt,
      }));
  }

  async normalizeSession(
    ref: SessionRef,
    options: NormalizeOptions = {},
  ): Promise<NormalizedWorkSession | undefined> {
    if (!ref.path) return undefined;
    const parsed = readJsonlTranscript(ref.path, options.fromCursor ?? 0);
    if (!parsed.messages.length) return undefined;

    const cwd = ref.cwd ?? parsed.cwd ?? process.cwd();
    const workspace = identifyWorkspace(cwd, options.workspaceId, options.workspaceLabel);

    return {
      source: this.getName(),
      sessionId: parsed.sessionId ?? ref.sessionId,
      workspaceId: workspace.id,
      workspaceLabel: workspace.label,
      startedAt: parsed.firstAt,
      endedAt: parsed.lastAt,
      messages: parsed.messages,
      toolCalls: parsed.toolCalls,
      changedResources: parsed.changedResources,
      cursor: parsed.cursor,
      metadata: {
        transcriptPath: ref.path,
        workspaceBasis: workspace.basis,
        unrecognizedLines: parsed.unrecognized,
      },
    };
  }
}

export function sessionsRoot(): string {
  const home = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  return join(home, "sessions");
}

/** rollout-2026-09-18T13-03-44-<uuid>.jsonl → the uuid. */
function rolloutSessionId(path: string): string {
  const name = basename(path, ".jsonl");
  const uuid = name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return uuid?.[1] ?? name;
}
