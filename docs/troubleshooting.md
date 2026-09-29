# Troubleshooting

## Server does not start remotely

Without `REMEMBRA_API_KEY`, Remembra intentionally binds to loopback. Set a
long random key before setting a non-loopback `REMEMBRA_HOST`, or keep the
server behind a local reverse proxy. Check [self-hosting](self-hosting.md).

## HTTP requests return 401 or 403

Send the configured key as `x-api-key` or `Authorization: Bearer <key>`. The
key is required for every data route when `REMEMBRA_API_KEY` is set;
`/health` and `/api/v1/health` are the public exceptions. A v1 response also
includes `X-Remembra-API-Version: v1`.

## Digest fails with a provider error

`memory_digest` needs a configured LLM and key. Keyword storage and search
remain available without one. For a timeout, check the provider budget and
network path; for a malformed response, inspect the provider model/endpoint
configuration. See [providers](providers.md).

## Search falls back to keyword mode

Embeddings are disabled by default, and a failed embedding intentionally
degrades to keyword search. Check `REMEMBRA_EMBEDDINGS`, the provider key, and
`remembra_embedding_batch_failures_total` in metrics. Existing memories can be
backfilled with maintenance.

## Private agent memories are missing

Confirm `REMEMBRA_AGENT_MODE=1` and that the host resolver returns the verified
agent context after authentication. Public `agentId` headers and JSON fields
are not trusted. Run the multi-agent tests and review [multi-agent](multi-agent.md).

## Upgrade or import fails

Export a snapshot before changing versions. Import rejects an invalid entire
snapshot rather than partially writing it. Compare the snapshot `format` and
`version`, then consult [migration-v4.9](migration-v4.9.md).

## Health reports `ReadOnly`, `Failed`, or `Recovering`

