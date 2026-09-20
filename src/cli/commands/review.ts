import type { CliContext } from "../context.ts";
import type { Proposal, RejectionReason } from "../../core/model/proposal.ts";
import { isRejectionReason, REJECTION_REASONS } from "../../core/model/proposal.ts";
import { distill } from "../../core/distillation/distill.ts";
import {
  listProposals,
  listActionable,
  resolveProposal,
  getProposal,
} from "../../core/storage/proposals-repo.ts";
import { getDecision } from "../../core/storage/decisions-repo.ts";
import {
  acceptProposal,
  rejectProposal,
  deferProposal,
  reopenProposal,
  ReviewError,
} from "../../core/review/actions.ts";
import { rendererFor } from "../../renderers/registry.ts";
import { isReentrantInvocation } from "../../core/config.ts";
import { emit, heading, proposalBlock, pad, truncate } from "../format.ts";

export interface DistillArgs {
  allWorkspaces?: boolean;
  dryRun?: boolean;
  max?: number;
}

export async function cmdDistill(ctx: CliContext, args: DistillArgs): Promise<number> {
  if (isReentrantInvocation()) {
    emit({ skipped: "reentrant" }, ctx.json, () => "Skipped: running inside an analyzer subprocess.");
    return 0;
  }

  const report = await distill({
    db: ctx.db,
    config: ctx.config,
    profile: ctx.profile,
    analyzer: await ctx.analyzer(),
    workspaceId: args.allWorkspaces ? undefined : ctx.workspace.id,
    dryRun: args.dryRun,
    maxProposals: args.max,
  });

  const open = args.dryRun
    ? report.created
    : listActionable(ctx.db, { domain: ctx.profile.domain });

  emit({ report, open }, ctx.json, () => {
    if (report.outcome === "not-enough-decisions") {
      return `Not enough decisions yet: ${report.error}.\nKeep working — decisions accumulate automatically.`;
    }
    if (report.outcome === "error") {
      return `Distillation failed: ${report.error}`;
    }

    const lines = [heading(`Distillation — ${report.considered} decision(s) considered`)];

    if (report.outcome === "no-pattern") {
      lines.push(
        "",
        "No meaningful pattern yet.",
        "",
        "That is a normal result. Patterns show up when the same judgment recurs",
        "across different situations; a handful of unrelated decisions will not",
        "produce one, and inventing a pattern from thin evidence would be worse",
        "than saying nothing.",
      );
      if (ctx.verbose && report.dropped.length) {
        lines.push("", "Dropped candidates:", ...report.dropped.map((d) => `  - ${d}`));
      }
      return lines.join("\n");
    }

    if (report.created.length) {
      lines.push("", `${report.created.length} new proposal(s):`, "");
      for (const p of report.created) {
        lines.push(proposalBlock(p, evidenceOf(ctx, p)), "");
      }
    }
    if (report.revived.length) {
      lines.push(`${report.revived.length} previously rejected theme(s) revived by new evidence:`, "");
      for (const p of report.revived) lines.push(proposalBlock(p, evidenceOf(ctx, p)), "");
    }
    if (report.reinforced.length) {
      lines.push(`${report.reinforced.length} existing proposal(s) gained evidence:`);
      for (const p of report.reinforced) lines.push(`  ${p.id}  ${truncate(p.title, 64)}`);
      lines.push("");
    }
    if (report.absorbedByAccepted.length) {
      lines.push(
        `${report.absorbedByAccepted.length} pattern(s) you already accepted absorbed new evidence ` +
          "instead of being proposed again:",
      );
      for (const p of report.absorbedByAccepted) lines.push(`  ${p.id}  ${truncate(p.title, 64)}`);
      lines.push("");
    }
    if (ctx.verbose && report.dropped.length) {
      lines.push("Dropped candidates:", ...report.dropped.map((d) => `  - ${d}`), "");
    }

    lines.push(
      "Review with:",
      "  decision-logger accept <id>",
      `  decision-logger reject <id> [--reason ${REJECTION_REASONS.slice(0, 3).join("|")}|…]`,
      "  decision-logger defer  <id> [--days 30]",
    );
    return lines.join("\n");
  });

  return report.outcome === "error" ? 1 : 0;
}

function evidenceOf(ctx: CliContext, proposal: Proposal) {
  return (proposal.evidenceDecisionIds ?? [])
    .map((id) => getDecision(ctx.db, id))
    .filter((d) => d !== undefined);
}

export interface ProposalsArgs {
  status?: string;
  limit?: number;
}

