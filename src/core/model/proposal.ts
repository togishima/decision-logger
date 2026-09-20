/**
 * Work-pattern proposals produced by distillation.
 *
 * The three kinds are intentionally profession-independent. A proposal never
 * carries target-specific markup (no CLAUDE.md headings, no YAML frontmatter);
 * turning a proposal into an artifact is a renderer's job.
 */

export const PROPOSAL_KINDS = ["principle", "procedure", "operation"] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

export const PROPOSAL_STATUSES = [
  "candidate",
  "accepted",
  "rejected",
  "deferred",
  "superseded",
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const REJECTION_REASONS = [
  "too_specific",
  "already_known",
  "not_actionable",
  "temporary_pattern",
  "wrong_abstraction",
  "not_worth_automating",
  "other",
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

/** Explainable ranking breakdown. Every factor is a named, inspectable number. */
export interface ScoreBreakdown {
  evidenceCount: number;
  sessionSpread: number;
  sourceSpread: number;
  workspaceSpread: number;
  recency: number;
  avgConfidence: number;
  rejectionPenalty: number;
  coveredPenalty: number;
  contradictionPenalty: number;
  total: number;
}

export interface Proposal {
  id: string;
  createdAt: string;
  updatedAt: string;
  domain: string;
  workspaceId?: string;
  kind: ProposalKind;
  title: string;
  /** The reusable rule / procedure / operation itself, in plain language. */
  statement: string;
  rationale?: string;
  /** Domain-suggested destination, e.g. "coding-rules". Advisory only. */
  proposedTarget?: string;
  confidence: number;
  priorityScore: number;
  scoreBreakdown?: ScoreBreakdown;
  status: ProposalStatus;
  firstSeenAt: string;
  lastSeenAt: string;
  acceptedAt?: string;
  rejectedAt?: string;
  rejectionReason?: RejectionReason;
  deferredUntil?: string;
  /** Set when a previously rejected theme came back with strong new evidence. */
  revived?: boolean;
  evidenceDecisionIds?: string[];
}

/** A proposal as produced by an analyzer, before matching and persistence. */
export interface CandidateProposal {
  kind: ProposalKind;
  title: string;
  statement: string;
  rationale?: string;
  proposedTarget?: string;
  confidence?: number;
  /** Ids of the decisions that justify this proposal. Provenance is mandatory. */
  evidenceDecisionIds: string[];
}

export function isProposalKind(v: unknown): v is ProposalKind {
  return typeof v === "string" && (PROPOSAL_KINDS as readonly string[]).includes(v);
}

export function isProposalStatus(v: unknown): v is ProposalStatus {
  return typeof v === "string" && (PROPOSAL_STATUSES as readonly string[]).includes(v);
}

export function isRejectionReason(v: unknown): v is RejectionReason {
  return typeof v === "string" && (REJECTION_REASONS as readonly string[]).includes(v);
}

export function proposalSearchText(p: Pick<Proposal, "title" | "statement">): string {
  return `${p.title}\n${p.statement}`;
}
