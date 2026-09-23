/**
 * Pluggable embedding provider (v2).
 *
 * Config: REMEMBRA_EMBEDDINGS=openai|ollama|none   (default: none → keyword-only, v1 behavior)
 * Keys:   OPENAI_API_KEY / OLLAMA_HOST (default localhost:11434)
 *
 * Vectors are computed once on write and cached in the memory file's frontmatter.
 * All requests go through the provider policy (src/provider.ts): timeout,
 * bounded retries, overall budget, cancellation, error normalization (§3.7).
 */
import { providerFetch } from "./provider.js";
import { RemembraError } from "./errors.js";
import { metrics } from "./metrics.js";

export type EmbeddingProvider = "openai" | "ollama" | "none";

export function resolveEmbeddingProvider(): EmbeddingProvider {
  const v = (process.env.REMEMBRA_EMBEDDINGS ?? "none").toLowerCase();
  if (v === "openai" || v === "ollama" || v === "none") return v;
  throw new Error(`Invalid REMEMBRA_EMBEDDINGS "${v}" — expected openai|ollama|none`);
}

export interface EmbedCallOptions {
  signal?: AbortSignal;
}

export interface BatchEmbedOptions extends EmbedCallOptions {
  /** Maximum number of inputs sent in one logical batch. */
  maxBatchSize?: number;
  /** Maximum provider calls running at once. */
  concurrency?: number;
  /** Injectable provider function for deterministic tests and adapters. */
  embedder?: (
    text: string,
    provider: EmbeddingProvider,
    opts?: EmbedCallOptions,
  ) => Promise<number[]>;
}

export async function embedText(
  text: string,
  provider: EmbeddingProvider = resolveEmbeddingProvider(),
  opts?: EmbedCallOptions,
): Promise<number[]> {
  if (provider === "none") throw new Error("embeddings disabled (REMEMBRA_EMBEDDINGS=none)");

  if (provider === "openai") {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error("REMEMBRA_EMBEDDINGS=openai requires OPENAI_API_KEY");
    const data = await providerFetch("https://api.openai.com/v1/embeddings", {
      label: "embeddings",
      headers: { authorization: `Bearer ${key}` },
      body: {
        model: process.env.REMEMBRA_EMBEDDING_MODEL ?? "text-embedding-3-small",
        input: text,
      },
      signal: opts?.signal,
    });
    return toVector(data?.data?.[0]?.embedding, "openai");
  }

  // ollama
  const host = process.env.OLLAMA_HOST ?? "http://localhost:11434";
  const data = await providerFetch(`${host}/api/embeddings`, {
    label: "embeddings",
    body: {
      model: process.env.REMEMBRA_EMBEDDING_MODEL ?? "nomic-embed-text",
      prompt: text,
    },
    signal: opts?.signal,
  });
  return toVector(data?.embedding, "ollama");
}

/**
 * Embed a bounded collection with deterministic per-item failure isolation.
 * Provider calls are chunked and concurrently limited; callers receive null
 * for failed/disabled items just like embedCached's fail-open contract.
 */
