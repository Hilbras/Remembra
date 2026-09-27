# Observability

Structured logging, Prometheus metrics, health/readiness, and alert rules.
Added in **3.7.0** (Phase 7 of the deep audit).

## Structured logging

Every server-side event goes through one logger (`src/log.ts`) and lands on
**stderr** — stdout stays reserved for MCP stdio framing and CLI output.

| | |
|---|---|
| **Format selection** | `REMEMBRA_LOG=json` or `REMEMBRA_LOG=text` forces a format. Unset → **auto**: JSON when stderr is piped/redirected (containers, CI, log shippers), text on a TTY. |
| **JSON shape** | `{"ts","level","event","msg",...fields}` — one object per line, ready for any log shipper. |
| **Text shape** | The human message verbatim (the exact strings Remembra always printed). |
| **Hygiene** | Raw search query text and the storage root path are included **only under `REMEMBRA_DEBUG=1`** (Phase 2 log-hygiene rule). No other debug flag unlocks them. |

### Request context (V5.1.0)

Every line emitted while handling a request carries the standard fields, even if
it comes from a layer that knows nothing about HTTP — the service, storage,
providers, and the job queue all inherit the context automatically:

| Field | Meaning |
|---|---|
| `ts` | ISO 8601 timestamp |
| `level` | `debug` / `info` / `warn` / `error` |
| `event` | stable event name |
| `requestId` | the validated `X-Remembra-Request-Id`, so one request can be followed across every line it caused |
| `operation` | coarse operation, e.g. `http.request` |
| `tenantId` | **hashed** organization correlation, 12 hex characters |
| `agentId` | **hashed** agent correlation |
| `durationMs` | elapsed time where known |

The context is carried in an `AsyncLocalStorage` store, so no call site has to
thread it by hand and none can forget to. Contexts nest, an explicit field
overrides the context for the same key, and concurrent requests never see each
other's context.

### Field policy (V5.1.0)

Two rules are applied to every caller-supplied field, because redacting by field
*name* cannot tell that `query` holds user text:

- **Content and path fields** — `query`, `text`, `content`, `path`, `root`,
  `dir`, `file`, `filename`, `storagePath`, `q` — are **dropped** unless
  `REMEMBRA_DEBUG` is set.
- **Identity fields** — `tenantId`, `organizationId`, `projectId`, `userId`,
  `agentId`, `apiKey` — are **replaced by a short stable digest** rather than
  dropped, so correlation survives without a raw identifier reaching every log
  aggregator and backup the process ever writes to.

Secrets are handled separately and unchanged: field names matching
`authorization`, `*token*`, `*secret*`, `*password*`, `apikey`, `credential`,
`cookie`, and friends are redacted, and string values are scanned for bearer
tokens, vendor key shapes, AWS access keys, and PEM private key blocks.

One completion line per HTTP request is emitted as `http.request` with the
bounded `route` slug (never the raw path), the method, the status, and
`durationMs`.

Example JSON events:

```json
{"ts":"2026-09-23T05:53:50.366Z","level":"info","event":"search","terms":2,"results":2,"duration_ms":1}
{"ts":"2026-09-23T05:53:50.314Z","level":"info","event":"http_listening","msg":"Remembra HTTP API listening on 0.0.0.0:8787 (auth required)","port":8787,"host":"0.0.0.0","auth":true}
{"ts":"…","level":"warn","event":"memory_parse_skipped","file":"bad.md","reason":"missing frontmatter"}
```

Event names in the wild: `http_listening`, `mcp_listening`, `search`,
`shutdown`, `crash_recovery`, `memory_parse_skipped`, `memory_normalized`
(4.0.1 — invalid metadata fixed at read time; fields: file, reason),
`embedding_failed`, `touch_failed`, `merge_llm_failed`, `decay_failed`,
`job_failed`, `job_error_callback_failed`,
`provider_retry` (4.0.1 — fields: provider, attempt, retries_left, reason),
`provider_failed` (4.0.1 — final failure: provider, attempts, status/reason),
`provider_cancelled` (4.0.1 — client disconnected mid-call), `redacted`
(3.8.0 — PII found at ingest; fields are per-kind counts, never the matched
text). Provider events carry only low-cardinality fields — no URLs, keys, or
request bodies (log-hygiene rule).

## Metrics — `GET /metrics`

Prometheus text exposition (format 0.0.4), served by the **same binary**.

**Auth:** the endpoint sits *after* the API-key check — keyed (including
public) deployments require `x-api-key` (or `Authorization: Bearer`); an
unkeyed server is loopback-only by the default-deny rule anyway. `/health`
stays exempt so unauthenticated readiness probes keep working.

