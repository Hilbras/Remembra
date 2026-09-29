import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual, createHash, createHmac, randomUUID } from "node:crypto";
import { MemoryService } from "./service.js";
import { API_CAPABILITY_MANIFEST, API_PREFIX, API_VERSION, API_VERSION_HEADER, IDEMPOTENCY_KEY_HEADER, REQUEST_ID_HEADER, isValidIdempotencyKey, isValidRequestId } from "./api-contract.js";
import { batchIdempotencyScope } from "./batch-idempotency-store.js";
import { DigestInput } from "./types.js";
import { isRemembraError, statusFor, errorLabel, publicErrorMessage, RemembraError } from "./errors.js";
import { logEvent, withLogContext } from "./log.js";
import { metrics } from "./metrics.js";
import {
  rateLimitIdentity,
  type RateLimiter,
  type RateLimitIdentity,
} from "./rate-limiter.js";
import { QuotaRateLimiter, parseQuotaPolicies } from "./quota.js";
import type { SharedState, SharedStateReport } from "./shared-state.js";
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
  /**
   * Resolve a stable opaque credential identity after authentication. This is
   * used only to isolate idempotency keys when host authentication has no
   * static API key; it is never an authorization decision.
   */
  resolveCredentialScope?: (
    req: http.IncomingMessage,
  ) => string | undefined | Promise<string | undefined>;
  /** Optional trusted tenant entity service for the V5 organization API. */
  tenantEntities?: TenantEntityService;
  /**
   * Rate limiter to use. Defaults to a bounded in-process sliding window.
   * Injected rather than constructed inline so the request path depends on the
   * interface only; a shared-store implementation can be supplied without
   * editing this file.
   */
  rateLimiter?: RateLimiter;
  /**
   * Shared-state handle, when the deployment configured one. Absent in
   * single-host mode, in which case readiness is byte-identical to before this
   * milestone and the in-process limiter is used unchanged.
   */
  sharedState?: SharedState;
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

function idempotencyScopeFor(
  apiKey: string | undefined,
  credentialScope: string | undefined,
  tenant: TenantContext | undefined,
  agent: AgentContext | undefined,
): string {
  if (credentialScope !== undefined && (typeof credentialScope !== "string" || credentialScope.length < 1 || credentialScope.length > 512)) {
    throw new RemembraError("INVALID_INPUT", "resolved credential scope is invalid");
  }
  let credential: string;
  if (credentialScope) credential = `host:${batchIdempotencyScope(credentialScope)}`;
  else if (apiKey) {
    credential = `api-key:${createHmac("sha256", apiKey).update("remembra-idempotency-credential", "utf8").digest("hex")}`;
  } else {
    throw new RemembraError("INVALID_INPUT", "idempotency keys require a static API key or trusted credential scope resolver");
  }
  const principal = tenant
    ? [
        "tenant",
        tenant.principal.organizationId,
        tenant.principal.projectId ?? "",
        tenant.principal.userId ?? "",
        tenant.principal.agentId ?? "",
      ].join(":")
    : "legacy";
  const agentPart = agent ? `agent:${agent.agentId}` : "no-agent";
  return batchIdempotencyScope(`v5.4\\0${credential}\\0${principal}\\0${agentPart}`);
}

function requestAddress(req: http.IncomingMessage): string {
  return req.socket.remoteAddress ?? "unknown";
}

function requestIdFor(req: http.IncomingMessage): string {
  const raw = req.headers[REQUEST_ID_HEADER.toLowerCase()];
  const candidate = Array.isArray(raw) ? raw[0] : raw;
  return isValidRequestId(candidate) ? candidate : randomUUID();
}

function idempotencyKeyFor(req: http.IncomingMessage): string | undefined {
  const raw = req.headers[IDEMPOTENCY_KEY_HEADER.toLowerCase()];
  if (raw === undefined) return undefined;
  if (Array.isArray(raw) || !isValidIdempotencyKey(raw)) {
    throw new RemembraError("INVALID_INPUT", "Idempotency-Key must be 1-128 safe ASCII characters");
  }
  return raw;
}

