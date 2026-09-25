import { API_PREFIX, API_VERSION, IDEMPOTENCY_KEY_HEADER, REQUEST_ID_HEADER, isValidIdempotencyKey, isValidRequestId, type ApiCapabilitiesResponse } from "./api-contract.js";
export type { ApiCapabilitiesResponse } from "./api-contract.js";
import type { ContextResult } from "./context.js";
import type { TenantEntity, TenantEntityKind, TenantEntityPage, TenantMembershipPage } from "./tenant-entities.js";
export type { TenantEntity, TenantEntityKind, TenantEntityPage, TenantMembershipPage } from "./tenant-entities.js";
export type { ContextMemory, ContextResult } from "./context.js";
export type { BatchSearchResult } from "./types.js";
import type {
  BatchExecutionMetadata,
  BatchOutcome,
  BatchRequest,
  BatchSearchResult,
  BatchSummary,
  DigestInput,
  Memory,
  MemoryType,
  RelationKind,
  RetrievalExplanation,
  SearchInput,
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

export type SdkBatchUpdateItem = { id: string } & Partial<Omit<UpdateInput, "id">>;

/** SDK-friendly batch input; server validation remains authoritative. */
export type SdkBatchRequestInput =
  | { operation: "store"; items: SdkStoreInput[] }
  | { operation: "update"; items: SdkBatchUpdateItem[] }
  | { operation: "delete"; ids: string[] }
  | { operation: "export"; ids: string[] }
  | { operation: "search"; items: SearchOptions[] };

/** Preserve the pre-V5.4 four-operation input type as a deprecated compile-time overload. */
export type LegacyBatchRequest =
  | Extract<BatchRequest, { operation: "store" }>
  | Extract<BatchRequest, { operation: "update" }>
  | Extract<BatchRequest, { operation: "delete" }>
  | Extract<BatchRequest, { operation: "export" }>;

/** SDK batch input excludes server-managed identity fields. */
export type SafeSdkBatchRequest = SdkBatchRequestInput;

/** Preserve the exported pre-V5.4 alias while keeping SafeSdkBatchRequest preferred. */
export type SdkBatchRequest = SafeSdkBatchRequest | LegacyBatchRequest;

export const MAX_SDK_TIMEOUT_MS = 120_000;

export interface RetryOptions {
  /** Total attempts, including the first request. */
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export interface RequestOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
  /** Optional per-request timeout; bounded to 1–120 seconds when supplied. */
  timeoutMs?: number;
  /** Optional correlation ID; bounded to 128 safe ASCII characters. */
  requestId?: string;
  /** Optional bounded key for replay-safe batch mutations. */
  idempotencyKey?: string;
  /** Opt-in bounded retries; accepted only for read-only requests. */
  retry?: RetryOptions;
}

export type SearchOptions = SearchInput;

export interface ListOptions {
  scope?: string;
  type?: MemoryType;
  includeArchived?: boolean;
  includeQuarantined?: boolean;
  includeExpired?: boolean;
  includeFuture?: boolean;
  offset?: number;
  /** Opaque keyset cursor; do not combine with offset. */
  cursor?: string;
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

/** A transport failure that is neither an HTTP response nor a caller abort. */
export class RemembraNetworkError extends Error {
  readonly code = "NETWORK_ERROR" as const;
  readonly cause: unknown;

  constructor(cause: unknown) {
    super("Remembra network request failed");
    this.name = "RemembraNetworkError";
    this.cause = cause;
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
  cursor?: string;
  limit?: number;
  nextCursor?: string;
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
  | {
      operation: "store" | "update" | "delete";
      summary: BatchSummary;
      results: BatchOutcome[];
      execution: BatchExecutionMetadata;
    }
  | {
      operation: "export";
      format: string;
      version: number;
      exportedAt: string;
      memories: Memory[];
      summary: BatchSummary;
      results: BatchOutcome[];
      execution: BatchExecutionMetadata;
    }
  | BatchSearchResult;

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

  batch(input: LegacyBatchRequest, options?: RequestOptions): Promise<BatchResponse>;
  batch(input: SdkBatchRequest, options?: RequestOptions): Promise<BatchResponse>;
  async batch(input: SdkBatchRequest | LegacyBatchRequest, options?: RequestOptions): Promise<BatchResponse> {
    const response = await this.request<unknown>("POST", "/memories/batch", input, options);
    const headerKey = Object.entries({ ...this.defaultHeaders, ...options?.headers })
      .find(([name, value]) => name.toLowerCase() === IDEMPOTENCY_KEY_HEADER.toLowerCase() && typeof value === "string");
    const keyed = options?.idempotencyKey !== undefined || headerKey !== undefined;
    if (!isBatchResponse(response, input, keyed)) {
      throw new TypeError("server returned an invalid batch response");
    }
    return response as BatchResponse;
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
    const retry = options.retry;
    const attempts = retry?.attempts ?? 1;
    const baseDelayMs = retry?.baseDelayMs ?? 100;
    const maxDelayMs = retry?.maxDelayMs ?? 1_000;
    if (retry && method !== "GET" && method !== "HEAD") {
      throw new TypeError("retry is only supported for read-only requests");
    }
    if (options.idempotencyKey !== undefined
      && (method !== "POST" || path !== "/memories/batch" || rejectsBatchIdempotency(body))) {
      throw new TypeError("idempotencyKey is only supported for batch mutations");
    }
    if (options.idempotencyKey !== undefined && !isValidIdempotencyKey(options.idempotencyKey)) {
      throw new TypeError("idempotencyKey must be 1-128 safe ASCII characters");
    }
    if (!Number.isInteger(attempts) || attempts < 1 || attempts > 3) {
      throw new TypeError("retry attempts must be an integer between 1 and 3");
    }
    if (!Number.isInteger(baseDelayMs) || baseDelayMs < 0 || baseDelayMs > 1_000) {
      throw new TypeError("retry baseDelayMs must be an integer between 0 and 1000");
    }
    if (!Number.isInteger(maxDelayMs) || maxDelayMs < baseDelayMs || maxDelayMs > 5_000) {
      throw new TypeError("retry maxDelayMs must be an integer between baseDelayMs and 5000");
    }
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await this.requestAttempt(method, path, body, options);
      } catch (error) {
        if (attempt >= attempts || !shouldRetryRequest(error)) throw error;
        const delay = Math.min(maxDelayMs, baseDelayMs * (2 ** (attempt - 1)));
        await waitForRetry(delay, options.signal);
      }
    }
    throw new Error("request retry loop exhausted");
  }

  private async requestAttempt<T>(
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
    const idempotencyKey = options.idempotencyKey ?? headers.get(IDEMPOTENCY_KEY_HEADER) ?? undefined;
    if (idempotencyKey !== undefined) {
      if (method !== "POST" || path !== "/memories/batch" || rejectsBatchIdempotency(body)) {
        throw new TypeError("idempotencyKey is only supported for batch mutations");
      }
      if (!isValidIdempotencyKey(idempotencyKey)) {
        throw new TypeError("idempotencyKey must be 1-128 safe ASCII characters");
      }
      headers.set(IDEMPOTENCY_KEY_HEADER, idempotencyKey);
    }
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
      if (options.signal?.aborted) throw error;
      if (error instanceof RemembraApiError || error instanceof RemembraTimeoutError || error instanceof RemembraNetworkError) {
        throw error;
      }
      throw new RemembraNetworkError(error);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (controller) options.signal?.removeEventListener("abort", onAbort);
    }
  }
}

