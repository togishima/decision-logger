import type { Db } from "../storage/db.ts";
import type { Config } from "../config.ts";
import type { Analyzer } from "../analysis/analyzer.ts";
import type { DomainProfile } from "../domains/profile.ts";
import type { Decision } from "../model/decision.ts";
import type { Proposal } from "../model/proposal.ts";
import { isProposalKind, proposalSearchText } from "../model/proposal.ts";

import { loadPrompt, fillTemplate } from "../analysis/prompts.ts";
import { distillationSchema, parseProposalsResponse } from "../ingestion/schema.ts";
import { listDecisions, markReviewed, getRelations } from "../storage/decisions-repo.ts";
import {
  listProposals,
  insertProposal,
  attachEvidence,
  updateScore,
  setStatus,
  markRevived,
  evidenceSince,
  getProposal,
} from "../storage/proposals-repo.ts";
import { scoreProposal } from "../ranking/score.ts";
import { jaccard, setOverlap } from "../dedupe/similarity.ts";
import { recordDistillation } from "../review/reminder.ts";
import { runId } from "../ids.ts";
import { transact } from "../storage/db.ts";

/**
 * Distillation: accumulated decisions in, reusable work patterns out.
 *
 * Always user-triggered. Reviewing is the one moment the user is asked to pay
 * attention, so this code owes them three things: every proposal traceable to
 * exact decisions, nothing re-proposed that they already settled, and an
 * honest "no pattern yet" when there isn't one.
 */

export type DistillOutcome = "ok" | "not-enough-decisions" | "no-pattern" | "error";

export interface DistillReport {
  outcome: DistillOutcome;
  runId: string;
  considered: number;
  /** Newly created candidate proposals. */
  created: Proposal[];
  /** Existing proposals that gained supporting evidence this run. */
  reinforced: Proposal[];
  /** Rejected themes brought back by strong new evidence. */
  revived: Proposal[];
  /** Accepted patterns that absorbed new evidence instead of being re-proposed. */
  absorbedByAccepted: Proposal[];
  dropped: string[];
  reviewedCount: number;
  error?: string;
  analyzerName?: string;
  meta?: Record<string, unknown>;
}

export interface DistillOptions {
  db: Db;
  config: Config;
  profile: DomainProfile;
  analyzer: Analyzer;
  /** Restrict to one workspace. Omit to distil across everything. */
  workspaceId?: string;
  /** Analyze and report without writing anything, including review state. */
  dryRun?: boolean;
  maxProposals?: number;
  now?: Date;
}

/** Above this statement similarity two proposals are the same theme. */
const THEME_MATCH = 0.55;
/** Or: this much of their evidence is shared. */
const EVIDENCE_MATCH = 0.5;

