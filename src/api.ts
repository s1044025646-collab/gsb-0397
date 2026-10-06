import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { BibError } from "./errors";
import {
  compareVersions,
  exportVersion,
  getDiagnostics,
  getEntryFields,
  getFieldOrigin,
  importSource,
  listEntries,
} from "./service";

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(data);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 32 * 1024 * 1024) reject(new BibError("VALIDATION_ERROR", "请求体过大"));
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function createServer(db: DatabaseSync): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      const v = url.searchParams.get("version");
      const version = v === null ? undefined : Number(v);
      if (v !== null && (!Number.isInteger(version) || (version as number) <= 0)) {
        throw new BibError("VALIDATION_ERROR", "version 参数必须是正整数");
      }
      const parts = url.pathname.split("/").filter(Boolean); // e.g. ["api","entries","C","fields","year","origin"]

      if (req.method === "GET" && url.pathname === "/api/health") {
        return send(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/import") {
        const body = JSON.parse(await readBody(req));
        if (typeof body?.source !== "string") {
          throw new BibError("VALIDATION_ERROR", "请求体必须为 JSON：{ \"source\": string }");
        }
        const result = importSource(db, body.source);
        return send(res, result.status === "ok" ? 201 : 422, result);
      }
      if (req.method === "GET" && url.pathname === "/api/entries") {
        return send(res, 200, { entries: listEntries(db, version) });
      }
      if (req.method === "GET" && parts[0] === "api" && parts[1] === "entries" && parts.length >= 3) {
        const key = decodeURIComponent(parts[2]);
        if (parts.length === 4 && parts[3] === "fields") {
          return send(res, 200, getEntryFields(db, key, version));
        }
        if (parts.length === 6 && parts[3] === "fields" && parts[5] === "origin") {
          return send(res, 200, getFieldOrigin(db, key, decodeURIComponent(parts[4]), version));
        }
      }
      if (req.method === "GET" && url.pathname === "/api/diagnostics") {
        return send(res, 200, getDiagnostics(db, version));
      }
      if (req.method === "GET" && url.pathname === "/api/compare") {
        const from = Number(url.searchParams.get("from"));
        const to = Number(url.searchParams.get("to"));
        if (!Number.isInteger(from) || !Number.isInteger(to)) {
          throw new BibError("VALIDATION_ERROR", "compare 需要整数参数 from 与 to");
        }
        return send(res, 200, compareVersions(db, from, to));
      }
      if (req.method === "GET" && url.pathname === "/api/export") {
        return send(res, 200, exportVersion(db, version));
      }
      throw new BibError("NOT_FOUND", `未知路由 ${req.method} ${url.pathname}`);
    } catch (e) {
      if (e instanceof BibError) {
        const status =
          e.code === "NOT_FOUND" ? 404 : e.code === "VALIDATION_ERROR" ? 400 : 422;
        return send(res, status, { error: e.toJSON() });
      }
      if (e instanceof SyntaxError) {
        return send(res, 400, { error: { code: "VALIDATION_ERROR", message: "请求体不是合法 JSON" } });
      }
      return send(res, 500, { error: { code: "INTERNAL", message: String(e) } });
    }
  });
}

export function listen(db: DatabaseSync, port?: number): Promise<{ port: number; close: () => void }> {
  const server = createServer(db);
  return new Promise((resolve) => {
    // 默认端口 0：由系统分配空闲端口
    server.listen(port ?? 0, "127.0.0.1", () => {
      const addr = server.address();
      const p = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ port: p, close: () => server.close() });
    });
  });
}
