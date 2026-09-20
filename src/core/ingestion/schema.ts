import type { DomainProfile } from "../domains/profile.ts";

/**
 * JSON Schemas handed to the analyzer, plus the hand-written validators that
 * check the response again on the way back in.
 *
 * Validating twice is deliberate. Not every analyzer can enforce a schema
 * (Codex cannot), and even a schema-enforced response can be semantically
 * wrong — an unknown category, an empty statement, evidence ids that do not
 * exist. Everything downstream of this file can assume the data is clean.
 */

export function extractionSchema(profile: DomainProfile): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      decisions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            category: { type: "string", enum: profile.categories },
            subject: { type: "string" },
            decision: { type: "string" },
            context: { type: "string" },
            reasoning: { type: "string" },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            alternatives: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  alternative: { type: "string" },
                  reason_rejected: { type: "string" },
                },
                required: ["alternative"],
                additionalProperties: false,
              },
            },
          },
          required: ["category", "subject", "decision", "confidence"],
          additionalProperties: false,
        },
      },
    },
    required: ["decisions"],
    additionalProperties: false,
  };
}

export function distillationSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      proposals: {
        type: "array",
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["principle", "procedure", "operation"] },
            title: { type: "string" },
            statement: { type: "string" },
            rationale: { type: "string" },
            proposed_target: { type: "string" },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            evidence_decision_ids: { type: "array", items: { type: "string" } },
          },
          required: ["kind", "title", "statement", "evidence_decision_ids"],
          additionalProperties: false,
        },
      },
    },
    required: ["proposals"],
    additionalProperties: false,
  };
}

/* ------------------------------------------------------------------ */
/* Response parsing                                                    */
/* ------------------------------------------------------------------ */

export interface RawDecision {
  category: string;
  subject: string;
  decision: string;
  context?: string;
  reasoning?: string;
  confidence?: number;
  alternatives?: { alternative: string; reason_rejected?: string; reasonRejected?: string }[];
}

export interface RawProposal {
  kind: string;
  title: string;
  statement: string;
  rationale?: string;
  proposed_target?: string;
  proposedTarget?: string;
  confidence?: number;
  evidence_decision_ids?: string[];
  evidenceDecisionIds?: string[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export interface ParseOutcome<T> {
  items: T[];
  /** Human-readable reasons items were dropped. Surfaced under `--verbose`. */
  rejected: string[];
}

export function parseDecisionsResponse(data: unknown): ParseOutcome<RawDecision> {
  const rejected: string[] = [];
  const root = asRecord(data);
  const list = root?.decisions;
  if (!Array.isArray(list)) {
    return { items: [], rejected: ['response has no "decisions" array'] };
  }

  const items: RawDecision[] = [];
  for (const [i, entry] of list.entries()) {
    const record = asRecord(entry);
    if (!record) {
      rejected.push(`decisions[${i}]: not an object`);
      continue;
    }
    const category = nonEmptyString(record.category);
    const subject = nonEmptyString(record.subject);
    const decision = nonEmptyString(record.decision);
    if (!category || !subject || !decision) {
      rejected.push(`decisions[${i}]: missing category, subject, or decision`);
      continue;
    }

    const alternatives: RawDecision["alternatives"] = [];
    if (Array.isArray(record.alternatives)) {
      for (const alt of record.alternatives) {
        const altRecord = asRecord(alt);
        const text = nonEmptyString(altRecord?.alternative);
        if (!text) continue;
        alternatives.push({
          alternative: text,
          reason_rejected:
            nonEmptyString(altRecord?.reason_rejected) ?? nonEmptyString(altRecord?.reasonRejected),
        });
      }
    }

    items.push({
      category,
      subject,
      decision,
      context: nonEmptyString(record.context),
      reasoning: nonEmptyString(record.reasoning),
      confidence: typeof record.confidence === "number" ? record.confidence : undefined,
      alternatives: alternatives.length ? alternatives : undefined,
    });
  }
  return { items, rejected };
}

export function parseProposalsResponse(data: unknown): ParseOutcome<RawProposal> {
  const rejected: string[] = [];
  const root = asRecord(data);
  const list = root?.proposals;
  if (!Array.isArray(list)) {
    return { items: [], rejected: ['response has no "proposals" array'] };
  }

  const items: RawProposal[] = [];
  for (const [i, entry] of list.entries()) {
    const record = asRecord(entry);
    if (!record) {
      rejected.push(`proposals[${i}]: not an object`);
      continue;
    }
    const kind = nonEmptyString(record.kind);
    const title = nonEmptyString(record.title);
    const statement = nonEmptyString(record.statement);
    if (!kind || !title || !statement) {
      rejected.push(`proposals[${i}]: missing kind, title, or statement`);
      continue;
    }
    const evidence =
      (Array.isArray(record.evidence_decision_ids) ? record.evidence_decision_ids : undefined) ??
      (Array.isArray(record.evidenceDecisionIds) ? record.evidenceDecisionIds : undefined) ??
      [];

    items.push({
      kind,
      title,
      statement,
      rationale: nonEmptyString(record.rationale),
      proposed_target:
        nonEmptyString(record.proposed_target) ?? nonEmptyString(record.proposedTarget),
      confidence: typeof record.confidence === "number" ? record.confidence : undefined,
      evidence_decision_ids: evidence.filter((id): id is string => typeof id === "string"),
    });
  }
  return { items, rejected };
}
