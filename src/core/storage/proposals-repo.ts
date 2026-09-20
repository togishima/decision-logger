import type { Db } from "./db.ts";
import { transact } from "./db.ts";
import type {
  Proposal,
  ProposalKind,
  ProposalStatus,
  RejectionReason,
  ScoreBreakdown,
} from "../model/proposal.ts";
import { proposalId } from "../ids.ts";

interface Row {
  id: string;
  created_at: string;
  updated_at: string;
  domain: string;
  workspace_id: string | null;
  kind: string;
  title: string;
  statement: string;
  rationale: string | null;
  proposed_target: string | null;
  confidence: number;
  priority_score: number;
  score_breakdown: string | null;
  status: string;
  first_seen_at: string;
  last_seen_at: string;
  accepted_at: string | null;
  rejected_at: string | null;
  rejection_reason: string | null;
  deferred_until: string | null;
  revived: number;
}

function toProposal(row: Row): Proposal {
  let breakdown: ScoreBreakdown | undefined;
  if (row.score_breakdown) {
    try {
      breakdown = JSON.parse(row.score_breakdown) as ScoreBreakdown;
    } catch {
      breakdown = undefined;
    }
  }
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    domain: row.domain,
    workspaceId: row.workspace_id ?? undefined,
    kind: row.kind as ProposalKind,
    title: row.title,
    statement: row.statement,
    rationale: row.rationale ?? undefined,
    proposedTarget: row.proposed_target ?? undefined,
    confidence: row.confidence,
    priorityScore: row.priority_score,
    scoreBreakdown: breakdown,
    status: row.status as ProposalStatus,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    acceptedAt: row.accepted_at ?? undefined,
    rejectedAt: row.rejected_at ?? undefined,
    rejectionReason: (row.rejection_reason as RejectionReason) ?? undefined,
    deferredUntil: row.deferred_until ?? undefined,
    revived: row.revived === 1,
  };
}

export interface NewProposal {
  domain: string;
  workspaceId?: string;
  kind: ProposalKind;
  title: string;
  statement: string;
  rationale?: string;
  proposedTarget?: string;
  confidence?: number;
  priorityScore?: number;
  scoreBreakdown?: ScoreBreakdown;
  evidenceDecisionIds: string[];
  revived?: boolean;
}

export function insertProposal(db: Db, input: NewProposal): Proposal {
  const now = new Date().toISOString();
  const id = proposalId();

  transact(db, () => {
    db.prepare(
      `INSERT INTO proposals
        (id, created_at, updated_at, domain, workspace_id, kind, title, statement,
         rationale, proposed_target, confidence, priority_score, score_breakdown,
         status, first_seen_at, last_seen_at, revived)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'candidate',?,?,?)`,
    ).run(
      id,
      now,
      now,
      input.domain,
      input.workspaceId ?? null,
      input.kind,
      input.title,
      input.statement,
      input.rationale ?? null,
      input.proposedTarget ?? null,
      input.confidence ?? 0.7,
      input.priorityScore ?? 0,
      input.scoreBreakdown ? JSON.stringify(input.scoreBreakdown) : null,
      now,
      now,
      input.revived ? 1 : 0,
    );
    attachEvidenceRows(db, id, input.evidenceDecisionIds, now);
  });

  return getProposal(db, id)!;
}

function attachEvidenceRows(db: Db, proposalId: string, decisionIds: string[], at: string): number {
  const stmt = db.prepare(
    "INSERT OR IGNORE INTO proposal_evidence(proposal_id, decision_id, added_at) VALUES (?,?,?)",
  );
  let added = 0;
  for (const decisionId of new Set(decisionIds)) {
    added += stmt.run(proposalId, decisionId, at).changes as number;
  }
  return added;
}

/**
 * Adds supporting decisions to an existing proposal and bumps `last_seen_at`.
 * This is what keeps an accepted pattern from being re-proposed as new.
 */
export function attachEvidence(db: Db, proposalId: string, decisionIds: string[]): number {
  const now = new Date().toISOString();
  return transact(db, () => {
    const added = attachEvidenceRows(db, proposalId, decisionIds, now);
    db.prepare("UPDATE proposals SET last_seen_at = ?, updated_at = ? WHERE id = ?").run(
      now,
      now,
      proposalId,
    );
    return added;
  });
}

export function getProposal(db: Db, id: string): Proposal | undefined {
  const row = db.prepare("SELECT * FROM proposals WHERE id = ?").get(id) as unknown as Row | undefined;
  if (!row) return undefined;
  const p = toProposal(row);
  p.evidenceDecisionIds = getEvidenceIds(db, id);
  return p;
}

export function resolveProposal(db: Db, idOrPrefix: string): Proposal | undefined {
  const exact = getProposal(db, idOrPrefix);
  if (exact) return exact;
  const rows = db
    .prepare("SELECT id FROM proposals WHERE id LIKE ? LIMIT 2")
    .all(`${idOrPrefix}%`) as { id: string }[];
  if (rows.length !== 1) return undefined;
  return getProposal(db, rows[0]!.id);
}

