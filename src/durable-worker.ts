/**
 * Durable worker (V5.6.0, roadmap §28).
 *
 * Polls a `JobStore`, claims jobs, runs them, and reports the outcome. This is
 * the shared-execution counterpart to the in-memory `JobQueue`: the ledger is
 * polled rather than awaited because a promise created in one process cannot be
 * resolved from another.
 *
 * ## The partition guard
 *
 * A claimed job carries a lease, and this worker renews it while the job runs. If
 * a renewal ever fails, the lease is gone: a peer has reclaimed it and may
 * already be running the same work. So the worker **aborts the job** rather than
 * letting it finish. Continuing would be the S1 lost-update failure wearing a
 * lease — two workers believing they own one job.
 *
 * ## Handlers are declared, not discovered
 *
 * A worker declares the types it can run, and claims are restricted to those. A
 * worker therefore never claims a job it has no handler for, which is what makes a
 * heterogeneous fleet (a scheduler-only instance, a worker that only consolidates)
 * safe. §28's split falls out of this rather than needing a separate mechanism.
 *
 * ## Handlers must be idempotent
 *
 * A worker that dies mid-job has its lease reclaimed and the job re-run. Nothing
 * can make an arbitrary handler safe to run twice, so this is a stated
 * requirement on the handler, not something the queue can enforce. The job's
 * `attempt` is passed in the context so a handler can tell which run it is.
 */
import { logEvent } from "./log.js";
import { metrics } from "./metrics.js";
import { defaultLockOwner } from "./lock.js";
import { RemembraError, isRemembraError, errorLabel } from "./errors.js";
import type { JobRecord, JobStore } from "./job-store.js";

export interface DurableJobContext {
  readonly jobId: string;
  readonly type: string;
  /** 1 on the first run, 2 on the first retry, and so on. */
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly tenantId?: string;
  /** Aborted when the lease is lost, so a long job stops instead of racing. */
  readonly signal: AbortSignal;
}

export type DurableJobHandler = (payload: unknown, context: DurableJobContext) => Promise<void> | void;

export interface DurableWorkerOptions {
  store: JobStore;
  /** The types this worker can run. A claim never returns any other type. */
  handlers: Record<string, DurableJobHandler>;
  owner?: string;
  /** Simultaneous jobs. Default 2. */
  concurrency?: number;
  /** How long a claim is valid. Default 60 000ms. */
  leaseMs?: number;
  /** How often to renew. Default leaseMs/3. */
  renewIntervalMs?: number;
  /** How long to wait after finding nothing. Default 250ms. */
  pollIntervalMs?: number;
  /** Restrict claims to one tenant digest. */
  tenantId?: string;
  now?: () => number;
  onError?: (error: unknown, job: JobRecord) => void;
  onSettled?: (job: JobRecord, outcome: "completed" | "failed" | "lease_lost" | "cancelled") => void;
}

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_POLL_MS = 250;

export class DurableWorker {
  private readonly store: JobStore;
  private readonly handlers: Record<string, DurableJobHandler>;
  private readonly owner: string;
  private readonly concurrency: number;
  private readonly leaseMs: number;
  private readonly renewIntervalMs: number;
  private readonly pollIntervalMs: number;
  private readonly tenantId?: string;
  private readonly now: () => number;
  private readonly onError?: DurableWorkerOptions["onError"];
  private readonly onSettled?: DurableWorkerOptions["onSettled"];

  private running = false;
  private pumping = false;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly inFlight = new Map<string, { controller: AbortController; renew: ReturnType<typeof setInterval> }>();
  /** Jobs whose lease was lost and which were aborted. Surfaced, never hidden. */
  private leaseLost = 0;
  private completed = 0;
  private failed = 0;

