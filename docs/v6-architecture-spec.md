# V6 Architecture Specification

**Status:** Design target / draft for review
**Scope:** V6.0.0 architecture, security model, API boundaries, migration, and release discipline
**Relationship to V5:** V6 extends the V5 platform without silently changing V5 data or breaking promised V5/V4.9 compatibility.

> This document describes the intended V6 architecture. It does not claim that
> V6 code, schemas, APIs, or infrastructure have been implemented yet.

---

## 1. Objective

V6 turns Remembra from a memory service with strong compatibility guarantees
into a security-first, provider-independent memory platform.

The central design change is that a memory is no longer treated as a content
record that happens to have metadata. In V6, every memory is evaluated through
a layered policy model before it can be written, read, ranked, exported, or
used as context.

V6 must:

- make trust, sensitivity, expiration, access, and retention first-class policy
  concerns;
- establish one fail-closed request path from identity to retrieval;
- keep storage, retrieval, tenancy, security, and context usable offline;
- make external AI providers optional intelligence modules rather than core
  dependencies;
- provide explicit, versioned API domains instead of one growing compatibility
  surface;
- migrate V5 data through analysis, dry-run, verification, and rollback rather
  than forcing a blind upgrade;
- make security, reliability, performance, and compatibility release gates
  measurable and repeatable.

The primary users are:

1. local-first developers and AI assistants;
2. teams embedding Remembra through MCP, HTTP, or the SDK;
3. operators running shared or multi-tenant deployments;
4. future Hilbras services that need a provider-neutral memory substrate.

---

## 2. Design principles

### 2.1 Memory is data, not executable policy

A retrieved memory may inform a model, but it cannot grant itself permissions,
change its own sensitivity, extend its expiration, or become a trusted system
instruction merely because it was retrieved.

### 2.2 Deny by default

Missing identity, unknown tenant, stale membership, conflicting policy,
invalid expiration, unsupported provider, or ambiguous authorization fails
closed. A successful fallback is allowed only when the operation is explicitly
classified as safe and the fallback is observable and tested.

### 2.3 Separate policy axes

Trust, sensitivity, access, retention, and expiration answer different
questions. They must not be collapsed into one numeric score or one enum.

### 2.4 Core before providers

The core must work without OpenAI, Anthropic, Gemini, Qwen, Ollama, or any
other remote service. Providers may improve embeddings, classification,
summarization, consolidation, or other intelligence, but they never become a
hidden dependency of durable storage or authorization.

### 2.5 Local-first, network-optional

A local installation must be useful without a network connection. Remote
providers, remote vector stores, remote model infrastructure, and distributed
control planes are optional deployment modes.

### 2.6 Explicit versions everywhere

Schemas, snapshots, migrations, policies, APIs, provider adapters, and audit
events carry explicit versions. A newer reader must be able to explain why it
refused or migrated a record.

### 2.7 Measure before claiming scale

V6 performance claims require reproducible datasets, hardware assumptions,
p50/p95 latency, memory use, candidate bounds, recovery time, and failure
behavior. A feature is not "production-ready" because it works on a small
fixture.

### 2.8 Preserve deliberate compatibility

V6 may add new APIs and schemas, but it must not silently reinterpret V5
records, remove promised V5 routes, or make an old client authoritative for
identity.

---

## 3. Capability map and dependency order

V6 contains several independently testable capabilities. The dependency order
is intentional; later capabilities must not bypass earlier boundaries.

| Module ID | Responsibility | Depends on |
|---|---|---|
| `v6-policy-model` | Trust, sensitivity, access, retention, and expiration model | — |
| `v6-request-security` | Identity, authorization, tenant binding, policy evaluation, audit decisions | `v6-policy-model` |
| `v6-core-runtime` | Offline-first storage, retrieval, context, lifecycle, and provider-neutral service boundary | `v6-request-security` |
| `v6-provider-boundary` | Optional embeddings, classification, summarization, and consolidation adapters | `v6-core-runtime` |
| `v6-api-domains` | Versioned Memory, Knowledge, Context, Tenant, Policy, Snapshot, Audit, and Provider APIs | `v6-core-runtime`, `v6-provider-boundary` |
| `v6-migration` | V5 analysis, compatibility reports, dry-run, migration, verification, and rollback | `v6-policy-model`, `v6-core-runtime` |
| `v6-reliability` | Atomic publication, crash recovery, corruption handling, backup/restore, replay protection | `v6-core-runtime`, `v6-migration` |
| `v6-observability` | Security decisions, policy outcomes, audit events, metrics, and diagnostic redaction | `v6-request-security`, `v6-core-runtime` |
| `v6-performance` | 10K/100K/1M/10M+ retrieval and context budgets | `v6-core-runtime`, `v6-reliability` |
| `v6-release` | Compatibility matrix, security review, package verification, and publication gates | all capabilities |

