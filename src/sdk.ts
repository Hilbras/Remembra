import { API_PREFIX, API_VERSION, REQUEST_ID_HEADER, isValidRequestId, type ApiCapabilitiesResponse } from "./api-contract.js";
export type { ApiCapabilitiesResponse } from "./api-contract.js";
import type { ContextResult } from "./context.js";
import type { TenantEntity, TenantEntityKind, TenantEntityPage, TenantMembershipPage } from "./tenant-entities.js";
export type { TenantEntity, TenantEntityKind, TenantEntityPage, TenantMembershipPage } from "./tenant-entities.js";
export type { ContextMemory, ContextResult } from "./context.js";
import type {
  BatchOutcome,
  BatchRequest,
  BatchSummary,
  DigestInput,
  Memory,
  MemoryType,
  RelationKind,
  RetrievalExplanation,
  StoreInput,
  UpdateInput,
  SnapshotInput,
} from "./types.js";
import type { SnapshotIntegrity } from "./snapshot-integrity.js";

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface RemembraOptions {
  /** Base server URL, for example `http://127.0.0.1:8787`. */
  endpoint: string;
  /** Optional HTTP API key. It is sent as `x-api-key`. */
  apiKey?: string;
  /** Injectable fetch implementation for tests, browsers, or custom runtimes. */
  fetch?: FetchLike;
  /** Additional headers sent with every request. */
  headers?: Record<string, string>;
}

export interface SdkProvenance {
  sourceType?: "manual" | "conversation" | "import" | "system";
  sessionId?: string;
  messageId?: string;
  provider?: string;
}

export type SdkStoreInput = Pick<StoreInput, "type" | "content"> &
  Partial<Omit<StoreInput, "type" | "content" | "provenance" | "owner" | "access">> & {
    provenance?: SdkProvenance;
  };

export const MAX_SDK_TIMEOUT_MS = 120_000;

export interface RequestOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
  /** Optional per-request timeout; bounded to 1–120 seconds when supplied. */
  timeoutMs?: number;
  /** Optional correlation ID; bounded to 128 safe ASCII characters. */
  requestId?: string;
}

export interface SearchOptions {
  query?: string;
  scope?: string;
  type?: MemoryType;
  limit?: number;
  explain?: boolean;
  includeExpired?: boolean;
  includeFuture?: boolean;
  includeQuarantined?: boolean;
  includeArchived?: boolean;
}

export interface ListOptions {
  scope?: string;
  type?: MemoryType;
  includeArchived?: boolean;
  includeQuarantined?: boolean;
  includeExpired?: boolean;
  includeFuture?: boolean;
  offset?: number;
  limit?: number;
}

export interface ContextOptions {
  query?: string;
  scope?: string;
  maxTokens?: number;
  limit?: number;
  explain?: boolean;
  includeArchived?: boolean;
  includeExpired?: boolean;
  includeFuture?: boolean;
  includeQuarantined?: boolean;
}

export interface TenantEntityOptions {
  offset?: number;
  limit?: number;
}

export interface TenantEntityWriteInput {
  displayName?: string;
  /** Resource references for agents; these are not authoritative identities. */
  userRef?: string;
  projectRef?: string;
}

export interface TenantOrganizationResponse {
  organizationId: string;
  membershipVersion: string;
}

export interface TenantMembershipResponse {
  ok: boolean;
}

export interface HistoryOptions {
  limit?: number;
}

export interface RelationOptions {
  action?: "add" | "remove";
  kind?: RelationKind;
}

export interface RemembraApiErrorBody {
  error?: string;
  code?: string;
  [key: string]: unknown;
}

/** A structured non-2xx response from the Remembra HTTP API. */
export class RemembraApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: RemembraApiErrorBody;

  constructor(status: number, body: RemembraApiErrorBody) {
    const message = typeof body.error === "string" ? body.error : `HTTP ${status}`;
    super(message);
    this.name = "RemembraApiError";
    this.status = status;
    this.code = typeof body.code === "string" ? body.code : `HTTP_${status}`;
    this.body = body;
  }
}

