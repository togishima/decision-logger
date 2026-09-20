import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { execPath } from "node:process";
import { createContext } from "./context.ts";
import type { ContextOptions } from "./context.ts";
import { cmdList, cmdShow, cmdSearch, cmdStatus, cmdProfiles, cmdWorkspaces } from "./commands/inspect.ts";
import { cmdIngest, cmdRemind } from "./commands/ingest.ts";
import type { RemindFormat } from "./commands/ingest.ts";
import {
  cmdDistill,
  cmdProposals,
  cmdShowProposal,
  cmdReview,
  cmdRender,
} from "./commands/review.ts";
import { cmdDoctor } from "./commands/doctor.ts";
import {
  cmdConfigList,
  cmdConfigGet,
  cmdConfigSet,
  cmdConfigUnset,
  cmdConfigPath,
} from "./commands/config.ts";
import type { ConfigScope } from "./commands/config.ts";
import { cmdInit, cliEntryPath } from "./commands/init.ts";
import type { InitTarget } from "./commands/init.ts";

const USAGE = `decision-logger — remembers the meaningful decisions you make while working with AI,
then distils them into reusable principles, procedures, and operations.

Usage: decision-logger <command> [options]

Inspect
  status                     Where things stand in this workspace
  list [recent|<category>]   Recorded decisions
  show <id>                  One decision, with relations and alternatives
  search <query>             Full-text search across decisions
  workspaces                 Every workspace seen, and recent ingestions
  profiles                   Available domain profiles

Capture
  ingest [options]           Read sessions and record decisions
    --hook                     Read a hook payload (JSON) from stdin
    --detach                   Fork and exit immediately (for hooks)
    --catch-up                 Scan for sessions not yet ingested
    --file <path>              A session document or JSONL transcript
    --stdin                    Read that document from stdin
    --adapter <name>           claude-code | cursor | codex | generic
    --session <id>             Session id
    --transcript <path>        Transcript path
    --force                    Analyze even when the gate would decline
    --dry-run                  Report what would be recorded, write nothing
  remind [--format text|hook|json] [--session <id>]
                             Non-blocking review reminder

Review
  distill [--all-workspaces] [--dry-run] [--max <n>]
                             Find reusable patterns in accumulated decisions
  proposals [--status open|candidate|accepted|rejected|deferred|all]
  show-proposal <id>         A proposal with its full provenance
  accept <id>
  reject <id> [--reason too_specific|already_known|not_actionable|…]
  defer  <id> [--days <n> | --until <iso-date>]
  reopen <id>
  render <id> [--target <name>] [--list]
                             Render an accepted proposal to stdout

Setup
  config list                Every setting, and which are changed from default
  config get <key>
  config set <key> <value>   e.g. config set notifications.unreviewedThreshold 10
  config unset <key>
  config path                Where the config file lives
    --project                  Apply to this workspace instead of your user profile
  init [--target claude-code|cursor|codex] [--apply] [--project]
  doctor                     Check that automatic capture will actually work

Global options
  --json                     Machine-readable output
  --verbose                  Show dropped candidates and per-adapter caveats
  --domain <name>            Override the active domain profile
  --db <path>                Override the database path
  --workspace <id>           Override workspace identity
  --config <path>            Use a specific config file
  --analyzer <name>          auto | claude-cli | codex-cli | anthropic-api | heuristic | none
  --cwd <path>               Treat this directory as the working directory
  -h, --help                 This text
  -v, --version
`;

