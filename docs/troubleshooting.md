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

## Startup reports an unusable batch idempotency ledger

An existing `<REMEMBRA_HOME>/.idempotency` directory is part of the durable
claim namespace, so normal startup fails closed when its database, identity,
permissions, or directory contents are invalid. Do not delete only
`claims.sqlite` or edit rows. Restore the matching `claims.identity` and database
pair. If this is a development-only ledger that never held production claims,
archive the entire `.idempotency` directory while the service is stopped and
restart; new keyed claims will then start in a new namespace. Legacy `.json`
claims and SQLite ledgers without an identity are never auto-migrated by
deleting old keys.

## Service reports `SERVICE_UNAVAILABLE` for a keyed batch

This can mean the ledger is unavailable, its capacity is exhausted, a matching
claim is already in progress, a restore gate is active, or the batch contained
a failed item. An all-deterministic failed batch releases its reservation; a
partial or ambiguous batch intentionally remains fail-closed. Check
`<REMEMBRA_HOME>/.idempotency/restore.pending`, recovery state, and the
`remembra_batch_items_total` metric before retrying with a new key. Never reuse
a key with a different body.

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
