#!/usr/bin/env node
import fs from "node:fs";
import { openDb } from "./db";
import { listen } from "./api";
import {
  compareVersions,
  exportVersion,
  getDiagnostics,
  getEntryFields,
  getFieldOrigin,
  importSource,
  listEntries,
} from "./service";
import { BibError } from "./errors";

const DEMO = `@string{press = {青山}}

@book{P,
  publisher = press,
  year = 2026
}

@misc{C,
  crossref = {P},
  title = {中文 {API}},
  year = 2027
}
`;

function print(x: unknown): void {
  console.log(JSON.stringify(x, null, 2));
}

function parseVersionFlag(args: string[]): number | undefined {
  const i = args.indexOf("--version");
  if (i < 0) return undefined;
  const n = Number(args[i + 1]);
  if (!Number.isInteger(n) || n <= 0) throw new BibError("VALIDATION_ERROR", "--version 必须是正整数");
  return n;
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  const db = openDb();
  const version = parseVersionFlag(args);
  const rest = args.filter((a, i) => a !== "--version" && args[i - 1] !== "--version");

  switch (cmd) {
    case "import": {
      const file = rest[0];
      if (!file) throw new BibError("VALIDATION_ERROR", "用法: import <file.bib>");
      const source = fs.readFileSync(file, "utf8");
      print(importSource(db, source));
      break;
    }
    case "list":
      print(listEntries(db, version));
      break;
    case "show": {
      if (!rest[0]) throw new BibError("VALIDATION_ERROR", "用法: show <key> [--version N]");
      print(getEntryFields(db, rest[0], version));
      break;
    }
    case "origin": {
      if (!rest[0] || !rest[1]) throw new BibError("VALIDATION_ERROR", "用法: origin <key> <field> [--version N]");
      print(getFieldOrigin(db, rest[0], rest[1], version));
      break;
    }
    case "diagnostics":
      print(getDiagnostics(db, version));
      break;
    case "compare": {
      const [from, to] = rest.map(Number);
      if (!Number.isInteger(from) || !Number.isInteger(to)) {
        throw new BibError("VALIDATION_ERROR", "用法: compare <fromVersion> <toVersion>");
      }
      print(compareVersions(db, from, to));
      break;
    }
    case "export":
      print(exportVersion(db, version));
      break;
    case "serve": {
      const pi = rest.indexOf("--port");
      const port = pi >= 0 ? Number(rest[pi + 1]) : undefined;
      if (pi >= 0 && (!Number.isInteger(port) || port! < 0 || port! > 65535)) {
        throw new BibError("VALIDATION_ERROR", "--port 必须是 0-65535 的整数（0 表示自动选择空闲端口）");
      }
      const { port: actual } = await listen(db, port);
      console.log(`API 服务已启动: http://127.0.0.1:${actual}/api/health`);
      return; // 保持进程运行
    }
    case "demo": {
      const result = importSource(db, DEMO);
      console.log(`已导入演示文献库，版本 ${result.versionId}`);
      print(getEntryFields(db, "C"));
      break;
    }
    default:
      console.log(`用法: node dist/src/cli.js <命令>
  import <file.bib>          导入新版本
  list [--version N]         列出条目
  show <key> [--version N]   展开条目字段（含来源链）
  origin <key> <field>       查询单个字段来源
  diagnostics [--version N]  查看诊断
  compare <from> <to>        比较两个版本
  export [--version N]       导出结构化结果
  serve [--port N]           启动 API（默认自动选择空闲端口）
  demo                       导入内置演示文献库并展开条目 C`);
  }
  db.close();
}

main().catch((e) => {
  if (e instanceof BibError) {
    console.error(JSON.stringify({ error: e.toJSON() }, null, 2));
    process.exit(2);
  }
  console.error(e);
  process.exit(1);
});
