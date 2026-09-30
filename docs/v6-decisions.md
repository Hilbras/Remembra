# V6 policy and version decisions (V6-T01)

Status: **approved 2026-09-30.**

Date: 2026-09-30

Resolves the open questions in [`v6-architecture-spec.md`](v6-architecture-spec.md)
§15 that block schema and API implementation. Nothing here is implemented: this
record exists so that V6-T02 and V6-T03 start from decisions rather than from
guesses, and so that any decision later reversed is visibly reversed rather than
quietly contradicted by code.

Each decision states what V5 does today, because a V6 decision that cannot be
read against V5 is not a migration path — it is a second product. Those V5
readings were checked against the source rather than recalled: `RetentionMode` is
the five-value enum in `src/types.ts`; the API prefix is the single `API_PREFIX`
constant in `src/api-contract.ts`; the idempotency surface is
`idempotencyKey` + `idempotencyScope` in `src/service.ts` with `replayed` as a
reported state; and the MCP tool set is the fourteen `memory_*` tools in
`src/mcp.ts`.

All ten questions are now settled. Five were genuine forks rather than defaults
and were put to the maintainer; each decision below carries the date and the
reasoning that settled it, so a later reversal is visibly a reversal.

## How to read the status column

| Status | Meaning |
|---|---|
| **Decided** | Settled. Five required a maintainer call; each carries the date inline. |
| **Deferred** | Deliberately not decided now, with the safe default named and the decision's owner named. |

Nine decisions were settled directly from constraints V5 has already committed
to. Five of them were genuine forks and were put to the maintainer; all five
came back with the recommended answer, and each records why below rather than
being silently absorbed into the prose.

---

## 1. Sensitivity labels and inheritance

**Decision: a closed ordered enum, no inheritance.**

Labels, most restrictive first: `secret` → `confidential` → `internal` → `public`.

- The enum is **closed**. An unknown label is a validation failure, not a
  permissive fallback. V5 already fails closed on unknown policy values — a
  misspelled `retention` is rejected rather than treated as the default — and an
  open enum would quietly grant read access to a label nobody classified.
- Labels are **ordered**, so "at most `internal`" is a single comparison. Ordering
  is what makes redaction expressible without a rule per pair.
- **No inheritance.** A memory's sensitivity is its own; it is never inherited
  from its project, tenant, or relations.

Why not inheritance: inherited classification is how a redaction label becomes
wrong. A child memory created under a `confidential` parent would carry
`confidential` forever, with no way to say it is now `public`, and no reclassification
of the parent would propagate correctly to a subtree that had been re-labelled
locally. V5 has no inheritance anywhere in its tenancy or retention model, so this
also keeps V6 additive.

**Consequence:** redaction is total per memory. A `secret` memory is excluded from
any response unless the caller holds a clearance for `secret` — never partially
emitted, never summarised.

**Resolved by [Decision 9](#9-audit-evidence-and-retention):** a `secret` memory
never appears in any aggregate a lower-clearance caller can read. The label's
reach extends to existence, not only to content.

## 2. Expiration semantics

**Decision: absolute expiry, independently renewable, policy-derived as a default only.**

Three distinct things, deliberately not conflated — V5 already distinguishes
archival from deletion from supersession, and this extends that:

- **Expiration** (`expiresAt`): absolute wall-clock instant. At or after it, the
  memory is not returned by any read path. It is *not* deletion — the record stays
  and stays auditable.
- **Renewal**: explicit, never automatic. A renewal is an ordinary authenticated
  write that extends `expiresAt`; it is bounded by the retention policy, so a
  `neverExpire` memory cannot be given an expiry and an ephemeral one cannot be
  renewed past its ceiling.
- **Policy-derived expiry**: the retention mode supplies a *default* for a write
  that does not specify one. It is never a ceiling and never overrides an explicit
  value.

V5's `RetentionMode` (`pinned`, `persistent`, `ephemeral`, `decaying`,
`neverExpire`) is the input to the third clause and is preserved as-is. V6 does not
redefine it; it gains a companion `expiresAt` that V5 does not have.

**Consequence:** `neverExpire` means exactly that — no expiry is ever derived for
it — which is why an explicit `expiresAt` on a `neverExpire` memory is a validation
error rather than a silent override.

**Decided 2026-09-30: renewal after expiry is allowed, with an explicit
audited `renewalReason`.** Renewing after expiry is a resurrection primitive, so
the reason is mandatory and is recorded as an audit event. A renewal without a
reason is `INVALID_INPUT`, not a default reason. This is the fork the ADR
originally left open; it is now settled in favour of the looser option because
forbidding it would make a legitimate correction impossible, and the audit trail
is what keeps the looser option honest.

