import { BibError } from "./errors";

export type ValuePart =
  | { kind: "string"; value: string }
  | { kind: "number"; value: string }
  | { kind: "macro"; name: string };

export interface ValueExpr {
  parts: ValuePart[];
  start: number;
  end: number;
}

export interface FieldNode {
  name: string;
  expr: ValueExpr;
  start: number;
  end: number;
}

export interface EntryNode {
  kind: "entry";
  type: string;
  key: string;
  fields: FieldNode[];
  start: number;
  end: number;
}

export interface StringNode {
  kind: "string";
  name: string;
  expr: ValueExpr;
  start: number;
  end: number;
}

export type TopNode = EntryNode | StringNode;

export const ALLOWED_ENTRY_TYPES = new Set([
  "book",
  "article",
  "inproceedings",
  "proceedings",
  "misc",
]);

const MAX_NEST_DEPTH = 256;

class Parser {
  pos = 0;
  constructor(public src: string) {}

  eof(): boolean {
    return this.pos >= this.src.length;
  }
  peek(): string {
    return this.src[this.pos];
  }
  skipWs(): void {
    while (!this.eof() && /\s/.test(this.src[this.pos])) this.pos++;
  }
  error(msg: string, start: number, end: number): never {
    throw new BibError("PARSE_ERROR", msg, start, end);
  }
  readIdent(): { name: string; start: number; end: number } {
    const start = this.pos;
    while (!this.eof() && /[A-Za-z0-9_:\-./]/.test(this.src[this.pos])) this.pos++;
    if (this.pos === start) this.error("此处应为标识符", start, start + 1);
    return { name: this.src.slice(start, this.pos), start, end: this.pos };
  }

  parseAll(): TopNode[] {
    const nodes: TopNode[] = [];
    if (this.src.charCodeAt(0) === 0xfeff) this.pos = 1;
    while (true) {
      this.skipWs();
      if (this.eof()) break;
      if (this.peek() !== "@") {
        this.error("顶层只允许 @ 指令", this.pos, this.pos + 1);
      }
      nodes.push(this.parseDirective());
    }
    return nodes;
  }

  parseDirective(): TopNode {
    const at = this.pos;
    this.pos++; // '@'
    const id = this.readIdent();
    const lower = id.name.toLowerCase();
    this.skipWs();
    if (lower === "string") {
      return this.parseString(at);
    }
    if (!ALLOWED_ENTRY_TYPES.has(lower)) {
      throw new BibError(
        "UNSUPPORTED_DIRECTIVE",
        `不支持的指令 @${id.name}：仅支持 book/article/inproceedings/proceedings/misc 与 @string`,
        at,
        this.pos
      );
    }
    return this.parseEntry(lower, at);
  }

  private expectOpen(): number {
    this.skipWs();
    const ch = this.peek();
    if (ch !== "{" && ch !== "(") {
      this.error("此处应为 '{' 或 '('", this.pos, this.pos + 1);
    }
    this.pos++;
    return this.pos - 1;
  }

  parseString(at: number): StringNode {
    this.expectOpen();
    this.skipWs();
    const id = this.readIdent();
    this.skipWs();
    if (this.peek() !== "=") this.error("@string 中应为 '='", this.pos, this.pos + 1);
    this.pos++;
    const expr = this.parseValue();
    this.skipWs();
    const close = this.peek();
    if (close !== "}" && close !== ")") {
      this.error("@string 结尾应为 '}' 或 ')'", this.pos, this.pos + 1);
    }
    this.pos++;
    return { kind: "string", name: id.name, expr, start: at, end: this.pos };
  }