function isBatchResponse(value: unknown, request: SdkBatchRequest | LegacyBatchRequest, keyed = false): value is BatchResponse {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  const operation = (request as { operation?: unknown }).operation;
  const expectedCount = operation === "store" || operation === "update" || operation === "search"
    ? ((request as { items?: unknown[] }).items?.length ?? -1)
    : ((request as { ids?: unknown[] }).ids?.length ?? -1);
  if (body.operation !== operation || !Array.isArray(body.results) || expectedCount < 1) return false;
  const summary = body.summary;
  if (summary === null || typeof summary !== "object" || Array.isArray(summary)) return false;
  const counts = summary as Record<string, unknown>;
  if (!Number.isInteger(counts.requested) || !Number.isInteger(counts.succeeded) || !Number.isInteger(counts.failed)) return false;
  const requested = counts.requested as number;
  const succeeded = counts.succeeded as number;
  const failed = counts.failed as number;
  if (requested < 1 || requested > 100 || succeeded < 0 || failed < 0 || succeeded + failed !== requested || requested !== expectedCount || body.results.length !== requested) return false;
  if (keyed && failed !== 0) return false;
  let actualSucceeded = 0;
  for (const [index, raw] of body.results.entries()) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return false;
    const outcome = raw as Record<string, unknown>;
    if (outcome.index !== index || typeof outcome.ok !== "boolean") return false;
    if (outcome.ok === false) {
      const keys = Object.keys(outcome).sort().join(",");
      if (keys !== "error,id,index,ok" && keys !== "error,index,ok") return false;
      const error = outcome.error;
      if (error === null || typeof error !== "object" || Array.isArray(error)) return false;
      const details = error as Record<string, unknown>;
      if (Object.keys(details).sort().join(",") !== "code,message" || typeof details.code !== "string" || typeof details.message !== "string") return false;
      continue;
    }
    const successKeys = Object.keys(outcome).sort().join(",");
    if (successKeys !== "id,index,ok,result" && successKeys !== "index,ok,result") return false;
    actualSucceeded++;
    const result = outcome.result;
    if (result === null || typeof result !== "object" || Array.isArray(result)) return false;
    const details = result as Record<string, unknown>;
    if (operation === "store" && (typeof details.id !== "string" || !details.id || typeof details.message !== "string")) return false;
    if (operation === "update" && (!Number.isInteger(details.version) || typeof details.text !== "string")) return false;
    if (operation === "delete" && typeof details.text !== "string") return false;
    if (operation === "export" && (typeof details.id !== "string" || !details.id)) return false;
    if (operation === "search"
      && (typeof details.text !== "string"
        || !Array.isArray(details.results)
        || (details.explanations !== undefined && !Array.isArray(details.explanations)))) return false;
    if (operation === "search") {
      const detailKeys = Object.keys(details).sort().join(",");
      if (detailKeys !== "results,text" && detailKeys !== "explanations,results,text") return false;
    }
  }
  if (actualSucceeded !== succeeded || requested - actualSucceeded !== failed) return false;
  if (operation === "export"
    && (typeof body.format !== "string"
      || !Number.isInteger(body.version)
      || typeof body.exportedAt !== "string"
      || !Array.isArray(body.memories))) return false;
  const execution = body.execution;
  if (execution === null || typeof execution !== "object" || Array.isArray(execution)) return false;
  const metadata = execution as Record<string, unknown>;
  const policyMatches = operation === "export" || operation === "search"
    ? metadata.transactionPolicy === "read-only" && metadata.idempotency === "read-only"
    : metadata.transactionPolicy === "per-item"
      && (keyed
        ? metadata.idempotency === "stored" || metadata.idempotency === "replayed"
        : metadata.idempotency === "unsupported");
  return policyMatches;
}

function rejectsBatchIdempotency(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const operation = (value as { operation?: unknown }).operation;
  return operation === "export" || operation === "search";
}

function shouldRetryRequest(error: unknown): boolean {
  if (error instanceof RemembraNetworkError || error instanceof RemembraTimeoutError) return true;
  if (error instanceof RemembraApiError) {
    return [408, 425, 429, 500, 502, 503, 504].includes(error.status);
  }
  return false;
}

function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Request aborted"));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason ?? new Error("Request aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
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
