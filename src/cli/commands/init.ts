import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";
import type { CliContext } from "../context.ts";
import { emit, heading } from "../format.ts";

export type InitTarget = "claude-code" | "cursor" | "codex";

export interface InitArgs {
  target?: InitTarget;
  /** Write the configuration instead of only printing it. */
  apply?: boolean;
  /** Install into the project rather than the user profile. */
  project?: boolean;
}

/**
 * Wires an environment's hooks up to this CLI.
 *
 * By default it prints exactly what it would add and changes nothing —
 * editing a user's agent configuration is not something a tool should do on
 * the strength of having been installed. `--apply` writes it, after backing up
 * the file it touches.
 *
 * The hook commands use an absolute node path and an absolute entry path,
 * because hooks run in a non-interactive shell where a version-manager `node`
 * is usually not on PATH. Codex additionally binds trust to the exact command
 * string, so these must stay stable across upgrades.
 */
export function cmdInit(ctx: CliContext, args: InitArgs): number {
  const target = args.target ?? "claude-code";
  const entry = cliEntryPath();
  const command = `${quote(execPath)} ${quote(entry)}`;

  switch (target) {
    case "claude-code":
      return initClaudeCode(ctx, args, command);
    case "cursor":
      return initCursor(ctx, args, command);
    case "codex":
      return initCodex(ctx, args, command);
  }
}

/** Absolute path to bin/decision-logger.js, resolved from this module. */
export function cliEntryPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/cli/commands/init.ts → ../../../bin, dist/cli/commands/init.js → ../../../bin
  return resolve(here, "..", "..", "..", "bin", "decision-logger.js");
}

function quote(path: string): string {
  return /[\s"']/.test(path) ? `"${path}"` : path;
}

/* ------------------------------------------------------------------ */
/* Claude Code                                                         */
/* ------------------------------------------------------------------ */

function claudeCodeHooks(command: string): Record<string, unknown> {
  return {
    SessionStart: [
      {
        hooks: [
          {
            type: "command",
            // Prints nothing unless a review is due; stdout becomes session context.
            command: `${command} remind --format hook`,
            timeout: 10,
          },
        ],
      },
    ],
    Stop: [
      {
        hooks: [
          {
            type: "command",
            // Per-turn incremental ingestion. Detached so the turn never waits.
            command: `${command} ingest --hook --detach`,
            timeout: 10,
          },
        ],
      },
    ],
    SessionEnd: [
      {
        hooks: [
          {
            type: "command",
            // Best-effort finalize: SessionEnd has a short budget and may not fire at all.
            command: `${command} ingest --hook --detach`,
            timeout: 10,
          },
        ],
      },
    ],
  };
}

function initClaudeCode(ctx: CliContext, args: InitArgs, command: string): number {
  const path = args.project
    ? join(ctx.workspace.root ?? ctx.cwd, ".claude", "settings.json")
    : join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "settings.json");

  const hooks = claudeCodeHooks(command);
  return applyHooks(ctx, args, {
    label: "Claude Code",
    path,
    patch: { hooks },
    notes: [
      "Claude Code merges hooks from every settings scope, so this does not replace your existing hooks.",
      "Cursor also imports Claude Code hooks from .claude/settings.json, so this covers Cursor too.",
      "For slash commands and a guided setup, install the plugin instead: /plugin marketplace add togishima/decision-logger",
    ],
  });
}

/* ------------------------------------------------------------------ */
/* Cursor                                                              */
/* ------------------------------------------------------------------ */

function initCursor(ctx: CliContext, args: InitArgs, command: string): number {
  const path = args.project
    ? join(ctx.workspace.root ?? ctx.cwd, ".cursor", "hooks.json")
    : join(homedir(), ".cursor", "hooks.json");

  return applyHooks(ctx, args, {
    label: "Cursor",
    path,
    patch: {
      version: 1,
      hooks: {
        sessionStart: [{ command: `${command} remind --format json`, timeout: 10 }],
        stop: [{ command: `${command} ingest --hook --detach`, timeout: 10 }],
        sessionEnd: [{ command: `${command} ingest --hook --detach`, timeout: 10 }],
      },
    },
    notes: [
      "Cursor already imports Claude Code hooks from .claude/settings.json; use native hooks only if you disabled that.",
      "sessionEnd does not fire for cloud agents — stop is the trigger that always runs.",
      "transcript_path is null when Cursor transcripts are disabled; ingestion then finds nothing.",
    ],
  });
}