## 3. Legal hold

**Decision: a first-class boolean, set by operator action only, and it wins over everything except an explicit deny.**

- `legalHold: true` **blocks every destructive operation**: deletion, archival,
  expiry-driven deletion, retention decay, and redaction that would destroy the
  record. Retention and expiry continue to be *computed* — the memory still ages
  and is still listed as expired — but nothing may destroy it.
- It is settable **only** by operator action: not from a request body, not from
  MCP, not from a provider callback. A caller who could set it would be able to
  block cleanup; a caller who could clear it would be able to escape retention.
- Ordering with deny: a policy deny still denies. Legal hold is not a way to
  *gain* access — it only ever prevents destruction.

This is deliberately the smallest thing that satisfies the requirement. There is
no hold *scope* (no per-field or per-date-range hold) in V6.0.0; if that is needed
it is a later version, and recording the omission is better than shipping a
partial hold that looks complete.

## 4. Policy engine authority

**Decision: composition, with the built-in engine authoritative and fail-closed.**

- The built-in evaluator is authoritative and always runs.
- A host-provided evaluator **may only narrow**: it can deny what the built-in
  engine allows, never widen it. The effective decision is the *most restrictive*
  of the two.
- If the host evaluator is **absent, slow, errors, or returns malformed output**,
  the built-in engine's decision stands. There is no path where a host failure
  produces an allow.

Rationale: V5's security posture is that a caller can never weaken extraction,
trust, or retention "from HTTP/MCP request bodies". A host evaluator that could
widen would reintroduce exactly that, one configuration file away. Narrow-only
composition is the same principle applied one layer up.

**Consequence:** a deployment cannot use a host evaluator to grant access the
built-in engine refuses. This is a real limitation, deliberately accepted.

## 5. API versioning

**Decision: `/api/v6` alongside `/api/v1`, plus content negotiation on the existing prefix.**

- `/api/v1` is **unchanged in meaning** for the whole V6 migration window. No
  route silently changes semantics.
- New V6 routes live under `/api/v6`. No V6 semantics appear under `/api/v1`.
- Content negotiation (`Accept: application/vnd.remembra.v6+json`) is **also**
  accepted, so a caller pinned to a base URL can opt in without path rewriting.
- The MCP tools keep their V5 contract; V6 capabilities are added as **new** tools
  rather than changed fields on existing ones. A tool whose parameters gain a
  meaning would break the typed SDK contract V5.7.1 just fixed. The existing tool
  set is `memory_store`, `memory_search`, `memory_get`, `memory_list`,
  `memory_update`, `memory_forget`, `memory_archive`, `memory_revive`,
  `memory_relate`, `memory_history`, `memory_context`, `memory_batch`,
  `memory_digest`, and `memory_maintain`.

**Decided 2026-09-30: both.** `/api/v6` routes exist *and*
`Accept: application/vnd.remembra.v6+json` is honoured, so a caller pinned to a
base URL can opt in without rewriting URLs while the path keeps V6 unambiguous in
logs. Shipping only one was rejected as half the mechanism.

## 6. Replay and idempotency

**Decision: one bounded scoped key model, shared by every non-idempotent operation.**

Scope: `tenant + operationClass + callerSuppliedKey`. The key is
**caller-supplied and required** for writes, snapshots, migrations, jobs, and
provider operations; it is never derived from the payload (a payload-derived key
would silently dedupe two genuinely different requests that happen to hash alike).

- Operations are classified into explicit **operation classes**; two operations in
  different classes never share an idempotency record even with the same key.
- Replay of a completed operation returns the **recorded original response**, not
  a re-execution. V5's batch idempotency ledger already does this and it is
  carried forward rather than reinvented.
- Records are **bounded and tenant-scoped**, with the retention the ledger already
  applies.
- **Fail closed** on a fingerprint mismatch: the same key with a different request
  shape is a conflict, never a silent overwrite.

The concrete risk this closes: two different callers, or two different operations,
colliding on one key. Scoping by tenant and operation class is what makes
collision impossible rather than unlikely.

**Decided 2026-09-30: provider operations get their own operation class.** A
provider call is not a memory mutation and its replay semantics differ, so
sharing the write class is rejected — it could let a provider replay be answered
with a memory response.

## 7. Local vector and index implementations