export function getEvidenceIds(db: Db, proposalId: string): string[] {
  return (
    db
      .prepare("SELECT decision_id FROM proposal_evidence WHERE proposal_id = ? ORDER BY added_at")
      .all(proposalId) as { decision_id: string }[]
  ).map((r) => r.decision_id);
}

export interface ProposalFilter {
  status?: ProposalStatus | ProposalStatus[] | "any";
  domain?: string;
  workspaceId?: string;
  kind?: ProposalKind;
  limit?: number;
}

export function listProposals(db: Db, filter: ProposalFilter = {}): Proposal[] {
  const where: string[] = [];
  const params: unknown[] = [];

  if (filter.status && filter.status !== "any") {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
    where.push(`status IN (${statuses.map(() => "?").join(",")})`);
    params.push(...statuses);
  }
  if (filter.domain) {
    where.push("domain = ?");
    params.push(filter.domain);
  }
  if (filter.workspaceId) {
    where.push("(workspace_id = ? OR workspace_id IS NULL)");
    params.push(filter.workspaceId);
  }
  if (filter.kind) {
    where.push("kind = ?");
    params.push(filter.kind);
  }

  const sql =
    "SELECT * FROM proposals" +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    " ORDER BY priority_score DESC, last_seen_at DESC" +
    (filter.limit ? ` LIMIT ${Number(filter.limit)}` : "");

  return (db.prepare(sql).all(...(params as never[])) as unknown as Row[]).map((row) => {
    const p = toProposal(row);
    p.evidenceDecisionIds = getEvidenceIds(db, p.id);
    return p;
  });
}

/** Proposals a user could act on right now: candidates plus expired deferrals. */
export function listActionable(db: Db, filter: ProposalFilter = {}): Proposal[] {
  const now = new Date().toISOString();
  return listProposals(db, { ...filter, status: ["candidate", "deferred"] }).filter(
    (p) => p.status === "candidate" || !p.deferredUntil || p.deferredUntil <= now,
  );
}

export function searchProposals(db: Db, query: string, limit = 20): Proposal[] {
  const sanitized = query
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, "")}"`)
    .join(" OR ");
  if (!sanitized) return [];
  try {
    const rows = db
      .prepare(
        `SELECT p.* FROM proposals_fts f
         JOIN proposals p ON p.rowid = f.rowid
         WHERE proposals_fts MATCH ?
         ORDER BY rank LIMIT ?`,
      )
      .all(sanitized, limit) as unknown as Row[];
    return rows.map((row) => {
      const p = toProposal(row);
      p.evidenceDecisionIds = getEvidenceIds(db, p.id);
      return p;
    });
  } catch {
    return [];
  }
}

export function setStatus(
  db: Db,
  id: string,
  status: ProposalStatus,
  extra: { rejectionReason?: RejectionReason; deferredUntil?: string } = {},
): Proposal | undefined {
  const now = new Date().toISOString();
  const fields = ["status = ?", "updated_at = ?"];
  const params: unknown[] = [status, now];

  if (status === "accepted") {
    fields.push("accepted_at = ?", "rejected_at = NULL", "deferred_until = NULL");
    params.push(now);
  } else if (status === "rejected") {
    fields.push("rejected_at = ?", "rejection_reason = ?", "deferred_until = NULL");
    params.push(now, extra.rejectionReason ?? null);
  } else if (status === "deferred") {
    fields.push("deferred_until = ?");
    params.push(extra.deferredUntil ?? null);
  }

  params.push(id);
  db.prepare(`UPDATE proposals SET ${fields.join(", ")} WHERE id = ?`).run(...(params as never[]));
  return getProposal(db, id);
}

export function updateScore(
  db: Db,
  id: string,
  priorityScore: number,
  breakdown: ScoreBreakdown,
): void {
  db.prepare(
    "UPDATE proposals SET priority_score = ?, score_breakdown = ?, updated_at = ? WHERE id = ?",
  ).run(priorityScore, JSON.stringify(breakdown), new Date().toISOString(), id);
}

export function markRevived(db: Db, id: string): void {
  db.prepare("UPDATE proposals SET revived = 1, updated_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    id,
  );
}

/**
 * Counts evidence that arrived after a moment — used to decide whether a
 * rejected theme has earned another hearing.
 *
 * Both the decision and its attachment must be at or after `since`. The
 * comparison is inclusive because evidence is only ever attached by a
 * distillation run, never at the moment of rejection, so a row sharing a
 * millisecond with `rejected_at` is genuinely later; an exclusive comparison
 * would silently discard it.
 */
export function evidenceSince(db: Db, proposalId: string, since: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM proposal_evidence pe
       JOIN decisions d ON d.id = pe.decision_id
       WHERE pe.proposal_id = ? AND pe.added_at >= ? AND d.created_at >= ?`,
    )
    .get(proposalId, since, since) as { n: number };
  return row.n;
}