/** A bounded client-side timeout, distinct from a caller abort or HTTP error. */
export class RemembraTimeoutError extends Error {
  readonly code = "TIMEOUT" as const;
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Remembra request timed out after ${timeoutMs}ms`);
    this.name = "RemembraTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export interface StoreResponse {
  id: string;
  message: string;
  memory: Memory;
}

export interface SearchResponse {
  text: string;
  results: Memory[];
  explanations?: RetrievalExplanation[];
}

export interface ListResponse {
  text: string;
  memories: Memory[];
  total: number;
  offset?: number;
  limit?: number;
}

export type SnapshotDocument = SnapshotInput;
export type { SnapshotIntegrity } from "./snapshot-integrity.js";

export type SignedSnapshotDocument = SnapshotDocument & { integrity: SnapshotIntegrity };

export interface SnapshotImportResponse {
  imported: number;
  skipped: number;
}

export interface RelatedMemory {
  id: string;
  kind: RelationKind;
  type?: MemoryType;
  scope?: string;
  content?: string;
  missing?: true;
}

export interface GetResponse {
  memory: Memory;
  related: RelatedMemory[];
  backlinks: RelatedMemory[];
  text: string;
}

export interface UpdateResponse {
  memory: Memory;
  text: string;
}

export interface DeleteResponse {
  ok: boolean;
  text: string;
}

export interface DigestResponse {
  extracted: number;
  stored: Memory[];
  skippedDuplicates: number;
  merged: number;
  ids: string[];
}

export interface MaintainResponse {
  archived: string[];
  deleted: string[];
  embedded: number;
  [key: string]: unknown;
}

export interface LifecycleResponse {
  memory: Memory;
  text: string;
}

export interface RelationResponse {
  id: string;
  related: string[];
  added: string[];
  removed: string[];
  text: string;
}

export interface HistoryVersion {
  current?: true;
  file?: string;
  at?: string;
  snapshotAt?: string;
  reason?: string;
  supersededAt?: string;
  content: string;
  diff: string;
}

export interface HistoryResponse {
  id: string;
  versions: HistoryVersion[];
  text: string;
}

export type BatchResponse =
  | { operation: "store" | "update" | "delete"; summary: BatchSummary; results: BatchOutcome[] }
  | {
      operation: "export";
      format: string;
      version: number;
      exportedAt: string;
      memories: Memory[];
      summary: BatchSummary;
      results: BatchOutcome[];
    };

/**
 * Side-effect-free TypeScript client for the versioned Remembra HTTP API.
 *
 * Import through `@hilbras/remembra/sdk`; importing the package root remains
 * the CLI entrypoint for backwards compatibility.
 */
export class Remembra {
  readonly endpoint: string;
  readonly apiVersion = API_VERSION;
  private readonly baseEndpoint: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: FetchLike;
  private readonly defaultHeaders: Record<string, string>;

  constructor(options: RemembraOptions) {
    if (!options.endpoint || !/^https?:\/\//i.test(options.endpoint)) {
      throw new TypeError("Remembra endpoint must be an http(s) URL");
    }
    const trimmed = options.endpoint.replace(/\/+$/, "");
    this.endpoint = trimmed;
    this.baseEndpoint = trimmed.endsWith(API_PREFIX)
      ? trimmed.slice(0, -API_PREFIX.length)
      : trimmed;
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.defaultHeaders = { ...options.headers };
    if (!this.fetchImpl) throw new TypeError("No fetch implementation is available");
  }

  capabilities(options?: RequestOptions): Promise<ApiCapabilitiesResponse> {
    return this.request("GET", "/capabilities", undefined, options);
  }

  createSnapshot(options?: RequestOptions): Promise<SnapshotDocument | SignedSnapshotDocument> {
    return this.request("GET", "/snapshot", undefined, options);
  }

  restoreSnapshot(
    snapshot: SnapshotDocument | SignedSnapshotDocument,
    options?: RequestOptions,
  ): Promise<SnapshotImportResponse> {
    return this.request("POST", "/import", snapshot, {
      ...options,
      allowSnapshotEnvelope: true,
    });
  }

  store(input: SdkStoreInput, options?: RequestOptions): Promise<StoreResponse> {
    return this.request("POST", "/memories", input, options);
  }

  search(params: SearchOptions = {}, options?: RequestOptions): Promise<SearchResponse> {
    return this.request("GET", "/memories/search", undefined, {
      ...options,
      query: params as Record<string, unknown>,
    });
  }

  list(params: ListOptions = {}, options?: RequestOptions): Promise<ListResponse> {
    return this.request("GET", "/memories", undefined, {
      ...options,
      query: params as Record<string, unknown>,
    });
  }

  context(input: ContextOptions, options?: RequestOptions): Promise<ContextResult> {
    return this.request("POST", "/context", input, options);
  }

  tenantOrganization(options?: RequestOptions): Promise<TenantOrganizationResponse> {
    return this.request("GET", "/tenant/organization", undefined, options);
  }

  listTenantEntities(
    kind: TenantEntityKind,
    params: TenantEntityOptions = {},
    options?: RequestOptions,
  ): Promise<TenantEntityPage> {
    return this.request("GET", `/tenant/entities/${encodeURIComponent(kind)}`, undefined, {
      ...options,
      query: params as Record<string, unknown>,
    });
  }

  listTenantMemberships(
    projectId: string,
    params: TenantEntityOptions = {},
    options?: RequestOptions,
  ): Promise<TenantMembershipPage> {
    return this.request("GET", `/tenant/memberships/${encodeURIComponent(projectId)}`, undefined, {
      ...options,
      query: params as Record<string, unknown>,
    });
  }

  getTenantEntity(
    kind: TenantEntityKind,
    id: string,
    options?: RequestOptions,
  ): Promise<TenantEntity> {
    return this.request("GET", `/tenant/entities/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`, undefined, options);
  }

  createTenantEntity(
    kind: TenantEntityKind,
    id: string,
    input: TenantEntityWriteInput = {},
    options?: RequestOptions,
  ): Promise<TenantEntity> {
    return this.request("POST", `/tenant/entities/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`, input, options);
  }

  updateTenantEntity(
    kind: TenantEntityKind,
    id: string,
    input: TenantEntityWriteInput = {},
    options?: RequestOptions,
  ): Promise<TenantEntity> {
    return this.request("PUT", `/tenant/entities/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`, input, options);
  }

  deleteTenantEntity(
    kind: TenantEntityKind,
    id: string,
    options?: RequestOptions,
  ): Promise<{ ok: boolean }> {
    return this.request("DELETE", `/tenant/entities/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`, undefined, options);
  }

  grantTenantMembership(
    projectId: string,
    userId: string,
    role: "member" | "manager" | "admin" = "member",
    options?: RequestOptions,
  ): Promise<TenantMembershipResponse> {
    return this.request("POST", `/tenant/memberships/${encodeURIComponent(projectId)}/${encodeURIComponent(userId)}`, { role }, options);
  }

  revokeTenantMembership(
    projectId: string,
    userId: string,
    options?: RequestOptions,
  ): Promise<TenantMembershipResponse> {
    return this.request("DELETE", `/tenant/memberships/${encodeURIComponent(projectId)}/${encodeURIComponent(userId)}`, undefined, options);
  }

  get(id: string, options?: RequestOptions): Promise<GetResponse> {
    return this.request("GET", `/memories/${encodeURIComponent(id)}`, undefined, options);
  }

  update(
    id: string,
    patch: Omit<UpdateInput, "id">,
    options?: RequestOptions,
  ): Promise<UpdateResponse> {
    return this.request("PUT", `/memories/${encodeURIComponent(id)}`, patch, options);
  }

  forget(id: string, options?: RequestOptions): Promise<DeleteResponse> {
    return this.request("DELETE", `/memories/${encodeURIComponent(id)}`, undefined, options);
  }

  archive(id: string, options?: RequestOptions): Promise<LifecycleResponse> {
    return this.request("POST", `/memories/${encodeURIComponent(id)}/archive`, {}, options);
  }

  revive(id: string, options?: RequestOptions): Promise<LifecycleResponse> {
    return this.request("POST", `/memories/${encodeURIComponent(id)}/revive`, {}, options);
  }

  digest(input: DigestInput, options?: RequestOptions): Promise<DigestResponse> {
    return this.request("POST", "/memories/digest", input, options);
  }

  maintain(options?: RequestOptions): Promise<MaintainResponse> {
    return this.request("POST", "/maintain", {}, options);
  }

  history(
    id: string,
    params: HistoryOptions = {},
    options?: RequestOptions,
  ): Promise<HistoryResponse> {
    return this.request("GET", `/memories/${encodeURIComponent(id)}/history`, undefined, {
      ...options,
      query: params as Record<string, unknown>,
    });
  }

  related(
    id: string,
    related: string[],
    params: RelationOptions = {},
    options?: RequestOptions,
  ): Promise<RelationResponse> {
    return this.request("POST", `/memories/${encodeURIComponent(id)}/relate`, {
      related,
      ...params,
    }, options);
  }

  batch(input: BatchRequest, options?: RequestOptions): Promise<BatchResponse> {
    return this.request("POST", "/memories/batch", input, options);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options: RequestOptions & {
      query?: Record<string, unknown>;
      /** Internal escape hatch for the server-validated snapshot envelope. */
      allowSnapshotEnvelope?: boolean;
    } = {},
  ): Promise<T> {
    const url = new URL(`${this.baseEndpoint}${API_PREFIX}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(key, String(item));
      } else {
        url.searchParams.set(key, String(value));
      }
    }

    const headers = new Headers(this.defaultHeaders);
    for (const [key, value] of Object.entries(options.headers ?? {})) headers.set(key, value);
    if (this.apiKey) headers.set("x-api-key", this.apiKey);
    const requestId = options.requestId ?? headers.get(REQUEST_ID_HEADER) ?? createRequestId();
    if (!isValidRequestId(requestId)) {
      throw new TypeError("requestId must be 1-128 characters using letters, digits, '.', '_', ':', or '-'");
    }
    headers.set(REQUEST_ID_HEADER, requestId);
    if (body !== undefined) headers.set("content-type", "application/json");

    assertNoUntrustedIdentity(body, "input", new WeakSet<object>(), options.allowSnapshotEnvelope === true);
    assertNoUntrustedTenantHeaders(headers);
    const timeoutMs = options.timeoutMs;
    if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_SDK_TIMEOUT_MS)) {
      throw new TypeError(`timeoutMs must be an integer between 1 and ${MAX_SDK_TIMEOUT_MS}`);
    }
    const controller = timeoutMs === undefined ? undefined : new AbortController();
    let timedOut = false;
    const onAbort = () => controller?.abort();
    if (controller && options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }
    const timer = controller && timeoutMs !== undefined
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs)
      : undefined;
    try {
      const response = await this.fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller?.signal ?? options.signal,
      });
      const text = await response.text();
      if (timedOut && timeoutMs !== undefined) throw new RemembraTimeoutError(timeoutMs);
      let parsed: unknown = undefined;
      if (text.length > 0) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }

      if (!response.ok) {
        const errorBody =
          parsed && typeof parsed === "object" ? (parsed as RemembraApiErrorBody) : { error: text };
        throw new RemembraApiError(response.status, errorBody);
      }
      return parsed as T;
    } catch (error) {
      if (timedOut && timeoutMs !== undefined) throw new RemembraTimeoutError(timeoutMs);
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (controller) options.signal?.removeEventListener("abort", onAbort);
    }
  }
}

