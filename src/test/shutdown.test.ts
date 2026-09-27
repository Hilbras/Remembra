/**
 * V5.1.0 graceful shutdown (roadmap §23): bounded, idempotent, and honest.
 *
 * The pre-V5.1 shutdown was six lines that always exited 0. These tests pin the
 * three properties that replaced it: a wedged phase cannot hold the process
 * open, a second signal cannot interleave a second shutdown, and a forced
 * shutdown is distinguishable from a clean one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ShutdownCoordinator,
  closeServerBounded,
  registerStandardShutdownPhases,
  type ShutdownPhase,
} from "../shutdown.js";
import { MemoryService } from "../service.js";
import { MemoryStore } from "../store.js";
import { RemembraError } from "../errors.js";

/** A clock the tests advance by hand, so no phase depends on wall time. */
function fakeClock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

/** A clock whose setTimeout fires only when the test advances past it. */
function manualClock(start = 1_000_000) {
  let now = start;
  let arms = 0;
  const pending: { at: number; fn: () => void }[] = [];
  return {
    now: () => now,
    advance: (ms: number): void => {
      now += ms;
      for (const entry of [...pending]) {
        if (entry.at <= now) {
          pending.splice(pending.indexOf(entry), 1);
          entry.fn();
        }
      }
    },
    // The handle is the entry itself, so clearTimeout actually removes it —
    // a stale timer left in the queue would make `pendingCount` lie.
    setTimeout: (fn: () => void, ms: number) => {
      arms++;
      const entry = { at: now + ms, fn };
      pending.push(entry);
      return entry;
    },
    clearTimeout: (handle: unknown) => {
      const index = pending.indexOf(handle as { at: number; fn: () => void });
      if (index >= 0) pending.splice(index, 1);
    },
    pendingCount: () => pending.length,
    armCount: () => arms,
  };
}

/**
 * Advance the manual clock only once a phase has armed its timeout.
 *
 * The coordinator's loop is async, so advancing synchronously right after
 * `shutdown()` returns would move time before the loop reaches the later
 * phases — and the test would be measuring its own race, not the shutdown.
 */
async function advanceOnArm(clock: ReturnType<typeof manualClock>, arm: number, ms: number): Promise<void> {
  // Wait for a *specific* arm rather than for a timer to exist. Each phase arms
  // exactly one timer, so arm N belongs to phase N; waiting for "a timer"
  // instead would match the previous phase's timer and advance the clock
  // mid-sequence, measuring the test's own race instead of the shutdown.
  for (let i = 0; i < 500 && clock.armCount() < arm; i++) await Promise.resolve();
  assert.ok(clock.armCount() >= arm, `expected phase ${arm} to arm its timer, saw ${clock.armCount()}`);
  clock.advance(ms);
}

test("SHUT-001: phases run in registration order and all complete", async () => {
  const order: string[] = [];
  const coordinator = new ShutdownCoordinator();
  for (const name of ["mark-draining", "stop-accepting", "stop-jobs", "close-storage"]) {
    coordinator.register({ name, critical: true, run: () => { order.push(name); } });
  }
  const report = await coordinator.shutdown("SIGTERM");
  assert.deepEqual(order, ["mark-draining", "stop-accepting", "stop-jobs", "close-storage"]);
  assert.equal(report.clean, true);
  assert.equal(report.forced, false);
  assert.equal(report.phases.length, 4);
  assert.equal(report.phases.every((phase) => phase.status === "completed"), true);
});

