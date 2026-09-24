# V5 Tenant and Identity Contract

Status: design contract for the V5 multi-tenant capability. This document is
intentionally explicit about the migration boundary; implementation must not
weaken any rule below to preserve an older deployment shortcut.

## Goals

Remembra must support this hierarchy without allowing data or identity to leak
across organizations:

```text
organization (tenant)
├── users
├── projects
├── agents
└── memories
```

A tenant is the security boundary. A project, user, or agent is an additional
authorization dimension inside that boundary.

## Trusted principal

The application authenticates the caller first and then constructs a trusted
principal. Remembra never accepts a tenant ID, user ID, project ID, or agent ID
from an ordinary HTTP body, query string, MCP argument, or SDK payload as an
authority.

```ts
interface TenantPrincipal {
  organizationId: string;       // stable, validated tenant root
  userId?: string;
  projectId?: string;
  agentId?: string;
  scopes?: readonly string[];   // project/council/task scopes for this actor
  capabilities?: readonly (
    | "tenant:read"
    | "tenant:write"
    | "tenant:export"
    | "tenant:admin"
  )[];
}
```

The host may attach this principal to service calls through an injected
resolver. A public transport may expose a host-specific authentication token,
but the token must be resolved to a principal before it reaches storage. The
SDK's untrusted-identity guard must reject `tenant`, `tenantId`,
`organizationId`, `userId`, `projectId`, and equivalent nested identity keys
before transmission, just as it rejects client-supplied agent/access fields.

### Identity validation

`organizationId`, `userId`, `projectId`, and `agentId` are opaque identifiers:

