/**
 * Domain-independent decision record.
 *
 * Nothing here is specific to software engineering. `category` is a free-form
 * string validated against the *active domain profile* at ingestion time, not
 * against a global enum — that is what lets a new profession be added without
 * a schema migration.
 */

export const DECISION_STATUSES = [
  "active",
  "superseded",
  "reverted",
  "expired",
  "experimental",
] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

export const RELATION_TYPES = [
  "supersedes",
  "contradicts",
  "supports",
  "refines",
  "related",
] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

export interface DecisionAlternative {
  id?: number;
  alternative: string;
  reasonRejected?: string;
}

export interface DecisionRelation {
  fromDecisionId: string;
  toDecisionId: string;
  relationType: RelationType;
  createdAt?: string;
  note?: string;
}

export interface Decision {
  id: string;
  createdAt: string;
  updatedAt: string;
  workspaceId: string;
  /** Adapter that observed this decision, e.g. "claude-code". */
  source: string;
  sourceSessionId: string;
  domain: string;
  /** Supplied by the active domain profile. */
  category: string;
  /** What the decision is about. */
  subject: string;
  /** What was decided. */
  decision: string;
  /** Situation that made the decision necessary. */
  context?: string;
  /** Why this option was chosen. */
  reasoning?: string;
  confidence: number;
  status: DecisionStatus;
  reviewedAt?: string;
  alternatives?: DecisionAlternative[];
}

/** A decision as proposed by an analyzer, before validation and persistence. */
export interface CandidateDecision {
  category: string;
  subject: string;
  decision: string;
  context?: string;
  reasoning?: string;
  confidence?: number;
  status?: DecisionStatus;
  alternatives?: DecisionAlternative[];
}

export function isDecisionStatus(v: unknown): v is DecisionStatus {
  return typeof v === "string" && (DECISION_STATUSES as readonly string[]).includes(v);
}

export function isRelationType(v: unknown): v is RelationType {
  return typeof v === "string" && (RELATION_TYPES as readonly string[]).includes(v);
}

/** Text used for search indexing and similarity comparison. */
export function decisionSearchText(d: Pick<Decision, "subject" | "decision" | "context" | "reasoning">): string {
  return [d.subject, d.decision, d.context ?? "", d.reasoning ?? ""].join("\n");
}
