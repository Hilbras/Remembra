// API client — same-origin fetches, API key kept in sessionStorage
// (per-tab, gone when the tab closes; never persisted to disk).

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const KEY_STORAGE = "remembra.key";

export interface MemoryRec {
  id: string;
  type: "fact" | "decision" | "role" | "history";
  content: string;
  scope: string;
  tags: string[];
  importance: number;
  source?: string;
  confidence?: number;
  provenance?: string;
  embedding?: number[];
  related?: string[];
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface ListResult {
  text?: string;
  memories: MemoryRec[];
  total: number;
  offset?: number;
  limit?: number;
}

export interface SearchResult {
  text?: string;
  results: MemoryRec[];
}

/** First-line brief of a linked memory (service.get). */
export interface Brief {
  id: string;
  type?: string;
  scope?: string;
  content?: string;
  missing?: true;
}

export interface RelatedInfo {
  related: Brief[];
  backlinks: Brief[];
}

export interface HistoryVersion {
  current?: true;
  file?: string;
  at?: string;
  snapshotAt?: string;
  content: string;
  diff: string;
}

export interface DigestResult {
  extracted: number;
  stored: MemoryRec[];
  skippedDuplicates: number;
  merged: number;
  ids: string[];
}

export interface MaintainResult {
  archived: string[];
  deleted: string[];
  embedded: number;
  revived?: number;
}

export interface HealthResult {
  status: "ok" | "unready";
  version: string;
  uptime_s: number;
  storage: string;
  cache?: { size: number; capacity: number };
}

const storage = (): Storage => {
  try {
    return window.sessionStorage;
  } catch {
    // Private-mode fallback: in-memory only.
    const mem = new Map<string, string>();
    return {
      get length() {
        return mem.size;
      },
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
      key: (i: number) => [...mem.keys()][i] ?? null,
      clear: () => mem.clear(),
    } as Storage;
  }
};

export const api = {
  getKey(): string | null {
    return storage().getItem(KEY_STORAGE);
  },
  setKey(key: string): void {
    storage().setItem(KEY_STORAGE, key);
  },
  clearKey(): void {
    storage().removeItem(KEY_STORAGE);
  },

  async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const key = api.getKey();
    const headers: Record<string, string> = {};
    if (key) headers["x-api-key"] = key;
    if (body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await fetch(path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError(0, "Server unreachable");
    }
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON body — keep null */
    }
    if (!res.ok) {
      const d = data as { error?: string; code?: string } | null;
      throw new ApiError(res.status, d?.error ?? `HTTP ${res.status}`, d?.code);
    }
    return data as T;
  },

  // read
  health: () => api.req<HealthResult>("GET", "/health"),
  metricsText: async (): Promise<string> => {
    const key = api.getKey();
    const res = await fetch("/metrics", { headers: key ? { "x-api-key": key } : {} });
    if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`);
    return res.text();
  },
  list: (q: Record<string, string | number | boolean | undefined>): Promise<ListResult> =>
    api.req("GET", `/memories${qs(q)}`),
  search: (q: Record<string, string | number | undefined>): Promise<SearchResult> =>
    api.req("GET", `/memories/search${qs(q)}`),
  get: (id: string): Promise<{ memory: MemoryRec } & RelatedInfo> =>
    api.req("GET", `/memories/${encodeURIComponent(id)}`),
  history: (id: string, limit?: number): Promise<{ id: string; versions: HistoryVersion[]; text: string }> =>
    api.req("GET", `/memories/${encodeURIComponent(id)}/history${limit ? `?limit=${limit}` : ""}`),

  // write
  store: (input: unknown) => api.req<{ memory: MemoryRec }>("POST", "/memories", input),
  update: (id: string, patch: unknown) =>
    api.req<{ memory: MemoryRec }>("PUT", `/memories/${encodeURIComponent(id)}`, patch),
  forget: (id: string) =>
    api.req<{ ok: boolean }>("DELETE", `/memories/${encodeURIComponent(id)}`),
  archive: (id: string) =>
    api.req<{ memory: MemoryRec }>("POST", `/memories/${encodeURIComponent(id)}/archive`),
  revive: (id: string) =>
    api.req<{ memory: MemoryRec }>("POST", `/memories/${encodeURIComponent(id)}/revive`),
  relate: (id: string, body: unknown) =>
    api.req("POST", `/memories/${encodeURIComponent(id)}/relate`, body),
  digest: (input: { transcript: string; scope?: string; source?: string }): Promise<DigestResult> =>
    api.req("POST", "/memories/digest", input),
  maintain: (): Promise<MaintainResult> => api.req("POST", "/maintain"),
  snapshot: () => api.req<{ format: string; version: number; exportedAt: string; memories: MemoryRec[] }>(
    "GET",
    "/snapshot",
  ),
  importSnapshot: (data: unknown) =>
    api.req<{ imported: number; skipped: number }>("POST", "/import", data),
};

function qs(q: Record<string, string | number | boolean | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === "" || v === false) continue;
    p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}
