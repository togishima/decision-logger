import type { Db } from "../storage/db.ts";
import type { Config } from "../config.ts";
import type { Analyzer } from "../analysis/analyzer.ts";
import type { DomainProfile } from "../domains/profile.ts";
import type { NormalizedWorkSession } from "../model/session.ts";
import type { CandidateDecision, Decision } from "../model/decision.ts";

import { validateSession } from "../model/session.ts";
import { normalizeCategory } from "../domains/profile.ts";
import { loadPrompt, fillTemplate } from "../analysis/prompts.ts";
import { extractionSchema, parseDecisionsResponse } from "./schema.ts";
import { shouldAnalyze } from "./gate.ts";
import { redact, truncateTail } from "./redact.ts";
import { classifyCandidate } from "../dedupe/classify.ts";
import {
  insertDecision,
  addRelation,
  supersede,
  touchDecision,
} from "../storage/decisions-repo.ts";
import {
  upsertWorkspace,
  getIngestionRecord,
  recordIngestion,
} from "../storage/workspace-repo.ts";

export interface IngestOutcome {
  analyzed: boolean;
  /** Why the deterministic gate declined, when it did. */
  skippedReason?: string;
  inserted: Decision[];
  duplicates: number;
  refinements: number;
  contradictions: number;
  supersessions: number;
  /** Candidates dropped by validation, with reasons. */
  dropped: string[];
  error?: string;
  analyzerName?: string;
  meta?: Record<string, unknown>;
}

export interface IngestOptions {
  db: Db;
  config: Config;
  profile: DomainProfile;
  analyzer: Analyzer;
  session: NormalizedWorkSession;
  /** Run the analyzer even when the gate would have declined. */
  force?: boolean;
  /** Analyze and report, but write nothing. */
  dryRun?: boolean;
}

/**
 * The one path from a normalized session to stored decisions.
 *
 * Order matters: gate, redact, analyze, validate, classify, persist. The model
 * only ever sits in the middle — every guarantee the store makes is enforced
 * by the deterministic steps around it.
 */
export async function ingestSession(options: IngestOptions): Promise<IngestOutcome> {
  const { db, config, profile, analyzer, session } = options;

  const empty: IngestOutcome = {
    analyzed: false,
    inserted: [],
    duplicates: 0,
    refinements: 0,
    contradictions: 0,
    supersessions: 0,
    dropped: [],
  };

  const problems = validateSession(session);
  if (problems.length) return { ...empty, error: `invalid session: ${problems.join("; ")}` };

  const previous = getIngestionRecord(db, session.source, session.sessionId);
  const gate = shouldAnalyze(session, config.ingestion, previous?.cursor ?? 0);
  if (!gate.proceed && !options.force) {
    return { ...empty, skippedReason: gate.reason };
  }

  const prompt = buildExtractionPrompt(session, profile, config);
  const response = await analyzer.analyze({
    prompt,
    schema: extractionSchema(profile),
    purpose: "extract-decisions",
    payload: { session, profile },
    timeoutMs: config.analyzerTimeoutMs,
  });

  if (!response.ok) {
    return { ...empty, analyzed: true, analyzerName: analyzer.name, error: response.error };
  }

  const parsed = parseDecisionsResponse(response.data);
  const outcome: IngestOutcome = {
    ...empty,
    analyzed: true,
    analyzerName: analyzer.name,
    dropped: [...parsed.rejected],
    meta: response.meta,
  };

  const candidates = validateCandidates(parsed.items, profile, config, outcome.dropped);
  if (options.dryRun) {
    outcome.inserted = candidates.map((c) => asPreview(c, session, profile.domain));
    return outcome;
  }

  upsertWorkspace(db, session.workspaceId, session.workspaceLabel);

  for (const candidate of candidates) {
    const verdict = classifyCandidate(db, candidate, {
      workspaceId: session.workspaceId,
      domain: profile.domain,
    });

    if (verdict.kind === "duplicate") {
      outcome.duplicates += 1;
      continue;
    }

    if (verdict.kind === "refinement" && verdict.enriches) {
      // Same question, same answer — the stored row just lacked the rationale.
      touchDecision(db, verdict.existing.id, {
        reasoning: candidate.reasoning ?? verdict.existing.reasoning,
        context: candidate.context ?? verdict.existing.context,
      });
      outcome.refinements += 1;
      continue;
    }

    const stored = insertDecision(db, {
      workspaceId: session.workspaceId,
      source: session.source,
      sourceSessionId: session.sessionId,
      domain: profile.domain,
      category: candidate.category,
      subject: candidate.subject,
      decision: candidate.decision,
      context: candidate.context,
      reasoning: candidate.reasoning,
      confidence: candidate.confidence,
      status: candidate.status ?? "active",
      alternatives: candidate.alternatives,
      createdAt: session.endedAt ?? session.startedAt,
    });
    outcome.inserted.push(stored);

    if (verdict.kind === "supersedes") {
      supersede(db, stored.id, verdict.existing.id, "detected during ingestion");
      outcome.supersessions += 1;
    } else if (verdict.kind === "contradiction") {
      addRelation(db, {
        fromDecisionId: stored.id,
        toDecisionId: verdict.existing.id,
        relationType: "contradicts",
      });
      outcome.contradictions += 1;
    } else if (verdict.kind === "refinement") {
      addRelation(db, {
        fromDecisionId: stored.id,
        toDecisionId: verdict.existing.id,
        relationType: "refines",
      });
      outcome.refinements += 1;
    }
  }

  recordIngestion(
    db,
    session.source,
    session.sessionId,
    session.workspaceId,
    session.cursor ?? (previous?.cursor ?? 0) + 1,
    outcome.inserted.length,
  );

  return outcome;
}

