import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Service } from "../src/service.js";
import { Store } from "../src/store.js";

function svc(db = ":memory:") { return new Service(new Store(db)); }
const field = (r: any, name: string) => r.fields.find((f: any) => f.name.toUpperCase() === name.toUpperCase());

test("演示场景：宏展开 + crossref 继承与覆盖", () => {
  const s = svc();
  const r = s.import(`
@string{press = {青山}}
@book{P, publisher = press, year = 2026}
@article{C, crossref = P, year = 2027, title = {子条目}}
`);
  assert.equal(r.status, "ok");
  const c = s.expandEntry("C");
  assert.equal(field(c, "publisher").value, "青山");
  assert.equal(field(c, "publisher").source, "P");
  assert.deepEqual(field(c, "publisher").path, ["C", "P"]);
  assert.equal(field(c, "year").value, "2027"); // 子条目显式覆盖
  assert.equal(field(c, "year").source, "C");
  assert.equal(field(c, "crossref").source, "C"); // crossref 不向下继承
});

test("内层花括号与反斜杠原样保留，外层定界符剥离", () => {
  const s = svc();
  s.import(`@misc{A, title = {中文 {API} 与 \\LaTeX}, note = "a, b = c # d"}`);
  const a = s.expandEntry("A");
  assert.equal(field(a, "title").value, "中文 {API} 与 \\LaTeX");
  assert.equal(field(a, "note").value, "a, b = c # d"); // 定界串内逗号/等号/# 是普通内容
});

test("连接表达式、十进制字面量、前向宏引用", () => {
  const s = svc();
  const r = s.import(`
@misc{A, x = "pre-" # mid # "-" # 2026 # post}
@string{post = {!}}
@string{mid = {中}}
`);
  assert.equal(r.status, "ok");
  assert.equal(field(s.expandEntry("A"), "x").value, "pre-中-2026!");
});

test("定义顺序调整不影响结果", () => {
  const a = svc(); const b = svc();
  const t1 = `@string{m = {值}}\n@misc{A, x = m}\n@misc{B, y = m}`;
  const t2 = `@misc{B, y = m}\n@misc{A, x = m}\n@string{m = {值}}`;
  assert.equal(a.import(t1).status, "ok");
  assert.equal(b.import(t2).status, "ok");
  assert.equal(field(a.expandEntry("A"), "x").value, field(b.expandEntry("A"), "x").value);
});

test("空字符串是有效显式值并覆盖继承", () => {
  const s = svc();
  s.import(`@book{P, publisher = {青山}}\n@book{C, crossref = P, publisher = {}}`);
  const c = s.expandEntry("C");
  assert.equal(field(c, "publisher").value, "");
  assert.equal(field(c, "publisher").source, "C");
  assert.equal(field(c, "publisher").explicit, true);
});

test("多层父链与来源路径", () => {
  const s = svc();
  s.import(`
@book{A, publisher = {社}, year = 2020}
@book{B, crossref = A, year = 2021}
@book{C, crossref = B, title = {t}}
`);
  const c = s.expandEntry("C");
  assert.equal(field(c, "publisher").value, "社");
  assert.deepEqual(field(c, "publisher").path, ["C", "B", "A"]);
  assert.equal(field(c, "year").value, "2021");
  assert.deepEqual(field(c, "year").path, ["C", "B"]);
});

test("宏循环与缺失宏返回依赖路径", () => {
  const s = svc();
  const cyc = s.import(`@string{a = b}\n@string{b = c}\n@string{c = a}\n@misc{X, t = a}`);
  assert.equal(cyc.status, "failed");
  const d = cyc.diagnostics.find(x => x.code === "MACRO_CYCLE")!;
  assert.deepEqual(d.path!.map((x: string) => x.toUpperCase()), ["A", "B", "C", "A"]);
  const miss = s.import(`@misc{X, t = nope}`);
  assert.equal(miss.status, "failed");
  assert.equal(miss.diagnostics[0].code, "UNDEFINED_MACRO");
  assert.ok(miss.diagnostics[0].path!.length >= 1);
});

