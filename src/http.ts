import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { MemoryService } from "./service.js";
import { DigestInput } from "./types.js";

interface HttpOptions {
  port?: number;
  /** Bind address. Defaults: loopback when no API key, all interfaces when keyed. */
  host?: string;
  /** If set, all endpoints except GET /health require `x-api-key` or `Authorization: Bearer`. */
  apiKey?: string;
  /** Max request body bytes (default: REMEMBRA_MAX_BODY or 10 MiB). */
  maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY = 10 * 1024 * 1024; // transcripts can be large — 10 MiB

/**
 * Listen policy (P1 audit: default-deny):
 *  - explicit REMEMBRA_HOST: non-loopback requires an API key (refuse otherwise)
 *  - no host + API key: all interfaces (public ChatGPT deployments)
 *  - no host + no key: loopback only (safe local default)
 */
export function resolveListen(
  host: string | undefined,
  hasKey: boolean,
): { host?: string; error?: string } {
  if (host) {
    const loopback = host === "localhost" || host.startsWith("127.") || host === "::1";
    if (!loopback && !hasKey) {
      return {
        error: `Refusing to listen on ${host} without REMEMBRA_API_KEY. Set a key, or bind to 127.0.0.1.`,
      };
    }
    return { host };
  }
  return hasKey ? {} : { host: "127.0.0.1" };
}

/**
 * Minimal HTTP API over the same handlers the MCP tools use.
 *
 * Routes:
 *   GET    /health              → liveness (no auth)
 *   POST   /memories            → store a memory
 *   GET    /memories/search     → ?query=&scope=&type=&limit=
 *   GET    /memories            → ?scope=&type=&includeArchived=
 *   POST   /memories/digest     → LLM extraction
 *   POST   /maintain            → decay sweep + vector backfill
 *   DELETE /memories/:id        → forget
 */
export function createHttpServer(service: MemoryService, opts: HttpOptions = {}): http.Server {
  const maxBody = opts.maxBodyBytes ?? Number(process.env.REMEMBRA_MAX_BODY ?? DEFAULT_MAX_BODY);
  const listenTarget = resolveListen(opts.host ?? process.env.REMEMBRA_HOST, Boolean(opts.apiKey));
  if (listenTarget.error) throw new Error(listenTarget.error);

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

      // POST /maintain — decay sweep + vector backfill
      if (req.method === "POST" && path === "/maintain") {
        const result = await service.maintain();
        return send(res, 200, result);
      }

      // POST /memories/digest — must be checked before /memories/:id DELETE patterns
      if (req.method === "POST" && path === "/memories/digest") {
        const body = await readBody(req, maxBody);
        const result = await service.digest(DigestInput.parse(body));
        return send(res, 200, result);
      }

      // POST /memories
      if (req.method === "POST" && path === "/memories") {
        const body = await readBody(req, maxBody);
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
          includeArchived: url.searchParams.get("includeArchived") === "true",
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
      const status =
        name === "ZodError" || name === "BadRequestError"
          ? 400
          : name === "PayloadTooLarge"
            ? 413
            : 500;
      send(res, status, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  const port = opts.port ?? Number(process.env.REMEMBRA_PORT ?? 8787);
  const address = listenTarget.host;
  server.listen(port, address, () => {
    const where = address ?? "0.0.0.0";
    console.error(
      `Remembra HTTP API listening on ${where}:${port}${opts.apiKey ? " (auth required)" : " (no auth — loopback only)"}`,
    );
  });
  return server;
}

/** Constant-time API key comparison (P1 audit: timing side-channel). */
function authorized(req: http.IncomingMessage, key: string): boolean {
  const header = req.headers["x-api-key"];
  const auth = req.headers.authorization;
  const provided =
    (typeof header === "string" ? header : undefined) ??
    (auth?.startsWith("Bearer ") ? auth.slice(7) : undefined);
  if (provided === undefined) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(key);
  if (a.length !== b.length) {
    // Still do one compare of equal-length buffers to blunt timing signal.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
  });
  res.end(data);
}

function readBody(req: http.IncomingMessage, maxBytes: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] ?? 0);
    if (Number.isFinite(declared) && declared > maxBytes) {
      const err = new Error(`Request body too large (limit ${maxBytes} bytes)`);
      err.name = "PayloadTooLarge";
      reject(err);
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > maxBytes) {
        const err = new Error(`Request body too large (limit ${maxBytes} bytes)`);
        err.name = "PayloadTooLarge";
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        const e = new Error("Invalid JSON body");
        e.name = "BadRequestError";
        reject(e);
      }
    });
    req.on("error", reject);
  });
}