/* ------------------------------------------------------------------ */
/* Codex                                                               */
/* ------------------------------------------------------------------ */

function initCodex(ctx: CliContext, args: InitArgs, command: string): number {
  const home = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const path = args.project
    ? join(ctx.workspace.root ?? ctx.cwd, ".codex", "hooks.json")
    : join(home, "hooks.json");

  return applyHooks(ctx, args, {
    label: "Codex",
    path,
    patch: {
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: `${command} ingest --hook --detach`, timeout: 3 }] }],
        SessionEnd: [
          {
            matcher: "other",
            hooks: [{ type: "command", command: `${command} ingest --hook --detach`, timeout: 3 }],
          },
        ],
      },
    },
    notes: [
      "Codex will NOT run these until you review and trust them once: run /hooks inside Codex.",
      "Trust is bound to a hash of the exact command string — re-trust is needed if the path changes.",
      "SessionEnd allows 1–3 seconds and can be delayed up to 30 idle minutes, so Stop does the real work.",
    ],
  });
}

/* ------------------------------------------------------------------ */
/* Shared                                                              */
/* ------------------------------------------------------------------ */

interface ApplyPlan {
  label: string;
  path: string;
  patch: Record<string, unknown>;
  notes: string[];
}

function applyHooks(ctx: CliContext, args: InitArgs, plan: ApplyPlan): number {
  const existing = readJsonFile(plan.path);
  const merged = mergeDeep(existing ?? {}, plan.patch);

  if (!args.apply) {
    emit({ ...plan, apply: false, existingFile: existing !== undefined }, ctx.json, () =>
      [
        heading(`${plan.label} integration`),
        `  file: ${plan.path}${existing ? " (exists)" : " (would be created)"}`,
        "",
        "Add this:",
        "",
        indent(JSON.stringify(plan.patch, null, 2), 2),
        "",
        ...plan.notes.map((n) => `  · ${n}`),
        "",
        `Nothing was written. Re-run with --apply to write it (a .bak copy is kept).`,
      ].join("\n"),
    );
    return 0;
  }

  mkdirSync(dirname(plan.path), { recursive: true });
  if (existsSync(plan.path)) copyFileSync(plan.path, `${plan.path}.bak`);
  writeFileSync(plan.path, `${JSON.stringify(merged, null, 2)}\n`, "utf8");

  emit({ ...plan, apply: true, written: plan.path }, ctx.json, () =>
    [
      heading(`${plan.label} integration installed`),
      `  wrote ${plan.path}`,
      existsSync(`${plan.path}.bak`) ? `  backup ${plan.path}.bak` : "",
      "",
      ...plan.notes.map((n) => `  · ${n}`),
      "",
      "  Verify with: decision-logger doctor",
    ]
      .filter(Boolean)
      .join("\n"),
  );
  return 0;
}

function readJsonFile(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new Error(`${path} is not valid JSON; fix it before running init --apply`);
  }
}

/**
 * Merges the hook patch into existing config. Arrays are concatenated with
 * duplicate commands removed, so re-running `init --apply` is idempotent and
 * never clobbers hooks the user added themselves.
 */
function mergeDeep(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = out[key];
    if (Array.isArray(value)) {
      const combined = [...(Array.isArray(current) ? current : []), ...value];
      out[key] = dedupeBySignature(combined);
    } else if (isRecord(value)) {
      out[key] = mergeDeep(isRecord(current) ? current : {}, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function dedupeBySignature(items: unknown[]): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const item of items) {
    const key = JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function indent(text: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return text
    .split("\n")
    .map((l) => prefix + l)
    .join("\n");
}
