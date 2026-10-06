import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export const RULES_VERSION = "restricted-1";

export function dataDir(): string {
  return process.env.BIB_DATA_DIR || path.join(process.cwd(), "data");
}

export function openDb(dir?: string): DatabaseSync {
  const d = dir || dataDir();
  fs.mkdirSync(d, { recursive: true });
  const db = new DatabaseSync(path.join(d, "bib.sqlite"));
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT NOT NULL,               -- 'ok' | 'failed'
      rules_version TEXT NOT NULL,
      source_text TEXT NOT NULL,
      diagnostics TEXT NOT NULL,          -- JSON array
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS entries (
      version_id INTEGER NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      type TEXT NOT NULL,
      fields TEXT NOT NULL,               -- JSON: [{name, expr, start, end}]
      start INTEGER NOT NULL,
      end INTEGER NOT NULL,
      PRIMARY KEY (version_id, key)
    );
    CREATE TABLE IF NOT EXISTS strings (
      version_id INTEGER NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
      name TEXT NOT NULL,                 -- 原始写法
      name_lower TEXT NOT NULL,
      expr TEXT NOT NULL,                 -- JSON ValueExpr
      PRIMARY KEY (version_id, name_lower)
    );
    CREATE TABLE IF NOT EXISTS expansions (
      version_id INTEGER NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
      entry_key TEXT NOT NULL,
      field_lower TEXT NOT NULL,
      name TEXT NOT NULL,
      value TEXT NOT NULL,
      source_key TEXT NOT NULL,
      path TEXT NOT NULL,                 -- JSON array
      raw TEXT NOT NULL,                  -- JSON ValueExpr
      PRIMARY KEY (version_id, entry_key, field_lower)
    );
    CREATE TABLE IF NOT EXISTS entry_diagnostics (
      version_id INTEGER NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
      entry_key TEXT NOT NULL,
      diagnostic TEXT NOT NULL            -- JSON
    );
  `);
  return db;
}

export function currentVersionId(db: DatabaseSync): number | null {
  const row = db.prepare("SELECT v FROM meta WHERE k='current_version'").get() as
    | { v: string }
    | undefined;
  return row ? Number(row.v) : null;
}

export function setCurrentVersion(db: DatabaseSync, id: number): void {
  db.prepare(
    "INSERT INTO meta(k,v) VALUES('current_version',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v"
  ).run(String(id));
}