test("crossref 缺失父条目与父链循环", () => {
  const s = svc();
  const miss = s.import(`@book{C, crossref = Ghost}`);
  assert.equal(miss.status, "failed");
  assert.equal(miss.diagnostics[0].code, "CROSSREF_MISSING");
  const cyc = s.import(`@book{A, crossref = B}\n@book{B, crossref = A}`);
  assert.equal(cyc.status, "failed");
  const d = cyc.diagnostics.find(x => x.code === "CROSSREF_CYCLE")!;
  assert.deepEqual(d.path, ["A", "B", "A"]);
});

test("重复宏/字段/条目被拒绝；条目键区分大小写", () => {
  const s = svc();
  assert.equal(s.import(`@string{a={1}}\n@string{A={2}}`).diagnostics[0]?.code, "DUPLICATE_MACRO");
  assert.equal(s.import(`@misc{K, x={1}, X={2}}`).diagnostics[0]?.code, "DUPLICATE_FIELD");
  assert.equal(s.import(`@misc{K, x={1}}\n@misc{K, y={2}}`).diagnostics[0]?.code, "DUPLICATE_ENTRY");
  assert.equal(s.import(`@misc{K, x={1}}\n@misc{k, y={2}}`).status, "ok"); // 键区分大小写
});

test("不支持的指令明确拒绝，语法错误带源区间", () => {
  const s = svc();
  const r = s.import(`@preamble{"x"}\n@misc{A, t={1}}`);
  assert.equal(r.status, "failed");
  assert.equal(r.diagnostics[0].code, "UNSUPPORTED_DIRECTIVE");
  const bad = s.import(`@misc{A, title = {未闭合`);
  assert.equal(bad.status, "failed");
  assert.equal(bad.diagnostics[0].code, "PARSE_ERROR");
  assert.ok(typeof bad.diagnostics[0].span?.start === "number");
});

test("预算耗尽明确失败，不返回截断结果", () => {
  const s = svc();
  const r = s.import(`@string{a = {xxxxxxxxxx}}\n@misc{K, t = a # a # a}`, { maxExpandChars: 20 });
  assert.equal(r.status, "failed");
  assert.equal(r.diagnostics[0].code, "BUDGET_EXCEEDED");
  const deep = s.import(`@misc{K, t = ${"{".repeat(70)}x${"}".repeat(70)}}`);
  assert.equal(deep.status, "failed");
  assert.equal(deep.diagnostics[0].code, "DEPTH_EXCEEDED");
});

test("父版本修改不污染旧报告；失败导入不覆盖当前版本", () => {
  const s = svc();
  const v1 = s.import(`@book{P, publisher = {旧社}}\n@book{C, crossref = P}`);
  assert.equal(v1.status, "ok");
  const v2 = s.import(`@book{P, publisher = {新社}}\n@book{C, crossref = P}`);
  assert.equal(v2.status, "ok");
  assert.equal(field(s.expandEntry("C", v1.version), "publisher").value, "旧社");
  assert.equal(field(s.expandEntry("C", v2.version), "publisher").value, "新社");
  const diff = s.diff(v1.version, v2.version);
  assert.ok(diff.changes.some(c => c.kind === "field_changed" && c.field === "PUBLISHER"));
  // 失败导入后当前版本仍是 v2
  const bad = s.import(`@misc{K, t = undefinedmacro}`);
  assert.equal(bad.status, "failed");
  assert.equal(s.store.currentVersion(), v2.version);
  assert.ok(s.diagnostics(bad.version).diagnostics.length > 0);
});

test("导出区分原始表达式与展开值；重启后查询可复现", () => {
  const dir = mkdtempSync(join(tmpdir(), "bib-"));
  const db = join(dir, "t.db");
  try {
    const s1 = svc(db);
    const v = s1.import(`@string{press = {青山}}\n@book{P, publisher = press}\n@book{C, crossref = P, title = {中文 {API}}}`);
    assert.equal(v.status, "ok");
    const ex1 = s1.export();
    assert.equal(ex1.entries.find(e => e.key === "P")!.rawFields[0].expr.pieces[0].kind, "macro"); // 原始表达式
    assert.equal(ex1.entries.find(e => e.key === "C")!.effectiveFields.find(f => f.name === "publisher")!.value, "青山");
    s1.store.close();
    const s2 = svc(db); // 模拟重启
    assert.equal(field(s2.expandEntry("C"), "title").value, "中文 {API}");
    assert.deepEqual(s2.export(), { ...ex1, sourceText: ex1.sourceText });
    s2.store.close();
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});



