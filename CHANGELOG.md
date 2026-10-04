# Changelog

All notable changes to Remembra will be documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/).

> **Versioning:** from 3.0.0 on, package versions match roadmap milestones
> (3.0.0 = v3, 4.0.0 = v4). Earlier releases used independent semver:
> 0.1.0 = v1, 0.2.0 = v1.5, 0.3.0 = v2, 0.4.0 = v3.

## [Unreleased]

### Added

- **V6 policy model and evaluator (V6-T02), the first V6 code.** `src/v6-policy.ts`
  implements the ten decisions frozen and approved in
  [`docs/v6-decisions.md`](docs/v6-decisions.md): a closed sensitivity order, four
  independent policy axes, a fixed six-layer precedence, and a bounded decision
  result with a closed effect/reason vocabulary. Contract in
  [`docs/v6-policy.md`](docs/v6-policy.md).

  Nothing calls it yet. The evaluator defines the decision; wiring it into the
  request path is V6-T04 through V6-T07, the cross-axis evaluator is V6-T05, and
  audit emission is V6-T08. No V5 route, schema, or default changes — the module
  is additive and unreferenced, so the V5 surface is untouched.

  Fail-closed is the property under test rather than a stated intent: 19
  mutations, all caught. Three survived the first pass and were gaps in the tests,
  not defects in the evaluator — nothing pinned that an absent clearance is
  fail-closed rather than unrestricted, nothing pinned that a missing capability
  denies, and a determinism test that asserted two evaluations agreed, which a
  wall clock also satisfies.

  One deviation from the architecture spec, recorded rather than silently applied:
  spec §4.2 proposed a `restricted` band, and the approved decision replaces it
  with `secret`. `restricted` read as a mode rather than a level, so restricted
  *handling* is now the `quarantine` effect — somewhere a decision can act on it.
  V6 stores are new, so no V5 record carries the old spelling and nothing
  migrates.

- **V6 memory metadata and schema contract (V6-T03).** `src/v6-schema.ts` defines
  the persisted V6 record: the eleven V5 memory types unchanged, four independent
  policy axes, tenant binding required, bounded content, and lifecycle markers that
  are *distinct flags* rather than an enum — expired, archived, superseded and
  deleted can all be true of one record at once, and `lifecycleStateOf` derives the
  single reported state with an explicit precedence where `deleted` is terminal.

  **A real security gap, found by mutation and invisible to the compiler.** The
  tenant field validated against V5's `TENANT_ID_RE` alone, which bounds character
  set and length but accepts `"."` and `".."` — V5's `isValidTenantId` adds the
  traversal check on top. A V6 record could therefore carry `organizationId: "."`,
  a path segment rather than a tenant. The type is still `string`, so no compiler
  could have flagged it. The field now uses the predicate.

  Downgrade refuses rather than drops: a `confidential` or `secret` record has no V5
  representation, and a projection that discarded the label would write it into a
  store whose readers have no idea it is sensitive. A V5 record is never classified
  as `migrated` — that is a claim about provenance only the migration tool may make.

  Additive and unreferenced, like V6-T02: no V5 route, schema or default changes,
  and nothing imports the module yet.

### Added

- **V6 request context: identity, operation, policy version, deadline and replay
  identity (V6-T04).** `src/v6-request-context.ts` is the first stage of the V6
  request pipeline, and the one everything downstream reads its inputs from. A
  context can only be minted by trusted host code: a private symbol brands it, the
  context and its principal are frozen, and unknown fields are refused rather than
  stripped, so an injected `isAdmin` cannot ride along unnoticed. The minting input
  has no `role` and no tenant claim at all — a field that could grant authority is
  absent rather than validated.

  Replay identity is scoped to tenant plus operation class and deliberately excludes
  the principal: the scope partitions *records*, so the two collisions that would
  produce a wrong replayed response — a different operation, a different tenant —
  cannot happen. Mutating operations require a caller-supplied key; a key shaped
  like a credential is refused, because a payload-derived key would dedupe two
  genuinely different requests that hash alike.

  Reuses V5's `TENANT_REQUIRED` (already 403, already meaning "a trusted context is
  required") rather than adding a V6-only code to an error surface callers switch on.
  19 mutations, all caught. Additive and unreferenced, like T02 and T03.

- **V6 policy evaluator (V6-T05).** `src/v6-policy-evaluator.ts` composes every
  policy axis into one decision: side-effect free, with the clock injected rather
  than read, so the same input always yields the same decision and an audit event
  can be replayed and still make sense. Explicit deny wins; missing or conflicting
  policy fails closed; expiry is evaluated before trust so a stale memory reports
  `expired` rather than being misattributed to trust; provider egress is evaluated
  before sensitivity so a low-clearance caller learns a third party was involved.
  The result carries only an effect, a reason and a policy version — `.strict()`,
  so a decision that somehow acquired content fails validation instead of being
  written to an audit event.

  20 mutations, 19 caught; the twentieth is an equivalent mutant (removing the
  early return for an explicit deny layer is indistinguishable from the final
  narrowing step, verified by measurement). Additive and unreferenced, like T02–T04.

- **V6 direct-operation policy enforcement (V6-T06).** `src/v6-service-policy.ts` is
  the single choke point every direct memory operation passes through, composing the
  T04 identity check with the T05 decision before storage. The acceptance criterion
  is a *negative* claim — no path bypasses — so it is checked structurally: the set of
  direct operations is declared once, and a test asserts that no public method exists
  outside it, which makes an unguarded method a test failure rather than a review
  question.

  Two existence leaks were found by the tests and fixed. An absent record returned a
  synthetic row on the paths that do not normalize to `NOT_FOUND`, so a batch
  containing a missing id reported that item as a success; and per-item batch failures
  forwarded the underlying error code, so a caller could distinguish "foreign" from
  "absent" and enumerate ids. Multi-record operations now report one code and reason
  for every refusal, with the policy reason going to the audit event where it is safe.

  10 mutations, 9 caught; the tenth is an equivalent mutant (the explicit brand check
  duplicates one `assertFreshContext` performs internally, verified by measurement).
  V5 behaviour is untouched — nothing in `service.ts`, `store.ts` or `backend.ts` is
  modified, and the V6 guard is not yet wired into any request path.

- **V6 retrieval policy boundary (V6-T07).** `src/v6-retrieval-policy.ts` applies
  tenant, sensitivity, expiration and hold predicates *before* candidate generation,
  ranking and counts. The criterion is ordering, and it is asserted against emitted SQL
  rather than behaviour: a `LIMIT 10` over unfiltered rows returns ten foreign
  memories and filters them to zero, which is both a wrong answer and a leak where the
  count is observable — and a behavioural test passes just as happily with a
  LIMIT-first query whenever the tenant owns enough rows to fill it. All eight
  retrieval paths carry one identical predicate fragment, asserted as a set cardinality
  of one so a separately-written path fails.

  14 mutations, 14 caught. Five survived the first pass and all shared a shape: the
  clause was *present* in every assertion, so inverting it, dropping the `OR` half of
  the expiration test, or removing the limit outright changed nothing the tests looked
  at. Asserting a guard exists is not asserting what it does.

  One real bug against the approved decision: a read excluded legally-held memories,
  but a hold blocks destruction rather than visibility, and hiding held records from
  an operator defeats the point of holding them. Held memories are excluded from
  candidates and remain readable by id.

  Not wired to a backend — `sqlite-backend.ts`, `store.ts`, `retrieval.ts` and
  `context.ts` are untouched. The module specifies the boundary for both the SQL and
  the file-namespace paths; adopting it in the real query builders is a later step and
  is not claimed.

- **V6 policy decision audit and redaction (V6-T08).** `src/v6-audit.ts` logs every
  decision with tenant, actor, operation, policy version, effect and reason, and
  nothing else. V5's `memory_audit` table is keyed by `memory_id`, so a decision log
  built the same way leaks existence — "access denied to `secret-key-42`" is a
  disclosure in a log a lower-privilege reader may see. This log is keyed by decision,
  with no resource identifier at all: it records the *class* of resource, never which
  resource. The schema is `.strict()`, so an added content field fails validation
  instead of being silently accepted into a log.

  Correlation ids get a credential-shape denylist, not just a length ceiling: 23
  characters of a real key fit comfortably, and `sk-abc123def456ghi789jkl` is a legal
  handle by charset. Retention reports `dropped` alongside `events`, because a
  silently truncating audit log is worse than a short one — a reader trusts it.

  14 mutations, 14 caught. Four survived the first pass, and the most serious was a
  genuine cross-tenant hole: the mandatory organization filter on an audit query could
  be deleted with no test failing, because every query passed an organizationId.
  Without it an unqualified query returns every tenant's decisions — the audit surface
  leaking more than the data plane does.

  In-process ring buffer; durable storage is a later task and is not claimed.

- **V6 provider-neutral core capability contracts (V6-T09).** `src/v6-core-contract.ts`
  separates durable core operations from optional intelligence capabilities. Provider
  absence is a supported runtime state, not a startup error: durable memory keeps
  working, degrading to lexical retrieval, because the premise of this package is
  offline-first.

  The boundary is a **projection, not a pass-through** — only the fields declared for a
  capability cross it. A provider returning fourteen fields of plausible authority
  state (`effect: "allow"`, a foreign principal, `tenant:admin`, a policy version, a
  token) crosses with one, which is what stops a remote service escalating by
  returning a richer object than the contract allows.

  Core is never delegable: a provider claiming `storage` is refused at *registration*,
  so no state exists in which the durable substrate looks remote. Provider metadata
  requires all four axes (privacy, cost, latency, availability) and bounds them, since
  an absent axis is a constraint nobody chose and an unbounded latency claim is not a
  latency claim.

  13 mutations: 9 caught, 2 survived (both now covered), and 2 that **failed to
  compile** — `tsc` refuses to let the projection guard be removed, which is a
  structural guarantee rather than a gap. A build-failed mutation is not coverage, and
  is reported as unmeasured rather than counted.

  `src/service.ts` is untouched; wiring the contracts to the service layer is a later
  step.

- **V6 offline and degraded operation modes (V6-T10).** `src/v6-degraded.ts` makes
  degradation a **value rather than an absence**. A retrieval path returning three
  thin results because the embedding provider is down is indistinguishable from one
  that found three good results; every degraded result now carries `degraded: true`,
  a classified failure, a bounded reason naming the capability, and **no value** — so
  the two cannot be confused in either direction.

  Fail-open/fail-closed is declared **per capability, not per provider**, so behaviour
  cannot depend on which provider happened to be registered. `embedding`, `reranking`
  and `summarization` fail open: quality-affecting, not authority-affecting, and a
  lexical answer is worse than a semantic one but still correct. `extraction` fails
  closed (503) because it writes structured data — a partial extraction is a wrong
  record, not a thinner one.

  Cancellation is never converted into an answer: an aborted request was not
  attempted, and reporting it as degraded would let it look like a completed call. The
  mutation run found this was genuinely broken — detection relied on `instanceof
  DOMException`, so an `AbortError` crossing a worker or library boundary fell through
  to the generic class.

  A provider fault clears pending tenant bindings and policy decisions whole, and a
  decision cannot be committed without an evaluation in flight. Operational status
  reports core and providers on two independent axes across three states
  (`ok`/`degraded`/`unavailable`), and readiness is never claimed while core is down.

  15 mutations, 15 caught. `src/service.ts` and the HTTP health endpoint are not yet
  wired, and `docs/self-hosting.md` is not yet updated.

- **V6 expiration and lifecycle orchestration (V6-T11).** `src/v6-lifecycle.ts` keeps
  retention, legal hold, archive, deletion and supersession separate by construction.
  These five all sound like "the memory is gone", and the failure mode is not a wrong
  answer but a *destructive* wrong one — deleting under a retention policy when a legal
  hold applied is unrecoverable, and no test inspecting a return value catches it.

  **Two real defects fixed.** The lifecycle job counted deletions without returning the
  updated records, so a restarted job deleted the same rows twice — precisely the
  duplication the idempotence criterion forbids; it now returns `updated`, passing the
  overflow and skipped rows through so a caller persisting the result cannot silently
  drop them. And `delete` did require expiry, but no test exercised it on a *live*
  record, so the check was never the thing under test.

  Expiry is an instant in UTC milliseconds and a local timestamp is **refused**: a naive
  local timestamp resolves differently per machine, expiring the same data at different
  instants per deployment. A malformed timestamp is refused rather than coerced, since
  `NaN` becomes "expires immediately" and `0` becomes "never expires". Expiry is
  exclusive at the boundary, and clock skew widens an announcement, never the expiry.

  A legal hold is absolute and there is deliberately **no `force` flag** — an operator
  override belongs in a separate, audited path, not buried in a job parameter. A deleted
  record is terminal, so no restart can resurrect it. The job rechecks expiry rather
  than trusting the record's own fields.

  23 mutations: 22 caught. One could not be introduced at all — an audit entry cannot
  gain a `content` field without `tsc` rejecting it, and a cast does not get past
  excess-property checking either — so that property is additionally asserted
  structurally at runtime.

### Fixed

- **Provider health axis, and the failure mode it deliberately does not have.**
  `src/health-status.ts` reports provider privacy, availability, capabilities and
  degradation alongside core readiness. `/health` stays a **two-state** contract
  (`ok` | `unready`): a degraded provider does **not** withdraw readiness, because core
  is still serving from local storage and returning 503 would remove a healthy node from
  load-balancer rotation — a worse failure than the one it reports. With no provider
  configured the payload is unchanged, so an exact-match watcher keeps working. The
  payload never carries the provider's API key or base URL, since it is typically
  unauthenticated. 10 mutations, 10 caught; two survivors in the first pass were the
  same mistake — asserting `status` while the mutation moved `ready`, and defaulting
  privacy to the reassuring `local` instead of `unknown`.

- **Corrected an earlier diagnosis of the Node 22 `sqlite: history snapshots` failure:
  it was never a snapshot-ordering bug.** History ordering is correct — 12 updates in a
  single millisecond return newest-first — so no monotonic-column migration is needed.
  The real cause is `ERR_DLOPEN_FAILED`: `better-sqlite3`'s native binary is compiled
  for Node 18's ABI (`compiled against NODE_MODULE_VERSION 108 … requires 137`), so
  *every* SQLite test fails on another runtime, not just the snapshot one. Measured over
  14 consecutive runs each: Node 18.20.8 12/12 pass, Node 22.23.3 0/12, Node 24.21.0
  0/12. Not flaky on any version, and already handled in CI by rebuilding the native
  module per job.

  Worth recording as a measurement lesson: an early Node-24 probe reported *zero*
  failures, because the run aborts at module load and prints no `not ok` lines, so
  `grep -c '^not ok'` returns zero. A grep count of zero is not a pass count.

- **SQLite had no busy timeout, and the two halves of one store used different
  policies.** `SqliteBackend` never set `busy_timeout`, so it ran on SQLite's
  default of 0 — which means "fail immediately", not "try again" — while
  `FileBatchIdempotencyStore` already waited 5000ms. In WAL mode a reader and a
  writer are the normal shape for two processes on one store, so ordinary
  concurrency could surface as `database is locked`.

  The timeout also has to be set **before** `journal_mode = WAL`, because the WAL
  pragma takes a brief exclusive lock — which is exactly what returns
  `SQLITE_BUSY`. The batch store had the same ordering, so both are corrected: a
  timeout set after the WAL pragma leaves the statement most likely to hit
  contention unprotected.

  Found by the first CI run: `MATRIX-03 concurrent migration` failed with
  `Command failed: ... matrix-peer.js migration-gate ... database is locked`, i.e.
  the peer process died instead of returning a decision. MATRIX-03 is one of the
  two §30 matrix rows documented as load-dependent; it had been failing roughly
  once in three suite runs and is now clean across repeated concurrent runs.

  A note on what was *not* concluded: at eight concurrent matrix runs a different
  failure appears — `shared_state.unreachable` under disk pressure from the load
  itself. That is a property of over-subscribing one machine, not of this change,
  and it is recorded rather than fixed, because "make it pass at any concurrency"
  is not the same as "not fail under normal load".

