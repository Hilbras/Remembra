# V5 Threat Model (Final)

**Status:** Final V5 threat model; maintained for V5.0.2 and the V5 release line.
**Scope:** V5.0.x HTTP/MCP/SDK/service paths, legacy compatibility mode,
strict tenant mode, supported storage backends, snapshots, recovery surfaces,
and optional providers.

This document describes the security boundary honestly. It is not a claim that
Remembra provides complete anti-repudiation, secure erasure, database
encryption, or isolation from a compromised host.

## Scope and deployment modes

Remembra has two explicit service modes:

- **Legacy mode** preserves the V4.9 single-tenant file/SQLite behavior. It is
  not a mixed-data fallback and must not be used to serve V5 tenant data.
- **Strict mode** requires a host-minted, immutable `TenantContext` for every
  data-plane operation. Public request fields cannot select an organization,
  project, user, or agent.

The default runtime backend is SQLite. The file backend is a supported
compatibility/embedded backend and an explicitly permitted startup fallback.
A deployment with tenant data must use strict mode and a current host
membership decision.

## Assets

1. Memory content, embeddings, relationships, lifecycle state, and history.
2. Tenant organization/project/user/agent identifiers and membership versions.
3. Owner/access/trust/provenance metadata and authorization capabilities.
4. API keys, snapshot HMAC keys, provider credentials, encryption keys, and
   process environment secrets.
5. SQLite databases, WAL/SHM files, file trees, history, exports, backups,
   migration plans, checkpoints, and audit rows.
6. Retrieval/context budgets, ranking/candidate decisions, and availability of
   the memory service.
7. Provider requests, transcripts, responses, diagnostics, and derived caches.

## Trust boundaries

1. **HTTP network → Node process:** API-key authentication, public health/UI
   exemptions, request limits, trusted host tenant resolution, and central
   authorization.
2. **MCP stdio → local process:** the invoking OS user/process and the
   process-bound context are the boundary; MCP has no independent network
   authentication protocol.
3. **SDK/client → embedding application:** the SDK is a client and rejects
   server-managed identity fields; the embedding application must authenticate
   and bind the host principal.
4. **Service → tenant directory:** membership and capability freshness is
   resolved outside the pure policy evaluator; queued and ordinary service
   operations recheck a configured verifier before use.
5. **Service → storage:** organization/project/user/agent filters and effective
   visibility are applied before candidate limits, counts, ranking, and output.
6. **Service → provider:** transcript/content egress is optional, bounded, and
   provider responses remain untrusted data.
7. **Process → local storage/operator tools:** filesystem permissions, SQLite
   files, exports, backups, CLI environment, and recovery commands are operator
   trust boundaries.
8. **Snapshot/backup/migration file → service:** signatures/checksums establish
   integrity/authenticity only; they do not establish confidentiality or
   freshness by themselves.

## Attacker profiles

- An unauthenticated network attacker or man-in-the-middle.
- A holder of the shared HTTP API key, which is a broad data-plane credential.
- A malicious or compromised tenant principal trying to select another
  organization/project/user/agent.
- A malicious memory author or transcript source attempting prompt injection or
  secret exfiltration.
- A compromised MCP host or another local process running as the same OS user.
- An author of a tampered snapshot, backup, migration plan, or state file.
- A passive thief of a database, file tree, export, backup, WAL/SHM file, or
  process environment.
- An active local user/root/process-memory attacker.
- A malicious or compromised provider.
- A dependency/build/npm supply-chain attacker.
- An availability attacker targeting storage, providers, queues, or recovery.

## Attack surfaces and required controls

