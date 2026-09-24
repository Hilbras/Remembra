import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual, createHash, randomUUID } from "node:crypto";
import { MemoryService } from "./service.js";
import { API_CAPABILITY_MANIFEST, API_PREFIX, API_VERSION, API_VERSION_HEADER, REQUEST_ID_HEADER, isValidRequestId } from "./api-contract.js";
import { DigestInput } from "./types.js";
import { isRemembraError, statusFor, errorLabel, publicErrorMessage, RemembraError } from "./errors.js";
import { logEvent } from "./log.js";
import { metrics } from "./metrics.js";
import { RateLimiter } from "./rate-limiter.js";
import type { AgentContext } from "./agent.js";
import type { TenantContext } from "./tenant.js";
import type { TenantEntityKind, TenantEntityService } from "./tenant-entities.js";

export interface HttpOptions {
  port?: number;
  /** Bind address. Defaults: loopback when no API key, all interfaces when keyed. */
  host?: string;
  /** If set, all endpoints except GET /health require `x-api-key` or `Authorization: Bearer`. */
  apiKey?: string;
  /** Max request body bytes (default: REMEMBRA_MAX_BODY or 10 MiB). */
  maxBodyBytes?: number;
  /**
   * Resolve a trusted agent identity after API-key authentication. This is the
   * only supported HTTP source of AgentContext; a public agent-id header is
   * deliberately not trusted by default.
   */
  resolveAgentContext?: (
    req: http.IncomingMessage,
  ) => AgentContext | undefined | Promise<AgentContext | undefined>;
  /** Resolve a host-minted V5 tenant context after authentication. */
  resolveTenantContext?: (
    req: http.IncomingMessage,
  ) => TenantContext | undefined | Promise<TenantContext | undefined>;
  /** Optional trusted tenant entity service for the V5 organization API. */
  tenantEntities?: TenantEntityService;
}

const RESERVED_TENANT_KEYS = new Set([
  "tenant",
  "tenantid",
  "organization",
  "organizationid",
  "userid",
  "user",
  "projectid",
  "project",
  "agentid",
  "agent",
  "membershipversion",
]);
const normalizeIdentityKey = (key: string): string => key.replace(/[-_]/g, "").toLowerCase();
const RESERVED_TENANT_HEADER = /^(?:x-)?(?:remembra-)?(?:tenant|tenant-id|organization|organization-id|user|user-id|project|project-id|agent|agent-id)$/i;

const DEFAULT_MAX_BODY = 10 * 1024 * 1024; // transcripts can be large — 10 MiB

/** Web UI root: dist/ui (TS from src/ui + HTML/CSS copied by scripts/copy-ui.mjs). */
const UI_ROOT = path.resolve(fileURLToPath(new URL("./ui/", import.meta.url)));

/** Whitelisted static extensions — anything else is 404 before touching the FS. */
const UI_EXT = new Set([".html", ".css", ".js", ".map"]);

/** Shell CSP (v4): no inline script/style, same-origin data calls only. */
const UI_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/** Baseline secure headers for every JSON API response (V4.4). */
const SECURE_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-xss-protection": "0",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

function publicErrorMessageForHttp(error: unknown): string {
  return publicErrorMessage(error);
}

const UI_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

