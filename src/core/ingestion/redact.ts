import type { PrivacyConfig } from "../config.ts";

/**
 * Redaction applied to session text before it leaves this process.
 *
 * The built-in patterns cover the credential shapes that show up most often in
 * a terminal transcript. They are a safety net, not a guarantee — the real
 * protection is that decision-logger persists structured decisions rather than
 * transcripts. `privacy.redactPatterns` is the extension point for anything
 * specific to a user's environment.
 */

interface BuiltinPattern {
  name: string;
  pattern: RegExp;
}

const BUILTIN: BuiltinPattern[] = [
  { name: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: "openai-key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/g },
  { name: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}/g },
  { name: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "google-key", pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  { name: "slack-token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: "bearer-token", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g },
  { name: "private-key-block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: "env-assignment", pattern: /\b([A-Z0-9_]*(?:SECRET|PASSWORD|TOKEN|APIKEY|API_KEY)[A-Z0-9_]*)\s*=\s*\S+/g },
];

export interface RedactionResult {
  text: string;
  /** Pattern names that fired, for `--verbose` reporting. Never the values. */
  hits: string[];
}

export function redact(text: string, privacy: PrivacyConfig): RedactionResult {
  let out = text;
  const hits: string[] = [];

  for (const { name, pattern } of BUILTIN) {
    pattern.lastIndex = 0;
    if (pattern.test(out)) {
      pattern.lastIndex = 0;
      out = out.replace(pattern, (match) =>
        name === "env-assignment"
          ? `${match.split("=")[0]}=[redacted]`
          : "[redacted]",
      );
      hits.push(name);
    }
  }

  for (const source of privacy.redactPatterns) {
    let custom: RegExp;
    try {
      custom = new RegExp(source, "g");
    } catch {
      continue; // an invalid user pattern must not break ingestion
    }
    if (custom.test(out)) {
      out = out.replace(new RegExp(source, "g"), "[redacted]");
      hits.push(`custom:${source}`);
    }
  }

  return { text: out, hits };
}

/** Keeps the tail of a long text, which is where the conclusions usually are. */
export function truncateTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `[… ${text.length - maxChars} earlier characters omitted …]\n${text.slice(-maxChars)}`;
}
