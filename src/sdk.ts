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
} from "./types.js";

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

export interface RequestOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
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
  readonly apiVersion = "v1" as const;
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
    this.baseEndpoint = trimmed.endsWith("/api/v1")
      ? trimmed.slice(0, -"/api/v1".length)
      : trimmed;
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.defaultHeaders = { ...options.headers };
    if (!this.fetchImpl) throw new TypeError("No fetch implementation is available");
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
    options: RequestOptions & { query?: Record<string, unknown> } = {},
  ): Promise<T> {
    const url = new URL(`${this.baseEndpoint}/api/v1${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(key, String(item));
      } else {
        url.searchParams.set(key, String(value));
      }
    }

    const headers = new Headers(this.defaultHeaders);
    if (this.apiKey) headers.set("x-api-key", this.apiKey);
    for (const [key, value] of Object.entries(options.headers ?? {})) headers.set(key, value);
    if (body !== undefined) headers.set("content-type", "application/json");

    assertNoUntrustedIdentity(body);
    const response = await this.fetchImpl(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: options.signal,
    });
    const text = await response.text();
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
  }
}

const IDENTITY_KEYS = new Set([
  "agent",
  "agentId",
  "agentType",
  "agentVersion",
  "owner",
  "access",
]);

function assertNoUntrustedIdentity(
  value: unknown,
  path = "input",
  seen = new WeakSet<object>(),
): void {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) throw new TypeError(`${path} must be JSON-serializable`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoUntrustedIdentity(item, `${path}[${index}]`, seen));
  } else {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (IDENTITY_KEYS.has(key)) {
        throw new TypeError(`${path}.${key} is server-managed and cannot be sent by the SDK`);
      }
      assertNoUntrustedIdentity(child, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}
