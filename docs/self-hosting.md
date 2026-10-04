# Self-hosting

Remembra is a single Node.js process with a local memory root. The default
configuration is safe for a workstation; public deployments should set an API
key and place the process behind a TLS reverse proxy.

## Minimal HTTP deployment

```bash
export REMEMBRA_HOME=/var/lib/remembra
export REMEMBRA_API_KEY="$(openssl rand -hex 32)"
export REMEMBRA_HOST=127.0.0.1
export REMEMBRA_PORT=8787
remembra --http
```

Terminate TLS at the proxy and forward only to the loopback interface. Keep
`/health` available to the platform probe; protect all data routes with the
API key. Prefer a secret manager over shell history or checked-in `.env` files.

## Backend startup and fallback

SQLite is the default backend and SQLite initialization/migration failures are
fail-closed. A file backend is available only as an explicit compatibility
fallback:

```bash
export REMEMBRA_ALLOW_FILE_FALLBACK=1
remembra --http
```

The fallback emits a warning and appears in `/health` as
`{"backend":"file","fallback":true}`. It is permission to fall back after a
SQLite startup failure, not a backend selector. Do not use it to conceal
corruption or permission failures. See the [V5.0.1 security and migration
guide](v5.0.1-security-and-migration.md).

## Storage and backups

The default SQLite backend stores data under `REMEMBRA_HOME`. The CLI snapshot
format is portable and suitable for backups:

```bash
remembra export /backups/remembra-$(date +%F).json
remembra import /backups/remembra-$(date +%F).json
```

Test restores regularly. Import validates the complete snapshot before writing
and skips existing ids/content idempotently. Protect backups as sensitive
memory data.

## Encryption boundaries

`REMEMBRA_ENCRYPT_KEY` encrypts file-backend memory and history files; it does
not encrypt SQLite pages, decrypted export JSON, process memory, or network
transport. The `remembra encrypt`/`decrypt` migration is a legacy/non-tenant
file-root operation and strict mode refuses it; use a tenant-aware storage
and key-management design for strict deployments. Snapshot HMAC signing
provides integrity/authenticity, not confidentiality. For a non-loopback
deployment, terminate TLS at the proxy and use encrypted volumes or backups
for the selected backend.

## Resource limits

The server bounds request bodies, batch size, provider concurrency, background
queue depth, retries, and provider wall-clock budgets. Keep proxy request
limits at least as large as the configured body limit, and monitor
`GET /metrics`. Do not expose unbounded reverse-proxy buffering or worker
processes in front of one memory root.

## Running more than one process (V5.6)

One process does everything by default. Splitting is a choice, not a
requirement.

| Command | HTTP | Worker | Scheduler |
|---|---|---|---|
| `remembra` *(no subcommand)* | yes | yes | yes |
| `remembra serve [--port N]` | yes | no | no |
| `remembra worker` | no | yes | no |
| `remembra scheduler` | no | no | yes |

A role that does not hold the HTTP duty **refuses** `--http` and `--port` at
startup, before any storage is touched:

```
$ remembra worker --port 8080
the "worker" role has no HTTP surface; drop --http/--port, or use "remembra serve"
```

This is deliberate. Ignoring the flag would let a `worker` bind a port and serve
traffic from a process whose whole premise is that it has no HTTP surface.

`worker` and `scheduler` need a writable storage root, because both open the
durable job ledger at `<root>/.jobs.sqlite`. A single-process install never
touches it and never needs a native database handle it did not need before.

### Shared state across instances

| `REMEMBRA_REDIS_URL` | Result |
|---|---|
| unset, empty, or whitespace | single-host. No Redis code is imported. |
| `redis://…` / `rediss://…`, package present | shared state, connected at startup. |
| set, package absent | **startup fails**, naming `npm install redis`. |
| set, connection refused | **startup fails.** |
| any other scheme | rejected as a configuration error. |

`redis` is an **optional peer dependency**, not a dependency:

```bash
npm install redis
export REMEMBRA_REDIS_URL='rediss://:password@host:6379'
```

**There is no fallback.** A deployment that asked for a shared budget and
quietly got a per-instance one would allow *N* × the configured limit while every
instance reported the limit it was not enforcing, and nothing in the logs would
look wrong. So an unreachable Redis at startup is a failure to start, not a
degraded mode.