**Build order:**

```text
v6-policy-model
      ↓
v6-request-security
      ↓
v6-core-runtime
      ↓
v6-provider-boundary
      ↓
v6-api-domains
      ↓
v6-migration + v6-reliability + v6-observability
      ↓
v6-performance
      ↓
v6-release
```

No provider implementation may become a prerequisite for testing
`v6-policy-model`, `v6-request-security`, or `v6-core-runtime`.

---

## 4. Conceptual memory model

A V6 memory is a composition of content, identity, policy, lifecycle, and
provenance concerns:

```text
Memory
 ├── Identity / Tenant Binding
 ├── Content and semantic metadata
 ├── Provenance and Trust
 ├── Sensitivity classification
 ├── Access policy
 ├── Retention policy
 ├── Expiration state
 ├── Typed relations
 └── Version and audit metadata
```

The exact persisted schema is a later design decision, but the conceptual
model is fixed for V6.

### 4.1 Trust

Trust answers: **how much confidence does the system have that this memory is
authentic and fit to influence retrieval?**

Trust is not authorization and not sensitivity. A highly trusted memory can
still be confidential, and an untrusted observation can still be useful inside
a restricted quarantine.

V6 must preserve at least the V5 trust concepts:

- `unverified`;
- `trusted`;
- `verified`;
- `system`.

The final trust transition and approval workflow remain subject to review, but
the following rules are mandatory:

- trust is assigned by a trusted host or validated policy, never by the public
  memory payload;
- trust transitions are auditable;
- a provider cannot promote content to `system` or `verified` by itself;
- retrieved content cannot change its own trust;
- trust policy can only restrict automatic influence, not expand it without an
  explicit host action.

### 4.2 Sensitivity

Sensitivity answers: **what is the impact of disclosing this memory?**

Sensitivity is separate from trust. The design should support a closed,
validated classification with at least these conceptual bands:

| Band | Meaning | Examples |
|---|---|---|
| `public` | Safe for broad approved audiences | Published documentation |
| `internal` | Appropriate for an organization or trusted team | Internal runbooks |
| `confidential` | Restricted to explicitly authorized principals | Customer account details |
| `restricted` | Highest-impact material requiring explicit controls | Credentials, regulated data, security keys |

These labels are a starting vocabulary, not a final storage enum. Before the
schema is frozen, V6 must decide whether sensitivity is one label, an ordered
classification, or a policy reference.

Sensitivity must affect:

- context and search visibility;
- export and snapshot permissions;
- provider transmission;
- logs, metrics, traces, and audit payloads;
- backup and remote-storage policy;
- administrative APIs.

A memory's content must never be copied into an audit event merely because it
is sensitive.

### 4.3 Access policy

Access answers: **which principals may perform which operation on this
memory?**

Access is evaluated from trusted identity and tenant context, not from a
caller-provided role or owner field. V6 must distinguish at least:

- tenant/organization access;
- project access;
- user or agent access;
- operation-level permissions such as read, write, export, delete, and policy
  administration;
- explicit resource relationships where required.

A caller may be denied because of tenant mismatch, project mismatch,
sensitivity, expiration, policy, or membership version. Denials should be
audited without revealing the existence of foreign records.

### 4.4 Retention

Retention answers: **how should this memory age and disappear?**

V6 supports the V5 retention concepts and makes their policy explicit:

- `pinned` — protected from ordinary decay;
- `persistent` — retained until an explicit administrative action;
- `ephemeral` — short-lived by policy;
- `decaying` — subject to configured archive behavior;
- `neverExpire` — no automatic time-based expiration.

Retention is a lifecycle policy, not a promise that data can never be deleted.
Legal, security, or operator-directed deletion may override ordinary retention
when policy permits.

### 4.5 Expiration

Expiration answers: **when is this memory no longer valid for use?**

Expiration is distinct from archival and retention:

- **expired** means invalid for normal retrieval or context use;
- **archived** means inactive but retained;
- **deleted** means removed according to the deletion policy;
- **superseded** means replaced by a newer version or decision.