function rateIdentityPart(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function requestAddress(req: http.IncomingMessage): string {
  return req.socket.remoteAddress ?? "unknown";
}

function requestIdFor(req: http.IncomingMessage): string {
  const raw = req.headers[REQUEST_ID_HEADER.toLowerCase()];
  const candidate = Array.isArray(raw) ? raw[0] : raw;
  return isValidRequestId(candidate) ? candidate : randomUUID();
}

function protectedRateIdentity(req: http.IncomingMessage, tenant: TenantContext | undefined, apiKey: string | undefined): string {
  if (tenant) {
    const principal = tenant.principal;
    const dimensions = [principal.organizationId, principal.projectId, principal.userId, principal.agentId]
      .filter((value): value is string => Boolean(value))
      .map(rateIdentityPart)
      .join(":");
    return `tenant:${dimensions}`;
  }
  if (apiKey) return `api:${rateIdentityPart(apiKey)}:${rateIdentityPart(requestAddress(req))}`;
  return `ip:${rateIdentityPart(requestAddress(req))}`;
}

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
 *   GET    /api/v1/capabilities → authenticated bounded API discovery
 *   GET    /metrics             → Prometheus text format (auth when keyed)
 *   GET    / , /ui/*            → web dashboard shell + static assets (no auth, v4)
 *   POST   /memories            → store a memory
 *   GET    /memories/search     → ?query=&scope=&type=&limit=
 *   GET    /memories            → ?scope=&type=&includeArchived=&offset=&limit=
 *   POST   /memories/digest     → LLM extraction
 *   POST   /maintain            → decay sweep + vector backfill
 *   GET    /memories/:id        → one memory + related + backlinks (Phase 8)
 *   PUT    /memories/:id        → patch fields; scope change moves the file (v4)
 *   POST   /memories/:id/relate → link/unlink memories (Phase 8)
 *   GET    /memories/:id/history→ version history + line diffs (Phase 8)
 *   POST   /memories/:id/archive / /revive → manual lifecycle (v4)
 *   GET    /snapshot            → full export snapshot (v4, CLI parity)
 *   POST   /import              → idempotent snapshot import (v4, CLI parity)
 *   DELETE /memories/:id        → forget
 *   GET    /audit               → recent audit events (V4.4, auth required)
 */
export function createHttpServer(service: MemoryService, opts: HttpOptions = {}): http.Server {
  const maxBody = opts.maxBodyBytes ?? Number(process.env.REMEMBRA_MAX_BODY ?? DEFAULT_MAX_BODY);
  const listenTarget = resolveListen(opts.host ?? process.env.REMEMBRA_HOST, Boolean(opts.apiKey));
  if (listenTarget.error) throw new Error(listenTarget.error);

  // V4.4: rate limiter (per-key sliding window).
  const rateLimiter = new RateLimiter({
    limit: Number(process.env.REMEMBRA_RATE_LIMIT ?? 60),
    windowMs: Number(process.env.REMEMBRA_RATE_WINDOW_MS ?? 60_000),
  });

  // V4.4: request timeout.
  const requestTimeoutMs = Number(process.env.REMEMBRA_REQUEST_TIMEOUT_MS ?? 30_000);

  // V4.4: concurrency limit.
  const maxConcurrent = Number(process.env.REMEMBRA_MAX_CONCURRENT ?? 32);
  let concurrent = 0;

  // V4.4: CORS origin.
  const corsOrigin = process.env.REMEMBRA_CORS_ORIGIN;
  const secureHeadersEnabled = process.env.REMEMBRA_SECURE_HEADERS !== "0";

  /** Apply security headers to a response. */
  function applySecureHeaders(res: http.ServerResponse): void {
    if (!secureHeadersEnabled) return;
    for (const [k, v] of Object.entries(SECURE_HEADERS)) {
      res.setHeader(k, v);
    }
  }

  /** Apply CORS headers to a response. */
  function applyCorsHeaders(res: http.ServerResponse, allowHeaders = true): void {
    if (!corsOrigin) return;
    if (corsOrigin === "*") {
      if (opts.apiKey) {
        // CORS wildcard + auth is invalid; fall back to explicit origin.
        res.setHeader("access-control-allow-origin", "");
      } else {
        res.setHeader("access-control-allow-origin", "*");
      }
    } else {
      res.setHeader("access-control-allow-origin", corsOrigin);
    }
    if (allowHeaders) {
      res.setHeader("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
      res.setHeader("access-control-allow-headers", `Content-Type, Authorization, x-api-key, ${REQUEST_ID_HEADER}`);
      res.setHeader("access-control-expose-headers", `${API_VERSION_HEADER}, ${REQUEST_ID_HEADER}, Retry-After`);
      res.setHeader("access-control-max-age", "86400");
    }
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader(REQUEST_ID_HEADER, requestIdFor(req));
    // Parse before the overload fast path so versioned responses get their
    // contract header even when rejected immediately. Defer malformed-URL
    // handling to the normal request try/catch below.
    let requestUrl: URL | undefined;
    let rawPath = "/";
    let isApiV1 = false;
    try {
      requestUrl = new URL(req.url ?? "/", "http://localhost");
      rawPath = requestUrl.pathname.replace(/\/+$/, "") || "/";
      isApiV1 = rawPath === API_PREFIX || rawPath.startsWith(`${API_PREFIX}/`);
    } catch {
      // The normal handler will turn malformed URLs into a controlled error.
    }
    if (isApiV1) res.setHeader(API_VERSION_HEADER, API_VERSION);

    // V4.4: concurrency accounting.
    if (concurrent >= maxConcurrent) {
      applySecureHeaders(res);
      applyCorsHeaders(res);
      return send(res, 503, { error: "Server overloaded — concurrency limit reached" }, { "retry-after": "1" });
    }
    concurrent++;

    try {
      const url = requestUrl ?? new URL(req.url ?? "/", "http://localhost");
      const path = isApiV1 ? rawPath.slice(API_PREFIX.length) || "/" : rawPath;

      // Request instrumentation (audit Phase 7) — low-cardinality route label,
      // counted on finish so the real status code is visible.
      const route = routeLabel(path, isApiV1);
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

      // V4.4: request timeout enforcement.
      if (requestTimeoutMs > 0) {
        res.setTimeout(requestTimeoutMs, () => {
          if (!res.writableEnded) {
            metrics.inc("remembra_errors_total", { code: "REQUEST_TIMEOUT", transport: "http" });
            applySecureHeaders(res);
            applyCorsHeaders(res);
            send(res, 504, { error: "Request timeout exceeded" });
            req.destroy();
          }
        });
      }

      // Liveness + readiness (audit Phase 7): 200 when storage is readable,
      // 503 with the failing check when it is not.
      if (path === "/health") {
        const health = await service.health();
        applySecureHeaders(res);
        applyCorsHeaders(res);
        return send(res, health.status === "ok" ? 200 : 503, health);
      }

      // V4.4: CORS preflight — handle before any auth/rate-limit check.
      if (req.method === "OPTIONS") {
        applySecureHeaders(res);
        applyCorsHeaders(res);
        res.writeHead(204);
        return res.end();
      }

      // Web UI shell (v4): static files served unauthenticated, like /health —
      // the shell itself holds no data; every API call the SPA makes still
      // carries the key. REMEMBRA_UI=0 turns serving off entirely.
      if (
        process.env.REMEMBRA_UI !== "0" &&
        !isApiV1 &&
        (path === "/" || path === "/ui" || path.startsWith("/ui/"))
      ) {
        applySecureHeaders(res);
        applyCorsHeaders(res);
        return serveStatic(res, req.method ?? "GET", path);
      }

      // Authenticate before consuming a protected rate bucket. Anonymous
      // attempts use a separate address bucket so they cannot exhaust the
      // configured client's quota.
      if (opts.apiKey && !authorized(req, opts.apiKey)) {
        const anonymousRate = rateLimiter.check(`anon:${rateIdentityPart(requestAddress(req))}`);
        if (!anonymousRate.allowed) {
          metrics.inc("remembra_errors_total", { code: "RATE_LIMITED", transport: "http" });
          logEvent("warn", "rate_limit", { identity: "anonymous" }, "Remembra: rate limit exceeded");
          applySecureHeaders(res);
          applyCorsHeaders(res);
          return send(
            res,
            429,
            { error: "Rate limit exceeded", retryAfterMs: anonymousRate.retryAfterMs },
            { "retry-after": String(Math.ceil(anonymousRate.retryAfterMs / 1000)) },
          );
        }
        metrics.inc("remembra_errors_total", { code: "UNAUTHORIZED", transport: "http" });
        logEvent("warn", "auth.failure", { remote: requestAddress(req) }, "Remembra: unauthorized access attempt");
        applySecureHeaders(res);
        applyCorsHeaders(res);
        return send(res, 401, { error: "Unauthorized: missing or invalid API key" });
      }

      assertNoReservedTenantIngress(req, url, service.isTenantStrict);

      // Identity is established by the embedding application only after the
      // transport authentication above. Never infer it from request JSON or an
      // unverified public header.
      const resolvedAgent = await opts.resolveAgentContext?.(req);
      const agent = resolvedAgent?.agentId?.trim() ? resolvedAgent : undefined;
      const tenant = await opts.resolveTenantContext?.(req);

      // Protected requests are charged only after authentication and trusted
      // identity resolution. Tenant dimensions provide separate quotas when
      // the host has resolved them; the API-key/address pair is the safe
      // fallback for legacy mode or a host without a tenant resolver.
      const rateKey = protectedRateIdentity(req, tenant, opts.apiKey);
      const rateCheck = rateLimiter.check(rateKey);
      if (!rateCheck.allowed) {
        metrics.inc("remembra_errors_total", { code: "RATE_LIMITED", transport: "http" });
        logEvent("warn", "rate_limit", { identity: rateKey }, "Remembra: rate limit exceeded");
        applySecureHeaders(res);
        applyCorsHeaders(res);
        return send(
          res,
          429,
          { error: "Rate limit exceeded", retryAfterMs: rateCheck.retryAfterMs },
          { "retry-after": String(Math.ceil(rateCheck.retryAfterMs / 1000)) },
        );
      }

      const agentOptions = { agent, tenant };

      if (req.method === "GET" && path === "/capabilities") {
        applySecureHeaders(res);
        applyCorsHeaders(res);
        return send(res, 200, API_CAPABILITY_MANIFEST);
      }

      const requireEntityTenant = (): TenantContext => {
        if (!tenant) throw new RemembraError("TENANT_REQUIRED", "trusted tenant context required");
        return tenant;
      };
      const entityService = opts.tenantEntities;
      const entityKind = (value: string): TenantEntityKind => {
        if (value === "user" || value === "project" || value === "agent") return value;
        const error = new Error("unsupported tenant entity kind");
        error.name = "BadRequestError";
        throw error;
      };
      const entityPageValue = (name: string): number | undefined => {
        const raw = url.searchParams.get(name);
        if (raw === null) return undefined;
        if (!/^\d+$/.test(raw)) {
          const error = new Error(`${name} must be a non-negative integer`);
          error.name = "BadRequestError";
          throw error;
        }
        return Number(raw);
      };
      const entityObjectBody = (body: unknown): Record<string, unknown> => {
        if (body === null || typeof body !== "object" || Array.isArray(body)) {
          const error = new Error("tenant entity body must be an object");
          error.name = "BadRequestError";
          throw error;
        }
        return body as Record<string, unknown>;
      };

      if (entityService && req.method === "GET" && path === "/tenant/organization") {
        const result = await entityService.getOrganization(requireEntityTenant());
        applySecureHeaders(res);
        applyCorsHeaders(res);
        return send(res, 200, result);
      }

      const entityList = entityService ? path.match(/^\/tenant\/entities\/(user|project|agent)$/) : null;
      if (entityList && req.method === "GET") {
        const result = await entityService!.list(requireEntityTenant(), entityKind(entityList[1]), {
          offset: entityPageValue("offset"),
          limit: entityPageValue("limit"),
        });
        applySecureHeaders(res);
        applyCorsHeaders(res);
        return send(res, 200, result);
      }

      const entityItem = entityService ? path.match(/^\/tenant\/entities\/(user|project|agent)\/([^/]+)$/) : null;
      if (entityItem && req.method === "GET") {
        const result = await entityService!.get(requireEntityTenant(), entityKind(entityItem[1]), decodeURIComponent(entityItem[2]));
        applySecureHeaders(res);
        applyCorsHeaders(res);
        return send(res, 200, result);
      }

      if (entityItem && (req.method === "POST" || req.method === "PUT" || req.method === "DELETE")) {
        const kind = entityKind(entityItem[1]);
        const id = decodeURIComponent(entityItem[2]);
        const tenantContext = requireEntityTenant();
        if (req.method === "DELETE") {
          if (kind === "user") await entityService!.deleteUser(tenantContext, id);
          else if (kind === "project") await entityService!.deleteProject(tenantContext, id);
          else await entityService!.deleteAgent(tenantContext, id);
          applySecureHeaders(res);
          applyCorsHeaders(res);
          return send(res, 200, { ok: true });
        }
        const body = entityObjectBody(await readBody(req, maxBody, service.isTenantStrict));
        let result;
        if (kind === "user") {
          const input = { ...body, userId: id };
          result = req.method === "POST"
            ? await entityService!.createUser(tenantContext, input as { userId: string; displayName?: string })
            : await entityService!.updateUser(tenantContext, input as { userId: string; displayName?: string });
        } else if (kind === "project") {
          const input = { ...body, projectId: id };
          result = req.method === "POST"
            ? await entityService!.createProject(tenantContext, input as { projectId: string; displayName?: string })
            : await entityService!.updateProject(tenantContext, input as { projectId: string; displayName?: string });
        } else {
          const { userRef, projectRef, ...rest } = body;
          const input = {
            ...rest,
            agentId: id,
            ...(userRef !== undefined ? { userId: userRef } : {}),
            ...(projectRef !== undefined ? { projectId: projectRef } : {}),
          };
          result = req.method === "POST"
            ? await entityService!.createAgent(tenantContext, input as { agentId: string; userId?: string; projectId?: string; displayName?: string })
            : await entityService!.updateAgent(tenantContext, input as { agentId: string; userId?: string; projectId?: string; displayName?: string });
        }
        applySecureHeaders(res);
        applyCorsHeaders(res);
        return send(res, req.method === "POST" ? 201 : 200, result);
      }

      const membershipList = entityService ? path.match(/^\/tenant\/memberships\/([^/]+)$/) : null;
      if (membershipList && req.method === "GET") {
        const result = await entityService!.listProjectMembers(
          requireEntityTenant(),
          decodeURIComponent(membershipList[1]),
          { offset: entityPageValue("offset"), limit: entityPageValue("limit") },
        );
        applySecureHeaders(res);
        applyCorsHeaders(res);
        return send(res, 200, result);
      }

      const membership = entityService ? path.match(/^\/tenant\/memberships\/([^/]+)\/([^/]+)$/) : null;
      if (membership && (req.method === "POST" || req.method === "DELETE")) {
        const tenantContext = requireEntityTenant();
        const projectId = decodeURIComponent(membership[1]);
        const userId = decodeURIComponent(membership[2]);
        if (req.method === "DELETE") {
          await entityService!.revokeProjectMembership(tenantContext, { projectId, userId });
        } else {
          const body = entityObjectBody(await readBody(req, maxBody, service.isTenantStrict));
          await entityService!.grantProjectMembership(tenantContext, {
            ...body,
            projectId,
            userId,
          } as { projectId: string; userId: string; role?: "member" | "manager" | "admin" });
        }
        applySecureHeaders(res);
        applyCorsHeaders(res);
        return send(res, 200, { ok: true });
      }

      // GET /metrics — Prometheus text format. After the auth check on
      // purpose: keyed (incl. public) deployments must not leak counters.
      if (req.method === "GET" && path === "/metrics") {
        service.assertTenantCapability(agentOptions, "admin");
        applySecureHeaders(res);
        applyCorsHeaders(res);
        res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
        return res.end(metrics.render());
      }

      // V4.4: GET /audit — recent audit events.
      if (req.method === "GET" && path === "/audit") {
        const limit = intParam(url.searchParams.get("limit"), 1) ?? 50;
        const since = url.searchParams.get("since") ?? undefined;
        const result = await service.getAudit({ limit, since }, agentOptions);
        applySecureHeaders(res);
        applyCorsHeaders(res);
        return sendListLike(res, 200, result, "events");
      }

      // V4.6: GET /quality — memory health dashboard.
      if (req.method === "GET" && path === "/quality") {
        const result = await service.quality(agentOptions);
        applySecureHeaders(res);
        applyCorsHeaders(res);
        return send(res, 200, result);
      }

      // GET /agents/:id — non-content attribution and memory counts.
      const agentSummary = path.match(/^\/agents\/([^/]+)$/);
      if (req.method === "GET" && agentSummary) {
        const result = await service.getAgentSummary(decodeURIComponent(agentSummary[1]), agentOptions);
        applySecureHeaders(res);
        applyCorsHeaders(res);
        return send(res, 200, result);
      }

      // POST /maintain — decay sweep + vector backfill
      if (req.method === "POST" && path === "/maintain") {
        const result = await service.maintain(agentOptions);
        applySecureHeaders(res);
        applyCorsHeaders(res);
        return send(res, 200, result);
      }

      // POST /context — bounded, read-only context assembly.
      if (req.method === "POST" && path === "/context") {
        const body = await readBody(req, maxBody, service.isTenantStrict);
        const result = await service.context(body, agentOptions);
        applySecureHeaders(res);
        applyCorsHeaders(res);
        return send(res, 200, result);
      }

      // POST /memories/digest — must be checked before /memories/:id DELETE patterns
      if (req.method === "POST" && path === "/memories/digest") {
        const body = await readBody(req, maxBody, service.isTenantStrict);
        // Cancellation (§3.7): a client that disconnects mid-digest aborts the
        // in-flight provider calls instead of letting them run to completion.
        const ac = new AbortController();
        res.on("close", () => {
          if (!res.writableEnded) ac.abort();
        });
        const result = await service.digest({ ...DigestInput.parse(body), signal: ac.signal, ...agentOptions });
        applySecureHeaders(res);
        applyCorsHeaders(res);
        return send(res, 200, result);
      }

      // POST /memories/batch — bounded operation-dispatched batch.
      if (req.method === "POST" && path === "/memories/batch") {
        const body = await readBody(req, maxBody, service.isTenantStrict);
        const result = await service.batch(body, agentOptions);
        applySecureHeaders(res);
        applyCorsHeaders(res);
        return result.operation === "export"
          ? sendListLike(res, 200, result, "memories")
          : sendListLike(res, 200, result, "results");
      }

      // POST /memories
      if (req.method === "POST" && path === "/memories") {
        const body = await readBody(req, maxBody, service.isTenantStrict);
        const result = await service.store(body, agentOptions);
        applySecureHeaders(res);
        applyCorsHeaders(res);
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
          explain: url.searchParams.get("explain") === "true",
          includeExpired: url.searchParams.get("includeExpired") === "true",
          includeFuture: url.searchParams.get("includeFuture") === "true",
          includeQuarantined: url.searchParams.get("includeQuarantined") === "true",
          includeArchived: url.searchParams.get("includeArchived") === "true",
          ...agentOptions,
        });
        applySecureHeaders(res);
        applyCorsHeaders(res);
        return sendListLike(res, 200, result, "results");
      }

      // GET /memories — ?scope=&type=&includeArchived=&offset=&limit=
      if (req.method === "GET" && path === "/memories") {
        const result = await service.list({
          scope: url.searchParams.get("scope") ?? undefined,
          type: (url.searchParams.get("type") as never) ?? undefined,
          includeArchived: url.searchParams.get("includeArchived") === "true",
          offset: intParam(url.searchParams.get("offset"), 0),
          cursor: url.searchParams.get("cursor") ?? undefined,
          limit: intParam(url.searchParams.get("limit"), 1),
          includeQuarantined: url.searchParams.get("includeQuarantined") === "true",
          includeExpired: url.searchParams.get("includeExpired") === "true",
          includeFuture: url.searchParams.get("includeFuture") === "true",
          ...agentOptions,
        });
        applySecureHeaders(res);
        applyCorsHeaders(res);
        return sendListLike(res, 200, result, "memories");
      }

      // POST /memories/compress — V4.5: trigger consolidation compression.
      if (req.method === "POST" && path === "/memories/compress") {
        const body = await readBody(req, maxBody, service.isTenantStrict);
        const result = await service.compress(body, agentOptions);
        applySecureHeaders(res);
        applyCorsHeaders(res);
        return send(res, 200, result);
      }

      // DELETE /memories/:id
      const del = path.match(/^\/memories\/([^/]+)$/);
      if (req.method === "DELETE" && del) {
        const result = await service.forget(decodeURIComponent(del[1]), agentOptions);
        applySecureHeaders(res);
        applyCorsHeaders(res);
        return send(res, result.ok ? 200 : 404, result);
      }

      // Write routes (v4): PUT patch, archive/revive.
      const singleWrite = path.match(/^\/memories\/([^/]+)$/);
      if (req.method === "PUT" && singleWrite) {
        const body = await readBody(req, maxBody, service.isTenantStrict);
        const result = await service.update(decodeURIComponent(singleWrite[1]), body, agentOptions);
        applySecureHeaders(res);
        applyCorsHeaders(res);
        return send(res, 200, result);
      }

      // Graph/history/lifecycle sub-routes: POST relate, GET history,
      // POST archive, POST revive (Phase 8 + v4).
      const sub = path.match(/^\/memories\/([^/]+)\/(relate|history|archive|revive)$/);
      if (sub && req.method === "POST" && (sub[2] === "archive" || sub[2] === "revive")) {
        const result = await service[sub[2]](decodeURIComponent(sub[1]), agentOptions);
        applySecureHeaders(res);
        applyCorsHeaders(res);
        return send(res, 200, result);
      }
      if (sub && req.method === "POST" && sub[2] === "relate") {
        const body = (await readBody(req, maxBody, service.isTenantStrict)) as Record<string, unknown>;
        const result = await service.relate({ ...body, id: decodeURIComponent(sub[1]) }, agentOptions); // path id wins
        applySecureHeaders(res);
        applyCorsHeaders(res);
        return send(res, 200, result);
      }
      if (sub && req.method === "GET" && sub[2] === "history") {
        const result = await service.history({
          id: decodeURIComponent(sub[1]),
          limit: intParam(url.searchParams.get("limit"), 1) ?? undefined,
        }, agentOptions);
        applySecureHeaders(res);
        applyCorsHeaders(res);
        return send(res, 200, result);
      }

      // GET /memories/:id — memory with related links + backlinks
      const single = path.match(/^\/memories\/([^/]+)$/);
      if (req.method === "GET" && single) {
        const result = await service.get(decodeURIComponent(single[1]), agentOptions);
        applySecureHeaders(res);
        applyCorsHeaders(res);
        return send(res, 200, result);
      }

      // Snapshot I/O (v4): HTTP export/import — same handlers the CLI uses.
      if (path === "/snapshot" && req.method === "GET") {
        applySecureHeaders(res);
        applyCorsHeaders(res);
        return send(res, 200, await service.exportSnapshot(agentOptions));
      }
      if (path === "/import" && req.method === "POST") {
        const body = await readBody(req, maxBody, service.isTenantStrict);
        applySecureHeaders(res);
        applyCorsHeaders(res);
        return send(res, 200, await service.importSnapshot(body, agentOptions));
      }

      applySecureHeaders(res);
      applyCorsHeaders(res);
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
            : name === "TimeoutError"
              ? 504
              : 500;
      metrics.inc("remembra_errors_total", {
        code: name === "PayloadTooLarge" ? "PAYLOAD_TOO_LARGE" : name === "TimeoutError" ? "REQUEST_TIMEOUT" : errorLabel(err),
        transport: "http",
      });
      applySecureHeaders(res);
      applyCorsHeaders(res);
      send(res, status, {
        error: publicErrorMessageForHttp(err),
        ...(isRemembraError(err) ? { code: err.code } : {}),
      });
    } finally {
      concurrent--;
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
function routeLabel(p: string, apiV1 = false): string {
  const label = routeLabelInternal(p);
  return apiV1 ? `api_v1_${label}` : label;
}

function routeLabelInternal(p: string): string {
  switch (p) {
    case "/health":
      return "health";
    case "/metrics":
      return "metrics";
    case "/capabilities":
      return "capabilities";
    case "/audit":
      return "audit";
    case "/quality":
      return "quality";
    case "/agents":
      return "agents";
    case "/memories":
      return "memories";
    case "/memories/search":
      return "search";
    case "/memories/digest":
      return "digest";
    case "/memories/batch":
      return "batch";
    case "/maintain":
      return "maintain";
    case "/memories/compress":
      return "compress";
    default:
      if (p === "/" || p === "/ui" || p.startsWith("/ui/")) return "ui";
      if (/^\/agents\/[^/]+$/.test(p)) return "agents";
      if (/^\/memories\/[^/]+\/(relate|history|archive|revive)$/.test(p)) return "memory_sub";
      if (p === "/snapshot" || p === "/import") return "data_io";
      return /^\/memories\/[^/]+$/.test(p) ? "memory_item" : "other";
  }
}

/**
 * Static UI file server (v4): GET/HEAD only, extension whitelist, decoded-path
 * containment check inside UI_ROOT, regular files only, CSP on HTML.
 * Traversal attempts (`..`, %2e%2e, absolute, NUL) all land on the generic 404.
 */
function serveStatic(res: http.ServerResponse, method: string, reqPath: string): void {
  const notFound = (): void => {
    const data = JSON.stringify({ error: "Not found" });
    res.writeHead(404, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(data),
      "x-content-type-options": "nosniff",
    });
    res.end(method === "HEAD" ? undefined : data);
  };
  if (method !== "GET" && method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" });
    res.end();
    return;
  }

  let rel: string;
  try {
    rel = reqPath === "/" || reqPath === "/ui" ? "index.html" : decodeURIComponent(reqPath.slice(4));
  } catch {
    res.writeHead(400, { "content-type": "text/plain" });
    res.end("Bad request");
    return;
  }
  if (rel.includes("\0")) return notFound();
  const dot = rel.lastIndexOf(".");
  if (dot < 0 || !UI_EXT.has(rel.slice(dot))) return notFound();

  let target: string;
  try {
    target = path.resolve(UI_ROOT, rel);
  } catch {
    return notFound();
  }
  // Containment: resolved target must be strictly inside the UI root.
  if (!target.startsWith(UI_ROOT + path.sep)) return notFound();

  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    return notFound();
  }
  if (!stat.isFile()) return notFound();

  const headers: Record<string, string> = {
    "content-type": UI_MIME[path.extname(target)] ?? "application/octet-stream",
    "content-length": String(stat.size),
    "x-content-type-options": "nosniff",
    "cache-control": "no-cache",
  };
  if (target.endsWith(".html")) headers["content-security-policy"] = UI_CSP;
  res.writeHead(200, headers);
  if (method === "HEAD") {
    res.end();
    return;
  }
  fs.createReadStream(target).pipe(res);
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

function send(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): void {
  const data = JSON.stringify(body, null, 2);
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(data)),
    ...(extraHeaders ?? {}),
  };
  res.writeHead(status, headers);
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
  itemKey: "memories" | "results" | "events",
): void {
  const items = (body[itemKey] as Array<Record<string, unknown>> | undefined) ?? [];
  let est = 256;
  for (const k of Object.keys(body)) est += k.length + 16;
  for (const it of items) est += JSON.stringify(it).length + 64;
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

function assertNoReservedTenantIngress(
  req: http.IncomingMessage,
  url: URL,
  strict: boolean,
): void {
  if (!strict) return;
  for (const key of url.searchParams.keys()) {
    if (RESERVED_TENANT_KEYS.has(normalizeIdentityKey(key))) {
      const error = new Error(`query parameter ${key} is server-managed`);
      error.name = "BadRequestError";
      throw error;
    }
  }
  for (const key of Object.keys(req.headers)) {
    if (RESERVED_TENANT_HEADER.test(key)) {
      const error = new Error(`header ${key} is server-managed`);
      error.name = "BadRequestError";
      throw error;
    }
  }
}

function assertNoReservedTenantBody(value: unknown, path = "body", allowSnapshotRecords = false): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoReservedTenantBody(item, `${path}[${index}]`, allowSnapshotRecords));
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (RESERVED_TENANT_KEYS.has(normalizeIdentityKey(key)) && !(allowSnapshotRecords && path.includes("memories"))) {
      const error = new Error(`${path}.${key} is server-managed`);
      error.name = "BadRequestError";
      throw error;
    }
    assertNoReservedTenantBody(child, `${path}.${key}`, allowSnapshotRecords);
  }
}

function readBody(req: http.IncomingMessage, maxBytes: number, strictTenant = false): Promise<any> {
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
        const parsed = JSON.parse(raw);
        if (strictTenant) {
          const isSignedSnapshot = Boolean(
            parsed && typeof parsed === "object" && parsed.format === "remembra-export" && parsed.integrity,
          );
          assertNoReservedTenantBody(parsed, "body", isSignedSnapshot);
        }
        resolve(parsed);
      } catch {
        const e = new Error("Invalid JSON body");
        e.name = "BadRequestError";
        reject(e);
      }
    });
    req.on("error", reject);
  });
}