| Surface | Primary risks | Required controls/evidence |
|---|---|---|
| HTTP API/UI/health/metrics | Forged identity, data disclosure, body/resource abuse, secret leakage | Authenticate before protected rate consumption; trusted tenant resolver; reserved ingress fields; central policy; bounded bodies/rate limits; `SEC-RL-*`, `SEC-AUTH-*` |
| MCP stdio | Local process impersonation, tool argument identity forgery | OS process isolation, immutable bound context, service policy, no identity arguments; MCP contract tests |
| SDK | Client-supplied tenant/owner/access fields, accidental credential transmission | Reject server-managed fields before transport; SDK is not an authorization authority |
| Tenant directory/entities | Stale membership, cross-tenant entity disclosure, privilege escalation | Versioned membership, exact entity filtering, admin-only mutations, `SEC-AUTH-001/002` |
| SQLite/file storage | Cross-tenant rows, traversal, symlinks, partial/corrupt writes, ID confusion | Tenant predicates before limits/counts, path containment, regular-file checks, atomic writes/locks, `SEC-TENANT-001`, `SEC-PATH-001` |
| History/relations/audit/queues | Foreign references, stale work, side channels, incomplete audit | Same visibility predicate, reauthorization, bounded queues, best-effort filtered audit |
| Encryption | Key loss/compromise, misleading backend assumptions | File bytes only; explicit SQLite/snapshot/transport limitations; encrypted volumes/TLS |
| Snapshots/migrations | Tenant reassignment, tampering, replay, partial application | Signed target-bound plans, preflight before writes, idempotent retry, verified backup/rollback; `SEC-SNAPSHOT-001` |
| Providers/logs | Secret leakage, raw transcript disclosure, SSRF/provider faults | Redaction boundary, generic public errors, bounded diagnostics, provider configuration/timeout policy |
| Package/runtime supply chain | Malicious dependency or native addon | Lockfile, audit, Node 18/24 release gates, controlled install scripts |

## Security invariants

The V5 release line maintains these invariants:

- No strict operation reads or mutates a foreign organization.
- A scoped project/user/agent selector cannot be widened by an absent
  dimension, a scope string, `provenance.agentId`, or an administrative label.
- `tenant:admin` does not erase explicit selectors; an organization-wide
  principal has no project/user/agent selector and requires explicit trusted
  capabilities.
- Ordinary strict restore never assigns a tenantless snapshot implicitly.
- Authorization is decided before provider work, mutation, or an export that
  could disclose data.
- Unauthorized and missing resources use the same externally visible
  not-found contract, apart from the caller-supplied ID.
- No storage failure silently changes the data plane; fallback is explicit.
- Public provider errors contain stable generic messages, not raw diagnostics.
- Cross-tenant cursors, counts, candidate sets, caches, relations, history, and
  exports do not provide an existence oracle.
- V4.9 compatibility never silently turns a V5 record into an unscoped record.

## Threat register and evidence

| ID | Threat | Mitigation | Evidence / residual risk |
|---|---|---|---|
| `TM-AUTH-001` | Spoofed or widened tenant identity | Opaque context, central evaluator, exact dimensions, trusted membership verifier | `SEC-AUTH-001`, `SEC-AUTH-002`; a process-bound operator without an external directory cannot detect revocation after startup |
| `TM-AUTH-002` | Valid principal reaches another user's/agent's record | Backend predicates before candidate limits/counts; service/resource checks; file history checks | `SEC-AUTH-001`, `SEC-AUTH-004`; direct legacy filters must opt into organization-wide semantics |
| `TM-AUTH-003` | Unauthorized provider work or mutation | Service authorization before provider/write paths; per-item batch checks | `SEC-AUTH-003`; provider egress remains an operational data-sharing decision |
| `TM-AUTH-004` | Stale queued or request context | Fresh verifier checks for ordinary service calls/jobs; immutable context | `SEC-AUTH-002`; stock CLI is process-bound and needs a host directory for live revocation |
| `TM-DATA-001` | Cross-tenant reference/history/audit leak | Same tenant filter on resources and derived paths; bounded reference resolution | `SEC-TENANT-001`, `SEC-AUTH-001`; audit is not a complete ledger |
| `TM-STORAGE-001` | Traversal, symlink, or unsafe file substitution | ID validation, containment, regular-file/symlink checks, locks | `SEC-PATH-001`, `SEC-STORAGE-001` |
| `TM-SNAPSHOT-001` | Tampered or replayed restore/migration input | HMAC/signature, target binding, manifest/checksum preflight, dry-run, idempotence | `SEC-SNAPSHOT-001`; HMAC does not provide confidentiality or anti-replay freshness |
| `TM-SECRET-001` | Credentials or provider diagnostics leak | Central log redaction, generic public errors, bounded internal diagnostics | `SEC-LOG-*`, `SEC-AUTH-005`; regex/pattern controls are not perfect DLP |
| `TM-CRYPTO-001` | Operator assumes SQLite is encrypted | Canonical encryption matrix and fail-loud file-key behavior | `SEC-DOC-001`; use encrypted volumes/backups and protect keys |
| `TM-AVAIL-001` | Resource exhaustion through context/provider/storage | Hard budgets, bounded queues/candidates/relations, rate limits, timeouts | `SEC-RL-*`, scale/tenant benchmarks |
| `TM-SUPPLY-001` | Dependency or native package compromise | Lockfile, audit, package dry-run, Node 18/24 gates | Release gate; install-script policy remains an operator concern |