  constructor(options: DurableWorkerOptions) {
    this.store = options.store;
    this.handlers = options.handlers ?? {};
    this.owner = options.owner ?? defaultLockOwner();
    this.concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
    this.leaseMs = Math.max(1_000, options.leaseMs ?? DEFAULT_LEASE_MS);
    this.renewIntervalMs = Math.max(250, options.renewIntervalMs ?? Math.floor(this.leaseMs / 3));
    this.pollIntervalMs = Math.max(10, options.pollIntervalMs ?? DEFAULT_POLL_MS);
    this.tenantId = options.tenantId;
    this.now = options.now ?? Date.now;
    this.onError = options.onError;
    this.onSettled = options.onSettled;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get stats(): {
    owner: string;
    types: string[];
    inFlight: number;
    completed: number;
    failed: number;
    leaseLost: number;
  } {
    return {
      owner: this.owner,
      types: Object.keys(this.handlers).sort(),
      inFlight: this.inFlight.size,
      completed: this.completed,
      failed: this.failed,
      leaseLost: this.leaseLost,
    };
  }

  /** The types this worker will claim — what a peer should route to it. */
  get types(): string[] {
    return Object.keys(this.handlers).sort();
  }

  start(): void {
    if (this.running) return;
    // A worker that can run nothing would poll forever claiming no jobs, which
    // looks like a healthy idle worker while doing no work at all.
    if (this.types.length === 0) {
      throw new RemembraError("INVALID_INPUT", "durable worker has no job types to run");
    }
    this.running = true;
    void this.pump();
  }

  /**
   * Stop polling and let in-flight work finish, bounded by `timeoutMs`.
   *
   * Each in-flight lease is *released* rather than left to expire, so a peer can
   * take the job immediately instead of waiting out the lease. A job that does
   * not finish in time keeps its lease and is reclaimed by a peer on expiry,
   * which is the correct outcome for work that is genuinely still running.
   */
  async stop(timeoutMs = 10_000): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
    const deadline = Date.now() + timeoutMs;
    while (this.inFlight.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    for (const [jobId, entry] of [...this.inFlight]) {
      clearInterval(entry.renew);
      this.inFlight.delete(jobId);
      // Release rather than abandon, so a peer does not wait out the lease.
      await this.store.fail(jobId, this.owner, "LEASE_RELEASED").catch(() => {});
      const job = await this.store.get(jobId).catch(() => undefined);
      this.onSettled?.(job ?? ({ jobId, type: "unknown" } as JobRecord), "cancelled");
    }
  }

  /**
   * Claim and run until `predicate` says to stop, or nothing remains. Used by
   * tests and by one-shot drains; the long-running path is `start()`.
   */
  async drain(maxRounds = 1_000): Promise<number> {
    let ran = 0;
    for (let round = 0; round < maxRounds; round++) {
      const job = await this.claimOne();
      if (!job) break;
      // Awaited: a caller that awaited drain() is entitled to expect the work to
      // be finished, not merely claimed. Claiming without running would make
      // every such caller a lie.
      await this.run(job);
      ran++;
    }
    return ran;
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.running) {
        let progressed = false;
        while (this.running && this.inFlight.size < this.concurrency) {
          const job = await this.claimOne();
          if (!job) break;
          // Not awaited: pump() exists to keep the concurrency window full.
          void this.run(job);
          progressed = true;
        }
        if (this.running && this.inFlight.size >= this.concurrency) {
          progressed = true; // saturated: the completion will pump again
        }
        if (progressed) continue;
        await this.wait(this.pollIntervalMs);
      }
    } catch (error) {
      logEvent("error", "worker.pump_failed", { error: String(error).slice(0, 200) });
    } finally {
      this.pumping = false;
    }
  }

  /**
   * Wait before polling again.
   *
   * The timer is deliberately **not** unref'd. §28 allows a worker-only process,
   * and a worker-only process has nothing else holding its event loop open: an
   * unref'd poll timer would let the process exit before it ever claimed a job.
   * `stop()` is what releases the handle, and the process owner is responsible
   * for calling it — a worker that silently exited mid-job would be worse than
   * one that needs a deliberate stop.
   */
  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.pollTimer = setTimeout(resolve, ms);
    });
  }

  private async claimOne(): Promise<JobRecord | undefined> {
    let job: JobRecord | undefined;
    try {
      job = await this.store.claim({
        owner: this.owner,
        leaseMs: this.leaseMs,
        types: this.types,
        ...(this.tenantId !== undefined ? { tenantId: this.tenantId } : {}),
      });
    } catch (error) {
      logEvent("warn", "worker.claim_failed", { error: String(error).slice(0, 200) });
      return undefined;
    }
    return job;
  }

  private async run(job: JobRecord): Promise<void> {
    const handler = this.handlers[job.type];
    if (!handler) {
      // Should be unreachable: claims are restricted to the types we declare.
      logEvent("error", "worker.no_handler", { type: job.type });
      await this.store.fail(job.jobId, this.owner, "NO_HANDLER").catch(() => {});
      return;
    }
    const controller = new AbortController();
    let lostLease = false;
    // The partition guard: if a renewal ever fails, abort. Continuing would race
    // a peer that has already reclaimed this job.
    const renew = setInterval(() => {
      void this.store
        .renew(job.jobId, this.owner, this.leaseMs)
        .then((ok) => {
          if (ok) return;
          if (lostLease) return;
          lostLease = true;
          this.leaseLost++;
          logEvent("warn", "worker.lease_lost", { job_id: job.jobId, type: job.type });
          controller.abort();
        })
        .catch(() => {
          lostLease = true;
          controller.abort();
        });
    }, this.renewIntervalMs);
    this.inFlight.set(job.jobId, { controller, renew });

    let outcome: "completed" | "failed" | "lease_lost" | "cancelled" = "completed";
    try {
      let payload: unknown;
      try {
        payload = JSON.parse(job.payload);
      } catch {
        await this.store.fail(job.jobId, this.owner, "INVALID_PAYLOAD").catch(() => {});
        outcome = "failed";
        this.failed++;
        return;
      }
      await handler(payload, {
        jobId: job.jobId,
        type: job.type,
        attempt: job.attempt,
        maxAttempts: job.maxAttempts,
        ...(job.tenantId !== undefined ? { tenantId: job.tenantId } : {}),
        signal: controller.signal,
      });
      if (lostLease) {
        // The work finished, but it may have been run twice. Report the truth
        // rather than marking success we cannot vouch for.
        outcome = "lease_lost";
        logEvent("warn", "worker.completed_without_lease", { job_id: job.jobId, type: job.type });
        return;
      }
      const ok = await this.store.complete(job.jobId, this.owner);
      if (!ok) {
        outcome = "lease_lost";
        this.leaseLost++;
        logEvent("warn", "worker.complete_refused", { job_id: job.jobId, type: job.type });
        return;
      }
      this.completed++;
      metrics.inc("remembra_durable_jobs_total", { type: safeLabel(job.type), outcome: "completed" });
    } catch (error) {
      outcome = controller.signal.aborted ? "cancelled" : "failed";
      this.failed++;
      metrics.inc("remembra_durable_jobs_total", { type: safeLabel(job.type), outcome: outcome });
      this.onError?.(error, job);
      logEvent("warn", "worker.job_failed", {
        job_id: job.jobId,
        type: job.type,
        attempt: job.attempt,
        aborted: controller.signal.aborted,
        error: isRemembraError(error) ? error.code : errorLabel(error),
      });
      await this.store.fail(job.jobId, this.owner, isRemembraError(error) ? error.code : errorLabel(error)).catch(() => {});
    } finally {
      clearInterval(renew);
      this.inFlight.delete(job.jobId);
      this.onSettled?.(job, outcome);
      if (this.running) void this.pump();
    }
  }
}

function safeLabel(value: string): string {
  return /^[A-Za-z0-9._:-]{1,64}$/.test(value) ? value : "other";
}
