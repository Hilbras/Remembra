import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { MemoryService } from "./service.js";
import { DigestInput } from "./types.js";
import { isRemembraError, statusFor, errorLabel } from "./errors.js";
import { logEvent } from "./log.js";
import { metrics } from "./metrics.js";

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
 *   GET    /health              → liveness + readiness (no auth): 200 ok / 503 unready
 *   GET    /metrics             → Prometheus text format (auth when keyed)
 *   POST   /memories            → store a memory
 *   GET    /memories/search     → ?query=&scope=&type=&limit=
 *   GET    /memories            → ?scope=&type=&includeArchived=&offset=&limit=
 *   POST   /memories/digest     → LLM extraction
 *   POST   /maintain            → decay sweep + vector backfill
 *   GET    /memories/:id        → one memory + related + backlinks (Phase 8)
 *   POST   /memories/:id/relate → link/unlink memories (Phase 8)
 *   GET    /memories/:id/history→ version history + line diffs (Phase 8)
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

      // Request instrumentation (audit Phase 7) — low-cardinality route label,
      // counted on finish so the real status code is visible.
      const route = routeLabel(path);
      const startedAt = performance.now();
      res.on("finish", () => {
        metrics.inc("remembra_http_requests_total", {
          route,
          method: req.method ?? "OTHER",
          status: res.statusCode,
        });
        metrics.observe("remembra_http_request_duration_seconds", (performance.now() - startedAt) / 1000, {
          route,
        });
      });

      // Liveness + readiness (audit Phase 7): 200 when storage is readable,
      // 503 with the failing check when it is not.
      if (path === "/health") {
        const health = await service.health();
        return send(res, health.status === "ok" ? 200 : 503, health);
      }

      if (opts.apiKey && !authorized(req, opts.apiKey)) {
        return send(res, 401, { error: "Unauthorized: missing or invalid API key" });
      }

      // GET /metrics — Prometheus text format. After the auth check on
      // purpose: keyed (incl. public) deployments must not leak counters.
      if (req.method === "GET" && path === "/metrics") {
        res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
        return res.end(metrics.render());
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
        const rawLimit = url.searchParams.get("limit");
        const limit = rawLimit && Number.isFinite(Number(rawLimit)) ? Number(rawLimit) : undefined;
        const result = await service.search({
          query: url.searchParams.get("query") ?? url.searchParams.get("q") ?? undefined,
          scope: url.searchParams.get("scope") ?? undefined,
          type: (url.searchParams.get("type") as never) ?? undefined,
          limit,
        });
        return sendListLike(res, 200, result, "results");
      }

      // GET /memories — ?scope=&type=&includeArchived=&offset=&limit=
      if (req.method === "GET" && path === "/memories") {
        const result = await service.list({
          scope: url.searchParams.get("scope") ?? undefined,
          type: (url.searchParams.get("type") as never) ?? undefined,
          includeArchived: url.searchParams.get("includeArchived") === "true",
          offset: intParam(url.searchParams.get("offset"), 0),
          limit: intParam(url.searchParams.get("limit"), 1),
        });
        return sendListLike(res, 200, result, "memories");
      }

      // DELETE /memories/:id
      const del = path.match(/^\/memories\/([^/]+)$/);
      if (req.method === "DELETE" && del) {
        const result = await service.forget(decodeURIComponent(del[1]));
        return send(res, result.ok ? 200 : 404, result);
      }

      // Graph sub-routes (audit Phase 8): POST relate, GET history.
      const sub = path.match(/^\/memories\/([^/]+)\/(relate|history)$/);
      if (sub && req.method === "POST" && sub[2] === "relate") {
        const body = (await readBody(req, maxBody)) as Record<string, unknown>;
        const result = await service.relate({ ...body, id: decodeURIComponent(sub[1]) }); // path id wins
        return send(res, 200, result);
      }
      if (sub && req.method === "GET" && sub[2] === "history") {
        const result = await service.history({
          id: decodeURIComponent(sub[1]),
          limit: intParam(url.searchParams.get("limit"), 1) ?? undefined,
        });
        return send(res, 200, result);
      }

      // GET /memories/:id — memory with related links + backlinks
      const single = path.match(/^\/memories\/([^/]+)$/);
      if (req.method === "GET" && single) {
        const result = await service.get(decodeURIComponent(single[1]));
        return send(res, 200, result);
      }

      send(res, 404, { error: `No route: ${req.method} ${path}` });
    } catch (err) {
      const name = (err as { name?: string }).name;
      // Structured classification: typed errors carry a stable code → status.
      const status = isRemembraError(err)
        ? statusFor(err)
        : name === "ZodError" || name === "BadRequestError"
          ? 400
          : name === "PayloadTooLarge"
            ? 413
            : 500;
      metrics.inc("remembra_errors_total", {
        code: name === "PayloadTooLarge" ? "PAYLOAD_TOO_LARGE" : errorLabel(err),
        transport: "http",
      });
      send(res, status, {
        error: err instanceof Error ? err.message : String(err),
        ...(isRemembraError(err) ? { code: err.code } : {}),
      });
    }
  });

  const port = opts.port ?? Number(process.env.REMEMBRA_PORT ?? 8787);
  const address = listenTarget.host;
  // Readiness-adjacent gauge: bound to this server's service (re-registered
  // idempotently if several servers exist in one process, e.g. tests).
  metrics.gauge("remembra_cache_entries", "Parse-cache entries currently held", () => {
    const s = service.storageStats();
    return s ? [{ value: s.size }] : [];
  });
  server.listen(port, address, () => {
    const where = address ?? "0.0.0.0";
    logEvent(
      "info",
      "http_listening",
      { port, host: where, auth: Boolean(opts.apiKey) },
      `Remembra HTTP API listening on ${where}:${port}${opts.apiKey ? " (auth required)" : " (no auth — loopback only)"}`,
    );
  });
  return server;
}

