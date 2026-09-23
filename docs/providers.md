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

## Session digest

Instead of the model remembering to call `memory_store` for every little thing,
hand the whole conversation to one tool at the end of a session:

```
memory_digest {
  transcript: "<full transcript or a detailed summary>",
  scope: "/path/to/project",   // optional, default global
  source: "opencode"            // optional
}
```

Remembra asks the configured LLM to extract **facts, decisions, roles, and
history**, then stores each one — **skipping exact duplicates** that are
already present (normalized by type + scope + content). Running a digest twice
over the same conversation is a no-op.

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
- **Gates stay absolute**: `role` memories always surface, and memories from
  other scopes are never returned, no matter how similar.
- **Memories without vectors** (stored while embeddings were off) fall back
  to keyword matching.

With `REMEMBRA_EMBEDDINGS=none` (default): pure keyword scoring — exactly
the v1 behavior.

### Backfilling vectors

Memories stored before you enabled embeddings have no vectors. They still
work (keyword fallback), but to bring them into semantic search, re-store
them or wait for v3's maintenance commands.

## Failure behavior

- **Embedding API fails** → warning logged, write continues without a vector,
  search degrades to keywords. Never blocks storing.
- **LLM call fails** → `memory_digest` returns the error; nothing is stored.
- **No keys configured** → MCP/HTTP servers run normally; only `memory_digest`
  errors if invoked.