These are deliberate recovery states, not a provider outage. `ReadOnly` permits
reads but rejects service and CLI mutations; `Failed` and an unresolved
`Recovering` state fail closed. Check `<REMEMBRA_HOME>/.recovery-state.json`,
the SQLite restore journal, permissions, and available disk space. Do not delete
state or journal files to force startup. After correcting the underlying issue,
run `remembra recover verify`; it verifies the backend before making the state
`Healthy`. See [storage](storage.md#recovery-state-and-staged-operations) and
[observability](observability.md#health--get-health).

A `restore.pending` gate is stronger than `ReadOnly`: readiness becomes
`unready` and data reads/writes return `SERVICE_UNAVAILABLE` until the operator
completes verification. Startup reconciles an interrupted SQLite publication
before `recover verify`; do not remove the gate or journal to force startup.
The marker records its owner, and the startup error names the matching action:
a `restore` gate needs `remembra recover verify`, while a `migration` gate needs
`remembra migrate apply` (or a destination rollback) because
`recover verify` refuses to publish a half-applied migration. If the marker was
replaced or damaged, nothing is cleared automatically — move it aside and let
the service report the gate, or restore it from a backup.

## Startup reports an unusable batch idempotency ledger

An existing `<REMEMBRA_HOME>/.idempotency` directory is part of the durable
claim namespace, so normal startup fails closed when its database, identity,
permissions, or directory contents are invalid. Do not delete only
`claims.sqlite` or edit rows. Restore the matching `claims.identity` and database
pair. If this is a development-only ledger that never held production claims,
archive the entire `.idempotency` directory while the service is stopped and
restart; new keyed claims will then start in a new namespace. Legacy `.json`
claims and SQLite ledgers without an identity are never auto-migrated by
deleting old keys. A ledger written by an earlier build is verified row by row
and rebuilt in place on open, so replay history survives an upgrade; an
unrecognized schema or a row that fails its integrity check fails closed.

## Service reports `SERVICE_UNAVAILABLE` for a keyed batch

This can mean the ledger is unavailable, its capacity is exhausted, a matching
claim is already in progress, a restore gate is active, or the batch contained
a failed item. An all-deterministic failed batch releases its reservation into a
tombstone that keeps the key bound to the same operation, so a different
operation under that key returns `CONFLICT` while the identical operation may be
retried; a partial or ambiguous batch intentionally remains fail-closed. Check
`<REMEMBRA_HOME>/.idempotency/restore.pending`, recovery state, and the
`remembra_batch_items_total` metric before retrying with a new key. Never reuse
a key with a different body.

## A process aborts with `RemoveEnvironmentCleanupHook`

```
# node[1234]: void node::RemoveEnvironmentCleanupHook(...) at ../src/api/hooks.cc:142
# Assertion failed: (env) != nullptr
...
4: ... Statement::~Statement() [node_modules/better-sqlite3/build/Release/better_sqlite3.node]
```

**This can kill a running server, not just a test run.** It is the single most
understated entry in this document, so read the whole section before deciding it
is harmless.

It comes from the native SQLite binding (`better-sqlite3`). A prepared
`Statement`'s destructor calls `RemoveEnvironmentCleanupHook` on an environment
that has already gone, and Node's assertion `env != nullptr` aborts the process.
It depends on garbage-collection timing, not on request content, so **where it
happens is not reproducible** — the same workload may run clean for thousands of
requests or abort at 750.

Measured against the published `5.4.0` and `5.5.1` packages, 2 500 requests of a
mixed write / search / scrape workload:

| Runtime | Result |
|---|---|
| Node 18.20.8 | 2 000 requests, no abort |
| Node 24.21.0, `better-sqlite3` 11.x | aborted at 750, 750, and 1 750 requests |
| Node 24.21.0, `better-sqlite3` 12.11.1 | aborted at 751 requests |

So: **Node 24 only, not fixed by upgrading `better-sqlite3`, and not introduced
by the 5.5.0 work** — 5.4.0 aborts identically. A single endpoint in isolation
does not trigger it; sustained mixed traffic does. Remembra already caches
prepared statements per SQL string, so the churn is not ours to reduce.

What this means for you:

- **In CI**, a `[run-tests]` note with every assertion green is this abort.
  `npm test`, `npm run security:check`, and `npm run recovery:check` re-run only
  the aborted file and still fail on any real failure. `npm run test:raw`
  bypasses that protection.
- **In production on Node 24**, expect the process to abort under sustained
  write load. It is not a data-loss bug — the store is durable and each write is
  acknowledged only once committed — but it *is* an availability problem, and no
  wrapper in this repository can contain it because there is no test to re-run.
- **On Node 18** the exposure has not reproduced in this workload.

There is no workaround in Remembra. Upgrading `better-sqlite3` past 11.x does
not remove it, so the only durable fix is upstream in the native binding; the
version is pinned to 11.x for the Node 18 gate, which is the smaller constraint
to revisit first. If you need an abort-free Node 24 deployment today, run Node
18.

## A webhook was not delivered

Check the order of events: a write queues the event, and a *separate* step
delivers it. The HTTP and MCP processes drain on
`REMEMBRA_WEBHOOK_INTERVAL_MS` (default 5s), and `remembra export`/`import`
drain once before exiting. A one-shot command that exits before the next drain
leaves the event queued, not lost: it stays in
`<REMEMBRA_HOME>/.webhooks` and is delivered by the next process that drains.

If a subscription never receives anything, in order:

1. `REMEMBRA_WEBHOOKS` is set and parses — an invalid value fails startup
   instead of disabling delivery, and the error names the variable.
2. The subscription allows that event type. The event set is a closed list and
   a subscription receives only what it lists.
3. The endpoint is `https`, or `http` on loopback, and carries no credentials
   in the URL.
4. The receiver verifies the `x-remembra-signature` header against the raw body
   and rejects a repeated `x-remembra-delivery` id.
5. `remembra_webhook_deliveries_total` shows `dropped_capacity` (the queue was
   full) or `failed`/`dead` (the subscriber refused it).

A webhook failure never fails the write that produced the event, so a
`SERVICE_UNAVAILABLE` from the memory API is never caused by delivery.

## Package import fails in TypeScript
Use the explicit subpath:

```ts
import { Remembra } from "@hilbras/remembra/sdk";
```

The package root remains the CLI entrypoint. The SDK and provider adapter
subpaths are side-effect-free and are covered by package smoke tests.

## Getting more detail

Set `REMEMBRA_DEBUG=1` for bounded diagnostic logging, inspect structured
provider events without logging keys or bodies, and use `GET /metrics` and
`GET /audit` on an authenticated deployment. See [observability](observability.md).

### The tenant benchmark aborts, and the release gate fails

`npm run bench:tenant` (and therefore `release:check`) could fail with:

```
Aborted (core dumped)  node::RemoveEnvironmentCleanupHook(...)  Statement::~Statement()
```

This is the same native teardown abort described above — load-dependent, Node 24
only, occurring *after* the measurement is written. `scripts/run-tests.mjs` has
retried it for the test suite for some time, which is why the suite is reliable
while the tenant benchmark was not: it made the **release gate** fail
nondeterministically on work that had already completed.

`scripts/bench-tenant.sh` now applies the same bounded retry
(`REMEMBRA_BENCH_ATTEMPTS`, default 3). A run that fails for any other reason
still fails on the first attempt, with its real exit code — verified by removing
the sample script and confirming the benchmark exits non-zero after exhausting its
attempts. Nothing about the measurement is weakened; the identical sample is simply
re-run.
