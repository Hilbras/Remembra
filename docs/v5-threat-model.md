# V5 Context API Threat Model (Draft)

## Assets

- Private and tenant-scoped memory content.
- Trust, provenance, lifecycle, and authorization metadata.
- API keys and provider credentials.
- Retrieval quality and context-budget guarantees.
- Memory-store integrity and audit history.

## Trust boundaries

1. HTTP/MCP/SDK request → authenticated transport.
2. Authenticated transport → host-resolved agent/tenant context.
3. Service → backend candidate/read operations.
4. Service → embedding/LLM provider.
5. Backend → local SQLite/filesystem and export snapshots.
6. Retrieved memory content → consuming agent/model.

## Threats and controls

| Threat | Control | Required evidence |
|---|---|---|
| Spoofed agent/tenant identity | Authenticate first; resolve identity only from trusted host callback/context; reject identity fields in SDK requests | Cross-tenant and forged-header tests |
| Private-memory disclosure through context | Apply the same hard visibility filter before ranking/serialization; test direct, relation, batch, and context paths | Adversarial isolation matrix |
| Prompt injection through selected memory | Treat memory as data; preserve trust/provenance metadata; never execute or auto-approve content | Poisoning and standing-instruction tests |
| Secret leakage in context | Ingest redaction/sensitive-data policy; bounded provider handling; no raw secrets in logs/metadata | Secret fixtures and log review |
| Context-budget bypass | Hard integer limit, bounded candidate list, counter-aware selection, no implicit expansion | Boundary/property tests |
| Denial of service through large context | Request/body/candidate/output limits, rate limits, provider and queue budgets | Load/resource tests |
| Unbounded relationship expansion | No implicit relation expansion in the first slice; future hop/output budgets required | Retrieval cost tests |
| Storage corruption or partial recovery | Atomic writes, locks, checksums, verified restore/import | Interruption/corruption fixtures |
| Stale or malicious provider output | Treat provider responses as untrusted data; schema validation and fail-open/fail-closed policy per operation | Malformed provider tests |
| Audit repudiation | Structured low-cardinality events without content/secrets; preserve actor and outcome | Audit event assertions |

## Abuse cases

- A caller submits `agentId`, `owner`, or `access` fields to read another
  tenant's private memories.
- A caller sets an enormous `maxTokens` or candidate limit to force unbounded
  work.
- A poisoned global role is stored with trusted-looking provenance and then
  requested through `context`.
- A provider returns a huge/malformed response or hangs during query
  embedding.
- A relationship cycle or archive/revive interruption causes duplicate or
  missing context candidates.
- A corrupted snapshot is restored over a healthy store.

## Release evidence

V5 release requires passing the context boundary tests, tenant isolation
matrix, secret/poisoning suite, corruption recovery fixtures, full regression
suite, dependency audit, and reproducible 10K/100K performance benchmarks.
