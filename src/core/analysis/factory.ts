import type { Analyzer } from "./analyzer.ts";
import { UnavailableAnalyzer } from "./analyzer.ts";
import type { Config } from "../config.ts";
import { ClaudeCliAnalyzer } from "./claude-cli.ts";
import { CodexCliAnalyzer } from "./codex-cli.ts";
import { AnthropicApiAnalyzer } from "./anthropic-api.ts";
import { HeuristicAnalyzer } from "./heuristic.ts";

export const ANALYZER_NAMES = [
  "auto",
  "claude-cli",
  "codex-cli",
  "anthropic-api",
  "heuristic",
  "none",
] as const;
export type AnalyzerName = (typeof ANALYZER_NAMES)[number];

function build(name: string, config: Config): Analyzer {
  const options = { model: config.analyzerModel, timeoutMs: config.analyzerTimeoutMs };
  switch (name) {
    case "claude-cli":
      return new ClaudeCliAnalyzer(options);
    case "codex-cli":
      return new CodexCliAnalyzer(options);
    case "anthropic-api":
      return new AnthropicApiAnalyzer(options);
    case "heuristic":
      return new HeuristicAnalyzer();
    case "none":
      return new UnavailableAnalyzer("none", "analyzer is disabled by configuration");
    default:
      return new UnavailableAnalyzer(name, `unknown analyzer "${name}"`);
  }
}

/**
 * Resolution order for `auto`: a local agent CLI first (no extra credential
 * needed), then the API if a key happens to be present. The heuristic analyzer
 * is never selected automatically — silently degrading to keyword matching
 * would make the store look healthy while quietly losing decisions.
 */
const AUTO_ORDER = ["claude-cli", "codex-cli", "anthropic-api"];

export async function createAnalyzer(config: Config): Promise<Analyzer> {
  if (config.analyzer !== "auto") return build(config.analyzer, config);

  for (const name of AUTO_ORDER) {
    const candidate = build(name, config);
    if (await candidate.available()) return candidate;
  }
  return new UnavailableAnalyzer(
    "auto",
    "no analyzer available: install the Claude Code or Codex CLI, set ANTHROPIC_API_KEY, " +
      'or set "analyzer": "heuristic" for offline keyword extraction',
  );
}

/** Used by `doctor` to report what is and is not usable. */
export async function probeAnalyzers(config: Config): Promise<{ name: string; available: boolean }[]> {
  const out: { name: string; available: boolean }[] = [];
  for (const name of ["claude-cli", "codex-cli", "anthropic-api", "heuristic"]) {
    out.push({ name, available: await build(name, config).available() });
  }
  return out;
}
