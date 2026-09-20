import type { Db } from "../storage/db.ts";
import type { CandidateDecision, Decision } from "../model/decision.ts";
import { decisionSearchText } from "../model/decision.ts";
import { searchDecisions, listDecisions } from "../storage/decisions-repo.ts";
import { jaccard } from "./similarity.ts";

/**
 * Decides what a freshly extracted candidate actually is, relative to what is
 * already stored.
 *
 * Blindly appending would make the store grow without becoming more useful:
 * the same judgment restated five times looks like five independent pieces of
 * evidence and would distort every ranking downstream.
 */

export type CandidateVerdict =
  | { kind: "new" }
  | { kind: "duplicate"; existing: Decision; score: number }
  /** Same question, same answer, but this candidate records it better. */
  | { kind: "refinement"; existing: Decision; score: number; enriches: boolean }
  | { kind: "contradiction"; existing: Decision; score: number }
  | { kind: "supersedes"; existing: Decision; score: number };

export interface ClassifyThresholds {
  /** Subject overlap above which two decisions are about the same question. */
  sameSubject: number;
  /** Conclusion overlap above which the same question got the same answer. */
  sameConclusion: number;
  /** Whole-record overlap that implies sameness even when subjects are worded differently. */
  duplicate: number;
  /** Whole-record overlap below which two decisions are simply unrelated. */
  related: number;
}

export const DEFAULT_THRESHOLDS: ClassifyThresholds = {
  sameSubject: 0.5,
  sameConclusion: 0.6,
  duplicate: 0.72,
  related: 0.42,
};

/** Phrases that mark a candidate as reversing an earlier decision. */
const REVERSAL = /\b(?:no longer|instead of (?:the )?(?:previous|earlier)|switch(?:ed|ing)? (?:back )?to|revert(?:ed|ing)?|replac(?:e|ed|ing)|abandon(?:ed|ing)?|move(?:d)? away from)\b/i;

interface Comparison {
  existing: Decision;
  /** Do these decide the same question? */
  subject: number;
  /** Do they reach the same answer? */
  conclusion: number;
  /** How alike are the records as a whole? */
  body: number;
}

function compare(candidate: CandidateDecision, existing: Decision): Comparison {
  return {
    existing,
    subject: jaccard(candidate.subject, existing.subject),
    conclusion: jaccard(candidate.decision, existing.decision),
    body: jaccard(decisionSearchText(candidate), decisionSearchText(existing)),
  };
}

/**
 * The subject is what identifies a decision, not the whole record.
 *
 * Reasoning is usually the longest field, so comparing full text makes two
 * decisions about the same question look unrelated as soon as the rationale
 * differs — which is exactly the case where one supersedes or contradicts the
 * other. Weighting the subject is what lets those be detected at all.
 */
function relevance(c: Comparison): number {
  return Math.max(c.body, (c.subject + c.conclusion) / 2);
}

export function classifyCandidate(
  db: Db,
  candidate: CandidateDecision,
  scope: { workspaceId: string; domain: string },
  thresholds: ClassifyThresholds = DEFAULT_THRESHOLDS,
): CandidateVerdict {
  const searched = searchDecisions(db, `${candidate.subject} ${candidate.decision}`, {
    workspaceId: scope.workspaceId,
    limit: 40,
  });
  const pool =
    searched.length > 0
      ? searched
      : listDecisions(db, { workspaceId: scope.workspaceId, limit: 200 });

  let best: Comparison | undefined;
  for (const existing of pool) {
    if (existing.domain !== scope.domain) continue;
    if (existing.status === "superseded" || existing.status === "reverted") continue;
    const c = compare(candidate, existing);
    if (!best || relevance(c) > relevance(best)) best = c;
  }

  if (!best) return { kind: "new" };

  const sameQuestion = best.subject >= thresholds.sameSubject;
  const score = relevance(best);

  if (!sameQuestion && score < thresholds.related) return { kind: "new" };

  const sameAnswer =
    best.body >= thresholds.duplicate ||
    (sameQuestion && best.conclusion >= thresholds.sameConclusion);

  if (sameAnswer) {
    // The record already exists. Keep the candidate only if it says more.
    const addsReasoning = Boolean(candidate.reasoning) && !best.existing.reasoning;
    const addsAlternatives =
      Boolean(candidate.alternatives?.length) && !best.existing.alternatives?.length;
    if (addsReasoning || addsAlternatives) {
      return { kind: "refinement", existing: best.existing, score, enriches: true };
    }
    return { kind: "duplicate", existing: best.existing, score };
  }

  // Same question, different answer.
  if (REVERSAL.test(candidate.decision) || REVERSAL.test(candidate.context ?? "")) {
    return { kind: "supersedes", existing: best.existing, score };
  }
  if (sameQuestion && opposedPolarity(candidate, best.existing)) {
    return { kind: "contradiction", existing: best.existing, score };
  }

  return { kind: "refinement", existing: best.existing, score, enriches: false };
}

/**
 * Cheap polarity check: the same question answered with opposite adopt/reject
 * sense. Conservative on purpose — a wrong "contradicts" link is worse than a
 * missing one, because it is shown to the user as a claim about their own
 * history.
 */
function opposedPolarity(candidate: CandidateDecision, existing: Decision): boolean {
  const negative = /\b(?:not|no|never|reject(?:ed)?|avoid|without|drop(?:ped)?|remove[d]?)\b/i;
  return negative.test(candidate.decision) !== negative.test(existing.decision);
}
