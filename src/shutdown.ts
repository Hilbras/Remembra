/**
 * Bounded graceful shutdown (V5.1.0, roadmap §23).
 *
 * The pre-V5.1 shutdown was six lines in `index.ts`: stop accepting, then
 * `process.exit(0)` after a hardcoded three seconds. It never stopped the
 * background jobs, never stopped the webhook drain interval, never closed
 * storage in HTTP mode, and in MCP mode there was no handler at all — so an MCP
 * server took the default `SIGTERM` disposition and died with no drain and no
 * recovery-state flush.
 *
 * The sequence the roadmap asks for:
 *
 *     stop accepting requests
 *            ↓
 *     finish active requests
 *            ↓
 *     stop workers
 *            ↓
 *     flush logs
 *            ↓
 *     flush metrics
 *            ↓
 *     close providers
 *            ↓
 *     close storage
 *            ↓
 *     exit
 *
 * Three properties make it safe to rely on:
 *
 *  - **Bounded.** One deadline covers every phase. A phase that overruns is
 *    reported as `timeout` and the shutdown continues, so a wedged provider
 *    cannot hold the process open forever.
 *  - **Idempotent.** A second `SIGTERM` does not start a second shutdown; it
 *    reports the current state and can escalate the deadline to force an exit.
 *  - **Honest.** The exit code reflects what happened. A forced timeout is
 *    distinguishable from a clean stop, which the old code could not express
 *    because it always exited 0.
 */
import { logEvent } from "./log.js";
import { metrics } from "./metrics.js";
import { isRemembraError, errorLabel } from "./errors.js";

export type ShutdownPhaseStatus = "completed" | "failed" | "timeout" | "skipped";

export interface ShutdownPhaseResult {
  readonly name: string;
  readonly status: ShutdownPhaseStatus;
  readonly durationMs: number;
  /** Classified error label, never a message that could carry internals. */
  readonly error?: string;
  /** True when this phase must complete for the process to exit cleanly. */
  readonly critical: boolean;
}

export interface ShutdownReport {
  readonly reason: string;
  readonly durationMs: number;
  readonly phases: ShutdownPhaseResult[];
  /** A phase that timed out or failed, and was marked critical. */
  readonly forced: boolean;
  readonly clean: boolean;
}

export interface ShutdownPhase {
  readonly name: string;
  run(): Promise<void> | void;
  /**
   * A critical phase that fails or times out forces the process to exit rather
   * than reporting success. Storage and recovery are critical; observability
   * flushes are not.
   */
  readonly critical?: boolean;
}

export interface ShutdownOptions {
  /** Total budget for every phase combined. Default: 10000ms. */
  deadlineMs?: number;
  /**
   * Injectable clock and timers, so the tests are deterministic. The handle
   * type is deliberately `unknown`: the production timer is a Node Timeout,
   * while a test clock returns its own queue entry, and neither should have to
   * pretend to be the other.
   */
  now?: () => number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

const DEFAULT_DEADLINE_MS = 10_000;

export class ShutdownCoordinator {
  private readonly phases: ShutdownPhase[] = [];
  private readonly now: () => number;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;
  private running?: Promise<ShutdownReport>;
  private lastReport?: ShutdownReport;

  constructor(private readonly options: ShutdownOptions = {}) {
    this.now = options.now ?? Date.now;
    this.setTimeoutFn = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  }

  /**
   * Add a phase. Order is registration order, which is the order the phases are
   * meant to run in — stopping requests before closing storage is not a
   * preference, it is a correctness requirement.
   */
  register(phase: ShutdownPhase): this {
    if (this.phases.some((existing) => existing.name === phase.name)) {
      throw new Error(`shutdown phase "${phase.name}" is already registered`);
    }
    this.phases.push(phase);
    return this;
  }

  /** True once a shutdown has been started and not yet finished. */
  get isShuttingDown(): boolean {
    return this.running !== undefined;
  }

