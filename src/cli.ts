import { readFileSync } from "node:fs";
import { Service } from "./service.js";
import { Store } from "./store.js";
import { startServer } from "./server.js";
import { BibError } from "./errors.js";

const USAGE = `用法: node dist/src/cli.js [--db 数据文件] <命令> [参数]

命令:
  serve [--port N]                 启动 HTTP API（默认自动选空闲端口）
  import <文件.bib>                导入 UTF-8 文本，创建新版本
  versions                         列出所有版本
  list [--version N]               列出条目
  expand <条目键> [字段] [--version N]  展开字段（含来源链）
  provenance <键> <字段> [--version N] 查询字段来源链
  diagnostics <版本N>              查看某版本诊断
  diff <版本A> <版本B>             比较两个版本
  export [--version N]             导出结构化 JSON
`;

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
function positional(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) { i++; continue; }
    out.push(args[i]);
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const db = arg(args, "--db") ?? "data/bibtex.db";
  const rest = args.filter((a, i) => a !== "--db" && args[i - 1] !== "--db");
  const cmd = rest[0];
  const pos = positional(rest.slice(1));
  const ver = () => { const v = arg(rest, "--version"); return v ? Number(v) : undefined; };

  if (cmd === "serve") {
    const p = arg(rest, "--port");
    await startServer(db, p ? Number(p) : 0);
    return;
  }
  const svc = new Service(new Store(db));
  const out = (x: unknown) => console.log(JSON.stringify(x, null, 2));
  try {
    switch (cmd) {
      case "import": {
        if (!pos[0]) throw new BibError({ code: "VALIDATION_ERROR", message: "缺少 .bib 文件路径" });
        const text = readFileSync(pos[0], "utf8");
        const r = svc.import(text);
        out(r);
        if (r.status !== "ok") process.exitCode = 2;
        break;
      }
      case "versions": out({ versions: svc.store.listVersions(), current: svc.store.currentVersion() }); break;
      case "list": out(svc.listEntries(ver())); break;
      case "expand":
        if (!pos[0]) throw new BibError({ code: "VALIDATION_ERROR", message: "缺少条目键" });
        out(pos[1] ? svc.provenance(pos[0], pos[1], ver()) : svc.expandEntry(pos[0], ver()));
        break;
      case "provenance":
        if (!pos[0] || !pos[1]) throw new BibError({ code: "VALIDATION_ERROR", message: "缺少条目键或字段名" });
        out(svc.provenance(pos[0], pos[1], ver()));
        break;
      case "diagnostics":
        if (!pos[0]) throw new BibError({ code: "VALIDATION_ERROR", message: "缺少版本号" });
        out(svc.diagnostics(Number(pos[0])));
        break;
      case "diff":
        if (!pos[0] || !pos[1]) throw new BibError({ code: "VALIDATION_ERROR", message: "缺少两个版本号" });
        out(svc.diff(Number(pos[0]), Number(pos[1])));
        break;
      case "export": out(svc.export(ver())); break;
      default: process.stdout.write(USAGE); if (cmd) process.exitCode = 2;
    }
  } catch (e) {
    if (e instanceof BibError) { out({ error: e.diag }); process.exitCode = 2; }
    else throw e;
  } finally {
    svc.store.close();
  }
}
main();
