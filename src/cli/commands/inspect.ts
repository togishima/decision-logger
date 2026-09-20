import type { CliContext } from "../context.ts";
import type { DecisionStatus } from "../../core/model/decision.ts";
import {
  listDecisions,
  searchDecisions,
  resolveDecision,
  getRelations,
  countUnreviewed,
  distinctCategories,
} from "../../core/storage/decisions-repo.ts";
import { listProposals } from "../../core/storage/proposals-repo.ts";
import { listWorkspaces, listIngestions } from "../../core/storage/workspace-repo.ts";
import { readState, lastDistilledAt } from "../../core/review/reminder.ts";
import { loadProfiles } from "../../core/domains/profile.ts";
import { emit, decisionLine, decisionDetail, heading, pad, truncate } from "../format.ts";
import { schemaVersion } from "../../core/storage/db.ts";

export interface ListArgs {
  /** `recent`, a status name, or a category. */
  filter?: string;
  limit?: number;
  allWorkspaces?: boolean;
  category?: string;
}

const STATUSES = new Set(["active", "superseded", "reverted", "expired", "experimental"]);

export function cmdList(ctx: CliContext, args: ListArgs): void {
  const workspaceId = args.allWorkspaces ? undefined : ctx.workspace.id;
  const limit = args.limit ?? 20;

  let status: DecisionStatus | "any" = "any";
  let category = args.category;
  const filter = args.filter?.toLowerCase();

  if (filter && STATUSES.has(filter)) status = filter as DecisionStatus;
  else if (filter === "rejected") category = "rejection";
  else if (filter && filter !== "recent" && filter !== "all") category = filter;

  const decisions = listDecisions(ctx.db, { workspaceId, status, category, limit });

  emit({ decisions, count: decisions.length }, ctx.json, () => {
    if (!decisions.length) return "No decisions recorded yet.";
    const scope = args.allWorkspaces ? "all workspaces" : ctx.workspace.label;
    return [
      heading(`${decisions.length} decision(s) — ${scope}`),
      ...decisions.map(decisionLine),
      "",
      `Use \`decision-logger show <id>\` for details.`,
    ].join("\n");
  });
}

export function cmdShow(ctx: CliContext, id: string): number {
  const decision = resolveDecision(ctx.db, id);
  if (!decision) {
    process.stderr.write(`No decision matching "${id}".\n`);
    return 1;
  }
  const relations = getRelations(ctx.db, decision.id).map((r) =>
    r.fromDecisionId === decision.id
      ? `${r.relationType} → ${r.toDecisionId}`
      : `${r.toDecisionId} ${r.relationType} → this`,
  );
  emit({ decision, relations }, ctx.json, () => decisionDetail(decision, relations));
  return 0;
}

export function cmdSearch(ctx: CliContext, query: string, limit = 20): void {
  const decisions = searchDecisions(ctx.db, query, { limit });
  emit({ query, decisions, count: decisions.length }, ctx.json, () => {
    if (!decisions.length) return `Nothing matched "${query}".`;
    return [heading(`${decisions.length} match(es) for "${query}"`), ...decisions.map(decisionLine)].join("\n");
  });
}

export function cmdStatus(ctx: CliContext): void {
  const workspaceId = ctx.workspace.id;
  const state = readState(ctx.db, workspaceId);
  const total = listDecisions(ctx.db, { workspaceId, status: "any" }).length;
  const globalTotal = listDecisions(ctx.db, { status: "any" }).length;
  const candidates = listProposals(ctx.db, { status: "candidate" });
  const accepted = listProposals(ctx.db, { status: "accepted" });
  const rejected = listProposals(ctx.db, { status: "rejected" });
  const deferred = listProposals(ctx.db, { status: "deferred" });

  const payload = {
    workspace: {
      id: workspaceId,
      label: ctx.workspace.label,
      basis: ctx.workspace.basis,
      root: ctx.workspace.root,
    },
    domain: ctx.config.domain,
    database: ctx.config.databasePath,
    schemaVersion: schemaVersion(ctx.db),
    decisions: { workspace: total, global: globalTotal, unreviewed: state.unreviewed },
    proposals: {
      candidate: candidates.length,
      accepted: accepted.length,
      rejected: rejected.length,
      deferred: deferred.length,
    },
    lastDistilledAt: lastDistilledAt(ctx.db) ?? null,
    notificationThreshold: ctx.config.notifications.unreviewedThreshold,
  };

  emit(payload, ctx.json, () => {
    const lines = [
      heading("decision-logger"),
      `  workspace     ${ctx.workspace.label}  (${ctx.workspace.basis})`,
      `  domain        ${ctx.config.domain}`,
      `  database      ${ctx.config.databasePath}`,
      "",
      `  decisions     ${total} here, ${globalTotal} across all workspaces`,
      `  unreviewed    ${state.unreviewed} / ${ctx.config.notifications.unreviewedThreshold} before a reminder`,
      `  last distill  ${payload.lastDistilledAt ?? "never"}`,
      "",
      `  proposals     ${candidates.length} candidate, ${accepted.length} accepted, ` +
        `${rejected.length} rejected, ${deferred.length} deferred`,
    ];
    if (candidates.length) lines.push("", "  Run `decision-logger distill` to review.");
    return lines.join("\n");
  });
}

export function cmdProfiles(ctx: CliContext): void {
  const { profiles, errors } = loadProfiles();
  const payload = {
    active: ctx.config.domain,
    profiles: [...profiles.values()].map((p) => ({
      domain: p.domain,
      label: p.label,
      categories: p.categories,
      outputTargets: p.outputTargets?.map((t) => t.id) ?? [],
    })),
    errors,
  };

  emit(payload, ctx.json, () => {
    const lines = [heading("Domain profiles")];
    for (const p of profiles.values()) {
      const mark = p.domain === ctx.config.domain ? "*" : " ";
      lines.push(`${mark} ${pad(p.domain, 24)} ${p.categories.length} categories`);
      lines.push(`    ${truncate(p.categories.join(", "), 70)}`);
    }
    if (errors.length) lines.push("", "Problems:", ...errors.map((e) => `  ! ${e}`));
    const categoriesInUse = distinctCategories(ctx.db);
    if (categoriesInUse.length) {
      lines.push("", `Categories in the store: ${categoriesInUse.join(", ")}`);
    }
    return lines.join("\n");
  });
}

export function cmdWorkspaces(ctx: CliContext): void {
  const workspaces = listWorkspaces(ctx.db);
  const ingestions = listIngestions(ctx.db, 10);
  emit({ workspaces, recentIngestions: ingestions }, ctx.json, () => {
    const lines = [heading(`${workspaces.length} workspace(s)`)];
    for (const w of workspaces) {
      const n = countUnreviewed(ctx.db, w.id);
      lines.push(`  ${pad(w.id, 16)} ${pad(w.label ?? "", 36)} ${n} unreviewed`);
    }
    if (ingestions.length) {
      lines.push(heading("Recent ingestions"));
      for (const i of ingestions) {
        lines.push(
          `  ${pad(i.source, 14)} ${i.sourceSessionId.slice(0, 12)}  ` +
            `${i.decisionsFound} decision(s) over ${i.runs} run(s)  ${i.lastIngestedAt.slice(0, 19)}`,
        );
      }
    }
    return lines.join("\n");
  });
}
