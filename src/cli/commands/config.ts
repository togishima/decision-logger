import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CliContext } from "../context.ts";
import { defaultConfig, loadConfig } from "../../core/config.ts";
import type { Config } from "../../core/config.ts";
import { userConfigPath, workspaceConfigPath } from "../../core/paths.ts";
import { ANALYZER_NAMES } from "../../core/analysis/factory.ts";
import { loadProfiles } from "../../core/domains/profile.ts";
import { emit, heading, pad } from "../format.ts";

/**
 * Reading and writing configuration.
 *
 * The slash command `/decision-logger:configure` is a thin wrapper around
 * this: settings have to be adjustable from a plain terminal too, and keeping
 * one implementation means the two can never disagree.
 *
 * Only keys that exist in the config schema can be set. A silently ignored
 * typo would leave the user believing they had changed a threshold.
 */

export class ConfigError extends Error {}

export type ConfigScope = "user" | "project";

export interface ConfigArgs {
  scope?: ConfigScope;
}

function scopePath(ctx: CliContext, scope: ConfigScope): string {
  if (scope === "project") {
    const root = ctx.workspace.root ?? ctx.cwd;
    return workspaceConfigPath(root);
  }
  return userConfigPath();
}

/** Every settable key, derived from the defaults so the two cannot drift. */
export function configKeys(): string[] {
  const out: string[] = [];
  const walk = (value: unknown, prefix: string): void => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const [k, v] of Object.entries(value)) walk(v, prefix ? `${prefix}.${k}` : k);
      return;
    }
    if (prefix) out.push(prefix);
  };
  walk(defaultConfig(), "");
  // Optional keys have no default, so they are not reachable by walking.
  out.push("workspaceId", "workspaceLabel", "analyzerModel");
  return out.sort();
}

function assertKnownKey(key: string): void {
  if (configKeys().includes(key)) return;
  throw new ConfigError(
    `unknown setting "${key}".\nRun \`decision-logger config list\` to see every setting.`,
  );
}

/**
 * Values arrive as strings from argv. JSON first so numbers, booleans and
 * arrays keep their type; anything else stays a string.
 */
export function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Rejects values the rest of the system would later choke on. */
function validate(key: string, value: unknown): void {
  const expected = getIn(defaultConfig() as unknown as Record<string, unknown>, key);
  if (expected !== undefined && typeof expected !== typeof value && !Array.isArray(expected)) {
    throw new ConfigError(
      `"${key}" expects a ${typeof expected}, got ${typeof value} (${JSON.stringify(value)}).`,
    );
  }
  if (Array.isArray(expected) && !Array.isArray(value)) {
    throw new ConfigError(`"${key}" expects an array, e.g. '["claude-code","cursor"]'.`);
  }

  if (key === "analyzer" && !ANALYZER_NAMES.includes(value as never)) {
    throw new ConfigError(`analyzer must be one of: ${ANALYZER_NAMES.join(", ")}`);
  }
  if (key === "domain") {
    const { profiles } = loadProfiles();
    if (!profiles.has(String(value))) {
      throw new ConfigError(
        `unknown domain "${value}". Available: ${[...profiles.keys()].sort().join(", ")}`,
      );
    }
  }
  if (typeof expected === "number" && typeof value === "number" && value < 0) {
    throw new ConfigError(`"${key}" cannot be negative.`);
  }
}

function getIn(obj: Record<string, unknown>, key: string): unknown {
  let cursor: unknown = obj;
  for (const part of key.split(".")) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

function setIn(obj: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split(".");
  let cursor = obj;
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part];
    if (next === null || typeof next !== "object" || Array.isArray(next)) cursor[part] = {};
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts.at(-1)!] = value;
}

function unsetIn(obj: Record<string, unknown>, key: string): boolean {
  const parts = key.split(".");
  let cursor: Record<string, unknown> = obj;
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part];
    if (next === null || typeof next !== "object") return false;
    cursor = next as Record<string, unknown>;
  }
  const last = parts.at(-1)!;
  if (!(last in cursor)) return false;
  delete cursor[last];
  return true;
}

function readOverrides(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch (err) {
    throw new ConfigError(`${path} is not valid JSON: ${(err as Error).message}`);
  }
}

