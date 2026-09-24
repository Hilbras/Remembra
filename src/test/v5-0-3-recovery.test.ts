import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryService } from "../service.js";
import { MemoryStore } from "../store.js";
import {
  recoveryStateForStorage,
  transitionRecoveryState,
  type RecoveryEvent,
  type RecoveryState,
} from "../recovery-state.js";

test("REC-STATE-001: recovery transitions are deterministic and do not erase terminal states", () => {
  const states: RecoveryState[] = ["Recovering", "Healthy", "Degraded", "Failed", "ReadOnly"];
  for (const state of states) {
    assert.equal(transitionRecoveryState(state, "ready"), state === "Recovering" ? "Healthy" : state);
    assert.equal(transitionRecoveryState(state, "verified"), "Healthy");
    assert.equal(transitionRecoveryState(state, "recovery_started"), "Recovering");
    assert.equal(transitionRecoveryState(state, "read_only"), "ReadOnly");
    assert.equal(transitionRecoveryState(state, "failed"), "Failed");
  }
  assert.equal(transitionRecoveryState("Healthy", "degraded"), "Degraded");
  assert.equal(transitionRecoveryState("Degraded", "storage_error"), "Degraded");
  assert.equal(transitionRecoveryState("ReadOnly", "storage_error"), "ReadOnly");
  assert.equal(transitionRecoveryState("Failed", "storage_error"), "Failed");
  assert.equal(transitionRecoveryState("Healthy", "not_an_event" as RecoveryEvent), "Healthy");
});

test("REC-STATE-001: read-only mode blocks writes until explicit verification", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-v503-readonly-"));
  const service = new MemoryService(new MemoryStore(root), { embeddingProvider: "none" });
  try {
    service.enterReadOnly();
    assert.equal((await service.health()).state, "ReadOnly");
    await assert.rejects(
      () => service.store({ type: "fact", content: "must be blocked" }),
      (error: unknown) => (error as { code?: string }).code === "SERVICE_UNAVAILABLE",
    );
    service.verifyRecovery();
    assert.equal((await service.health()).state, "Healthy");
    await service.store({ type: "fact", content: "write after verification" });
  } finally {
    await service.shutdownBackgroundJobs();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("REC-STATE-001: a failing probe does not clear read-only state", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-v503-readonly-probe-"));
  const backend = new MemoryStore(root);
  const service = new MemoryService(backend, { embeddingProvider: "none" });
  try {
    service.enterReadOnly();
    (backend as unknown as { all: () => Promise<unknown> }).all = async () => {
      throw new Error("injected read failure");
    };
    const health = await service.health();
    assert.equal(health.status, "unready");
    assert.equal(health.state, "ReadOnly");
  } finally {
    await service.shutdownBackgroundJobs();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("REC-STATE-001: storage health maps to an explicit state", () => {
  assert.equal(recoveryStateForStorage({ ok: true }), "Healthy");
  assert.equal(recoveryStateForStorage({ ok: false }), "Failed");
  assert.equal(recoveryStateForStorage({ ok: true, readOnly: true }), "ReadOnly");
  assert.equal(recoveryStateForStorage({ ok: false, recovering: true }), "Recovering");
});
