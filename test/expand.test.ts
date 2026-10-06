import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBibtex, EntryNode, StringNode } from "../src/parser";
import { resolveEntry } from "../src/expand";

function setup(src: string) {
  const nodes = parseBibtex(src);
  const entries = new Map(
    nodes.filter((n): n is EntryNode => n.kind === "entry").map((e) => [e.key, e])
  );
  const strings = nodes.filter((n): n is StringNode => n.kind === "string");
  const macros = { get: (l: string) => strings.find((s) => s.name.toLowerCase() === l)?.expr };
  return { entries, macros };
}

test("宏展开与 # 连接", () => {
  const { entries, macros } = setup(`@string{press = {青山}}
@book{P, publisher = press, note = press # "出版社" # 2026}`);
  const r = resolveEntry("P", entries, macros);
  assert.equal(r.fields["publisher"].value, "青山");
  assert.equal(r.fields["note"].value, "青山出版社2026");
});

test("宏前向引用与定义顺序无关", () => {
  const a = setup(`@misc{A, x = m}\n@string{m = {值}}`);
  const b = setup(`@string{m = {值}}\n@misc{A, x = m}`);
  assert.equal(resolveEntry("A", a.entries, a.macros).fields["x"].value, "值");
  assert.equal(resolveEntry("A", b.entries, b.macros).fields["x"].value, "值");
});

test("宏名大小写不敏感", () => {
  const { entries, macros } = setup(`@string{Press = {青山}}\n@misc{A, x = PRESS}`);
  assert.equal(resolveEntry("A", entries, macros).fields["x"].value, "青山");
});

test("缺失宏返回依赖路径", () => {
  const { entries, macros } = setup(`@string{a = b}\n@misc{A, x = a}`);
  const r = resolveEntry("A", entries, macros);
  const d = r.diagnostics.find((d) => d.code === "MACRO_UNDEFINED");
  assert.ok(d);
  assert.deepEqual((d.detail as any).path, ["a", "b"]);
  assert.equal(r.fields["x"], undefined);
});

test("宏循环返回依赖路径", () => {
  const { entries, macros } = setup(`@string{a = b}\n@string{b = a}\n@misc{A, x = a}`);
  const r = resolveEntry("A", entries, macros);
  const d = r.diagnostics.find((d) => d.code === "MACRO_CYCLE");
  assert.ok(d);
  assert.deepEqual((d.detail as any).path, ["a", "b", "a"]);
});

test("空字符串是有效显式值并覆盖父字段", () => {
  const { entries, macros } = setup(`@book{P, note = {父}}\n@misc{C, crossref = {P}, note = ""}`);
  const r = resolveEntry("C", entries, macros);
  assert.equal(r.fields["note"].value, "");
  assert.equal(r.fields["note"].sourceKey, "C");
});

test("crossref 继承与来源链", () => {
  const { entries, macros } = setup(`@string{press = {青山}}
@book{P, publisher = press, year = 2026}
@misc{C, crossref = {P}, title = {中文 {API}}, year = 2027}`);
  const r = resolveEntry("C", entries, macros);
  assert.equal(r.fields["publisher"].value, "青山");
  assert.equal(r.fields["publisher"].sourceKey, "P");
  assert.deepEqual(r.fields["publisher"].path, ["C", "P"]);
  assert.equal(r.fields["year"].value, "2027");
  assert.equal(r.fields["year"].sourceKey, "C");
  assert.equal(r.fields["title"].value, "中文 {API}");
  assert.equal(r.fields["crossref"], undefined);
});

test("多层父链", () => {
  const { entries, macros } = setup(`@book{G, publisher = {社}}
@book{P, crossref = {G}, year = 2026}
@misc{C, crossref = {P}}`);
  const r = resolveEntry("C", entries, macros);
  assert.equal(r.fields["publisher"].value, "社");
  assert.deepEqual(r.fields["publisher"].path, ["C", "P", "G"]);
  assert.equal(r.fields["year"].value, "2026");
  assert.deepEqual(r.fields["year"].path, ["C", "P"]);
});

test("缺失父条目诊断", () => {
  const { entries, macros } = setup(`@misc{C, crossref = {Nope}}`);
  const r = resolveEntry("C", entries, macros);
  assert.ok(r.diagnostics.some((d) => d.code === "CROSSREF_MISSING"));
});

test("父链循环诊断", () => {
  const { entries, macros } = setup(`@misc{A, crossref = {B}}\n@misc{B, crossref = {A}}`);
  const r = resolveEntry("A", entries, macros);
  assert.ok(r.diagnostics.some((d) => d.code === "CROSSREF_CYCLE"));
});

test("预算耗尽明确失败", () => {
  const { entries, macros } = setup(`@string{a = {xxxxxxxxxx}}\n@misc{A, x = a # a # a}`);
  const r = resolveEntry("A", entries, macros, { maxDepth: 64, maxChars: 10, maxDeps: 100 });
  assert.ok(r.diagnostics.some((d) => d.code === "BUDGET_EXCEEDED"));
  assert.equal(r.fields["x"], undefined);
});
