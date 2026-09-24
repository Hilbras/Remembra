# V5 Memory Policy Configuration

V5 policy is loaded once when `MemoryService` is constructed. It is not read
from HTTP/MCP request bodies, so a caller cannot weaken extraction, trust,
sensitive-data, lifecycle, retrieval, or provenance rules.

## File format

Set `REMEMBRA_POLICY_FILE` to a trusted local YAML file (maximum 64 KiB):

```yaml
memory:
  extraction:
    enabled: true
  roles:
    requireTrust: true
  sensitiveData:
    action: quarantine
  lifecycle:
    default: decaying
  retrieval:
    reranking: true
    diversity: true
  provenance:
    required: true
```

The implementation accepts the policy sections at the document root or under
a single `memory:` wrapper. Unknown sections or fields, invalid enum values,
non-boolean values, unreadable files, and oversized files fail closed with
`INVALID_INPUT` during service startup.

## Environment overrides

The following trusted environment variables override file values:

| Variable | Values | Default |
|---|---|---|
| `REMEMBRA_EXTRACTION_ENABLED` | `true`/`false` | `true` |
| `REMEMBRA_ROLES_REQUIRE_TRUST` | `true`/`false` | `true` |
| `REMEMBRA_SENSITIVE_POLICY` | `allow`, `redact`, `reject`, `quarantine` | `redact` |
| `REMEMBRA_LIFECYCLE_DEFAULT` | `pinned`, `persistent`, `ephemeral`, `decaying`, `neverExpire` | `decaying` |
| `REMEMBRA_RETRIEVAL_RERANKING` | `true`/`false` | `true` |
| `REMEMBRA_RETRIEVAL_DIVERSITY` | `true`/`false` | `true` |
| `REMEMBRA_PROVENANCE_REQUIRED` | `true`/`false` | `true` |

Precedence is: validated defaults → policy file → environment overrides.
The policy object can also be injected directly in trusted application code via
`new MemoryService(backend, { policy })`.

## Enforcement notes

- `extraction.enabled=false` rejects session digest before provider work.
- `roles.requireTrust=true` preserves the standing-instruction trust gate;
  disabling it is an explicit application policy choice and is never controlled
  by a memory request.
- `sensitiveData.action` is passed to the existing sensitive-data detector.
- `lifecycle.default` is applied when a store omits retention.
- `retrieval.diversity` controls bounded MMR; reranking remains an explicit
  policy seam until a non-identity reranker is selected.
- `provenance.required` documents the mandatory provenance invariant; current
  storage schemas already enforce provenance on normalized reads/writes.

Invalid configuration is a startup/configuration error, not a request-time
fallback. See [v5-context-spec.md](v5-context-spec.md) and
[v5-threat-model.md](v5-threat-model.md) for the context-specific boundaries.
