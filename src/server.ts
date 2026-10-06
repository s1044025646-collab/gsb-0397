import { createServer } from "node:http";
import { Service } from "./service.js";
import { Store } from "./store.js";
import { BibError } from "./errors.js";

const json = (res: any, code: number, body: unknown) => {
  const s = JSON.stringify(body, null, 2);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(s);
};

export function startServer(dbPath: string, port = 0): Promise<{ port: number; close: () => void }> {
  const svc = new Service(new Store(dbPath));
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const q = (k: string) => url.searchParams.get(k);
      const vq = () => q("version") ? Number(q("version")) : undefined;
      const seg = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

      if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true });
      if (req.method === "POST" && url.pathname === "/versions") {
        const body = await readBody(req);
        let parsed: any;
        try { parsed = JSON.parse(body); } catch { throw new BibError({ code: "VALIDATION_ERROR", message: "请求体必须是 JSON：{text, options?}" }); }
        if (typeof parsed?.text !== "string") throw new BibError({ code: "VALIDATION_ERROR", message: "缺少字符串字段 text" });
        const r = svc.import(parsed.text, parsed.options ?? {});
        return json(res, r.status === "ok" ? 201 : 422, r);
      }
      if (req.method === "GET" && url.pathname === "/versions") return json(res, 200, { versions: svc.store.listVersions(), current: svc.store.currentVersion() });
      if (req.method === "GET" && url.pathname === "/entries") return json(res, 200, svc.listEntries(vq()));
      if (req.method === "GET" && seg[0] === "entries" && seg.length === 2) return json(res, 200, svc.expandEntry(seg[1], vq()));
      if (req.method === "GET" && seg[0] === "entries" && seg.length === 3) return json(res, 200, svc.provenance(seg[1], seg[2], vq()));
      if (req.method === "GET" && url.pathname === "/diagnostics") {
        const v = q("version"); if (!v) throw new BibError({ code: "VALIDATION_ERROR", message: "缺少查询参数 version" });
        return json(res, 200, svc.diagnostics(Number(v)));
      }
      if (req.method === "GET" && url.pathname === "/diff") {
        const a = q("from"), b = q("to");
        if (!a || !b) throw new BibError({ code: "VALIDATION_ERROR", message: "缺少查询参数 from/to" });
        return json(res, 200, svc.diff(Number(a), Number(b)));
      }
      if (req.method === "GET" && url.pathname === "/export") return json(res, 200, svc.export(vq()));
      throw new BibError({ code: "NOT_FOUND", message: `${req.method} ${url.pathname} 不存在` });
    } catch (e) {
      if (e instanceof BibError) return json(res, e.diag.code === "NOT_FOUND" ? 404 : 400, { error: e.diag });
      json(res, 500, { error: { code: "INTERNAL", message: String(e) } });
    }
  });
  return new Promise(resolve => {
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address() as any;
      console.log(`API 服务已启动: http://127.0.0.1:${addr.port}  (数据: ${dbPath})`);
      resolve({ port: addr.port, close: () => { server.close(); svc.store.close(); } });
    });
  });
}

function readBody(req: any): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// 直接运行：node dist/src/server.js [dbPath] [port]
if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href) {
  const db = process.argv[2] ?? "data/bibtex.db";
  const port = process.argv[3] ? Number(process.argv[3]) : 0; // 0 = 自动选空闲端口
  startServer(db, port);
}
