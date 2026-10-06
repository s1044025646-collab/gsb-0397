import { parseLibrary } from "./parser.js";
import { evaluate, Budgets } from "./evaluator.js";
import { Store, RULE_VERSION } from "./store.js";
import { BibError, norm } from "./errors.js";

export interface ImportOptions extends Budgets { maxNestDepth?: number }

/** 领域服务：导入、查询、比较、导出。查询一律只读，绝不回写父条目或旧版本。 */
export class Service {
  constructor(public store: Store) {}

  import(text: string, options: ImportOptions = {}) {
    if (typeof text !== "string") throw new BibError({ code: "VALIDATION_ERROR", message: "text 必须是 UTF-8 字符串" });
    const parsed = parseLibrary(text, { maxNestDepth: options.maxNestDepth });
    if (parsed.diagnostics.length) {
      const vid = this.store.saveVersion({ status: "failed", sourceText: text, options, diagnostics: parsed.diagnostics });
      return { version: vid, status: "failed" as const, diagnostics: parsed.diagnostics };
    }
    const evaluated = evaluate(parsed.strings, parsed.entries, options);
    if (evaluated.diagnostics.length) {
      const vid = this.store.saveVersion({ status: "failed", sourceText: text, options, diagnostics: evaluated.diagnostics });
      return { version: vid, status: "failed" as const, diagnostics: evaluated.diagnostics };
    }
    const expanded = evaluated.entries.flatMap(e => [
      ...e.explicitFields.map(f => ({ entryKey: e.key, name: f.name, nameNorm: f.nameNorm, value: f.value, source: f.source, path: f.path, explicit: true })),
      ...e.fields.filter(f => !e.explicitFields.some(x => x.nameNorm === f.nameNorm))
        .map(f => ({ entryKey: e.key, name: f.name, nameNorm: f.nameNorm, value: f.value, source: f.source, path: f.path, explicit: false })),
    ]);
    const vid = this.store.saveVersion({
      status: "ok", sourceText: text, options, diagnostics: [],
      macros: evaluated.macros.map(m => {
        const def = parsed.strings.find(s => s.name === m.name)!;
        return { name: m.name, nameNorm: norm(m.name), expr: def.expr, value: m.value };
      }),
      entries: parsed.entries.map(e => ({ key: e.key, type: e.type, fields: e.fields.map(f => ({ name: f.name, expr: f.expr })) })),
      expanded,
    });
    return { version: vid, status: "ok" as const, diagnostics: [] };
  }

  private okVersion(version?: number): number {
    const vid = version ?? this.store.currentVersion();
    if (vid == null) throw new BibError({ code: "NOT_FOUND", message: "尚无可用的库版本" });
    const v = this.store.getVersion(vid);
    if (!v) throw new BibError({ code: "NOT_FOUND", message: `版本 ${vid} 不存在` });
    if (v.status !== "ok") throw new BibError({ code: "VALIDATION_ERROR", message: `版本 ${vid} 是失败导入，仅可查询诊断` });
    return vid;
  }

  listEntries(version?: number) {
    const vid = this.okVersion(version);
    return { version: vid, entries: this.store.listEntries(vid) };
  }

  /** 展开某条目全部有效字段，附来源链；只读。 */
  expandEntry(key: string, version?: number) {
    const vid = this.okVersion(version);
    const fields = this.store.getFields(vid, key);
    if (!fields.length && !this.store.listEntries(vid).some(e => e.key === key))
      throw new BibError({ code: "NOT_FOUND", message: `版本 ${vid} 中不存在条目 ${key}` });
    const entry = this.store.listEntries(vid).find(e => e.key === key)!;
    return { version: vid, key, type: entry.type, fields };
  }

  provenance(key: string, field: string, version?: number) {
    const res = this.expandEntry(key, version);
    const f = res.fields.find(x => norm(x.name) === norm(field));
    if (!f) throw new BibError({ code: "NOT_FOUND", message: `条目 ${key} 没有字段 ${field}` });
    return { version: res.version, key, field: f.name, value: f.value, source: f.source, path: f.path, explicit: f.explicit };
  }

  diagnostics(version: number) {
    const v = this.store.getVersion(version);
    if (!v) throw new BibError({ code: "NOT_FOUND", message: `版本 ${version} 不存在` });
    return { version, status: v.status, diagnostics: this.store.getDiagnostics(version) };
  }

  /** 比较两个已通过版本的有效字段展开结果。 */
  diff(from: number, to: number) {
    const a = this.okVersion(from), b = this.okVersion(to);
    const map = (vid: number) => {
      const m = new Map<string, Map<string, { value: string; source: string }>>();
      for (const e of this.store.listEntries(vid)) {
        const fm = new Map<string, { value: string; source: string }>();
        for (const f of this.store.getFields(vid, e.key)) fm.set(norm(f.name), { value: f.value, source: f.source });
        m.set(e.key, fm);
      }
      return m;
    };
    const ma = map(a), mb = map(b);
    const changes: any[] = [];
    for (const key of new Set([...ma.keys(), ...mb.keys()])) {
      const ea = ma.get(key), eb = mb.get(key);
      if (!ea) { changes.push({ entry: key, kind: "entry_added" }); continue; }
      if (!eb) { changes.push({ entry: key, kind: "entry_removed" }); continue; }
      for (const fn of new Set([...ea.keys(), ...eb.keys()])) {
        const fa = ea.get(fn), fb = eb.get(fn);
        if (!fa) changes.push({ entry: key, field: fn, kind: "field_added", to: fb });
        else if (!fb) changes.push({ entry: key, field: fn, kind: "field_removed", from: fa });
        else if (fa.value !== fb.value || fa.source !== fb.source)
          changes.push({ entry: key, field: fn, kind: "field_changed", from: fa, to: fb });
      }
    }
    return { from: a, to: b, changes };
  }

  /** 导出结构化结果：原始表达式、展开值、继承来源分离。 */
  export(version?: number) {
    const vid = this.okVersion(version);
    const v = this.store.getVersion(vid);
    return {
      version: vid,
      ruleVersion: RULE_VERSION,
      semantics: "受限字段继承：子显式字段覆盖父同名有效字段；键/类型/crossref 不继承；不做隐含改名",
      macros: this.store.getMacros(vid),
      entries: this.store.listEntries(vid).map(e => ({
        key: e.key, type: e.type,
        rawFields: e.fields,                       // 原始表达式 AST
        effectiveFields: this.store.getFields(vid, e.key), // 展开值 + 来源链
      })),
      diagnostics: this.store.getDiagnostics(vid),
      sourceText: v.sourceText,
    };
  }
}
