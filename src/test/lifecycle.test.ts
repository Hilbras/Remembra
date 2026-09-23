import { test } from "node:test";
import assert from "node:assert/strict";
import { computeHealth, getLifecycleState, parseDecayWeights, agingScorePenalty } from "../lifecycle.js";
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

test("computeHealth: fresh high-importance verified memory scores high", () => {
  const m = makeMem({ id: "health-fresh", importance: 5, confidence: 1.0, trust: "verified" });
  const h = computeHealth(m);
  assert.ok(h > 0.6, `expected > 0.6, got ${h.toFixed(3)}`);
});

test("computeHealth: old unverified low-importance memory scores low", () => {
  const old = new Date(Date.now() - 365 * 86_400_000).toISOString();
  const m = makeMem({ id: "health-old", importance: 1, confidence: 0.3, trust: "unverified", createdAt: old, updatedAt: old, lastSeen: old });
  const h = computeHealth(m);
  assert.ok(h < 0.4, `expected < 0.4, got ${h.toFixed(3)}`);
});

test("computeHealth: pinned memory is effectively immortal (caller decides)", () => {
  const old = new Date(Date.now() - 730 * 86_400_000).toISOString();
  const m = makeMem({ id: "life-pinned", importance: 1, retention: "pinned", createdAt: old, updatedAt: old, lastSeen: old });
  const state = getLifecycleState(m);
  assert.equal(state, "active");
});

test("getLifecycleState: role/instruction never ages", () => {
  const old = new Date(Date.now() - 730 * 86_400_000).toISOString();
  const m = makeMem({ id: "life-role", type: "role", importance: 1, createdAt: old, updatedAt: old, lastSeen: old });
  assert.equal(getLifecycleState(m), "active");
});

test("getLifecycleState: quarantined memory returns quarantined", () => {
  const m = makeMem({ id: "life-quar", meta: { quarantined: true } });
  assert.equal(getLifecycleState(m), "quarantined");
});

test("getLifecycleState: archived memory returns archived", () => {
  const m = makeMem({ id: "life-arc", archivedAt: new Date().toISOString() });
  assert.equal(getLifecycleState(m), "archived");
});

test("getLifecycleState: low-health memory enters aging", () => {
  const old = new Date(Date.now() - 400 * 86_400_000).toISOString();
  const m = makeMem({ id: "life-age", importance: 1, confidence: 0.2, trust: "unverified", createdAt: old, updatedAt: old, lastSeen: old });
  const state = getLifecycleState(m, {}, { healthAgingThreshold: 0.5, healthArchiveThreshold: 0.3 });
  assert.equal(state, "aging");
});

test("getLifecycleState: fresh memory stays active", () => {
  const m = makeMem({ id: "life-fresh", importance: 4, trust: "verified" });
  const state = getLifecycleState(m, {}, { healthAgingThreshold: 0.5, healthArchiveThreshold: 0.3 });
  assert.equal(state, "active");
});

test("agingScorePenalty: returns 0 for non-aging states", () => {
  assert.equal(agingScorePenalty("active"), 0);
  assert.equal(agingScorePenalty("archived"), 0);
  assert.equal(agingScorePenalty("deleted"), 0);
});

test("agingScorePenalty: returns negative value for aging", () => {
  assert.ok(agingScorePenalty("aging") < 0);
});

test("parseDecayWeights: reads env, renormalizes", () => {
  const orig = process.env.REMEMBRA_DECAY_WEIGHTS;
  process.env.REMEMBRA_DECAY_WEIGHTS = "age=0.5;lastSeen=0.3";
  try {
    const w = parseDecayWeights();
    assert.ok(Math.abs(w.age - 0.5) < 0.01, `age=${w.age}`);
    assert.ok(Math.abs(w.lastSeen - 0.3) < 0.01, `lastSeen=${w.lastSeen}`);
    // Other weights distributed the remainder.
    assert.ok(w.importance > 0);
  } finally {
    if (orig === undefined) delete process.env.REMEMBRA_DECAY_WEIGHTS;
    else process.env.REMEMBRA_DECAY_WEIGHTS = orig;
  }
});

test("parseDecayWeights: invalid values are ignored", () => {
  const orig = process.env.REMEMBRA_DECAY_WEIGHTS;
  process.env.REMEMBRA_DECAY_WEIGHTS = "age=2.0;lastSeen=-1;importance=0.5";
  try {
    const w = parseDecayWeights();
    // importance is valid and set to 0.5.
    assert.ok(Math.abs(w.importance - 0.5) < 0.01, `importance=${w.importance}`);
    // age and lastSeen were invalid → they fell back to defaults but got renormalized.
    // The sum of all weights should be ~1.0.
    const sum = Object.values(w).reduce((s, v) => s + v, 0);
    assert.ok(Math.abs(sum - 1.0) < 0.01, `weights sum to ${sum}`);
  } finally {
    if (orig === undefined) delete process.env.REMEMBRA_DECAY_WEIGHTS;
    else process.env.REMEMBRA_DECAY_WEIGHTS = orig;
  }
});

test("computeHealth: retrieval count boosts score", () => {
  const m = makeMem({ id: "rec-test", importance: 2 });
  const h0 = computeHealth(m, {});
  const h1 = computeHealth(m, { retrievalCount: 50 });
  assert.ok(h1 > h0, "retrieved memory should score higher");
});

test("computeHealth: relation count boosts score", () => {
  const m = makeMem({ id: "rel-test", importance: 2 });
  const h0 = computeHealth(m, {});
  const h1 = computeHealth(m, { relationCount: 10 });
  assert.ok(h1 > h0, "well-linked memory should score higher");
});
