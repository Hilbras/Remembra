# Remembra V5.7.1 → V7.0.0 Roadmap

Status: **planning**. Phases 0–5 are folded into the existing V6 plan
([`v6-plan.md`](../tasks/v6-plan.md) / [`v6-todo.md`](../tasks/v6-todo.md)) rather than tracked twice;
this document is the umbrella and the record of *why* the fold happened.

## Why this is not a second V6 plan

The repository already had an approved, in-flight V6 plan: 26 tasks across 8
phases, security-first (policy model → request security → core runtime →
provider boundary → API domains → migration → reliability → observability →
release), with `docs/v6-architecture-spec.md` as its architecture contract and
`docs/v6-decisions.md` recording the ten decisions it freezes.

This roadmap proposed its own V6.0.0 "core architecture" phase after
V5.8.0–V5.14.0. Two plans cannot own one version slot, so on 2026-09-30 the
maintainer chose to **fold V5.8–V5.14 into the V6 plan as its Phases 1–5**, and
let this roadmap's later phases continue from V6.0.0. Nothing that was approved
is retired: T01–T03 remain done, and the ten architecture decisions stand.

The V5.8–V5.14 *intent* survives as work items in the V6 plan; the V5.x version
numbers do not. A V5.9.0 that "formalizes tenants" would be a minor release
changing security semantics, which is a breaking change wearing a minor's
clothes.

## Version line

```text
V5.7.1  (current, published)
  │
  ├── V5.7.x  architecture & release baseline        → V6 Phase 0
  ├── core boundary stabilization                    → V6 Phase 1
  ├── security & tenant isolation hardening           → V6 Phase 1
  ├── retrieval & context engineering                 → V6 Phase 2
  ├── distributed infrastructure isolation            → V6 Phase 3
  ├── recovery, backup & data integrity               → V6 Phase 4
  ├── performance & scalability                       → V6 Phase 5
  ├── API / SDK / MCP stabilization                   → V6 Phase 4
  │
  └── V6.0.0  core architecture          (security-first, see v6-plan.md)
        │
        ├── V6.1  extensibility & provider architecture
        ├── V6.2  observability
        ├── V6.3  advanced retrieval
        ├── V6.4  agent context infrastructure
        ├── V6.5  enterprise reliability
        ├── V6.6  developer experience
        ├── V6.7  ecosystem
        ├── V6.8  security & privacy 2.0
        └── V6.9  V7 preparation & stabilization
              │
              └── V7.0.0  platform architecture
```

Each V6.1+ phase remains **unplanned**. They are named here so the version line
is stable, not so they can be started: the pattern this repo has hit repeatedly
is that a named phase becomes an assumed authorization.

---

# Phase 0 — baseline (V5.7.1) — audited 2026-09-30

## 0.1 Version consistency — two defects found and fixed

| Location | Found | Now |
|---|---|---|
| `README.md` release badge + "Current release" line | claimed **5.0.2** while 5.7.1 was published and tagged | 5.7.1 |
| `package-lock.json` `version` and `packages[""].version` | **5.0.3** | 5.7.1 |
| `package-lock.json` peer dependencies | `redis` optional peer **absent entirely** | declared |

`package.json`, `src/version.ts` and `python/pyproject.toml` were already
consistent at 5.7.1, and `git describe` / `npm view` agree.