V6 requires an explicit expiration state and clock semantics. The design must
define, before implementation:

- whether expiration is absolute, renewable, or policy-derived;
- whether an expired memory remains visible to administrators;
- how timezone, clock skew, and future-dated values are handled;
- whether a legal hold or equivalent operator control can prevent deletion;
- whether a provider may extend expiration (default: no).

The safe default is fail-closed: malformed, ambiguous, or conflicting
expiration metadata prevents automatic eligibility rather than being guessed.

### 4.6 Policy composition

A conceptual request evaluates policy in this order:

```text
system safety policy
      ↓
tenant policy
      ↓
project / resource policy
      ↓
principal capabilities
      ↓
memory policy
      ↓
provider and export constraints
```

The exact precedence and conflict semantics must be represented by a versioned
policy document. The following rules are fixed:

1. explicit deny wins over allow;
2. a more restrictive sensitivity or expiration rule wins;
3. a caller cannot weaken policy through request fields;
4. missing policy uses a documented safe default, not an implicit allow;
5. policy evaluation emits a low-cardinality decision reason for audit and
   metrics without exposing private content.

---

## 5. Request security pipeline

V6 has one mandatory path for every data-plane operation:

```text
Request
  ↓
Identity
  ↓
Authorization
  ↓
Tenant
  ↓
Policy
  ↓
Memory
  ↓
Retrieval
```

It explicitly does **not** permit:

```text
Request
  ↓
Memory
```

### 5.1 Request

The transport authenticates the connection, bounds the body and headers, and
constructs an immutable request context. Request data is untrusted, including
tenant IDs, organization IDs, user IDs, agent IDs, roles, owners, access
claims, sensitivity, and expiration overrides.

### 5.2 Identity

Identity is resolved by the host after authentication. V6 may support local
operator binding, API keys, mTLS, OAuth/OIDC integrations, or application
resolvers, but the core never invents an identity from an arbitrary payload.

Identity output must distinguish:

- authenticated principal;
- tenant/organization;
- project/user/agent dimensions;
- authentication strength and expiry;
- membership version;
- authentication method for audit.

### 5.3 Authorization

Authorization determines the operation and resource class the principal may
attempt. It occurs before storage access and before provider work.

Authorization must be explicit for:

- read and context assembly;
- create and update;
- archive, revive, and delete;
- relations and history;
- export and snapshot;
- policy administration;
- provider configuration and audit access.

### 5.4 Tenant

Tenant binding is a separate, non-optional stage. Even an otherwise valid
principal cannot access a memory outside its organization. Tenant filtering is
pushed into storage queries and file namespace selection before ranking, limits,
counts, joins, and cursor creation.

### 5.5 Policy

Policy evaluation combines authorization, sensitivity, trust, retention,
expiration, provenance, and operation-specific constraints. The result is a
decision object suitable for enforcement and audit, such as:

```ts
interface PolicyDecision {
  readonly effect: "allow" | "deny" | "redact" | "quarantine";
  readonly reason:
    | "authorized"
    | "tenant_mismatch"
    | "sensitivity_denied"
    | "expired"
    | "retention_denied"
    | "trust_restricted"
    | "policy_invalid"
    | "provider_not_permitted";
  readonly policyVersion: string;
}
```

The exact decision type is an implementation contract, but the decision must be
deterministic, bounded, versioned, and safe to log.

### 5.6 Memory and retrieval

Only a memory that passes identity, authorization, tenant, policy, lifecycle,
and expiration checks becomes eligible for retrieval. Retrieval must apply
the same decision to direct reads, search candidates, context selection,
relations, backlinks, history, exports, jobs, caches, and provider requests.

A cross-tenant or otherwise unauthorized ID returns the same externally
normalized not-found behavior unless an explicit administrative capability is
present and the operation is audited.

---

## 6. Core runtime and provider independence

### 6.1 Core responsibilities

The V6 core must provide:

- durable storage;
- tenant and identity-aware retrieval;
- trust and policy evaluation;
- context assembly;
- lifecycle and expiration;
- relations and history;
- snapshot and migration primitives;
- audit and operational metrics.

The core must work with no provider configured.

### 6.2 Optional intelligence providers

Providers are optional modules for:

- embeddings;
- classification;
- summarization;
- consolidation;
- extraction or digest;
- other future intelligence operations.

A provider may be:

