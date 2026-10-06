import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/db";
import {
  compareVersions,
  exportVersion,
  getDiagnostics,
  getEntryFields,
  getFieldOrigin,
  importSource,
  listEntries,
} from "../src/service";
import { listen } from "../src/api";

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bib-test-"));
  return { db: openDb(dir), dir };
}

const DEMO = `@string{press = {青山}}
@book{P, publisher = press, year = 2026}
@misc{C, crossref = {P}, title = {中文 {API}}, year = 2027}
`;

test("导入演示库并查询来源链", () => {
  const { db } = tmpDb();
  const r = importSource(db, DEMO);
  assert.equal(r.status, "ok");
  const fields = getEntryFields(db, "C");
  const pub = fields.fields.find((f) => f.name === "publisher")!;
  assert.equal(pub.value, "青山");
  assert.equal(pub.sourceKey, "P");
  assert.deepEqual(pub.path, ["C", "P"]);
  const year = fields.fields.find((f) => f.name === "year")!;
  assert.equal(year.value, "2027");
  const origin = getFieldOrigin(db, "C", "PUBLISHER");
  assert.equal(origin.sourceKey, "P");
  db.close();
});

test("重复宏/字段/条目被拒绝", () => {
  const { db } = tmpDb();
  assert.equal(importSource(db, `@string{a={1}}\n@string{A={2}}`).status, "failed");
  assert.equal(importSource(db, `@misc{K, x={1}}\n@misc{K, y={2}}`).status, "failed");
  assert.equal(importSource(db, `@misc{K, x={1}, X={2}}`).status, "failed");
  const d = getDiagnostics(db, 1);
  assert.equal(d.diagnostics[0].code, "DUPLICATE_MACRO");
  db.close();
});

test("失败导入不覆盖已通过的版本", () => {
  const { db } = tmpDb();
  const ok = importSource(db, DEMO);
  const bad = importSource(db, `@preamble{x}`);
  assert.equal(bad.status, "failed");
  const entries = listEntries(db);
  assert.deepEqual(entries.map((e) => e.key), ["C", "P"]);
  const d = getDiagnostics(db, bad.versionId);
  assert.equal(d.status, "failed");
  assert.equal(d.diagnostics[0].code, "UNSUPPORTED_DIRECTIVE");
  db.close();
});

test("修改父条目创建新版本，旧报告可复现", () => {
  const { db } = tmpDb();
  const v1 = importSource(db, DEMO);
  const v2 = importSource(db, DEMO.replace("青山", "蓝山"));
  assert.notEqual(v1.versionId, v2.versionId);
  assert.equal(getFieldOrigin(db, "C", "publisher", v1.versionId).value, "青山");
  assert.equal(getFieldOrigin(db, "C", "publisher", v2.versionId).value, "蓝山");
  const cmp = compareVersions(db, v1.versionId, v2.versionId);
  const cDiff = cmp.changed.find((c) => c.key === "C");
  assert.ok(cDiff.fields.some((f: any) => f.field === "publisher" && f.to.value === "蓝山"));
  db.close();
});

test("重启后查询结果一致", () => {
  const { db, dir } = tmpDb();
  const v = importSource(db, DEMO);
  db.close();
  const db2 = openDb(dir);
  const origin = getFieldOrigin(db2, "C", "publisher", v.versionId);
  assert.equal(origin.value, "青山");
  assert.deepEqual(origin.path, ["C", "P"]);
  db2.close();
});

test("导出结构化结果区分原始表达式与展开值", () => {
  const { db } = tmpDb();
  importSource(db, DEMO);
  const exp = exportVersion(db);
  const c = exp.entries.find((e) => e.key === "C")!;
  const title = c.fields.find((f: any) => f.name === "title")!;
  assert.equal(title.value, "中文 {API}");
  assert.equal(title.raw.parts[0].kind, "string");
  assert.equal(exp.version.rulesVersion, "restricted-1");
  db.close();
});

test("API 端到端", async () => {
  const { db } = tmpDb();
  const { port, close } = await listen(db, 0);
  const base = `http://127.0.0.1:${port}`;
  const imp = await fetch(`${base}/api/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: DEMO }),
  });
  assert.equal(imp.status, 201);
  const { versionId } = (await imp.json()) as any;
  const fields = (await (await fetch(`${base}/api/entries/C/fields`)).json()) as any;
  assert.equal(fields.fields.find((f: any) => f.name === "publisher").value, "青山");
  const origin = (await (await fetch(`${base}/api/entries/C/fields/year/origin`)).json()) as any;
  assert.equal(origin.value, "2027");
  const bad = await fetch(`${base}/api/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: "@comment{x}" }),
  });
  assert.equal(bad.status, 422);
  const notFound = await fetch(`${base}/api/entries/ZZZ/fields`);
  assert.equal(notFound.status, 404);
  const diag = (await (await fetch(`${base}/api/diagnostics?version=${versionId}`)).json()) as any;
  assert.equal(diag.status, "ok");
  close();
  db.close();
});
