import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** SQLite 持久化：原文、语法结构、规则版本、展开结果、诊断，全部随版本原子写入。 */
export const RULE_VERSION = "restricted-bibtex/1";

export class Store {
  private db: DatabaseSync;
  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_version TEXT NOT NULL,
        status TEXT NOT NULL,              -- ok | failed
        source_text TEXT NOT NULL,
        options_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS macros (
        version_id INTEGER NOT NULL, name TEXT NOT NULL, name_norm TEXT NOT NULL,
        expr_json TEXT NOT NULL, value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS entries (
        version_id INTEGER NOT NULL, key TEXT NOT NULL, type TEXT NOT NULL,
        fields_json TEXT NOT NULL          -- [{name, expr}] 原始表达式
      );
      CREATE TABLE IF NOT EXISTS fields (
        version_id INTEGER NOT NULL, entry_key TEXT NOT NULL,
        name TEXT NOT NULL, name_norm TEXT NOT NULL,
        value TEXT NOT NULL, source TEXT NOT NULL, path_json TEXT NOT NULL,
        explicit INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS diagnostics (
        version_id INTEGER NOT NULL, code TEXT NOT NULL, message TEXT NOT NULL,
        span_start INTEGER, span_end INTEGER, path_json TEXT, entry TEXT, field TEXT
      );
    `);
  }
  close() { this.db.close(); }

  /** 原子导入：全部写入在一个事务里；失败版本只含原文与诊断，绝不影响当前通过版本。 */
  saveVersion(v: {
    status: "ok" | "failed"; sourceText: string; options: unknown;
    macros?: { name: string; nameNorm: string; expr: unknown; value: string }[];
    entries?: { key: string; type: string; fields: { name: string; expr: unknown }[] }[];
    expanded?: { entryKey: string; name: string; nameNorm: string; value: string; source: string; path: string[]; explicit: boolean }[];
    diagnostics: { code: string; message: string; span?: { start: number; end: number }; path?: string[]; entry?: string; field?: string }[];
  }): number {
    this.db.exec("BEGIN");
    try {
      const r = this.db.prepare(
        "INSERT INTO versions (rule_version, status, source_text, options_json, created_at) VALUES (?,?,?,?,?)"
      ).run(RULE_VERSION, v.status, v.sourceText, JSON.stringify(v.options ?? {}), new Date().toISOString());
      const vid = Number(r.lastInsertRowid);
      const im = this.db.prepare("INSERT INTO macros (version_id,name,name_norm,expr_json,value) VALUES (?,?,?,?,?)");
      for (const m of v.macros ?? []) im.run(vid, m.name, m.nameNorm, JSON.stringify(m.expr), m.value);
      const ie = this.db.prepare("INSERT INTO entries (version_id,key,type,fields_json) VALUES (?,?,?,?)");
      for (const e of v.entries ?? []) ie.run(vid, e.key, e.type, JSON.stringify(e.fields));
      const if_ = this.db.prepare("INSERT INTO fields (version_id,entry_key,name,name_norm,value,source,path_json,explicit) VALUES (?,?,?,?,?,?,?,?)");
      for (const f of v.expanded ?? []) if_.run(vid, f.entryKey, f.name, f.nameNorm, f.value, f.source, JSON.stringify(f.path), f.explicit ? 1 : 0);
      const id = this.db.prepare("INSERT INTO diagnostics (version_id,code,message,span_start,span_end,path_json,entry,field) VALUES (?,?,?,?,?,?,?,?)");
      for (const d of v.diagnostics) id.run(vid, d.code, d.message, d.span?.start ?? null, d.span?.end ?? null, d.path ? JSON.stringify(d.path) : null, d.entry ?? null, d.field ?? null);
      if (v.status === "ok") this.db.prepare("INSERT INTO meta (k,v) VALUES ('current_version',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(String(vid));
      this.db.exec("COMMIT");
      return vid;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  currentVersion(): number | null {
    const r = this.db.prepare("SELECT v FROM meta WHERE k='current_version'").get() as { v: string } | undefined;
    return r ? Number(r.v) : null;
  }
  listVersions() {
    return this.db.prepare("SELECT id, rule_version AS ruleVersion, status, created_at AS createdAt FROM versions ORDER BY id").all();
  }
  getVersion(id: number) {
    return this.db.prepare("SELECT id, rule_version AS ruleVersion, status, source_text AS sourceText, options_json AS options, created_at AS createdAt FROM versions WHERE id=?").get(id) as any;
  }
  listEntries(vid: number) {
    return this.db.prepare("SELECT key, type, fields_json AS fields FROM entries WHERE version_id=? ORDER BY key").all(vid)
      .map((r: any) => ({ key: r.key, type: r.type, fields: JSON.parse(r.fields) }));
  }
  getFields(vid: number, key: string) {
    return this.db.prepare("SELECT name, value, source, path_json AS path, explicit FROM fields WHERE version_id=? AND entry_key=? ORDER BY rowid").all(vid, key)
      .map((r: any) => ({ name: r.name, value: r.value, source: r.source, path: JSON.parse(r.path), explicit: !!r.explicit }));
  }
  getMacros(vid: number) {
    return this.db.prepare("SELECT name, expr_json AS expr, value FROM macros WHERE version_id=? ORDER BY rowid").all(vid)
      .map((r: any) => ({ name: r.name, expr: JSON.parse(r.expr), value: r.value }));
  }
  getDiagnostics(vid: number) {
    return this.db.prepare("SELECT code, message, span_start AS s, span_end AS e, path_json AS path, entry, field FROM diagnostics WHERE version_id=? ORDER BY rowid").all(vid)
      .map((r: any) => ({ code: r.code, message: r.message, span: r.s == null ? undefined : { start: r.s, end: r.e }, path: r.path ? JSON.parse(r.path) : undefined, entry: r.entry ?? undefined, field: r.field ?? undefined }));
  }
}