const OPTIONS = {
  json: { type: "boolean" },
  verbose: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  domain: { type: "string" },
  db: { type: "string" },
  workspace: { type: "string" },
  config: { type: "string" },
  analyzer: { type: "string" },
  cwd: { type: "string" },

  hook: { type: "boolean" },
  detach: { type: "boolean" },
  "catch-up": { type: "boolean" },
  file: { type: "string" },
  stdin: { type: "boolean" },
  adapter: { type: "string" },
  session: { type: "string" },
  transcript: { type: "string" },
  force: { type: "boolean" },
  "dry-run": { type: "boolean" },
  since: { type: "string" },
  limit: { type: "string" },

  format: { type: "string" },
  peek: { type: "boolean" },

  "all-workspaces": { type: "boolean" },
  max: { type: "string" },
  status: { type: "string" },
  reason: { type: "string" },
  days: { type: "string" },
  until: { type: "string" },
  target: { type: "string" },
  list: { type: "boolean" },
  category: { type: "string" },

  apply: { type: "boolean" },
  project: { type: "boolean" },
} as const;

export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\nTry --help.\n`);
    return 2;
  }

  const { values: flags, positionals } = parsed;
  const command = positionals[0];

  if (flags.version) {
    process.stdout.write(`${readVersion()}\n`);
    return 0;
  }
  if (flags.help || !command) {
    process.stdout.write(USAGE);
    return command ? 0 : flags.help ? 0 : 1;
  }

  // Hook payloads arrive on stdin. Reading them before building a context
  // keeps the adapter boundary honest: the hook shape is an environment
  // detail, and only these few fields cross into the core.
  // Read it once: stdin cannot be consumed twice, and a detached re-run needs
  // the same bytes handed to the child.
  const hookRaw = flags.hook ? safeReadStdin() : "";
  const hookPayload: HookPayload = flags.hook ? parseHookPayload(hookRaw) : {};

  if (flags.detach) return detach(argv, hookRaw);

  const contextOptions: ContextOptions = {
    cwd: flags.cwd ?? hookPayload.cwd,
    json: flags.json,
    verbose: flags.verbose,
    domain: flags.domain,
    databasePath: flags.db,
    workspaceId: flags.workspace,
    configPath: flags.config,
    analyzerName: flags.analyzer,
  };

  let ctx;
  try {
    ctx = createContext(contextOptions);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }

  const num = (v: string | undefined): number | undefined =>
    v === undefined ? undefined : Number.parseInt(v, 10);

  try {
    switch (command) {
      case "status":
        cmdStatus(ctx);
        return 0;

      case "list":
      case "decisions":
        cmdList(ctx, {
          filter: positionals[1],
          limit: num(flags.limit),
          allWorkspaces: flags["all-workspaces"],
          category: flags.category,
        });
        return 0;

      case "show":
        return requireArg(positionals[1], "show <id>") ?? cmdShow(ctx, positionals[1]!);

      case "search":
        return (
          requireArg(positionals.slice(1).join(" ") || undefined, "search <query>") ??
          (cmdSearch(ctx, positionals.slice(1).join(" "), num(flags.limit)), 0)
        );

      case "workspaces":
        cmdWorkspaces(ctx);
        return 0;

      case "profiles":
        cmdProfiles(ctx);
        return 0;

      case "ingest":
        return await cmdIngest(ctx, {
          adapter: flags.adapter,
          sessionId: flags.session ?? hookPayload.session_id,
          transcriptPath: flags.transcript ?? hookPayload.transcript_path,
          file: flags.file,
          stdin: flags.stdin,
          catchUp: flags["catch-up"],
          limit: num(flags.limit),
          since: flags.since,
          force: flags.force,
          dryRun: flags["dry-run"],
        });

      case "remind":
        return cmdRemind(ctx, {
          format: (flags.format as RemindFormat) ?? "text",
          sessionId: flags.session ?? hookPayload.session_id,
          peek: flags.peek,
        });

      case "distill":
        return await cmdDistill(ctx, {
          allWorkspaces: flags["all-workspaces"],
          dryRun: flags["dry-run"],
          max: num(flags.max),
        });

      case "proposals":
        cmdProposals(ctx, { status: flags.status, limit: num(flags.limit) });
        return 0;

      case "show-proposal":
        return requireArg(positionals[1], "show-proposal <id>") ?? cmdShowProposal(ctx, positionals[1]!);

      case "accept":
      case "reject":
      case "defer":
      case "reopen":
        return (
          requireArg(positionals[1], `${command} <id>`) ??
          cmdReview(ctx, command, positionals[1]!, {
            reason: flags.reason,
            days: num(flags.days),
            until: flags.until,
          })
        );

      case "render":
        return (
          requireArg(positionals[1], "render <id>") ??
          cmdRender(ctx, positionals[1]!, { target: flags.target, list: flags.list })
        );

      case "init":
        return cmdInit(ctx, {
          target: (flags.target as InitTarget) ?? "claude-code",
          apply: flags.apply,
          project: flags.project,
        });

      case "config": {
        const scope: ConfigScope = flags.project ? "project" : "user";
        const action = positionals[1] ?? "list";
        switch (action) {
          case "list":
            return cmdConfigList(ctx, { scope });
          case "get":
            return requireArg(positionals[2], "config get <key>") ?? cmdConfigGet(ctx, positionals[2]!);
          case "set":
            return (
              requireArg(positionals[2], "config set <key> <value>") ??
              requireArg(positionals[3], "config set <key> <value>") ??
              cmdConfigSet(ctx, positionals[2]!, positionals.slice(3).join(" "), { scope })
            );
          case "unset":
            return (
              requireArg(positionals[2], "config unset <key>") ??
              cmdConfigUnset(ctx, positionals[2]!, { scope })
            );
          case "path":
            return cmdConfigPath(ctx, { scope });
          default:
            process.stderr.write(`Unknown config action "${action}". Try list, get, set, unset, path.\n`);
            return 2;
        }
      }

      case "doctor":
        return await cmdDoctor(ctx);

      default:
        process.stderr.write(`Unknown command "${command}".\n\n${USAGE}`);
        return 2;
    }
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    if (ctx.verbose) process.stderr.write(`${(err as Error).stack}\n`);
    return 1;
  } finally {
    ctx.db.close();
  }
}

function requireArg(value: string | undefined, usage: string): number | undefined {
  if (value) return undefined;
  process.stderr.write(`Usage: decision-logger ${usage}\n`);
  return 2;
}

interface HookPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  /** Cursor uses conversation_id and workspace_roots. */
  conversation_id?: string;
  workspace_roots?: string[];
}

/**
 * Reads a hook payload from stdin, tolerating every variation across the three
 * environments — and tolerating no payload at all, because a hook that fails
 * must never take the user's session down with it.
 */
function parseHookPayload(raw: string): HookPayload {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as HookPayload;
    return {
      session_id: parsed.session_id ?? parsed.conversation_id,
      transcript_path: parsed.transcript_path ?? process.env.CURSOR_TRANSCRIPT_PATH,
      cwd: parsed.cwd ?? parsed.workspace_roots?.[0] ?? process.env.CLAUDE_PROJECT_DIR,
      hook_event_name: parsed.hook_event_name,
    };
  } catch {
    return {};
  }
}

/**
 * Re-runs this command detached and returns immediately.
 *
 * Every environment gives session hooks a budget between 1 and 10 seconds,
 * while extraction takes a model call. Blocking a turn to record a decision
 * would violate the one rule the product has: never interrupt the work.
 */
function detach(argv: string[], stdin: string): number {
  const args = [cliEntryPath(), ...argv.filter((a) => a !== "--detach")];

  const child = spawn(execPath, args, {
    detached: true,
    stdio: ["pipe", "ignore", "ignore"],
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  child.stdin?.end(stdin);
  child.unref();
  return 0;
}

function safeReadStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function readVersion(): string {
  try {
    const pkg = new URL("../../package.json", import.meta.url);
    return (JSON.parse(readFileSync(pkg, "utf8")) as { version: string }).version;
  } catch {
    return "0.0.0";
  }
}

// Allow `node src/cli/main.ts …` in addition to the bin wrapper.
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main(process.argv.slice(2));
}