export async function distill(options: DistillOptions): Promise<DistillReport> {
  const { db, config, profile, analyzer } = options;
  const now = options.now ?? new Date();
  const id = runId();
  const maxProposals = options.maxProposals ?? 6;

  const base: DistillReport = {
    outcome: "ok",
    runId: id,
    considered: 0,
    created: [],
    reinforced: [],
    revived: [],
    absorbedByAccepted: [],
    dropped: [],
    reviewedCount: 0,
  };

  // Distillation looks at the whole active record, not only the unreviewed
  // part: a pattern is usually visible precisely because old and new decisions
  // rhyme. Review state governs the reminder, never the input set.
  const considered = gatherDecisions(db, config, profile, options.workspaceId, now);
  base.considered = considered.length;

  if (considered.length < config.distillation.minDecisions) {
    return {
      ...base,
      outcome: "not-enough-decisions",
      error: `${considered.length} decisions available, ${config.distillation.minDecisions} needed`,
    };
  }

  const accepted = listProposals(db, { status: "accepted", domain: profile.domain });
  const rejected = listProposals(db, { status: "rejected", domain: profile.domain });
  const open = listProposals(db, { status: ["candidate", "deferred"], domain: profile.domain });

  const prompt = fillTemplate(loadPrompt("distill-patterns"), {
    domain: profile.domain,
    distillation_guidance: profile.distillationGuidance ?? "(none)",
    max_proposals: String(maxProposals),
    accepted: renderKnownProposals(accepted),
    rejected: renderKnownProposals(rejected),
    decisions: renderDecisions(considered),
  });

  const response = await analyzer.analyze({
    prompt,
    schema: distillationSchema(),
    purpose: "distill-patterns",
    payload: { decisions: considered, profile, accepted, rejected },
    timeoutMs: config.analyzerTimeoutMs,
  });

  if (!response.ok) {
    return { ...base, outcome: "error", error: response.error, analyzerName: analyzer.name };
  }

  const parsed = parseProposalsResponse(response.data);
  base.dropped = [...parsed.rejected];
  base.analyzerName = analyzer.name;
  base.meta = response.meta;

  const byId = new Map(considered.map((d) => [d.id, d]));

  for (const raw of parsed.items.slice(0, maxProposals)) {
    if (!isProposalKind(raw.kind)) {
      base.dropped.push(`"${raw.title}": unknown kind "${raw.kind}"`);
      continue;
    }

    // Provenance is not optional. An evidence id we cannot resolve means the
    // model invented support, so the proposal goes no further.
    const evidenceIds = (raw.evidence_decision_ids ?? []).filter((eid) => byId.has(eid));
    if (evidenceIds.length === 0) {
      base.dropped.push(`"${raw.title}": no resolvable supporting decisions`);
      continue;
    }

    const evidence = evidenceIds.map((eid) => byId.get(eid)!);
    const candidate = { title: raw.title, statement: raw.statement };

    const match = findExistingTheme(candidate, evidenceIds, [...accepted, ...rejected, ...open]);

    if (match?.status === "accepted") {
      if (!options.dryRun) attachEvidence(db, match.id, evidenceIds);
      base.absorbedByAccepted.push(getProposal(db, match.id) ?? match);
      continue;
    }

    const breakdown = scoreProposal(candidate, {
      evidence,
      confidence: raw.confidence ?? 0.7,
      similarRejections: rejected,
      similarAccepted: accepted,
      contradictions: countContradictions(db, evidenceIds),
      now,
    });

    if (options.dryRun) {
      base.created.push(previewProposal(raw, profile.domain, evidenceIds, breakdown, now));
      continue;
    }

    if (match?.status === "rejected") {
      const outcome = tryRevive(db, match, evidenceIds, config, breakdown);
      if (outcome === "revived") base.revived.push(getProposal(db, match.id)!);
      else base.dropped.push(`"${raw.title}": matches a rejected proposal (${match.id}); not enough new evidence to revive`);
      continue;
    }

    if (match) {
      attachEvidence(db, match.id, evidenceIds);
      const refreshed = getProposal(db, match.id)!;
      const rescored = scoreProposal(refreshed, {
        evidence: (refreshed.evidenceDecisionIds ?? []).map((eid) => byId.get(eid)).filter(Boolean) as Decision[],
        confidence: refreshed.confidence,
        similarRejections: rejected,
        similarAccepted: accepted,
        now,
      });
      updateScore(db, match.id, rescored.total, rescored);
      base.reinforced.push(getProposal(db, match.id)!);
      continue;
    }

    base.created.push(
      insertProposal(db, {
        domain: profile.domain,
        workspaceId: options.workspaceId,
        kind: raw.kind,
        title: raw.title,
        statement: raw.statement,
        rationale: raw.rationale,
        proposedTarget: raw.proposed_target,
        confidence: raw.confidence ?? 0.7,
        priorityScore: breakdown.total,
        scoreBreakdown: breakdown,
        evidenceDecisionIds: evidenceIds,
      }),
    );
  }

  if (!options.dryRun) {
    // Everything examined counts as reviewed, including on a no-pattern run.
    // Otherwise the reminder would fire forever over the same decisions.
    base.reviewedCount = markReviewed(db, considered.map((d) => d.id), now.toISOString());
    recordDistillation(db, now);
    writeRunRecord(db, id, options, profile, analyzer.name, base, now);
  }

  const producedNothing =
    base.created.length === 0 && base.reinforced.length === 0 && base.revived.length === 0;
  if (producedNothing) base.outcome = "no-pattern";

  return base;
}

function gatherDecisions(
  db: Db,
  config: Config,
  profile: DomainProfile,
  workspaceId: string | undefined,
  now: Date,
): Decision[] {
  const since =
    config.distillation.lookbackDays > 0
      ? new Date(now.getTime() - config.distillation.lookbackDays * 86_400_000).toISOString()
      : undefined;

  return listDecisions(db, {
    workspaceId,
    domain: profile.domain,
    status: "active",
    since,
    limit: config.distillation.maxDecisions,
  });
}

/**
 * Finds the proposal that already represents this theme, by statement
 * similarity or by overlapping evidence. Evidence overlap catches the case
 * where the model reworded a pattern it has proposed before.
 */
