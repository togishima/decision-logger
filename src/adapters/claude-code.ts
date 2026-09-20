import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
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
 * Claude Code adapter — the reference integration.
 *
 * Hooks hand us `transcript_path` and `session_id` directly, which is the only
 * path we fully trust. The on-disk layout below is used solely for `--catch-up`
 * scanning, because Claude Code's own documentation states that the transcript
 * entry format is internal and changes between releases. The parser is
 * therefore shape-based and tolerant, and a format change degrades to "no
 * decisions found" rather than to wrong decisions.
 */
export class ClaudeCodeAdapter implements WorkAdapter {
  getName(): string {
    return "claude-code";
  }

  canHandle(input: CollectInput): boolean {
    if (input.transcriptPath) return input.transcriptPath.includes(".claude/projects/");
    return existsSync(projectsRoot());
  }

  describe(): AdapterDescription {
    return {
      name: "claude-code",
      label: "Claude Code",
      automaticIngestion: "supported",
      transcriptStability: "internal",
      notes: [
        "Hooks provide session_id and transcript_path on every event.",
        "Transcripts are written asynchronously, so the final assistant message of a turn may be missing when a hook fires; incremental ingestion picks it up on the next run.",
        "Anthropic documents the JSONL entry format as internal and subject to change between releases.",
      ],
    };
  }

  async collectSession(input: CollectInput): Promise<SessionRef[]> {
    if (input.transcriptPath && existsSync(input.transcriptPath)) {
      return [
        {
          source: this.getName(),
          sessionId: input.sessionId ?? basename(input.transcriptPath, ".jsonl"),
          path: input.transcriptPath,
          cwd: input.cwd,
        },
      ];
    }

    if (input.sessionId && input.cwd) {
      const path = join(projectsRoot(), projectSlug(input.cwd), `${input.sessionId}.jsonl`);
      if (existsSync(path)) {
        return [{ source: this.getName(), sessionId: input.sessionId, path, cwd: input.cwd }];
      }
    }

    if (!input.catchUp) return [];

    const root = input.cwd ? join(projectsRoot(), projectSlug(input.cwd)) : projectsRoot();
    return findFiles(root, (name) => name.endsWith(".jsonl"), { limit: input.limit ?? 20 })
      .filter((f) => !input.since || f.modifiedAt >= input.since)
      .map((f) => ({
        source: this.getName(),
        sessionId: basename(f.path, ".jsonl"),
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

export function projectsRoot(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  return join(configDir, "projects");
}

/** Claude Code derives its project directory by replacing non-alphanumerics with `-`. */
export function projectSlug(cwd: string): string {
  return resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-");
}
