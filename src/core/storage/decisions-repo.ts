import type { Db } from "./db.ts";
import { transact } from "./db.ts";
import type {
  Decision,
  DecisionAlternative,
  DecisionRelation,
  DecisionStatus,
  RelationType,
} from "../model/decision.ts";
import { decisionId } from "../ids.ts";

interface Row {
  id: string;
  created_at: string;
  updated_at: string;
  workspace_id: string;
  source: string;
  source_session_id: string;
  domain: string;
  category: string;
  subject: string;
  decision: string;
  context: string | null;
  reasoning: string | null;
  confidence: number;
  status: string;
  reviewed_at: string | null;
}

function toDecision(row: Row): Decision {
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    workspaceId: row.workspace_id,
    source: row.source,
    sourceSessionId: row.source_session_id,
    domain: row.domain,
    category: row.category,
    subject: row.subject,
    decision: row.decision,
    context: row.context ?? undefined,
    reasoning: row.reasoning ?? undefined,
    confidence: row.confidence,
    status: row.status as DecisionStatus,
    reviewedAt: row.reviewed_at ?? undefined,
  };
}

export interface NewDecision {
  workspaceId: string;
  source: string;
  sourceSessionId: string;
  domain: string;
  category: string;
  subject: string;
  decision: string;
  context?: string;
  reasoning?: string;
  confidence?: number;
  status?: DecisionStatus;
  alternatives?: DecisionAlternative[];
  createdAt?: string;
}

export interface ListFilter {
  workspaceId?: string;
  domain?: string;
  source?: string;
  category?: string;
  status?: DecisionStatus | "any";
  /** Only decisions that have never been part of a distillation run. */
  unreviewedOnly?: boolean;
  since?: string;
  limit?: number;
  offset?: number;
}

