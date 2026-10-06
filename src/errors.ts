export type ErrorCode =
  | "PARSE_ERROR"
  | "UNSUPPORTED_DIRECTIVE"
  | "DUPLICATE_ENTRY"
  | "DUPLICATE_FIELD"
  | "DUPLICATE_MACRO"
  | "MACRO_UNDEFINED"
  | "MACRO_CYCLE"
  | "CROSSREF_MISSING"
  | "CROSSREF_CYCLE"
  | "BUDGET_EXCEEDED"
  | "VALIDATION_ERROR"
  | "NOT_FOUND";

export class BibError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public start?: number,
    public end?: number,
    public detail?: unknown
  ) {
    super(message);
    this.name = "BibError";
  }
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      start: this.start,
      end: this.end,
      detail: this.detail,
    };
  }
}

export interface Diagnostic {
  code: ErrorCode;
  message: string;
  start?: number;
  end?: number;
  entryKey?: string;
  field?: string;
  detail?: unknown;
}
