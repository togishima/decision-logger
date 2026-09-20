import type { Analyzer, AnalyzeRequest, AnalyzeResult } from "./analyzer.ts";
import { extractJson } from "./analyzer.ts";

/**
 * Analyzer that calls the Claude API directly.
 *
 * Only used when `ANTHROPIC_API_KEY` is set and the user selected it: the CLI
 * analyzers are preferred because they need no extra credential. Implemented
 * with `fetch` so the tool keeps zero runtime dependencies.
 *
 * The schema is enforced through a single forced tool call, which is the
 * documented way to get structured output from the Messages API.
 */
const DEFAULT_MODEL = "claude-sonnet-5";
const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

export class AnthropicApiAnalyzer implements Analyzer {
  readonly name = "anthropic-api";
  private readonly model: string;
  private readonly defaultTimeoutMs: number;

  constructor(options: { model?: string; timeoutMs?: number } = {}) {
    this.model = options.model ?? DEFAULT_MODEL;
    this.defaultTimeoutMs = options.timeoutMs ?? 180_000;
  }

  async available(): Promise<boolean> {
    return Boolean(process.env.ANTHROPIC_API_KEY);
  }

  async analyze(request: AnalyzeRequest): Promise<AnalyzeResult> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return { ok: false, error: `${this.name}: ANTHROPIC_API_KEY is not set` };

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      request.timeoutMs ?? this.defaultTimeoutMs,
    );

    try {
      const response = await fetch(API_URL, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": API_VERSION,
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 8000,
          messages: [{ role: "user", content: request.prompt }],
          tools: [
            {
              name: "emit_result",
              description: `Return the ${request.purpose} result.`,
              input_schema: request.schema,
            },
          ],
          tool_choice: { type: "tool", name: "emit_result" },
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        return { ok: false, error: `${this.name}: HTTP ${response.status}: ${body.slice(0, 400)}` };
      }

      const payload = (await response.json()) as {
        content?: { type: string; input?: unknown; text?: string }[];
        usage?: unknown;
      };

      const toolUse = payload.content?.find((block) => block.type === "tool_use");
      if (toolUse?.input !== undefined) {
        return { ok: true, data: toolUse.input, meta: { model: this.model, usage: payload.usage } };
      }

      const text = payload.content?.find((block) => block.type === "text")?.text;
      const data = text ? extractJson(text) : undefined;
      if (data === undefined) return { ok: false, error: `${this.name}: no structured result` };
      return { ok: true, data, meta: { model: this.model, usage: payload.usage } };
    } catch (err) {
      const message = (err as Error).name === "AbortError" ? "timed out" : (err as Error).message;
      return { ok: false, error: `${this.name}: ${message}` };
    } finally {
      clearTimeout(timer);
    }
  }
}