| Series | Type | Labels | Meaning |
|---|---|---|---|
| `remembra_http_requests_total` | counter | `route`, `method`, `status` | Requests. Legacy `route` labels are bounded (`health`/`metrics`/`memories`/`search`/`digest`/`batch`/`maintain`/`compress`/`audit`/`quality`/`agents`/`memory_item`/`memory_sub`/`data_io`/`ui`/`other`). Versioned requests add the bounded `api_v1_` prefix (for example, `api_v1_search`); raw paths and memory IDs are never used. `memory_sub` = the `relate`/`history`/`archive`/`revive` sub-routes; `data_io` = `/snapshot`/`/import`; `ui` = the static dashboard shell. |
| `remembra_http_request_duration_seconds` | histogram | `route` | Request latency. |
| `remembra_errors_total` | counter | `code`, `transport` | Classified errors (`http`/`mcp`). Codes: the [error codes](architecture.md#error-classification-audit-phase-2) plus `INVALID_INPUT`, `PAYLOAD_TOO_LARGE`, `INTERNAL`. |
| `remembra_searches_total` | counter | — | `memory_search` invocations. |
| `remembra_search_duration_seconds` | histogram | — | Search latency (embed + walk + score + rank). |
| `remembra_stores_total` | counter | — | `memory_store` invocations. |
| `remembra_digests_total` | counter | — | Completed session-digest runs. |
| `remembra_digest_items_total` | counter | `result` | Digest items: `stored` / `skipped` / `merged`. |
| `remembra_digest_duration_seconds` | histogram | — | Digest run latency (includes lock queueing). |
| `remembra_cache_events_total` | counter | `result` | Parse-cache probes: `hit` / `miss`. |
| `remembra_cache_entries` | gauge | — | Parse-cache entries currently held. |
| `remembra_redactions_total` | counter | `kind` | PII placeholders written at ingest (3.8.0): `email`/`ssn`/`card`/`phone`/`secret`. Zero (absent) unless `REMEMBRA_REDACT=1`. |
| `remembra_relate_total` | counter | `action` | `memory_relate` link writes (3.8.0): `add` / `remove` (no-op idempotent calls don't count). |
| `remembra_history_snapshots_total` | counter | — | History pre-images written (3.8.0). Growth rate ≈ content-changing updates. |
| `remembra_encryption_migrations_total` | counter | `mode` | `remembra encrypt`/`decrypt` files converted (3.8.0). |
| `remembra_info` | gauge | `version` | Build info, always `1`. |
| `remembra_jobs_total` | counter | `type`, `outcome` | Background queue lifecycle: `queued`, `completed`, `failed`, or `cancelled`. `type` is bounded to the six types this build registers, with any host-registered type counted as `other`, so an embedder cannot grow the series by registering a per-tenant job type. |
| `remembra_job_failures_total` | counter | `type` | Jobs that exhausted their bounded retry budget. |
| `remembra_job_queue_depth` | gauge | — | Jobs waiting for a worker. |
| `remembra_job_queue_running` | gauge | — | Jobs currently executing. |
| `remembra_embedding_batch_items_total` | counter | `result` | Bounded embedding items: `success`, `failure`, or `disabled`. |
| `remembra_embedding_batch_failures_total` | counter | — | Failed bounded embedding items. |
| `remembra_batch_items_total` | counter | `operation`, `result` | Batch item outcomes (`store`, `update`, `delete`, `export`, `search`). |
| `remembra_webhook_events_total` | counter | `result` | Webhook events by result: `published`, `rejected`, or `error`. |
| `remembra_webhook_deliveries_total` | counter | `result` | Webhook deliveries by result: `queued`, `delivered`, `failed`, `dropped_capacity`, `dropped_payload`, `retired`. |
| `remembra_rate_limit_hits_total` | counter | `dimension`, `transport` | Rate-limit rejections. `dimension` is a closed enum from the quota contract (`global`, `organization`, `project`, `user`, `agent`, `apikey`, `ip`, `endpoint`, `provider`) plus `anonymous` for a pre-authentication rejection, so a 429 can be attributed to the budget that refused it without ever naming a principal. |
| `remembra_memory_reads_total` | counter | `operation` | Read-path invocations: `search`, `list`, `get`. |
| `remembra_provider_requests_total` | counter | `provider`, `direction` | Provider calls, `direction` = `embed` or `llm`. |
| `remembra_provider_errors_total` | counter | `provider`, `code` | Provider failures by classified error code. |
| `remembra_provider_failures_total` | counter | `provider`, `code` | Alias of the above, retained for existing alert rules. |
| `remembra_snapshot_operations_total` | counter | `operation`, `result` | Snapshot `export`/`import`/`migrate`/`migrate_dry_run` as `started`/`completed` pairs. A `started` with no matching `completed` is itself the signal; failures also surface in `remembra_errors_total` with a snapshot error code. |
| `remembra_recovery_operations_total` | counter | `operation`, `result` | Recovery-state transitions by event, plus explicit `read_only` entries and failures. `operation` is the closed transition enum, so it cannot grow. |

### Percentiles (V5.1.0)

Every `histogram` series above is queryable for quantiles through
`MetricsRegistry.quantile`/`summary`, which interpolate inside the bucket the
quantile falls in — the same approximation `histogram_quantile` makes
server-side, at the fixed bucket resolution the series was registered with:

```ts
import { metrics } from "@hilbras/remembra/api-contract"; // or the internal registry
metrics.summary("remembra_http_request_duration_seconds", { route: "search" });
// { p50, p95, p99, count, sum }
```

A series with no observations reports `0` for all three rather than a fabricated
latency, and `sum`/`count` stay exact even though the quantiles are estimates.
`metrics.seriesCount(name)` returns the observed series count for a name, which
is the cardinality guard to alert on.

### Series that were removed (V5.1.0)

Seven series that V4.6.0 declared were never recorded by any code path, so a
dashboard on them rendered empty and the emptiness looked like data loss. The
four provider and storage series are now genuinely instrumented. The
memory-count gauges (`remembra_memory_count_{active,archived,deleted}`), the
quality-rate gauges (`remembra_duplicate_rate`, `remembra_conflict_rate`,
`remembra_stale_memory_rate`), `remembra_estimated_cost_usd`, and
`remembra_token_usage_total` were **removed**: each needs a full backend scan, a
quality computation, or token usage the adapter contract does not report, so any
value would be invented. If they are wanted later they should be computed on a
bounded schedule and registered with a real `collect`. See
[`v5.1.0-audit.md`](v5.1.0-audit.md) finding M4.

Keyed-batch and gate events appear in the structured log, not as metrics:
`batch_idempotency.release_failed` when a released claim cannot be persisted,
and `recovery_state.refresh_failed` when the durable recovery state cannot be
read and a write therefore failed closed. Both carry only a truncated error
detail, never keys, scopes, or tenant identifiers.

Background limits are configurable with `REMEMBRA_JOB_CONCURRENCY`,
`REMEMBRA_JOB_QUEUE`, `REMEMBRA_JOB_MAX_ATTEMPTS`, and
`REMEMBRA_JOB_RETRY_DELAY_MS`. Batch embedding limits use
`REMEMBRA_MAX_BATCH_SIZE` and `REMEMBRA_MAX_CONCURRENT_EMBEDDINGS`. Invalid
values fail closed with `INVALID_INPUT`; values are never read from request
bodies or public headers. These embedding counters describe the internal
bounded store precompute path; V5.4 does not expose a public batch embedding
operation.

### Scrape config

```yaml
scrape_configs:
  - job_name: remembra
    metrics_path: /metrics
    static_configs:
      - targets: ["127.0.0.1:8787"]
    # Required when REMEMBRA_API_KEY is set:
    headers:
      x-api-key: YOUR_KEY
```

## Health

`/health` is the legacy combined route: no auth (readiness probes carry no
key), liveness and readiness in one. It is unchanged and still works, but V5.1.0
added the separated routes, and they answer different questions:

| Route | Auth | Answers | Cost |
|---|---|---|---|
| `GET /health/live` | none | is this process able to respond? | process state only |
| `GET /health` | none | can the backend be read? | storage read + recovery refresh |
| `GET /health/ready` | key when configured | same check as `/health` | same |
| `GET /health/storage` | key when configured | backend identity, fallback, cache occupancy | storage read |
| `GET /health/provider` | key when configured | provider configuration state | none |

Prefer `/health/live` for a liveness probe. It performs no storage read and no
durable write, so it keeps reporting `200` while storage is broken, and it sets
`draining: true` once a graceful shutdown begins so an orchestrator can drain
the instance before the process exits. `/health` and `/health/ready` are the
routes that legitimately fail when storage fails.

Because `/health` is unauthenticated and unrated, its result is cached for
`REMEMBRA_HEALTH_CACHE_MS` (default 1000) and concurrent probes share one
check, so a poller cannot drive one storage scan per request. Set that variable
to `0` if a deployment needs a live answer on every probe.

No health response contains memory content, record counts, storage paths, error
message text, or provider keys — only the classified error label such as
`IO_ERROR`, and only provider *configuration*, never reachability.

The legacy `status` field remains `ok`/`unready`; the additional `state` field
is the canonical recovery state:

- `Healthy`: the backend read succeeded and no restrictive recovery state is active.
- `Degraded`: the explicitly allowed file fallback is serving; the response includes
  `backend: "file"` and `fallback: true`.
- `Recovering`: startup or a recovery transition is still being verified.
- `Failed`: the primary store or durable recovery state could not be verified;
  mutations fail closed until explicit recovery verification.
- `ReadOnly`: reads may succeed, but service and CLI mutations fail with
  `SERVICE_UNAVAILABLE` until explicit verification.

Ordinary probes never clear `Failed` or `ReadOnly`. The server persists the
last transition in `<REMEMBRA_HOME>/.recovery-state.json` using a temporary file,
fsync, and same-directory rename. A malformed, oversized, or symlinked state file
fails startup closed. Operators can inspect or transition the state with:

```bash
remembra recover read-only
remembra recover verify
```

`recover verify` performs a backend read before publishing `Healthy`; it is not
an automatic consequence of a health request.

## Graceful shutdown (V5.1.0)

`SIGINT` and `SIGTERM` run a coordinated, bounded sequence. Previously the
handler stopped accepting and called `process.exit(0)` after a hardcoded three
seconds — it never stopped the background jobs, never stopped the webhook drain
interval, never closed storage, and an MCP server had no handler at all, so
`SIGTERM` took the default disposition and killed it outright.

| Phase | Critical | What it does |
|---|---|---|
| `mark-draining` | yes | sets `draining: true`, so `/health/live` reports it and an orchestrator can take the instance out of rotation |
| `stop-accepting` | yes | stops new connections and waits for in-flight requests |
| `stop-background-work` | no | clears the webhook drain interval |
| `drain-webhooks` | no | one final delivery attempt for anything queued |
| `stop-jobs` | no | stops the job queue and decay pass |
| `close-providers` | no | closes an injected adapter that holds a socket |
| `close-storage` | yes | closes the SQLite handle |

Properties worth relying on:

- **Bounded.** One deadline covers the whole sequence
  (`REMEMBRA_SHUTDOWN_TIMEOUT_MS`, default 10000). A wedged phase is reported as
  `timeout` and the remaining phases are recorded as `skipped` rather than run —
  storage is never closed while a phase may still be in flight.
- **Idempotent.** A second signal joins the shutdown already in flight instead of
  starting a second one, and shortens the deadline to 1s so a second `Ctrl-C`
  exits promptly.
- **Honest.** The exit code is `0` only for a clean shutdown. A forced timeout or
  a failed critical phase exits `1`, which the old code could not express because
  it always exited `0`.

Two series record it: `remembra_shutdown_total{result}` and
`remembra_shutdown_phases_total{phase,status}`. Each phase emits one
`shutdown.complete` line with every phase and its status.

## Alerting

Remembra ships the *substrate* (counters + scrape endpoint), not a notifier —
alerting is Prometheus/Grafana's job. Ready-to-paste rules:

```yaml
groups:
  - name: remembra
    rules:
      - alert: RemembraDown
        expr: up{job="remembra"} == 0
        for: 2m
        annotations:
          summary: Remembra target unreachable

      - alert: RemembraHighInternalErrorRate
        expr: sum(rate(remembra_errors_total{code=~"IO_ERROR|INTERNAL|LLM_ERROR"}[5m])) > 0.1
        for: 5m
        annotations:
          summary: >-
            {{ $value | humanize }} internal errors/s — storage or provider
            failures (client 4xx are excluded on purpose)

      - alert: RemembraReadinessFailing
        expr: increase(remembra_http_requests_total{route="health",status="503"}[5m]) > 0
        annotations:
          summary: /health returning 503 (storage unready)

      - alert: RemembraLockContention
        expr: increase(remembra_errors_total{code="LOCK_TIMEOUT"}[15m]) > 5
        annotations:
          summary: Repeated lock timeouts — concurrent writers starving

      - alert: RemembraSlowSearches
        expr: histogram_quantile(0.95, rate(remembra_search_duration_seconds_bucket[5m])) > 1
        annotations:
          summary: Search p95 above 1s

      - alert: RemembraCacheThrash
        expr: |
          sum(rate(remembra_cache_events_total{result="miss"}[15m]))
            / sum(rate(remembra_cache_events_total[15m])) > 0.5
        annotations:
          summary: Parse-cache hit ratio below 50% — store churn or capacity
```