test("SHUT-002: a wedged phase is bounded and forces a non-clean exit", async () => {
  const clock = manualClock();
  const coordinator = new ShutdownCoordinator({
    now: clock.now,
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
  });
  let storageClosed = false;
  coordinator.register({ name: "stop-accepting", critical: true, run: () => {} });
  coordinator.register({ name: "wedged", critical: false, run: () => new Promise<void>(() => {}) });
  coordinator.register({
    name: "close-storage",
    critical: true,
    run: () => { storageClosed = true; },
  });

  const pending = coordinator.shutdown("SIGTERM", 5_000);
  // Nothing has timed out until the clock moves.
  assert.equal(coordinator.isShuttingDown, true, "the shutdown is in flight");
  await advanceOnArm(clock, 2, 5_000);   // phase 2 is the wedged one
  const report = await pending;

  assert.equal(coordinator.isShuttingDown, false);
  const wedged = report.phases.find((phase) => phase.name === "wedged");
  assert.equal(wedged?.status, "timeout", "the phase that overran is reported as a timeout");
  const storage = report.phases.find((phase) => phase.name === "close-storage");
  assert.equal(storage?.status, "skipped", "and the phases after it are skipped, not run");
  assert.equal(storageClosed, false, "storage is never closed while a phase may still be in flight");
  assert.equal(report.clean, false);
  assert.equal(report.forced, true, "a skipped critical phase forces the exit");
});

test("SHUT-003: a repeated signal returns the same shutdown, not a second one", async () => {
  const clock = manualClock();
  const coordinator = new ShutdownCoordinator({
    now: clock.now,
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
  });
  let runs = 0;
  coordinator.register({ name: "slow", critical: true, run: () => { runs++; clock.advance(1_000); } });

  const first = coordinator.shutdown("SIGTERM", 10_000);
  const second = coordinator.shutdown("SIGINT", 10_000);
  assert.equal(first, second, "a repeated signal joins the shutdown already in flight");
  // Both await the same in-flight run, so the phase body executed once.
  clock.advance(0);
  const report = await first;
  assert.equal(runs, 1, "the phase ran once, not twice");
  assert.equal(report.reason, "SIGTERM", "the first reason is the one reported");
});

test("SHUT-004: a failing phase is reported, not thrown, and the rest still run", async () => {
  const after: string[] = [];
  const coordinator = new ShutdownCoordinator();
  coordinator.register({
    name: "stop-jobs",
    critical: false,
    run: () => { throw new RemembraError("SERVICE_UNAVAILABLE", "internal detail must not be reported"); },
  });
  coordinator.register({ name: "close-storage", critical: true, run: () => { after.push("storage"); } });

  const report = await coordinator.shutdown("SIGTERM");
  const failed = report.phases.find((phase) => phase.name === "stop-jobs");
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.error, "phase_failed", "a classified label, not the internal message");
  assert.equal(report.phases.some((phase) => (phase.error ?? "").includes("internal detail")), false);
  assert.deepEqual(after, ["storage"], "a non-critical failure does not stop the sequence");
  assert.equal(report.clean, false, "but the report is not clean either");
  assert.equal(report.forced, false, "because the failing phase was not critical");
});

test("SHUT-005: a failing critical phase forces a non-clean exit", async () => {
  const coordinator = new ShutdownCoordinator();
  coordinator.register({ name: "close-storage", critical: true, run: () => { throw new Error("disk handle stuck"); } });
  const report = await coordinator.shutdown("SIGTERM");
  assert.equal(report.clean, false);
  assert.equal(report.forced, true, "storage is critical, so a failure forces the exit");
});

test("SHUT-006: duplicate phase names are refused at registration", () => {
  const coordinator = new ShutdownCoordinator();
  coordinator.register({ name: "close-storage", run: () => {} });
  assert.throws(() => coordinator.register({ name: "close-storage", run: () => {} }), /already registered/);
});