- local and embedded;
- local and separately installed;
- remote and network-dependent;
- replaced at runtime;
- unavailable during a degraded operation.

Provider interfaces must expose capability, cost, latency, privacy, and data
handling metadata. A provider cannot silently change authorization, tenant,
sensitivity, retention, or expiration decisions.

### 6.3 Provider output trust

All provider output is untrusted input until validated against a bounded
schema. A provider may suggest content or metadata, but it cannot:

- grant itself a capability;
- mark content `system` or `verified`;
- remove sensitivity or expiration;
- expand access;
- write outside the authorized tenant;
- bypass deterministic policy evaluation.

### 6.4 Offline-first deployment

The minimum local deployment is:

```text
Remembra Core
 ├── local storage
 ├── local retrieval
 ├── local policy and identity binding
 ├── local audit
 └── optional local or remote providers
```

The following are optional:

- remote vector database;
- remote LLM or embedding service;
- remote object storage;
- distributed queue;
- centralized identity provider;
- cloud secret manager;
- remote observability backend.

A disconnected installation must still support local CRUD, search, context,
tenant enforcement, snapshots, audit, and recovery for the data it already
owns.

---

## 7. V6 API architecture

V6 uses explicit, versioned API domains. The exact route spelling is finalized
during the API contract review, but the following domains are required.

| API domain | Responsibility | Examples of operations |
|---|---|---|
| **Memory API** | Memory lifecycle and content | create, get, update, archive, revive, delete |
| **Knowledge API** | Typed entities, relations, and graph semantics | entity lookup, relate, retype, backlinks |
| **Context API** | Deterministic authorized context assembly | query, budget, include/exclude policy filters |
| **Tenant API** | Organizations, projects, users, agents, membership | resolve, provision, grant, revoke, list |
| **Policy API** | Validated policy inspection and administration | explain, validate, version, simulate |
| **Snapshot API** | Export, preview, import, and recovery state | dry-run, signed export, restore, verify |
| **Audit API** | Security and lifecycle evidence | policy decisions, mutations, denials, replay events |
| **Provider API** | Optional provider capabilities and health | list, configure, test, capability negotiation |

### 7.1 Versioning rules

- V6 APIs use an explicit V6 namespace or an equivalent content-negotiated
  version contract; they do not silently change V5 response shapes.
- V5 routes remain available according to the V5 compatibility policy.
- Every request and response carries a version or compatibility identifier.
- Every policy, snapshot, migration manifest, and provider adapter has its own
  version independent of the HTTP version.
- Additive fields must be optional and documented. Removing or changing the
  meaning of a field requires a new major contract.

### 7.2 Policy explainability

The Policy API must be able to explain a decision without returning private
content:

```json
{
  "decision": "deny",
  "reason": "sensitivity_denied",
  "policyVersion": "v6.1",
  "resourceClass": "tenant-memory",
  "expiresAt": "2026-10-01T00:00:00Z"
}
```

The explanation is intended for authorized operators and audit tooling. It must
respect the same redaction and sensitivity constraints as the resource.

---

## 8. Migration strategy

V6 must never require a blind in-place upgrade.

```text
V5 database / snapshots
          ↓
Migration analyzer
          ↓
Compatibility report
          ↓
Dry run
          ↓
Migration
          ↓
Verification
          ↓
V6
```

### 8.1 Required stages

1. **Inventory** — enumerate schemas, tenants, policies, relations, history,
   audit records, snapshots, and provider metadata without changing them.
2. **Analyze** — identify V5 records, unsupported V6 policy states, ambiguous
   sensitivity, expiration conflicts, orphan references, and incompatible
   provider metadata.
3. **Report** — produce a machine-readable and human-readable compatibility
   report with counts, warnings, blockers, and proposed actions.
4. **Dry run** — execute the complete transformation in a temporary or
   isolated target and produce checksums and reference results without
   publishing.
5. **Migrate** — apply a signed, versioned plan with bounded batches, durable
   checkpoints, idempotent operations, and explicit failure records.
6. **Verify** — compare counts, checksums, tenant membership, policy decisions,
   relation integrity, expiration semantics, audit evidence, and representative
   retrieval results.
7. **Publish** — require an explicit operator-confirmed marker and an atomic
   backend-specific publication step.
8. **Rollback** — retain a verified V5 backup or pre-publication V6 state and
   document the exact reversal procedure.

### 8.2 Migration safety properties

