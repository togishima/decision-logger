import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MIGRATIONS } from "./migrations.ts";

export type Db = DatabaseSync;

export interface OpenOptions {
  /** Skip migrations (used by `doctor` to inspect without touching anything). */
  readOnly?: boolean;
}

/**
 * Opens (and creates, if needed) the SQLite store.
 *
 * SQLite is the source of truth. It is a single file the user can `sqlite3`,
 * copy, or delete — that inspectability is a product requirement, not an
 * implementation detail.
 */
export function openDatabase(path: string, options: OpenOptions = {}): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

  const db = new DatabaseSync(path, { readOnly: options.readOnly ?? false });
  db.exec("PRAGMA foreign_keys = ON");
  if (!options.readOnly) {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
    migrate(db);
  }
  return db;
}

export function migrate(db: Db): number {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);

  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as { version: number }[]).map(
      (r) => r.version,
    ),
  );

  let count = 0;
  for (const [index, migration] of MIGRATIONS.entries()) {
    const version = index + 1;
    if (applied.has(version)) continue;
    db.exec("BEGIN");
    try {
      db.exec(migration.sql);
      db.prepare(
        "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)",
      ).run(version, migration.name, new Date().toISOString());
      db.exec("COMMIT");
      count += 1;
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(`migration ${migration.name} failed: ${(err as Error).message}`);
    }
  }
  return count;
}

export function schemaVersion(db: Db): number {
  try {
    const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as
      | { v: number | null }
      | undefined;
    return row?.v ?? 0;
  } catch {
    return 0;
  }
}

/** Runs `fn` inside a transaction, rolling back on any throw. */
export function transact<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* the original error is the interesting one */
    }
    throw err;
  }
}

export function getState(db: Db, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM app_state WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setState(db: Db, key: string, value: string): void {
  db.prepare(
    `INSERT INTO app_state(key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, new Date().toISOString());
}