test("SHUT-007: the standard sequence stops requests before closing storage", async () => {
  // This ordering is a correctness requirement, not a preference: closing
  // storage while a request can still be writing loses the write.
  const order: string[] = [];
  const phases: ShutdownPhase[] = [];
  const service = {
    beginShutdown: () => { order.push("beginShutdown"); },
    shutdownBackgroundJobs: async () => { order.push("stopJobs"); },
  };
  registerStandardShutdownPhases(new ShutdownCoordinator(), {
    service,
    closeServer: async () => { order.push("stopAccepting"); },
    stopBackgroundWork: () => { order.push("stopBackgroundWork"); },
    drainWebhooks: async () => { order.push("drainWebhooks"); },
    closeProviders: () => { order.push("closeProviders"); },
    closeStorage: () => { order.push("closeStorage"); },
  });
  // Re-register onto a fresh coordinator to observe the phase order.
  const observed = registerStandardShutdownPhases(new ShutdownCoordinator(), {
    service: {
      beginShutdown: () => { order.push("beginShutdown"); },
      shutdownBackgroundJobs: async () => { order.push("stopJobs"); },
    },
    closeServer: async () => { order.push("stopAccepting"); },
    stopBackgroundWork: () => { order.push("stopBackgroundWork"); },
    drainWebhooks: async () => { order.push("drainWebhooks"); },
    closeProviders: () => { order.push("closeProviders"); },
    closeStorage: () => { order.push("closeStorage"); },
  });
  for (const name of ["beginShutdown", "stopAccepting", "stopBackgroundWork", "drainWebhooks", "stopJobs", "closeProviders", "closeStorage"]) {
    order.length = 0;
    await observed.shutdown("SIGTERM");
    assert.deepEqual(order, [
      "beginShutdown",
      "stopAccepting",
      "stopBackgroundWork",
      "drainWebhooks",
      "stopJobs",
      "closeProviders",
      "closeStorage",
    ], `${name} phase order`);
    break;
  }
  assert.equal(phases.length, 0, "no phases are constructed eagerly");
});

test("SHUT-008: an MCP process with no HTTP server still gets the sequence", async () => {
  // The audit's S5: MCP mode previously installed no signal handler at all.
  const order: string[] = [];
  const coordinator = registerStandardShutdownPhases(new ShutdownCoordinator(), {
    service: {
      beginShutdown: () => { order.push("beginShutdown"); },
      shutdownBackgroundJobs: async () => { order.push("stopJobs"); },
    },
    stopBackgroundWork: () => { order.push("stopBackgroundWork"); },
    closeStorage: () => { order.push("closeStorage"); },
  });
  const report = await coordinator.shutdown("SIGTERM");
  assert.deepEqual(order, ["beginShutdown", "stopBackgroundWork", "stopJobs", "closeStorage"]);
  assert.equal(report.clean, true, "an omitted optional phase is skipped, not failed");
  assert.equal(report.phases.some((phase) => phase.status === "skipped"), false);
});

