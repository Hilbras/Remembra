# V6.0.0 Task List

Status: **in progress.** V6-T01, T02 and T03 are done (2026-09-30); the ten
architecture decisions the milestone freezes are recorded in
[`docs/v6-decisions.md`](../docs/v6-decisions.md).

**Scope change, 2026-09-30.** A V5.7.1 to V7.0.0 roadmap was supplied and
proposed its own V6.0.0 "core architecture" phase after V5.8.0 through V5.14.0.
Two plans cannot own one version slot, so the maintainer folded V5.8 through
V5.14 into this plan as its Phases 1 through 5, and kept the later phases
(V6.1 through V7.0.0) as named-but-unplanned version commitments. Nothing
approved is retired: T01 through T03 stand, and the V5.x version numbers do not
survive, because a V5.9.0 that "formalizes tenants" would be a breaking change
wearing a minor release's clothes.

The umbrella document is [`docs/v7-roadmap.md`](../docs/v7-roadmap.md). It records
*why* the fold happened and carries the Phase 0 baseline audit; this file remains
the authoritative task list.

Phase 1 is scoped as **guards before moves**: a dependency-direction test must be
green and mutation-verified before any module is relocated. A refactor whose
safety is argued is not the same proposition as one a guard can prove.

Source plan: [`v6-plan.md`](v6-plan.md)
Architecture contract: [`docs/v6-architecture-spec.md`](../docs/v6-architecture-spec.md)

## Phase 0: Decision gates and contracts

