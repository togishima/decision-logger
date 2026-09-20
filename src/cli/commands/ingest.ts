import { readFileSync } from "node:fs";
import type { CliContext } from "../context.ts";
import type { CollectInput } from "../../adapters/adapter.ts";
import { selectAdapter, adapterByName } from "../../adapters/registry.ts";
import { parseSessionDocument } from "../../adapters/generic.ts";
import { ingestSession } from "../../core/ingestion/pipeline.ts";
import type { IngestOutcome } from "../../core/ingestion/pipeline.ts";
import { getIngestionRecord } from "../../core/storage/workspace-repo.ts";
import { isReentrantInvocation } from "../../core/config.ts";
import {
  evaluateReminder,
  recordNotification,
} from "../../core/review/reminder.ts";
import { emit, heading, truncate } from "../format.ts";

export interface IngestArgs {
  adapter?: string;
  sessionId?: string;
  transcriptPath?: string;
  file?: string;
  stdin?: boolean;
  catchUp?: boolean;
  limit?: number;
  since?: string;
  force?: boolean;
  dryRun?: boolean;
}

/**
 * Ingestion entry point for every environment.
 *
 * Hooks call this; so does `--catch-up`; so does a manual `--file`. All three
 * converge on the same core pipeline, which is what keeps adapter code free of
 * analysis logic.
 */
export async function cmdIngest(ctx: CliContext, args: IngestArgs): Promise<number> {
  // A nested `claude -p` inside the analyzer fires the same hooks that called
  // us. Without this guard, ingestion would recurse.
  if (isReentrantInvocation()) {
    emit({ skipped: "reentrant" }, ctx.json, () => "Skipped: running inside an analyzer subprocess.");
    return 0;
  }

  const results: (IngestOutcome & { sessionId: string; source: string })[] = [];

  if (args.stdin || args.file) {
    const raw = args.file ? readFileSync(args.file, "utf8") : readFileSync(0, "utf8");
    const ref = {
      source: args.adapter ?? "generic",
      sessionId: args.sessionId ?? `manual-${Date.now()}`,
      cwd: ctx.cwd,
    };
    const session = parseSessionDocument(raw, ref, {
      workspaceId: ctx.config.workspaceId,
      workspaceLabel: ctx.config.workspaceLabel,
    });
    if (!session) {
      process.stderr.write("Could not read a work session from the input.\n");
      return 1;
    }
    const outcome = await ingestSession({
      db: ctx.db,
      config: ctx.config,
      profile: ctx.profile,
      analyzer: await ctx.analyzer(),
      session,
      force: args.force,
      dryRun: args.dryRun,
    });
    results.push({ ...outcome, sessionId: session.sessionId, source: session.source });
    return report(ctx, results, args);
  }

  const input: CollectInput = {
    cwd: ctx.cwd,
    sessionId: args.sessionId,
    transcriptPath: args.transcriptPath,
    catchUp: args.catchUp,
    since: args.since,
    limit: args.limit,
  };

  const adapter = args.adapter
    ? adapterByName(args.adapter)
    : selectAdapter(input, ctx.config.enabledAdapters);

  if (!adapter) {
    process.stderr.write(
      `No adapter can handle this input. Try --adapter <name> or --file <path>.\n`,
    );
    return 1;
  }

  const refs = await adapter.collectSession(input);
  if (!refs.length) {
    emit({ sessions: 0 }, ctx.json, () => "No sessions found to ingest.");
    return 0;
  }

  for (const ref of refs) {
    const previous = getIngestionRecord(ctx.db, ref.source, ref.sessionId);
    const session = await adapter.normalizeSession(ref, {
      fromCursor: previous?.cursor ?? 0,
      workspaceId: ctx.config.workspaceId,
      workspaceLabel: ctx.config.workspaceLabel,
    });
    if (!session) continue;

    const outcome = await ingestSession({
      db: ctx.db,
      config: ctx.config,
      profile: ctx.profile,
      analyzer: await ctx.analyzer(),
      session,
      force: args.force,
      dryRun: args.dryRun,
    });
    results.push({ ...outcome, sessionId: session.sessionId, source: session.source });
  }

  return report(ctx, results, args);
}

function report(
  ctx: CliContext,
  results: (IngestOutcome & { sessionId: string; source: string })[],
  args: IngestArgs,
): number {
  const inserted = results.flatMap((r) => r.inserted);
  const errors = results.filter((r) => r.error);

  emit({ results, insertedCount: inserted.length }, ctx.json, () => {
    if (!results.length) return "Nothing to ingest.";
    const lines: string[] = [];

    for (const r of results) {
      if (r.skippedReason) {
        if (ctx.verbose) lines.push(`skipped ${r.source}/${r.sessionId.slice(0, 8)}: ${r.skippedReason}`);
        continue;
      }
      if (r.error) {
        lines.push(`error   ${r.source}/${r.sessionId.slice(0, 8)}: ${r.error}`);
        continue;
      }
      const parts = [`${r.inserted.length} new`];
      if (r.duplicates) parts.push(`${r.duplicates} duplicate`);
      if (r.refinements) parts.push(`${r.refinements} refinement`);
      if (r.supersessions) parts.push(`${r.supersessions} superseding`);
      if (r.contradictions) parts.push(`${r.contradictions} contradicting`);
      lines.push(`${args.dryRun ? "would add" : "ingested"} ${r.source}/${r.sessionId.slice(0, 8)}: ${parts.join(", ")}`);

      for (const d of r.inserted) lines.push(`    + ${d.id}  ${truncate(d.subject, 60)}`);
      if (ctx.verbose) for (const reason of r.dropped) lines.push(`    - dropped: ${reason}`);
    }

    if (!lines.length) return "Nothing new to record.";
    return lines.join("\n");
  });

  return errors.length && !inserted.length ? 1 : 0;
}

/* ------------------------------------------------------------------ */
/* Reminder                                                            */
/* ------------------------------------------------------------------ */

export type RemindFormat = "text" | "hook" | "json";

export interface RemindArgs {
  format?: RemindFormat;
  sessionId?: string;
  /** Evaluate without recording that a reminder was shown. */
  peek?: boolean;
}

/**
 * Non-blocking review reminder, designed to be called from a SessionStart
 * hook. Silence is the normal outcome and always exits 0 — a reminder must
 * never be able to interrupt or fail a session.
 */
export function cmdRemind(ctx: CliContext, args: RemindArgs): number {
  if (isReentrantInvocation()) return 0;

  const decision = evaluateReminder(ctx.db, ctx.config.notifications, {
    workspaceId: ctx.workspace.id,
    sessionId: args.sessionId,
  });

  const format = args.format ?? "text";

  if (!decision.notify) {
    if (format === "json") {
      process.stdout.write(`${JSON.stringify({ notify: false, reason: decision.reason, state: decision.state })}\n`);
    } else if (ctx.verbose) {
      process.stderr.write(`No reminder: ${decision.reason}\n`);
    }
    return 0;
  }

  if (!args.peek) recordNotification(ctx.db, args.sessionId);

  if (format === "json") {
    process.stdout.write(`${JSON.stringify({ notify: true, message: decision.message, state: decision.state })}\n`);
    return 0;
  }

  if (format === "hook") {
    // SessionStart adds stdout to the session context on exit 0. The explicit
    // hookSpecificOutput form is used so the intent is visible in the payload.
    process.stdout.write(
      `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: `[decision-logger] ${decision.message}`,
        },
        suppressOutput: true,
      })}\n`,
    );
    return 0;
  }

  process.stdout.write(`${heading("decision-logger")}\n${decision.message}\n`);
  return 0;
}