## Encryption and confidentiality boundary

`REMEMBRA_ENCRYPT_KEY` encrypts file-backend memory/history file bytes with
AES-256-GCM. It does **not** encrypt SQLite database pages, SQLite WAL/SHM
files, exported snapshot JSON, process memory, filenames/metadata, or HTTP/MCP
transport. Snapshot HMAC signs plaintext content for authenticity/integrity;
it is not encryption. SQLite backups are plaintext SQLite files with an
accidental-corruption SHA-256 sidecar. Operators must use encrypted volumes or
filesystem encryption, protect backups/snapshots separately, and terminate TLS
for non-loopback traffic.

## Residual risks

- A process-memory or local-root attacker may read plaintext data and keys.
- A static API key is broad authority; this release does not provide key
  rotation, per-user API credentials, or a revocation ledger.
- MCP security depends on OS process isolation and the host's binding.
- Provider selection can disclose raw transcript/content to a third party;
  redaction does not prevent provider-side disclosure.
- Pattern-based secret/PII detection has false negatives and false positives.
- HMAC snapshots have no built-in freshness, anti-replay, or rollback policy.
- Audit/history is filtered and best-effort, not immutable or complete
  anti-repudiation evidence; some lifecycle events are not retained as a full
  ledger.
- `forget` is not secure erasure: filesystem recovery, history, exports,
  backups, provider copies, and replicas may retain data.
- Default sensitive-data behavior is configuration-dependent and must be
  tested against the selected policy; no regex is a compliance control.
- File encryption does not hide paths, tenant directory names, timestamps, or
  process memory; key rotation is an operator procedure.
- A provider, dependency, operating system, or host process compromise is
  outside the application boundary.
- Public health and operational endpoints may reveal bounded version/backend
  readiness metadata; deployments should decide whether that metadata is
  acceptable at their network boundary.

## Operator responsibilities

1. Bind non-loopback deployments behind TLS and protect the listener/API key.
2. Generate, store, rotate, and revoke API, provider, snapshot, and encryption
   keys through a secret manager; protect process environment and file
   permissions.
3. Use strict mode for shared/tenant deployments and provide a trusted tenant
   directory/membership resolver; do not treat public headers or scopes as
   identity.
4. Grant organization-wide capabilities deliberately. Keep explicit
   project/user/agent selectors on scoped administrators.
5. Use encrypted volumes/filesystem encryption for SQLite, WAL/SHM, snapshots,
   and backups. Never assume `REMEMBRA_ENCRYPT_KEY` covers SQLite.
6. Govern provider egress and understand raw transcript/content disclosure.
7. Maintain separate, tested backups; rehearse restore, migration retry, and
   rollback procedures.
8. Monitor health, readiness, metrics, redacted logs, provider failures, queue
   depth, storage errors, and authorization failures.
9. Review global roles/instructions, sensitive-data policy, retention, and
   deletion semantics with the data owner.
10. Run the security, recovery, documentation, audit, package, and performance
    release gates on supported Node versions and keep an incident/rollback
    procedure.

## Release evidence

V5.0.x release evidence must include:

```text
SEC-RL-001, SEC-RL-002
SEC-LOG-001, SEC-LOG-002, SEC-LOG-003, SEC-LOG-004, SEC-LOG-005
SEC-STORAGE-001
SEC-PATH-001
SEC-SNAPSHOT-001
SEC-TENANT-001
SEC-AUTH-001, SEC-AUTH-002, SEC-AUTH-003, SEC-AUTH-004, SEC-AUTH-005
SEC-DOC-001
```

The authoritative commands are defined in
[`v5-release-gates.md`](v5-release-gates.md). V5.0.2 does not authorize V6
policy, schema, provider, API, or migration implementation.
