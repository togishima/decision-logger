import { readFileSync, existsSync } from "node:fs";
import { basename } from "node:path";
import type {
  WorkAdapter,
  CollectInput,
  SessionRef,
  NormalizeOptions,
  AdapterDescription,
} from "./adapter.ts";
import type { NormalizedWorkSession } from "../core/model/session.ts";
import { validateSession } from "../core/model/session.ts";
import { parseJsonlTranscript } from "./jsonl-transcript.ts";
import { identifyWorkspace } from "../core/workspace.ts";

/**
 * Fallback adapter: a file or stdin containing either a NormalizedWorkSession
 * document or a JSONL transcript.
 *
 * This is what keeps the CLI useful when an environment offers no hooks at
 * all. Any tool that can write a session JSON can feed decision-logger, which
 * is also how a future integration gets tried out before it is worth writing
 * an adapter for.
 */
export class GenericAdapter implements WorkAdapter {
  getName(): string {
    return "generic";
  }

  canHandle(input: CollectInput): boolean {
    return Boolean(input.transcriptPath);
  }

  describe(): AdapterDescription {
    return {
      name: "generic",
      label: "Generic file / stdin",
      automaticIngestion: "manual-only",
      transcriptStability: "documented",
      notes: [
        "Accepts a NormalizedWorkSession JSON document or a JSONL transcript.",
        "The session model is this project's own and is documented in docs/ARCHITECTURE.md.",
        "Use this for any environment without hooks: `decision-logger ingest --file session.json`.",
      ],
    };
  }

  async collectSession(input: CollectInput): Promise<SessionRef[]> {
    if (!input.transcriptPath || !existsSync(input.transcriptPath)) return [];
    return [
      {
        source: this.getName(),
        sessionId: input.sessionId ?? basename(input.transcriptPath).replace(/\.[^.]+$/, ""),
        path: input.transcriptPath,
        cwd: input.cwd,
      },
    ];
  }

  async normalizeSession(
    ref: SessionRef,
    options: NormalizeOptions = {},
  ): Promise<NormalizedWorkSession | undefined> {
    if (!ref.path) return undefined;
    const raw = readFileSync(ref.path, "utf8");
    return parseSessionDocument(raw, ref, options);
  }
}

/**
 * Shared by the adapter and by `ingest --stdin`. Tries a session document
 * first, then falls back to treating the input as a JSONL transcript.
 */
export function parseSessionDocument(
  raw: string,
  ref: SessionRef,
  options: NormalizeOptions = {},
): NormalizedWorkSession | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  if (trimmed.startsWith("{") && !trimmed.includes("\n{")) {
    try {
      const parsed = JSON.parse(trimmed) as Partial<NormalizedWorkSession>;
      if (Array.isArray(parsed.messages)) {
        const cwd = ref.cwd ?? process.cwd();
        const workspace = identifyWorkspace(
          cwd,
          options.workspaceId ?? parsed.workspaceId,
          options.workspaceLabel ?? parsed.workspaceLabel,
        );
        const session: NormalizedWorkSession = {
          source: parsed.source ?? ref.source,
          sessionId: parsed.sessionId ?? ref.sessionId,
          workspaceId: workspace.id,
          workspaceLabel: workspace.label,
          startedAt: parsed.startedAt,
          endedAt: parsed.endedAt,
          messages: parsed.messages,
          toolCalls: parsed.toolCalls,
          artifacts: parsed.artifacts,
          changedResources: parsed.changedResources,
          cursor: parsed.cursor,
          metadata: parsed.metadata,
        };
        return validateSession(session).length === 0 ? session : undefined;
      }
    } catch {
      /* fall through to the JSONL path */
    }
  }

  const parsed = parseJsonlTranscript(trimmed, options.fromCursor ?? 0);
  if (!parsed.messages.length) return undefined;

  const cwd = ref.cwd ?? parsed.cwd ?? process.cwd();
  const workspace = identifyWorkspace(cwd, options.workspaceId, options.workspaceLabel);
  return {
    source: ref.source,
    sessionId: ref.sessionId,
    workspaceId: workspace.id,
    workspaceLabel: workspace.label,
    startedAt: parsed.firstAt,
    endedAt: parsed.lastAt,
    messages: parsed.messages,
    toolCalls: parsed.toolCalls,
    changedResources: parsed.changedResources,
    cursor: parsed.cursor,
  };
}