  parseEntry(type: string, at: number): EntryNode {
    this.expectOpen();
    this.skipWs();
    const keyStart = this.pos;
    while (!this.eof() && this.peek() !== "," && this.peek() !== "}" && this.peek() !== ")") {
      this.pos++;
    }
    const key = this.src.slice(keyStart, this.pos).trim();
    if (key.length === 0) this.error("条目键不能为空", keyStart, this.pos);
    this.skipWs();
    const fields: FieldNode[] = [];
    if (this.peek() === ",") {
      this.pos++;
      while (true) {
        this.skipWs();
        const ch = this.peek();
        if (ch === "}" || ch === ")") {
          this.pos++;
          break;
        }
        if (this.eof()) this.error("条目未闭合", at, this.pos);
        const fStart = this.pos;
        const fname = this.readIdent();
        this.skipWs();
        if (this.peek() !== "=") this.error("字段名后应为 '='", this.pos, this.pos + 1);
        this.pos++;
        const expr = this.parseValue();
        fields.push({
          name: fname.name,
          expr,
          start: fStart,
          end: expr.end,
        });
        this.skipWs();
        const sep = this.peek();
        if (sep === ",") {
          this.pos++;
          continue;
        }
        if (sep === "}" || sep === ")") {
          this.pos++;
          break;
        }
        this.error("字段之间应为 ',' 或条目结束", this.pos, this.pos + 1);
      }
    } else if (this.peek() === "}" || this.peek() === ")") {
      this.pos++;
    } else {
      this.error("条目键后应为 ',' 或条目结束", this.pos, this.pos + 1);
    }
    return { kind: "entry", type, key, fields, start: at, end: this.pos };
  }

  parseValue(): ValueExpr {
    const start = this.pos;
    const parts: ValuePart[] = [];
    while (true) {
      this.skipWs();
      const ch = this.peek();
      if (ch === '"') {
        parts.push({ kind: "string", value: this.parseQuoted() });
      } else if (ch === "{") {
        parts.push({ kind: "string", value: this.parseBraced(0) });
      } else if (/[0-9]/.test(ch)) {
        const nStart = this.pos;
        while (!this.eof() && /[0-9]/.test(this.src[this.pos])) this.pos++;
        parts.push({ kind: "number", value: this.src.slice(nStart, this.pos) });
      } else if (/[A-Za-z_]/.test(ch)) {
        const id = this.readIdent();
        parts.push({ kind: "macro", name: id.name });
      } else {
        this.error("值应为字符串、数字或宏名", this.pos, this.pos + 1);
      }
      this.skipWs();
      if (this.peek() === "#") {
        this.pos++;
        continue;
      }
      break;
    }
    return { parts, start, end: this.pos };
  }

  parseQuoted(): string {
    // 外层引号不属于值；内部花括号与反斜杠原样保留
    this.pos++; // opening "
    const out: string[] = [];
    let depth = 0;
    while (!this.eof()) {
      const ch = this.src[this.pos];
      if (ch === "{") {
        depth++;
        if (depth > MAX_NEST_DEPTH) this.error("花括号嵌套过深", this.pos, this.pos + 1);
        out.push(ch);
        this.pos++;
      } else if (ch === "}") {
        if (depth === 0) this.error("引号字符串内出现未匹配的 '}'", this.pos, this.pos + 1);
        depth--;
        out.push(ch);
        this.pos++;
      } else if (ch === '"' && depth === 0) {
        this.pos++;
        return out.join("");
      } else {
        out.push(ch);
        this.pos++;
      }
    }
    this.error("引号字符串未闭合", this.pos, this.pos);
  }

  parseBraced(depth: number): string {
    // 外层花括号不属于值；内层原样保留
    this.pos++; // opening {
    const out: string[] = [];
    while (!this.eof()) {
      const ch = this.src[this.pos];
      if (ch === "{") {
        if (depth + 1 > MAX_NEST_DEPTH) this.error("花括号嵌套过深", this.pos, this.pos + 1);
        out.push(ch);
        out.push(this.parseBraced(depth + 1));
        out.push(this.src[this.pos - 1]); // closing brace consumed by recursion
      } else if (ch === "}") {
        this.pos++;
        return out.join("");
      } else {
        out.push(ch);
        this.pos++;
      }
    }
    this.error("花括号字符串未闭合", this.pos, this.pos);
  }
}

export function parseBibtex(src: string): TopNode[] {
  return new Parser(src).parseAll();
}