export function insertDecision(db: Db, input: NewDecision): Decision {
  const now = new Date().toISOString();
  const createdAt = input.createdAt ?? now;
  const id = decisionId();

  transact(db, () => {
    db.prepare(
      `INSERT INTO decisions
        (id, created_at, updated_at, workspace_id, source, source_session_id,
         domain, category, subject, decision, context, reasoning, confidence, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      createdAt,
      now,
      input.workspaceId,
      input.source,
      input.sourceSessionId,
      input.domain,
      input.category,
      input.subject,
      input.decision,
      input.context ?? null,
      input.reasoning ?? null,
      input.confidence ?? 0.7,
      input.status ?? "active",
    );

    for (const alt of input.alternatives ?? []) {
      db.prepare(
        "INSERT INTO decision_alternatives(decision_id, alternative, reason_rejected) VALUES (?,?,?)",
      ).run(id, alt.alternative, alt.reasonRejected ?? null);
    }
  });

  return getDecision(db, id)!;
}

export function getDecision(db: Db, id: string): Decision | undefined {
  const row = db.prepare("SELECT * FROM decisions WHERE id = ?").get(id) as unknown as Row | undefined;
  if (!row) return undefined;
  const d = toDecision(row);
  d.alternatives = getAlternatives(db, id);
  return d;
}

/** Unambiguous prefix lookup so users can type `d_a1b2` instead of the full id. */
export function resolveDecision(db: Db, idOrPrefix: string): Decision | undefined {
  const exact = getDecision(db, idOrPrefix);
  if (exact) return exact;
  const rows = db
    .prepare("SELECT * FROM decisions WHERE id LIKE ? LIMIT 2")
    .all(`${idOrPrefix}%`) as unknown as Row[];
  if (rows.length !== 1) return undefined;
  return getDecision(db, rows[0]!.id);
}

export function getAlternatives(db: Db, decisionId: string): DecisionAlternative[] {
  const rows = db
    .prepare(
      "SELECT id, alternative, reason_rejected FROM decision_alternatives WHERE decision_id = ? ORDER BY id",
    )
    .all(decisionId) as { id: number; alternative: string; reason_rejected: string | null }[];
  return rows.map((r) => ({
    id: r.id,
    alternative: r.alternative,
    reasonRejected: r.reason_rejected ?? undefined,
  }));
}

export function listDecisions(db: Db, filter: ListFilter = {}): Decision[] {
  const where: string[] = [];
  const params: unknown[] = [];

  if (filter.workspaceId) {
    where.push("workspace_id = ?");
    params.push(filter.workspaceId);
  }
  if (filter.domain) {
    where.push("domain = ?");
    params.push(filter.domain);
  }
  if (filter.source) {
    where.push("source = ?");
    params.push(filter.source);
  }
  if (filter.category) {
    where.push("category = ?");
    params.push(filter.category);
  }
  if (filter.status && filter.status !== "any") {
    where.push("status = ?");
    params.push(filter.status);
  }
  if (filter.unreviewedOnly) where.push("reviewed_at IS NULL");
  if (filter.since) {
    where.push("created_at >= ?");
    params.push(filter.since);
  }

  const sql =
    "SELECT * FROM decisions" +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    " ORDER BY created_at DESC" +
    (filter.limit ? ` LIMIT ${Number(filter.limit)}` : "") +
    (filter.offset ? ` OFFSET ${Number(filter.offset)}` : "");

  return (db.prepare(sql).all(...(params as never[])) as unknown as Row[]).map(toDecision);
}

export function countDecisions(db: Db, filter: ListFilter = {}): number {
  return listDecisions(db, { ...filter, limit: undefined, offset: undefined }).length;
}

export function countUnreviewed(db: Db, workspaceId?: string): number {
  const sql = workspaceId
    ? "SELECT COUNT(*) AS n FROM decisions WHERE reviewed_at IS NULL AND workspace_id = ?"
    : "SELECT COUNT(*) AS n FROM decisions WHERE reviewed_at IS NULL";
  const row = (
    workspaceId ? db.prepare(sql).get(workspaceId) : db.prepare(sql).get()
  ) as { n: number };
  return row.n;
}

/**
 * FTS5 search. Falls back to LIKE when the query contains characters that the
 * FTS tokenizer would reject — a search must never crash the CLI.
 */
export function searchDecisions(db: Db, query: string, filter: ListFilter = {}): Decision[] {
  const limit = filter.limit ?? 50;
  const sanitized = query
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, "")}"`)
    .join(" OR ");

  let rows: Row[] = [];
  if (sanitized) {
    try {
      rows = db
        .prepare(
          `SELECT d.* FROM decisions_fts f
           JOIN decisions d ON d.rowid = f.rowid
           WHERE decisions_fts MATCH ?
           ORDER BY rank LIMIT ?`,
        )
        .all(sanitized, limit) as unknown as Row[];
    } catch {
      rows = [];
    }
  }

  if (rows.length === 0) {
    const like = `%${query}%`;
    rows = db
      .prepare(
        `SELECT * FROM decisions
         WHERE subject LIKE ? OR decision LIKE ? OR context LIKE ? OR reasoning LIKE ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(like, like, like, like, limit) as unknown as Row[];
  }

  const workspaceId = filter.workspaceId;
  return rows.map(toDecision).filter((d) => !workspaceId || d.workspaceId === workspaceId);
}

export function updateDecisionStatus(db: Db, id: string, status: DecisionStatus): void {
  db.prepare("UPDATE decisions SET status = ?, updated_at = ? WHERE id = ?").run(
    status,
    new Date().toISOString(),
    id,
  );
}

export function touchDecision(db: Db, id: string, patch: Partial<Decision>): void {
  const fields: string[] = [];
  const params: unknown[] = [];
  if (patch.context !== undefined) {
    fields.push("context = ?");
    params.push(patch.context);
  }
  if (patch.reasoning !== undefined) {
    fields.push("reasoning = ?");
    params.push(patch.reasoning);
  }
  if (patch.confidence !== undefined) {
    fields.push("confidence = ?");
    params.push(patch.confidence);
  }
  if (patch.decision !== undefined) {
    fields.push("decision = ?");
    params.push(patch.decision);
  }
  if (!fields.length) return;
  fields.push("updated_at = ?");
  params.push(new Date().toISOString(), id);
  db.prepare(`UPDATE decisions SET ${fields.join(", ")} WHERE id = ?`).run(
    ...(params as never[]),
  );
}

export function markReviewed(db: Db, ids: string[], at = new Date().toISOString()): number {
  if (!ids.length) return 0;
  const stmt = db.prepare("UPDATE decisions SET reviewed_at = ? WHERE id = ? AND reviewed_at IS NULL");
  let n = 0;
  transact(db, () => {
    for (const id of ids) n += stmt.run(at, id).changes as number;
  });
  return n;
}

export function addRelation(db: Db, relation: DecisionRelation): void {
  db.prepare(
    `INSERT OR IGNORE INTO decision_relations
       (from_decision_id, to_decision_id, relation_type, created_at, note)
     VALUES (?,?,?,?,?)`,
  ).run(
    relation.fromDecisionId,
    relation.toDecisionId,
    relation.relationType,
    relation.createdAt ?? new Date().toISOString(),
    relation.note ?? null,
  );
}

export function getRelations(db: Db, decisionId: string): DecisionRelation[] {
  const rows = db
    .prepare(
      `SELECT from_decision_id, to_decision_id, relation_type, created_at, note
       FROM decision_relations
       WHERE from_decision_id = ? OR to_decision_id = ?`,
    )
    .all(decisionId, decisionId) as {
    from_decision_id: string;
    to_decision_id: string;
    relation_type: string;
    created_at: string;
    note: string | null;
  }[];
  return rows.map((r) => ({
    fromDecisionId: r.from_decision_id,
    toDecisionId: r.to_decision_id,
    relationType: r.relation_type as RelationType,
    createdAt: r.created_at,
    note: r.note ?? undefined,
  }));
}

/**
 * Records that `newId` supersedes `oldId`. The old decision keeps its row and
 * all of its evidence links; only its status changes. History is never deleted.
 */
export function supersede(db: Db, newDecisionId: string, oldDecisionId: string, note?: string): void {
  transact(db, () => {
    addRelation(db, {
      fromDecisionId: newDecisionId,
      toDecisionId: oldDecisionId,
      relationType: "supersedes",
      note,
    });
    updateDecisionStatus(db, oldDecisionId, "superseded");
  });
}

export function distinctCategories(db: Db, domain?: string): string[] {
  const rows = (
    domain
      ? db.prepare("SELECT DISTINCT category FROM decisions WHERE domain = ? ORDER BY category").all(domain)
      : db.prepare("SELECT DISTINCT category FROM decisions ORDER BY category").all()
  ) as { category: string }[];
  return rows.map((r) => r.category);
}
