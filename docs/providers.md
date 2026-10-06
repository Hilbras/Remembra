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

---

## V6 provider manifests

The sections above describe *which* provider is configured. A **manifest** describes what
that provider may receive — so policy can decide **before** any network work happens.

### What a manifest declares

| Field | Meaning |
|---|---|
| `id` | Registered name. Descriptive, not authorising. |
| `version` | Manifest schema version. A build only accepts the version it understands. |
| `capabilities` | Which optional capabilities it supplies. |
| `privacy` | `local` (in-process, content never leaves the host) or `external`. |
| `regions` | Where content is processed. Empty for local-only providers. |
| `dataClasses` | Which categories of data it may receive at all. |
| `retention.training` | May content be used to train the provider's models? |
| `retention.logDays` | How long content is retained after the request. |
| `maxSensitivity` | The highest sensitivity band this provider may receive. |
| `cost` / `latency` / `availability` | Bounds for negotiation. |

Every axis is **required**. A manifest missing one is a manifest whose constraint nobody
chose — the same failure as an unknown privacy value.

### The transmission gate

Policy must be able to **deny transmission before network work begins**. Not after, not by
inspecting what came back: once a request is on the wire the content has left the host,
and a refusal that arrives afterwards is a disclosure with extra steps.

```ts
const decision = evaluateTransmission({
  manifest, sensitivity: "confidential", tenantAllowsExternal: true, now,
});
// { effect: "allow" } | { effect: "deny", reason: "provider_sensitivity_ceiling" }
```

It is a pure function of configuration — no provider call, no input beyond what is already
known. Two independent denials, in a fixed order so the reason is deterministic:

1. **The provider's ceiling.** Content above `maxSensitivity` is refused regardless of
   what the tenant permits.
2. **The tenant's external rule.** Applies only when `privacy` is `external`. A *local*
   provider transmits nothing, so refusing it would deny a request involving no
   transmission at all.

Bands are compared **by position, never lexically** — `"internal" > "confidential"` is
false as strings and true as bands, so a lexical comparison permits the wrong direction
for most pairs, and in the permissive direction, which is the dangerous one. An
unrecognised band is read as the **most sensitive** available, never the loosest.

### Training is a separate consent

A provider may be permitted to *process* content and forbidden to *train* on it. Those are
different permissions, so an `allow` still reports them:

```
warnings: ["provider_trains_on_data", "provider_retains_content"]
```

A **deny** never carries warnings — a denial softened by a suggestion is a different, and
worse, outcome.

### Derived defaults

A provider without an explicit policy gets a *derived* manifest rather than a per-call
guess, so one provider cannot answer the transmission question differently on two
requests:

| | local | external |
|---|---|---|
| `maxSensitivity` | `secret` — content never leaves | `confidential` — `secret` refused |
| `retention.training` | `false` | `false` |
| `retention.logDays` | `0` | `0` |

Training consent is never assumed, and retention beyond the request is never assumed.

### Credentials

A manifest has **no credential field** and the schema is strict, so a manifest carrying
`apiKey` or `baseUrl` does not validate and cannot be stored, logged, or attached to an
audit event. For paths that bypass the schema — a `notes` string, an error payload, an
adapter description — use `assertNoCredentials(value)` (throws) and `redactManifest(value)`
(replaces, for logging). Detection is deliberately broader than the schema: it also catches
a secret *inside* a string named something innocuous.

### Capability adapters (T13)

`provider-adapters.ts` supplies embedding and completion adapters with the full
timeout/retry/cancellation policy. The **capability adapters** sit above them and add
the two things a caller needs from an *optional* operation:

- **A typed result for every outcome.** An unsupported capability, a policy refusal, a
  cancellation and a provider failure all return `ok: false` with a reason, rather than
  throwing past the boundary. An exception a caller forgets to catch is a failure mode of
  its own.

```ts
const result = await adapter.invoke("summarization", text, { sensitivity: "internal" });
if (!result.ok) {
  // result.reason says which of the four happened
  return;
}
result.value; // the declared payload
```

- **Provider output as data, never authority.** Extraction output is rebuilt field by
  field from an allowlist, so a provider returning `trust: "system"` or
  `organizationId: "org-b"` has those fields **dropped**, not merely ignored. Malformed
  output is refused outright rather than half-parsed — partially understood provider
  output becomes partially stored data, which is worse than a refusal because nothing
  downstream can tell the difference.

#### Local adapters

`createLocalClassificationAdapter()` and `createLocalSummarizationAdapter()` are pure and
offline. "Local adapters work without network access" is asserted by construction: a
local adapter never calls `fetch`, even when one is supplied to its context.

The summarizer is **extractive** (the leading sentence, bounded), not generative. That is
the right trade for an offline default: it cannot hallucinate, and its output is drawn
verbatim from the input.

#### The gate is not skippable

An omitted manifest becomes the derived **external** one, which refuses `secret` content.
Forgetting a parameter must not be a way to transmit. `V6-PA-015` pins that.

Classification and summarization are separate capabilities: an adapter that does not
implement a capability says so rather than silently serving it.