- 1–128 ASCII identifier characters;
- letters, digits, `.`, `_`, `:`, and `-` only;
- no `/`, `\`, whitespace, `.`/`..` path segments, or control characters;
- organization ID is required in strict mode;
- project/user/agent IDs are optional and are never inferred from a scope
  string supplied by a caller.

The identifier is not a display name and is not a bearer credential. The
`TenantPrincipal` shown above is a host-resolved claim shape, not a value that
public transports may construct. The service accepts only an opaque,
deeply immutable `TenantContext` minted by the host after authentication and
membership lookup. A plain object, missing resolver result, resolver timeout,
malformed claim, or stale membership version is denied in strict mode.

A principal must be one of these closed authorization shapes:

- organization-wide principal: explicit `tenant:read`/`tenant:write` capability
  and no project/user/agent selector;
- project principal: one `projectId` that the host has verified belongs to the
  organization;
- user/agent principal: one `userId` or `agentId` whose membership and tenant
  binding the host has verified.

An absent optional dimension never means “all projects” or “all users.”
Organization-wide access requires an explicit capability. Scope values use a
closed canonical grammar (`global`, `project/<id>`, `agent/<id>`,
`task/<id>`, or `council/<id>`); arbitrary V4 scope strings are not accepted
as V5 authorization selectors. The host is responsible for membership
resolution; Remembra validates the resulting claims and fails closed on
unknown or conflicting membership.

## Modes and compatibility

V5 supports two service modes:

| Mode | Behavior |
|---|---|
| `legacy` | Explicit V4-only compatibility mode. It reads/writes the legacy namespace, never enumerates tenant namespaces, and refuses to start if V5 tenant data is present. It is not a mixed-data fallback. |
| `strict` | Every data-plane operation requires a host-minted tenant context and a tenant filter; unscoped data is never returned. |

`legacy` preserves V4.9 behavior only for V4 data. It must not create an
unscoped V5 record, silently assign a default organization, or hide tenant
records. A deployment with tenant data must configure strict mode explicitly;
a missing or invalid tenant-mode configuration fails startup rather than
falling back to legacy.

Strict mode has a startup readiness gate. It inventories all reachable
records, history, indexes, and migration state before serving data. If any
relevant record is unmigrated or inconsistent, the service refuses to become
ready; it never serves a partial result. Migration-needed status is an
operator/internal signal, not a public existence oracle.

V4.9 memories do not acquire a tenant implicitly at read time. A migration
command must assign them to an explicitly named legacy/default organization,
produce a manifest and checksum, and leave the source untouched until the
operator verifies the result.

## Persisted model (schema V5)

The V5 memory record adds:

```ts
interface TenantMetadata {
  organizationId: string;       // required in schema V5
  projectId?: string;           // explicit project dimension, when applicable
  userId?: string;              // creator/owner user, when applicable
  agentId?: string;             // authorization-bearing creator/agent, if any
}
```

`tenantId` is the persisted name of `organizationId`; it is not accepted from a
public request. The service maps the trusted `organizationId` to this field and
rejects any attempt to change it during update/import. A persisted
`agentId` is distinct from historical `provenance.agentId`: the former binds
authorization, while the latter remains provenance and can be absent on
imported/manual memories.

In strict mode, `projectId` is the authorization boundary. `scope` is retained
as a V4-compatible display/search label but cannot widen access: a project
memory requires a matching `projectId`; a memory with no `projectId` must use
`scope: "global"` and an organization-wide capability. Conflicting, unknown,
or unsafe scope/project values are rejected during write/import and never
silently canonicalized. Existing `owner`, `access`, and trust rules remain in
force after tenant matching.

Memory IDs remain globally unique across organizations. A tenant-qualified
lookup must therefore return not-found for a valid ID owned by another
organization; it must not fall back to a same-ID record in the caller's tenant.
This preserves the existing UUID/legacy ID contract and avoids ambiguous
relation or snapshot references.

A record's effective visibility is the intersection of:

1. exact organization match;
2. project/scope authorization from the trusted principal;
3. existing owner/access/agent policy;
4. lifecycle and quarantine policy.

There is no platform-wide memory that bypasses organization matching. A memory
with `scope: "global"` means global **within its organization**, not global
across tenants.

## V4.9 compatibility matrix

V5 preserves the following V4.9 behavior in `legacy` mode and during a staged
migration:

| Surface | V4.9 guarantee | V5 rule |
|---|---|---|
| Memory types | Eleven types and existing trust/lifecycle semantics | unchanged; tenant/project checks are additional predicates |
| HTTP/MCP/SDK | Existing routes, legacy aliases, 13-tool V4 manifest, and response shapes | remain available in legacy mode; V5 additions are opt-in and separately versioned |
| Markdown | Legacy root paths and frontmatter remain readable | V5 tenant records use a distinct versioned namespace; V4.9 readers must skip, never rewrite, V5 records |
| Owner/access/scope | Existing values and defaults | preserved in legacy mode; strict mode adds authoritative `projectId` and rejects ambiguous combinations |
| IDs/history | IDs remain globally unique and history remains available | unchanged across migration; every history/audit lookup is tenant-filtered in strict mode |
| Direct backend use | V4 custom backends may implement the old interface | allowed only in legacy mode; strict mode requires the tenant-capable V5 contract |

A V4.9 client may read legacy data during migration, but it must not be allowed
to write a V5 record. V5 writers emit a new schema version and preserve
unknown V4 frontmatter fields where the format permits it. Golden round-trip
fixtures cover every memory type, trust level, scope class, owner/access
combination, and Markdown/JSON representation before strict rollout.

## Hierarchy entities and membership

The V5 data model treats organizations, users, projects, and agents as
tenant-owned entities, not as free-form labels on a memory. Their persisted
identifiers are organization-scoped and use composite foreign keys wherever a
relationship is stored. Membership changes are versioned and audited.

Creating, listing, updating, deleting, or changing membership for any of these
entities is a separate authorized operation. The V5 service can consume a
host `TenantDirectory` for versioned membership re-authorization; the shipped
`InMemoryTenantDirectory` is a deterministic reference adapter, and
`FileTenantDirectory` provides an atomic, permission-safe local durable
adapter. A production host should implement the same contract in its identity
store. The trusted `TenantEntityService` provides bounded organization-derived
CRUD/pagination and membership changes with an audit callback. Organization
provisioning is a separate default-deny host authorization hook. A principal
used for a memory operation must be resolved against the current organization
membership version; stale or revoked membership fails closed, including queued
work.

## Storage contract

The storage boundary must enforce organization filtering, not merely return
all rows for the service to filter. Both supported backends implement the same
contract. The V5 `MemoryBackend` contract adds an optional trailing
`TenantFilter` to every data-plane method; strict mode always supplies it and
rejects a backend that does not advertise tenant enforcement. The filter is
derived from the trusted principal, never from a request payload.

Both supported backends implement the same contract:

- active and archived reads carry a required organization filter in strict
  mode;
- point lookups, updates, archive/revive, forget, history, relations, imports,
  jobs, and candidate generation all carry or derive the same filter;
- writes persist the trusted organization ID and cannot replace it with a
  payload field;
- relation targets are resolved inside the same organization (and project when
  the relation policy requires it);
- a missing record and a cross-tenant record have the same externally visible
  not-found result;
- export is tenant-scoped by default; cross-tenant export requires an explicit
  trusted administrative capability and is audited.

For the file backend, tenant directories use an injective, case-sensitive
encoding with a reserved internal prefix (for example, base64url of the
validated ID). Reserved names, trailing dots, platform length limits,
case-fold collisions, symlinks, hard links, and path-derived V4 scope values
are rejected or safely handled. Tenant directories are defense in depth, not
a replacement for record checks; atomic writes use no-follow/permission-safe
operations and verify the resulting path remains under the selected tenant
root. For SQLite, `tenant_id` (the persisted name for `organizationId`) is
non-null in the V5 tenant schema, indexed, and included in every data
statement, join, unique constraint, history/audit row, and trigger. Legacy
root paths remain readable only in `legacy` mode; an unscoped legacy read
never enumerates tenant directories.

Tenant-owned SQLite tables use non-null organization columns and composite
foreign/unique keys for memory, relation endpoints, history, audit, jobs, and
derived indexes. A top-level row filter is insufficient if an auxiliary join
can return a foreign target. FTS/vector/search paths apply the tenant predicate
before ranking, limits, counts, and cursor creation.

## Raw backend and candidate safety

A strict-mode `MemoryService` must not expose an unguarded backend property or
allow a caller to substitute a global backend operation for a tenant-scoped
one. The V4.9 `service.db` escape hatch may remain only in legacy mode; V5
strict mode uses a private backend reference and exposes only guarded service
operations.

Tenant predicates are part of the backend query, not only a service callback:

- SQLite candidate SQL filters `tenant_id` before `LIMIT` and before
  `totalDocs`/ranking calculations;
- file candidate enumeration walks only the selected tenant namespace;
- a backend that cannot enforce the predicate must reject strict-mode
  construction; an "unsupported" result may select a separately tenant-aware
  backend, never a global fallback.

The embedding cache, FTS/vector indexes, and provider request budget must include
the tenant or a tenant-safe cache partition. A cache hit must never become a
cross-tenant timing or policy side channel. Request context is passed
explicitly through service/backend/provider calls; no ambient “current
principal” is allowed. Derived indexes and caches are purged or tombstoned
when a memory is forgotten, quarantined, or revoked.

## Reference integrity

`relations`, `supersededBy`, `meta.compressedFrom`, and any future ID-bearing
metadata are tenant-scoped references. Every reference is resolved through the
same tenant filter, and missing or unauthorized targets are normalized to the
same not-found/missing representation. A foreign ID must not be retained in a
response, snapshot, explanation, audit record, or error message.

## Service and transport boundaries

`MemoryService` receives a trusted request context and passes it to every
backend operation. A context object is immutable for the duration of a job.
The following operations are included in the first strict-mode matrix:

- store, update, batch store/update/delete;
- search, list, get, context, history, quality, relations;
- digest and maintenance jobs;
- archive/revive, forget, import, export, and snapshot verification.

Bounded batches remain sequential and may return per-item outcomes for
compatibility. In strict mode each item is re-authorized immediately before its
write, duplicate IDs are deterministic conflicts, and foreign/missing items
use the same non-informative error. Counts, positions, and partial outcomes
must not reveal another tenant's records. A batch never embeds or sends content
to a provider before its tenant authorization succeeds.

HTTP gets an optional trusted `resolveTenantContext(req)` callback. It does
not get a public `X-Remembra-Tenant` override. The SDK likewise does not
accept a caller-selected organization ID; its embedding application binds
the authenticated request to a principal at the service/transport boundary.
An MCP server in strict mode is bound to one principal at startup (or refuses
to start); it never accepts organization IDs as tool arguments. CLI, dashboard,
backup, restore, encryption, and migration commands are operator surfaces: in
strict mode they require an explicit local operator capability and a selected
tenant, and they cannot fall back to a process-wide global operation.

## Relations and lifecycle

A relation may never cross an organization boundary. Both endpoints are
resolved with composite tenant keys at write and read; a relation row tagged
for one organization cannot reference an ID from another. A relation crossing
projects is allowed only when the source principal has both project
authorizations, the target is independently readable, and the configured
sharing policy permits it. Cycles, traversal depth, edge count, and output
bytes are hard-bounded; an unauthorized or dangling target is normalized to
the same missing representation. Relation hydration, backlinks, context
expansion, compression, and consolidation must apply the same filter as
ordinary search; an ID is not an authorization proof.

Lifecycle jobs capture `(organizationId, projectId, actor)` at enqueue time.
They cannot inherit a mutable request object or change tenant while running.
Every job handler uses tenant-filtered point lookups and writes; queue metrics
and results are partitioned or aggregated without exposing another tenant's
IDs/counts. Jobs carry an authorization version and are re-authorized at
dequeue/execution, so membership or scope revocation invalidates stale work.
Queue messages are authenticated/namespace-bound where the queue is durable.
Search-triggered decay is disabled in strict mode unless it carries the
current immutable principal, and its debounce state is per tenant.
Maintenance in strict mode processes only the current organization unless an
explicit administrative job is used.

## Snapshot, export, and migration

V5 snapshots include a format/version, tenant manifest, canonical record
hashes, and an authenticated signature or HMAC from a trusted key covering
the format version, destination organization, every record/ACL/reference, and
the manifest. A plain checksum detects accidental corruption but is not
authentication. Untrusted snapshots are staged, size-bounded, and verified
before any write; they cannot choose a destination organization.

A normal export applies the complete effective-visibility predicate, not only
`organizationId`: project, user/agent, owner/access, trust, quarantine, and
lifecycle rules all apply. Full-organization export requires a separate,
explicit organization-wide capability. An administrative multi-tenant export
is a separate capability and must be explicit, bounded, checksummed, signed,
and audited.

Migration is a separate operation with a versioned manifest containing at
minimum `format`, `manifestVersion`, source/destination schema versions,
organization mapping, mappings for every source user/project/agent/ACL/scope,
record counts, IDs/relations checked, and SHA-256 checksums. The manifest is
written before destination mutation and verified after it. It is separate
from the public memory snapshot format.

The operation requires a quiesced source or immutable snapshot, staged writes,
durable migration state, and idempotent operations keyed by
`(organizationId, resourceId)`. A retry after a crash must neither duplicate
nor cross-bind records. Every unresolved user/project/agent/owner/access/
relation mapping is a conflict that quarantines the destination and blocks
strict readiness; counts and checksums alone are insufficient.

The operation has:

1. dry-run inventory and conflict report;
2. explicit mappings for every source namespace and authorization entity;
3. signed/checksummed immutable snapshot before writing;
4. staged, idempotent import or database migration;
5. verification of counts, IDs, relations, ACLs, trust, scope, and tenant
   invariants;
6. atomic publication of the migrated destination;
7. a retained rollback source until the operator confirms success.

The shipped migration runner performs steps 1–5 in memory and applies records
idempotently to a tenant-capable backend. Its durable state layer atomically
checkpoints progress, verifies prior records before resuming, records failures,
and exposes an explicit publication marker after destination verification.
Checkpoints default to every 100 records (configurable by the operator), so a
crash replays at most the bounded uncheckpointed tail. Backend-specific atomic
swap and rollback remain required before strict rollout.

A failed or partial migration never switches the service into strict mode.
Legacy defaults for owner/access are not tenant ownership: migration must assign
an explicit organization and must reject ambiguous or malformed records rather
than allowing a missing field to become shared access.

Reserved tenant-bearing fields (`tenant`, `tenantId`, `organizationId`,
`userId`, `projectId`, `agentId`, aliases, and case variants) are rejected at
every public ingress: JSON bodies, query strings, path parameters, MCP
arguments, SDK bodies/headers, CLI options, and imported frontmatter. The
field is never silently stripped. Trusted context and resource selectors are
separate types.

## Audit and errors

Tenant audit events include organization ID, actor ID, operation, outcome, and
resource ID. They exclude memory content, credentials, and provider payloads.
A missing principal in strict mode is an authorization/configuration failure;
resource lookups across tenants return the existing not-found/error contract
without revealing whether the resource exists in another organization.
Administrative export or maintenance requires an explicit capability and is
never inferred from a scope or organization ID. The V5 error contract may add a
typed `TENANT_REQUIRED`/`TENANT_FORBIDDEN` code for local service/API failures,
but cross-tenant resource lookups must still use `NOT_FOUND` semantics.

## Derived data, aggregates, and rollout

Tenant checks apply to every derived representation: history, relations,
backlinks, FTS/vector indexes, caches, quality/facet counts, cursors, audit,
queued jobs, exports, and snapshots. Counts and cursors are calculated from the
complete effective-visibility set and are bound to the authorization context;
cross-tenant cursor reuse is rejected. Forgetting, quarantining, or revoking a
memory tombstones/purges derived representations and prevents queued work from
resurrecting it.

The V5 rollout is expand/contract:

1. deploy readers that understand V4 and V5 records while writers remain V4;
2. migrate an immutable, mapped source and verify all invariants;
3. enable strict readiness for one organization at a time;
4. remove legacy writers only after compatibility and rollback gates pass.

A mode transition is blocked if any entity, ingress, backend, index, cache,
provider, CLI, UI, job, export/import, or audit path lacks tenant enforcement.

Existing eleven memory types and trust levels retain their V4 predicates;
tenant, project, user, and agent checks are additional mandatory predicates,
not replacements.

## Required adversarial tests

- forged tenant/user/project/agent fields in HTTP, MCP, SDK, and batch inputs;
- missing or mismatched trusted principal in strict mode;
- cross-tenant get/search/list/context/history/quality/update/archive/revive/
  forget/relation/export/import paths;
- cross-tenant relation, backlink, maintenance, and queued-job races;
- concurrent writes using the same resource ID in separate organizations must
  be rejected by the globally unique memory-ID contract, never resolved by
  whichever tenant happens to query first;
- unmigrated V4 records and interrupted migration;
- malformed, path-like, oversized, and control-character identifiers;
- snapshot tampering and administrative export authorization.

The release test matrix must map every ingress, hierarchy entity, backend
method, derived index/cache, provider call, job, export/import path, CLI/UI
operation, failure mode, and lifecycle transition to an automated test. It must
include direct-backend probes, mixed batches, membership revocation, project-
scoped export, aggregate/cursor side channels, file symlink/case collisions,
Markdown round-trips, snapshot authenticity, mixed legacy data, and both
backends. Differential/property tests must assert that missing and cross-
tenant resources have indistinguishable externally observable outcomes.

The implementation is not complete until all of these paths are covered by
automated tests and the release checklist records the evidence.
