import type { Db } from "../core/storage/db.ts";
import type { Config } from "../core/config.ts";
import type { DomainProfile } from "../core/domains/profile.ts";
import type { Analyzer } from "../core/analysis/analyzer.ts";
import { openDatabase } from "../core/storage/db.ts";
import { loadConfig } from "../core/config.ts";
import { getProfile } from "../core/domains/profile.ts";
import { createAnalyzer } from "../core/analysis/factory.ts";
import { identifyWorkspace, findWorkspaceRoot } from "../core/workspace.ts";
import type { WorkspaceIdentity } from "../core/workspace.ts";

/**
 * Everything a command needs, assembled once.
 *
 * Commands receive a context and never reach for globals: that is what lets
 * the test suite drive the same code paths against an in-memory database and a
 * scripted analyzer.
 */
export interface CliContext {
  db: Db;
  config: Config;
  profile: DomainProfile;
  workspace: WorkspaceIdentity;
  cwd: string;
  json: boolean;
  verbose: boolean;
  /** Built lazily — most commands never need a model. */
  analyzer(): Promise<Analyzer>;
}

export interface ContextOptions {
  cwd?: string;
  json?: boolean;
  verbose?: boolean;
  domain?: string;
  databasePath?: string;
  workspaceId?: string;
  configPath?: string;
  analyzerName?: string;
}

export function createContext(options: ContextOptions = {}): CliContext {
  const cwd = options.cwd ?? process.cwd();
  const workspaceRoot = findWorkspaceRoot(cwd);

  const overrides: Partial<Config> = {};
  if (options.domain) overrides.domain = options.domain;
  if (options.databasePath) overrides.databasePath = options.databasePath;
  if (options.workspaceId) overrides.workspaceId = options.workspaceId;
  if (options.analyzerName) overrides.analyzer = options.analyzerName;

  const config = loadConfig({ workspaceRoot, configPath: options.configPath, overrides });
  const workspace = identifyWorkspace(cwd, config.workspaceId, config.workspaceLabel);
  const db = openDatabase(config.databasePath);
  const profile = getProfile(config.domain);

  let cached: Analyzer | undefined;
  return {
    db,
    config,
    profile,
    workspace,
    cwd,
    json: options.json ?? false,
    verbose: options.verbose ?? false,
    async analyzer() {
      cached ??= await createAnalyzer(config);
      return cached;
    },
  };
}
