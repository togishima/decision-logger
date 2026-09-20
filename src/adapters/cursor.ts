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
 * Cursor adapter.
 *
 * Cursor documents its hooks fully — every event carries `conversation_id`,
 * `workspace_roots` and `transcript_path` — but documents nothing about where
 * transcripts live or what is inside them. So this adapter only ever reads a
 * path it was handed at runtime, via the hook payload or `CURSOR_TRANSCRIPT_PATH`.
 * Guessing a location would be building on an undocumented layout that Cursor
 * has never promised to keep.
 *
 * Because Cursor also imports Claude Code hooks from `.claude/settings.json`,
 * the same hook command serves both environments; there is no Cursor-specific
 * ingestion logic anywhere in the core.
 */
export class CursorAdapter implements WorkAdapter {
  getName(): string {
    return "cursor";
  }

  canHandle(input: CollectInput): boolean {
    if (input.transcriptPath) return input.transcriptPath.toLowerCase().includes("cursor");
    return Boolean(process.env.CURSOR_TRANSCRIPT_PATH ?? process.env.CURSOR_PROJECT_DIR);
  }

  describe(): AdapterDescription {
    return {
      name: "cursor",
      label: "Cursor",
      automaticIngestion: "supported",
      transcriptStability: "undocumented",
      notes: [
        "Hooks are documented and every event except workspaceOpen carries conversation_id, workspace_roots and transcript_path.",
        "Cursor reads Claude Code hooks from .claude/settings.json, so one hook command covers both environments.",
        "transcript_path is null when transcripts are disabled; the transcript file format is not documented, so the parser is shape-based and may find nothing.",
        "sessionEnd does not fire for cloud agents; the per-turn stop event is the reliable trigger.",
      ],
    };
  }

  async collectSession(input: CollectInput): Promise<SessionRef[]> {
    const path = input.transcriptPath ?? process.env.CURSOR_TRANSCRIPT_PATH;
    if (path && existsSync(path)) {
      return [
        {
          source: this.getName(),
          sessionId: input.sessionId ?? basename(path).replace(/\.[^.]+$/, ""),
          path,
          cwd: input.cwd ?? process.env.CURSOR_PROJECT_DIR,
        },
      ];
    }

    if (!input.catchUp) return [];

    // Best-effort only, and deliberately narrow: this directory is a community
    // report, not a documented location, so a miss here is expected.
    const root = join(homedir(), ".cursor", "projects");
    return findFiles(root, (name) => name.endsWith(".jsonl"), { limit: input.limit ?? 20 })
      .filter((f) => !input.since || f.modifiedAt >= input.since)
      .map((f) => ({
        source: this.getName(),
        sessionId: basename(f.path).replace(/\.[^.]+$/, ""),
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

    const cwd = ref.cwd ?? parsed.cwd ?? process.env.CURSOR_PROJECT_DIR ?? process.cwd();
    const workspace = identifyWorkspace(cwd, options.workspaceId, options.workspaceLabel);

    return {
      source: this.getName(),
      sessionId: ref.sessionId,
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
