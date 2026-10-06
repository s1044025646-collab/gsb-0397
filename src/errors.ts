/** 错误码与诊断类型。所有可预期失败都用这些码，不抛裸 Error 给调用方。 */
export type ErrCode =
  | "PARSE_ERROR"            // 词法/语法错误，带源区间
  | "UNSUPPORTED_DIRECTIVE"  // 非支持集合的 @指令
  | "DUPLICATE_MACRO"        // 规范化后重复的宏名
  | "DUPLICATE_FIELD"        // 同条目内规范化后重复字段
  | "DUPLICATE_ENTRY"        // 重复条目键（区分大小写）
  | "UNDEFINED_MACRO"        // 引用未定义宏
  | "MACRO_CYCLE"            // 宏循环，带依赖路径
  | "CROSSREF_MISSING"       // 父条目缺失
  | "CROSSREF_CYCLE"         // 父链循环，带路径
  | "DEPTH_EXCEEDED"         // 嵌套/展开深度超限
  | "BUDGET_EXCEEDED"        // 展开字符数或依赖数超限
  | "VALIDATION_ERROR"       // API/CLI 参数校验
  | "NOT_FOUND"              // 版本/条目/字段不存在
  | "INTERNAL";

export interface Span { start: number; end: number } // 半开区间 [start, end)，按 UTF-16 码元偏移

export interface Diagnostic {
  code: ErrCode;
  message: string;
  span?: Span;        // 源文本区间（语法错误必有）
  path?: string[];    // 依赖路径（宏循环 / crossref 循环）
  entry?: string;     // 相关条目键
  field?: string;     // 相关字段名（原始大小写）
}

export class BibError extends Error {
  constructor(public diag: Diagnostic) { super(diag.message); }
}

export const norm = (s: string): string => s.toUpperCase(); // ASCII 大小写不敏感规范化
