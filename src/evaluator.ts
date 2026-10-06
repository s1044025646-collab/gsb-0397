import { Diagnostic, norm } from "./errors.js";
import { EntryDef, StringDef, ValueExpr } from "./parser.js";

export interface Budgets {
  maxExpandDepth?: number;   // 宏递归展开深度，默认 100
  maxExpandChars?: number;   // 全库展开总字符预算，默认 1_000_000
  maxDependencies?: number;  // 宏依赖解析次数预算，默认 10_000
}

export interface FieldValue {
  name: string;        // 原始字段名（取最终生效条目中的写法）
  nameNorm: string;
  value: string;       // 展开后的值；空串是合法显式值
  source: string;      // 实际来源条目键
  path: string[];      // 继承路径：[查询条目, ..., 来源条目]
}

export interface EntryResult {
  key: string;
  type: string;
  fields: FieldValue[];             // 显式 + 继承后的有效字段
  explicitFields: FieldValue[];     // 仅本条目显式声明
}

export interface EvalResult {
  macros: { name: string; value: string }[];
  entries: EntryResult[];
  diagnostics: Diagnostic[]; // 非空即导入失败
}

const CROSSREF = norm("crossref");
const RESERVED = new Set([CROSSREF]); // crossref 本身不向下继承

export function evaluate(strings: StringDef[], entries: EntryDef[], budgets: Budgets = {}): EvalResult {
  const maxDepth = budgets.maxExpandDepth ?? 100;
  const maxChars = budgets.maxExpandChars ?? 1_000_000;
  const maxDeps = budgets.maxDependencies ?? 10_000;
  const diagnostics: Diagnostic[] = [];
  let usedChars = 0;
  let usedDeps = 0;

  // ---- 宏表：规范化后重复即拒绝 ----
  const macroDefs = new Map<string, StringDef>();
  for (const s of strings) {
    if (macroDefs.has(s.nameNorm)) {
      diagnostics.push({ code: "DUPLICATE_MACRO", message: `宏 ${s.name} 与已有定义重名（大小写不敏感）`, span: s.span });
    } else macroDefs.set(s.nameNorm, s);
  }

  // ---- 条目表：键区分大小写 ----
  const entryDefs = new Map<string, EntryDef>();
  for (const e of entries) {
    if (entryDefs.has(e.key)) {
      diagnostics.push({ code: "DUPLICATE_ENTRY", message: `条目键 ${e.key} 重复定义`, span: e.span, entry: e.key });
    } else entryDefs.set(e.key, e);
  }
  if (diagnostics.length) return { macros: [], entries: [], diagnostics };

  const charge = (len: number, span?: { start: number; end: number }) => {
    usedChars += len;
    if (usedChars > maxChars) {
      diagnostics.push({ code: "BUDGET_EXCEEDED", message: `展开字符数超过预算 ${maxChars}，导入失败`, span });
      throw abort;
    }
  };
  const abort = Symbol("abort");

  // ---- 宏展开：整库版本级求值，支持前向引用；缓存结果 ----
  const macroCache = new Map<string, string>();
  const expandExpr = (expr: ValueExpr, stack: string[], entry?: string, field?: string): string => {
    let out = "";
    for (const p of expr.pieces) {
      if (p.kind === "string" || p.kind === "number") { out += p.text; charge(p.text.length, p.span); continue; }
      const mNorm = norm(p.name);
      const idx = stack.indexOf(mNorm);
      if (idx >= 0) {
        const path = [...stack.slice(idx), mNorm];
        diagnostics.push({ code: "MACRO_CYCLE", message: `宏循环依赖: ${path.join(" -> ")}`, span: p.span, path, entry, field });
        throw abort;
      }
      const def = macroDefs.get(mNorm);
      if (!def) {
        diagnostics.push({ code: "UNDEFINED_MACRO", message: `未定义的宏 ${p.name}（依赖路径: ${[...stack, mNorm].join(" -> ")}）`, span: p.span, path: [...stack, mNorm], entry, field });
        throw abort;
      }
      if (++usedDeps > maxDeps) {
        diagnostics.push({ code: "BUDGET_EXCEEDED", message: `宏依赖数量超过预算 ${maxDeps}，导入失败`, span: p.span });
        throw abort;
      }
      if (stack.length + 1 > maxDepth) {
        diagnostics.push({ code: "DEPTH_EXCEEDED", message: `宏展开深度超过 ${maxDepth}`, span: p.span, path: [...stack, mNorm] });
        throw abort;
      }
      let v = macroCache.get(mNorm);
      if (v === undefined) {
        v = expandExpr(def.expr, [...stack, mNorm]);
        macroCache.set(mNorm, v);
      }
      out += v;
      charge(v.length, p.span);
    }
    return out;
  };

  try {
    // 先求值全部宏（整库版本语义，定义顺序无关）
    const macros = [...macroDefs.values()].map(d => ({ name: d.name, value: expandExpr(d.expr, [d.nameNorm]) }));

    // ---- 条目显式字段展开 ----
    const explicit = new Map<string, FieldValue[]>();
    for (const e of entries) {
      const seen = new Set<string>();
      const fields: FieldValue[] = [];
      for (const f of e.fields) {
        if (seen.has(f.nameNorm)) {
          diagnostics.push({ code: "DUPLICATE_FIELD", message: `条目 ${e.key} 中字段 ${f.name} 重复（大小写不敏感）`, span: f.span, entry: e.key, field: f.name });
          throw abort;
        }
        seen.add(f.nameNorm);
        // crossref 特判：单个未定义裸标识符按字面父条目键处理，其余情况正常展开
        const bareKey = f.nameNorm === CROSSREF && f.expr.pieces.length === 1 && f.expr.pieces[0].kind === "macro"
          && !macroDefs.has(norm((f.expr.pieces[0] as any).name))
          ? (f.expr.pieces[0] as any).name as string : undefined;
        const value = bareKey ?? expandExpr(f.expr, [], e.key, f.name);
        fields.push({ name: f.name, nameNorm: f.nameNorm, value, source: e.key, path: [e.key] });
      }
      explicit.set(e.key, fields);
    }

    // ---- crossref 继承：子覆盖父，普通字段逐层继承；键/类型/crossref 不继承 ----
    // 字段 path 以所在条目键开头（相对路径）；子条目继承时拼上自己的键。
    // 不做跨链缓存，避免父条目结果被某条查询链污染。
    const resolve = (key: string, chain: string[]): EntryResult => {
      const e = entryDefs.get(key)!;
      const own = explicit.get(key)!;
      const cross = own.find(f => f.nameNorm === CROSSREF);
      let inherited: FieldValue[] = [];
      if (cross) {
        const parentKey = cross.value;
        const ci = chain.indexOf(parentKey);
        if (ci >= 0) {
          const path = [...chain.slice(ci), parentKey];
          diagnostics.push({ code: "CROSSREF_CYCLE", message: `crossref 父链循环: ${path.join(" -> ")}`, entry: key, field: cross.name, path });
          throw abort;
        }
        if (!entryDefs.has(parentKey)) {
          diagnostics.push({ code: "CROSSREF_MISSING", message: `条目 ${key} 的 crossref 指向不存在的父条目 ${parentKey}`, entry: key, field: cross.name, path: [...chain, parentKey] });
          throw abort;
        }
        const parentRes = resolve(parentKey, [...chain, parentKey]);
        inherited = parentRes.fields
          .filter(f => !RESERVED.has(f.nameNorm))
          .map(f => ({ name: f.name, nameNorm: f.nameNorm, value: f.value, source: f.source, path: [key, ...f.path] }));
      }
      const ownNorms = new Set(own.map(f => f.nameNorm));
      const fields = [...own, ...inherited.filter(f => !ownNorms.has(f.nameNorm))];
      return { key, type: e.type, fields, explicitFields: own };
    };

    const results = entries.map(e => resolve(e.key, [e.key]));
    if (diagnostics.length) return { macros: [], entries: [], diagnostics };
    return { macros, entries: results, diagnostics };
  } catch (e) {
    if (e === abort) return { macros: [], entries: [], diagnostics };
    throw e;
  }
}