- source data remains untouched until publication is confirmed;
- a failed migration leaves a durable failure record and a resumable checkpoint;
- every reference is checked before publication;
- checksums are canonical and reproducible;
- mixed V5/V6 data is never served as if it were homogeneous;
- a migration report cannot be used as a public data-existence oracle;
- rollback is tested with corruption, interruption, and partial-batch fixtures.

### 8.3 V5 compatibility window

V5 snapshots, V5 databases, and promised V5 API behavior remain readable during
the migration window. V6 readers must refuse or explicitly quarantine records
they cannot interpret; they must not guess.

---

## 9. Release gates for V6.0.0

V6.0.0 cannot ship until every gate below passes on the release commit.

### 9.1 Functional gates

- memory CRUD and optimistic concurrency;
- search and context assembly;
- all eleven memory types;
- typed relations and history;
- snapshots, preview, import, and restore;
- tenant and membership lifecycle;
- policy evaluation and explanation;
- audit events and administrative APIs;
- provider capability and degraded-mode behavior;
- local/offline operation.

### 9.2 Security gates

- authentication and authorization;
- tenant isolation across every data-plane path;
- policy deny/allow precedence;
- sensitivity and expiration enforcement;
- path traversal and symlink resistance;
- prompt injection and memory poisoning;
- sensitive-data and secret leakage;
- replay and confused-deputy resistance;
- privilege escalation and forged identity;
- rate, body, queue, provider, and context limits;
- secure headers, CORS, error redaction, and audit evidence.

### 9.3 Reliability gates

- crash recovery;
- interrupted writes;
- corrupted database and snapshot handling;
- failed and resumed migration;
- atomic publication and rollback;
- backup and restore verification;
- provider timeout and cancellation;
- concurrent tenant and worker behavior;
- idempotent retry and replay handling.

### 9.4 Performance gates

Reproducible benchmarks must report corpus size, hardware, backend, policy
configuration, p50/p95 latency, memory use, candidate counts, context token
counts, queue behavior, and recovery time.

Required scale points:

- 10K memories;
- 100K memories;
- 1M memories;
- 10M+ memories where the deployment mode supports it.

V6 must not claim a scale level merely because a smaller benchmark passed.

### 9.5 Compatibility gates

- V5 snapshots import into a controlled V6 target;
- promised V5 APIs remain tested;
- V5 clients receive explicit compatibility behavior;
- migration analyzer, report, dry-run, apply, verify, and rollback are green;
- old readers never rewrite unknown V6 records;
- Markdown compatibility remains covered;
- MCP compatibility is explicitly versioned and tested.

### 9.6 Release evidence artifact

The release must publish a machine-readable evidence manifest containing:

```json
{
  "version": "6.0.0",
  "policyVersion": "v6.0",
  "schemaVersion": "v6.0",
  "node": ">=18.14.1",
  "compatibility": ["v4.9", "v5"],
  "gates": {
    "functional": "pass",
    "security": "pass",
    "reliability": "pass",
    "performance": "pass",
    "compatibility": "pass"
  },
  "benchmarkProfile": "recorded-in-release-evidence",
  "migrationVerified": true
}
```

The manifest is evidence, not a substitute for running the gates.

---

## 10. Proposed V5 → V6 roadmap

The sequence preserves room for corrective releases while making the
architecture progression explicit.

| Version | Target |
|---|---|
| `5.0.0` | V5 architecture baseline and production memory platform |
| `5.0.1` | Critical security and correctness fixes |
| `5.0.2` | Security consistency |
| `5.0.3` | Reliability and recovery hardening |
| `5.1.0` | Production infrastructure |
| `5.1.1` | Infrastructure hardening |
| `5.2.0` | Distributed Remembra |
| `5.2.1` | Distributed security |
| `5.3.0` | Advanced retrieval |
| `5.3.1` | Retrieval hardening |
| `5.4.0` | Developer platform |
| `5.4.1` | Developer/API hardening |
| `5.5.0` | Advanced tenancy and RBAC |
| `5.5.1` | Tenant security |
| `5.6.0` | Performance and scalability |
| `5.6.1` | Performance correctness |
| `5.7.0` | Enterprise reliability |
| `5.8.0` | Intelligent memory lifecycle |
| `5.9.0` | V6 architecture preparation |
| `5.9.1` | V5 → V6 migration preview |
| `6.0.0` | Next-generation memory architecture |

