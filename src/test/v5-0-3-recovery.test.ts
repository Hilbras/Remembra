import { test } from "node:test";
import assert from "node:assert/strict";
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

test("REC-STATE-001: storage health maps to an explicit state", () => {
  assert.equal(recoveryStateForStorage({ ok: true }), "Healthy");
  assert.equal(recoveryStateForStorage({ ok: false }), "Failed");
  assert.equal(recoveryStateForStorage({ ok: true, readOnly: true }), "ReadOnly");
  assert.equal(recoveryStateForStorage({ ok: false, recovering: true }), "Recovering");
});