The README's *other* `5.0.2` references were left alone deliberately: lines that
name the release which introduced a documented behaviour ("V5.0.2 makes
project/user/agent selectors conjunctive") are historical records. Rewriting
those would edit history to fix a present-tense problem.

## 0.2 Repository health — measured, not asserted

| Measure | Value |
|---|---|
| Source modules | 65 (`src/*.ts`, 25,349 lines) |
| Test files | 100 (23,673 lines) |
| Largest module | `src/service.ts` — 3,111 lines |
| Next three | `sqlite-backend.ts` 1,548 · `store.ts` 1,446 · `retrieval.ts` 1,297 |
| Largest test file | `src/test/batch-idempotency.test.ts` — 1,127 lines |
| CI | **none** — `.github/` does not exist |

The largest four modules total 7,402 lines and are exactly the Phase 1 refactor
targets. That is the concrete shape of the "core architecture stabilization"
work, and it is why Phase 1 is scoped as **guards before moves**: a 3,111-line
`service.ts` cannot be relocated and regression-guarded in one step.

## 0.3 Public API inventory — not yet done

Every exported symbol classified as public / internal / experimental /
deprecated. Outstanding. `src/index.ts` is 889 lines and is the natural starting
point, but the inventory is a V6-T15 (API domains) deliverable, not a Phase 0
one.

## 0.4 Baseline gates — established and green

| Gate | Result |
|---|---|
| `npm test` | 995/995 |
| `npm run security:check` | 147/147 |
| `npm run recovery:check` | 52/52 |
| `npm run python:test` | 28 OK |
| `npm run docs:check` | 49 files |
| `npm run bench:gate` | passed |
| `npm audit --audit-level=high` | 0 vulnerabilities |
| Node | 18.20.8 |

**Every one of these is run by hand.** `scripts/release-gate.mjs` wires them
together and exits non-zero on failure, but nothing invokes it automatically —
recorded under the V5.7 T08 checkpoint and unchanged by this roadmap. This is the
single highest-leverage gap in the release process: a documented gate nobody
triggers is a script, not a guarantee.

---

# V6 phases 1–5 (folded from V5.8–V5.14)

Intent preserved, sequencing governed by [`v6-plan.md`](../tasks/v6-plan.md), which
already sequences these dependencies correctly. What changes is *how* they are
approached, per the maintainer's decision of 2026-09-30: **boundaries and guards
first, code moves only where a guard proves them.**

## Phase 1 — core boundaries and security hardening

From V5.8 (architecture) and V5.9 (security/tenant).

Target layering — `interfaces → application → domain`, with `infrastructure`
depended upon only through ports:

```text
Interfaces      HTTP · MCP · SDK · CLI · Python
Application     Memory · Retrieval · Context · Relation · Tenant · Lifecycle
Domain          Memory · Relation · Trust · Scope · Tenant · Authorization
Infrastructure  SQLite · Markdown · Redis · Embeddings · Jobs · Locks · Recovery
```

**Approach: guards, then moves.** The first deliverable is a dependency-direction
test — a static guard that fails if `domain/` imports `infrastructure/`, or if
`interfaces/` imports `domain/` directly. Only once that guard is green and
mutation-verified does any file move. A move that the guard can then prove safe
is a different proposition from a refactor whose safety is argued.

The security work (V5.9's content) is mostly **already done and gated**: the V5
suite has 147 security tests, the authorization pipeline is
auth-before-rate-limit, tenant identities are opaque, redaction is centralized,
errors are sanitized, paths are contained, snapshots strict, recovery
fail-closed. V6 Phase 1's security contribution is making the *pipeline*
explicit and adding the adversarial rows V5.9 names — tenant spoofing, ID
substitution, scope escalation, stale membership, authorization replay.

## Phase 2 — retrieval and context engineering

From V5.10. Substantially delivered by the 5.7.0 milestone (roadmap §31–§38):
hybrid lexical+vector retrieval, real IDF, exact dedup, superseded suppression,
one context budget object, configurable fusion weights, and a benchmark gate that
fails a release on a retrieval regression.

Outstanding and named: the temporal qualifier's **missing semantics** (audit S8 —
`latestCount` never limits, `beforeMs`/`afterMs` are never read), and the
benchmark set's known blind spots — no temporal query and no non-ASCII document,
so the gate cannot catch either class. Named as a gate gap rather than papered
over, because a stage that fails on correct code is not a gate.

## Phase 3 — distributed infrastructure isolation

From V5.11. Redis is already an optional peer dependency, not a devDependency,
and the core is already SQLite-plus-single-process. The work is making that
*structural* rather than incidental: `JobQueue`, `LockProvider`, `SharedState`,
`RateLimiter`, `WorkerBackend` as interfaces with local and Redis
implementations.

## Phase 4 — recovery and API stabilization

From V5.12 and V5.14. Recovery is already substantial (52 tests, fail-closed
restore gates, verified resume, signed tenant-migration manifests). API
stabilization is V6-T15 onward: one canonical contract shared by HTTP, the
TypeScript SDK, the Python SDK, MCP and CLI — which is where the 5.7.1 defect
pattern recurred three times, where a neighbouring layer forgot to forward a
field the feature added.

## Phase 5 — performance and scale

From V5.13. `bench:gate` exists with per-scenario tolerances and absolute and
relative latency bounds. Outstanding: the full 1K/10K/100K/1M matrix across
tenant counts, and P95/P99 documentation.

---

# Phases 6+ — named, not planned

V6.1 through V6.9 and V7.0.0 are recorded as version-line commitments only. Each
needs its own plan, its own decisions, and its own approval — the same bar
V6-T01 set, and the reason three of the V6 tasks this session were decisions
rather than code.

The V7.0.0 acceptance criteria in the original roadmap are sound and are kept
as the target. One structural addition this repo's history argues for:

- **A CI workflow.** Every gate in 0.4 is currently manual. V7.0.0's
  "architecture maturity" claim cannot be evidenced by a process nobody runs
  automatically.
- **A decision record per phase, not only per milestone.** Ten decisions were
  needed for V6.0.0's contracts alone; the later phases carry policy questions of
  the same weight.

---

## Release policy

Every completed phase ends in a complete release cycle: version bump across
`package.json` / `src/version.ts` / `python/pyproject.toml`, changelog, docs,
full gate, tag, GitHub Release, registry verification.

Two rules from this repository's history, both learned the hard way:

1. **A tag never moves once published.** `v5.6.0` was cut once and has stayed.
2. **Ask before publishing to npm or PyPI.** "continue" is not authorization.

PyPI remains unpublished past 5.5.1 — 5.6.0, 5.7.0 and 5.7.1 are npm-only
because no credential exists. That is a live gap in the release policy above,
not an oversight: the policy says "publish to NPM and GitHub Release", and this
project additionally ships a Python package it cannot currently release.

## Strategic principle

Adopted from the original roadmap, because it is the constraint that keeps the
rest honest:

```text
Do not make Remembra bigger just for the sake of making it bigger.

Make the Core smaller,
the boundaries clearer,
the APIs more stable,
the security stronger,
the retrieval more explainable,
the infrastructure more replaceable,
and the platform easier to operate.
```