import type { Db } from "./db.ts";

export interface Workspace {
  id: string;
  label?: string;
  rootPath?: string;
  createdAt: string;
  lastSeenAt: string;
}

export function upsertWorkspace(
  db: Db,
  id: string,
  label?: string,
  rootPath?: string,
): Workspace {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO workspaces(id, label, root_path, created_at, last_seen_at)
     VALUES (?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       label = COALESCE(excluded.label, workspaces.label),
       root_path = COALESCE(excluded.root_path, workspaces.root_path),
       last_seen_at = excluded.last_seen_at`,
  ).run(id, label ?? null, rootPath ?? null, now, now);
  return getWorkspace(db, id)!;
}

export function getWorkspace(db: Db, id: string): Workspace | undefined {
  const row = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as
    | { id: string; label: string | null; root_path: string | null; created_at: string; last_seen_at: string }
    | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    label: row.label ?? undefined,
    rootPath: row.root_path ?? undefined,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

export function listWorkspaces(db: Db): Workspace[] {
  const rows = db.prepare("SELECT * FROM workspaces ORDER BY last_seen_at DESC").all() as {
    id: string;
    label: string | null;
    root_path: string | null;
    created_at: string;
    last_seen_at: string;
  }[];
  return rows.map((row) => ({
    id: row.id,
    label: row.label ?? undefined,
    rootPath: row.root_path ?? undefined,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  }));
}

/* ------------------------------------------------------------------ */
/* Ingestion log                                                       */
/* ------------------------------------------------------------------ */

export interface IngestionRecord {
  source: string;
  sourceSessionId: string;
  workspaceId: string;
  /** How far into the underlying transcript we have already read. */
  cursor: number;
  lastIngestedAt: string;
  decisionsFound: number;
  runs: number;
}

export function getIngestionRecord(
  db: Db,
  source: string,
  sessionId: string,
): IngestionRecord | undefined {
  const row = db
    .prepare("SELECT * FROM ingestion_log WHERE source = ? AND source_session_id = ?")
    .get(source, sessionId) as
    | {
        source: string;
        source_session_id: string;
        workspace_id: string;
        cursor: number;
        last_ingested_at: string;
        decisions_found: number;
        runs: number;
      }
    | undefined;
  if (!row) return undefined;
  return {
    source: row.source,
    sourceSessionId: row.source_session_id,
    workspaceId: row.workspace_id,
    cursor: row.cursor,
    lastIngestedAt: row.last_ingested_at,
    decisionsFound: row.decisions_found,
    runs: row.runs,
  };
}

export function recordIngestion(
  db: Db,
  source: string,
  sessionId: string,
  workspaceId: string,
  cursor: number,
  decisionsFound: number,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO ingestion_log
       (source, source_session_id, workspace_id, cursor, last_ingested_at, decisions_found, runs)
     VALUES (?,?,?,?,?,?,1)
     ON CONFLICT(source, source_session_id) DO UPDATE SET
       cursor = excluded.cursor,
       last_ingested_at = excluded.last_ingested_at,
       decisions_found = ingestion_log.decisions_found + excluded.decisions_found,
       runs = ingestion_log.runs + 1`,
  ).run(source, sessionId, workspaceId, cursor, now, decisionsFound);
}

export function listIngestions(db: Db, limit = 20): IngestionRecord[] {
  const rows = db
    .prepare("SELECT * FROM ingestion_log ORDER BY last_ingested_at DESC LIMIT ?")
    .all(limit) as {
    source: string;
    source_session_id: string;
    workspace_id: string;
    cursor: number;
    last_ingested_at: string;
    decisions_found: number;
    runs: number;
  }[];
  return rows.map((row) => ({
    source: row.source,
    sourceSessionId: row.source_session_id,
    workspaceId: row.workspace_id,
    cursor: row.cursor,
    lastIngestedAt: row.last_ingested_at,
    decisionsFound: row.decisions_found,
    runs: row.runs,
  }));
}
