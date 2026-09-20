import type { Decision } from "../core/model/decision.ts";
import type { Proposal } from "../core/model/proposal.ts";
import { explainScore } from "../core/ranking/score.ts";

/**
 * Terminal output.
 *
 * `--json` exists so agents and scripts never have to scrape the prose form,
 * and so the Claude Code slash commands stay thin wrappers around the CLI
 * rather than a second implementation.
 */

export function emit(value: unknown, asJson: boolean, render: () => string): void {
  process.stdout.write(asJson ? `${JSON.stringify(value, null, 2)}\n` : `${render()}\n`);
}

export function decisionLine(d: Decision): string {
  const flag = d.status === "active" ? " " : "!";
  return `${flag} ${d.id}  ${pad(d.category, 14)} ${d.subject}`;
}

export function decisionDetail(d: Decision, relations: string[] = []): string {
  const lines = [
    `${d.id}`,
    `  subject     ${d.subject}`,
    `  decision    ${d.decision}`,
  ];
  if (d.context) lines.push(`  context     ${wrapIndent(d.context)}`);
  if (d.reasoning) lines.push(`  reasoning   ${wrapIndent(d.reasoning)}`);
  lines.push(
    `  category    ${d.category}   domain ${d.domain}`,
    `  status      ${d.status}   confidence ${d.confidence.toFixed(2)}`,
    `  source      ${d.source} / ${d.sourceSessionId}`,
    `  workspace   ${d.workspaceId}`,
    `  created     ${d.createdAt}`,
    `  reviewed    ${d.reviewedAt ?? "not yet"}`,
  );
  if (d.alternatives?.length) {
    lines.push("  alternatives");
    for (const alt of d.alternatives) {
      lines.push(`    - ${alt.alternative}${alt.reasonRejected ? ` — rejected: ${alt.reasonRejected}` : ""}`);
    }
  }
  if (relations.length) {
    lines.push("  relations");
    for (const r of relations) lines.push(`    - ${r}`);
  }
  return lines.join("\n");
}

export function proposalBlock(p: Proposal, evidence: Decision[]): string {
  const lines = [
    `${p.id}  [${p.kind}]  score ${p.priorityScore.toFixed(2)}${p.revived ? "  (revived)" : ""}`,
    `  ${p.title}`,
    "",
    `  ${wrapIndent(p.statement, 2)}`,
  ];
  if (p.rationale) lines.push("", `  why: ${wrapIndent(p.rationale, 2)}`);
  if (p.proposedTarget) lines.push("", `  suggested target: ${p.proposedTarget}`);

  lines.push("", `  evidence (${evidence.length}):`);
  for (const d of evidence.slice(0, 8)) {
    lines.push(`    ${d.id}  ${d.subject} — ${truncate(d.decision, 80)}`);
  }
  if (evidence.length > 8) lines.push(`    … and ${evidence.length - 8} more`);

  if (p.scoreBreakdown) lines.push("", `  ranking: ${explainScore(p.scoreBreakdown)}`);
  if (p.status !== "candidate") lines.push("", `  status: ${p.status}`);
  return lines.join("\n");
}

export function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export function wrapIndent(text: string, indent = 14, width = 76): string {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if ((current + " " + word).trim().length > width) {
      lines.push(current.trim());
      current = word;
    } else {
      current += ` ${word}`;
    }
  }
  if (current.trim()) lines.push(current.trim());
  return lines.join(`\n${" ".repeat(indent)}`);
}

export function heading(text: string): string {
  return `\n${text}\n${"─".repeat(Math.min(text.length, 60))}`;
}
