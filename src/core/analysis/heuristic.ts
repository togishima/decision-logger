import type { Analyzer, AnalyzeRequest, AnalyzeResult } from "./analyzer.ts";
import type { NormalizedWorkSession } from "../model/session.ts";
import type { Decision } from "../model/decision.ts";

/**
 * Deterministic, offline analyzer. No model, no network, no cost.
 *
 * Recall is deliberately poor: it only fires on explicit comparative or
 * rejection language in the user's own words. It exists so that the whole
 * pipeline can be exercised — in tests, in `doctor`, and on machines with no
 * agent CLI installed — without an LLM in the loop. It is not a replacement
 * for the model-backed extractor and `status` reports when it is in use.
 */

interface Marker {
  pattern: RegExp;
  category: string;
  weight: number;
}

const DECISION_MARKERS: Marker[] = [
  { pattern: /\binstead of\b/i, category: "tradeoff", weight: 0.72 },
  { pattern: /\brather than\b/i, category: "tradeoff", weight: 0.72 },
  { pattern: /\bwe(?:'ll| will|'re going to)? (?:go|stick) with\b/i, category: "tradeoff", weight: 0.7 },
  { pattern: /\b(?:don't|do not|won't|will not|no need to) (?:add|introduce|use|install)\b/i, category: "rejection", weight: 0.75 },
  { pattern: /\breject(?:ed|ing)?\b/i, category: "rejection", weight: 0.7 },
  { pattern: /\b(?:defer|postpone|punt|hold off)(?:red|ring|ed|ing)?\b/i, category: "defer", weight: 0.7 },
  { pattern: /\bfor now\b.*\blater\b/i, category: "defer", weight: 0.65 },
  { pattern: /\bout of scope\b/i, category: "constraint", weight: 0.7 },
  { pattern: /\bworkaround\b/i, category: "workaround", weight: 0.68 },
];

const REASON_MARKER = /\b(?:because|since|as it|so that|the reason)\b/i;

/** Drops boilerplate that would otherwise look like a decision. */
const NOISE = /^(?:ok|okay|thanks|yes|no|sure|go ahead|continue|proceed|lgtm)\b/i;

export class HeuristicAnalyzer implements Analyzer {
  readonly name = "heuristic";

  async available(): Promise<boolean> {
    return true;
  }

  async analyze(request: AnalyzeRequest): Promise<AnalyzeResult> {
    if (request.purpose === "extract-decisions") {
      const session = request.payload as { session?: NormalizedWorkSession } | undefined;
      if (!session?.session) return { ok: false, error: "heuristic: missing session payload" };
      return { ok: true, data: { decisions: extract(session.session) } };
    }

    if (request.purpose === "distill-patterns") {
      const payload = request.payload as { decisions?: Decision[] } | undefined;
      return { ok: true, data: { proposals: distill(payload?.decisions ?? []) } };
    }

    return { ok: false, error: `heuristic: unsupported purpose ${request.purpose}` };
  }
}

interface HeuristicDecision {
  category: string;
  subject: string;
  decision: string;
  context?: string;
  reasoning?: string;
  confidence: number;
}

function extract(session: NormalizedWorkSession): HeuristicDecision[] {
  const out: HeuristicDecision[] = [];
  const seen = new Set<string>();

  for (const message of session.messages) {
    if (message.role !== "user") continue;
    for (const sentence of splitSentences(message.text)) {
      if (sentence.length < 25 || sentence.length > 400) continue;
      if (NOISE.test(sentence.trim())) continue;

      const marker = DECISION_MARKERS.find((m) => m.pattern.test(sentence));
      if (!marker) continue;

      const hasReason = REASON_MARKER.test(sentence);
      const key = sentence.toLowerCase().replace(/\W+/g, " ").trim();
      if (seen.has(key)) continue;
      seen.add(key);

      out.push({
        category: marker.category,
        subject: subjectOf(sentence),
        decision: sentence.trim(),
        reasoning: hasReason ? sentence.trim() : undefined,
        confidence: Math.min(0.95, marker.weight + (hasReason ? 0.1 : 0)),
      });
    }
  }
  return out;
}

function splitSentences(text: string): string[] {
  return text
    .split(/\n{2,}|(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function subjectOf(sentence: string): string {
  const words = sentence
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);
  return words.join(" ") || "decision";
}

interface HeuristicProposal {
  kind: "principle";
  title: string;
  statement: string;
  rationale: string;
  confidence: number;
  evidence_decision_ids: string[];
}

/**
 * Groups decisions by category and proposes a principle only where the same
 * category recurs across at least three separate sessions. Intentionally
 * conservative: without a model there is no way to judge whether two decisions
 * really express the same judgment.
 */
function distill(decisions: Decision[]): HeuristicProposal[] {
  const byCategory = new Map<string, Decision[]>();
  for (const d of decisions) {
    const list = byCategory.get(d.category) ?? [];
    list.push(d);
    byCategory.set(d.category, list);
  }

  const out: HeuristicProposal[] = [];
  for (const [category, group] of byCategory) {
    const sessions = new Set(group.map((d) => d.sourceSessionId));
    if (group.length < 3 || sessions.size < 2) continue;
    out.push({
      kind: "principle",
      title: `Recurring ${category} judgment`,
      statement:
        `You repeatedly make ${category} decisions of the same shape. ` +
        `Review the supporting decisions and decide whether a standing rule is warranted.`,
      rationale:
        `${group.length} decisions in category "${category}" across ${sessions.size} sessions. ` +
        "Generated without a language model, so the wording is a placeholder, not a finished principle.",
      confidence: 0.4,
      evidence_decision_ids: group.slice(0, 12).map((d) => d.id),
    });
  }
  return out;
}
