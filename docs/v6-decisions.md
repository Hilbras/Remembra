# V6 policy and version decisions (V6-T01)

Status: **proposed — awaiting maintainer approval.**

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

## How to read the status column

| Status | Meaning |
|---|---|
| **Proposed** | Recommended here. Reversible without a schema migration. |
| **Proposed, needs a call** | A real fork in the road. The recommendation is a default, not an answer. |
| **Deferred** | Deliberately not decided now, with the safe default named. |

Nine of the ten are **proposed** and follow from constraints V5 has already
committed to. Four need your decision, marked below and collected in
[Open decisions](#open-decisions-for-the-maintainer).

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

**Needs a call:** whether `secret` memories may ever appear in aggregate counts
that a lower-clearance caller can read (see [Decision 9](#9-audit-evidence-and-retention)).

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

**Needs a call:** whether an expired memory may be renewed after expiry, or only
before. Renewing after is a resurrection primitive and needs an audit reason; I
recommend allowing it only with an explicit `renewalReason`, because the
alternative silently forbids a legitimate correction.

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

**Needs a call:** whether `/api/v6` exists at all, or whether V6 is
content-negotiation-only on `/api/v1`. I recommend both — the path is unambiguous
in logs, negotiation is what lets a pinned caller adopt it — but shipping one
means shipping half the mechanism.

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

**Needs a call:** whether provider operations get their own class or share the
write class. I recommend their own class, because a provider call is not a
memory mutation and its replay semantics differ.

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

**Needs a call:** whether a caller below `secret` clearance may see *that* a
`secret` memory was accessed (counts and timestamps) without seeing its content.
The safer default is no — deny entirely. I flag it because aggregate existence
disclosure is a real leak channel and operators legitimately need the counts, so
the answer is a product decision, not a technical one.

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

## Open decisions for the maintainer

Four of these are forks rather than defaults. Each has a recommendation, and none
is implemented.

| # | Question | Recommendation | Cost of the other answer |
|---|---|---|---|
| 2 | May an expired memory be renewed, or only before expiry? | Allow after expiry, but only with an explicit `renewalReason` (audited) | Forbidding is simpler and safer; it makes a legitimate correction impossible |
| 5 | `/api/v6` path, content negotiation, or both? | Both | Path-only needs URL rewriting for pinned callers; negotiation-only is ambiguous in logs |
| 6 | Do provider operations get their own idempotency class? | Yes — their replay semantics differ from a memory write | Sharing the write class risks a provider replay being answered with a memory response |
| 9 | May a sub-`secret` caller see *that* a `secret` memory was accessed? | No — deny entirely | Allowing leaks existence through aggregate counts; operators may need it, so it is a product call |

Everything else in §1–§10 is proposed and internally consistent: the sensitivity
order, the fail-closed engine composition, and the scoped idempotency key are the
three the rest of the plan leans on hardest.

## Not decided here

- **Implementation of any kind.** V6-T02 onward still requires this record to be
  approved first; the plan's own gate says so.
- **V6-T03's schema shape.** Field names and defaults are T03's acceptance, and
  this record deliberately describes semantics rather than shapes.
- **The two deferred items** (§7 local index choice, §8 distributed consistency)
  are carried forward with their safe defaults named, which is what the
  "every unresolved decision has a safe default" criterion asks for.