function writeOverrides(path: string, data: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

/** Settings worth showing first; the rest are for people who go looking. */
const HIGHLIGHTS = [
  "domain",
  "analyzer",
  "analyzerModel",
  "notifications.enabled",
  "notifications.unreviewedThreshold",
  "notifications.reviewAgeDays",
  "ingestion.minConfidence",
  "ingestion.maxDecisionsPerSession",
  "distillation.minDecisions",
  "privacy.sendReasoningToAnalyzer",
  "databasePath",
];

export function cmdConfigList(ctx: CliContext, args: ConfigArgs): number {
  const userPath = userConfigPath();
  const projectPath = ctx.workspace.root ? workspaceConfigPath(ctx.workspace.root) : undefined;
  const effective = ctx.config as unknown as Record<string, unknown>;
  const defaults = defaultConfig() as unknown as Record<string, unknown>;

  const settings = configKeys().map((key) => ({
    key,
    value: getIn(effective, key),
    isDefault: JSON.stringify(getIn(effective, key)) === JSON.stringify(getIn(defaults, key)),
  }));

  emit(
    {
      files: {
        user: { path: userPath, exists: existsSync(userPath) },
        project: projectPath ? { path: projectPath, exists: existsSync(projectPath) } : null,
      },
      settings,
    },
    ctx.json,
    () => {
      const lines = [heading("Configuration")];
      lines.push(
        `  user file     ${userPath}${existsSync(userPath) ? "" : "  (not created yet)"}`,
      );
      if (projectPath) {
        lines.push(
          `  project file  ${projectPath}${existsSync(projectPath) ? "" : "  (not created yet)"}`,
        );
      }
      lines.push("", "  * = changed from the default", "");

      const shown = new Set<string>();
      for (const key of HIGHLIGHTS) {
        const setting = settings.find((s) => s.key === key);
        if (!setting) continue;
        shown.add(key);
        lines.push(
          `  ${setting.isDefault ? " " : "*"} ${pad(key, 38)} ${JSON.stringify(setting.value)}`,
        );
      }

      const rest = settings.filter((s) => !shown.has(s.key));
      if (rest.length) {
        lines.push("", "  more:");
        for (const setting of rest) {
          lines.push(
            `  ${setting.isDefault ? " " : "*"} ${pad(setting.key, 38)} ${JSON.stringify(setting.value)}`,
          );
        }
      }

      lines.push(
        "",
        "  decision-logger config set <key> <value> [--project]",
        "  decision-logger config unset <key> [--project]",
      );
      return lines.join("\n");
    },
  );
  void args;
  return 0;
}

export function cmdConfigGet(ctx: CliContext, key: string): number {
  try {
    assertKnownKey(key);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }
  const value = getIn(ctx.config as unknown as Record<string, unknown>, key);
  emit({ key, value }, ctx.json, () => JSON.stringify(value));
  return 0;
}

export function cmdConfigSet(
  ctx: CliContext,
  key: string,
  rawValue: string,
  args: ConfigArgs,
): number {
  const scope = args.scope ?? "user";
  const path = scopePath(ctx, scope);

  try {
    assertKnownKey(key);
    const value = parseValue(rawValue);
    validate(key, value);

    const overrides = readOverrides(path);
    const previous = getIn(ctx.config as unknown as Record<string, unknown>, key);
    setIn(overrides, key, value);
    writeOverrides(path, overrides);

    // Re-read so what we report is what the layered config actually resolves
    // to — a project file can still win over a user file.
    const after = loadConfig({ workspaceRoot: ctx.workspace.root });
    const effective = getIn(after as unknown as Record<string, unknown>, key);

    emit({ key, value, effective, scope, path }, ctx.json, () => {
      const lines = [
        `${key}: ${JSON.stringify(previous)} → ${JSON.stringify(value)}`,
        `written to ${path} (${scope})`,
      ];
      if (JSON.stringify(effective) !== JSON.stringify(value)) {
        lines.push(
          "",
          `Note: the effective value is still ${JSON.stringify(effective)} —`,
          "another config layer or an environment variable is overriding it.",
        );
      }
      return lines.join("\n");
    });
    return 0;
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

export function cmdConfigUnset(ctx: CliContext, key: string, args: ConfigArgs): number {
  const scope = args.scope ?? "user";
  const path = scopePath(ctx, scope);

  try {
    assertKnownKey(key);
    const overrides = readOverrides(path);
    const removed = unsetIn(overrides, key);
    if (removed) writeOverrides(path, overrides);

    const after = loadConfig({ workspaceRoot: ctx.workspace.root });
    const effective = getIn(after as unknown as Record<string, unknown>, key);

    emit({ key, removed, effective, scope, path }, ctx.json, () =>
      removed
        ? `${key} removed from ${path}\nnow: ${JSON.stringify(effective)}`
        : `${key} was not set in ${path}; nothing to do.`,
    );
    return 0;
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

export function cmdConfigPath(ctx: CliContext, args: ConfigArgs): number {
  const path = scopePath(ctx, args.scope ?? "user");
  emit({ path, exists: existsSync(path) }, ctx.json, () => path);
  return 0;
}

/** Exposed for tests: applies a change without going through argv. */
export function applyConfigChange(
  path: string,
  key: string,
  rawValue: string,
): Config {
  assertKnownKey(key);
  const value = parseValue(rawValue);
  validate(key, value);
  const overrides = readOverrides(path);
  setIn(overrides, key, value);
  writeOverrides(path, overrides);
  return loadConfig({ configPath: path });
}