/**
 * The protected request's rate identity, derived only from trusted context:
 * a host-minted tenant principal, or the API key plus source address, or the
 * address alone when neither exists. Every value is hashed, so the identity is
 * opaque and cannot be reversed into a principal (SEC-RL-002).
 *
 * Dimensions that the host did not resolve are simply absent. A missing
 * dimension never widens access — it only means that dimension is not charged.
 */
function protectedRateIdentity(
  req: http.IncomingMessage,
  tenant: TenantContext | undefined,
  apiKey: string | undefined,
): RateLimitIdentity {
  if (tenant) {
    const principal = tenant.principal;
    return rateLimitIdentity({
      organization: principal.organizationId ? rateIdentityPart(principal.organizationId) : undefined,
      project: principal.projectId ? rateIdentityPart(principal.projectId) : undefined,
      user: principal.userId ? rateIdentityPart(principal.userId) : undefined,
      agent: principal.agentId ? rateIdentityPart(principal.agentId) : undefined,
    });
  }
  if (apiKey) {
    return rateLimitIdentity({
      apikey: rateIdentityPart(apiKey),
      ip: rateIdentityPart(requestAddress(req)),
    });
  }
  return rateLimitIdentity({ ip: rateIdentityPart(requestAddress(req)) });
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
 *   GET    /memories            → ?scope=&type=&includeArchived=&dedupeExact=&limit=
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

  // V5.1.0: rate limiting depends on the interface, not the implementation, and
  // the in-process limiter is bounded (the anonymous bucket below is reachable
  // without a credential, so unbounded per-identity state would be a
  // memory-exhaustion vector). The base budget is charged for every request, so
  // the pre-V5.1 per-identity window is preserved; any REMEMBRA_QUOTAS
  // dimensions are additional constraints layered on top of it.
  // Computed once, then handed to whichever limiter is actually used. Building
  // the two from separate expressions is how a deployment ends up with one set of
  // limits in single-host mode and a subtly different set once Redis is on.
  const quotaConfig = {
    base: {
      limit: Number(process.env.REMEMBRA_RATE_LIMIT ?? 60),
      windowMs: Number(process.env.REMEMBRA_RATE_WINDOW_MS ?? 60_000),
    },
    policies: parseQuotaPolicies(process.env.REMEMBRA_QUOTAS),
  };
  // With shared state configured the shared limiter replaces the in-process one
  // wholesale rather than per dimension, so a deployment cannot accidentally run
  // half-shared quotas: a mix would apply the shared budget to some dimensions and
  // a per-instance budget to the rest, and the second is the one nobody watches.
  const rateLimiter =
    opts.rateLimiter ??
    opts.sharedState?.rateLimiter(quotaConfig) ??
    new QuotaRateLimiter({
      ...quotaConfig,
      ...(process.env.REMEMBRA_RATE_MAX_IDENTITIES
        ? { maxIdentities: Number(process.env.REMEMBRA_RATE_MAX_IDENTITIES) }
        : {}),
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
      res.setHeader("access-control-allow-headers", `Content-Type, Authorization, x-api-key, ${REQUEST_ID_HEADER}, ${IDEMPOTENCY_KEY_HEADER}`);
      res.setHeader("access-control-expose-headers", `${API_VERSION_HEADER}, ${REQUEST_ID_HEADER}, Retry-After`);
      res.setHeader("access-control-max-age", "86400");
    }
  }

  // V5.1.0: bounded readiness. A short TTL keeps a polling probe from driving a
  // storage read per request, and single-flight means a burst of concurrent
  // probes costs one check rather than one per connection. The check itself is
  // unchanged, so a stale answer is at most one TTL old.
  const healthCacheMs = Number(process.env.REMEMBRA_HEALTH_CACHE_MS ?? 1_000);
  let healthCached: { at: number; value: Awaited<ReturnType<MemoryService["health"]>> } | undefined;
  let healthInFlight: Promise<Awaited<ReturnType<MemoryService["health"]>>> | undefined;
  /**
   * Attach the shared-state view, or return the payload untouched.
   *
   * Returning the *same object* when nothing is configured is deliberate: a
   * single-host deployment's readiness payload must not gain a field, because
   * a deployment watching for an exact payload would break, and "nothing in
   * V5.6.0 changes a single-process deployment's behaviour" is easier to keep if
   * it is literally true.
   */
  function withSharedState(
    health: Awaited<ReturnType<MemoryService["health"]>>,
  ): Awaited<ReturnType<MemoryService["health"]>> & { shared?: SharedStateReport } {
    const shared = opts.sharedState?.report;
    if (!shared) return health;
    // A configured store that has gone away makes the process unready: it is
    // currently failing closed, and a load balancer that keeps sending traffic
    // to it will collect 503s instead of noticing.
    const status = shared.mode === "unreachable" ? "unready" : health.status;
    return { ...health, status, shared };
  }

  async function readiness(): Promise<Awaited<ReturnType<MemoryService["health"]>>> {
    if (!Number.isFinite(healthCacheMs) || healthCacheMs <= 0) return withSharedState(await service.health());
    const now = Date.now();
    if (healthCached && now - healthCached.at < healthCacheMs) return healthCached.value;
    if (healthInFlight) return healthInFlight;
    healthInFlight = service
      .health()
      .then((value) => {
        const merged = withSharedState(value);
        healthCached = { at: Date.now(), value: merged };
        return merged;
      })
      .finally(() => {
        healthInFlight = undefined;
      });
    return healthInFlight;
  }

  const server = http.createServer((req, res) => {
    const requestId = requestIdFor(req);
    res.setHeader(REQUEST_ID_HEADER, requestId);
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

    // V5.1.0: bind the request context around the entire handler, so every log
    // line emitted below — including deep in the service, storage, or provider
    // layers that know nothing about HTTP — carries the same request id and
    // operation without any of them threading it by hand.
    return withLogContext({ requestId, operation: "http.request" }, async () => {
      try {
        const url = requestUrl ?? new URL(req.url ?? "/", "http://localhost");
        const path = isApiV1 ? rawPath.slice(API_PREFIX.length) || "/" : rawPath;

        // Request instrumentation (audit Phase 7) — low-cardinality route label,
        // counted on finish so the real status code is visible.
        const route = routeLabel(path, isApiV1);
        const startedAt = performance.now();
        // V5.1.0: bind the request context for the whole handler, so every log
        // line emitted anywhere below — including deep in the service, storage,
        // or provider layers that know nothing about HTTP — carries the same
        // request id and operation without any of them threading it by hand.
        res.on("finish", () => {
          metrics.inc("remembra_http_requests_total", {
            route,
            method: req.method ?? "OTHER",
            status: res.statusCode,
          });
          const durationMs = performance.now() - startedAt;
          metrics.observe("remembra_http_request_duration_seconds", durationMs / 1000, {
            route,
          });
          // One completion line per request, with the standard fields the roadmap
          // asks for. The route label is the bounded slug, never the raw path.
          logEvent("info", "http.request", { route, method: req.method ?? "OTHER", status: res.statusCode, durationMs: Math.round(durationMs) });
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
        //
        // V5.1.0: readiness touches storage and may write durable recovery state,
        // and this route is public and unrated, so an unauthenticated caller
        // could otherwise drive storage reads at request rate. The result is
        // therefore cached briefly and concurrent probes share one check
        // (single-flight). `REMEMBRA_HEALTH_CACHE_MS=0` disables the cache.
        if (path === "/health") {
          const health = await readiness();
          applySecureHeaders(res);
          applyCorsHeaders(res);
          return send(res, health.status === "ok" ? 200 : 503, health);
        }

        // Cheap liveness: process state only. Never cached, never touches storage,
        // so it stays truthful while the process is alive and cannot be used to
        // generate load.
        if (path === "/health/live") {
          applySecureHeaders(res);
          applyCorsHeaders(res);
          return send(res, 200, service.liveness());
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
          const anonymousIdentity = rateLimitIdentity({ ip: rateIdentityPart(requestAddress(req)) });
          const anonymousRate = await rateLimiter.consume(anonymousIdentity);
          if (!anonymousRate.allowed) {
            metrics.inc("remembra_errors_total", { code: "RATE_LIMITED", transport: "http" });
            metrics.inc("remembra_rate_limit_hits_total", { dimension: "anonymous", transport: "http" });
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
        const rateIdentity = protectedRateIdentity(req, tenant, opts.apiKey);
        const rateCheck = await rateLimiter.consume(rateIdentity);
        if (!rateCheck.allowed) {
          metrics.inc("remembra_errors_total", { code: "RATE_LIMITED", transport: "http" });
          // The dimension is a bounded enum from the quota contract, never a
          // tenant or key value, so this label cannot grow without bound.
          metrics.inc("remembra_rate_limit_hits_total", {
            dimension: rateCheck.dimension ?? "unknown",
            transport: "http",
          });
          logEvent("warn", "rate_limit", { identity: rateIdentity.key }, "Remembra: rate limit exceeded");
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

        // V5.1.0 dependency health. These sit after authentication and rate
        // limiting, so they inherit the existing rules: a deployment with an API
        // key requires it, and they are charged like any other protected route.
        // Liveness stays above, unauthenticated and cheap, because that is the
        // one a probe on an untrusted path needs.
        if (req.method === "GET" && path === "/health/ready") {
          const health = await readiness();
          applySecureHeaders(res);
          applyCorsHeaders(res);
          return send(res, health.status === "ok" ? 200 : 503, health);
        }

        if (req.method === "GET" && path === "/health/storage") {
          const storage = await service.storageHealth();
          applySecureHeaders(res);
          applyCorsHeaders(res);
          return send(res, storage.status === "ok" ? 200 : 503, storage);
        }

        if (req.method === "GET" && path === "/health/provider") {
          applySecureHeaders(res);
          applyCorsHeaders(res);
          // Configuration state only: no reachability probe, no key, no
          // diagnostic text. Providers are optional, so this is always 200.
          return send(res, 200, service.providerHealth());
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
          const idempotencyKey = idempotencyKeyFor(req);
          const credentialScope = idempotencyKey ? await opts.resolveCredentialScope?.(req) : undefined;
          if (idempotencyKey && !opts.apiKey && credentialScope === undefined) {
            throw new RemembraError("INVALID_INPUT", "idempotency keys require a static API key or trusted credential scope resolver");
          }
          const ac = new AbortController();
          res.on("close", () => {
            if (!res.writableEnded) ac.abort();
          });
          const result = await service.batch(body, {
            ...agentOptions,
            signal: ac.signal,
            idempotencyKey,
            ...(idempotencyKey
              ? { idempotencyScope: idempotencyScopeFor(opts.apiKey, credentialScope, tenant, agent) }
              : {}),
          });
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
            // Deduplication is on by default; these are the escape hatches, so a
            // caller who wants every copy sees every copy.
            dedupeExact: url.searchParams.get("dedupeExact") !== "false",
            dedupeSameSource: url.searchParams.get("dedupeSameSource") === "true",
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
  body: object,
  itemKey: "memories" | "results" | "events",
): void {
  const record = body as Record<string, unknown>;
  const items = (record[itemKey] as Array<Record<string, unknown>> | undefined) ?? [];
  let est = 256;
  for (const k of Object.keys(record)) est += k.length + 16;
  for (const it of items) est += JSON.stringify(it).length + 64;
  if (est < STREAM_THRESHOLD) return send(res, status, body);

  const { [itemKey]: _items, ...rest } = record;
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
