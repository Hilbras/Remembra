# V6 Policy Model (V6-T02)

The executable form of [`v6-decisions.md`](v6-decisions.md). Implementation:
[`src/v6-policy.ts`](../src/v6-policy.ts). Decision fixtures:
[`src/test/v6-policy.test.ts`](../src/test/v6-policy.test.ts).

Every rule here traces to an approved decision. Where the architecture spec and
the ADR disagree, the ADR wins and the difference is recorded below.

## What a policy decision is

```ts
interface PolicyDecision {
  readonly effect: "allow" | "deny" | "redact" | "quarantine";
  readonly reason: /* one of 12 closed codes */;
  readonly policyVersion: "v6-policy/1.0.0";
}
```

Three properties, each mutation-checked rather than asserted. **19 mutations,
all caught** — 15 in the first pass and 4 more after three test holes were closed
(see [What mutation testing found](#what-mutation-testing-found)):

**The vocabularies are closed.** `effect` and `reason` are zod enums. An
unrecognised value is refused, not coerced to a default. `PolicyDecisionSchema`
is `.strict()`: an unknown field fails validation instead of being stripped,
because a decision that silently discards `{ effect: "allow", content: "..." }`
reports success while the extra field is gone — and a decision that can carry
content into an audit log is a leak that validates cleanly.

**Deny wins, and precedence is a fixed sequence.** Layers resolve in the order
`system → tenant → resource → principal → memory → provider`. Within that, the
*most restrictive* effect survives, and on a tie the *earlier* layer wins. Both
halves are load-bearing: restriction alone lets a permissive high layer paper
over a restrictive low one, and precedence alone lets input order decide the
answer.

**Nothing fails open.** An unknown layer source, a malformed layer, a
non-finite clock, an unknown field, or a version this build does not implement
all refuse. `parsePolicyDocument` refuses a version mismatch rather than
best-effort parsing it, because a policy written for a later engine may encode
a rule this one would silently drop — and a dropped rule is an allow.

## Evaluation order

The order is the contract, and one entry in it is counter-intuitive enough to be
worth stating.

1. **Structural validation.** Malformed layers throw `INVALID_INPUT`. This runs
   before any allow is reachable, so a malformed policy can never degrade into a
   permissive one.
2. **Resource binding.** A memory belonging to another tenant or project is
   denied with `tenant_mismatch` / `project_mismatch` — reasons that reveal
   nothing about whether the record exists.
3. **Operation capability.** Each operation class maps to one required
   capability (`read` → `tenant:read`, `export` → `tenant:export`,
   `provider_transmit` → `provider:transmit`). A missing capability denies.
4. **Provider egress.** `provider_transmit` requires clearance of at least
   `internal`.
5. **Sensitivity.** The memory's label must be covered by the identity's
   clearance. **An absent clearance covers `public` only** — never
   "unrestricted".
6. **Expiration.** Absolute and independent of `retention`: `neverExpire` does
   not make an expired memory usable.
7. **Legal hold.** Blocks `delete` only, and never grants access.
8. **Trust.** `unverified` content is denied by default.
9. **Explicit layers**, resolved by precedence then restriction.

### Why egress is checked before sensitivity

Step 4 sits above step 5 deliberately. With the natural ordering, a
`public`-clearance principal asking to transmit an `internal` memory is told
`sensitivity_denied` — which is true, but reports the wrong cause and makes the
egress rule unreachable in precisely the case it exists for. The caller needs to
learn that a third party was involved; the sensitivity reason does not say that.

A `secret` memory still needs `secret` clearance to transmit, so this ordering
weakens nothing: it changes which reason is reported, never whether the
operation is permitted.

## Axes

Trust, sensitivity, retention, and expiration are four independent axes. The
sharpest pair: trust is *not* sensitivity. `verified` content can be
`confidential`, and `unverified` content can still be useful inside a quarantine.

| Axis | Vocabulary | Answers |
|---|---|---|
| Sensitivity | `public` < `internal` < `confidential` < `secret` | What is the impact of disclosing this? |
| Trust | `unverified` < `trusted` < `verified` < `system` | How authentic is it, and how fit to influence retrieval? |
| Retention | `pinned`, `persistent`, `ephemeral`, `decaying`, `neverExpire` | How should it age? |
| Expiration | absolute instant `expiresAt` | When is it no longer valid for use? |

`RetentionMode` is V5's vocabulary unchanged (`src/types.ts`), so V6 adds
`expiresAt` beside it rather than redefining it.

## Two vocabularies that must not be conflated

`PRECEDENCE_ORDER` and `POLICY_SOURCES` are different sets and look similar:

- **`PRECEDENCE_ORDER`** — which *layer* speaks, in what order.
- **`POLICY_SOURCES`** — where a policy *document* came from:
  `builtin`, `host`, `policy_file`.

A document origin is not a precedence position. `V6-DEC-019` pins that they stay
disjoint, because merging them would make "where did this policy come from"
answerable as "which layer is this".

## A deviation from the architecture spec, recorded

Spec §4.2 proposes sensitivity bands `public | internal | confidential |
restricted`. The approved ADR §1 replaces the top band with `secret` and drops
`restricted`.

`restricted` read as a *mode* rather than a *level*, which is the property that
made inheritance and ordering ambiguous. The V5 quarantine path already expresses
restricted handling, so the behaviour is not lost — it moves to the `quarantine`
*effect*, where a decision can actually act on it. `V6-DEC-016` pins the
resulting four bands.

V6 stores are new, so no V5 record carries a `restricted` value and there is
nothing to migrate. If a V5 import ever does supply one, `SensitivitySchema`
refuses it, which is the intended fail-closed outcome rather than a silent
remapping to `secret`.

## What mutation testing found

19 mutations, all caught. Three of them survived the first pass, and each was a
gap in the *tests* rather than a defect in the evaluator. They are recorded
because the pattern recurs and the three are the three most consequential
defaults in the module.

**Nothing pinned the fail-closed default for an absent clearance.** Defaulting it
to `secret` — "absent means unrestricted", the exact permissive failure this
design exists to prevent — changed no test outcome, because every other test
either supplied a clearance or compared two labels. `V6-DEC-022` now walks all
four bands with no clearance declared: `public` is allowed, the other three are
denied.

**Nothing pinned that a missing capability denies.** Every test granted the
capability its operation needed, so removing the capability check entirely was
invisible. `V6-DEC-023` now asserts every operation class denies on an empty
capability list, and names `capability_missing` rather than a downstream cause.
`V6-DEC-024` adds the escalation shape: `tenant:read` must not imply
`tenant:export`, and `tenant:write` must not imply `provider:transmit`.

**The determinism test could not detect a wall clock.** It asserted that two
evaluations of the same input agree — which `Date.now()` also satisfies, because
two calls microseconds apart return the same millisecond. `V6-DEC-025` now
asserts the *bound*: with no injected clock a memory expiring in 1970+1 is still
usable, while `Date.now()` would report it long expired.

Two earlier results were also discarded rather than reported:

- **An overlapping run produced a false "caught".** Two harnesses were left
  running against the same source file at once. A mutation reported caught in the
  second run may have been caught by the *first* run's mutant still on disk. Both
  were killed and the whole set re-run serially, with the source proved
  byte-identical to its snapshot after every revert. The serial run found M3 and
  M8 surviving, which the overlapping run had reported as caught.
- **One mutation was unmeasurable, not passed.** Renaming the top sensitivity band
  to `restricted` failed to *compile*, so it produced no verdict either way. It
  was replaced with a behavioural mutation that reorders the bands instead — one
  that builds, and that the ordering assertions do catch.

The general lesson is the one this repo keeps relearning: a test that asserts two
calls agree is not a test that the clock is injected.

## What a caller cannot do

The request-field attack — asserting authority in a public field — is refused by
construction. `PolicyPrincipal.clearance` is *declared by the request* and is
only ever used as a ceiling to compare against the memory's label; it is never
treated as authority. A caller declaring `secret` while holding only `internal`
is compared, and denied.

Catching the *lie* — a clearance the identity context does not actually hold —
is V6-T04's job at the identity layer. This module's obligation is only that a
declaration never grants anything on its own, which it does not.

## Not in this module

- **Enforcement.** Nothing calls `evaluatePolicy` yet. Wiring it into the request
  path is V6-T04 through V6-T07; T02 defines the decision, not the pipeline.
- **The policy evaluator proper** (V6-T05) — combining authorization, trust,
  retention, and provenance across every axis with caching and explanations.
- **Audit emission** (V6-T08). The decision is audit-*safe* by construction here
  (closed, content-free, bounded) because these strings reach logs and metrics.
  Where they get emitted is T08's.
- **Persistence and migration.** `parsePolicyDocument` validates; V6-T02's
  "versioned" requirement is met by the explicit version field and the refusal to
  read a version it does not implement. Durable policy storage is T03.