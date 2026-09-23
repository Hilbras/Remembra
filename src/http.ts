import http from "node:http";
import { MemoryService } from "./service.js";

interface HttpOptions {
  port?: number;
  /** If set, all endpoints except GET /health require `x-api-key` or `Authorization: Bearer`. */
  apiKey?: string;
}

/**
 * Minimal HTTP API over the same handlers the MCP tools use.
 *
 * Routes:
 *   GET    /health              → liveness (no auth)
 *   POST   /memories            → store a memory
 *   GET    /memories/search     → ?query=&scope=&type=&limit=
 *   GET    /memories            → ?scope=&type=
 *   DELETE /memories/:id        → forget
 */
export function createHttpServer(service: MemoryService, opts: HttpOptions = {}): http.Server {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname.replace(/\/+$/, "") || "/";

      if (path === "/health") {
        return send(res, 200, { status: "ok" });
      }

      if (opts.apiKey && !authorized(req, opts.apiKey)) {
        return send(res, 401, { error: "Unauthorized: missing or invalid API key" });
      }

      // POST /memories
      if (req.method === "POST" && path === "/memories") {
        const body = await readBody(req);
        const result = await service.store(body);
        return send(res, 201, result);
      }

      // GET /memories/search
      if (req.method === "GET" && path === "/memories/search") {
        const result = await service.search({
          query: url.searchParams.get("query") ?? url.searchParams.get("q") ?? undefined,
          scope: url.searchParams.get("scope") ?? undefined,
          type: (url.searchParams.get("type") as never) ?? undefined,
          limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined,
        });
        return send(res, 200, result);
      }

      // GET /memories
      if (req.method === "GET" && path === "/memories") {
        const result = await service.list({
          scope: url.searchParams.get("scope") ?? undefined,
          type: (url.searchParams.get("type") as never) ?? undefined,
        });
        return send(res, 200, result);
      }

      // DELETE /memories/:id
      const del = path.match(/^\/memories\/([^/]+)$/);
      if (req.method === "DELETE" && del) {
        const result = await service.forget(decodeURIComponent(del[1]));
        return send(res, result.ok ? 200 : 404, result);
      }

      send(res, 404, { error: `No route: ${req.method} ${path}` });
    } catch (err) {
      const name = (err as { name?: string }).name;
      const isClientError = name === "ZodError" || name === "BadRequestError";
      send(res, isClientError ? 400 : 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  const port = opts.port ?? Number(process.env.REMEMBRA_PORT ?? 8787);
  server.listen(port, () => {
    console.error(`Remembra HTTP API listening on :${port}${opts.apiKey ? " (auth required)" : " (no auth!)"}`);
  });
  return server;
}

function authorized(req: http.IncomingMessage, key: string): boolean {
  const header = req.headers["x-api-key"];
  const auth = req.headers.authorization;
  const provided =
    (typeof header === "string" ? header : undefined) ??
    (auth?.startsWith("Bearer ") ? auth.slice(7) : undefined);
  return provided === key;
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(data);
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        const e = new Error("Invalid JSON body");
        (e as Error & { name: string }).name = "BadRequestError";
        reject(e);
      }
    });
    req.on("error", reject);
  });
}
