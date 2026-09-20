import { readFileSync, existsSync } from "node:fs";
import {
  defaultDatabasePath,
  userConfigPath,
  workspaceConfigPath,
} from "./paths.ts";

/**
 * Configuration. Every value has a default that makes the tool work with no
 * setup at all. Layering: built-in defaults < user config < workspace config
 * < environment variables.
 */

export interface PrivacyConfig {
  /**
   * Forward assistant reasoning/thinking blocks to the analyzer. They contain
   * the best rationale but are the most sensitive part of a transcript, and
   * they are never persisted either way.
   */
  sendReasoningToAnalyzer: boolean;
  /** Extra regexes (as strings) redacted from text before it leaves the process. */
  redactPatterns: string[];
  /**
   * Hard cap on characters of session text sent to an analyzer in one call.
   * Kept well below the ~120 KB command-line limit that CLI-backed analyzers
   * have to live within, since the prompt template and schema also take space.
   */
  maxAnalyzerInputChars: number;
}

export interface NotificationConfig {
  enabled: boolean;
  /** Remind once unreviewed decisions reach this count. */
  unreviewedThreshold: number;
  /** Remind once this many days have passed since the last distillation. */
  reviewAgeDays: number;
  /** Suppress repeat reminders for this many hours. */
  cooldownHours: number;
}

export interface DistillationConfig {
  /** Minimum decisions required before distillation will call an analyzer. */
  minDecisions: number;
  /** Only consider decisions created within this window (0 = no limit). */
  lookbackDays: number;
  /** Maximum decisions handed to the analyzer in one run. */
  maxDecisions: number;
  /** New evidence needed after a rejection before a theme may be revived. */
  revivalEvidenceThreshold: number;
  /** Default cooldown applied by `defer` when no date is given. */
  deferDays: number;
}

export interface IngestionConfig {
  /** Sessions with fewer user turns than this are skipped without an LLM call. */
  minUserTurns: number;
  /** Sessions with less new text than this are skipped without an LLM call. */
  minNewChars: number;
  /** Candidates below this confidence are dropped. Precision over recall. */
  minConfidence: number;
  /** Upper bound on decisions accepted from a single session. */
  maxDecisionsPerSession: number;
}

export interface Config {
  databasePath: string;
  workspaceId?: string;
  workspaceLabel?: string;
  workspaceRoot?: string;
  domain: string;
  analyzer: string;
  analyzerModel?: string;
  analyzerTimeoutMs: number;
  enabledAdapters: string[];
  /** Work-system destinations this user actually maintains. Advisory for renderers. */
  workSystemTargets: string[];
  notifications: NotificationConfig;
  distillation: DistillationConfig;
  ingestion: IngestionConfig;
  privacy: PrivacyConfig;
}

export function defaultConfig(): Config {
  return {
    databasePath: defaultDatabasePath(),
    domain: "software-engineering",
    analyzer: "auto",
    analyzerTimeoutMs: 180_000,
    enabledAdapters: ["claude-code", "cursor", "codex", "generic"],
    workSystemTargets: [],
    notifications: {
      enabled: true,
      unreviewedThreshold: 20,
      reviewAgeDays: 14,
      cooldownHours: 20,
    },
    distillation: {
      minDecisions: 5,
      lookbackDays: 180,
      maxDecisions: 200,
      revivalEvidenceThreshold: 3,
      deferDays: 30,
    },
    ingestion: {
      minUserTurns: 2,
      minNewChars: 400,
      minConfidence: 0.6,
      maxDecisionsPerSession: 8,
    },
    privacy: {
      sendReasoningToAnalyzer: true,
      redactPatterns: [],
      maxAnalyzerInputChars: 60_000,
    },
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep merge, with arrays replaced rather than concatenated. */
function merge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch)) return base;
  if (!isPlainObject(base)) return patch as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = isPlainObject(v) ? merge(out[k], v) : v;
  }
  return out as T;
}

function readJson(path: string): unknown {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`invalid JSON in ${path}: ${(err as Error).message}`);
  }
}

function envOverrides(): Partial<Config> {
  const patch: Record<string, unknown> = {};
  const db = process.env.DECISION_LOGGER_DB;
  if (db) patch.databasePath = db;
  const domain = process.env.DECISION_LOGGER_DOMAIN;
  if (domain) patch.domain = domain;
  const analyzer = process.env.DECISION_LOGGER_ANALYZER;
  if (analyzer) patch.analyzer = analyzer;
  const model = process.env.DECISION_LOGGER_MODEL;
  if (model) patch.analyzerModel = model;
  const ws = process.env.DECISION_LOGGER_WORKSPACE_ID;
  if (ws) patch.workspaceId = ws;
  if (process.env.DECISION_LOGGER_NOTIFICATIONS === "0") {
    patch.notifications = { enabled: false };
  }
  return patch as Partial<Config>;
}

export interface LoadConfigOptions {
  workspaceRoot?: string;
  /** Explicit config file, bypassing the user/workspace lookup. */
  configPath?: string;
  /** Applied last, above environment variables. */
  overrides?: Partial<Config>;
}

export function loadConfig(options: LoadConfigOptions = {}): Config {
  let cfg = defaultConfig();

  if (options.configPath) {
    cfg = merge(cfg, readJson(options.configPath));
  } else {
    cfg = merge(cfg, readJson(userConfigPath()));
    if (options.workspaceRoot) {
      cfg = merge(cfg, readJson(workspaceConfigPath(options.workspaceRoot)));
    }
  }

  cfg = merge(cfg, envOverrides());
  if (options.overrides) cfg = merge(cfg, options.overrides);
  if (options.workspaceRoot && !cfg.workspaceRoot) cfg.workspaceRoot = options.workspaceRoot;
  return cfg;
}

/**
 * True when we are running inside an analyzer subprocess spawned by this tool.
 * Both ingestion and reminders must become no-ops, otherwise a nested
 * `claude -p` call would recursively trigger the very hooks that spawned it.
 */
export function isReentrantInvocation(): boolean {
  return process.env.DECISION_LOGGER_INGEST === "1";
}
