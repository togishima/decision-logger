/**
 * The LLM port.
 *
 * The core never talks to a model provider directly. It hands an analyzer a
 * prompt plus a JSON schema and gets back a parsed object — or an error. All
 * of the deterministic work (gating, validation, deduplication, ranking,
 * persistence) happens around this boundary, so a bad model response degrades
 * to "nothing was recorded" rather than to corrupted state.
 */

export type AnalyzePurpose = "extract-decisions" | "distill-patterns";

export interface AnalyzeRequest {
  prompt: string;
  /** JSON Schema the response must satisfy. */
  schema: Record<string, unknown>;
  purpose: AnalyzePurpose;
  /**
   * The same information as `prompt`, still structured.
   *
   * LLM-backed analyzers ignore this and use `prompt`. Non-LLM analyzers (the
   * deterministic heuristic, the test fake) read this instead of trying to
   * parse rendered Markdown back into data.
   */
  payload?: unknown;
  timeoutMs?: number;
}

export interface AnalyzeResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  /** Free-form diagnostics (cost, model, duration) for `--verbose`. */
  meta?: Record<string, unknown>;
}

export interface Analyzer {
  readonly name: string;
  /** Whether this analyzer can run right now (binary on PATH, key present, ...). */
  available(): Promise<boolean>;
  analyze(request: AnalyzeRequest): Promise<AnalyzeResult>;
}

export class UnavailableAnalyzer implements Analyzer {
  readonly name: string;
  readonly reason: string;

  constructor(name: string, reason: string) {
    this.name = name;
    this.reason = reason;
  }

  async available(): Promise<boolean> {
    return false;
  }

  async analyze(): Promise<AnalyzeResult> {
    return { ok: false, error: this.reason };
  }
}

/**
 * Extracts a JSON object from a model response that may be wrapped in prose or
 * a code fence. Returns undefined rather than throwing: an unparseable
 * response is a normal outcome we log and drop, not an exception.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  const direct = tryParse(trimmed);
  if (direct !== undefined) return direct;

  const fence = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n?```/);
  if (fence?.[1]) {
    const parsed = tryParse(fence[1]);
    if (parsed !== undefined) return parsed;
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) {
    const parsed = tryParse(trimmed.slice(start, end + 1));
    if (parsed !== undefined) return parsed;
  }

  return undefined;
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