If the connection drops *after* startup:

- the limiter **fails closed** with `503` rather than granting against a local
  budget;
- `/health/ready` reports `status: "unready"` and `shared.mode: "unreachable"`,
  so a load balancer stops sending traffic;
- `/health` liveness stays up, so you can still reach the process;
- and it **recovers on its own** at the next successful operation — no restart,
  no operator action.

`shared` never carries the URL, host, port, or password. A Redis URL routinely
embeds a password, and `/health/ready` is the endpoint most likely to be logged,
cached, or exposed through a proxy.

> **Verify against a real Redis before relying on this.** No Redis exists in this
> project's test environment, so the scripts are verified by executing them
> through a Lua VM with a command shim, and the failure matrix verifies our
> response to a store outage — not Redis itself. See [lock and jobs](lock.md).

---

## Agent deployments

Agent mode is opt-in. A host embedding Remembra must establish identity after
API-key authentication through `resolveAgentContext`; do not forward public
agent headers or trust `provenance.agentId` as authentication. Keep private
memory roots and backups access-controlled.

## Upgrades

Back up first, install the new package, build, run the test suite, and verify
`/health` plus an authenticated store/search round trip. The V4.9 migration
notes are in [migration-v4.9.md](migration-v4.9.md).

---

## Running with no provider at all (V6)

Remembra is offline-first. A disconnected installation with **no provider configured**
is a supported deployment, not a degraded one: local storage, local retrieval, tenant
enforcement, policy, audit, snapshots and recovery all work, and retrieval falls back to
lexical ranking.

Optional (see architecture spec §6.4): remote vector database, remote LLM/embedding
service, remote object storage, distributed queue, centralized identity provider, cloud
secret manager, remote observability backend.

Requesting an optional capability that no provider supplies returns a **typed miss**
(`NOT_FOUND`, "capability X is not available"), not a crash and not a silent empty
result. Handle it by degrading deliberately.

## What happens when a provider fails

Degradation is reported as a **value**, never as an absence:

```ts
const result = await executeWithDegradation("embedding", () => provider.embed(q), { now });
// { degraded: true, ok: false, failure: "timeout",
//   capability: "embedding", reason: "embedding is degraded (timeout); …" }
```

A retrieval path returning three thin results because the embedding provider is down is
otherwise indistinguishable from one that found three good results. Check `degraded`
before trusting a result.

### Fail-open vs fail-closed, per capability

| Capability | Policy | Why |
|---|---|---|
| `embedding`, `reranking`, `summarization` | **fail open** | Quality-affecting, not authority-affecting. A lexical answer is worse than a semantic one but still correct, so failing closed would be the more dangerous choice. |
| `extraction` | **fail closed** (503) | It writes structured data. A partial extraction is a *wrong record*, not a thinner one. |

The policy is attached to the **capability**, not the provider: two providers for one
capability must not get different answers to "what happens if you fail", or behaviour
would depend on which one happened to be registered.

Fault classes: `timeout`, `rate_limited`, `malformed`, `cancelled`, `unavailable`, plus
a conservative default for anything unrecognised. An unrecognised fault is never treated
as success.

**Cancellation is never converted into an answer.** An aborted request was not attempted,
so it must not look like a completed call with a thin result.

## Health and readiness

`GET /health` remains a **two-state** contract (`ok` | `unready`) — load balancers and
uptime probes read exactly that. A degraded provider does **not** withdraw readiness:
core is still serving from local storage, and returning 503 would remove a healthy node
from rotation, which is a worse failure than the one it reports.

When a provider is configured, the payload gains one additional `providers` object:

```json
{
  "status": "ok",
  "ready": true,
  "providers": {
    "degraded": true,
    "privacy": "external",
    "availability": "remote",
    "capabilities": ["embedding"],
    "id": "openai-compatible"
  }
}
```

When no provider is configured the payload is **unchanged** — no new field appears, so a
deployment watching for an exact V5 payload keeps working.

`privacy` is worth watching: `external` means memory content leaves the host. The health
payload never carries the provider's API key or base URL (it is typically
unauthenticated), though the descriptive `id` is included.
