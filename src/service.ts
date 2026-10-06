import { DatabaseSync } from "node:sqlite";
import { BibError, Diagnostic } from "./errors";
import { EntryNode, parseBibtex, StringNode, ValueExpr } from "./parser";
import { Budget, DEFAULT_BUDGET, resolveEntry } from "./expand";
import { currentVersionId, RULES_VERSION, setCurrentVersion } from "./db";

export interface ImportResult {
  versionId: number;
  status: "ok" | "failed";
  diagnostics: Diagnostic[];
}

function dupCheck<T>(items: T[], keyOf: (t: T) => string, code: any, what: string): void {
  const seen = new Set<string>();
  for (const it of items) {
    const k = keyOf(it);
    if (seen.has(k)) {
      throw new BibError(code, `${what} 重复（大小写不敏感规范化后）：${k}`);
    }
    seen.add(k);
  }
}

export function importSource(
  db: DatabaseSync,
  source: string,
  budget: Budget = DEFAULT_BUDGET
): ImportResult {
  if (typeof source !== "string" || source.length === 0) {
    throw new BibError("VALIDATION_ERROR", "source 必须是非空 UTF-8 字符串");
  }
  const diagnostics: Diagnostic[] = [];
  let entries: EntryNode[] = [];
  let strings: StringNode[] = [];
  let failed = false;

  try {
    const nodes = parseBibtex(source);
    entries = nodes.filter((n): n is EntryNode => n.kind === "entry");
    strings = nodes.filter((n): n is StringNode => n.kind === "string");
    dupCheck(strings, (s) => s.name.toLowerCase(), "DUPLICATE_MACRO", "宏");
    dupCheck(entries, (e) => e.key, "DUPLICATE_ENTRY", "条目键");
    for (const e of entries) {
      dupCheck(e.fields, (f) => f.name.toLowerCase(), "DUPLICATE_FIELD", `条目 ${e.key} 的字段`);
    }
  } catch (e) {
    if (e instanceof BibError) {
      failed = true;
      diagnostics.push(e.toJSON() as Diagnostic);
    } else throw e;
  }

  // 事务写入：任何一步失败整体回滚，不污染已有版本
  db.exec("BEGIN");
  try {
    const created = new Date().toISOString();
    const ins = db.prepare(
      "INSERT INTO versions(status, rules_version, source_text, diagnostics, created_at) VALUES(?,?,?,?,?)"
    );
    // 先占位拿到版本号（展开诊断稍后回填）
    const r = ins.run(failed ? "failed" : "ok", RULES_VERSION, source, "[]", created);
    const versionId = Number(r.lastInsertRowid);

    if (!failed) {
      const entryMap = new Map(entries.map((e) => [e.key, e]));
      const macros = {
        get(nameLower: string): ValueExpr | undefined {
          const s = strings.find((x) => x.name.toLowerCase() === nameLower);
          return s?.expr;
        },
      };
      const insEntry = db.prepare(
        "INSERT INTO entries(version_id, key, type, fields, start, end) VALUES(?,?,?,?,?,?)"
      );
      const insStr = db.prepare(
        "INSERT INTO strings(version_id, name, name_lower, expr) VALUES(?,?,?,?)"
      );
      const insExp = db.prepare(
        "INSERT INTO expansions(version_id, entry_key, field_lower, name, value, source_key, path, raw) VALUES(?,?,?,?,?,?,?,?)"
      );
      const insDiag = db.prepare(
        "INSERT INTO entry_diagnostics(version_id, entry_key, diagnostic) VALUES(?,?,?)"
      );
      for (const s of strings) insStr.run(versionId, s.name, s.name.toLowerCase(), JSON.stringify(s.expr));
      for (const e of entries) {
        insEntry.run(versionId, e.key, e.type, JSON.stringify(e.fields), e.start, e.end);
      }
      for (const e of entries) {
        const res = resolveEntry(e.key, entryMap, macros, budget);
        for (const [lower, f] of Object.entries(res.fields)) {
          insExp.run(
            versionId,
            e.key,
            lower,
            f.name,
            f.value,
            f.sourceKey,
            JSON.stringify(f.path),
            JSON.stringify(f.raw)
          );
        }
        for (const d of res.diagnostics) {
          insDiag.run(versionId, e.key, JSON.stringify(d));
          diagnostics.push(d);
        }
      }
      db.prepare("UPDATE versions SET diagnostics=? WHERE id=?").run(
        JSON.stringify(diagnostics),
        versionId
      );
      setCurrentVersion(db, versionId);
    } else {
      db.prepare("UPDATE versions SET diagnostics=? WHERE id=?").run(
        JSON.stringify(diagnostics),
        versionId
      );
      // 失败导入不更新 current_version
    }
    db.exec("COMMIT");
    return { versionId, status: failed ? "failed" : "ok", diagnostics };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

function resolveVersion(db: DatabaseSync, version?: number): number {
  const id = version ?? currentVersionId(db);
  if (id === null) throw new BibError("NOT_FOUND", "尚无可用的库版本");
  const row = db.prepare("SELECT status FROM versions WHERE id=?").get(id) as
    | { status: string }
    | undefined;
  if (!row) throw new BibError("NOT_FOUND", `版本 ${id} 不存在`);
  if (row.status !== "ok") throw new BibError("VALIDATION_ERROR", `版本 ${id} 是失败导入，仅可查询诊断`);
  return id;
}

export function listEntries(db: DatabaseSync, version?: number) {
  const vid = resolveVersion(db, version);
  return db
    .prepare("SELECT key, type FROM entries WHERE version_id=? ORDER BY key")
    .all(vid) as { key: string; type: string }[];
}

export function getEntryFields(db: DatabaseSync, key: string, version?: number) {
  const vid = resolveVersion(db, version);
  const entry = db
    .prepare("SELECT type FROM entries WHERE version_id=? AND key=?")
    .get(vid, key) as { type: string } | undefined;
  if (!entry) throw new BibError("NOT_FOUND", `条目 '${key}' 不存在`);
  const rows = db
    .prepare(
      "SELECT field_lower, name, value, source_key, path, raw FROM expansions WHERE version_id=? AND entry_key=? ORDER BY field_lower"
    )
    .all(vid, key) as any[];
  const diags = db
    .prepare("SELECT diagnostic FROM entry_diagnostics WHERE version_id=? AND entry_key=?")
    .all(vid, key) as { diagnostic: string }[];
  return {
    key,
    type: entry.type,
    fields: rows.map((r) => ({
      name: r.name,
      value: r.value,
      sourceKey: r.source_key,
      path: JSON.parse(r.path),
      raw: JSON.parse(r.raw),
    })),
    diagnostics: diags.map((d) => JSON.parse(d.diagnostic)),
  };
}

export function getFieldOrigin(db: DatabaseSync, key: string, field: string, version?: number) {
  const vid = resolveVersion(db, version);
  const row = db
    .prepare(
      "SELECT name, value, source_key, path, raw FROM expansions WHERE version_id=? AND entry_key=? AND field_lower=?"
    )
    .get(vid, key, field.toLowerCase()) as any;
  if (!row) throw new BibError("NOT_FOUND", `条目 '${key}' 没有有效字段 '${field}'`);
  return {
    entryKey: key,
    field: row.name,
    value: row.value,
    sourceKey: row.source_key,
    path: JSON.parse(row.path),
    raw: JSON.parse(row.raw),
  };
}

export function getDiagnostics(db: DatabaseSync, version?: number) {
  const id = version ?? currentVersionId(db);
  if (id === null) throw new BibError("NOT_FOUND", "尚无任何版本");
  const row = db.prepare("SELECT diagnostics, status FROM versions WHERE id=?").get(id) as
    | { diagnostics: string; status: string }
    | undefined;
  if (!row) throw new BibError("NOT_FOUND", `版本 ${id} 不存在`);
  return { versionId: id, status: row.status, diagnostics: JSON.parse(row.diagnostics) };
}

export function exportVersion(db: DatabaseSync, version?: number) {
  const vid = resolveVersion(db, version);
  const v = db
    .prepare("SELECT id, status, rules_version, source_text, diagnostics, created_at FROM versions WHERE id=?")
    .get(vid) as any;
  const entries = db
    .prepare("SELECT key, type, fields FROM entries WHERE version_id=? ORDER BY key")
    .all(vid) as any[];
  const strings = db
    .prepare("SELECT name, expr FROM strings WHERE version_id=? ORDER BY name_lower")
    .all(vid) as any[];
  return {
    version: {
      id: v.id,
      status: v.status,
      rulesVersion: v.rules_version,
      createdAt: v.created_at,
      diagnostics: JSON.parse(v.diagnostics),
    },
    sourceText: v.source_text,
    strings: strings.map((s) => ({ name: s.name, expr: JSON.parse(s.expr) })),
    entries: entries.map((e) => ({
      ...getEntryFields(db, e.key, vid),
      declaredFields: JSON.parse(e.fields),
    })),
  };
}

export function compareVersions(db: DatabaseSync, from: number, to: number) {
  const fa = listEntries(db, from);
  const ta = listEntries(db, to);
  const fKeys = new Set(fa.map((e) => e.key));
  const tKeys = new Set(ta.map((e) => e.key));
  const added = ta.filter((e) => !fKeys.has(e.key)).map((e) => e.key);
  const removed = fa.filter((e) => !tKeys.has(e.key)).map((e) => e.key);
  const changed: any[] = [];
  for (const key of tKeys) {
    if (!fKeys.has(key)) continue;
    const fFields = new Map(getEntryFields(db, key, from).fields.map((f) => [f.name.toLowerCase(), f]));
    const tFields = new Map(getEntryFields(db, key, to).fields.map((f) => [f.name.toLowerCase(), f]));
    const fieldDiffs: any[] = [];
    for (const [lower, tf] of tFields) {
      const ff = fFields.get(lower);
      if (!ff) fieldDiffs.push({ field: tf.name, kind: "added", to: tf.value });
      else if (ff.value !== tf.value || ff.sourceKey !== tf.sourceKey) {
        fieldDiffs.push({
          field: tf.name,
          kind: "changed",
          from: { value: ff.value, sourceKey: ff.sourceKey },
          to: { value: tf.value, sourceKey: tf.sourceKey },
        });
      }
    }
    for (const [lower, ff] of fFields) {
      if (!tFields.has(lower)) fieldDiffs.push({ field: ff.name, kind: "removed", from: ff.value });
    }
    if (fieldDiffs.length) changed.push({ key, fields: fieldDiffs });
  }
  return { from, to, added, removed, changed };
}
