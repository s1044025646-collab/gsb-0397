import { Diagnostic, Span, norm } from "./errors.js";

/** 值表达式 AST：外层定界符已剥离，内部花括号/反斜杠原文保留。 */
export type ValuePiece =
  | { kind: "string"; text: string; span: Span }   // 引号串或花括号串的内容
  | { kind: "number"; text: string; span: Span }   // 十进制字面量原文
  | { kind: "macro"; name: string; span: Span };   // 宏引用（保留原始大小写）

export interface ValueExpr { pieces: ValuePiece[]; span: Span }
export interface FieldDef { name: string; nameNorm: string; expr: ValueExpr; span: Span }
export interface EntryDef { type: string; key: string; fields: FieldDef[]; span: Span }
export interface StringDef { name: string; nameNorm: string; expr: ValueExpr; span: Span }

export interface ParseResult {
  strings: StringDef[];
  entries: EntryDef[];
  diagnostics: Diagnostic[]; // 非空即导入失败
}

export const SUPPORTED_TYPES = new Set(["book", "article", "inproceedings", "proceedings", "misc"].map(norm));

export interface ParseOptions { maxNestDepth?: number }
const DEFAULT_MAX_NEST = 64;

/** 手写的受限 BibTeX 解析器：不做任何正则切分，逐字符扫描并记录源区间。 */
export function parseLibrary(text: string, opts: ParseOptions = {}): ParseResult {
  const maxNest = opts.maxNestDepth ?? DEFAULT_MAX_NEST;
  const diagnostics: Diagnostic[] = [];
  const strings: StringDef[] = [];
  const entries: EntryDef[] = [];
  let pos = 0;
  const n = text.length;

  const err = (code: Diagnostic["code"], message: string, span: Span, extra?: Partial<Diagnostic>) => {
    diagnostics.push({ code, message, span, ...extra });
  };
  const skipWs = () => { while (pos < n && /\s/.test(text[pos])) pos++; };
  const isNameStart = (c: string) => /[A-Za-z]/.test(c);
  const isNameChar = (c: string) => /[A-Za-z0-9_:-]/.test(c);

  while (pos < n) {
    skipWs();
    if (pos >= n) break;
    if (text[pos] !== "@") {
      // 顶层只允许空白与 @指令；注释等内容视为错误，不静默跳过
      const start = pos;
      while (pos < n && text[pos] !== "@") pos++;
      err("PARSE_ERROR", "顶层存在不属于任何指令的内容", { start, end: pos });
      continue;
    }
    const atPos = pos++;
    skipWs();
    const nameStart = pos;
    while (pos < n && /[A-Za-z]/.test(text[pos])) pos++;
    if (pos === nameStart) { err("PARSE_ERROR", "@ 后缺少指令名", { start: atPos, end: pos }); continue; }
    const directive = text.slice(nameStart, pos);
    const dNorm = norm(directive);
    skipWs();
    if (pos >= n || (text[pos] !== "{" && text[pos] !== "(")) {
      err("PARSE_ERROR", `指令 @${directive} 后缺少 { 或 (`, { start: atPos, end: pos });
      break;
    }
    const open = text[pos];
    const close = open === "{" ? "}" : ")";
    pos++;

    if (dNorm === "STRING") {
      const def = parseStringBody(atPos, close);
      if (def) strings.push(def);
    } else if (SUPPORTED_TYPES.has(dNorm)) {
      const ent = parseEntryBody(directive, atPos, close);
      if (ent) entries.push(ent);
    } else {
      // 其他指令（如 @preamble/@comment/未知类型）明确拒绝
      err("UNSUPPORTED_DIRECTIVE", `不支持的指令 @${directive}，仅支持 @string/book/article/inproceedings/proceedings/misc`, { start: atPos, end: pos });
      skipBalanced(close);
    }
  }

  return { strings, entries, diagnostics };

  function skipBalanced(close: string) {
    let depth = 1;
    while (pos < n && depth > 0) {
      const c = text[pos++];
      if (c === "{" || c === "(") depth++;
      else if (c === "}" || c === ")") depth--;
    }
  }

  function parseStringBody(atPos: number, close: string): StringDef | null {
    skipWs();
    const start = pos;
    if (pos >= n || !isNameStart(text[pos])) { err("PARSE_ERROR", "@string 缺少宏名", { start, end: pos }); skipBalanced(close); return null; }
    while (pos < n && isNameChar(text[pos])) pos++;
    const name = text.slice(start, pos);
    skipWs();
    if (text[pos] !== "=") { err("PARSE_ERROR", "@string 宏名后缺少 =", { start: pos, end: pos + 1 }); skipBalanced(close); return null; }
    pos++;
    const expr = parseValue();
    if (!expr) { skipBalanced(close); return null; }
    skipWs();
    if (pos >= n || text[pos] !== close) { err("PARSE_ERROR", "@string 缺少结束定界符", { start: atPos, end: pos }); return null; }
    pos++;
    return { name, nameNorm: norm(name), expr, span: { start: atPos, end: pos } };
  }

  function parseEntryBody(type: string, atPos: number, close: string): EntryDef | null {
    skipWs();
    const keyStart = pos;
    while (pos < n && text[pos] !== "," && text[pos] !== close && !/\s/.test(text[pos])) pos++;
    const key = text.slice(keyStart, pos);
    if (!key) { err("PARSE_ERROR", "条目缺少引用键", { start: atPos, end: pos }); skipBalanced(close); return null; }
    skipWs();
    const fields: FieldDef[] = [];
    if (text[pos] === ",") pos++;
    while (true) {
      skipWs();
      if (pos >= n) { err("PARSE_ERROR", "条目未正常结束", { start: atPos, end: pos }); return null; }
      if (text[pos] === close) { pos++; break; }
      const fStart = pos;
      if (!isNameStart(text[pos])) { err("PARSE_ERROR", "字段名无效", { start: pos, end: pos + 1 }, { entry: key }); return null; }
      while (pos < n && isNameChar(text[pos])) pos++;
      const fname = text.slice(fStart, pos);
      skipWs();
      if (text[pos] !== "=") { err("PARSE_ERROR", `字段 ${fname} 后缺少 =`, { start: pos, end: pos + 1 }, { entry: key, field: fname }); return null; }
      pos++;
      const expr = parseValue();
      if (!expr) return null;
      fields.push({ name: fname, nameNorm: norm(fname), expr, span: { start: fStart, end: pos } });
      skipWs();
      if (text[pos] === ",") { pos++; continue; }
      if (text[pos] === close) { pos++; break; }
      err("PARSE_ERROR", "字段后缺少逗号或结束定界符", { start: pos, end: Math.min(pos + 1, n) }, { entry: key });
      return null;
    }
    return { type, key, fields, span: { start: atPos, end: pos } };
  }

  /** 解析 值 := 片段 (# 片段)*，片段为 引号串 | 花括号串 | 十进制数 | 宏引用 */
  function parseValue(): ValueExpr | null {
    const pieces: ValuePiece[] = [];
    const vStart = pos;
    while (true) {
      skipWs();
      if (pos >= n) { err("PARSE_ERROR", "值表达式未结束", { start: vStart, end: pos }); return null; }
      const c = text[pos];
      if (c === "\"") {
        const s = parseQuoted();
        if (!s) return null;
        pieces.push(s);
      } else if (c === "{") {
        const s = parseBraced();
        if (!s) return null;
        pieces.push(s);
      } else if (/[0-9]/.test(c)) {
        const start = pos;
        while (pos < n && /[0-9]/.test(text[pos])) pos++;
        pieces.push({ kind: "number", text: text.slice(start, pos), span: { start, end: pos } });
      } else if (isNameStart(c)) {
        const start = pos;
        while (pos < n && isNameChar(text[pos])) pos++;
        pieces.push({ kind: "macro", name: text.slice(start, pos), span: { start, end: pos } });
      } else {
        err("PARSE_ERROR", `值表达式中出现意外字符 '${c}'`, { start: pos, end: pos + 1 });
        return null;
      }
      skipWs();
      if (text[pos] === "#") { pos++; continue; }
      break;
    }
    return { pieces, span: { start: vStart, end: pos } };
  }

  /** 引号串：内部花括号需平衡，深度 0 处的引号结束；逗号/等号/# 均为普通内容。 */
  function parseQuoted(): ValuePiece | null {
    const start = pos; // 指向开引号
    pos++;
    let depth = 0;
    const contentStart = pos;
    while (pos < n) {
      const c = text[pos];
      if (c === "{") depth++;
      else if (c === "}") {
        if (depth === 0) { err("PARSE_ERROR", "引号串内出现未匹配的 }", { start: pos, end: pos + 1 }); return null; }
        depth--;
      } else if (c === "\"" && depth === 0) {
        const text_ = text.slice(contentStart, pos);
        pos++;
        return { kind: "string", text: text_, span: { start, end: pos } };
      }
      pos++;
      if (depth > maxNest) { err("DEPTH_EXCEEDED", `引号串内花括号嵌套超过 ${maxNest} 层`, { start, end: pos }); return null; }
    }
    err("PARSE_ERROR", "引号串未闭合", { start, end: pos });
    return null;
  }

  /** 花括号串：剥掉最外层定界符，内部内容（含花括号与反斜杠）原样保留。 */
  function parseBraced(): ValuePiece | null {
    const start = pos; // 指向 {
    pos++;
    let depth = 1;
    const contentStart = pos;
    while (pos < n) {
      const c = text[pos];
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          const text_ = text.slice(contentStart, pos);
          pos++;
          return { kind: "string", text: text_, span: { start, end: pos } };
        }
      }
      pos++;
      if (depth > maxNest) { err("DEPTH_EXCEEDED", `花括号嵌套超过 ${maxNest} 层`, { start, end: pos }); return null; }
    }
    err("PARSE_ERROR", "花括号串未闭合", { start, end: pos });
    return null;
  }
}