/** Low-cardinality route label for metrics (never the raw path). */
function routeLabel(p: string): string {
  switch (p) {
    case "/health":
      return "health";
    case "/metrics":
      return "metrics";
    case "/memories":
      return "memories";
    case "/memories/search":
      return "search";
    case "/memories/digest":
      return "digest";
    case "/maintain":
      return "maintain";
    default:
      if (/^\/memories\/[^/]+\/(relate|history)$/.test(p)) return "memory_sub";
      return /^\/memories\/[^/]+$/.test(p) ? "memory_item" : "other";
  }
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

/** Responses at or below this estimated size keep Content-Length + pretty JSON. */
const STREAM_THRESHOLD = 64 * 1024;

/** Parse an integer query param, rejecting non-integers / out-of-range values. */
function intParam(raw: string | null, min: number): number | undefined {
  if (raw === null || !/^\d+$/.test(raw.trim())) return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= min ? n : undefined;
}

/**
 * Search/list responses: small bodies go out with Content-Length (pretty
 * JSON, Phase 1 shape); estimated-large bodies stream as chunked JSON —
 * each item is written as it is serialized instead of buffering one giant
 * string first (audit Phase 5: streaming large search results).
 */
function sendListLike(
  res: http.ServerResponse,
  status: number,
  body: Record<string, unknown>,
  itemKey: "memories" | "results",
): void {
  const items = (body[itemKey] as Array<{ content?: string; embedding?: number[] }> | undefined) ?? [];
  let est = 256;
  for (const k of Object.keys(body)) est += k.length + 16;
  for (const it of items) est += (it.content?.length ?? 0) + (it.embedding?.length ?? 0) * 10 + 256;
  if (est < STREAM_THRESHOLD) return send(res, status, body);

  const { [itemKey]: _items, ...rest } = body;
  const tail =
    "]" +
    Object.entries(rest)
      .map(([k, v]) => `,${JSON.stringify(k)}:${JSON.stringify(v)}`)
      .join("") +
    "}";
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" }); // no length → chunked
  res.write(`{"${itemKey}":[`);
  for (let i = 0; i < items.length; i++) {
    res.write((i > 0 ? "," : "") + JSON.stringify(items[i]));
  }
  res.write(tail);
  res.end();
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
