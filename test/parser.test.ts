import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBibtex } from "../src/parser";
import { BibError } from "../src/errors";

test("嵌套花括号：内层保留，外层剥离", () => {
  const nodes = parseBibtex(`@misc{C, title = {中文 {API} 与 {深层 {嵌套}}}}`);
  const e = nodes[0] as any;
  assert.equal(e.fields[0].expr.parts[0].value, "中文 {API} 与 {深层 {嵌套}}");
});

test("引号字符串内逗号、等号、# 是普通内容", () => {
  const nodes = parseBibtex(`@misc{A, note = "a, b = c # d"}`);
  const e = nodes[0] as any;
  assert.equal(e.fields[0].expr.parts[0].value, "a, b = c # d");
});

test("引号内花括号保护引号", () => {
  const nodes = parseBibtex(`@misc{A, note = "say {"hi"} ok"}`);
  const e = nodes[0] as any;
  assert.equal(e.fields[0].expr.parts[0].value, `say {"hi"} ok`);
});

test("连接表达式与数字字面量", () => {
  const nodes = parseBibtex(`@string{a = {X}}\n@misc{A, year = 2026, note = a # "-" # 2026}`);
  const e = nodes[1] as any;
  assert.deepEqual(
    e.fields[1].expr.parts.map((p: any) => p.kind),
    ["macro", "string", "number"]
  );
});

test("反斜杠文本原样保留", () => {
  const nodes = parseBibtex(`@misc{A, note = {\\'e \\textbf{x}}}`);
  const e = nodes[0] as any;
  assert.equal(e.fields[0].expr.parts[0].value, `\\'e \\textbf{x}`);
});

test("拒绝不支持的指令", () => {
  assert.throws(() => parseBibtex(`@preamble{foo}`), (e: any) => {
    assert.equal(e.code, "UNSUPPORTED_DIRECTIVE");
    return true;
  });
});

test("语法错误带源区间", () => {
  try {
    parseBibtex(`@misc{A, note = {未闭合`);
    assert.fail("应抛出");
  } catch (e) {
    assert.ok(e instanceof BibError);
    assert.equal(e.code, "PARSE_ERROR");
    assert.equal(typeof e.start, "number");
  }
});

test("顶层垃圾被拒绝", () => {
  assert.throws(() => parseBibtex(`hello`), /顶层只允许/);
});
