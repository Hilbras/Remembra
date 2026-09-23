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

export type EmbeddingProvider = "openai" | "ollama" | "none";

export function resolveEmbeddingProvider(): EmbeddingProvider {
  const v = (process.env.REMEMBRA_EMBEDDINGS ?? "none").toLowerCase();
  if (v === "openai" || v === "ollama" || v === "none") return v;
  throw new Error(`Invalid REMEMBRA_EMBEDDINGS "${v}" — expected openai|ollama|none`);
}

export interface EmbedCallOptions {
  signal?: AbortSignal;
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