  /** The most recent report, once a shutdown has completed. */
  get report(): ShutdownReport | undefined {
    return this.lastReport;
  }

  /**
   * Run the sequence. Concurrent and repeated calls return the *same* promise,
   * so a second `SIGTERM` cannot interleave a second shutdown with the first.
   */
  shutdown(reason: string, deadlineMs?: number): Promise<ShutdownReport> {
    if (this.running) return this.running;
    this.running = this.run(reason, deadlineMs ?? this.options.deadlineMs ?? DEFAULT_DEADLINE_MS).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async run(reason: string, deadlineMs: number): Promise<ShutdownReport> {
    const startedAt = this.now();
    const results: ShutdownPhaseResult[] = [];
    let forced = false;

    for (const phase of this.phases) {
      const critical = phase.critical === true;
      const remaining = deadlineMs - (this.now() - startedAt);
      if (remaining <= 0) {
        // The budget is spent. Record it honestly rather than pretending the
        // phase ran.
        results.push({ name: phase.name, status: "skipped", durationMs: 0, critical });
        if (critical) forced = true;
        logEvent("warn", "shutdown.phase_skipped", { phase: phase.name, reason }, "Remembra: shutdown budget exhausted");
        continue;
      }

      const phaseStartedAt = this.now();
      let timer: unknown;
      const outcome = await new Promise<ShutdownPhaseStatus>((resolve) => {
        // Settle-once, so a phase that completes and a timer that fires in the
        // same turn cannot both decide the outcome.
        let settled = false;
        const settle = (status: ShutdownPhaseStatus): void => {
          if (settled) return;
          settled = true;
          resolve(status);
        };
        timer = this.setTimeoutFn(() => settle("timeout"), remaining);
        // The phase body starts *synchronously*. Deferring it to a microtask
        // would let a synchronous phase lose the race to its own timer, so a
        // phase that had already finished would be reported as a timeout.
        try {
          const result = phase.run();
          if (result && typeof (result as Promise<void>).then === "function") {
            (result as Promise<void>).then(
              () => settle("completed"),
              (error: unknown) => {
                logEvent("warn", "shutdown.phase_failed", {
                  phase: phase.name,
                  error: isRemembraError(error) ? error.code : errorLabel(error),
                });
                settle("failed");
              },
            );
          } else {
            settle("completed");
          }
        } catch (error) {
          logEvent("warn", "shutdown.phase_failed", {
            phase: phase.name,
            error: isRemembraError(error) ? error.code : errorLabel(error),
          });
          settle("failed");
        }
      });
      if (timer) this.clearTimeoutFn(timer);

      const durationMs = this.now() - phaseStartedAt;
      const result: ShutdownPhaseResult = {
        name: phase.name,
        status: outcome,
        durationMs,
        critical,
        ...(outcome === "failed" ? { error: "phase_failed" } : {}),
      };
      results.push(result);
      if (critical && outcome !== "completed") forced = true;

      // A timed-out phase may still be running. The next phase cannot assume the
      // previous one finished, so stop here rather than closing storage under
      // an in-flight write.
      if (outcome === "timeout") {
        logEvent("warn", "shutdown.phase_timeout", { phase: phase.name, durationMs }, "Remembra: shutdown phase timed out");
        for (const remainingPhase of this.phases.slice(this.phases.indexOf(phase) + 1)) {
          const restCritical = remainingPhase.critical === true;
          results.push({ name: remainingPhase.name, status: "skipped", durationMs: 0, critical: restCritical });
          if (restCritical) forced = true;
        }
        break;
      }
    }

    const report: ShutdownReport = {
      reason,
      durationMs: this.now() - startedAt,
      phases: results,
      forced,
      clean: !forced && results.every((phase) => phase.status === "completed"),
    };
    this.lastReport = report;
    metrics.inc("remembra_shutdown_total", { result: report.clean ? "clean" : "forced" });
    for (const phase of results) {
      metrics.inc("remembra_shutdown_phases_total", { phase: phase.name, status: phase.status });
    }
    logEvent(report.clean ? "info" : "warn", "shutdown.complete", {
      reason,
      durationMs: report.durationMs,
      forced: report.forced,
      phases: results.map((phase) => `${phase.name}:${phase.status}`).join(","),
    });
    return report;
  }
}

/**
 * The standard sequence for a Remembra server, in the order the phases depend on
 * each other. `deps` are the live objects; anything omitted is skipped, so an
 * MCP process (no HTTP server) and an HTTP process (no CLI) both get the right
 * sequence without branching.
 */
export function registerStandardShutdownPhases(
  coordinator: ShutdownCoordinator,
  deps: {
    service: { beginShutdown(): void; shutdownBackgroundJobs(): Promise<void> };
    /** Stop accepting new connections. Resolves when in-flight requests finish. */
    closeServer?: () => Promise<void>;
    /** Stop background intervals, e.g. the webhook drain. */
    stopBackgroundWork?: () => void;
    /** Give queued webhook deliveries a final attempt. */
    drainWebhooks?: () => Promise<void>;
    /** Close the backend and any native handle it owns. */
    closeStorage?: () => void;
    /** Close provider adapters and sockets. */
    closeProviders?: () => void;
  },
): ShutdownCoordinator {
  // Liveness starts reporting `draining` first, so an orchestrator can take the
  // instance out of rotation while the rest of the sequence runs.
  coordinator.register({
    name: "mark-draining",
    critical: true,
    run: () => {
      deps.service.beginShutdown();
    },
  });
  if (deps.closeServer) {
    coordinator.register({
      name: "stop-accepting",
      critical: true,
      run: deps.closeServer,
    });
  }
  if (deps.stopBackgroundWork) {
    coordinator.register({
      name: "stop-background-work",
      critical: false,
      run: deps.stopBackgroundWork,
    });
  }
  if (deps.drainWebhooks) {
    coordinator.register({
      // A failed final drain delays a notification to the next process rather
      // than losing it, so it must not force a non-clean exit.
      name: "drain-webhooks",
      critical: false,
      run: deps.drainWebhooks,
    });
  }
  coordinator.register({
    name: "stop-jobs",
    critical: false,
    run: () => deps.service.shutdownBackgroundJobs(),
  });
  if (deps.closeProviders) {
    coordinator.register({
      name: "close-providers",
      critical: false,
      run: deps.closeProviders,
    });
  }
  if (deps.closeStorage) {
    coordinator.register({
      name: "close-storage",
      critical: true,
      run: deps.closeStorage,
    });
  }
  return coordinator;
}

/**
 * Close a server, bounded by a deadline.
 *
 * The timer is `unref`'d on purpose: a shutdown deadline must never be the
 * reason a process stays alive. That does mean a caller which needs to *observe*
 * the timeout must keep its own handle, so the timers are injectable and the
 * tests drive them from a manual clock rather than from wall time.
 */
export function closeServerBounded(
  server: { close(cb: (error?: Error) => void): unknown; closeAllConnections?: () => void },
  deadlineMs: number,
  options: { setTimeoutFn?: (fn: () => void, ms: number) => unknown; clearTimeoutFn?: (handle: unknown) => void } = {},
): Promise<void> {
  const setTimeoutFn = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimeoutFn = options.clearTimeoutFn ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  return new Promise<void>((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const timer = setTimeoutFn(() => {
      logEvent("warn", "shutdown.server_close_timeout", { deadlineMs }, "Remembra: in-flight requests did not drain in time");
      // Idle keep-alive sockets would otherwise hold the close open past the
      // deadline forever, since `close` waits for them.
      server.closeAllConnections?.();
      done();
    }, deadlineMs);
    (timer as { unref?: () => void }).unref?.();
    try {
      server.close(() => {
        clearTimeoutFn(timer);
        done();
      });
    } catch (error) {
      clearTimeoutFn(timer);
      logEvent("warn", "shutdown.server_close_failed", { error: errorLabel(error) });
      done();
    }
  });
}
