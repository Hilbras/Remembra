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
`{"backend":"file","fallback":true}`. Do not use it to conceal corruption or
permission failures. See the [V5.0.1 security and migration guide](v5.0.1-security-and-migration.md).

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

## Resource limits

The server bounds request bodies, batch size, provider concurrency, background
queue depth, retries, and provider wall-clock budgets. Keep proxy request
limits at least as large as the configured body limit, and monitor
`GET /metrics`. Do not expose unbounded reverse-proxy buffering or worker
processes in front of one memory root.

## Agent deployments

Agent mode is opt-in. A host embedding Remembra must establish identity after
API-key authentication through `resolveAgentContext`; do not forward public
agent headers or trust `provenance.agentId` as authentication. Keep private
memory roots and backups access-controlled.

## Upgrades

Back up first, install the new package, build, run the test suite, and verify
`/health` plus an authenticated store/search round trip. The V4.9 migration
notes are in [migration-v4.9.md](migration-v4.9.md).