- **The published-artifact CI job packed an empty tarball.** `dist/` is gitignored
  and untracked, so a fresh checkout has no `dist/` at all and `npm pack` produced
  a package containing only `package.json`. Every subpath check then failed with
  `Cannot find module .../dist/index.js`, which reads like a packaging bug in the
  library rather than a missing build. The job now builds first.

- **Two mutation runs that overlapped on the same source file were discarded and
  re-run.** Both were left running concurrently, so a mutation reported as caught
  in the second run may have been caught by the first run's mutant still on disk.
  The serial re-run found two mutations the overlapping run had reported as
  caught. Both runs also now verify their anchors before mutating anything and
  prove the source is byte-identical to its snapshot after every revert.

## [5.7.1] — 2026-09-30

Three fixes, all found by installing 5.7.0 from the registry and using it rather than
by anything in the suite. Full compatibility statement: `docs/v5.7.0-compatibility.md`.
Findings and measurements: `docs/v5.7.0-audit.md`.

### Fixed

- **Roadmap §37's budget is reachable through the typed SDK.** `SearchInput` — which
  the SDK's `SearchOptions` is an alias of — never gained `budget`, so a typed caller
  could not set one. Adding it exposed a second half: the SDK serialises query
  parameters with `String(value)`, so a nested object became the literal string
  `"[object Object]"` and the server ignored it. The SDK accepted the argument, the type
  allowed it, and the bound was never applied. Nested parameters are now flattened as
  `parent.child`, which is how the search route already read them. The response side had
  the same gap in reverse: the server has returned `budget` since §37 shipped and
  `SearchResponse` did not declare it, so a typed caller could not learn which bound
  applied — the entire point of the report.

- **Non-ASCII queries now reach the lexical path.** `extractQuery` filtered query terms
  with `/^[a-z0-9]+$/u`, so every non-ASCII query produced **zero** terms, no keyword
  list was built, and retrieval fell back to the vector path alone — which is nothing
  at all when no embedding provider is configured. A CJK, Russian, Greek, Hangul or Thai
  query returned an empty result set with no error and no warning, and a query returning
  nothing is indistinguishable from a query with no match.

  The two halves of retrieval now share one tokeniser, so they cannot drift apart again
  — which is how the CJK branch in `tokenize` came to be unreachable: the document side
  segmented, the query side refused, and no test compared them. Scripts that segment per
  character (Han, hiragana, katakana) yield per-character terms; scripts that tokenise as
  words (Hangul, Thai, Greek, Cyrillic) yield whole words, which is what the document
  side already did.

  One ASCII behaviour changes, deliberately pinned by a test: a query containing internal
  punctuation now contributes its alphanumeric parts, where before the whole
  whitespace-delimited run had to be alphanumeric. So `don't` contributes `don` and
  matches a document containing `don't` — which it previously could not. This is the
  tokeniser becoming consistent with the document side rather than a new rule.

- **`latest N <query>` now parses.** `TEMPORAL_RE` anchored its alternation with `$`, so
  each branch had to consume the entire query: `latest(?:\s+(\d+))` matched `"latest 3"`,
  left the body unconsumed, the anchor failed, and the qualifier was tokenised as an
  ordinary word. `latest 3 errors` therefore ran as a plain keyword search for the words
  *latest* and *errors*. Both branches now carry a trailing remainder, and the digit
  count stays required so `"latest news about the deployment"` is still an ordinary query
  rather than a qualifier that swallows the rest of the sentence.

  **This restores parsing, not meaning**, and the difference is worth stating plainly.
  The qualifier's values are read in exactly one place — `modifierScore`, where they
  switch the recency multiplier from `0.5` to `2`. So `latestCount` still does not limit
  to the N most recent, and `before` / `after` still filter nothing. Measured, with four
  documents of decreasing age and all four matching:

  ```
  search(pool, "incident review")   -> d1, d2, d3, d4
  search(pool, "latest 2")          -> d1, d2, d3, d4
  search(pool, "before 2026-08-01") -> d1, d2, d3, d4
  ```

  Making them count and filter is new behaviour rather than a bug fix: it changes the
  result set for every temporal query, and needs a decision about what "the 3 most recent"
  means when ties, archiving and `validUntil` are in play. Recorded in full as audit S8.

### Known limitations

- The temporal qualifier parses but does almost nothing beyond the recency multiplier.
  See audit S8.
- The benchmark set contains no temporal query and no non-ASCII document, so the gate
  cannot see either of the two fixes above. The unit tests are what cover them; both are
  gaps in the gate, recorded rather than papered over.


### Fixed

- **Roadmap §37's budget is reachable through the typed SDK.** Published in 5.7.0 and
  then installed from the registry, which is where this surfaced: `SearchInput` —
  which the SDK's `SearchOptions` is an alias of — never gained `budget`, so a typed
  caller could not set one. Adding it exposed a second half: the SDK serialises query
  parameters with `String(value)`, so a nested object became the literal string
  `"[object Object]"` and the server ignored it. Nested parameters are now flattened
  as `parent.child`, which is how the search route already read them.

  The response side had the same problem in reverse: the server has returned `budget`
  since §37 shipped, but `SearchResponse` did not declare it. A typed caller could
  set a bound and still not learn which one applied, which is the entire point of the
  report.

  All of it escaped the suite because no test compared `SearchInput` with
  `SearchQuery`, or `SearchResponse` with what the server actually returns —
  hand-maintained descriptions of the same thing at two different layers, with nothing
  comparing them.

- **Non-ASCII queries now reach the lexical path.** `extractQuery` filtered query
  terms with `/^[a-z0-9]+$/u`, so every non-ASCII query produced **zero** terms, no
  keyword list was built, and retrieval fell back to the vector path alone — which is
  nothing at all when no embedding provider is configured. A CJK, Russian, Greek,
  Hangul or Thai query returned an empty result set with no error and no warning, and
  a query returning nothing is indistinguishable from a query with no match.

  The two halves of retrieval now share one tokeniser, so they cannot drift apart
  again — which is how the CJK branch in `tokenize` came to be unreachable: the
  document side segmented, the query side refused, and no test compared them. Scripts
  that segment per character (Han, hiragana, katakana) yield per-character terms;
  scripts that tokenise as words (Hangul, Thai, Greek, Cyrillic) yield whole words,
  which is what the document side already did.

  One ASCII behaviour changes, deliberately pinned by a test: a query containing
  internal punctuation now contributes its alphanumeric parts, where before the whole
  whitespace-delimited run had to be alphanumeric. So `don't` contributes `don` and
  matches a document containing `don't` — which it previously could not. This is the
  tokeniser being consistent with the document side rather than a new rule.

- **Two cold-start races in the batch idempotency ledger**, both found by deliberately
  cold-starting a store from many concurrent processes against one fresh claim
  directory — a reproduction built because the original symptom surfaced as a single
  MATRIX-02 failure that passed on every rerun, which is the hardest shape of defect to
  catch.

  - A peer's integrity-key **staging file** made the next start fail with "claim
    directory contains unrelated files". `link()` needs its source to exist, so
    publishing the key necessarily has a window in which a
    `.claims.key.<pid>.<hex>.tmp` file is visible in the claim directory, and the
    constructor's allowlist rejected that name. The only tolerated unexpected name is
    now a staging file this code creates, and the constructor waits for its publisher
    to remove it — the bounded-poll-then-fail-closed shape the ledger already uses.
    Anything else is still refused immediately, and a staging file that outlives its
    publisher is still refused, with a message that says why it waited.
  - The **ledger identity** was published with `open(O_EXCL)` followed by a write, so
    the file existed *empty* before it was filled. A peer reading in between saw an
    empty string, failed the 64-hex check, and refused to start with "ledger identity is
    invalid". This is the same defect as the zero-byte integrity key fixed in 5.6.0,
    and it survived there because that fix was applied to `claims.key` and not to
    `claims.identity`. It is now published with `link()` too, so a peer sees either no
    file or the complete one.

  Measured over 60 rounds of 16 concurrent processes cold-starting against a fresh
  claim directory:

  | | before | after |
  |---|---|---|
  | claim directory contains unrelated files | routine, hundreds of failures | 0 |
  | ledger identity is invalid | ~1 in 300 | 0 |

  Two rarer symptoms in the same family remain and are **not** fixed, because they are
  in code this change does not touch and because a per-symptom wait is what produced
  five manifestations in the first place: "ledger database exists without its identity"
  and "batch idempotency database could not be opened" (SQLite contention under heavy
  concurrency). Roughly 3 occurrences across ~250,000 cold starts. The 5.6.0 note on
  this store prescribes the actual fix — a single atomic initialisation rather than
  another patch — and this release should not pretend six patches reach it.

- **`latest N <query>` now parses** (audit S8, found while writing the tests for the
  above). `TEMPORAL_RE` anchored its alternation with `$`, so each branch had to
  consume the entire query: `latest(?:\s+(\d+))` matched `"latest 3"`, left the body
  unconsumed, the anchor failed, and the qualifier was tokenised as an ordinary word.
  `latest 3 errors` therefore ran as a plain keyword search for the words *latest* and
  *errors*. Both branches now carry a trailing remainder, and the digit count stays
  required so `"latest news about the deployment"` is still an ordinary query rather
  than a qualifier that swallows the rest of the sentence.

  **This restores parsing, not meaning.** The qualifier's values are read in exactly
  one place — `modifierScore`, where they switch the recency multiplier from `0.5` to
  `2`. So `latestCount` still does not limit to the N most recent, and `before` /
  `after` still filter nothing. Measured, with four documents of decreasing age and
  all four matching:

  ```
  search(pool, "incident review")   -> d1, d2, d3, d4
  search(pool, "latest 2")          -> d1, d2, d3, d4
  search(pool, "before 2026-08-01") -> d1, d2, d3, d4
  ```

  Making them count and filter is new behaviour rather than a bug fix — it changes the
  result set for every temporal query, and needs a decision about ties, archiving and
  `validUntil`. Recorded in full in `docs/v5.7.0-audit.md` (S8). That comparison is now a compile-time assertion, so a drift fails
  the build. It needed three attempts to get right, and each wrong version failed
  silently or reported the wrong field: the first only named a type alias, the second
  reported on `type` and `scope` because `Record` makes keys required where the shape
  makes them optional, and the third built its source from the very keys it was
  checking, so removing `budget` produced no error at all. It is now expressed as "the
  missing set is empty", which cannot be satisfied by the thing it checks.

## [5.7.0] — 2026-09-30

Roadmap §31–§38, the Advanced Retrieval Engine milestone. The intent of every
roadmap item is delivered; see [V5.7.0 compatibility report](docs/v5.7.0-compatibility.md)
for the two default-on behaviour changes and the known limitations, and
[the benchmark gate](docs/benchmark-gate.md) for the new guardrail.

### Added

- **Configurable fusion weights** (`retrieval.fusionWeights`, or
  `REMEMBRA_RETRIEVAL_FUSION_WEIGHTS=keyword=2,semantic=0.5`). The lexical,
  semantic, metadata, recency and confidence weights were hardcoded, so a
  deployment could not express "this corpus is keyword-shaped" or "recency does
  not matter here". Every default reproduces the previous behaviour exactly, so an
  unconfigured deployment is unchanged — a weight whose default was wrong would be
  a silent behaviour change shipped as a feature. A weight of `0` is legal and is
  the point of the knob. An unknown weight name is rejected rather than ignored, so
  a typo cannot leave a deployment running on defaults it did not ask for.

- **The retrieval benchmark gate is now a release stage** (`npm run bench:gate`).
  §38 asks that every retrieval-engine change be measured against a benchmark set;
  that was a rule people followed by intention, which is to say a rule people could
  forget. A labelled 23-scenario set now runs through the real retrieval pipeline
  and is compared against a committed baseline, failing on a regression in
  precision, recall, MRR, nDCG, duplicate rate, or a latency percentile. Each
  scenario names the regression it guards. Latency is checked only when the
  benchmark runs alone, because the suite runs files in parallel and a wall-clock
  number measured there describes scheduling rather than retrieval.

### Fixed

- **Roadmap §37's budget was unreachable and its report was discarded.** `SearchQuery`
  gained `budget` in this milestone and `searchQ` honoured it, but `MemoryService.search`
  — the entry point most callers actually use — did not *accept* a budget in its
  signature and did not *return* the report: it destructured only `results` and
  `explanations`. The budget was computed and then dropped, so no caller on any
  surface could set a bound or learn which one bound. Both are fixed, the budget is
  also settable over HTTP as `?budget.maxItems=` and friends, and a malformed bound
  is rejected with a 400 rather than silently ignored — a dropped budget reads as "no
  budget was set", which is the one state an operator never intends. T06's tests
  called `searchQ` directly, which is why the gap survived the task that introduced
  the feature.

- **The relation-expansion re-rank no longer builds its search policy separately**
  from the first search, so a configured fusion weight can no longer apply to one
  ranking and silently not the other — a reordering confined to the paths that
  happen to use relations. Both call sites now share one policy object.

### Known limitations

- **Non-ASCII queries return no lexical results.** `extractQuery` filters query
  terms with `/^[a-z0-9]+$/u`, so a query in any non-ASCII script produces zero
  terms and retrieval falls back to the vector path alone — nothing at all when no
  embedding provider is configured. The CJK branch in `tokenize` is therefore
  unreachable from the query path: it looks like support and is not. Documents in
  those scripts are stored and tokenised correctly; it is querying that is
  affected. Not fixed in this release because the one-line change alters what
  existing deployments get back for non-ASCII input. Reproduction and the full
  analysis are in `docs/v5.7.0-audit.md` (S7). The benchmark gate deliberately has
  no CJK scenario: a stage that fails on correct code is not a gate.


### Added

- **One retrieval budget object** covering all four roadmap §37 dimensions,
  settable through `MemoryService.search` and over HTTP.
  `maxBytes` and `maxLatencyMs` did not exist anywhere in the tree; `maxTokens` and
  `maxItems` existed as unrelated parameters, so a caller could satisfy two bounds
  and violate the third without noticing. The budget is optional, and when supplied
  the response carries a report saying which bound was binding. Exceeding
  `maxLatencyMs` returns the best results found so far rather than an error — the
  bound exists so retrieval degrades under load, and degrading into *no* answer is
  the opposite — and a budget never starves a query of every result, so
  `maxBytes: 1` yields one result rather than none. A malformed budget is rejected
  rather than silently repaired.

- **Superseded memories are excluded from search results by default.** A query for
  the current policy no longer returns v1 and v2 side by side, which the V5.7.0
  audit reproduced. `includeSuperseded` brings the older version back, because "what
  did this used to say?" is a real question. Suppression only applies when the
  superseding memory is actually available — a dangling reference keeps the old copy
  visible rather than replacing it with nothing — and chains resolve to the newest
  link. Nothing is deleted; the store still holds every version and each is readable
  by id.

- **Fixed a third cold-start race in the batch idempotency ledger.** The integrity
  key was created with `O_EXCL` and *then* written, so a process that lost the race
  read a zero-byte file and refused to start with "integrity key has an invalid
  length". The key is now published with `link()`, which is atomic and never exposes
  a partial file. The check that refuses a genuinely truncated key is unchanged. This
  store has now produced three separate manifestations of the same underlying
  problem — file mode, ledger generation metadata, and this.

