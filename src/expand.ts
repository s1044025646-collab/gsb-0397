import { BibError } from "./errors";
import { EntryNode, ValueExpr } from "./parser";

export interface Budget {
  maxDepth: number; // 宏/继承递归最大深度
  maxChars: number; // 展开输出最大字符数
  maxDeps: number; // 单次展开允许的最大依赖（宏求值）次数
}

export const DEFAULT_BUDGET: Budget = {
  maxDepth: 64,
  maxChars: 1_000_000,
  maxDeps: 10_000,
};

export interface MacroTable {
  // key: ASCII 小写宏名
  get(nameLower: string): ValueExpr | undefined;
}

export class Expander {
  private chars = 0;
  private deps = 0;
  constructor(
    private macros: MacroTable,
    private budget: Budget = DEFAULT_BUDGET
  ) {}

  expandExpr(expr: ValueExpr, macroStack: string[] = [], depth = 0): string {
    if (depth > this.budget.maxDepth) {
      throw new BibError("BUDGET_EXCEEDED", `展开深度超过预算 ${this.budget.maxDepth}`);
    }
    let out = "";
    for (const part of expr.parts) {
      let piece: string;
      if (part.kind === "macro") {
        const lower = part.name.toLowerCase();
        const idx = macroStack.indexOf(lower);
        if (idx >= 0) {
          const cycle = [...macroStack.slice(idx), lower].join(" -> ");
          throw new BibError("MACRO_CYCLE", `宏循环依赖：${cycle}`, expr.start, expr.end, {
            path: [...macroStack.slice(idx), lower],
          });
        }
        const def = this.macros.get(lower);
        if (!def) {
          const path = [...macroStack, lower];
          throw new BibError(
            "MACRO_UNDEFINED",
            `未定义的宏 '${part.name}'，依赖路径：${path.join(" -> ")}`,
            expr.start,
            expr.end,
            { path }
          );
        }
        this.deps++;
        if (this.deps > this.budget.maxDeps) {
          throw new BibError("BUDGET_EXCEEDED", `依赖数量超过预算 ${this.budget.maxDeps}`);
        }
        piece = this.expandExpr(def, [...macroStack, lower], depth + 1);
      } else {
        piece = part.value;
      }
      this.chars += piece.length;
      if (this.chars > this.budget.maxChars) {
        throw new BibError("BUDGET_EXCEEDED", `展开字符数超过预算 ${this.budget.maxChars}`);
      }
      out += piece;
    }
    return out;
  }
}

export interface EffectiveField {
  name: string; // 原始字段名（取定义处的写法）
  value: string; // 展开后的值
  sourceKey: string; // 实际来源条目键
  path: string[]; // 继承路径，子条目在前
  raw: ValueExpr; // 来源条目中的原始表达式
}

export interface EntryResult {
  key: string;
  type: string;
  fields: Record<string, EffectiveField>; // key: 字段名小写
  diagnostics: import("./errors").Diagnostic[];
}

const NON_INHERITED = new Set(["crossref"]);

export function resolveEntry(
  key: string,
  entries: Map<string, EntryNode>,
  macros: MacroTable,
  budget: Budget = DEFAULT_BUDGET,
  chain: string[] = [],
  depth = 0
): EntryResult {
  const diagnostics: import("./errors").Diagnostic[] = [];
  const entry = entries.get(key);
  if (!entry) {
    throw new BibError("NOT_FOUND", `条目 '${key}' 不存在`);
  }
  if (depth > budget.maxDepth) {
    throw new BibError("BUDGET_EXCEEDED", `继承链深度超过预算 ${budget.maxDepth}`);
  }

  // 解析 crossref（若存在）
  let parentKey: string | undefined;
  const crossrefField = entry.fields.find((f) => f.name.toLowerCase() === "crossref");
  if (crossrefField) {
    try {
      parentKey = new Expander(macros, budget).expandExpr(crossrefField.expr);
    } catch (e) {
      if (e instanceof BibError) {
        diagnostics.push({ ...e.toJSON(), entryKey: key, field: "crossref" });
      } else throw e;
    }
  }

  // 先解析父链
  let inherited: Record<string, EffectiveField> = {};
  if (parentKey !== undefined) {
    const cycleIdx = chain.indexOf(parentKey);
    if (cycleIdx >= 0 || parentKey === key) {
      const path = parentKey === key ? [key, parentKey] : [...chain.slice(cycleIdx), parentKey];
      diagnostics.push({
        code: "CROSSREF_CYCLE",
        message: `crossref 父链循环：${path.join(" -> ")}`,
        entryKey: key,
        field: "crossref",
        detail: { path },
      });
    } else if (!entries.has(parentKey)) {
      diagnostics.push({
        code: "CROSSREF_MISSING",
        message: `crossref 引用的父条目 '${parentKey}' 不存在`,
        entryKey: key,
        field: "crossref",
        detail: { parentKey },
      });
    } else {
      const parent = resolveEntry(parentKey, entries, macros, budget, [...chain, key], depth + 1);
      diagnostics.push(...parent.diagnostics);
      for (const [fname, f] of Object.entries(parent.fields)) {
        if (NON_INHERITED.has(fname)) continue;
        inherited[fname] = { ...f, path: [key, ...f.path] };
      }
    }
  }

  // 子条目显式字段覆盖继承字段
  const fields: Record<string, EffectiveField> = { ...inherited };
  for (const f of entry.fields) {
    const lower = f.name.toLowerCase();
    if (lower === "crossref") continue; // crossref 本身不作为有效字段暴露
    try {
      const value = new Expander(macros, budget).expandExpr(f.expr);
      fields[lower] = { name: f.name, value, sourceKey: key, path: [key], raw: f.expr };
    } catch (e) {
      if (e instanceof BibError) {
        diagnostics.push({ ...e.toJSON(), entryKey: key, field: f.name });
        delete fields[lower]; // 失败字段不返回截断值
      } else throw e;
    }
  }

  return { key, type: entry.type, fields, diagnostics };
}