export function cmdProposals(ctx: CliContext, args: ProposalsArgs): void {
  const status = args.status ?? "open";
  const proposals =
    status === "open"
      ? listActionable(ctx.db, { limit: args.limit })
      : listProposals(ctx.db, {
          status: status === "all" ? "any" : (status as Proposal["status"]),
          limit: args.limit,
        });

  emit({ status, proposals }, ctx.json, () => {
    if (!proposals.length) return `No ${status} proposals.`;
    const lines = [heading(`${proposals.length} ${status} proposal(s)`)];
    for (const p of proposals) {
      lines.push(
        `  ${pad(p.id, 14)} ${pad(p.kind, 10)} ${p.priorityScore.toFixed(2).padStart(6)}  ${truncate(p.title, 50)}`,
      );
    }
    lines.push("", "Use `decision-logger show-proposal <id>` for evidence and ranking.");
    return lines.join("\n");
  });
}

export function cmdShowProposal(ctx: CliContext, id: string): number {
  const proposal = resolveProposal(ctx.db, id);
  if (!proposal) {
    process.stderr.write(`No proposal matching "${id}".\n`);
    return 1;
  }
  const evidence = evidenceOf(ctx, proposal);
  emit({ proposal, evidence }, ctx.json, () => proposalBlock(proposal, evidence));
  return 0;
}

export interface ReviewArgs {
  reason?: string;
  days?: number;
  until?: string;
}

export function cmdReview(
  ctx: CliContext,
  action: "accept" | "reject" | "defer" | "reopen",
  id: string,
  args: ReviewArgs,
): number {
  try {
    let proposal: Proposal;
    switch (action) {
      case "accept":
        proposal = acceptProposal(ctx.db, id);
        break;
      case "reject": {
        let reason: RejectionReason | undefined;
        if (args.reason) {
          if (!isRejectionReason(args.reason)) {
            process.stderr.write(
              `Unknown reason "${args.reason}". Valid: ${REJECTION_REASONS.join(", ")}\n`,
            );
            return 1;
          }
          reason = args.reason;
        }
        proposal = rejectProposal(ctx.db, id, reason);
        break;
      }
      case "defer":
        proposal = deferProposal(ctx.db, id, {
          days: args.days,
          until: args.until,
          defaultDays: ctx.config.distillation.deferDays,
        });
        break;
      case "reopen":
        proposal = reopenProposal(ctx.db, id);
        break;
    }

    emit({ proposal }, ctx.json, () => {
      const lines = [`${proposal.status}: ${proposal.id} — ${proposal.title}`];
      if (action === "accept") {
        lines.push(
          "",
          "It will not be proposed again. New supporting decisions will attach to it,",
          "and contradicting evidence can bring it back for re-review.",
          "",
          `To turn it into a work-system artifact:  decision-logger render ${proposal.id}`,
        );
      }
      if (action === "reject") {
        lines.push(
          "",
          "Kept with its evidence. Similar proposals will rank lower from now on,",
          "and only genuinely strong new evidence can raise this theme again.",
        );
      }
      if (action === "defer" && proposal.deferredUntil) {
        lines.push("", `It will reappear after ${proposal.deferredUntil.slice(0, 10)}.`);
      }
      return lines.join("\n");
    });
    return 0;
  } catch (err) {
    if (err instanceof ReviewError) {
      process.stderr.write(`${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

export interface RenderArgs {
  target?: string;
  list?: boolean;
}

/**
 * Renders an accepted proposal into a concrete artifact — to stdout.
 *
 * Nothing is written to disk. Accepting a pattern and letting a tool edit the
 * files that steer future work are separate decisions, and the second one
 * stays with the user.
 */
export function cmdRender(ctx: CliContext, id: string, args: RenderArgs): number {
  const proposal = resolveProposal(ctx.db, id);
  if (!proposal) {
    process.stderr.write(`No proposal matching "${id}".\n`);
    return 1;
  }

  const renderer = rendererFor(proposal.domain);

  if (args.list) {
    const targets = renderer.targets();
    emit({ domain: proposal.domain, renderer: renderer.domain, targets }, ctx.json, () =>
      [heading(`Targets for ${proposal.domain}`), ...targets.map((t) => `  ${t}`)].join("\n"),
    );
    return 0;
  }

  if (proposal.status !== "accepted") {
    process.stderr.write(
      `Proposal ${proposal.id} is "${proposal.status}". Accept it first:\n` +
        `  decision-logger accept ${proposal.id}\n`,
    );
    return 1;
  }

  const target = args.target ?? renderer.targets()[0]!;
  if (!renderer.targets().includes(target)) {
    process.stderr.write(
      `Unknown target "${target}". Available: ${renderer.targets().join(", ")}\n`,
    );
    return 1;
  }

  const artifact = renderer.render({
    proposal,
    evidence: evidenceOf(ctx, proposal),
    target,
  });

  emit(artifact, ctx.json, () => {
    const header = [
      `# target: ${artifact.target}`,
      `# suggested: ${artifact.suggestedPath ?? "(none)"} (${artifact.mode})`,
      "# nothing was written — copy what you want, or redirect this output",
      "",
    ].join("\n");
    return header + artifact.content;
  });
  return 0;
}