- **Exact and same-source duplicate suppression in search results**
  (`src/retrieval.ts`), on by default. A repeated memory previously occupied
  several slots in a result set — and the audit found the only existing pass,
  `mmrDedup`, is a diversity *reordering* that classifies nothing, returning its
  input unchanged in the default `REMEMBRA_EMBEDDINGS=none` configuration. Detection
  now uses the same normalisation as the duplicate-rate metric and needs no
  embeddings. `dedupeExact` and `dedupeSameSource` escape hatches are exposed on HTTP
  search and the MCP `search` tool. Same-source collapsing is **off** by default:
  identical text from two different sources is often corroboration, and discarding
  the second source is a worse error than showing a repeat. Nothing is deleted —
  suppression affects a result set, and the store still holds every copy.

- **The tenant benchmark no longer fails the release gate nondeterministically.**
  `scripts/bench-tenant.sh` now retries the known native SQLite teardown abort
  (`RemoveEnvironmentCleanupHook`), which `scripts/run-tests.mjs` has retried for
  the test suite for some time. The abort happens after the measurement is written,
  so the gate was failing on completed work. A genuine failure still fails on the
  first attempt with its real exit code.

- **Real inverse document frequency in lexical scoring** (`src/retrieval.ts`).
  The old "idf" factor was computed from *the document being scored* — how many of
  the query's terms that document happened to contain — so it was a coverage
  discount wearing the name of IDF and could not tell a rare term from a common one.
  Corpus document frequencies are now counted once per search using the backend's
  true corpus total, and each term's credit is scaled by a normalised IDF. The
  coverage ordering that was already correct is preserved, and the scorer's now-dead
  `totalDocs` parameter is gone.

- **Lexical retrieval now matches whole tokens, scores phrases, and weights
  fields** (`src/retrieval.ts`). A query for `cat` scored
  `"concatenate the streams"` at exactly the same 60.00 as `"the cat sat"`,
  because matching was a single `String.includes`. Terms now match whole tokens, a
  prefix match is a distinct separately-weighted signal rather than a tie with an
  exact one, a phrase adjacent and in order earns a bonus (scored, never filtered —
  dropping a result for containing the words in the wrong order would lose
  something the user asked for), and `content` and `tags` are weighted separately
  instead of concatenated into one string where a tag mention was worth as much as
  prose. CJK is tokenized per character. The 0..60 scale and the zero-means-zero
  property the `keyword_hit` explanation depends on are unchanged.

- **Token efficiency and duplicate rate** in the retrieval evaluation harness
  (`src/eval.ts`) — the two of roadmap §38's seven metrics that were missing, and
  the guardrail the deduplication work in V5.7.0 needs. Token efficiency is the
  fraction of returned context that belonged to relevant results, which separates a
  change that made results *more relevant* from one that merely made them *longer*;
  precision@k cannot tell those apart. Duplicate rate is the fraction of results
  that repeat an earlier one, reported from the same `duplicateKey` the
  deduplication pass will use, so it moves when deduplication lands. Raw counts are
  reported alongside both ratios.

## [5.6.0] — 2026-09-29

Distributed Remembra: cross-instance primitives, an optional Redis backend, and an
explicit process split. **A single-process installation is unaffected** — with no
`REMEMBRA_REDIS_URL` the optional package is never imported, no shared store is
opened, and the readiness payload is byte-identical to 5.5.1.

Runtime dependencies are unchanged at four. `redis` is an **optional peer** and is
not even a devDependency, which is what keeps its missing-package startup failure
a real test rather than a mocked one. Six new published subpaths: `./lock`,
`./job-store`, `./worker`, `./redis`, `./shared-state`, `./process-roles`.

**Not verified: a live Redis server.** The quota scripts are executed through a
Lua 5.3 VM with a shim of the Redis commands they use (28 checks, covering their
logic but not a real server), and the failure matrix verifies our response to a
store outage rather than Redis itself. Treat shared-state operation as
reviewed-and-unit-tested until a Redis instance is in CI.

### Added

- **The §30 failure matrix** (`src/test/failure-matrix.test.ts`, with a real
  second OS process in `src/test/matrix-peer.ts`): all nine distributed-failure
  scenarios, each asserting a stated invariant rather than "did not crash". The
  two-process rows force the same expected version into both processes rather
  than relying on interleaving, so they detect the lost-update defect that
  motivated the milestone. **A live Redis is still not exercised** — the
  outage rows verify our response to a store outage, not Redis itself.

- **Process roles** (`src/process-roles.ts`, published as
  `@hilbras/remembra/process-roles`): `remembra serve`, `remembra worker`, and
  `remembra scheduler`. The no-subcommand path is unchanged and still requires no
  configuration, so a single-process install is unaffected. A role without an HTTP
  surface **refuses** `--http`/`--port` and refuses data verbs rather than ignoring
  them — a `worker` that silently bound a port would serve traffic from a process
  whose premise is that it has no HTTP surface. `worker` runs a durable worker over
  a SQLite ledger; `scheduler` only enqueues periodic jobs, so exactly one worker
  anywhere claims each one.

- **Shared-state configuration with honest degradation**
  (`src/shared-state.ts`, published as `@hilbras/remembra/shared-state`). The
  capability manifest advertises `distributed` unconditionally — it describes the
  build, like `webhooks`, not the configuration. A single-process readiness
  payload is byte-identical to the previous release: it does not even gain a field
  saying "absent". When a configured store becomes unreachable the limiter
  **fails closed** with 503 rather than degrading to per-instance limits, which
  would let a fleet exceed a tenant's quota while every instance reported a limit
  it was not enforcing; readiness reports `unready` so a load balancer drains the
  instance, liveness stays up so it can be diagnosed, and it recovers on its own
  at the next successful operation. Reports carry a classified label only — never
  the URL, host, port, or password.

- **An optional Redis adapter** (`src/redis.ts`, published as
  `@hilbras/remembra/redis`) providing `RedisLockProvider` and
  `RedisQuotaRateLimiter`. `redis` is an **optional peer dependency** and not a
  runtime dependency; the only reference to it is a dynamic `import()`. There is
  no silent fallback: with `REMEMBRA_REDIS_URL` unset the process imports no
  Redis code at all, and with it set but unreachable, startup fails rather than
  degrading to per-instance state that would report a limit it is not enforcing.
  Locks use `SET … NX PX` so the lease and its expiry are one atomic operation,
  and renew/release are owner-checked by the server.
  Quota is evaluated as **one Lua script across every dimension** rather than one
  limiter per dimension, because the in-process limiter's mutex does not cross
  instances and interleaved dimension checks would let a shared organization
  budget be exceeded. Precedence and policy validation match the in-process
  limiter exactly, and each dimension keeps its own window.
  The script bodies are verified by running the shipped text through a Lua 5.3 VM
  (`scripts/verify-redis-lua.mjs`, 28 checks, not a release gate). **A live Redis
  server is not exercised by the test suite.**

- **A durable worker** (`src/durable-worker.ts`, published as
  `@hilbras/remembra/worker`), the shared-execution counterpart to the in-memory
  `JobQueue`, which is unchanged and remains what a single process uses. Its
  centrepiece is the partition guard: a claimed job's lease is renewed while it
  runs, and if a renewal ever fails the job's `AbortSignal` fires — finishing
  anyway would be the lost-update failure below wearing a lease. A refused
  `complete()` is reported as `lease_lost` rather than as success. Claims are
  restricted to the types a worker declares, so a heterogeneous fleet never
  claims work it cannot run, and `stop()` releases in-flight leases so a peer
  takes over immediately instead of waiting out the lease. The poll timer is
  deliberately not `unref`'d, since §28 allows a worker-only process that has
  nothing else holding its event loop open.

- **A durable job ledger** (`src/job-store.ts`, published as
  `@hilbras/remembra/job-store`), the second distributed primitive. All six §27
  states and ten fields, with `InMemoryJobStore` and `SqliteJobStore` behind one
  `JobStore` interface. A claim is a single `UPDATE ... RETURNING`, so the
  database picks the winner and returns the row it actually claimed — a
  read-then-write is the shape that produced the lost update below. Claims are
  ordered oldest-first with the id as tie-break, so every claimer agrees on the
  next job. A dead worker's job returns to `retrying` once its lease expires, and
  `renew`/`complete`/`fail` return `false` for a lease the caller no longer
  holds. Payloads, job types, tenant digests, and stored error labels are all
  bounded. 28 tests, with the whole behavioural suite run against both
  implementations so they cannot drift.

- **Lease-based locking** (`src/lock.ts`, published as `@hilbras/remembra/lock`),
  the first primitive of the distributed-runtime milestone. Every acquisition is a
  *lease* with an owner and an absolute expiry rather than a lock, so a crashed
  holder is reclaimed instead of deadlocking. `release()` is owner-checked and
  cannot clear a peer's lease; `renew()` returns `false` once a lease is lost, so
  a partitioned worker stops rather than resuming on a belief it still holds it —
  the same failure as the lost update below, wearing a lock. Two implementations
  ship: an in-process provider (the default) and a file-backed one that reclaims
  on the expiry timestamp rather than pid liveness, which is what makes it
  portable beyond one host. `lockKey` hashes any non-digest part, so a raw tenant
  cannot reach a key that is written to disk. Documented in
  [`docs/lock.md`](docs/lock.md). 15 tests, two of which caught defects in the
  implementation: an unreadable lease file livelocked `acquire` forever, and
  `isHeld()` never observed the lease it had just written.

### Fixed

- **A cold-start race in ledger initialization.** The identity file, the schema,
  and the generation row become visible at three separate moments, so two
  processes starting against one fresh directory could observe an intermediate
  state and refuse to start. The integrity checks are unchanged; a state only a
  live initialiser can produce is now polled for up to two seconds first, so
  genuine damage is still refused, just after the wait. Reverting the fix
  reproduces it: **1 failure in 24 simultaneous cold starts without, 0 with.**

- **A cold-start race in the batch idempotency ledger.** Two processes
  starting against a fresh ledger directory could observe each other's
  not-yet-`0600` `claims.sqlite` — better-sqlite3 creates the file with the
  process umask and it was only `chmod`ed after the open — and one would refuse to
  start with "claim database must not be group/world accessible". The permission
  check is unchanged; the file is now created `0600` with `O_CREAT|O_EXCL` before
  it is opened, so there is no window to lose. Without this a fleet cannot
  cold-start against a fresh store.

- **A spurious `IO_ERROR` from a racing delete on the file backend.** Two
  `MemoryStore` instances deleting the same memory could have one unlink the file
  after the other resolved it; the resulting `ENOENT` surfaced as an error to a
  caller that had done nothing wrong. `ENOENT` on the unlink is now the
  already-reported "missing" result, so a racing delete is genuinely idempotent.
  This was a pre-existing intermittent failure, caught by a release gate and
  disproving the audit's own assessment of `forget` as safe — idempotent *state*
  is not the same as a non-throwing *call*.
- **A cross-instance lost update on the SQLite backend, with a success
  response.** `MemoryBackend` requires mutating calls to be safe under
  "cross-process concurrency (advisory lock)", and `SqliteBackend` only
  satisfied the same-process half: `withLock` is a promise queue over one
  instance's field, with no `BEGIN IMMEDIATE` and no `db.transaction()` anywhere
  in the file. `update` read the row, checked `expectedVersion` in application
  code, and then wrote `WHERE id = ?` with no version predicate — so two
  instances that read the same version both passed the check and both wrote.
  Reproduced 5 times out of 5 with two instances over one `data.sqlite`: both
  were told they wrote version 2, and one write was discarded with no error.
  The write is now a compare-and-swap on the version it read, and a zero-row
  result distinguishes `NOT_FOUND` from `CONFLICT` so a caller does not retry a
  write whose row is gone. Six tests in `src/test/sqlite-cas.test.ts` cover the
  race, the error text, delete-in-between, and the two behaviours that must not
  change. Found by
  [`v5.6.0-audit.md`](docs/v5.6.0-audit.md) finding S1, the first task of the
  distributed-runtime milestone — reachable before any distributed work, and
  routine after it.

### Known limitation, now measured

The native `RemoveEnvironmentCleanupHook` abort previously documented as a test
teardown nuisance **can kill a running server on Node 24**. Measured against the
published `5.4.0` and `5.5.1` packages under 2 500 requests of mixed write,
search, and scrape traffic:

| Runtime | Result |
|---|---|
| Node 18.20.8 | 2 000 requests, no abort |
| Node 24.21.0, `better-sqlite3` 11.x | aborted at 750, 750, and 1 750 requests |
| Node 24.21.0, `better-sqlite3` 12.11.1 | aborted at 751 requests |

Three things this corrects: the abort is **not** confined to process teardown, it
is **not** fixed by upgrading the binding, and it is **not** a regression from the
5.5.0 work — `5.4.0` aborts identically. It is a garbage-collection-timing race
in the native binding, so the point at which it fires is not reproducible.

No code change is possible from this repository: there is no wrapper that can
contain a process abort, and the store already caches prepared statements, so the
allocation churn is not ours to reduce. `docs/troubleshooting.md` now says so
plainly instead of calling it contained. An operator who needs an abort-free
Node 24 deployment should run Node 18, where the exposure has not reproduced.

## [5.5.1] — 2026-09-27

A patch release for two defects in the log field policy introduced by 5.5.0.
Both were found by a post-release audit that enumerated every `logEvent` field
name in the tree and diffed it against the policy's lists, rather than by
reading the code — the call site looked correct in both cases.

### Fixed

- **A documented diagnostic field was silently removed.** `file` sat on the
  blanket drop list alongside `path` and `root`, so `memory_parse_skipped` and
  `memory_normalized` stopped emitting the `file` field that
  `docs/observability.md` advertises. The event still reported that a memory file
  was unparseable, but not which one — the only thing an operator needs from it.
  A bare basename is not a disclosure; a path is. Filename fields now pass
  through only when the value is bounded, separator-free, and free of parent
  references, so `/home/someone/.remembra/secret.md` and `../../etc/passwd` are
  still refused *in a `file` field*.
- **The field policy only inspected top-level keys**, so
  `{ details: { path: "/home/someone/..." } }` bypassed it completely, as did any
  deeper nesting and any object inside an array. The redactor was already
  recursive; the policy was not. It is now applied at every depth, with the top
  level left alone so an identity is not hashed twice.

No behaviour outside logging changes. `SEMVER` patch because the route, env-var,
and metric surfaces are untouched.

### Release evidence

- Node 18.20.8 and Node 24.21.0: build, 688 suite, 142 security, 52 recovery,
  28 Python, and 41 documentation checks, 0 production audit findings, and both
  benchmarks within their documented ceilings.
- Verified from both registries after publication, against the **installed**
  package rather than this tree: a clean npm install imports every published
  subpath and refuses a tampered webhook body; a fresh Python venv pulls zero
  dependencies and reports the same frozen batch limits; the published wheel and
  sdist hash-match the artifacts built from this tag. The seven field-policy cases
  above were run against the published `dist/log.js` — a bare filename survives,
  an absolute path and a `../..` reference are refused, and a nested path, a
  three-deep query, and an object inside an array are all dropped.

## [5.5.0] — 2026-09-27

Production infrastructure: the roadmap §17–§24 milestone the plan calls
V5.1.0, released as 5.5.0 because V5.4.0 shipped first and the roadmap's
`5.1.0` is now a downgrade. See
[`docs/v5.5.0-compatibility.md`](docs/v5.5.0-compatibility.md) for the
renumbered milestone table and the full compatibility statement.

### Rate limiting and quotas

- Added a `RateLimiter` interface with async `check`, `consume`, and `reset`,
  implemented in-process and injected through `HttpOptions.rateLimiter`, so a
  shared-store implementation can be supplied without editing the request path.
