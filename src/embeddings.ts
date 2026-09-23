/**
 * Pluggable embedding provider (v2).
 *
 * Config: REMEMBRA_EMBEDDINGS=openai|ollama|none   (default: none → keyword-only, v1 behavior)
 * Keys:   OPENAI_API_KEY / OLLAMA_HOST (default localhost:11434)
 *
 * Vectors are computed once on write and cached in the memory file's frontmatter.
 */

export type EmbeddingProvider = "openai" | "ollama" | "none";

export function resolveEmbeddingProvider(): EmbeddingProvider {
  const v = (process.env.REMEMBRA_EMBEDDINGS ?? "none").toLowerCase();
  if (v === "openai" || v === "ollama" || v === "none") return v;
  throw new Error(`Invalid REMEMBRA_EMBEDDINGS "${v}" — expected openai|ollama|none`);
}

export async function embedText(
  text: string,
  provider: EmbeddingProvider = resolveEmbeddingProvider(),
): Promise<number[]> {
  if (provider === "none") throw new Error("embeddings disabled (REMEMBRA_EMBEDDINGS=none)");

  if (provider === "openai") {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error("REMEMBRA_EMBEDDINGS=openai requires OPENAI_API_KEY");
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: process.env.REMEMBRA_EMBEDDING_MODEL ?? "text-embedding-3-small",
        input: text,
      }),
    });
    if (!res.ok) throw new Error(`OpenAI embeddings failed: ${res.status}`);
    const data = (await res.json()) as { data: { embedding: number[] }[] };
    return data.data[0].embedding;
  }

  // ollama
  const host = process.env.OLLAMA_HOST ?? "http://localhost:11434";
  const res = await fetch(`${host}/api/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: process.env.REMEMBRA_EMBEDDING_MODEL ?? "nomic-embed-text",
      prompt: text,
    }),
  });
  if (!res.ok) throw new Error(`Ollama embeddings failed: ${res.status}`);
  const data = (await res.json()) as { embedding: number[] };
  return data.embedding;
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
