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
    relationExpansion: false
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
| `REMEMBRA_RETRIEVAL_RELATION_EXPANSION` | `true`/`false` | `false` |
| `REMEMBRA_PROVENANCE_REQUIRED` | `true`/`false` | `true` |
| `REMEMBRA_RETRIEVAL_FUSION_WEIGHTS` | `name=value,...` | unconfigured |

Precedence is: validated defaults → policy file → environment overrides.
The policy object can also be injected directly in trusted application code via
`new MemoryService(backend, { policy })`.

### Fusion weights

`retrieval.fusionWeights` makes the ranking tunable per deployment. Every default
reproduces the behaviour that shipped before the weights existed, so leaving the
section out changes nothing.

| Weight | Scales | Default |
|---|---|---|
| `keyword` | the lexical (reciprocal-rank) contribution | `1` |
| `semantic` | the semantic (reciprocal-rank) contribution | `1` |
| `metadata` | provenance, trust, retention and importance, together | `1` |
| `recency` | the recency modifier | `1` |
| `confidence` | the confidence modifier | `1` |
| `rrfK` | how steeply fused score falls off with rank | `1.6` |
| `fusionScale` | the scale of the fused score against the modifiers | `50` |

```yaml
retrieval:
  fusionWeights:
    keyword: 2
    semantic: 0.5
    recency: 0
```

Equivalently, `REMEMBRA_RETRIEVAL_FUSION_WEIGHTS=keyword=2,semantic=0.5,recency=0`.

A weight of `0` is legal and is the point of the knob: it turns that signal off.
Weights must be non-negative and finite, and `rrfK` must be above zero. An
unknown weight name is an error rather than a silent no-op, so a typo cannot
leave a deployment running on defaults it did not ask for.

Two things are worth knowing before tuning. The metadata weight covers four
signals at once, so there is one knob rather than four. And `rrfK` and
`fusionScale` cannot reorder a list on their own — the first is monotone in rank
and the second is a common multiplier — so they change *scores*, not order; to
see either one move a result, the fusion and the modifiers have to disagree
first.

## Enforcement notes

- `extraction.enabled=false` rejects session digest before provider work.
- `roles.requireTrust=true` preserves the standing-instruction trust gate;
  disabling it is an explicit application policy choice and is never controlled
  by a memory request.
- `sensitiveData.action` is passed to the existing sensitive-data detector.
- `lifecycle.default` is applied when a store omits retention.
- `retrieval.diversity` controls bounded MMR; `retrieval.reranking` applies the
  deterministic embedding tie-breaker before MMR.
- `retrieval.relationExpansion` enables one-hop, 32-edge expansion inside the
  already-authorized candidate pool; it never performs a cross-tenant lookup.
- `provenance.required` documents the mandatory provenance invariant; current
  storage schemas already enforce provenance on normalized reads/writes.

Invalid configuration is a startup/configuration error, not a request-time
fallback. See [v5-context-spec.md](v5-context-spec.md) and
[v5-threat-model.md](v5-threat-model.md) for the context-specific boundaries.