- `check` now decides without charging. Previously a caller could not ask
  whether it had budget without spending it.
- Bounded the limiter's identity map. A window was previously reclaimed only if
  its own key was checked again after expiry, so an identity used once and
  abandoned lived for the process lifetime — 50,000 abandoned keys retained
  50,001 entries, reachable pre-authentication through the anonymous address
  bucket. A `maxIdentities` ceiling with a deterministic sweep and
  least-recently-used eviction replaces it, and pruning no longer depends on
  `Math.random()`.
- `rateLimitIdentity` refuses any dimension value that is not a hex digest, so a
  raw principal or API key fails loudly at the call site instead of quietly
  becoming a rate-limit key.
- Added `REMEMBRA_QUOTAS` for per-dimension policies across organization,
  project, user, agent, API key, IP, endpoint, and provider, layered on top of
  the base budget so adding a policy can only make a deployment stricter.
  Precedence is the declared dimension order, charging is all-or-nothing, and a
  429 now names the dimension that refused it without ever naming a principal.
- **Fixed:** decide and charge were separated by an `await`, so a concurrent
  burst bypassed the quota entirely — 500 requests against an organization cap
  of 20 were all admitted. Now serialized, with `reset`.

### Health

- Added `/health/live`, `/health/ready`, `/health/storage`, and
  `/health/provider`. Liveness is public and reads process state only, so it
  stays `200` when storage is broken and reports `draining` once a shutdown
  begins. The dependency routes sit behind authentication.
- **Fixed:** `/health` is unauthenticated and unrated but performed a full
  storage scan, a recovery-state refresh, and a durable recovery-state write on
  every call. Its result is now cached briefly with single-flight — 25
  sequential probes cost one storage scan, 20 concurrent probes cost one.
- **Fixed:** `/metrics` was rate limited despite `rate-limiter.ts` documenting it
  as exempt, so a scraper lost observability during rate-limit storms.
- No health response contains memory content, record counts, storage paths,
  error message text, or provider keys — only the classified error label and
  provider *configuration*.

### Metrics

- Added p50/p95/p99 over recorded histograms, plus `names()` and
  `seriesCount()` for introspection and cardinality alerting. An unobserved
  series reports `0` rather than a fabricated latency; `sum` and `count` stay
  exact.
- Added the six §21 series that did not exist, including
  `remembra_rate_limit_hits_total{dimension}`.
- **Fixed:** seven further series were declared and never written by anything —
  the four provider and storage series now have a real choke point in
  `observeProviderCall`, so injected and constructed adapters are counted alike.
  The three memory-count gauges, three quality-rate gauges, the cost gauge, and
  `remembra_token_usage_total` were **removed** rather than left empty: each
  needs a full scan, a quality computation, or usage the adapter contract does
  not report, and a series that can never report is a worse lie than an absent
  one.
- Bounded the job-type metric label to a closed set at both the enqueue and
  completion sites, so a host cannot create one series per tenant by registering
  a per-tenant job type.

### Logging

- Every log line now carries `requestId`, `operation`, and `durationMs` through
  an `AsyncLocalStorage` request context, so events from the service, storage,
  provider, and job-queue layers correlate without threading anything by hand.
- Added a field policy: content and path fields are dropped unless
  `REMEMBRA_DEBUG` is set, and identity fields are replaced by a short stable
  digest so correlation survives without a raw identifier reaching every log
  aggregator. Filename fields pass through only when the value is a bare,
  bounded, separator-free name, so `memory_parse_skipped` still says *which*
  file is bad while an absolute path is still refused. The policy is enforced at
  every nesting depth, not just on top-level fields.
- **Fixed:** `retrieval.debug` logged the raw query text behind
  `REMEMBRA_DEBUG_RETRIEVAL` rather than the documented `REMEMBRA_DEBUG`, and
  `migration_start` logged a storage path unconditionally.

### Graceful shutdown

- Replaced a six-line handler that always exited `0` with a coordinated
  sequence: mark draining, stop accepting, stop background work, drain webhooks,
  stop jobs, close providers, close storage. One deadline bounds the whole
  sequence; a wedged phase is reported `timeout` with later phases `skipped`, so
  storage is never closed under an in-flight write. A second signal joins the
  in-flight shutdown and shortens the deadline, and a forced shutdown exits `1`.
- **Fixed:** MCP mode installed no signal handler at all, so `SIGTERM` took the
  default disposition and killed an MCP server with no drain and no
  recovery-state flush.

### Testing

- Added a bounded production stress matrix: 100 and 1K concurrency, large and
  oversized payloads, large search, provider timeout storms, rate-limit storms
  in-process and over HTTP, quota storms, database contention, shutdown and
  restart under load, file-descriptor leaks, and metric cardinality. No
  wall-clock thresholds, so it is reproducible on a slow runner.

### Release evidence

- Node 18.20.8 and Node 24.21.0: build, 684 suite, 142 security, 52 recovery,
  28 Python, and 40 documentation checks, 0 production audit findings, and both
  benchmarks within their documented ceilings.
- Published as `@hilbras/remembra@5.5.0` on npm and `hilbras-remembra 5.5.0` on
  PyPI, and verified **from both registries** rather than from this tree: the npm
  install imports every published subpath, verifies a webhook signature, and
  refuses a tampered body; the PyPI install into a fresh virtual environment
  pulls zero dependencies and reports the same frozen batch limits; and the
  published wheel and sdist hash-match the artifacts built from this tag. A live
  server from the published package serves all five health routes with the
  intended auth rules, honours `REMEMBRA_QUOTAS` with a `429` that names a
  hashed dimension, and shuts down cleanly on `SIGTERM` in both HTTP and MCP
  mode.
- This release does not claim distributed quotas, distributed workers, or the
  advanced retrieval engine. The rate limiter, quota ledger, webhook queue, and
  idempotency ledger remain single-host and in-process; the interfaces exist so a
  shared implementation can be added later without changing the request path.

## [5.4.0] — 2026-09-26

### Developer platform

- Added the draft [V6 architecture specification](docs/v6-architecture-spec.md),
  covering first-class trust/sensitivity/expiration policy, provider-independent
  offline operation, versioned API domains, migration gates, and release
  discipline. No V6 implementation is implied by this design document.
- Added bounded read-only batch search across the service, HTTP, MCP, and
  TypeScript SDK contracts. Search fans out through authorized single-search,
  preserves per-item order and sanitized failures, limits aggregate requested
  results to 1,000, omits internal embeddings, accounts output bytes
  incrementally, and caps requests/responses at 10 MiB. Mutation-only
  idempotency keys are rejected. Public batch embedding remains intentionally
  unavailable pending provider-cost, quota, and response-output policy
  decisions.
- Hardened V5.4 keyed-batch recovery: tenant-shaped options can no longer mint
  trusted contexts, missing credential scopes fail closed, writes re-read durable
  recovery state, restore gates block reads/readiness and fence in-flight claims,
  interrupted SQLite restores reconcile before verification, replaced or legacy
  ledgers are never silently reset, deterministic all-failed claims release
  capacity safely, and durable tenant migration requires the restore gate.
- Attributed the durable batch data gate to its owner: a data `restore` gate is
  completed with `recover verify`, while a tenant `migration` gate stays
  resumable through `migrate apply`. Startup names the matching operator action,
  an unsafe or unrecognized gate marker is never auto-cleared, and a damaged
  marker can no longer discard replay claims before it is resolved.
- Bound a released keyed-batch claim to its original operation instead of
  freeing the key, so a different operation returns `CONFLICT` while the
  identical operation may be retried; tombstones no longer consume capacity.
- Migrated a pre-existing claim ledger in place after verifying every row, so
  replay history survives an upgrade and tampered or unknown schemas still fail
  closed.
- Kept recovery failures local: an unreadable durable recovery state fails that
  write closed without latching `Failed` for later writes, and read-only batch
  operations no longer depend on the writable-state channel.
- Added a TypeScript SDK batch budget guard: an impossible batch (over 100
  items, over 1,000 aggregate search results, over 10 MiB, or not serializable)
  throws locally instead of spending a request. The shared limits now live in the
  dependency-free `@hilbras/remembra/api-contract` entry point.
- Added a dependency-free Python SDK (`hilbras-remembra`) with synchronous and
  asynchronous clients: the same `/api/v1` paths, `x-api-key` authentication,
  typed error hierarchy, read-only retry policy, bounded timeouts and request
  IDs, opaque cursor pagination, and mutation-only `Idempotency-Key` handling.
  The client uses only the standard library, ships its own tests, and a parity
  suite reads the published TypeScript contract so the two SDKs cannot drift
  apart silently.
- Added signed webhook delivery as an opt-in host integration, exported from
  `@hilbras/remembra/webhooks`: a closed event set, allowlist-only payloads with
  no embedding vectors or credential-like fields, HMAC-SHA256 `t,v1` signatures
  with a bounded timestamp window, a receiver replay guard, an
  integrity-protected durable SQLite queue, and a dispatcher with bounded
  exponential backoff that retries only timeouts, network errors, `408`, `429`,
  and `5xx`. Deliveries are notifications: a failed or missing dispatcher never
  fails the write that produced the event. The full event set is emitted
  (`memory.created`, `memory.updated`, `memory.deleted`, `memory.consolidated`,
  `snapshot.created`, `snapshot.restored`, `job.completed`, `job.failed`), and a
  deployment can enable delivery with `REMEMBRA_WEBHOOKS`; long-running HTTP and
  MCP processes drain due deliveries on a bounded interval.
