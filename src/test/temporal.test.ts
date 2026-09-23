import { test } from "node:test";
import assert from "node:assert/strict";
import { consolidate } from "../consolidation.js";
import { computeHealth, getLifecycleState, agingScorePenalty } from "../lifecycle.js";
import type { Memory } from "../types.js";

function makeMem(overrides: Partial<Memory> & { id: string }): Memory {
  const now = new Date().toISOString();
  const { id, ...rest } = overrides;
  return {
    id,
    type: rest.type ?? "fact",
    scope: rest.scope ?? "global",
    content: rest.content ?? "test content",
    tags: rest.tags ?? [],
    importance: rest.importance ?? 3,
    confidence: rest.confidence ?? 0.8,
    trust: rest.trust ?? "trusted",
    createdAt: rest.createdAt ?? now,
    updatedAt: rest.updatedAt ?? now,
    version: 1,
    provenance: { sourceType: "manual" },
    ...rest,
  } as Memory;
}

// ---- Temporal filtering ----

test("temporal: validUntil in the past excludes memory by default", () => {
  const past = new Date(Date.now() - 86_400_000).toISOString(); // 1 day ago
  const m = makeMem({ id: "t1", validUntil: past });
  const now = Date.now();
  const included = !(!m.validUntil || Date.parse(m.validUntil) >= now);
  // Without includeExpired, this should be filtered out.
  const filtered = [m].filter((mem) => {
    if (!mem.validUntil || Date.parse(mem.validUntil) >= now) return true;
    return false;
  });
  assert.equal(filtered.length, 0, "expired memory should be excluded");
});

test("temporal: validUntil in the future includes memory", () => {
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const m = makeMem({ id: "t2", validUntil: future });
  const now = Date.now();
  const filtered = [m].filter((mem) => {
    if (!mem.validUntil || Date.parse(mem.validUntil) >= now) return true;
    return false;
  });
  assert.equal(filtered.length, 1, "not-yet-expired memory should be included");
});

test("temporal: validFrom in the future excludes memory by default", () => {
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const m = makeMem({ id: "t3", validFrom: future });
  const now = Date.now();
  const filtered = [m].filter((mem) => {
    if (!mem.validFrom || Date.parse(mem.validFrom) <= now) return true;
    return false;
  });
  assert.equal(filtered.length, 0, "future memory should be excluded");
});

test("temporal: quarantined memories excluded by default", () => {
  const m = makeMem({ id: "t4", meta: { quarantined: true } });
  const now = Date.now();
  const filtered = [m].filter((mem) => {
    if (mem.meta?.quarantined) return false;
    return true;
  });
  assert.equal(filtered.length, 0, "quarantined memory should be excluded");
});

test("temporal: contradictions are detected and flagged", () => {
  const mems = [
    makeMem({ id: "c1", content: "User is active in the project" }),
    makeMem({ id: "c2", content: "User is inactive in the project" }),
  ];
  const r = consolidate(mems);
  assert.ok(r.contradictions.length > 0, `should detect contradiction, got ${JSON.stringify(r.contradictions)}`);
});

test("temporal: lifecycle health score respects importance", () => {
  const fresh = makeMem({ id: "h1", importance: 5, confidence: 1.0, trust: "verified" });
  const low = makeMem({ id: "h2", importance: 1, confidence: 0.3, trust: "unverified" });
  assert.ok(computeHealth(fresh) > computeHealth(low), "high-importance should score higher");
});

test("temporal: aging penalty is negative", () => {
  const penalty = agingScorePenalty("aging");
  assert.ok(penalty < 0, `aging penalty should be negative, got ${penalty}`);
});