This table is a roadmap, not a promise that every minor version will ship on a
fixed calendar date. Each version still requires its own scoped plan and
release evidence.

---

## 11. Release discipline

Every version, including patch releases, follows this lifecycle:

1. Create version plan.
2. Audit current implementation.
3. Implement only scoped changes.
4. Add unit tests.
5. Add integration tests.
6. Add regression tests.
7. Run security tests.
8. Run build and typecheck.
9. Run the release gate.
10. Update README.
11. Update architecture documentation.
12. Update security documentation.
13. Update CHANGELOG.
14. Update version metadata.
15. Create the Git commit.
16. Create the Git tag.
17. Create the GitHub Release.
18. Publish the npm package.
19. Verify the published package.
20. Run a post-release audit.

A release is incomplete if any step is skipped, silently fails, or is replaced
by an unreviewed manual claim.

---

## 12. Testing strategy

V6 testing is layered by boundary:

| Layer | Required coverage |
|---|---|
| Unit | Policy precedence, trust/sensitivity/expiration decisions, token and limit boundaries, reference validation |
| Property | No over-budget context, no cross-tenant result, deterministic ordering, idempotent migration, replay safety |
| Integration | Request → identity → authorization → tenant → policy → backend → retrieval |
| Adversarial | Forged identity, injection, secret leakage, path traversal, privilege escalation, replay, poisoning |
| Recovery | Corruption, interrupted writes, failed migration, rollback, backup restore, sidecar rejection |
| Compatibility | V5 snapshots, V5 API promises, Markdown, MCP, SDK, and older-reader behavior |
| Performance | 10K, 100K, 1M, and supported 10M+ profiles |
| Operational | Health, metrics, audit, provider failure, rate limits, and deployment smoke tests |

Tests must assert both positive behavior and fail-closed behavior. A test that
only proves the happy path is insufficient for security and migration paths.

---

## 13. Commands and repository boundaries

The V6 implementation will use the repository's existing commands unless a
versioned plan explicitly adds a new tool:

```bash
npm run build
npm test
npm run docs:check
npm run security:check
npm run recovery:check
npm run bench:scale
npm run bench:tenant
npm run release:check
```

Repository boundaries:

- **Always:** preserve V5 compatibility contracts, keep work bounded, add
  migration and security evidence, and update living documentation with the
  implementation.
- **Ask first:** changing persisted schemas, removing public routes/tools,
  adding dependencies, changing CI/release infrastructure, or selecting a
  distributed deployment model.
- **Never:** commit secrets, silently reinterpret V5 records, weaken policy in
  a request path, delete failing tests without replacement evidence, or publish
  an unverified migration.

---

## 14. Success criteria for this specification

This document is ready to become an implementation plan when:

- maintainers approve the capability map and dependency order;
- trust, sensitivity, and expiration semantics are resolved into concrete
  schemas and policy precedence;
- the V6 API domain/versioning strategy is approved;
- the V5→V6 migration artifact and rollback model are approved;
- the 10K/100K/1M/10M+ performance profiles have documented hardware and
  quality thresholds;
- an owner and task plan exist for each capability module;
- no implementation work is implied to be complete merely because this
  specification exists.

---

## 15. Open questions

These questions must be resolved before the corresponding V6 schema or API is
implemented:

1. What are the final sensitivity labels and inheritance rules?
2. Is expiration absolute, renewable, policy-derived, or a combination?
3. What legal-hold or equivalent operator control is required?
4. Which policy engine is authoritative: built-in, host-provided, or a
   composition of both?
5. Does V6 use `/api/v6`, content negotiation, or separately versioned domain
   services while preserving `/api/v1`?
6. What is the canonical replay/idempotency key model for writes, snapshots,
   jobs, and provider operations?
7. Which local vector/index implementations are supported without a remote
   service?
8. What distributed consistency and failure model is required for V5.2.0
   before V6.0.0?
9. Which evidence and retention requirements apply to security audit events?
10. What compatibility period applies to V5 after V6.0.0 is released?

---

## 16. Related documents

- [V5 tenant contract](v5-tenant-spec.md)
- [V5 policy configuration](v5-policy.md)
- [V5 context contract](v5-context-spec.md)
- [V5 threat model](v5-threat-model.md)
- [V5 release gates](v5-release-gates.md)
- [Public API and stability contract](public-api.md)
- [Security model](security.md)
- [Architecture](architecture.md)
- [Migration from V4.9](migration-v4.9.md)
