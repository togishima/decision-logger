import type { Analyzer, AnalyzeRequest, AnalyzeResult } from "./analyzer.ts";
import { extractJson } from "./analyzer.ts";
import { runProcess, which } from "./run-process.ts";

/**
 * Analyzer backed by the Claude Code CLI in headless mode.
 *
 * Chosen as the default because it needs no API key beyond the login the user
 * already has. The flags matter:
 *
 * - `--bare` skips hooks, skills, MCP servers and CLAUDE.md. Without it the
 *   SessionStart/SessionEnd hooks that trigger ingestion would fire again
 *   inside this subprocess.
 * - `--no-session-persistence` keeps the analysis out of `~/.claude/projects`,
 *   so observing the user's work does not itself create transcripts.
 * - `--json-schema` gives schema-validated structured output instead of prose
 *   we would have to scrape.
 * - `DECISION_LOGGER_INGEST=1` is a second, belt-and-braces re-entrancy guard.
 *
 * The prompt goes in argv, not on stdin: `claude -p` treats piped stdin as
 * extra context for a prompt argument and exits non-zero when no such argument
 * is given. Argv is size-limited, hence MAX_PROMPT_BYTES below.
 */

/**
 * Ceiling on the prompt passed through argv. Well under the smallest limit
 * observed in practice (~120 KB), leaving room for the schema and flags.
 */
const MAX_PROMPT_BYTES = 80_000;

export class ClaudeCliAnalyzer implements Analyzer {
  readonly name = "claude-cli";
  private readonly binary: string;
  private readonly model?: string;
  private readonly defaultTimeoutMs: number;

  constructor(options: { binary?: string; model?: string; timeoutMs?: number } = {}) {
    this.binary = options.binary ?? "claude";
    this.model = options.model;
    this.defaultTimeoutMs = options.timeoutMs ?? 180_000;
  }

  async available(): Promise<boolean> {
    return which(this.binary) !== undefined;
  }

  async analyze(request: AnalyzeRequest): Promise<AnalyzeResult> {
    const prompt = clampBytes(request.prompt, MAX_PROMPT_BYTES);

    const args = [
      "-p",
      prompt,
      "--output-format",
      "json",
      "--bare",
      "--no-session-persistence",
      "--permission-prompts",
      "none",
      "--max-turns",
      "4",
      "--json-schema",
      JSON.stringify(request.schema),
    ];
    if (this.model) args.push("--model", this.model);

    const result = await runProcess(this.binary, args, {
      timeoutMs: request.timeoutMs ?? this.defaultTimeoutMs,
      env: { DECISION_LOGGER_INGEST: "1", CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1" },
    });

    if (result.timedOut) return { ok: false, error: `${this.name}: timed out` };
    if (result.code !== 0) {
      return {
        ok: false,
        error: `${this.name}: exited ${result.code}: ${result.stderr.trim().slice(0, 400)}`,
      };
    }

    const envelope = extractJson(result.stdout);
    const message = findResultMessage(envelope);
    if (!message) {
      return { ok: false, error: `${this.name}: no result message in output` };
    }
    if (message.is_error) {
      return { ok: false, error: `${this.name}: ${String(message.result ?? "error")}` };
    }

    const data =
      message.structured_output ??
      (typeof message.result === "string" ? extractJson(message.result) : undefined);

    if (data === undefined) {
      return { ok: false, error: `${this.name}: response was not valid JSON` };
    }

    return {
      ok: true,
      data,
      meta: {
        model: this.model ?? "default",
        costUsd: message.total_cost_usd,
        durationMs: message.duration_ms,
      },
    };
  }
}

interface ResultMessage {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: unknown;
  structured_output?: unknown;
  total_cost_usd?: number;
  duration_ms?: number;
}

/**
 * `--output-format json` emits an array of session messages whose last entry is
 * the result. Older builds emit the result object alone, so handle both.
 */
function findResultMessage(envelope: unknown): ResultMessage | undefined {
  if (Array.isArray(envelope)) {
    for (let i = envelope.length - 1; i >= 0; i--) {
      const item = envelope[i] as ResultMessage;
      if (item && typeof item === "object" && item.type === "result") return item;
    }
    return undefined;
  }
  if (envelope && typeof envelope === "object") {
    const obj = envelope as ResultMessage;
    if ("result" in obj || "structured_output" in obj) return obj;
  }
  return undefined;
}

/** Keeps the tail, which is where a session's conclusions are. */
function clampBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const notice = "[… earlier content omitted to fit the command-line limit …]\n";
  const budget = maxBytes - Buffer.byteLength(notice, "utf8");
  const buf = Buffer.from(text, "utf8").subarray(-budget);
  return notice + buf.toString("utf8");
}
