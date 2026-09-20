/**
 * Normalized work session.
 *
 * This is the ONLY representation the core knows about. Agent adapters
 * (Claude Code, Cursor, Codex, ...) translate their environment-specific
 * transcripts into this shape; nothing downstream of here may branch on
 * `source` to change analysis behaviour.
 *
 * Almost every field is optional on purpose: an integration that can only
 * expose a flat list of messages must still be able to produce a valid
 * session.
 */

export type MessageRole = "user" | "assistant" | "system";

export interface WorkMessage {
  role: MessageRole;
  /** Plain text. Adapters are responsible for flattening rich content blocks. */
  text: string;
  at?: string;
  /**
   * Internal reasoning captured by the environment (e.g. thinking blocks).
   * Never persisted by the core; only forwarded to the analyzer when
   * `privacy.sendReasoningToAnalyzer` is enabled.
   */
  reasoning?: string;
}

export interface WorkToolCall {
  name: string;
  /** Short, already-redacted summary of the invocation. Not the raw payload. */
  summary?: string;
  at?: string;
  ok?: boolean;
}

/** Something produced during the session (a file, a document, a report, ...). */
export interface WorkArtifact {
  kind: string;
  ref: string;
  summary?: string;
}

/** Something the session changed. Deliberately not "file": a resource may be a doc, a dataset, a campaign. */
export interface ChangedResource {
  kind: string;
  ref: string;
  changeType?: "created" | "modified" | "deleted" | "renamed" | "other";
}

export interface NormalizedWorkSession {
  /** Adapter name, e.g. "claude-code". Metadata only — never a behaviour switch. */
  source: string;
  sessionId: string;
  workspaceId: string;
  /** Human-facing label for the workspace (repo name, project name, ...). */
  workspaceLabel?: string;
  startedAt?: string;
  endedAt?: string;
  messages: WorkMessage[];
  toolCalls?: WorkToolCall[];
  artifacts?: WorkArtifact[];
  changedResources?: ChangedResource[];
  /**
   * Byte or line offset in the underlying transcript that this session object
   * was read up to. Used to make ingestion incremental and idempotent.
   */
  cursor?: number;
  metadata?: Record<string, unknown>;
}

export function emptySession(
  source: string,
  sessionId: string,
  workspaceId: string,
): NormalizedWorkSession {
  return { source, sessionId, workspaceId, messages: [] };
}

/**
 * Structural validation. Returns a list of problems; empty means usable.
 * Kept deliberately permissive — adapters vary wildly in what they can supply.
 */
export function validateSession(session: NormalizedWorkSession): string[] {
  const problems: string[] = [];
  if (!session.source) problems.push("source is required");
  if (!session.sessionId) problems.push("sessionId is required");
  if (!session.workspaceId) problems.push("workspaceId is required");
  if (!Array.isArray(session.messages)) problems.push("messages must be an array");
  else {
    for (const [i, m] of session.messages.entries()) {
      if (m.role !== "user" && m.role !== "assistant" && m.role !== "system") {
        problems.push(`messages[${i}].role is invalid: ${String(m.role)}`);
      }
      if (typeof m.text !== "string") problems.push(`messages[${i}].text must be a string`);
    }
  }
  return problems;
}

export function countUserTurns(session: NormalizedWorkSession): number {
  return session.messages.filter((m) => m.role === "user").length;
}

export function sessionTextLength(session: NormalizedWorkSession): number {
  return session.messages.reduce((n, m) => n + m.text.length, 0);
}
