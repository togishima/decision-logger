import type { NormalizedWorkSession } from "../core/model/session.ts";

/**
 * Agent / environment adapter.
 *
 * An adapter's entire job is: find the data this environment exposes, turn it
 * into a NormalizedWorkSession, and hand it to the core. Adapters contain no
 * decision analysis, no prompts, no storage, and no domain knowledge. If a
 * change to one adapter would need a matching change in another, it belongs in
 * the core instead.
 */

/** A session this adapter knows how to read, before it has been parsed. */
export interface SessionRef {
  source: string;
  sessionId: string;
  /** Transcript file, when the environment exposes one. */
  path?: string;
  cwd?: string;
  /** Last modification time, used to pick up where a catch-up scan left off. */
  modifiedAt?: string;
}

export interface CollectInput {
  /** Directory the work happened in. */
  cwd?: string;
  /** Session id supplied by a hook payload. */
  sessionId?: string;
  /** Transcript path supplied by a hook payload. Always preferred over guessing. */
  transcriptPath?: string;
  /** Scan for sessions not yet ingested rather than reading one. */
  catchUp?: boolean;
  /** Ignore sessions older than this. */
  since?: string;
  limit?: number;
}

export interface NormalizeOptions {
  /** Resume reading from this offset (line index) for incremental ingestion. */
  fromCursor?: number;
  workspaceId?: string;
  workspaceLabel?: string;
}

export interface WorkAdapter {
  getName(): string;
  /** Whether this adapter can serve the given input. */
  canHandle(input: CollectInput): boolean;
  /** Discovers sessions. One entry when a hook named a specific session. */
  collectSession(input: CollectInput): Promise<SessionRef[]>;
  /** Reads a discovered session and normalizes it. */
  normalizeSession(
    ref: SessionRef,
    options?: NormalizeOptions,
  ): Promise<NormalizedWorkSession | undefined>;
  /** Free-form notes shown by `doctor`, e.g. known format instability. */
  describe(): AdapterDescription;
}

export interface AdapterDescription {
  name: string;
  label: string;
  /** Whether automatic hook-driven ingestion is possible today. */
  automaticIngestion: "supported" | "supported-with-setup" | "manual-only";
  /** How stable the transcript format is, per the vendor's own documentation. */
  transcriptStability: "documented" | "internal" | "undocumented";
  notes: string[];
}