**Decision: defer to a decision in the storage layer, with a hard constraint recorded now.**

The constraint is the part that matters and is decided: **no V6 vector index may
require a remote service**, and the default V6 deployment is local/offline
(provider-free), per plan assumption 3. Which local implementation is chosen is a
V6-T13+ (provider boundary) decision, not a policy-model one.

**Deferred** to the storage layer, with the safe default named: an empty index is
a valid, fully functional state — V5's lexical path already works with no
embedding provider configured, and V6 must not regress that.

## 8. Distributed consistency and failure model

**Deferred — out of scope for V6.0.0, with the requirement recorded.**

V6.0.0 targets the **single-node** deployment. The file and SQLite backends are
the compatibility baseline (plan assumption 9), and V5 already has an
owner-only, fail-closed claim-directory protocol.

The safe default is what V5 does today: **a single writer**, contention refused
rather than resolved by last-write-wins. Multi-writer distributed consistency is
a separate milestone with its own spec, and guessing at it now would put
unfalsifiable language into a document that is supposed to be a contract.

## 9. Audit evidence and retention

**Decision: content-free events, bounded, and retained at least as long as the data they describe.**

- An audit event carries **no memory content** — never a body, never a snippet,
  never a field value that could reconstruct one. It carries the decision
  (`allow`/`deny`/`redact`/`quarantine`/`expired`), the reason code, the policy
  version, the actor and tenant, and the target identifier.
- Retention: audit events outlive the memory they describe. Deleting a memory does
  not delete the record that it was accessed. This is the one place where the
  legal-hold rule and the retention rule interact, and the ordering is fixed:
  **legal hold first, then retention.**
- Events are append-only and bounded per tenant, with the same pagination and
  redaction as any other domain.

**Decided 2026-09-30: deny entirely.** A caller below `secret` clearance may not
learn that a `secret` memory exists — not even as an aggregate count or a
timestamp. Existence disclosure is itself a leak channel, so an operator who
needs the counts reads them from an audit surface that is itself access-controlled,
not from a list endpoint.

## 10. V5 compatibility window

**Decision: V5 remains fully supported for the entire V6 migration window, which is one major version: V5.x through V6.0.0 and its patch line.**

- V5 receives **security and correctness fixes only**. No V5 feature additions, so
  the supported surface stops growing.
- V6 reads V5 data through an explicit migration (V6-T19+) that is versioned,
  dry-runnable, and reversible. A V6 deployment is never a V5 store opened in
  place.
- The compatibility window closes by an announced major version after V6.0.0, not
  by an unannounced removal.

This is plan assumption 1, and it is the one V6 decision that constrains every
other: a migration window that can be closed without notice makes "V5 remains
supported" untrustworthy.

---

## Decisions that required a maintainer call

Five questions were forks rather than defaults. Each was put to the maintainer on
2026-09-30 with its recommendation and the cost of the alternative stated; all five
came back with the recommendation. The table records what was asked, so the shape of
the fork stays visible after it is closed.

| # | Question | Answered | Decision |
|---|---|---|---|
| 2 | May an expired memory be renewed, or only before expiry? | Allow after expiry, with a mandatory audited `renewalReason` | Forbidding was rejected: it makes a legitimate correction impossible, and the audit trail is what keeps the looser answer honest |
| 5 | `/api/v6` path, content negotiation, or both? | **Both** | Path-only needs URL rewriting for pinned callers; negotiation-only is ambiguous in logs. Shipping one is half the mechanism |
| 6 | Do provider operations get their own idempotency class? | Yes, their own class | Sharing the write class could let a provider replay be answered with a memory response |
| 9 | May a sub-`secret` caller see *that* a `secret` memory was accessed? | No — deny entirely | Allowing leaks existence through aggregate counts, which is itself a leak channel |
| 1 | May `secret` memories appear in aggregate counts? | No — resolved by #9 | The label's reach extends to existence, not only to content |

The three the rest of the plan leans on hardest — the sensitivity order, the
fail-closed engine composition, and the scoped idempotency key — were not forks and
were settled from constraints V5 has already committed to.

## Not decided here

- **Implementation of any kind.** This record is approved; V6-T02 is unblocked and
  is the first thing to build. Nothing here is implemented yet.
- **V6-T03's schema shape.** Field names and defaults are T03's acceptance, and
  this record deliberately describes semantics rather than shapes.
- **The two deferred items** (§7 local index choice, §8 distributed consistency)
  are carried forward with their safe defaults named, which is what the
  "every unresolved decision has a safe default" criterion asks for.