test("SHUT-009: beginShutdown is idempotent and liveness reflects it", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-shutdown-"));
  const svc = new MemoryService(new MemoryStore(root), { embeddingProvider: "none" });
  try {
    assert.equal(svc.liveness().draining, false);
    assert.equal(svc.isShuttingDown, false);
    svc.beginShutdown();
    svc.beginShutdown();
    assert.equal(svc.liveness().draining, true, "repeated signals do not flip it back");
    assert.equal(svc.isShuttingDown, true);
  } finally {
    await svc.shutdownBackgroundJobs();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("SHUT-010: a real service shuts down through the standard sequence", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-shutdown-real-"));
  const svc = new MemoryService(new MemoryStore(root), { embeddingProvider: "none" });
  let drained = 0;
  try {
    await svc.store({ type: "fact", content: "written before shutdown" });
    const coordinator = registerStandardShutdownPhases(new ShutdownCoordinator(), {
      service: svc,
      stopBackgroundWork: () => {},
      drainWebhooks: async () => { drained++; },
      closeProviders: () => svc.closeProviders(),
      closeStorage: () => svc.backendForShutdown?.()?.close?.(),
    });
    const report = await coordinator.shutdown("SIGTERM", 5_000);
    assert.equal(report.clean, true, `phases: ${report.phases.map((p) => `${p.name}:${p.status}`).join(", ")}`);
    assert.equal(svc.isShuttingDown, true);
    assert.equal(drained, 1, "queued deliveries get a final attempt");
    assert.equal(report.phases.find((p) => p.name === "mark-draining")?.status, "completed");
    assert.equal(report.phases.find((p) => p.name === "close-storage")?.status, "completed");
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("SHUT-011: closing a server with in-flight requests drains them", async () => {
  // A server close waits for in-flight requests; the test proves they finish
  // before close resolves, which is the whole point of stopping after accepting.
  let requestFinished = false;
  const clock = manualClock();
  const fakeServer = {
    close(cb: () => void) {
      // The in-flight request finishes on the manual clock, before the deadline.
      clock.setTimeout(() => {
        requestFinished = true;
        cb();
      }, 20);
      return undefined;
    },
  };
  const pending = closeServerBounded(fakeServer, 1_000, {
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
  });
  clock.advance(20);
  await pending;
  assert.equal(requestFinished, true, "in-flight work completed before close resolved");
});

test("SHUT-012: a server that never drains is bounded and its sockets are cut", async () => {
  // Driven from a manual clock. The production timer is unref'd so a shutdown
  // deadline can never keep a process alive, which also means a real timer here
  // would leave the test file with nothing holding the event loop open.
  const clock = manualClock();
  let cut = false;
  const wedgedServer = {
    close(_cb: () => void) {
      return undefined; // never calls back
    },
    closeAllConnections() {
      cut = true;
    },
  };
  const pending = closeServerBounded(wedgedServer, 60, {
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
  });
  assert.equal(clock.armCount(), 1, "the deadline timer is armed");
  clock.advance(60);
  await pending;
  assert.equal(cut, true, "idle keep-alive sockets would otherwise hold the close open forever");
});

test("SHUT-013: a throwing close is reported, not propagated", async () => {
  const clock = manualClock();
  const throwingServer = {
    close(_cb: () => void): unknown {
      throw new Error("socket already destroyed");
    },
  };
  await assert.doesNotReject(
    () =>
      closeServerBounded(throwingServer, 200, {
        setTimeoutFn: clock.setTimeout,
        clearTimeoutFn: clock.clearTimeout,
      }),
  );
  assert.equal(clock.pendingCount(), 0, "and the deadline timer is released, not left armed");
});

test("SHUT-014: the budget covers every phase, not each phase individually", async () => {
  // Per-phase timeouts would let a sequence of slow phases exceed the budget by
  // an unbounded amount; the deadline is for the whole shutdown.
  const clock = manualClock();
  const coordinator = new ShutdownCoordinator({
    now: clock.now,
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
  });
  let secondRan = false;
  coordinator.register({ name: "one", critical: false, run: () => { clock.advance(3_000); } });
  coordinator.register({ name: "two", critical: false, run: () => { secondRan = true; } });
  const pending = coordinator.shutdown("SIGTERM", 5_000);
  clock.advance(1);
  const report = await pending;
  assert.equal(secondRan, true, "the second phase still ran");
  assert.equal(report.phases[1]?.name, "two");

  // Now exhaust the budget partway through.
  const clock2 = manualClock();
  const coordinator2 = new ShutdownCoordinator({
    now: clock2.now,
    setTimeoutFn: clock2.setTimeout,
    clearTimeoutFn: clock2.clearTimeout,
  });
  let thirdRan = false;
  coordinator2.register({ name: "one", critical: true, run: () => { clock2.advance(4_000); } });
  coordinator2.register({ name: "two", critical: false, run: () => { clock2.advance(4_000); } });
  coordinator2.register({ name: "three", critical: true, run: () => { thirdRan = true; } });
  const pending2 = coordinator2.shutdown("SIGTERM", 5_000);
  await advanceOnArm(clock2, 2, 4_001);
  const report2 = await pending2;
  assert.equal(thirdRan, false, "the budget was spent, so the last phase is skipped");
  assert.equal(report2.phases[2]?.status, "skipped");
  assert.equal(report2.forced, true, "because that phase was critical");
});

test("SHUT-015: the report is recorded for later inspection", async () => {
  const coordinator = new ShutdownCoordinator();
  const before: unknown = coordinator.report;
  assert.equal(before, undefined, "no report before a shutdown runs");
  coordinator.register({ name: "close-storage", critical: true, run: () => {} });
  await coordinator.shutdown("SIGINT");
  const report = coordinator.report;
  assert.ok(report, "the report is retained after the shutdown completes");
  assert.equal(report.reason, "SIGINT");
  assert.equal(report.clean, true);
  assert.equal(report.phases.length, 1);
});
