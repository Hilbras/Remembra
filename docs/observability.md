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
| **Hygiene** | Raw search query text and the storage root path are included **only under `REMEMBRA_DEBUG=1`** (Phase 2 log-hygiene rule). |

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
| `remembra_jobs_total` | counter | `type`, `outcome` | Background queue lifecycle: `queued`, `completed`, `failed`, or `cancelled`. |
| `remembra_job_failures_total` | counter | `type` | Jobs that exhausted their bounded retry budget. |
| `remembra_job_queue_depth` | gauge | — | Jobs waiting for a worker. |
| `remembra_job_queue_running` | gauge | — | Jobs currently executing. |
| `remembra_embedding_batch_items_total` | counter | `result` | Bounded embedding items: `success`, `failure`, or `disabled`. |
| `remembra_embedding_batch_failures_total` | counter | — | Failed bounded embedding items. |
| `remembra_batch_items_total` | counter | `operation`, `result` | Batch item outcomes (`store`, `update`, `delete`, `export`, `search`). |

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

## Health — `GET /health`

No auth (readiness probes carry no key). Liveness **and** readiness in one.
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