/**
 * The quality bar, applied after the model and before the database.
 *
 * Precision over recall is a product requirement, so this stage is allowed to
 * throw away plausible-looking output: an unknown category, a confidence below
 * the threshold, a decision with no reasoning anywhere, or a cap overflow.
 */
function validateCandidates(
  raw: ReturnType<typeof parseDecisionsResponse>["items"],
  profile: DomainProfile,
  config: Config,
  dropped: string[],
): CandidateDecision[] {
  const out: CandidateDecision[] = [];

  for (const item of raw) {
    const category = normalizeCategory(profile, item.category);
    if (!category) {
      dropped.push(`"${item.subject}": category "${item.category}" is not in the ${profile.domain} profile`);
      continue;
    }

    const confidence = item.confidence ?? 0.7;
    if (confidence < config.ingestion.minConfidence) {
      dropped.push(`"${item.subject}": confidence ${confidence.toFixed(2)} below ${config.ingestion.minConfidence}`);
      continue;
    }

    if (item.subject.length > 160) {
      dropped.push(`"${item.subject.slice(0, 40)}…": subject is too long to be a subject`);
      continue;
    }

    if (!item.reasoning && !item.alternatives?.length) {
      dropped.push(`"${item.subject}": no reasoning and no alternatives — not a reusable decision`);
      continue;
    }

    out.push({
      category,
      subject: item.subject,
      decision: item.decision,
      context: item.context,
      reasoning: item.reasoning,
      confidence,
      alternatives: item.alternatives?.map((a) => ({
        alternative: a.alternative,
        reasonRejected: a.reason_rejected ?? a.reasonRejected,
      })),
    });

    if (out.length >= config.ingestion.maxDecisionsPerSession) {
      if (out.length < raw.length) {
        dropped.push(`${raw.length - out.length} further candidate(s) over the per-session cap`);
      }
      break;
    }
  }

  return out;
}

function asPreview(
  candidate: CandidateDecision,
  session: NormalizedWorkSession,
  domain: string,
): Decision {
  const now = new Date().toISOString();
  return {
    id: "(dry-run)",
    createdAt: now,
    updatedAt: now,
    workspaceId: session.workspaceId,
    source: session.source,
    sourceSessionId: session.sessionId,
    domain,
    category: candidate.category,
    subject: candidate.subject,
    decision: candidate.decision,
    context: candidate.context,
    reasoning: candidate.reasoning,
    confidence: candidate.confidence ?? 0.7,
    status: "active",
    alternatives: candidate.alternatives,
  };
}

export function buildExtractionPrompt(
  session: NormalizedWorkSession,
  profile: DomainProfile,
  config: Config,
): string {
  const transcript = renderTranscript(session, config);
  return fillTemplate(loadPrompt("extract-decisions"), {
    domain: profile.domain,
    categories: profile.categories.map((c) => `- ${c}`).join("\n"),
    extraction_guidance: profile.extractionGuidance ?? "(none)",
    examples: renderExamples(profile),
    max_decisions: String(config.ingestion.maxDecisionsPerSession),
    workspace: session.workspaceLabel ?? session.workspaceId,
    source: session.source,
    transcript,
  });
}

function renderExamples(profile: DomainProfile): string {
  if (!profile.examples?.length) return "";
  const lines = profile.examples.map(
    (ex) =>
      `- [${ex.category}] ${ex.subject} — ${ex.decision}` +
      (ex.reasoning ? `\n  reasoning: ${ex.reasoning}` : ""),
  );
  return `## Examples of decisions worth recording in this domain\n\n${lines.join("\n")}`;
}

function renderTranscript(session: NormalizedWorkSession, config: Config): string {
  const parts: string[] = [];

  for (const message of session.messages) {
    if (!message.text.trim() && !message.reasoning) continue;
    parts.push(`[${message.role}] ${message.text.trim()}`);
    if (config.privacy.sendReasoningToAnalyzer && message.reasoning?.trim()) {
      parts.push(`[${message.role}:reasoning] ${message.reasoning.trim()}`);
    }
  }

  if (session.toolCalls?.length) {
    const names = summarizeToolCalls(session.toolCalls.map((t) => t.name));
    parts.push(`[tools used] ${names}`);
  }

  if (session.changedResources?.length) {
    const refs = session.changedResources.slice(0, 40).map((r) => `${r.ref} (${r.changeType ?? "changed"})`);
    parts.push(`[changed resources] ${refs.join(", ")}`);
  }

  const joined = parts.join("\n\n");
  const { text } = redact(joined, config.privacy);
  return truncateTail(text, config.privacy.maxAnalyzerInputChars);
}

function summarizeToolCalls(names: string[]): string {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `${name}×${n}`)
    .join(", ");
}
