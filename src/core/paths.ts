import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Where decision-logger keeps its files.
 *
 * Default is a user-level store, not a per-project directory: the database
 * must never end up inside a repository, and decisions from many workspaces
 * are more useful together (cross-project evidence raises a proposal's rank).
 * Per-workspace isolation is still available by setting `databasePath`.
 */

function xdg(envName: string, fallback: string): string {
  const v = process.env[envName];
  return v && v.trim() ? v : fallback;
}

export function stateDir(): string {
  return join(xdg("XDG_STATE_HOME", join(homedir(), ".local", "state")), "decision-logger");
}

export function configDir(): string {
  return join(xdg("XDG_CONFIG_HOME", join(homedir(), ".config")), "decision-logger");
}

export function defaultDatabasePath(): string {
  return join(stateDir(), "decisions.db");
}

export function userConfigPath(): string {
  return join(configDir(), "config.json");
}

/** Per-workspace overrides live next to the work, but only config — never the database. */
export function workspaceConfigPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".decision-logger", "config.json");
}

/** User-supplied domain profiles and prompt overrides. */
export function userProfilesDir(): string {
  return join(configDir(), "profiles");
}

export function userPromptsDir(): string {
  return join(configDir(), "prompts");
}

/** Root of the installed package (…/decision-logger), used to find bundled assets. */
export function packageRoot(): string {
  return resolve(new URL("../..", import.meta.url).pathname);
}

export function bundledPromptsDir(): string {
  return join(packageRoot(), "prompts");
}

export function bundledProfilesDir(): string {
  return join(packageRoot(), "profiles");
}