function createRequestId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const IDENTITY_KEYS = new Set([
  "agent",
  "agentid",
  "agenttype",
  "agentversion",
  "owner",
  "access",
  "tenant",
  "tenantid",
  "organization",
  "organizationid",
  "user",
  "userid",
  "project",
  "projectid",
  "membershipversion",
]);
const normalizeIdentityKey = (key: string): string => key.replace(/[-_]/g, "").toLowerCase();

const TENANT_HEADER = /^(?:x-)?(?:remembra-)?(?:tenant|tenant-id|organization|organization-id|user|user-id|project|project-id|agent|agent-id)$/i;

function assertNoUntrustedTenantHeaders(headers: Headers): void {
  for (const key of headers.keys()) {
    if (TENANT_HEADER.test(key)) {
      throw new TypeError(`header ${key} is server-managed and cannot be sent by the SDK`);
    }
  }
}

function isSnapshotEnvelope(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.format === "string"
    && Number.isInteger(record.version)
    && Array.isArray(record.memories);
}

function assertNoUntrustedIdentity(
  value: unknown,
  path = "input",
  seen = new WeakSet<object>(),
  allowSnapshotEnvelope = false,
): void {
  if (value === null || typeof value !== "object") return;
  if (allowSnapshotEnvelope && path === "input" && isSnapshotEnvelope(value)) return;
  if (seen.has(value)) throw new TypeError(`${path} must be JSON-serializable`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoUntrustedIdentity(item, `${path}[${index}]`, seen, allowSnapshotEnvelope));
  } else {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (IDENTITY_KEYS.has(normalizeIdentityKey(key))) {
        throw new TypeError(`${path}.${key} is server-managed and cannot be sent by the SDK`);
      }
      assertNoUntrustedIdentity(child, `${path}.${key}`, seen, allowSnapshotEnvelope);
    }
  }
  seen.delete(value);
}