- [x] **V6-T01 — Freeze V6 policy and version decisions**
  - Acceptance: trust, sensitivity, expiration, policy precedence, API versioning, replay/idempotency, and V5 compatibility decisions are approved.
  - Verify: architecture review and decision fixtures recorded; no blocking open question remains.
  - Depends on: none.
  - **Approved 2026-09-30.** All ten open questions from the architecture spec §15
    are answered in [`docs/v6-decisions.md`](../docs/v6-decisions.md), each read
    against what V5 actually does — those readings were checked against the source
    (`RetentionMode`, `API_PREFIX`, `idempotencyKey`/`idempotencyScope`, the
    `memory_*` tool set) rather than recalled, and two were corrected as a result.
  - **Five were genuine forks, not defaults**, and were put to the maintainer with
    the recommendation and the cost of the alternative stated. All five came back
    with the recommendation: renewal after expiry is allowed with a mandatory
    audited `renewalReason`; V6 is exposed by **both** `/api/v6` and
    `Accept: application/vnd.remembra.v6+json`; provider operations get their own
    idempotency class; existence of a `secret` memory is never disclosed to a
    lower-clearance caller; and `secret` never appears in aggregates they can read.
  - Two questions are **deferred with a safe default named** rather than answered:
    the local index implementation (Q7, decided part — no remote service may be
    required; deferred to the storage layer) and distributed consistency (Q8,
    single-node V6.0.0, defaulting to V5's single-writer fail-closed behaviour).
    Both are owned by later phases, which is what "every unresolved decision has a
    safe default" asks for.
  - **Decision fixtures are not written.** They are V6-T02's first deliverable: they
    are the executable form of this record, and writing them before the record was
    approved would have encoded assumptions as tests. This is the one Verify item
    that remains open, and it is T02's, not T01's — T01's acceptance is the
    approval, which is taken.

- [x] **V6-T02 — Define versioned policy and decision schemas**
  - Acceptance: versioned bounded policy documents, closed decision effects/reasons, deterministic precedence, and fail-closed validation.
  - Verify: unit/property policy tests, invalid/unknown/version-mismatch fixtures, build/typecheck.
  - Depends on: V6-T01.
  - **Delivered 2026-09-30.** `src/v6-policy.ts` (358 lines) implements the approved
    decisions; `docs/v6-policy.md` is the contract; `src/test/v6-policy.test.ts`
    holds 25 decision fixtures. Suite 942 → 967.
  - **19 mutations, all caught.** Three survived the first pass and were test
    holes, not code defects — and they were the three most consequential defaults
    in the module: nothing pinned that an *absent* clearance is fail-closed rather
    than unrestricted; nothing pinned that a *missing* capability denies (every
    test granted the one its operation needed); and the determinism test asserted
    two calls agree, which a wall clock also satisfies. Now `V6-DEC-022` through
    `V6-DEC-025`.
  - **A real ordering bug in my own first implementation.** `provider_transmit`
    with low clearance returned `sensitivity_denied` instead of
    `provider_not_permitted` — true, but the wrong cause, and it made the egress
    rule unreachable in exactly the case it exists for. The check moved above the
    sensitivity comparison; the reason now says what the caller needs to know.
  - **A deviation from the architecture spec, recorded rather than silently
    applied.** Spec §4.2 proposes `public | internal | confidential | restricted`;
    ADR §1 approved `public | internal | confidential | secret`. The ADR wins,
    `restricted` is retired (it read as a mode, not a level), and restricted
    *handling* moves to the `quarantine` effect where a decision can act on it. V6
    stores are new, so nothing migrates. `V6-DEC-016` pins the four bands.
  - **Two earlier mutation runs were discarded, not reported.** Two harnesses were
    left running against the same file concurrently, so a "caught" in the second
    could have been the first's mutant still on disk; both were killed and the set
    re-run serially, with the source proved identical to its snapshot after every
    revert. Separately, one mutation failed to compile and so produced no verdict
    at all — reported as unmeasurable, then replaced with a behavioural equivalent.
  - `docs/v6-policy.md` records what is *not* here: nothing calls `evaluatePolicy`
    yet. Wiring it into the request path is T04–T07, the cross-axis evaluator is
    T05, and audit emission is T08.

- [x] **V6-T03 — Define V6 memory metadata and schema contract**
  - Acceptance: every new field has type, default, owner, validation, serialization, redaction, indexing, and migration behavior.
  - Verify: round-trip fixtures cover all eleven memory types and policy states.
  - Depends on: V6-T01, V6-T02.
  - **Delivered 2026-09-30.** `src/v6-schema.ts` (320 lines) is the persisted V6
    record; `src/test/v6-schema.test.ts` holds 28 contract fixtures. Suite 967 → 995.
    Every field carries a stated owner in the module, which is the acceptance
    criterion most easily lost — a field nobody owns is one nobody migrates or bounds.
  - **A real security gap found by mutation, invisible to the compiler.** The tenant
    field validated against V5's `TENANT_ID_RE` alone, which bounds character set and
    length but accepts `"."` and `".."` — V5's `isValidTenantId` adds the traversal
    check on top. So a V6 record could carry `organizationId: "."`, a path segment
    rather than a tenant. The compiler cannot catch this: the type is still `string`.
    Now uses the predicate, not the regex.
  - **Lifecycle states are flags, not an enum on the record.** Expired, archived,
    superseded and deleted can all be true of one record at once; collapsing them
    would force a choice between truths. `lifecycleStateOf` derives the one reported
    state with an explicit precedence — `deleted > expired > superseded > archived >
    active` — where `deleted` is terminal, so a tombstone cannot be resurrected by a
    reader that treats expiry as "still retained".
  - **Downgrade refuses rather than drops.** A `confidential` or `secret` record has
    no V5 representation, and a projection that discarded the label would write it
    into a store whose readers have no idea it is sensitive. `internal` and below do
    project — deliberately asymmetric, because V5 treats everything as
    `internal`-or-below, so those lose nothing V5 could have enforced.
  - **A V5 record never classifies as `migrated`.** That is a claim about provenance
    only the migration tool may make. Classification says what a record *is*; it does
    not assert a transformation happened.
  - **25 mutations, 23 caught.** Two were harness artifacts rather than code
    defects, and are recorded as such rather than as passes: S13's mutation supplied
    a *present-but-invalid* field (`""`), which is a different property from an
    absent one and is now pinned separately as `V6-SCH-025b`; and S17 did not
    compile. Eight survivors in the first pass were real test gaps — chiefly four
    tests that asserted "it was refused" without asserting *what the refusal said*, so
    a refusal for the wrong reason counted.
  - **Deviation from the plan's file list, recorded:** the plan names `types.ts`,
    `backend.ts`, `store.ts` and `sqlite-backend.ts`. None is touched. The file
    backend, the SQLite schema and durable storage are T19–T21; touching them here
    would have meant implementing storage before the contract it must satisfy was
    reviewed.
  - **Still ahead of T03's own scope, and named rather than skipped:** the SQLite
    column/index mapping, the file-backend serialization format, and the migration
    path itself. The contract is complete; the persistence of it is not.

### Checkpoint: Contracts

- [ ] V6 policy/schema decisions approved.
- [ ] V5 compatibility fixtures green.
- [ ] Security review confirms public fields cannot alter policy.
- [ ] Maintainer review approves implementation.

## Phase 1: Request security and policy enforcement

- [x] **V6-T04 — Implement identity, authorization, and replay context**
  - Acceptance: identity and tenant are resolved by trusted host code only.
  - Verify: unit tests for forged identity, stale membership, operation mismatch, expiry, duplicate requests, and secret-bearing keys.
  - Depends on: V6-T02, V6-T03.
  - **Delivered 2026-09-30.** `src/v6-request-context.ts` (363 lines); 22 fixtures in
    `src/test/v6-request-security.test.ts`. Suite 995 → 1017.
  - **Three mechanisms carry "a payload cannot widen a context", and each is the
    stronger version of the obvious one.** A private symbol brands the context, so a
    reconstruction is refused; the context and its principal are frozen, so a caller
    cannot widen capabilities mid-request; and unknown fields are *refused* rather
    than stripped, so an injected `isAdmin` cannot ride along unnoticed. This
    extends V5's existing `TENANT_CONTEXT` brand in `tenant.ts` rather than
    introducing a second idea.
  - **The minting input has no `role`, no `isAdmin`, no tenant claim at all.** A
    field that could grant authority is absent, so a payload cannot supply one —
    an adapter's job is to *resolve* identity, not forward what it was given.
  - **Replay scope is tenant + operation class, deliberately excluding the
    principal.** The scope partitions *records*: two principals in one tenant
    sharing an operation share a scope, which is correct, and the two collisions
    that would produce a wrong replayed response — a different operation, a
    different tenant — cannot happen. `policy_admin` deliberately requires a
    capability V5 has no equivalent for, so administrative authority is not implied
    by `tenant:admin`.
  - **`TENANT_REQUIRED` reused rather than a new code.** It is already mapped to 403
    and already means "a trusted context is required". Adding a V6-only code would
    put an unmapped identifier into the V5 error surface callers switch on.
  - **19 mutations, 19 caught.** Six survived the first pass and five were missing
    rules rather than missing tests: nothing pinned mint-time expiry, the deadline,
    that *every* mutating class needs a replay key, the scoped-principal rule, or the
    organization-wide read floor. Now `V6-SEC-018`–`022`.
  - **The brand test was wrong twice before it tested anything, and the mutation is
    what proved it.** `{...ctx}` was assumed to drop the symbol; it does not — a
    spread copies symbol keys but drops frozen-ness, so `isRequestContext` rejected
    the forgery on the frozen check and the brand was never exercised. Asserting a
    precondition (symbols copied; not frozen) and testing a *reconstruction* —
    which is what an attacker builds — is what made R1 observable. The lesson is
    the recurring one: a passing test that asserts nothing is worse than no test,
    because it is mistaken for evidence.
  - **A stray `Remebra/` directory was created and removed.** A mistyped path put
    the test file in a sibling directory outside the repo, so `npm run build`
    silently did nothing for it and the first run reported no test file at all.
    Caught by noticing `dist/test/v6-request-security.test.js` was absent while the
    build reported success. Moved into the repo; the empty directory removed.

- [x] **V6-T05 — Implement the policy evaluator**
  - Acceptance: evaluator is side-effect free and deterministic for a fixed policy/input.
  - Verify: table-driven tests for every policy axis and conflict pair.
  - Depends on: V6-T02, V6-T04.
  - **Delivered 2026-09-30.** `src/v6-policy-evaluator.ts` (238 lines) composes every
    axis into one decision; 20 fixtures in `src/test/v6-policy-evaluator.test.ts`.
    Suite 1017 → 1037.
  - **A real bug in my first implementation, and the hardest kind to notice.**
    Validation of the principal's clearance used
    `Object.prototype.hasOwnProperty.call(SENSITIVITY_ORDER, clearance)` — an
    array's own keys are *indices*, so no value in it ever matches. Every request
    therefore denied with `policy_invalid`. It is fail-closed, which is exactly why
    it survived: every test asserting a *refusal* passed, and only the one test
    asserting an allow failed.
  - **Two orderings are counter-intuitive and documented at the call site.**
    Expiration precedes trust, so a stale memory reports `expired` rather than
    `trust_restricted` — otherwise an operator chases a trust problem for a memory
    that is simply old. Provider egress precedes sensitivity, so a low-clearance
    caller asking to transmit reports `provider_not_permitted` and learns a third
    party was involved; the weakest rule is unchanged, so this changes which reason
    is reported and never whether the operation is permitted.
  - **20 mutations, 19 caught, and the 20th is an equivalent mutant.** E8 removes the
    early-return for an explicit `deny` layer, and the suite cannot notice — because
    the final narrowing step (`if (layer) return layer`) yields the identical
    decision. Verified rather than assumed: with the branch deleted, every layer
    still produced `effect=deny reason=policy_invalid`. That is a property of the
    code's redundancy, not a missing test, and no test could distinguish the two.
  - **Eleven survivors in the first pass were two whole untested surfaces**, not a
    scattering of gaps: the *entire* malformed-input path (no test ever passed an
    invalid value, so all five fail-closed checks were unobserved) and the *entire*
    layer-resolution path (no test had two layers disagreeing, so deny-wins,
    most-restrictive and precedence were all unobserved). `V6-POL-013`–`020` now
    cover both.
  - **E10 was the same trap as T02's DEC-003, in the same shape**: with a deny and
    an allow, restriction alone decides the answer, so deleting the precedence sort
    changed nothing. The fix is the same too — two layers of equal effect with
    different reasons, which only ordering can decide.
  - **One property test was tautological.** The first version of POL-008 computed a
    predicate that was true on every iteration, so it asserted only "no allow
    leaked for these inputs" — trivially satisfied while the *fixture* was wrong.
    A second version spread the defect before the sweep's own memory, so the sweep
    silently replaced the defect and every case was really testing the allow path.
    Both now assert preconditions (the sweep size, the defect applied last).

- [x] **V6-T06 — Enforce policy on direct memory operations**
  - Acceptance: no direct CRUD path bypasses identity, authorization, tenant, and policy.
  - Verify: cross-tenant, cross-project, sensitivity, expiration, and privilege escalation tests for every direct operation.
  - Depends on: V6-T04, V6-T05.
  - **Delivered 2026-09-30.** `src/v6-service-policy.ts` (371 lines) is the choke
    point; 16 fixtures in `src/test/v6-service-policy.test.ts`. Suite 1037 → 1053.
  - **The acceptance criterion is a negative claim, so it is checked structurally.**
    "No path bypasses" cannot be verified by testing the paths that work.
    `DIRECT_OPERATIONS` declares what a direct operation *is*, every one routes
    through `#guard`, and `V6-DIR-002` asserts that **no public method exists
    outside that set** — so adding an unguarded method is a test failure. The
    mutation that adds such a method is caught by that test, which is the criterion
    demonstrated rather than asserted.
  - **Two real existence leaks, both found by the tests and fixed in the implementation.**
    1. An absent record returned a **synthetic row** on the operations that do not
       normalize to `NOT_FOUND`, so a batch containing a missing id reported that item
       as `ok: true` — the mirror image of the leak it was meant to prevent.
    2. Per-item batch failures forwarded the underlying error code, so an absent item
       reported `NOT_FOUND` and a foreign one `TENANT_REQUIRED`. A caller could then
       enumerate ids by reading the code. Every multi-record item now reports one
       code and reason; the policy reason goes to the audit event, where it is safe.
  - **A third defect was a design flaw the tests exposed:** `#guard` fetched the
    record *before* deciding, so a denied read still touched storage. The guard now
    refuses on the context alone before any fetch where it can, and the tests assert
    write-freedom rather than the impossible "a read never fetches" — a read must
    see the record to evaluate its sensitivity and expiry.
  - **A fourth: multi-record operations report per-item outcomes and must not throw.**
    Failing the whole batch because one id is unauthorized would make them unusable
    for mixed sets. The first version expected a rejection, which no correct
    implementation produces.
  - **10 mutations, 9 caught; the tenth is an equivalent mutant.** S1 removes the
    explicit brand check in `#guard`, and `assertFreshContext` performs the same check
    internally with the same message — verified, not assumed: it refuses an unminted
    context with `TENANT_REQUIRED: not a minted request context`. The duplication is
    deliberate belt-and-braces, and no test can separate the two paths.
  - **Two survivors in the first pass were the identity checks themselves.** The brand
    check and the freshness check were called but never observed failing, which for a
    security guard is the difference between "the call is there" and "the call does
    anything". `V6-DIR-015`/`016` now use a forged context and an expired-but-otherwise-
    authorized one, and assert storage was never touched.
  - **One mutation was unmeasurable, not passing.** The first S9 deleted the
    `policyVersion` schema field, which does not compile — reported as a build failure
    and replaced with a behavioural equivalent that stops passing the version through.
  - **Two mistakes of my own, both the sync/async class.** `codeFor` called `s.read()`
    without `await` inside a `try`, so the rejection escaped after the block had already
    returned "no error" — and the existence-leak test passed on two identical
    non-errors. Separately, indexing `svc[op]` where `op` is a union of differently
    shaped methods resolves to an *intersection* of signatures that TypeScript rejects
    for every call; naming the parameter in a small helper removed the union.
  - **V5 legacy behaviour is untouched.** Nothing in `service.ts`, `store.ts` or
    `backend.ts` is modified by this task; the V6 guard is a separate, unreferenced
    type. Wiring it into V5's request path is not this task's scope and is not claimed.

- [x] **V6-T07 — Enforce policy before retrieval candidates and ranking**
  - Acceptance: tenant/sensitivity/expiration predicates occur before SQL/file limits.
  - Verify: backend query-plan/SQL predicate tests and file namespace tests.
  - Depends on: V6-T05, V6-T06.
  - **Delivered 2026-09-30.** `src/v6-retrieval-policy.ts` (223 lines); 17 fixtures
    in `src/test/v6-retrieval-policy.test.ts`. Suite 1053 → 1070.
  - **The criterion is about ORDERING, so it is asserted against SQL rather than
    behaviour.** A `LIMIT 10` over unfiltered rows returns ten foreign memories and
    filters them to zero — a wrong answer *and* a leak in the one place the count is
    observable. A behavioural test ("no foreign memory came back") passes just as
    happily with a LIMIT-first query whenever the tenant owns enough rows to fill the
    limit. So the guarantee is structural: one `compileV6Predicate` writes the clause
    once, and `LIMIT` can only follow it. `V6-RET-005` asserts the position, and the
    mutation that reorders it is caught.
  - **All eight retrieval paths share one identical predicate fragment.** Asserted as
    a set cardinality of 1, so a path written separately and therefore free to drift
    fails the test. That is the "same policy boundary" criterion as a property rather
    than a claim.
  - **A real bug against ADR §3, caught by the fixture.** `read` was in the
    hold-excluding set, so a read predicate excluded legally-held memories. A hold
    blocks *destruction*; excluding held records from a read would hide them from
    exactly the operators who must see what is held. Held memories are excluded from
    *candidates* (context, search) and remain readable by id.
  - **The expiration clause needs both halves.** `(expires_at IS NULL OR expires_at > ?)`
    — `expires_at < ?` alone silently drops every memory that never expires, which is
    usually most of them, and the string still matches `/expires_at/`. Same for the
    boundary: `>` not `>=`, so a memory expiring exactly now is expired.
  - **14 mutations, 14 caught.** Five survived the first pass and they all shared one
    shape: the clause was *present* in every assertion, so inverting it (`>=`), dropping
    the `OR`, dropping the `LIMIT` entirely, or removing the candidate comparison
    changed nothing the tests looked at. Asserting that a guard exists is not asserting
    what it does. `V6-RET-014`–`017` now evaluate the clause against real bands and
    check the direction, the boundary and the bound value.
  - **`allowUnfilteredFallback` is a named `false` field, not an absence.** "If nothing
    matched, return everything" is the exact shape of the fallback this module exists to
    prevent, and a named flag is what makes it assertable; the mutation that permits it
    is caught.
  - **Not wired to a backend.** `src/sqlite-backend.ts`, `src/store.ts`,
    `src/retrieval.ts` and `src/context.ts` are untouched. The module emits the clause
    and applies the same rules in process, so both the SQL and the file-namespace paths
    are specified; adopting them in the real query builders is the integration step and
    is not claimed here. V5's `tenantWhere` is untouched and composable with this.

- [x] **V6-T08 — Policy decision audit and redaction**
  - Acceptance: every decision logged with tenant, actor, reason and policy version;
    no memory content in any log; queryable per tenant.
  - Verify: security matrix cases for log redaction, decision explanation, tenant
    filtering; log injection tests.
  - Depends on: V6-T05, V6-T07.
  - **Delivered 2026-09-30.** `src/v6-audit.ts` (269 lines); 18 fixtures in
    `src/test/v6-audit.test.ts`. Suite 1070 → 1088.
  - **No audit module existed.** V5 has `memory_audit` in SQLite, keyed by
    `memory_id` — so a decision log built the same way leaks *existence*:
    "access denied to `secret-key-42`" is a disclosure in a log a lower-privilege
    reader may see. This log is keyed by **decision**, with no resource identifier at
    all: actor, tenant, operation, policy version, effect, reason, and the *class* of
    resource. Never which resource.
  - **The schema is `.strict()`**, so an added content field fails validation rather
    than being silently accepted into a log. Two mutations confirm it: making the
    schema permissive, and adding a `memoryId` field.
  - **A bounded field is still a field.** The correlation id needed a *shape* denylist,
    not just a length ceiling — 23 characters of a real key fit comfortably, and
    `sk-abc123def456ghi789jkl` is a legal handle by charset. Same shapes `redactForLog`
    recognises, applied before the value is stored rather than after. Caught by
    `V6-AUD-006`.
  - **Retention reports its own gap.** A silently truncating audit log is worse than a
    short one, because a reader trusts it. `dropped` is returned alongside `events`, and
    `V6-AUD-013` asserts both the ceiling and the count.
  - **14 mutations, 14 caught.** Four survived the first pass, and the most serious was
    a genuine cross-tenant hole: the mandatory organization filter on a query could be
    deleted and no test failed, because every query in the file passed an
    organizationId. Without it, an unqualified query returns *every* tenant's
    decisions — the audit surface leaking more than the data plane does. The other
    three were a fixture built from the same constant it was testing (A3), an
    unobserved validation on `append` (A5), and an explanation never exercised with
    anything but a resourceClass (A14). `V6-AUD-015`–`018` now cover them.
  - **Explanations are two fixed sentences from closed vocabularies** — spec §7.2's
    shape, minus `expiresAt` which is not implemented. It cannot carry a resource id or
    content because there is nowhere in it to put one, which is what makes it safe to
    return from an API to a user with a lower clearance than the resource.
  - **In-process ring buffer, not durable storage.** Persistence is T17; this specifies
    and enforces the record's shape and the query boundary, and the SQL schema for
    `PolicyAuditLog` is not claimed.

- [x] **V6-T09 — Define provider-neutral core capability contracts**
  - Acceptance: core interfaces cover storage, retrieval, context, policy, lifecycle,
    audit, snapshots without provider types; provider interfaces declare capability,
    privacy, cost, latency, availability; provider absence is a supported runtime
    state, not a startup error; provider output cannot mutate authorization or policy.
  - Verify: contract tests with no provider, a local provider, and a failing remote
    provider; dependency graph; public type/API compatibility.
  - Depends on: V6-T05, V6-T08.
  - **Delivered 2026-09-30.** `src/v6-core-contract.ts` (253 lines); 20 fixtures in
    `src/test/v6-core-contract.test.ts`. Suite 1088 → 1108.
  - **Provider absence is a first-class state.** Constructing, registering and
    negotiating with nothing are all valid, and negotiation names its misses so a
    caller decides what to degrade rather than discovering an `undefined` at the point
    of use. A missing optional capability is a typed catchable miss, not a `TypeError`.
  - **The boundary is a projection, not a pass-through.** `invokeCapability` copies out
    the fields declared for that capability and discards everything else. A provider
    returning fourteen fields of plausible authority state — `effect: "allow"`, a
    foreign principal, `tenant:admin`, a policy version, a token — crosses with one.
    Each field is copied individually; a spread would reintroduce exactly what the
    projection prevents.
  - **Core is never delegable.** A provider claiming `storage` is refused at
    *registration*, not at negotiation, so there is no state in which core looks
    delegated. My first fixture asserted at negotiation and would have accepted a
    registry that had briefly held the pretender — the fixture was wrong, not the code.
  - **Metadata axes are required, not optional, and bounded.** An absent cost or
    privacy is a constraint nobody chose; an unbounded latency claim is not a latency
    claim, so `p95Ms` is capped and a negative cost refused.
  - **The dependency-graph guard is proven to fire.** `V6-CC-011` reads the real
    `src/` tree rather than an import map. A probe file importing `openai` was written
    into `src/`, the test failed as it should, and the probe was removed — a guard
    that has never fired is not evidence of anything.
  - **13 mutations: 9 caught, 2 survived, 2 unmeasurable — and the classification
    matters more than the count.**
    - K8 survived: metadata tests validated the *schema* directly, so deleting the
      check inside `register` was invisible. The schema being correct and the registry
      enforcing it are two different claims. `V6-CC-017`.
    - K12 survived: the id check was never exercised with an empty string.
      `V6-CC-018`.
    - K1/K3 **failed to compile** — `tsc` rejects removing the projection guard. A
      build-failed mutation is not coverage. K1 was rewritten to compile and is now
      caught by `V6-CC-009`/`010`; K3 cannot be removed at all without the compiler
      refusing, which is a *structural* guarantee rather than a gap, and `V6-CC-019`
      covers it behaviourally. I verified this by attempting a cast-based rewrite:
      tsc rejected it too, and the source was restored byte-identical.
  - **`src/service.ts` untouched.** The contracts and registry are new; wiring them to
    the service layer is a later step and is not claimed. V5's provider handling is
    unchanged.

- [x] **V6-T10 — Implement offline and degraded operation modes**
  - Acceptance: disconnected local install passes the core journey; timeout, malformed
    output, rate limit and cancellation have documented fail-open/fail-closed behaviour
    per operation; no provider error creates partial tenant or policy state; status
    distinguishes core unavailable from provider degraded.
  - Verify: offline profile with network denied; fault injection for every optional
    capability; health/metrics report core and provider separately.
  - Depends on: V6-T09.
  - **Delivered 2026-09-30.** `src/v6-degraded.ts` (266 lines); 26 fixtures in
    `src/test/v6-degraded.test.ts`. Suite 1108 → 1134.
  - **Degradation is a value, not an absence.** A retrieval path returning three thin
    results because the embedding provider is down is indistinguishable from one that
    found three good results. Every degraded result carries `degraded: true`, `ok:
    false`, a classified `failure`, a bounded `reason` naming the capability, and
    **no value** — so a caller cannot mistake a degraded answer for a real one in
    either direction.
  - **Fail-open/fail-closed is declared per capability, not per provider.** Two
    providers for one capability must not get different answers to "what happens if you
    fail", or behaviour would depend on which happened to be registered.
    - `embedding`, `reranking`, `summarization` → **fail open.** Quality-affecting, not
      authority-affecting; a lexical answer is worse than a semantic one but still
      correct, so failing closed would be the more dangerous choice.
    - `extraction` → **fail closed** (`SERVICE_UNAVAILABLE`, 503). It writes structured
      data; a partial extraction is a wrong record, not a thinner one.
  - **Cancellation is never converted into an answer.** An aborted request was not
    attempted; reporting it as degraded would let it look like a completed call with a
    thin result. It gets its own class and its own reason.
  - **The classification gap the mutation found was real.** G3 survived because
    detection relied on `error instanceof DOMException`, so an `AbortError` crossing a
    worker or library boundary — a different realm, so a different prototype — fell
    through to the generic class. Now name, code and message are all checked.
    `V6-DG-023` covers all four arrival shapes.
  - **Nothing partial survives a fault.** A failure clears pending tenant bindings and
    pending decisions whole, and committing a decision requires an evaluation in
    flight, so a retry cannot overwrite a recorded decision or commit one that was
    never made.
  - **Core unavailable ≠ provider degraded.** Three states (`ok`/`degraded`/
    `unavailable`) on two independent axes; `V6-DG-018` proves all four axis
    combinations are distinguishable. Readiness is never claimed while core is down —
    routing traffic to a node that cannot serve it is the worse failure.
  - **15 mutations, 15 caught.** Twelve first pass; G3 and G7 survived (realm-crossing
    AbortError; the per-call policy override was never exercised), and G9 failed to
    compile as written, so it was rewritten to an empty-reason mutation and is now
    caught. `V6-DG-023`–`026` close them.
  - **No health module existed** — `reportOperationalStatus` is new and is the status
    shape, but wiring it to an HTTP `/health` endpoint is not done. `src/service.ts`
    untouched; `docs/self-hosting.md` not yet updated.
  - **CORRECTION 2026-10-04: the `sqlite: history snapshots` Node-22 failure is NOT a
    snapshot-ordering bug, and not a code defect.** I chased it as one and was wrong.
    - Verified history ordering is correct: 12 updates in one millisecond return
      `[v11 … v0]`, newest first, because `ORDER BY created_at DESC` plus the
      history-includes-original semantics are right. No monotonic-column migration is
      needed.
    - The real cause is `ERR_DLOPEN_FAILED`: `better-sqlite3`'s native binary in
      `node_modules` is compiled for **Node 18's ABI**, so on Node 22 *every* SQLite
      test fails — measured 0 pass / 12 fail across 14 of 14 runs. Not flaky, and not
      specific to the snapshot test.
    - This is expected and already handled in CI: every job runs
      `npm rebuild better-sqlite3` for its own Node version. A single `node_modules`
      shared across Node versions cannot serve two ABIs, which is what my local
      invocation did.

- [x] **V6-T11 — Implement expiration and lifecycle orchestration**
  - Acceptance: explicit clock and timezone semantics; expired content excluded by
    default; retention, legal hold, archive, deletion and supersession cannot be
    confused or silently overridden; jobs bounded, idempotent, tenant-aware, and
    rechecking policy.
  - Verify: boundary tests for now/future/past/skew/renewal/malformed; concurrent
    lifecycle and retrieval; failure/restart proving no duplicate deletion or
    resurrection.
  - Depends on: V6-T03, V6-T05, V6-T09.
  - **Delivered 2026-10-04.** `src/v6-lifecycle.ts` (377 lines); 31 fixtures in
    `src/test/v6-lifecycle.test.ts`. Suite 1134 → 1165.
  - **Two real defects found and fixed, both destructive.**
    - **The job never returned its effects.** `runLifecycleJob` counted deletions but
      did not return the updated records, so a restarted job found the same expired
      rows again and deleted them twice — exactly the duplication the idempotence
      criterion forbids. It now returns `updated`, with the overflow and skipped rows
      passed through so a caller persisting the result does not silently drop them.
      Caught by `V6-LC-022`, proven by mutation L5.
    - **`delete` did require expiry, but nothing tested that on a live record.** Every
      existing delete fixture used an *expired* record, so the check was never the thing
      under test. Mutation L4 — removing the expiry check so `delete` removes any record
      at any time — survived the first pass. `V6-LC-028`–`030` now cover a future
      expiry, a never-expiring record, and the exclusive boundary from both directions.
  - **Expiry is an instant in UTC milliseconds; a local timestamp is refused.**
    `parseExpiry` requires an explicit offset or `Z`, because a naive local timestamp
    resolves differently per machine and so expires the same data at different instants
    per deployment. A malformed timestamp is refused rather than coerced — `NaN` becomes
    "expires immediately", `0` becomes "never expires", and both are silent corruption
    of retention intent.
  - **Expiry is exclusive** (`expiresInMs <= 0`): a record whose `expiresAt` equals `now`
    is expired. Anything else makes "expires at T" mean "usable until T", the more
    surprising reading. Skew widens an *announcement* (`expiring`), never the expiry.
  - **The five dispositions are separate by construction.** Supersession does not
    delete, archive does not delete, expiry is not deletion, and each returns a distinct
    `disposition`. Four mutations confirm it (L12–L14, L4).
  - **A legal hold is absolute, and there is deliberately no `force` flag.** An operator
    override is a legitimate need, but it belongs in a separate, audited path; burying
    a bypass in a job parameter is how holds stop meaning anything. `V6-LC-026` proves
    passing one changes nothing.
  - **A deleted record is terminal.** Resurrection is the restart failure mode: a crash
    between the delete and the audit write must not leave it live again. Any later
    action is refused with `already_deleted` (L3).
  - **The job rechecks expiry rather than trusting the record.** A record claiming to be
    expiring is not evidence; a corrupted or forged field must not drive a deletion.
    Replaced the field read with `evaluateExpiration` (L20).
  - **Renewal is bounded and renews from `now`, not from the old expiry** — extending
    from the old expiry lets a long-expired record gain a future date without anyone
    deciding to renew it (L16).
  - **23 mutations: 22 caught, 1 compiler-enforced and also test-covered.** L22 (audit
    entry gaining a `content` field) cannot be added without `tsc` rejecting it — and a
    `as never` cast does not get past excess-property checking either. I verified both
    and restored the source byte-identical. `V6-LC-031` catches it at runtime as well,
    so this one is covered twice. **A build-failed mutation is not coverage**, and the
    one property is asserted structurally instead: audit entry keys are enumerable and
    none is content-shaped.
  - **Reused the existing error vocabulary** — `INVALID_INPUT` and `NOT_FOUND` rather
    than inventing `INVALID_TIMESTAMP`/`RECORD_NOT_FOUND`, which would have given the
    same two situations two codes and left the HTTP layer with no mapping.
  - **Not wired to storage.** `src/sqlite-backend.ts` and `src/service.ts` untouched;
    `docs/lifecycle.md` not yet written; `job-queue.ts` not yet used.

- [ ] **V6-T12 — Add provider capability and privacy metadata**
  - Acceptance: providers declare capability, privacy, cost, latency, retention, and sensitivity transmission rules; policy blocks disallowed transmission before network work.
  - Verify: manifest validation, sensitive-content denial, secret/log redaction.
  - Depends on: V6-T09, V6-T10.

- [ ] **V6-T13 — Add local and remote intelligence adapters**
  - Acceptance: optional local/remote embeddings, classification, summarization, and consolidation adapters are bounded, cancellable, schema-validated, and unable to grant trust/access.
  - Verify: local/fake/remote contract suites, timeout/retry/cancellation/malformed/rate-limit tests, all-provider-disabled core tests.
  - Depends on: V6-T12.

- [ ] **V6-T14 — Add provider-safe jobs, caching, and replay handling**
  - Acceptance: immutable tenant/policy/idempotency job context, no duplicate committed mutations on retry, tenant-partitioned caches, bounded queues/providers.
  - Verify: duplicate delivery, cancellation, worker restart, cache isolation, queue exhaustion, and outage tests.
  - Depends on: V6-T08, V6-T12, V6-T13.

### Checkpoint: Provider independence

- [ ] Core works with no providers.
- [ ] Optional intelligence cannot change authorization/trust/sensitivity.
- [ ] Remote data handling is policy-gated and audited.
- [ ] Retry/failure behavior is deterministic.

## Phase 4: Versioned API domains

- [ ] **V6-T15 — Define V6 API versioning and domain schemas**
  - Acceptance: version strategy, envelopes, errors, pagination, idempotency, bounded domain schemas, and V5 compatibility rules are approved.
  - Verify: contract fixtures, unknown-version tests, V5 client smoke tests.
  - Depends on: V6-T02, V6-T03, V6-T04.

- [ ] **V6-T16 — Implement Memory, Knowledge, and Context APIs**
  - Acceptance: policy-aware CRUD/relations/history/search/context share the V6 service path and preserve bounded/error semantics.
  - Verify: HTTP/SDK end-to-end, cross-tenant/sensitivity/expiration/injection fixtures, V5 route regression.
  - Depends on: V6-T06, V6-T07, V6-T15.

- [ ] **V6-T17 — Implement Tenant, Policy, and Provider APIs**
  - Acceptance: resource selectors are non-authoritative, policy simulation is side-effect-free/redacted, provider config requires host authorization and secret handling.
  - Verify: cross-tenant/privilege/policy/provider-secret contract tests.
  - Depends on: V6-T08, V6-T12, V6-T15.

- [ ] **V6-T18 — Implement Snapshot, Audit, and recovery APIs**
  - Acceptance: signed bounded snapshot operations, tenant-filtered paginated audit, safe recovery progress/failure visibility, explicit V5 snapshot compatibility.
  - Verify: snapshot/audit/recovery contracts, cross-tenant export/audit tests, dry-run/interrupted publication.
  - Depends on: V6-T08, V6-T10, V6-T15.

### Checkpoint: API domains

- [ ] All V6 domains are versioned and documented.
- [ ] V5 routes/clients remain compatible where promised.
- [ ] Every route shares identity/authorization/tenant/policy enforcement.
- [ ] API security and contract review passes.

## Phase 5: V5 migration and reliability

- [ ] **V6-T19 — Build V5 migration analyzer and compatibility report**
  - Acceptance: read-only bounded analyzer detects schema/tenant/policy/sensitivity/expiration/orphan issues and emits machine/human reports.
  - Verify: V5/V6/mixed golden reports, no-write assertions, large-corpus analyzer benchmark.
  - Depends on: V6-T03, V6-T15.

- [ ] **V6-T20 — Implement migration dry-run and durable execution**
  - Acceptance: complete no-publish dry-run, signed plan, bounded idempotent batches, checkpoints, failure records, verified resume.
  - Verify: interruption/retry/partial failure/resume/corrupt-state/permission fixtures.
  - Depends on: V6-T19, V6-T06, V6-T08.

- [ ] **V6-T21 — Implement verification, publication, and rollback**
  - Acceptance: count/checksum/policy/reference/lifecycle/retrieval verification, explicit atomic publication, tested rollback, untouched V5 source until publish.
  - Verify: success/failure/rollback/disaster/old-reader/new-reader fixtures.
  - Depends on: V6-T20.

- [ ] **V6-T22 — Add crash, corruption, replay, and disaster-recovery fixtures**
  - Acceptance: interrupted writes/lifecycle/publication/migration recover without duplicate/resurrected data; corruption and replay fail safely; backend rollback evidence retained.
  - Verify: repeated fault-injection matrix, recovery timing/resource evidence, supported Node versions.
  - Depends on: V6-T10, V6-T14, V6-T20, V6-T21.

### Checkpoint: Migration and recovery

- [ ] Analyze/dry-run/migrate/verify/publish/rollback flow is green.
- [ ] Mixed/unknown data is never served silently.
- [ ] Disaster fixtures pass repeatedly.
- [ ] Operator runbook reviewed.

## Phase 6: Observability and scale

- [ ] **V6-T23 — Add policy-aware observability and diagnostics**
  - Acceptance: bounded metrics/traces/audit/health distinguish policy, expiration, sensitivity, replay, migration, recovery, and provider outcomes without content/secrets.
  - Verify: redaction, cardinality, request-to-decision tracing, and operator dashboard/runbook tests.
  - Depends on: V6-T08, V6-T10, V6-T18.

- [ ] **V6-T24 — Build 10K/100K/1M/10M+ benchmark profiles**
  - Acceptance: fixed datasets/seeds report backend/hardware/policy/p50/p95/memory/candidates/tokens/failures for all supported scale points.
  - Verify: repeated scale/offline/tenant runs and documented correctness/latency/memory thresholds.
  - Depends on: V6-T07, V6-T10, V6-T22.

- [ ] **V6-T25 — Run V5 compatibility and security release matrix**
  - Acceptance: V5 APIs/clients/snapshots/Markdown/MCP/SDK, tenant/policy security, recovery, Node support, build, audit, package, and install checks pass.
  - Verify: full/security/recovery suites, release gate, published-package smoke test, maintainer sign-off.
  - Depends on: V6-T16, V6-T17, V6-T18, V6-T22, V6-T23, V6-T24.

### Checkpoint: V6 release candidate

- [ ] All capability modules have evidence artifacts.
- [ ] No critical/high security finding remains.
- [ ] Performance and compatibility thresholds pass.
- [ ] Documentation/version/changelog are current.
- [ ] Maintainers approve release candidate.

## Phase 7: V6.0.0 release

- [ ] **V6-T26 — Prepare and publish V6.0.0**
  - Acceptance: version/schema/API/package metadata synchronized; commit/tag/GitHub Release/npm point to one commit; published package installs and post-release audit passes.
  - Verify: `npm run release:check -- --expect-version 6.0.0`, tag/release/npm checks, installed-package smoke test, post-release audit.
  - Depends on: V6-T25.

### Checkpoint: V6.0.0 complete

- [ ] Release evidence manifest published.
- [ ] V5 compatibility window and migration runbook active.
- [ ] V6 support ownership and security response process recorded.
- [ ] Post-release audit complete.

## Definition of done for the planning phase

Audited 2026-09-30. Four of the six are mechanically checkable and are now
verified; two are maintainer acts.

- [ ] Capability map and dependency order approved. *(Maintainer act. The map is
  in `v6-plan.md`; the task list's dependency order was machine-checked rather
  than eyeballed — 26 tasks, 0 forward references, 0 unknown dependencies, 0 cycles,
  and a single root (T01), so the graph is executable as written. The approval
  itself is not taken.)*
- [x] Every task has acceptance, verification, dependencies, scope, and size.
  Verified: all 26 tasks carry Acceptance/Verify/Depends on in `v6-todo.md` and
  Estimated scope in `v6-plan.md` (12×L, 10×M, and 4 with split guidance). The two
  files deliberately split these — the ledger carries the contract, the plan
  carries the estimate — so "present somewhere" is the criterion, not "present in
  one file". An audit run against `v6-todo.md` alone reports all 26 as missing
  scope and size, which is a false reading.
- [x] Open policy/schema/API/migration questions have owners and safe defaults.
  All ten of the architecture spec's §15 questions are answered and **approved** in
  [`docs/v6-decisions.md`](../docs/v6-decisions.md). Five were forks requiring a
  maintainer call and all five are settled, each carrying its date and reasoning.
  The two deferred items have their safe default named and their owning phase
  identified: Q7 (local index) is owned by the storage layer, Q8 (distributed
  consistency) is explicitly out of scope for single-node V6.0.0.
- [x] V5 compatibility/security/performance evidence is identified.
  `v5-tenant-spec.md`, `v5-threat-model.md`, `v5-release-gates.md`,
  `v5-performance.md`, `v5-policy.md` all exist and are linked from the spec.
- [x] Release gates are executable and fail closed.
  `scripts/release-gate.mjs` wires 8 stages (build, benchmark gate, security,
  recovery, python, docs, tenant benchmark, scale benchmark) and exits non-zero on
  a stage's non-zero status. Verified by reading the script; note the standing
  caveat that nothing in CI invokes it (see the V5.7 T08 checkpoint).
- [ ] Maintainer review approves the plan before implementation.
