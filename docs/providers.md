# AI Providers & Session Digest (v2)

Remembra can call an LLM to extract memories automatically (**session digest**)
and use embeddings for semantic search. Both are pluggable and off-by-default
where possible, so a plain keyword install still works with zero API keys.

## Configuration

| Variable | Values | Default | Purpose |
|----------|--------|---------|---------|
| `REMEMBRA_LLM` | `openai` \| `anthropic` \| `ollama` | `openai` | Which LLM does digest extraction |
| `REMEMBRA_LLM_MODEL` | provider model id | provider default | Override the extraction model |
| `REMEMBRA_EMBEDDINGS` | `openai` \| `ollama` \| `none` | `none` | Semantic search provider |
| `REMEMBRA_EMBEDDING_MODEL` | provider model id | provider default | Override the embedding model |
| `OPENAI_API_KEY` | — | — | Required when provider = openai |
| `ANTHROPIC_API_KEY` | — | — | Required when provider = anthropic |
| `OLLAMA_HOST` | URL | `http://localhost:11434` | Ollama endpoint (LLM and/or embeddings) |
| `REMEMBRA_PROVIDER_TIMEOUT_MS` | ms | `60000` | Per-attempt timeout for every provider call (4.0.1, plan §3.7) |
| `REMEMBRA_PROVIDER_RETRIES` | count | `2` | Retries after the first attempt — network errors, 408/429/5xx only |
| `REMEMBRA_PROVIDER_BUDGET_MS` | ms | `180000` | Wall-clock cap across all attempts; a hung provider can never block longer |
| `REMEMBRA_PROVIDER_BACKOFF_MS` | ms | `250` | Retry backoff base (doubles per retry, capped at 2s) |

### Examples

```bash
# OpenAI for both (simplest hosted setup)
export OPENAI_API_KEY=sk-...
export REMEMBRA_LLM=openai
export REMEMBRA_EMBEDDINGS=openai

# Fully local with Ollama — no API keys
export REMEMBRA_LLM=ollama
export REMEMBRA_LLM_MODEL=llama3.2
export REMEMBRA_EMBEDDINGS=ollama
export REMEMBRA_EMBEDDING_MODEL=nomic-embed-text

# Anthropic for extraction, semantic search off (keyword mode)
export ANTHROPIC_API_KEY=sk-ant-...
export REMEMBRA_LLM=anthropic
```

## Provider adapter contract

Provider integrations can be implemented without depending on a vendor SDK.
The public adapter types and built-in factories are available from the
side-effect-free `@hilbras/remembra/providers` subpath:

```ts
import {
  createInjectedEmbeddingAdapter,
  createInjectedLlmAdapter,
  createOpenAICompatibleLlmAdapter,
} from "@hilbras/remembra/providers";

const llm = createInjectedLlmAdapter("my-local-model", async ({ system, user }) => {
  return myModel.complete({ system, user });
});

const embeddings = createInjectedEmbeddingAdapter("my-local-embeddings", async (text) => {
  return myModel.embed(text);
});
```

`LlmAdapter` exposes `complete({ system, user }, context)` and
`EmbeddingAdapter` exposes `embed(text, context)`. A context carries an optional
`AbortSignal`, injectable `fetchImpl`, and `ProviderPolicy` override. Every
built-in HTTP adapter uses the same bounded `providerFetch` policy as the
legacy environment configuration; adapters do not retry or weaken policy on
their own.

Built-in factories are available for OpenAI-compatible chat/embedding APIs,
Anthropic messages, and Ollama chat/embeddings. `createLlmAdapter("openai")` and
`createEmbeddingAdapter("ollama")` select the corresponding legacy-compatible
implementation. The service accepts the same adapters through
`new MemoryService(backend, { llmAdapter, embeddingAdapter })`; adapter `id`
values are used for digest provenance while vendor credentials remain server
configuration.

OpenAI-compatible adapters accept `endpoint`, `apiKey`, `model`, and extra
headers, making local gateways and self-hosted implementations possible.
Anthropic and Ollama factories retain their existing environment defaults and
request/response validation.


Instead of the model remembering to call `memory_store` for every little thing,
hand the whole conversation to one tool at the end of a session:

```
memory_digest {
  transcript: "<full transcript or a detailed summary>",
  scope: "/path/to/project",   // optional, default global
  source: "opencode"            // optional
}
```

Remembra asks the configured LLM to extract memories of all **11 types**, then
stores each one — **skipping exact duplicates** that are already present
(normalized by type + scope + content). Running a digest twice over the same
conversation is a no-op.

Every extraction is stored with `provenance: { sourceType: "conversation",
provider: <llm> }` and `trust: unverified` (4.1.0, plan §4.3/§4.9) —
extracted roles/instructions never steer anything until someone approves
them; see [memory-model.md](memory-model.md#trust-410-plan-45).

HTTP equivalent:

```bash
curl -X POST http://localhost:8787/memories/digest \
  -H "content-type: application/json" \
  -H "x-api-key: $REMEMBRA_API_KEY" \
  -d '{"transcript":"...","scope":"chatgpt","source":"chatgpt"}'
```

Response:

```json
{
  "extracted": 4,
  "stored": [ ... ],
  "skippedDuplicates": 2,
  "ids": ["a1b2c3d4", "..."]
}
```

> **Note:** the digest LLM key is only needed when you actually call
> `memory_digest` — storage and search work without it.

## Semantic search

With `REMEMBRA_EMBEDDINGS=openai|ollama`:

- **On write**: every stored memory gets an embedding, cached in its
  frontmatter (`embedding: [...]`) — computed once, never re-embedded.
- **On search**: the query is embedded and **cosine similarity becomes the
  primary ranking signal**. Importance and recency remain small modifiers.
- **Gates stay absolute**: in-scope `role`/`instruction` memories with
  `trust ≥ trusted` always surface, and
  memories from other scopes are never returned, no matter how similar.
- **Memories without vectors** (stored while embeddings were off) fall back
  to keyword matching.

With `REMEMBRA_EMBEDDINGS=none` (default): pure keyword scoring — exactly
the v1 behavior.

### Backfilling vectors

Memories stored before you enabled embeddings have no vectors. They still
work (keyword fallback), but to bring them into semantic search, re-store
them or wait for v3's maintenance commands.

## Failure behavior (bounded since 4.0.1 — plan §3.7)

Every outbound call goes through one policy: **per-attempt timeout → bounded
retries with backoff → overall budget**, with error normalization to stable
codes. A provider that hangs can delay a request by at most the budget — it
can never hang the service.

- **Embedding API fails** (after retries/timeout) → warning logged
  (`embedding_failed`), write continues without a vector, search degrades to
  keywords. Never blocks storing.
- **LLM call fails** → `memory_digest` returns `LLM_ERROR` (502); a hung
  provider returns `PROVIDER_TIMEOUT` (504). Nothing is stored.
- **Retries**: network failures and HTTP 408/429/5xx only, capped by
  `REMEMBRA_PROVIDER_RETRIES` and the budget; other 4xx (bad key, bad
  request) fail immediately. Each retry logs `provider_retry`, the final
  failure logs `provider_failed` (label/attempt/status/reason only — no
  URLs, keys, or bodies).
- **Cancellation**: an HTTP client that disconnects mid-digest aborts the
  in-flight provider call (and stops retrying) instead of burning tokens on a
  response nobody will read.
- **Malformed responses** (non-JSON body, missing `choices[0].message`, junk
  embedding vectors) are rejected as `LLM_ERROR` — never half-parsed into
  memories.
- **No keys configured** → MCP/HTTP servers run normally; only `memory_digest`
  errors if invoked.
