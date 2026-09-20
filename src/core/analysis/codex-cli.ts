import type { Analyzer, AnalyzeRequest, AnalyzeResult } from "./analyzer.ts";
import { extractJson } from "./analyzer.ts";
import { runProcess, which } from "./run-process.ts";

/**
 * Analyzer backed by the Codex CLI in non-interactive mode.
 *
 * Codex has no structured-output flag equivalent to `--json-schema`, so the
 * schema is appended to the prompt and the reply is scraped for a JSON object.
 * Validation downstream is identical either way, so a sloppier reply simply
 * gets dropped rather than mishandled.
 */
export class CodexCliAnalyzer implements Analyzer {
  readonly name = "codex-cli";
  private readonly binary: string;
  private readonly model?: string;
  private readonly defaultTimeoutMs: number;

  constructor(options: { binary?: string; model?: string; timeoutMs?: number } = {}) {
    this.binary = options.binary ?? "codex";
    this.model = options.model;
    this.defaultTimeoutMs = options.timeoutMs ?? 180_000;
  }

  async available(): Promise<boolean> {
    return which(this.binary) !== undefined;
  }

  async analyze(request: AnalyzeRequest): Promise<AnalyzeResult> {
    const args = ["exec", "--skip-git-repo-check", "--sandbox", "read-only"];
    if (this.model) args.push("--model", this.model);
    args.push("-");

    const prompt =
      `${request.prompt}\n\n` +
      "Respond with a single JSON object and nothing else. It must validate against this JSON Schema:\n" +
      "```json\n" +
      `${JSON.stringify(request.schema, null, 2)}\n` +
      "```\n";

    const result = await runProcess(this.binary, args, {
      input: prompt,
      timeoutMs: request.timeoutMs ?? this.defaultTimeoutMs,
      env: { DECISION_LOGGER_INGEST: "1" },
    });

    if (result.timedOut) return { ok: false, error: `${this.name}: timed out` };
    if (result.code !== 0) {
      return {
        ok: false,
        error: `${this.name}: exited ${result.code}: ${result.stderr.trim().slice(0, 400)}`,
      };
    }

    const data = extractJson(result.stdout);
    if (data === undefined) return { ok: false, error: `${this.name}: response was not valid JSON` };
    return { ok: true, data, meta: { model: this.model ?? "default" } };
  }
}
