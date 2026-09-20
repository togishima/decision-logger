import type { Decision } from "../model/decision.ts";
import type { Proposal, ScoreBreakdown } from "../model/proposal.ts";
import { jaccard } from "../dedupe/similarity.ts";
import { proposalSearchText } from "../model/proposal.ts";

/**
 * Explainable ranking.
 *
 * Every number below is a named factor the user can read back in
 * `score_breakdown`. No learned weights, no opaque model: if a proposal ranks
 * high the user must be able to see exactly why, otherwise they cannot trust
 * the review step — and the review step is the whole product.
 */

const WEIGHTS = {
  evidence: 1.0,
  sessionSpread: 1.4,
  sourceSpread: 1.0,
  workspaceSpread: 1.2,
  recency: 0.8,
  confidence: 1.0,
  rejectionPenalty: -2.5,
  coveredPenalty: -3.0,
  contradictionPenalty: -0.8,
} as const;

export interface ScoreInputs {
  evidence: Decision[];
  confidence: number;
  /** Rejected proposals whose theme resembles this one. */
  similarRejections: Proposal[];
  /** Accepted proposals whose theme resembles this one. */
  similarAccepted: Proposal[];
  /** Evidence decisions that contradict one another. */
  contradictions?: number;
  now?: Date;
}

export function scoreProposal(
  candidate: { title: string; statement: string },
  inputs: ScoreInputs,
): ScoreBreakdown {
  const now = inputs.now ?? new Date();
  const evidence = inputs.evidence;

  const evidenceCount = Math.min(evidence.length, 12) / 4;
  const sessionSpread = spread(evidence.map((d) => d.sourceSessionId));
  const sourceSpread = spread(evidence.map((d) => d.source));
  const workspaceSpread = spread(evidence.map((d) => d.workspaceId));
  const recency = recencyScore(evidence, now);
  const avgConfidence = evidence.length
    ? evidence.reduce((n, d) => n + d.confidence, 0) / evidence.length
    : inputs.confidence;

  const rejectionPenalty = themeMatch(candidate, inputs.similarRejections);
  const coveredPenalty = themeMatch(candidate, inputs.similarAccepted);
  const contradictionPenalty = Math.min(inputs.contradictions ?? 0, 3) / 3;

  const total =
    WEIGHTS.evidence * evidenceCount +
    WEIGHTS.sessionSpread * sessionSpread +
    WEIGHTS.sourceSpread * sourceSpread +
    WEIGHTS.workspaceSpread * workspaceSpread +
    WEIGHTS.recency * recency +
    WEIGHTS.confidence * avgConfidence +
    WEIGHTS.rejectionPenalty * rejectionPenalty +
    WEIGHTS.coveredPenalty * coveredPenalty +
    WEIGHTS.contradictionPenalty * contradictionPenalty;

  return {
    evidenceCount: round(evidenceCount),
    sessionSpread: round(sessionSpread),
    sourceSpread: round(sourceSpread),
    workspaceSpread: round(workspaceSpread),
    recency: round(recency),
    avgConfidence: round(avgConfidence),
    rejectionPenalty: round(rejectionPenalty),
    coveredPenalty: round(coveredPenalty),
    contradictionPenalty: round(contradictionPenalty),
    total: round(total),
  };
}

/** 0 for a single distinct value, approaching 1 as evidence spreads out. */
function spread(values: string[]): number {
  const distinct = new Set(values).size;
  if (distinct <= 1) return 0;
  return Math.min(1, (distinct - 1) / 3);
}

/** 1.0 for evidence from today, decaying to 0 over 90 days. */
function recencyScore(evidence: Decision[], now: Date): number {
  if (!evidence.length) return 0;
  const newest = Math.max(...evidence.map((d) => Date.parse(d.createdAt)));
  const days = (now.getTime() - newest) / 86_400_000;
  return Math.max(0, Math.min(1, 1 - days / 90));
}

/** How strongly this candidate resembles the strongest match in a set. */
function themeMatch(candidate: { title: string; statement: string }, others: Proposal[]): number {
  if (!others.length) return 0;
  const text = proposalSearchText(candidate);
  let best = 0;
  for (const other of others) {
    best = Math.max(best, jaccard(text, proposalSearchText(other)));
  }
  return best;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Renders a breakdown as the one-line explanation shown next to a proposal. */
export function explainScore(breakdown: ScoreBreakdown): string {
  const parts = [
    `evidence ${breakdown.evidenceCount}`,
    `sessions ${breakdown.sessionSpread}`,
    `sources ${breakdown.sourceSpread}`,
    `workspaces ${breakdown.workspaceSpread}`,
    `recency ${breakdown.recency}`,
    `confidence ${breakdown.avgConfidence}`,
  ];
  if (breakdown.rejectionPenalty > 0) parts.push(`rejected-before −${breakdown.rejectionPenalty}`);
  if (breakdown.coveredPenalty > 0) parts.push(`already-covered −${breakdown.coveredPenalty}`);
  if (breakdown.contradictionPenalty > 0) parts.push(`contradictions −${breakdown.contradictionPenalty}`);
  return parts.join(", ");
}