export async function embedTexts(
  texts: readonly string[],
  provider: EmbeddingProvider = resolveEmbeddingProvider(),
  opts: BatchEmbedOptions = {},
): Promise<Array<number[] | null>> {
  if (!Array.isArray(texts) || texts.some((text) => typeof text !== "string")) {
    throw new RemembraError("INVALID_INPUT", "texts must be an array of strings");
  }
  const maxBatchSize = positiveLimit(
    opts.maxBatchSize ?? Number(process.env.REMEMBRA_MAX_BATCH_SIZE ?? 32),
    "maxBatchSize",
  );
  const concurrency = positiveLimit(
    opts.concurrency ?? Number(process.env.REMEMBRA_MAX_CONCURRENT_EMBEDDINGS ?? 4),
    "concurrency",
  );
  const embed = opts.embedder ?? embedCached;
  const results = new Array<number[] | null>(texts.length).fill(null);

  for (let start = 0; start < texts.length; start += maxBatchSize) {
    const end = Math.min(texts.length, start + maxBatchSize);
    let cursor = start;
    const worker = async (): Promise<void> => {
      while (true) {
        if (opts.signal?.aborted) return;
        const index = cursor++;
        if (index >= end) return;
        try {
          results[index] = await embed(texts[index], provider, { signal: opts.signal });
          const outcome = results[index] ? "success" : provider === "none" ? "disabled" : "failure";
          metrics.inc("remembra_embedding_batch_items_total", { result: outcome });
          if (outcome === "failure") metrics.inc("remembra_embedding_batch_failures_total");
        } catch {
          results[index] = null;
          metrics.inc("remembra_embedding_batch_items_total", { result: "failure" });
          metrics.inc("remembra_embedding_batch_failures_total");
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(concurrency, end - start) }, () => worker()),
    );
  }
  return results;
}

function positiveLimit(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RemembraError("INVALID_INPUT", `${name} must be a positive integer`);
  }
  return value;
}


/** Validate the provider's answer: a non-empty array of finite numbers. */
function toVector(v: unknown, provider: string): number[] {
  if (
    !Array.isArray(v) ||
    v.length === 0 ||
    !v.every((n): n is number => typeof n === "number" && Number.isFinite(n))
  ) {
    throw new RemembraError("LLM_ERROR", `${provider} returned a malformed embedding vector`);
  }
  return v;
}

export function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ---------------------------------------------------------------------------
// V4.2.0: query-embedding cache (plan §5.9). In-memory, TTL-based, keyed by
// (model, textHash) — avoids redundant provider calls for repeated queries.
// ---------------------------------------------------------------------------
const EMBED_CACHE_TTL_MS =
  Number(process.env.REMEMBRA_EMBEDDING_CACHE_TTL_MS) || 3_600_000; // 1h default
interface EmbedCacheEntry {
  vec: number[];
  ts: number;
}
const embedCache = new Map<string, EmbedCacheEntry>();

/** murmur-like 32-bit hash of a short string (enough to key the cache, not crypto). */
function hashStr(s: string): number {
  let h = 0xdeadbeef;
  for (let i = 0; i < s.length; i++) {
    h = (h + s.charCodeAt(i)) | 0;
    h = (h ^ (h >>> 11)) >>> 0;
  }
  return h >>> 0;
}

/**
 * Look up (or compute + cache) an embedding vector for the given text.
 * Falls back to a direct embedText call on miss/expired.
 */
export async function embedCached(
  text: string,
  provider: EmbeddingProvider = resolveEmbeddingProvider(),
  opts?: EmbedCallOptions,
): Promise<number[] | null> {
  if (provider === "none") return null;
  const model =
    provider === "openai"
      ? process.env.REMEMBRA_EMBEDDING_MODEL ?? "text-embedding-3-small"
      : process.env.REMEMBRA_EMBEDDING_MODEL ?? "nomic-embed-text";
  const key = `${model}:${hashStr(text)}`;
  const now = Date.now();
  const hit = embedCache.get(key);
  if (hit && now - hit.ts < EMBED_CACHE_TTL_MS) return hit.vec;
  try {
    const vec = await embedText(text, provider, opts);
    embedCache.set(key, { vec, ts: now });
    return vec;
  } catch {
    return null;
  }
}

/** Exposed for tests to reset the cache between runs. */
export function clearEmbedCache(): void {
  embedCache.clear();
}

/** Exposed for metrics (plan §V4.2.0 — observability on the retrieval path). */
export function embedCacheStats(): { size: number; capacity_ms: number; ttl_ms: number } {
  return {
    size: embedCache.size,
    capacity_ms: EMBED_CACHE_TTL_MS,
    ttl_ms: EMBED_CACHE_TTL_MS,
  };
}
