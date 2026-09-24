# Migrating to V4.9

V4.9 is additive. Existing storage, MCP clients, and unversioned HTTP routes
remain compatible; no migration command is required for normal upgrades.

## MCP clients

The stable V4.9 manifest keeps the current 13 tool names, including
`memory_batch`. No tool was renamed or removed. Integrations should use the
names documented in [tools.md](tools.md) and should not infer aliases from
Custom GPT action names.

## HTTP clients

Existing calls such as `POST /memories` continue to work. New integrations
should prefix routes with `/api/v1`:

```diff
-POST /memories
+POST /api/v1/memories
```

The v1 namespace reuses the same authentication, limits, trusted agent
resolver, and route-specific response bodies. Every v1 response carries:

```http
X-Remembra-API-Version: v1
```

`/api/v1/health` is public, matching `/health`. The dashboard is not served
under the v1 prefix. V1 preserves legacy error shapes during the stabilization
release; clients should handle both `{error, code}` and legacy `{error}` or
`{ok:false,text}` responses. The TypeScript SDK normalizes missing codes to
`HTTP_<status>` while retaining the raw body.

## TypeScript SDK

Install the same package and use the explicit SDK subpath:

```ts
import { Remembra } from "@hilbras/remembra/sdk";
```

Importing the package root remains the CLI entrypoint for compatibility. The
SDK sends an API key, supports `AbortSignal`, and rejects server-managed agent
identity/access fields before transmission. Trusted agent context remains the
responsibility of the host resolver.

## Providers

Existing environment variables and provider behavior are unchanged. Applications
that need a local or vendor-neutral implementation can opt into the
`@hilbras/remembra/providers` adapter factories; see [providers.md](providers.md).

## Upgrade checklist

1. Back up the storage root or export a snapshot.
2. Upgrade the package and run the build/test commands used by your deployment.
3. Keep legacy routes during a transition period, or move read/write clients to
   `/api/v1` independently.
4. Verify `/health` and one authenticated store/search round trip.
5. Review any custom MCP allowlists; the stable manifest now has 13 names.
6. Roll back by reinstalling the previous package and restoring the compatible
   storage snapshot if needed.

No data migration is required. See [self-hosting](self-hosting.md) for
deployment controls and [troubleshooting](troubleshooting.md) for common
upgrade failures.
