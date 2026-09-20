/**
 * Schema migrations.
 *
 * Append-only: never edit a shipped migration, add a new one. The list index
 * is the version, tracked in `schema_migrations`.
 *
 * Design note: nothing in this schema names a profession. `domain` and
 * `category` are plain TEXT precisely so that adding product-management or
 * design decisions requires no migration at all.
 */

export interface Migration {
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    name: "0001_initial",
    sql: `
CREATE TABLE workspaces (
  id            TEXT PRIMARY KEY,
  label         TEXT,
  root_path     TEXT,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL
);

CREATE TABLE decisions (
  id                TEXT PRIMARY KEY,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  workspace_id      TEXT NOT NULL,
  source            TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  domain            TEXT NOT NULL,
  category          TEXT NOT NULL,
  subject           TEXT NOT NULL,
  decision          TEXT NOT NULL,
  context           TEXT,
  reasoning         TEXT,
  confidence        REAL NOT NULL DEFAULT 0.7,
  status            TEXT NOT NULL DEFAULT 'active',
  reviewed_at       TEXT
);

CREATE INDEX idx_decisions_workspace ON decisions(workspace_id);
CREATE INDEX idx_decisions_created ON decisions(created_at);
CREATE INDEX idx_decisions_reviewed ON decisions(reviewed_at);
CREATE INDEX idx_decisions_status ON decisions(status);
CREATE INDEX idx_decisions_session ON decisions(source, source_session_id);

CREATE TABLE decision_alternatives (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  decision_id     TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  alternative     TEXT NOT NULL,
  reason_rejected TEXT
);

CREATE INDEX idx_alternatives_decision ON decision_alternatives(decision_id);

CREATE TABLE decision_relations (
  from_decision_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  to_decision_id   TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  relation_type    TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  note             TEXT,
  PRIMARY KEY (from_decision_id, to_decision_id, relation_type)
);

CREATE INDEX idx_relations_to ON decision_relations(to_decision_id);

CREATE TABLE proposals (
  id               TEXT PRIMARY KEY,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  domain           TEXT NOT NULL,
  workspace_id     TEXT,
  kind             TEXT NOT NULL,
  title            TEXT NOT NULL,
  statement        TEXT NOT NULL,
  rationale        TEXT,
  proposed_target  TEXT,
  confidence       REAL NOT NULL DEFAULT 0.7,
  priority_score   REAL NOT NULL DEFAULT 0,
  score_breakdown  TEXT,
  status           TEXT NOT NULL DEFAULT 'candidate',
  first_seen_at    TEXT NOT NULL,
  last_seen_at     TEXT NOT NULL,
  accepted_at      TEXT,
  rejected_at      TEXT,
  rejection_reason TEXT,
  deferred_until   TEXT,
  revived          INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_proposals_status ON proposals(status);
CREATE INDEX idx_proposals_domain ON proposals(domain);

CREATE TABLE proposal_evidence (
  proposal_id TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  decision_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  added_at    TEXT NOT NULL,
  PRIMARY KEY (proposal_id, decision_id)
);

CREATE INDEX idx_evidence_decision ON proposal_evidence(decision_id);

CREATE TABLE distillation_runs (
  id             TEXT PRIMARY KEY,
  started_at     TEXT NOT NULL,
  finished_at    TEXT,
  workspace_id   TEXT,
  domain         TEXT NOT NULL,
  analyzer       TEXT NOT NULL,
  considered     INTEGER NOT NULL DEFAULT 0,
  proposed_new   INTEGER NOT NULL DEFAULT 0,
  attached       INTEGER NOT NULL DEFAULT 0,
  outcome        TEXT NOT NULL DEFAULT 'ok',
  note           TEXT
);

-- One row per (source, session) so re-running ingestion is idempotent and
-- long-lived sessions can be ingested incrementally from a stored offset.
CREATE TABLE ingestion_log (
  source            TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  workspace_id      TEXT NOT NULL,
  cursor            INTEGER NOT NULL DEFAULT 0,
  last_ingested_at  TEXT NOT NULL,
  decisions_found   INTEGER NOT NULL DEFAULT 0,
  runs              INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source, source_session_id)
);

-- Small key/value store for reminder + distillation bookkeeping.
CREATE TABLE app_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Note: schema_migrations itself is created by the migration runner in db.ts,
-- before any migration runs. It is the runner's bookkeeping, not schema.
`,
  },
  {
    name: "0002_fts",
    sql: `
CREATE VIRTUAL TABLE decisions_fts USING fts5(
  subject, decision, context, reasoning,
  content='decisions', content_rowid='rowid'
);

CREATE TRIGGER decisions_fts_ai AFTER INSERT ON decisions BEGIN
  INSERT INTO decisions_fts(rowid, subject, decision, context, reasoning)
  VALUES (new.rowid, new.subject, new.decision, new.context, new.reasoning);
END;

CREATE TRIGGER decisions_fts_ad AFTER DELETE ON decisions BEGIN
  INSERT INTO decisions_fts(decisions_fts, rowid, subject, decision, context, reasoning)
  VALUES ('delete', old.rowid, old.subject, old.decision, old.context, old.reasoning);
END;

CREATE TRIGGER decisions_fts_au AFTER UPDATE ON decisions BEGIN
  INSERT INTO decisions_fts(decisions_fts, rowid, subject, decision, context, reasoning)
  VALUES ('delete', old.rowid, old.subject, old.decision, old.context, old.reasoning);
  INSERT INTO decisions_fts(rowid, subject, decision, context, reasoning)
  VALUES (new.rowid, new.subject, new.decision, new.context, new.reasoning);
END;

CREATE VIRTUAL TABLE proposals_fts USING fts5(
  title, statement,
  content='proposals', content_rowid='rowid'
);

CREATE TRIGGER proposals_fts_ai AFTER INSERT ON proposals BEGIN
  INSERT INTO proposals_fts(rowid, title, statement)
  VALUES (new.rowid, new.title, new.statement);
END;

CREATE TRIGGER proposals_fts_ad AFTER DELETE ON proposals BEGIN
  INSERT INTO proposals_fts(proposals_fts, rowid, title, statement)
  VALUES ('delete', old.rowid, old.title, old.statement);
END;

CREATE TRIGGER proposals_fts_au AFTER UPDATE ON proposals BEGIN
  INSERT INTO proposals_fts(proposals_fts, rowid, title, statement)
  VALUES ('delete', old.rowid, old.title, old.statement);
  INSERT INTO proposals_fts(rowid, title, statement)
  VALUES (new.rowid, new.title, new.statement);
END;
`,
  },
];