function findExistingTheme(
  candidate: { title: string; statement: string },
  evidenceIds: string[],
  pool: Proposal[],
): Proposal | undefined {
  const text = proposalSearchText(candidate);
  let best: { proposal: Proposal; score: number } | undefined;

  for (const existing of pool) {
    const textScore = jaccard(text, proposalSearchText(existing));
    const evidenceScore = setOverlap(evidenceIds, existing.evidenceDecisionIds ?? []);
    const score = Math.max(textScore, evidenceScore >= EVIDENCE_MATCH ? evidenceScore : 0);
    if (score >= THEME_MATCH && (!best || score > best.score)) {
      best = { proposal: existing, score };
    }
  }
  return best?.proposal;
}

/**
 * A rejected proposal comes back only when decisions made *after* the
 * rejection support it. Anything less and the user would be re-asked the same
 * question they already answered.
 */
function tryRevive(
  db: Db,
  rejected: Proposal,
  evidenceIds: string[],
  config: Config,
  breakdown: ReturnType<typeof scoreProposal>,
): "revived" | "suppressed" {
  attachEvidence(db, rejected.id, evidenceIds);

  const since = rejected.rejectedAt ?? rejected.updatedAt;
  const fresh = evidenceSince(db, rejected.id, since);
  if (fresh < config.distillation.revivalEvidenceThreshold) return "suppressed";

  transact(db, () => {
    setStatus(db, rejected.id, "candidate");
    markRevived(db, rejected.id);
    updateScore(db, rejected.id, breakdown.total, breakdown);
  });
  return "revived";
}

function countContradictions(db: Db, decisionIds: string[]): number {
  const ids = new Set(decisionIds);
  let n = 0;
  for (const id of decisionIds) {
    for (const relation of getRelations(db, id)) {
      if (relation.relationType !== "contradicts") continue;
      const other =
        relation.fromDecisionId === id ? relation.toDecisionId : relation.fromDecisionId;
      if (ids.has(other)) n += 1;
    }
  }
  return Math.floor(n / 2);
}

function renderKnownProposals(proposals: Proposal[]): string {
  if (!proposals.length) return "(none)";
  return proposals
    .map((p) => `- [${p.kind}] ${p.title}: ${p.statement}`)
    .join("\n");
}

function renderDecisions(decisions: Decision[]): string {
  return decisions
    .map((d) => {
      const lines = [
        `### ${d.id}`,
        `- category: ${d.category}`,
        `- subject: ${d.subject}`,
        `- decision: ${d.decision}`,
      ];
      if (d.context) lines.push(`- context: ${d.context}`);
      if (d.reasoning) lines.push(`- reasoning: ${d.reasoning}`);
      if (d.alternatives?.length) {
        lines.push(
          `- alternatives: ${d.alternatives
            .map((a) => `${a.alternative}${a.reasonRejected ? ` (rejected: ${a.reasonRejected})` : ""}`)
            .join("; ")}`,
        );
      }
      lines.push(`- when: ${d.createdAt.slice(0, 10)}`, `- session: ${d.source}/${d.sourceSessionId.slice(0, 8)}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

function previewProposal(
  raw: { kind: string; title: string; statement: string; rationale?: string; proposed_target?: string; confidence?: number },
  domain: string,
  evidenceIds: string[],
  breakdown: ReturnType<typeof scoreProposal>,
  now: Date,
): Proposal {
  const iso = now.toISOString();
  return {
    id: "(dry-run)",
    createdAt: iso,
    updatedAt: iso,
    domain,
    kind: raw.kind as Proposal["kind"],
    title: raw.title,
    statement: raw.statement,
    rationale: raw.rationale,
    proposedTarget: raw.proposed_target,
    confidence: raw.confidence ?? 0.7,
    priorityScore: breakdown.total,
    scoreBreakdown: breakdown,
    status: "candidate",
    firstSeenAt: iso,
    lastSeenAt: iso,
    evidenceDecisionIds: evidenceIds,
  };
}

function writeRunRecord(
  db: Db,
  id: string,
  options: DistillOptions,
  profile: DomainProfile,
  analyzerName: string,
  report: DistillReport,
  now: Date,
): void {
  db.prepare(
    `INSERT INTO distillation_runs
       (id, started_at, finished_at, workspace_id, domain, analyzer,
        considered, proposed_new, attached, outcome, note)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    now.toISOString(),
    new Date().toISOString(),
    options.workspaceId ?? null,
    profile.domain,
    analyzerName,
    report.considered,
    report.created.length,
    report.reinforced.length + report.absorbedByAccepted.length + report.revived.length,
    report.created.length || report.reinforced.length || report.revived.length ? "ok" : "no-pattern",
    report.dropped.length ? report.dropped.slice(0, 10).join(" | ") : null,
  );
}
