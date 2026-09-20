import { existsSync } from "node:fs";
import { execPath } from "node:process";
import type { CliContext } from "../context.ts";
import { probeAnalyzers } from "../../core/analysis/factory.ts";
import { which } from "../../core/analysis/run-process.ts";
import { allAdapters } from "../../adapters/registry.ts";
import { loadProfiles } from "../../core/domains/profile.ts";
import { promptPath } from "../../core/analysis/prompts.ts";
import { schemaVersion } from "../../core/storage/db.ts";
import { userConfigPath, workspaceConfigPath } from "../../core/paths.ts";
import { emit, heading, pad } from "../format.ts";

interface Check {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

/**
 * `doctor` answers one question: will automatic capture actually work here?
 *
 * The failure modes worth surfacing are environmental, not logical — a hook
 * shell without `node` on PATH, no analyzer available, a transcript directory
 * that does not exist. Each one makes the tool silently record nothing, which
 * is the worst way for it to fail.
 */
export async function cmdDoctor(ctx: CliContext): Promise<number> {
  const checks: Check[] = [];

  checks.push({
    name: "node",
    status: "ok",
    detail: `${process.version} at ${execPath}`,
  });

  // nvm/mise/asdf keep node out of a hook's non-interactive PATH, so hooks
  // must call it by absolute path. `init` bakes that in; this explains why.
  const nodeOnPath = which("node");
  checks.push({
    name: "node on PATH",
    status: nodeOnPath ? "ok" : "warn",
    detail: nodeOnPath
      ? nodeOnPath
      : "not resolvable by name — hooks must invoke node by absolute path (init does this)",
  });

  checks.push({
    name: "database",
    status: "ok",
    detail: `${ctx.config.databasePath} (schema v${schemaVersion(ctx.db)})`,
  });

  const userCfg = userConfigPath();
  const wsCfg = ctx.workspace.root ? workspaceConfigPath(ctx.workspace.root) : undefined;
  checks.push({
    name: "config",
    status: "ok",
    detail:
      [existsSync(userCfg) ? userCfg : undefined, wsCfg && existsSync(wsCfg) ? wsCfg : undefined]
        .filter(Boolean)
        .join(", ") || "defaults only (no config file needed)",
  });

  checks.push({
    name: "workspace",
    status: "ok",
    detail: `${ctx.workspace.label} — ${ctx.workspace.id} (${ctx.workspace.basis})`,
  });

  const { profiles, errors } = loadProfiles();
  checks.push({
    name: "domain profiles",
    status: errors.length ? "warn" : profiles.has(ctx.config.domain) ? "ok" : "fail",
    detail: errors.length
      ? errors.join("; ")
      : `${profiles.size} loaded, active "${ctx.config.domain}"`,
  });

  for (const name of ["extract-decisions", "distill-patterns"] as const) {
    const path = promptPath(name);
    checks.push({
      name: `prompt: ${name}`,
      status: existsSync(path) ? "ok" : "fail",
      detail: path,
    });
  }

  const analyzers = await probeAnalyzers(ctx.config);
  const usable = analyzers.filter((a) => a.available && a.name !== "heuristic");
  const active = await ctx.analyzer();
  checks.push({
    name: "analyzer",
    status: usable.length ? "ok" : "warn",
    detail: usable.length
      ? `active "${active.name}"; available: ${analyzers.filter((a) => a.available).map((a) => a.name).join(", ")}`
      : 'no model-backed analyzer found — install the Claude Code or Codex CLI, or set ANTHROPIC_API_KEY. ' +
        'Offline keyword extraction is available with `"analyzer": "heuristic"` but misses most decisions.',
  });

  const adapters = allAdapters().map((a) => ({
    ...a.describe(),
    detected: a.canHandle({ cwd: ctx.cwd }),
  }));

  const worst = checks.some((c) => c.status === "fail")
    ? "fail"
    : checks.some((c) => c.status === "warn")
      ? "warn"
      : "ok";

  emit({ checks, adapters, overall: worst }, ctx.json, () => {
    const lines = [heading("Checks")];
    for (const c of checks) {
      const mark = c.status === "ok" ? "✓" : c.status === "warn" ? "!" : "✗";
      lines.push(`  ${mark} ${pad(c.name, 22)} ${c.detail}`);
    }

    lines.push(heading("Adapters"));
    for (const a of adapters) {
      lines.push(
        `  ${a.detected ? "✓" : "·"} ${pad(a.name, 14)} ${pad(a.automaticIngestion, 22)} transcript: ${a.transcriptStability}`,
      );
      if (ctx.verbose) for (const note of a.notes) lines.push(`      ${note}`);
    }
    if (!ctx.verbose) lines.push("", "  Run with --verbose for per-adapter caveats.");

    lines.push(
      "",
      worst === "fail"
        ? "Something is broken above; decisions will not be recorded."
        : worst === "warn"
          ? "Usable, but see the warnings above."
          : "Everything checks out.",
    );
    return lines.join("\n");
  });

  return worst === "fail" ? 1 : 0;
}