- Contained a pre-existing native teardown abort in the test gates. The pinned
  `better-sqlite3` 11.x binding can abort a test process while Node tears the
  environment down, after every assertion has reported, with
  `RemoveEnvironmentCleanupHook ... Assertion failed: (env) != nullptr`. The
  `test`, `security:check`, and `recovery:check` scripts now re-run only the
  aborted files through `scripts/run-tests.mjs`, log every recovery, and still
  fail immediately on any real failure. `npm run test:raw` keeps the previous
  unguarded behavior.
  > **Corrected after release.** This entry originally said the binding's
  > version was the only obstacle. That is wrong on both counts: the abort is
  > **not** fixed by `better-sqlite3` 12.x, and it is **not** confined to test
  > teardown — it can kill a running server on Node 24. See
  > [`troubleshooting.md`](docs/troubleshooting.md#a-process-aborts-with-removeenvironmentcleanuphook)
  > for the measurements.
- Added the [V5.4.0 compatibility report](docs/v5.4.0-compatibility.md) and a
  complete [OpenAPI 3.1 specification](docs/openapi.yaml) for the `/api/v1`
  surface, with a regression test that fails when a served route, limit,
  idempotency rule, or capability is undocumented.
- Added a verified example suite (Node, Python, FastAPI, RAG, local-LLM,
  Next.js, React, and AI agent) documented in [docs/examples.md](docs/examples.md).
- Added the receiver half of the webhook contract as verified examples in Node
  and Python: read the raw body, verify `x-remembra-signature` against it, and
  reject a repeated delivery id. An end-to-end test drives the real CLI into the
  real receiver, and a forged body, an expired timestamp, a foreign secret, and
  a replayed delivery id are each refused.

- Retired queued webhook deliveries when a data restore or operator rollback
  replaces the store. A queued event describes data that may no longer exist, so
  delivering it would tell a subscriber something untrue. The queue survives the
  gate and is retired only when the restore is published.
- Added `aiter_list` to the Python asynchronous client, so both clients offer
  the same pagination surface the documentation claims.
- Advertised `webhooks` in the `/api/v1/capabilities` manifest. The manifest
  describes the build rather than the deployment, so the capability is present
  whether or not `REMEMBRA_WEBHOOKS` is configured; a regression test now
  asserts that every shipped surface is discoverable.
- Added `remembra --version` and `remembra --help`. Both answer before any
  configuration validation, storage-directory creation, or server start, so
  asking what is installed never has a side effect and never blocks on an MCP
  stdio handshake.

### Release evidence

- Node 18.20.8 and Node 24.21.0: build, 567 suite, 139 security, 52 recovery,
  28 Python, and 39 documentation checks, 0 production audit findings, and a
  241-file package dry run.
- Published as `@hilbras/remembra@5.4.0` on npm and `hilbras-remembra 5.4.0`
  on PyPI. Both were then verified **from their registries**, not from the
  source tree: the npm install imports every published subpath, verifies a
  webhook signature, and refuses a tampered body; the PyPI install into a fresh
  virtual environment pulls zero dependencies and reports the same frozen
  batch limits; the published wheel and sdist hash-match the artifacts built
  from this commit. A body signed by the TypeScript sender is accepted by the
  Python receiver, while a tampered, stale, mis-keyed, re-serialized, or
  replayed one is refused.
- V5.4.0 deliberately does not claim distributed quotas, distributed workers,
  or the advanced retrieval engine: V5.1–V5.3 remain unfinished. Public batch
  embedding remains unavailable, and delivery state is single-host.

## [5.0.3] — 2026-09-24

### Reliability

- Added deterministic startup validation for configuration, tenant context,
  storage paths, permissions, and write readiness before backend migration.
- Added bounded `Healthy`/`Degraded`/`Recovering`/`Failed`/`ReadOnly` health
  states with durable, atomically replaced recovery state and explicit
  `recover read-only`/`recover verify` controls.
- Added snapshot semantic validation, SQLite restore journaling/reconciliation,
  atomic SQLite batch imports, and a durable file-import rollback journal.
- Added permanent recovery regressions for restart, corruption, symlinks,
  SIGKILL, permission, disk, I/O, and SQLite-full failures.

### Compatibility

- Preserved V4.9/V5 behavior and deferred V5.1/V6 implementation.
- Kept provider-optional operation, tenant authorization, path containment,
  redaction, and fallback observability unchanged.

### Verification

- Node 18.20.8 and Node 24.21.0 complete release gates passed at 5.0.3.
- Full suite: 466 passed, 0 failed; security matrix: 64 passed; recovery matrix:
  48 passed on both runtimes.
- Documentation check passed (36 files), dependency audit found 0
  vulnerabilities, and package dry-run included 222 files (440.7 kB packed;
  1.9 MB unpacked).
- Tenant benchmarks completed at 10K/100K records and the bounded scale
  benchmark completed at 10K/50K records under both runtimes.

## [5.0.2] — 2026-09-24

### Security

- Added a centralized authorization decision layer with explicit operation and
  capability mappings, exact organization/project/user/agent visibility, and
  non-informative cross-tenant lookup behavior.
- Enforced tenant dimensions across file/SQLite candidate queries, counts,
  history, audit, entities, batches, snapshots, and scoped migration.
- Rechecked configured tenant membership before ordinary service work, provider
  calls, and mutations; required the separate `tenant:export` capability for
  full and selected exports.
- Normalized reserved identity ingress across HTTP, MCP, and SDK surfaces and
  sanitized provider/IO errors returned through public tool boundaries.
- Applied configured sensitive-data redaction to store, update, and import paths.

### Changed

- Documented the exact file-backend, SQLite, snapshot, backup, and transport
  encryption boundaries; strict mode refuses legacy global Markdown/encryption
  commands.
- Finalized the V5 threat model and added a versioned V5.0.2 authorization
  contract with permanent `SEC-AUTH-*`, `SEC-SENS-001`, and `SEC-DOC-001`
  regressions.
- Preserved V4.9/V5 compatibility and deferred all V6 implementation.

### Verification

- Node 18.20.8 and Node 24.21.0 complete release gates passed at 5.0.2.
- Full suite: 431 passed, 0 failed; security matrix: 64 passed; recovery matrix:
  13 passed.
- Documentation check passed (36 files), dependency audit found 0
  vulnerabilities, and package dry-run included 207 files (422.7 kB).
- Tenant benchmarks completed at 10K/100K records and the bounded scale
  benchmark completed at 10K/50K records under both runtimes.

## [5.0.1] — 2026-09-24

### Security

- Hardened authentication-before-rate-limiting with opaque rate identities and
  separate anonymous/authenticated buckets.
- Added centralized secret redaction for structured logs, debug queries, and
  provider diagnostics; HTTP provider errors are sanitized.
- Made SQLite startup and migration readiness fail closed; file fallback is
  explicit, warned, and visible in health.
- Contained file-history paths and rejected symlinked history storage.

### Migration

- Strict restore now rejects tenantless snapshots.
- Added signed, target-bound `migrate analyze`, `migrate plan`, and
  `migrate apply --dry-run`/apply workflows with tamper rejection and idempotent
  retry behavior.

### Verification

- Node 18.20.8 and Node 24.21.0 release gates passed at 5.0.1.
- Full suite: 414 passed, 0 failed; security matrix: 47 passed; recovery
  matrix: 13 passed.
- Documentation check passed (35 files), dependency audit found 0
  vulnerabilities, and package dry-run included 203 files (410.2 kB).

## [5.0.0] — 2026-09-24

**Production Memory Platform** — plan §13 of the Master Development Plan.
V5 preserves V4.9 compatibility while adding strict tenant isolation, bounded
context/retrieval, verified recovery, and release-gated operations.

### Added

- **V5 context contract and threat model** covering token budgets, visibility,
  tenant boundaries, and release evidence.
- **Bounded context assembly** through `MemoryService.context`, the v1 HTTP
  route, the TypeScript SDK, and the additive `memory_context` MCP tool.
- **Conservative token estimator** with injectable counters, hard candidate and
  budget limits, deterministic ordering, and internal-vector omission.
- **Validated V5 policy configuration** with trusted file/env layering,
  fail-closed validation, lifecycle defaults, extraction control, retrieval
  toggles, and sensitive-data policy integration.
- **Effective embedding reranking** now honors the validated retrieval
  reranking policy with a deterministic cosine tie-breaker before MMR
  selection; unsupported/vectorless cases retain the fused order.
- **Bounded relation expansion** is available through validated retrieval
  policy, restricted to the already-authorized candidate pool with one-hop and
  32-edge caps.
- **V5 tenant contract and identity primitives** with opaque host contexts,
  canonical scoped identifiers, fail-closed matching, migration boundaries,
  versioned organization/user/project/agent directory verification, an atomic
  file-backed directory adapter with strict entity-reference validation, a
  bounded organization-derived entity CRUD/pagination service, default-deny
  host-authorized organization provisioning, trusted HTTP/SDK entity routes,
  and a `TENANT_REQUIRED` error. Backend enforcement is active across file and
  SQLite paths.
- **V5 tenant schema expansion** adds optional persisted organization/project/
  user/agent metadata while keeping tenantless V4 records at schema 3 and
  tenant records at schema 4. A canonical HMAC-SHA256 migration manifest now
  validates explicit organization/entity/ACL mappings, counts, checksums, and
  relation references before any future migration step consumes it.
- **V5 signed snapshot recovery** adds canonical HMAC-SHA256 snapshot
  envelopes, strict export/import verification, reference sanitization, and
  operator key configuration. Legacy mode continues to accept unsigned V4
  snapshots during migration.
- **V5 tenant migration runner** preflights explicit organization/entity/ACL
  mappings, signs and verifies manifests, validates source/reference checksums,
  and applies records idempotently to tenant-capable backends. Durable
  checkpoint/resume state and an explicit publication marker are included;
  backend-specific publication and retained-previous rollback are explicit.
- **Atomic recovery files** write signed snapshots through fsync + rename,
  reject symlink/oversized/tampered inputs, and are used by keyed CLI
  export/import. Snapshot restore also has a no-write `previewSnapshot` and
  `import --dry-run` preflight path.
- **V5 release gates** are reproducible through `npm run release:check`,
  including dedicated tenant-security and recovery matrices before build/docs,
  audit, package, and benchmark publication gates.
- **SQLite recovery** adds verified online backups, `integrity_check` and
  schema validation, same-directory atomic restore publication, retained
  pre-restore rollback, and symlink/active-sidecar rejection.
- **Strict HTTP ingress hardening** rejects tenant-bearing headers, query
  parameters, and request fields (while allowing signed snapshot records) so
  public callers cannot select an organization.
- **File-backend tenant boundary** adds encoded tenant namespaces and
  tenant-filtered point reads, writes, lifecycle operations, and history;
  unscoped legacy reads never enumerate tenant directories.
- **SQLite tenant boundary** adds nullable tenant/project/user/agent columns,
  tenant-filtered point/lifecycle/history/audit operations, FTS filtering, and
  candidate predicates before `LIMIT`/count calculation.
- **Strict tenant service and transport binding** adds opaque host contexts,
  fail-closed service authorization, tenant-aware CRUD/search/context/history/
  relations/import/export/maintenance paths, trusted HTTP resolution, strict
  MCP server binding, and SDK rejection of tenant-bearing body/header fields.
  Raw backend access is disabled in strict mode. Queued handlers support
  host membership re-checks, and embedding cache keys accept tenant-safe
  partitions. The CLI now has an explicit `REMEMBRA_TENANT_MODE=strict` operator
  binding and refuses legacy global backup/restore/migration/encryption forms;
  remaining work is broader derived-cache invalidation.

### Verification

- Node 18.20.8 and Node 24.21.0 release gates passed at version 5.0.0.
- Full tests, tenant-security and recovery matrices, documentation checks,
  package checks, and dependency audit passed with zero audit vulnerabilities.
- Strict tenant benchmarks passed the documented 10K/100K p95 and heap ceilings.
- Published as `@hilbras/remembra@5.0.0` and
  [GitHub Release v5.0.0](https://github.com/Hilbras/Remembra/releases/tag/v5.0.0).

---

## [4.9.0] — 2026-09-24

**API, SDK & Compatibility Stabilization** — plan §12 of the Master
Development Plan.

### Added
- **Versioned HTTP namespace**: additive `/api/v1/*` aliases for the existing
  routes, with `X-Remembra-API-Version: v1` on success and transport errors,
  public health behavior, bounded CORS exposure, and legacy parity tests.
- **TypeScript SDK**: side-effect-free `@hilbras/remembra/sdk` fetch client with
  typed store/search/list/item/lifecycle/relation/digest/batch methods,
  pagination, cancellation, structured errors, and server-managed identity
  rejection.
- **Stable MCP manifest**: the 13 current tool names are centralized and tested
  through an in-memory `tools/list` contract without renaming legacy tools.
- **Provider adapters**: vendor-neutral LLM and embedding interfaces plus
  OpenAI-compatible, Anthropic, Ollama, and injected-local factories. Built-in
  adapters retain the bounded `providerFetch` policy and legacy environment
  configuration.
- **V4.9 documentation**: getting started, migration, self-hosting,
  troubleshooting, SDK, MCP manifest, and provider-adapter guidance.

### Compatibility notes
- Existing unversioned HTTP routes and MCP names remain supported.
- V1 preserves route-specific legacy response bodies; the SDK retains the raw
  body and supplies `HTTP_<status>` only when a server code is absent.
- Trusted agent context remains host-resolved; public identity fields are not
  authentication. The SDK rejects server-managed identity/access fields before
  transmission.

### Verification

- Full suite on Node 24: **340 passed, 0 failed**.
- Full suite on Node 18.20.8: **340 passed, 0 failed**.
- TypeScript build and SDK/provider import smoke tests pass on both runtimes.
- `npm run docs:check`: **27 Markdown files, no missing relative links**.
- `npm audit --omit=dev --audit-level=high`: **0 vulnerabilities**.
- `npm publish --dry-run`: package contents and prepublish checks passed; tests
  are excluded from the tarball.
- 10K/50K V4.8 scale benchmark remains the retrieval baseline; V4.9 does not
  change candidate planning or storage formats.

Published as `@hilbras/remembra@4.9.0` and
[GitHub Release v4.9.0](https://github.com/Hilbras/Remembra/releases/tag/v4.9.0).

---

## [4.8.0] — 2026-09-24

**Performance & Scalability** — plan §11 of the Master Development Plan.
Adds bounded retrieval planning, batch APIs, background work, and scale
observability without changing the existing single-memory API.

### Added
- **Bounded SQLite keyword candidates**: exact lexical matches plus the highest
  zero-signal modifier anchors are planned inside a hard budget; partial pages,
  semantic queries, type-filtered queries, agent mode, and legacy backends retain
  the full-scan fallback.
- **Scale benchmark**: deterministic 10K/50K SQLite benchmark with p50/p95
  latency, result counts, heap usage, and explicit legacy fallback mode.
- **Batch operations**: `MemoryService.batch`, `POST /memories/batch`, and the
  `memory_batch` MCP tool support bounded store/update/delete/selected-export
  requests with ordered per-item outcomes and whole-request validation.
- **Bounded embeddings**: `embedTexts` applies batch-size and provider-
  concurrency limits; embedding-enabled batch stores avoid duplicate provider
  calls when redaction/reject policy permits.
- **Background jobs**: typed `JobQueue` with capacity, concurrency, retries,
  cancellation, typed queue errors, maintenance/embedding/consolidation/
  validation/archive handlers, and graceful shutdown.
- **Resource metrics and configuration**: queue depth/running gauges, job and
  batch/embedding counters, and `REMEMBRA_JOB_*`, `REMEMBRA_MAX_BATCH_SIZE`,
  and `REMEMBRA_MAX_CONCURRENT_EMBEDDINGS` limits.
- **SQLite FTS maintenance**: idempotent rebuild plus update/archive/revive
  synchronization and actual memory IDs from `ftsSearch`.

### Compatibility and safety
- Existing single-item store/update/delete/export behavior and all eleven
  memory types remain available.
- Agent visibility remains fail-closed and is applied before batch or job
  mutations; inaccessible ids are reported as `NOT_FOUND`.
- Batch mutations are sequential, bounded, and explicitly not cross-item
  atomic; partial outcomes are returned in input order.
- File storage remains scan-based; SQLite receives the candidate planning path.

### Verification
- Full suite: **321 passed, 0 failed**.
- `npm run build` passes.
- 10K/50K scale benchmark completed with the bounded candidate path.
- Dependency audit completed with no high-severity production vulnerabilities.

---

## [4.7.0] — 2026-09-23

**Agent & Multi-Agent Memory** — plan §10 of the Master Development Plan.
Adds opt-in agent identity, attribution, scope-aware visibility, council/task
scope conventions, and trusted HTTP context resolution.

### Added
- **Agent attribution**: `agentType`, `agentVersion`, `conversationId`,
  `taskId`, and `runId` provenance fields, preserved by file and SQLite
  backends and snapshot import/export.
- **Ownership and access policy**: `owner` (`user`, `agent`, `project`,
  `organization`, `global`) and `access` (`private`, `shared`, `global`) on
  stored memories.
- **Agent mode**: opt-in fail-closed visibility for search, list, direct
  reads, updates, lifecycle operations, relationships, history, compression,
  maintenance, quality, audit, and snapshots.
- **Council conventions**: use existing scopes such as `agent:<id>`,
  `council:<name>`, and `task:<id>` with the existing eleven memory types.
- **Trusted HTTP context**: `createHttpServer` accepts an application-supplied
  `resolveAgentContext(req)` callback. It is never inferred from a public
  agent-id field or header.
- **`GET /agents/:id`**: non-content agent metadata and memory counts.
- **New environment variables**:
  | Variable | Default | Meaning |
  |----------|---------|---------|
  | `REMEMBRA_AGENT_MODE` | `0` | Enable fail-closed agent visibility policy |
  | `REMEMBRA_DEFAULT_ACCESS` | `global` | Default access for new memories |

### Security
- Private memories are never treated as authenticated merely because their
  payload contains an `agentId`; a host-authenticated context is required.
- Non-global direct access is scope-checked, including council and task
  scopes, so an agent cannot bypass retrieval filters with a guessed memory id.

### Tests
- Agent policy, attribution, persistence, snapshot, compression, summary, and
  HTTP resolver coverage in `src/test/agent.test.ts` and
  `src/test/http.test.ts`.
- SQLite attribution, ownership, access, and temporal round-trip coverage in
  `src/test/sqlite.test.ts`.

---

## [4.6.0] — 2026-09-23

**Observability & Evaluation** — plan §9 of the Master Development Plan.

### Added
- **Extended metrics**: `remembra_embedding_latency_seconds`,
  `remembra_llm_latency_seconds`, `remembra_storage_latency_seconds`,
  `remembra_provider_failures_total`, `remembra_token_usage_total`,
  `remembra_estimated_cost_usd`, `remembra_memory_count_active/archived/deleted`,
  `remembra_duplicate_rate`, `remembra_conflict_rate`,
  `remembra_stale_memory_rate` — all registered on the Prometheus
  registry (`GET /metrics`).
- **`GET /quality` endpoint** (auth-required): memory health dashboard
  reporting active/archived/deleted counts, duplicate/conflict/stale rates,
  lifecycle distribution, growth rate, and provider stats.
- **Evaluation harness** (`src/eval.ts`): Precision@K, Recall@K, MRR,
  NDCG@K, Hit Rate@K, latency percentiles over a query corpus.
- **Debug retrieval tracing** (`REMEMBRA_DEBUG_RETRIEVAL=1`): structured
  per-query pipeline logs covering normalize → candidate generation →
  keyword/vector scoring → RRF fusion → standing-instruction gate →
  MMR diversity → final selection.
- **Benchmark corpus** at `test-benchmarks/`: facts, preferences,
  contradictions, temporal, poisoning datasets with expected outcomes.
- **Baseline scores** at `test-benchmarks/baseline.json` for regression
  comparison.

### Changed
- `retrieval.ts`: emits `retrieval.debug` log event when
  `REMEMBRA_DEBUG_RETRIEVAL=1`.
- `service.ts`: new `quality()` method; `maintain()` reports
  `consolidation` findings in result.
- `http.ts`: `GET /quality` route added; `/quality` route label registered.
- `types.ts`: `SearchInput` / `ListInput` gain `includeExpired`,
  `includeFuture`, `includeQuarantined` flags.

### Tests
- 5 new tests in `src/test/eval.test.ts`
- 6 new tests in `src/test/benchmark.test.ts`
- 2 new tests in `src/test/security.test.ts` (quality endpoint)

---

## [4.5.0] — 2026-09-23

**Lifecycle & Memory Intelligence** — plan §8 of the Master Development Plan.
Introduces multi-signal decay, memory consolidation (duplicates, contradictions,
fragments), temporal knowledge fields, and a compression endpoint.

### Added
- **Multi-signal decay model** (`src/lifecycle.ts`): composite health score
  combining age, last-seen recency, importance, confidence, retrieval
  frequency, trust, and relationship strength. Configurable weights via
  `REMEMBRA_DECAY_WEIGHTS`; aging/archive thresholds via
  `REMEMBRA_HEALTH_AGE_THRESHOLD` / `REMEMBRA_HEALTH_ARCHIVE_THRESHOLD`.
- **Memory lifecycle states**: `active`, `aging`, `archived`, `quarantined`,
  `deleted`. Standing instructions and pinned memories are effectively immortal.
- **Consolidation detection** (`src/consolidation.ts`): exact-duplicate,
  near-duplicate (vector similarity ≥ threshold), contradiction (semantic
  opposition heuristic), and fragment (3+ short same-type memories within
  window) detection during `POST /maintain`.
- **Contradiction flagging**: detected contradictions set
  `meta.contradicted: true` on both memories; surfaced in search results.
- **Temporal knowledge fields**: `validFrom`, `validUntil`, `observedAt`,
  `supersededBy` accepted in store input; respected in search and list
  filters (`includeExpired`, `includeFuture`).
- **`POST /memories/compress`** endpoint: LLM-assisted compression of
  fragmented memories into a compact representation with provenance.
- **Search/list temporal filtering**: new query params
  `includeExpired`, `includeFuture`, `includeQuarantined`,
  `includeArchived`.
- **New env vars**:
  | Variable | Default | Purpose |
  |----------|---------|---------|
  | `REMEMBRA_DECAY_WEIGHTS` | auto | semicolon-separated `key=value` weights |
  | `REMEMBRA_HEALTH_AGE_THRESHOLD` | `0.35` | health score for aging transition |
  | `REMEMBRA_HEALTH_ARCHIVE_THRESHOLD` | `0.15` | health score for archive transition |
  | `REMEMBRA_AGE_THRESHOLD_DAYS` | `30` | days without activity before aging consideration |
  | `REMEMBRA_AGING_BOOST` | `-50` | search score penalty for aging memories |
  | `REMEMBRA_DUP_SIMILARITY` | `0.92` | vector similarity threshold for near-dupes |
  | `REMEMBRA_FRAGMENT_WINDOW_DAYS` | `7` | lookback window for fragment detection |

### Changed
- `MaintainResult` now includes a `consolidation` field with findings.
- `Memory` interface extended with `meta`, `validFrom`, `validUntil`,
  `observedAt`, `supersededBy`.
- `StoreInput` Zod schema extended with temporal fields and meta.
- `SearchInput` and `ListInput` extended with temporal filter flags.
- `POST /maintain` now runs consolidation analysis and flags contradictions.

### Tests
- 14 new tests in `src/test/lifecycle.test.ts`
- 9 new tests in `src/test/consolidation.test.ts`
- 7 new tests in `src/test/temporal.test.ts`

---

## [4.4.0] — 2026-09-23

**Security & Memory Integrity** — plan §7 of the Master Development Plan.
Hardens Remembra against malicious input, memory poisoning, and abuse with
HTTP-level protections and a sensitive-data policy engine.

### Added
- **Rate limiting** (`src/rate-limiter.ts`): per-API-key sliding window.
  Configurable via `REMEMBRA_RATE_LIMIT` (default 60) and
  `REMEMBRA_RATE_WINDOW_MS` (default 60000). Exceeded requests return 429
  with `Retry-After`. `/health`, `/metrics` unkeyed, and UI shell are exempt.
- **Secure response headers**: every JSON API response includes
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Strict-Transport-Security`, `X-XSS-Protection: 0`, `Referrer-Policy:
  no-referrer`, `Cache-Control: no-store`. Toggle off with
  `REMEMBRA_SECURE_HEADERS=0`.
- **CORS support** (`REMEMBRA_CORS_ORIGIN`): explicit origin allowed; wildcard
  rejected when an API key is set. `OPTIONS` preflight handled without auth.
- **Request timeouts** (`REMEMBRA_REQUEST_TIMEOUT_MS`, default 30s): in-flight
  requests exceeding the limit return 504.
- **Concurrency limits** (`REMEMBRA_MAX_CONCURRENT`, default 32): when the cap
  is reached, new requests return 503.
- **Prompt injection detection** (`src/injection-detector.ts`): pattern-based
  scan on every `store()` call flags attempts to override roles, leak system
  prompts, or manipulate metadata. Flagged memories carry `meta.injected: true`.
- **Sensitive data policy engine** (`src/sensitive-data.ts`): detects API keys,
  AWS credentials, private keys, passwords, and financial secrets. Policy modes:
  `allow` · `redact` · `reject` · `quarantine` (set via
  `REMEMBRA_SENSITIVE_POLICY`).
- **`GET /audit` endpoint** (auth-required): paginated audit event stream.
  Events include `memory.created`, `memory.updated`, `memory.archived`, etc.
- **New error codes**: `RATE_LIMITED` (429), `REQUEST_TIMEOUT` (504),
  `SERVICE_UNAVAILABLE` (503), `SENSITIVE_DATA` (400), `INJECTION_DETECTED` (400).

### Changed
- `MemoryBackend.getAudit()` optional method added to the interface.
- `Memory.meta` field added for V4.4 security flags (`injected`, `quarantined`).
- `StoreInput` Zod schema extended with optional `meta` object.
- HTTP server now applies secure headers and CORS to all JSON responses.

### New env vars
| Variable | Default | Purpose |
|----------|---------|---------|
| `REMEMBRA_RATE_LIMIT` | `60` | max requests per window per key |
| `REMEMBRA_RATE_WINDOW_MS` | `60000` | sliding window size |
| `REMEMBRA_REQUEST_TIMEOUT_MS` | `30000` | per-request timeout |
| `REMEMBRA_MAX_CONCURRENT` | `32` | simultaneous in-flight requests |
| `REMEMBRA_CORS_ORIGIN` | *(unset)* | allow this origin; `*` rejects with key |
| `REMEMBRA_SECURE_HEADERS` | `1` | set to `0` to disable |
| `REMEMBRA_SENSITIVE_POLICY` | `redact` | `allow` · `redact` · `reject` · `quarantine` |
| `REMEMBRA_INJECTION_PATTERNS` | *(unset)* | custom regex patterns, comma-separated |

### Tests
- 8 new tests in `src/test/security.test.ts`
- 6 new tests in `src/test/rate-limiter.test.ts`
- 8 new tests in `src/test/injection-detector.test.ts`
- 8 new tests in `src/test/sensitive-data.test.ts`

---

## [4.3.0] — 2026-09-23

**Storage & Index Architecture** — plan §6 of the Master Development Plan.
The flat-file backend is replaced by a SQLite-backed runtime while keeping
Markdown as the human-readable export format. Public APIs are unchanged.

### Added
- **SQLite backend** (`src/sqlite-backend.ts`): new `SqliteBackend` class
  implementing `MemoryBackend` with WAL mode, optimistic concurrency via
  `expectedVersion`, and full-text search backed by FTS5.
- **Schema**: `memories`, `memory_versions`, `memory_audit` tables with
  foreign-key relationships and indexes on scope, type, archived_at,
  updated_at, last_seen.
- **FTS5 full-text search**: keyword queries now use an FTS5 virtual table
  when available; graceful fallback to keyword-only scoring when the
  SQLite build lacks FTS5 support.
- **Embedding BLOB storage**: vectors are stored as raw `Float32Array` bytes
  in a `BLOB` column instead of comma-separated text in Markdown frontmatter.
- **CLI commands**:
  - `remembra export-markdown <dir>` — dump active memories as `.md` files
  - `remembra import-markdown <dir>` — import `.md` files into SQLite
  - `remembra backup <file>` — copy DB + write SHA-256 sidecar
  - `remembra restore <file>` — verify checksum and atomically replace DB
- **Auto-migration**: on first launch, legacy flat files are read and
  imported into SQLite; the old tree is moved to `<root>/.legacy/`.
- **10 new tests** covering SQLite CRUD, FTS search, embedding round-trip,
  history snapshots, and archive/revive lifecycle.

### Changed
- Default runtime backend switched from `MemoryStore` (flat files) to
  `SqliteBackend`. The file backend remains available for backward compat
  and export; existing `MemoryStore` tests continue to pass unchanged.

### Notes
- The `MemoryBackend` interface is unchanged — all HTTP endpoints, MCP
  tools, and dashboard behavior are identical.
- If FTS5 is unavailable on your SQLite build, retrieval degrades to
  keyword-only scoring without error.

---

## [4.2.0] — 2026-09-23

**Retrieval Engine** — plan §5 of the Master Development Plan. The monolithic
`search()` function is replaced by a staged multi-stage pipeline with
explainability, hybrid fusion, diversity, temporal parsing, and an
in-process embedding cache. Every existing `search()` call retains its
ranking; the new `searchQ()` entry point adds optional per-memory score
breakdowns.

### Added
- **Multi-stage retrieval pipeline** (`src/retrieval.ts`): normalize → hard
  filters → candidate generation → keyword scoring → vector scoring → RRF
  fusion → ranking modifiers → standing-instruction gate → MMR diversity →
  context selection.
- **Reciprocal Rank Fusion (RRF)** between keyword and vector signals with
  average-rank tie handling so tied items do not suffer positional bias.
- **Reranker interface** (`Reranker`, `identityReranker`, `EmbedReranker`)
  exported for future provider plugging; identity is the default so existing
  rankings are preserved.
- **MMR-lite diversity pass** that dampens redundant near-duplicate results
  in semantic mode (pool capped at `limit × 10` for O(K·N) bounded cost).
- **Retrieval explanations** (`SearchResults.explanations`): each memory gets
  a `{ components, totalScore, reasons }` breakdown when the caller sets
  `explain: true` on the query. HTTP `?explain=true` is wired end-to-end.
- **Temporal query parsing**: `latest [N]`, `recent [N]`, `before <date>`,
  `after <date>` recognised in the query string and applied as recency boosts
  or hard filters.
- **Embedding cache** (`embedCached`, `clearEmbedCache` in `embeddings.ts`):
  in-process TTL-based cache keyed by `(model, textHash)` — avoids redundant
  provider calls for repeated queries within the TTL window.
- **Confidence integrated into scoring** (user-decided during design):
  `confidence × 20` additive term alongside provenance/trust/retention.

### Changed
- `service.search()` now accepts `explain?: boolean` and returns it in the
  envelope when requested. HTTP `GET /memories/search?explain=true` surfaces
  the per-memory breakdown.
- `SearchQuery` gains optional `explain` field; `SearchResults` and
  `RetrievalExplanation` added to `types.ts`.

### Fixed
- Keyword and vector ranked lists use deterministic tie-breaking (id sort),
  eliminating input-order dependence in RRF positions.
- Embed reranker no longer overrides the RRF+modifier ranking; it is
  available as a composable hook for callers that opt in.
- Single-signal RRF short-circuit avoids unnecessary Map construction.

### Tests
- Six new tests in `src/test/retrieval.test.ts`: explain output, RRF tie
  fairness, temporal `latest`/`after` parsing, MMR deduplication, embed
  cache export shape. Full suite remains at 204 green.

## [4.1.1] — 2026-09-23

### Fixed
- Dashboard link picker: the relation-kind select no longer leaks the
  internal plan reference into its label (now just "Relation kind").
- Crash recovery: the `*.tmp` sweep is now age-gated (files younger than the
  stale-lock window are treated as in-flight writes, not orphans). The sweep
  could previously race a live atomic write under load and fail it with a
  spurious `ENOENT` on rename — a pre-existing intermittent flake in the
  concurrent-writes test. Crash orphans are still collected once they age
  past the window.

## [4.1.0] — 2026-09-23

**Memory Model & Provenance** — plan §4 of the Master Development Plan, plus
the structural §3 leftovers folded in per the version-collision decision
(formal metadata format, optimistic `expectedVersion`, UUIDv7). Backward
compatible for every pre-4.1 store: all new fields are additive, legacy shapes
migrate on read, and nothing is rewritten behind your back.

### Added — eleven semantic types (plan §4.1)
- **Type vocabulary 4 → 11**: `fact · preference · decision · constraint ·
  instruction · role · entity · relationship · event · history · observation`
  (was `fact · decision · role · history`). The four old types keep their
  exact semantics; new-type files are skipped — never deleted — by downgrade.
- Digest extraction, MCP tool schemas, HTTP validation, the dashboard
  (type filter, edit form, per-type badge colors ×11, graph legend derived
  from present types) and the Custom GPT action enum all cover the full set.

### Added — provenance & trust (plan §4.3, §4.5, §4.9)
- **`provenance` is a required object**: `{ sourceType, sessionId?,
  messageId?, agentId?, provider? }` — legacy `explicit`/`auto` strings
  migrate on read (`explicit` → `manual`, `auto` → `conversation`); digest
  extractions stamp **which LLM produced them** (`provider`).
- **Required `trust` classification**: `system +8 / verified +6 / trusted +2 /
  unverified −8` ranking points (`TRUST_POINTS`), derived from provenance when
  absent (conversation → `unverified`, system → `system`, else `trusted`).
  Direct stores stay `trusted`; digest extraction always lands `unverified`.
- **Instruction gate**: `role`/`instruction` memories earn the +1000 standing
  boost only at `trust ≥ trusted` — unverified ones stay listed, searchable
  and badged, but never surface first. Promote via the dashboard **Approve**
  button (→ `verified`) or `memory_update { trust }`; a trust change stamps
  `lastValidated` (new metadata field).
- **Required `confidence`** with sane legacy defaults (0.7 conversation /
  1.0 otherwise).

### Added — retention modes (plan §4.8)
- **`retention`**: `pinned · persistent · ephemeral · neverExpire` (absent =
  `decaying`). `pinned`/`neverExpire` are fully exempt from decay sweeps,
  `pinned` also gets +50 rank points, `persistent` is archivable but never
  auto-deleted; `role`/`instruction` never decay regardless. Editable from the
  dashboard form and `memory_store`/`memory_update`.

### Added — typed relations (plan §4.7)
- **`memory_relate` gains `kind`**: `supports · contradicts · supersedes ·
  refines · duplicates · related` (default `related`). Re-linking retypes the
  edge in place (never duplicates); backlinks carry the kind; legacy
  `related: [ids]` frontmatter migrates to kind `related` on read. Dashboard
  link picker shows a kind selector and kind chips.

### Added — storage & concurrency (plan §3.4, §3.5, §3.6, §4.2)
- **Spec-parsed YAML frontmatter** (`yaml@^2.9.1`) + zod validation on every
  read — YAML-ambiguous scopes/tags/sources now round-trip; the hand-rolled
  parser remains only as the legacy fallback.
- **Schema `version: 1 → 2`**: 4.0.x readers skip `version: 2` files (logged,
  never deleted) instead of honoring them without trust gating — downgrades
  can no longer silently bypass the instruction gate. 4.1.0 reads all
  pre-4.1 files unchanged.
- **Optimistic concurrency**: `memory_update`/`PUT` accept `expectedVersion`
  (compared against the fresh on-disk counter *inside the lock*) — mismatch →
  `CONFLICT` (HTTP 409), nothing written; every write bumps `revision`
  (exposed as JSON `version`).
- **UUIDv7 ids**: time-ordered, unique from entropy — the collision-scan
  retry loop is gone (legacy 8–32 hex ids remain valid).

### Changed
- **History reasons (plan §4.6)**: updates accept `reason` (≤500 chars),
  recorded as `{ reason, supersededAt }` in `.history/<id>/reasons.json`
  (encrypted with the tree) and returned by `memory_history` /
  `GET /memories/:id/history`.
- **Digest merges no longer inline** the `> superseded (…)` note into the new
  content — the pre-image snapshot in version history carries it, with the
  reason `digest merge (superseded by a newer extraction)`.
- **Retrieval ranking** gains the trust layer and pinned boost on top of the
  existing provenance/importance/recency/keyword layers.
- **Frontmatter layout**: `version` = schema guard, `revision` = per-memory
  write counter; `tags`, `provenance`, `relations` serialize as proper YAML
  structures; `embedding` as a comma scalar.
- Snapshot envelope exports `version: 2`; pre-4.1 snapshots (string
  provenance, untyped `related`) still import cleanly.

### Docs
- `storage.md` rewritten for the v2 format (field table, downgrade contract,
  reasons.json); `memory-model.md` covers all 11 types + provenance/trust/
  retention sections; `tools.md`, `public-api.md`, `architecture.md`,
  `lifecycle.md`, `ui.md`, `providers.md`, `chatgpt.md`, `security.md`,
  `clients.md` and the README updated to match.

### Verification
- **198 tests, 0 failures** — 15 new behavioral tests in
  `src/test/model.test.ts` (type round-trips, trust derivation + gate,
  expectedVersion CAS at service and HTTP level, legacy frontmatter/snapshot
  migration, relation retype/removal, retention decay exemptions, ranking
  layers, snapshot round-trip) on top of the existing suite.

## [4.0.1] — 2026-09-23

**Foundation & Correctness** — the non-breaking subset of the Master
Development Plan's §3 milestone (4.0.0 already shipped as the dashboard
release; per the split decision, structural items — formal metadata format,
optimistic `expectedVersion`, UUIDv7 — land in 4.1.0 "Memory Model &
Provenance" instead).

### Added — provider reliability (plan §3.7)
- **`src/provider.ts`**: every LLM/embedding call now runs through one
  policy — per-attempt **timeout** (`REMEMBRA_PROVIDER_TIMEOUT_MS`, 60s),
  **bounded retries** with capped exponential backoff
  (`REMEMBRA_PROVIDER_RETRIES`=2, `REMEMBRA_PROVIDER_BACKOFF_MS`=250; only
  network/408/429/5xx — 4xx fails fast), an **overall wall-clock budget**
  (`REMEMBRA_PROVIDER_BUDGET_MS`, 180s), and **cancellation** via
  `AbortSignal`. A hung provider could previously block a store/digest call
  **forever** (bare `fetch`); now it is bounded and observable.
- **Error normalization**: new `PROVIDER_TIMEOUT` code (HTTP **504**);
  exhausted retries, network failures, malformed bodies/vectors and
  cancellations normalize to `LLM_ERROR` (502). Digest rethrows already-
  classified errors instead of double-wrapping them.
- **Cancellation end-to-end**: an HTTP client disconnecting mid-digest aborts
  the in-flight provider call (and stops retrying) — signal plumbed
  `res.close → service.digest → extract/merge/embed → fetch`.
- **Response shape guards**: missing `choices[0].message.content` /
  `content[0].text` / `message.content`, non-JSON bodies, and junk embedding
  vectors are rejected as `LLM_ERROR` — never half-parsed.
- New log events: `provider_retry`, `provider_failed`, `provider_cancelled`
  (low-cardinality fields only — no URLs/keys/bodies, log-hygiene rule).

### Added — read-side metadata validation (plan §3.4 / §3.8)
- Every read now validates the parsed object (`store.parse`):
  - **skip** (file untouched, logged once as `memory_parse_skipped`):
    broken frontmatter, non-numeric or **future schema version**, bad id,
    unknown type, scope with `..`, empty content — unknown-version files from
    a newer Remembra are never served;
  - **normalize** (served, logged once as `memory_normalized`):
    importance clamped 1–5 (non-numeric → 3), confidence clamped 0–1,
    unparseable dates fall back instead of propagating `NaN` into decay
    math, id/filename mismatch resolves to the filename, bad
    provenance/embedding/related entries are dropped or filtered.
- **ID allocation tested** (plan §3.6/§3.8): collision → fresh-id retry
  (via a new `idGen` store test hook), exhaustion → `CONFLICT`; an existing
  memory is never overwritten.

### Added — tests & docs (plan §3.8 / §3.1)
- `src/test/foundation.test.ts` — 23 tests: provider retry/timeout/budget/
  cancel/normalize, malformed LLM & embedding responses, invalid-type/
  future-version/unsafe-scope/empty-content skips, NaN-proof clamping,
  warn-once behavior, simultaneous writes across instances,
  delete-during-search, archive/revive races (single-tree invariant),
  ID collision + CONFLICT, a seeded **serialization property test**
  (40 random memories round-trip byte-faithfully), and HTTP
  client-disconnect cancellation. **160 → 183 tests.**
- New **`docs/public-api.md`** (stability contract: tools, HTTP routes,
  error→status table, snapshot format, CLI, provider policy) and
  **`docs/storage.md`** (layout, file format field table, read-validation
  rules, history) — completing the §3.1 audit doc list alongside the existing
  architecture/memory-model/security/providers docs.
- Updated: providers (policy envs + bounded failure behavior), clients
  (env index), observability (new events), README docs table.

## [4.0.0] — 2026-09-23

**v4 — the complete web dashboard**, shipped as one release: every read and
write surface of Remembra in a modern gold-on-charcoal UI (dark default,
light-mode toggle), served by the same `--http` binary with zero new
dependencies.

### Added — dashboard
- **Full web UI at `/`** — hash-routed SPA, hand-written TypeScript compiled
  to native ES modules by the existing `tsc` (no bundler, no framework):
  - **Memories**: debounced search, type/scope/archived filters,
    pagination, type badges, tags, importance, relative ages.
  - **Detail**: metadata grid, tag chips, related + backlinks with a link
    picker, Archive/Revive, Delete (confirm dialog), lazy **History**
    panel with unified diffs (current version open).
  - **Forms**: create/edit (type, content, scope, tags, importance,
    confidence, source) — scope edits move the file, content edits snapshot
    history.
  - **Roles auditor** with an instructions-first warning banner.
  - **Graph**: force-directed canvas of `related()` edges — drag, click to
    open, legend, gold-ringed role nodes.
  - **Digest**: transcript box → LLM extraction with result breakdown and
    provider-setup hints.
  - **Ops**: health card, stat tiles with 5-minute sparklines (requests,
    errors, p95 computed from the Prometheus histogram buckets, searches,
    stores, cache hit %), Run maintain, Export/Import buttons.
- **Theming** — CSS-variable design system, **dark default**, light mode via
  the header toggle (persisted in `localStorage`), gold `#d4af37` accents,
  system fonts, responsive/off-canvas sidebar,
  `prefers-reduced-motion` respected.

### Added — write API (drives the dashboard; CLI/MCP parity)
- **`memory_update`** MCP tool + **`PUT /memories/:id`** — partial patch
  (type/content/scope/tags/importance/source/confidence); empty patch and
  unsafe scopes rejected; content changes snapshot the pre-image to history
  and re-embed fail-open; scope changes move the file between trees without
  dual-homing (old path unlinked, recovery reconciles a crash between the
  two writes).
- **`memory_archive` / `memory_revive`** MCP tools + **`POST
  /memories/:id/archive|revive`** — manual lifecycle alongside automatic
  decay; archived memories drop out of default list/search until revived
  (**12 MCP tools total**, was 9).
- **`GET /snapshot` + `POST /import`** — HTTP parity with `remembra
  export`/`remembra import` (same handlers; whole-file Zod validation stays
  atomic, idempotent on re-import).

### Security (dashboard static serving)
- `/` + `/ui/*` serve an extension whitelist from `dist/ui/` only:
  decode-then-**path-containment** check, regular files, generic 404 —
  traversal pen tests (`..`, `%2e%2e`, `%2f`, NUL, absolute, non-whitelisted
  extensions) in `src/test/ui.test.ts`.
- **CSP with no `unsafe-inline`** on HTML (`default-src 'none'`,
  same-origin script/style/API only) + `nosniff`; the shell contains no
  inline script or style at all.
- Shell/assets are unauthenticated like `/health` (static bytes, zero data);
  every API call the page makes still requires the key, entered once and
  kept in **`sessionStorage`** (per-tab, never persisted).
  `REMEMBRA_UI=0` disables UI serving entirely.
- New metrics route labels: `ui` (static shell), `data_io`
  (`/snapshot`/`/import`); `memory_sub` now also covers `archive`/`revive`.

### Changed
- Build: `tsc && node scripts/copy-ui.mjs` (copies `src/ui/index.html` +
  `styles.css` into `dist/ui/`; `dist/ui` ships in the npm package).
- Docs: new **`docs/ui.md`**; tools reference (now 12 tools), README route/
  tool tables + dashboard quick start, clients/chatgpt/security/
  observability updated for the new routes, labels and `REMEMBRA_UI`.

### Tests
- 148 → **160**: static shell (CSP/nosniff/no inline script), asset MIME +
  nested modules, traversal pen test, shell-vs-data auth boundary, route
  labels, `REMEMBRA_UI=0`, service-level patch/scope-move/history/stale-
  vector clearing, archive/revive visibility, HTTP PUT/archive/revive
  validation, snapshot export → import roundtrip (same store idempotent +
  fresh store restore) and atomic invalid-snapshot rejection.

## [3.8.0] — 2026-09-23

**Phase 8 of the deep audit — Advanced Capabilities.** All five roadmap
items covered; both storage-altering features are **opt-in** (scope review:
plain markdown and byte-faithful storage remain the defaults).

### Added
- **Relationship graph** — `related: [ids]` frontmatter (directed, single
  write; backlinks derived at read time), `memory_relate` MCP tool
  (add/remove, targets validated, self-links rejected, idempotent), plus the
  missing read surfaces: **`memory_get`** / `GET /memories/:id` return a
  memory with resolved `related` + `backlinks`. Retrieval ranking untouched —
  graph is structure for the consumer, not a score.
- **Confidence scores** — `confidence: 0–1` frontmatter: explicit stores
  default `1.0`, digest extractions `0.7` (the extraction LLM may supply its
  own via the extended prompt/schema). Surfaced everywhere and carried through
  merge/export/import; **deliberately not ranked** — importance answers
  "relevant?", confidence answers "true?" (Phase 4 weight decisions stay
  closed).
- **PII redaction filter** (opt-in `REMEMBRA_REDACT=1`) — pattern filter at
  the *ingest layer* (`memory_store`, digest items, merge output): emails,
  Luhn-valid cards, SSNs, phone numbers, provider tokens / ≥40-char entropy
  blobs → typed placeholders (`<EMAIL>` …). Cards must pass Luhn; phone
  matching requires separators + 10–15 digits, so dates/versions never match.
  Irreversible by design; `remembra_redactions_total{kind}` + `redacted`
  log event (counts only, never matched text). Reverses the former "no PII
  filter" non-goal — documented with its limits in `docs/security.md`.
- **Encrypted storage mode** (opt-in `REMEMBRA_ENCRYPT_KEY`) — AES-256-GCM
  per file via `node:crypto` (zero deps): magic-header detection, transparent
  decrypt-on-read, encrypt-on-write, mixed plain/cipher trees supported;
  `remembra encrypt` / `remembra decrypt` migrate the whole tree (incl.
  history) idempotently under the advisory lock. Missing/wrong key fails
  **loudly**: `ENCRYPTED_NO_KEY` (HTTP 503, `/health` `storage` field) —
  never warn-skipped into silent partial results. GCM makes wrong-key ≡
  tampered. Reverses the former "no encryption at rest" non-goal with an
  explicit threat-model section (protects stolen backups / copied dirs, not
  a runtime attacker with your env).
- **Diff/history view** — content-changing updates snapshot the raw
  on-disk pre-image into `.history/<id>/<epochMs>-<seq>.md` first (content-
  equality gate: embedding backfills and linking never snapshot);
  `memory_history` MCP tool + `GET /memories/:id/history?limit=` return
  versions newest-first, each with a **unified line diff** against its
  predecessor (own ~60-line LCS, zero deps, cell-budget fallback for huge
  contents). Pruned to `REMEMBRA_HISTORY_LIMIT` (default 20, `0` disables);
  `.history` is never walked by `all()`/search.

### Changed
- Error classification gains `ENCRYPTED_NO_KEY` (503) and documents why it
  breaks the skip-malformed-file rule; `metrics` route enum gains
  `memory_sub` (the relate/history sub-routes).
- Extraction system prompt optionally returns `confidence` (0–1).

### Docs
`tools` (+3 tools, 9 total, encrypt/decrypt CLI), `memory-model`
(relationships, version history, metadata rows, layout incl. `.history`),
`security` (encryption + redaction sections replace the two reversed
non-goals, checklist items), `architecture` (encryption format, history
snapshot design, error table), `clients` (+3 env vars), `observability`
(+4 counters, `memory_sub`, `redacted` event), `chatgpt` (+3 routes),
`lifecycle` (merge → history cross-ref), README (9 tools, 11 routes).

### Tests
- **148 tests** (+16: redaction patterns + false-positive guards + service
  on/off, digest redaction & confidence pass-through, confidence round-trip,
  relations incl. backlinks/validation/idempotence/persistence, diff unit,
  merge → snapshot → diff view, embedding-gate + limit pruning, encryption
  round-trip / missing-key loud failure / wrong-key / mixed trees /
  idempotent both-way migration incl. history, HTTP GET/relate/history
  routes + `memory_sub` metric label). Suite verified stable across 3
  consecutive runs.

## [3.7.0] — 2026-09-23

**Phase 7 of the deep audit** — observability. All five roadmap items
covered (error-rate alerting taken as the *pragmatic substrate*: counters +
documented rules, no built-in notifier — decided in scope review).

### Added
- **Structured JSON logging** (`src/log.ts`) — every server-side event goes
  through one logger on **stderr** (stdout stays reserved for MCP stdio/CLI).
  Format: `REMEMBRA_LOG=json|text` forces it; unset → auto — JSON when stderr
  is piped (containers, CI, shippers), text on a TTY. Text mode prints the
  exact legacy strings, so existing greps and the Phase 2/3 tests still hold.
  JSON lines carry `{"ts","level","event","msg",...fields}`.
- **`GET /metrics`** (`src/metrics.ts`) — zero-dependency Prometheus text
  endpoint: request/digest/search/cache counters, latency histograms,
  `errors_total{code,transport}`, cache-entry gauge, `remembra_info`. Route
  labels are a fixed low-cardinality enum (never raw paths). Sits **after**
  the API-key check — keyed deployments must not leak counters; `/health`
  stays exempt.
- **Search query logging** — one structured `search` event per call (scope,
  term count, results, limit, `duration_ms`). Raw query text only under
  `REMEMBRA_DEBUG` (Phase 2 log-hygiene rule unchanged).
- **`/health` readiness probe** — now runs a real storage read: `200 ok`
  with `version`/`uptime_s`/`storage`/`cache` fields, **`503 unready`** with
  the failing error code when storage cannot be read — the probe fails
  instead of lying. Field `status:"ok"` kept for existing consumers.
- **Alerting infrastructure** — `docs/observability.md`: metric reference,
  scrape config (incl. `x-api-key`), and ready-to-paste Prometheus rules
  (down, internal error rate with 4xx excluded, readiness, lock contention,
  search p95, cache thrash). No built-in notifier by design: a local tool
  alerts through the operator's existing stack.
- `src/version.ts` single-sources `VERSION` (MCP server id, `/health`,
  `remembra_info`); a test pins it to `package.json`.

### Fixed
- **Prometheus bucket labels** — histogram series emitted `{le="…"route="…"}`
  (missing comma), caught by the exposition-format test.

### Changed
- Conversion to `logEvent` at 8 sites (listening banners, shutdown, parse
  skip, crash recovery, embedding/touch/merge/decay failures) — messages
  unchanged in text mode.

### Tests
- **132 tests** (+13: log formats + auto-detection, `/metrics` content,
  label enum + exposition grammar, auth on `/metrics`, counter movement for
  store/search/cache, MCP + HTTP error counters, hygiene-first query logging
  (and `REMEMBRA_DEBUG` opt-in), healthy + broken-storage `/health`,
  version pin). Suite verified stable across 3 consecutive runs.

## [3.6.0] — 2026-09-23

**Phase 6 of the deep audit** — testing depth. All six roadmap items now
covered (traversal pen test, 413, and content-length checks already shipped in
earlier phases). The new tests found **three live production bugs**, fixed
here:

### Fixed
- **Cross-scope role leak (isolation, security-relevant)** — `search()`'s
  filter included `m.type === "role" || score > 0`, so a role scoped to
  *another project* (score 0 from the scope gate) was re-included and surfaced
  in **every** project's searches — a cross-project prompt-injection vector.
  No existing test pinned it; a Phase 6 property test caught it on round 1.
  Roles now surface within their scope (global or current), foreign-scope
  roles are gated like everything else — code now matches what
  `docs/providers.md` already promised ("memories from other scopes are never
  returned"). Trust-model + role docs updated in four places.
- **Sibling lock steal** — a fresh `.remembra.lock` carrying this process's
  own pid was treated as stale and stolen instantly: a second `MemoryStore`
  instance in the same process broke mutual exclusion. Own-pid + fresh now
  waits (a live sibling may hold it); abandoned own-pid files are still
  recovered by the age rule (`REMEMBRA_LOCK_STALE_MS`).
- **Poisoned recovery** — if the first-ever access failed (e.g.
  `LOCK_TIMEOUT`), the rejected recovery promise stayed cached and *every*
  later operation re-threw it forever. Failures now clear the promise so
  recovery is retryable.

### Added (tests — 15 new, **119 total**)
- **Concurrency stress**: the lock regression above (wait-not-steal +
  age-rescue + retryable recovery); two store instances hammering one root
  (51 interleaved store/all/get/update/archive/revive ops — no dual-homed
  ids, exact file counts); concurrent reads while writing (no throws, no torn
  data).
- **Traversal angles**: digest path with the caller skipping validation —
  both inherited and per-item evil scopes rejected as `INVALID_INPUT`, nothing
  written outside the root.
- **Large payloads**: 2 MiB content round-trip over HTTP + searchable;
  declared overflow → 413 with the server proven still alive; mid-body
  overflow with *no* content-length (streaming counter path).
- **Malformed recovery**: four corruption shapes (empty, binary,
  unterminated frontmatter, no frontmatter) skipped-but-*preserved*,
  idempotent across repeated passes, list/search survive.
- **Cross-scope under load**: 4 scopes × (10 stores + 1 digest) written
  concurrently with globals — exact per-scope totals, zero sibling leakage in
  list and search.
- **Property-based scoring** (seeded LCG, zero new deps, both modes): roles
  rank first & scopes never leak; determinism + input-order independence;
  importance/recency/provenance monotonicity (raising any never lowers rank);
  limit bounds → unique subset of input. ~200 random rounds per run.

### Docs
`memory-model`, `security` (trust model now notes the cross-project rule),
`providers`, `clients`: "roles always surface" qualified with scope.

## [3.5.0] — 2026-09-23

**Phase 5 of the deep audit** — performance & scalability.

### Added
- **mtime-validated LRU parse cache** (audit: in-memory cache for parsed
  memories + the lazy-loading item deferred from Phase 4) — reads cost one
  `stat()` when the file hasn't changed (validated by mtime+size, so writers
  in *other* processes are caught automatically); writes refresh their own
  entry, deletes/renames evict. Configurable via `REMEMBRA_CACHE_SIZE`
  (default 10000 entries, `0` disables); `store.cacheStats()` exposes
  size/capacity. The directory walk still runs every query — discovering
  new/deleted files is its job.
- **Pagination** (audit: paginate `/memories`) — `offset`/`limit` on
  `GET /memories` and the `memory_list` MCP tool (opt-in: absent = full list,
  so existing clients don't break), `total` always returned, and a
  `Showing X–Y of Z` text header when paginated. Invalid query params fall
  back to unpaginated behavior.
- **Chunked streaming** (audit: streaming large search results) — list/search
  responses estimated ≥ 64 KiB stream as chunked JSON (no `content-length`,
  item-per-write); smaller responses keep the Phase-1 Content-Length shape.

### Declined with evidence
- **Vector index (FAISS/HNSW)** — native dependencies for double-digit-ms
  savings: the new benchmark measures brute-force cosine over **10,000 ×
  768-dim vectors in ~32 ms**. Revisit at >50k vectors or p95 >100 ms;
  rationale and both thresholds documented in `docs/architecture.md`, seam
  identified (`MemoryBackend` + rebuildable index over frontmatter vectors).

### Added (tests)
8 Phase-5 tests: cache staleness (external edit), cross-instance coherence,
validated-hit proof (read is skipped), LRU capacity/disable, pagination
(service + HTTP + schema), chunked-vs-Content-Length streaming, and the
10K×768 brute-force benchmark with a <1000 ms ceiling. **104/104 total.**

## [3.4.0] — 2026-09-23

**Phase 4 of the deep audit** — retrieval & memory quality.

### Changed
- **Exponential recency decay** — ~30-day half-life replaces the linear ramp
  that hit a hard zero at 60 days (audit #20): a 60-day-old memory now earns
  ~5 points instead of 0, and old-but-important facts stop falling off a
  cliff. Future-dated files clamp to "fresh"; invalid dates score 0.
- **Importance normalized across modes** — keyword mode drops ×10 → ×4 to
  match semantic mode (audit: "same memory ranks differently depending on
  embedding enablement"). The delta for importance 1→5 is now identical
  (+16) in both modes.

### Added
- **Provenance weighting** (audit: "source stored but never ranked") —
  memories carry `provenance: explicit | auto` in frontmatter: direct
  tool/API stores are `explicit` (+10 in ranking, both modes), digest
  extractions are `auto`. Pre-3.4.0 files have no field and score neutrally.
  Preserved through export/import.
- **Fuzzy dedup fast path** (audit: "dedup tolerance for fuzzy matches") —
  three dedup tiers now: exact → textual near-identity (Sørensen–Dice ≥ 0.9
  over bigrams; punctuation/case/typos) skipped **without an LLM call** →
  LLM merge for everything semantically evolved. Changed quantities
  (100→500 rpm, v2→v3) are explicitly *not* near-duplicates — they always
  reach the merge arbiter. Works against active, revives archived, and
  dedupes within a single digest batch.
- `docs/memory-model.md`: dedup tiers, corrected ranking weights, provenance
  row, stale "8-char id"/"embeddings planned for v2" text fixed.

### Deferred (recorded, not dropped)
- **Lazy loading for >10K stores** (audit Phase 4, P2) — the mechanism that
  actually serves this is the parsed-memory cache scheduled for Phase 5
  (performance); building a separate metadata index now would duplicate it.
  Tracked here per scope decision.

### Added (tests)
10 Phase-4 tests: decay curve + half-life + no-cliff, importance-delta
equality across modes, provenance deltas + ordering + persistence + snapshot
round trip, fuzzy skip (punctuation/typo/quantity guard), in-batch dedup,
archived revive, cross-scope isolation. **96/96 total.**

## [3.3.0] — 2026-09-23

**Phase 3 of the deep audit** — architecture: swappable backend, cross-process
locking, crash recovery, structured errors.

### Added
- **`MemoryBackend` interface** (`src/backend.ts`) — `MemoryService` now
  depends on the storage contract, not the file store; a DB backend can be
  dropped in without touching service/transport code. Tested against an
  in-memory implementation. Fixes audit Phase 3 item.
- **Advisory file locking** — `<root>/.remembra.lock` (`O_EXCL` create) around
  every mutation *including its read*, plus an in-process FIFO queue. Stale
  locks (dead pid or older than `REMEMBRA_LOCK_STALE_MS`) are stolen;
  waiters fail with typed `LOCK_TIMEOUT` after `REMEMBRA_LOCK_TIMEOUT_MS`.
  Fixes audit Phase 2 item (concurrent writers) and closes the
  touch-vs-archive resurrection window.
- **Crash-recovery pass** (the audit's "journal", recovery-pass flavor —
  documented rationale in `docs/architecture.md`): on first access per
  process, deletes orphaned `*.tmp` files and reconciles ids left in *both*
  active and archived trees by an interrupted archive/revive (finding #19);
  newest `updatedAt` wins. Logged when it does anything.
- **Structured error classification** — `RemembraError` with stable codes
  (`INVALID_INPUT`, `SNAPSHOT_INVALID`, `SCOPE_ESCAPES_ROOT`, `NOT_FOUND`,
  `CONFLICT`, `LOCK_TIMEOUT`, `IO_ERROR`, `LLM_ERROR`). HTTP maps codes →
  statuses and includes `code` in error bodies (423 for locked, 502 for LLM
  failures); MCP tools return `[CODE] message` with `isError: true`; raw fs
  failures wrap as `IO_ERROR`. Fixes audit Phase 2 item.
- **`docs/architecture.md`** — backend seam, locking model, recovery pass,
  error-code table, schema-versioning notes.

### Changed
- `archive()` now bumps `updatedAt` (state change updates recency; also makes
  crash-recovery tie-breaks deterministic).
- All six MCP tool handlers catch and classify failures instead of throwing
  through the SDK.

### Added (tests)
15 Phase-3 tests: non-file backend swappability, lock release/steal/timeout,
HTTP 423, mixed-concurrency single-tree invariant, tmp + both recovery
directions, error codes on every boundary, `formatToolError`/`statusFor`
units. **86/86 total.**

## [3.2.0] — 2026-09-23

**Phase 2 of the deep audit** — data integrity, portability, and shared schemas.

### Added
- **`remembra export <file>.json` / `remembra import <file>.json`** — full
  snapshot backup incl. archived memories. Import validates the *whole* file
  before writing (atomic rollback on any invalid entry) and is idempotent
  (existing ids and exact duplicates are skipped). Fixes audit #8.
- **Schema version field** — every memory file now carries `version: 1` in
  frontmatter; files without it (v1–v3.1) parse as v1. Fixes audit #10.
- `REMEMBRA_DEBUG=1` — opt-in storage-root path logging.

### Fixed
- **Log hygiene (audit #7)**: startup no longer prints the storage root path
  (gated behind `REMEMBRA_DEBUG`); embedding errors truncated to 200 chars;
  swallowed `touch()` errors now logged (audit #15); unparseable memory files
  warn once instead of being silently skipped.
- **Simultaneous digests** — digest runs are serialized through a lock, so
  parallel sessions can no longer double-store duplicates.
- **Merge LLM failure fails open** — a failed merge stores the new fact fresh
  instead of aborting the digest mid-way (never lose data).
- **Shared input schemas (audit #13)** — MCP tools, HTTP routes and the
  service all parse the same Zod shapes from `types.ts` (single source of
  truth; the `type` enum is no longer declared twice).
- `?limit=abc` on `/memories/search` no longer yields empty results (NaN guard).

### Changed
- MCP `memory_store` now applies `.default()` for `tags`/`importance` at the
  schema layer (behavior unchanged; validation moved to shared schemas).

### Added (tests)
12 Phase-2 tests: schema version + backward compat, malformed-file recovery,
empty transcript, extraction rollback, merge fail-open, parallel stores,
serialized digests, export/import round-trip, cross-id dedup, atomic import
rollback. **71/71 total.**

## [3.1.0] — 2026-09-23

**Security hardening** in response to the deep audit (`HILBRAS-MEMORY-DEEP-AUDIT.md`).

### Fixed
- **P0 directory traversal**: scopes containing `..` are rejected by validation,
  and `fileFor()` verifies the resolved path stays under `REMEMBRA_HOME`
  (defense in depth). Penetration test added.
- **Default-deny HTTP**: no API key → binds `127.0.0.1` only; non-loopback
  `REMEMBRA_HOST` without a key refuses to start.
- **Timing-safe API key comparison** (`crypto.timingSafeEqual`).
- **Request body size limit** (10 MiB default, `REMEMBRA_MAX_BODY`) → `413`.
- **Atomic writes** (temp file + `rename`) — crash can no longer leave
  half-written memory files.
- **ID length** 8 → 12 hex chars (2⁴⁸) + existence check on store (collision-safe).
- **Digest validation** on both transports (`DigestInput` Zod schema).
- **`Content-Length`** on all HTTP responses.
- `memory_list` MCP tool now exposes `includeArchived`; HTTP accepts
  `includeArchived=true`.

### Added
- `docs/security.md` — trust model (incl. role prompt-injection guidance),
  enforced protections, deployment checklist.
- 14 security tests (traversal pen test ×2, listen policy, body limit,
  digest validation, atomic-write leftovers, ID uniqueness).

## [3.0.0] — 2026-09-23

**Same content as 0.4.0** — version renumbered so the package version equals the
roadmap milestone (v3). No behavior changes.

## [0.4.0] — 2026-09-23

### Added
- **Memory lifecycle**: active → downrank → archived (unused 90d, `REMEMBRA_ARCHIVE_AFTER_DAYS`)
  → deleted (365d after archive, `REMEMBRA_ARCHIVE_TTL_DAYS`). Only archived memories are
  ever auto-deleted; roles never decay.
- **Decay piggybacks on search** (debounced 1/hour) — free file math; search hits refresh a
  memory's `lastSeen` clock, so used memories stay alive.
- **Contradiction merge**: digest LLM decisions are now `store | skip | merge` — evolved facts
  update the stored memory in place, preserving the old value as a
  `> superseded (date): ...` note. Fail-open: LLM failure stores fresh.
- **Revival**: digesting an exact duplicate of an archived memory revives it.
- **`memory_maintain` tool** + **`POST /maintain`** + **`remembra maintain` CLI** — explicit
  decay sweep + embedding vector backfill.
- `memory_list` gained `includeArchived`; archived memories show a `[archived]` flag.
- Store ops: `archive()`, `revive()`, `update()`, `touch()`; `archived/` storage tree.
- `docs/lifecycle.md` — full lifecycle + merge documentation.
- 11 new tests (decay, TTL delete, revival, merge decisions, backfill).

### Changed
- Storage stays file-based (decision: no SQLite — files remain source of truth).

## [0.3.0] — 2026-09-23

### Added
- **Session digest**: `memory_digest` tool + `POST /memories/digest` — LLM extracts
  facts/decisions/roles/history from a transcript and stores them.
- **Pluggable LLM provider**: `REMEMBRA_LLM=openai|anthropic|ollama` (+ `REMEMBRA_LLM_MODEL`).
- **Pluggable embeddings**: `REMEMBRA_EMBEDDINGS=openai|ollama|none` (default `none`).
- **Semantic search**: cosine similarity becomes the primary ranking signal when enabled;
  vectors cached in memory frontmatter (computed once on write).
- Scope and role rules remain hard gates in both ranking modes.
- Keyword fallback: memories without vectors, and any embedding API failure, degrade
  gracefully to keyword scoring (writes never blocked by embedding errors).
- Exact-match dedup in digest (type + scope + normalized content) — digests are idempotent.
- `docs/providers.md` — configuration guide for digest + embeddings.
- 18 new tests (digest, embeddings, retrieval modes, LLM output parsing).

### Changed
- `MemoryService` now accepts optional injected deps (embed/extract) for testing.

## [0.2.0] — 2026-09-23

### Added
- HTTP API mode: `remembra --http [--port N]` — same handlers as the MCP tools.
- Routes: `GET /health`, `POST /memories`, `GET /memories/search`, `GET /memories`,
  `DELETE /memories/:id`.
- API-key auth via `REMEMBRA_API_KEY` (`x-api-key` header or `Authorization: Bearer`).
- `REMEMBRA_PORT` env var as default port.
- Shared `MemoryService` core used by both MCP and HTTP transports.
- ChatGPT setup guide with full Custom GPT OpenAPI action schema (`docs/chatgpt.md`).
- HTTP and service test suites.

## [0.1.0] — 2026-09-23

### Added
- Initial release: MCP memory server for AI assistants.
- Four memory types: `fact`, `decision`, `role`, `history`.
- Hybrid scopes: `global` + per-project isolation (no cross-project leaks).
- File-based storage (`~/.remembra`, markdown + frontmatter), override via `REMEMBRA_HOME`.
- Layered retrieval: roles always surface → scope → importance → recency → keywords.
- MCP tools: `memory_store`, `memory_search`, `memory_list`, `memory_forget`.
- Client setup docs for OpenCode, Claude Code, Cline, and Kimi Code.
- Test suite (store round-trip, scope isolation, role priority, ranking, delete).
