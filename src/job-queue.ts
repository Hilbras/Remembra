import { logEvent } from "./log.js";
import { metrics } from "./metrics.js";
import { RemembraError } from "./errors.js";

/** Jobs currently understood by the internal V4.8 worker boundary. */
export type JobType =
  | "embed-memory"
  | "reindex-memory"
  | "consolidate-memory"
  | "validate-memory"
  | "archive-memory"
  | "maintenance"
  | (string & {});

export type JobState = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface JobContext {
  signal: AbortSignal;
  attempt: number;
}

export type JobHandler<T = unknown> = (payload: T, context: JobContext) => Promise<unknown>;

export interface JobResult<T = unknown> {
  id: string;
  type: JobType;
  state: "completed" | "failed" | "cancelled";
  attempts: number;
  value?: T;
  error?: unknown;
}

export interface JobHandle<T = unknown> {
  readonly id: string;
  readonly type: JobType;
  readonly done: Promise<JobResult<T>>;
}

export interface JobQueueOptions {
  /** Maximum handlers running at once. */
  concurrency?: number;
  /** Maximum queued (not currently running) jobs. */
  maxQueue?: number;
  /** Total attempts, including the first attempt. */
  maxAttempts?: number;
  /** Delay before a retry. Defaults to zero for deterministic tests/callers. */
  retryDelayMs?: number;
  /** Injectable for deterministic IDs in tests. */
  idGen?: () => string;
  /** Called after a job exhausts retries. */
  onError?: (error: unknown, job: { id: string; type: JobType; attempts: number }) => void;
}

interface InternalJob {
  id: string;
  type: JobType;
  payload: unknown;
  handler: JobHandler<any>;
  controller: AbortController;
  resolve: (result: JobResult<unknown>) => void;
  attempts: number;
  settled: boolean;
}

/**
 * Small in-process, bounded work queue.
 *
 * It deliberately has no worker threads: embedding/consolidation providers are
 * async I/O, and a bounded cooperative pool gives callers predictable resource
 * usage without spawning unbounded native workers. The queue is internal and
 * does not expose a public client-controlled capacity.
 */
export class JobQueue {
  private readonly concurrency: number;
  private readonly maxQueue: number;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly idGen: () => string;
  private readonly onError?: JobQueueOptions["onError"];
  private readonly handlers = new Map<JobType, JobHandler<any>>();
  private readonly queue: InternalJob[] = [];
  private readonly running = new Set<InternalJob>();
  private readonly drainWaiters = new Set<() => void>();
  private closed = false;

  constructor(options: JobQueueOptions = {}) {
    this.concurrency = positiveInteger(options.concurrency ?? 2, "concurrency");
    this.maxQueue = positiveInteger(options.maxQueue ?? 100, "maxQueue");
    this.maxAttempts = positiveInteger(options.maxAttempts ?? 3, "maxAttempts");
    this.retryDelayMs = nonNegativeNumber(options.retryDelayMs ?? 0, "retryDelayMs");
    this.idGen = options.idGen ?? (() => `job-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
    this.onError = options.onError;
    metrics.gauge("remembra_job_queue_depth", "Queued background jobs", () => [{ value: this.queue.length }]);
    metrics.gauge("remembra_job_queue_running", "Running background jobs", () => [{ value: this.running.size }]);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  stats(): { queued: number; running: number; capacity: number; concurrency: number } {
    return {
      queued: this.queue.length,
      running: this.running.size,
      capacity: this.maxQueue,
      concurrency: this.concurrency,
    };
  }

  register<T>(type: JobType, handler: JobHandler<T>): void {
    this.assertOpen();
    if (this.handlers.has(type)) {
      throw new RemembraError("INVALID_INPUT", `job handler already registered for ${type}`);
    }
    this.handlers.set(type, handler as JobHandler<any>);
  }

  enqueue<P, R = unknown>(type: JobType, payload: P): JobHandle<R> {
    this.assertOpen();
    const handler = this.handlers.get(type);
    if (!handler) {
      throw new RemembraError("SERVICE_UNAVAILABLE", `no handler registered for job ${type}`);
    }
    if (this.queue.length >= this.maxQueue) {
      throw new RemembraError("QUEUE_FULL", `job queue is full (${this.maxQueue} waiting)`);
    }

    let resolve!: (result: JobResult<R>) => void;
    const done = new Promise<JobResult<R>>((r) => {
      resolve = r;
    });
    const job: InternalJob = {
      id: this.idGen(),
      type,
      payload,
      handler,
      controller: new AbortController(),
      resolve: resolve as (result: JobResult<unknown>) => void,
      attempts: 0,
      settled: false,
    };
    this.queue.push(job);
    metrics.inc("remembra_jobs_total", { type, outcome: "queued" });
    this.pump();
    return { id: job.id, type, done };
  }

  /** Wait until all queued and running jobs have settled. */
  async drain(): Promise<void> {
    if (this.queue.length === 0 && this.running.size === 0) return;
    await new Promise<void>((resolve) => this.drainWaiters.add(resolve));
  }

  /**
   * Stop accepting work, cancel queued jobs, and abort running jobs. A handler
   * that ignores AbortSignal is still awaited so shutdown never leaves an
   * unobserved promise behind.
   */
  async shutdown(): Promise<void> {
    if (this.closed) {
      await this.drain();
      return;
    }
    this.closed = true;
    const queued = this.queue.splice(0);
    for (const job of queued) {
      job.controller.abort();
      this.settle(job, "cancelled", job.attempts);
    }
    for (const job of this.running) job.controller.abort();
    await this.drain();
  }

  private assertOpen(): void {
    if (this.closed) throw new RemembraError("QUEUE_CLOSED", "job queue is closed");
  }

  private pump(): void {
    while (!this.closed && this.running.size < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.running.add(job);
      void this.execute(job).finally(() => {
        this.running.delete(job);
        this.notifyDrain();
        if (!this.closed) this.pump();
      });
    }
    this.notifyDrain();
  }

  private async execute(job: InternalJob): Promise<void> {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      job.attempts = attempt;
      if (job.controller.signal.aborted) {
        this.settle(job, "cancelled", attempt);
        return;
      }
      try {
        const value = await job.handler(job.payload, {
          signal: job.controller.signal,
          attempt,
        });
        if (job.controller.signal.aborted) {
          this.settle(job, "cancelled", attempt);
        } else {
          this.settle(job, "completed", attempt, value);
        }
        return;
      } catch (error) {
        if (job.controller.signal.aborted) {
          this.settle(job, "cancelled", attempt);
          return;
        }
        if (attempt >= this.maxAttempts) {
          this.settle(job, "failed", attempt, undefined, error);
          return;
        }
        await waitForRetry(this.retryDelayMs, job.controller.signal);
        if (job.controller.signal.aborted) {
          this.settle(job, "cancelled", attempt);
          return;
        }
      }
    }
  }

  private settle(
    job: InternalJob,
    state: JobResult["state"],
    attempts: number,
    value?: unknown,
    error?: unknown,
  ): void {
    // A job is settled exactly once, even if a handler resolves after abort.
    if (job.settled) return;
    job.settled = true;
    job.attempts = attempts;
    const result: JobResult<unknown> = {
      id: job.id,
      type: job.type,
      state,
      attempts,
      ...(state === "completed" ? { value } : {}),
      ...(error === undefined ? {} : { error }),
    };
    job.resolve(result);
    metrics.inc("remembra_jobs_total", { type: job.type, outcome: state });
    if (state === "failed") {
      metrics.inc("remembra_job_failures_total", { type: job.type });
      try {
        this.onError?.(error, { id: job.id, type: job.type, attempts });
      } catch (callbackError) {
        logEvent(
          "error",
          "job_error_callback_failed",
          { job_id: job.id, error: String(callbackError).slice(0, 200) },
          "Remembra: background job error callback failed",
        );
      }
      logEvent(
        "warn",
        "job_failed",
        { job_id: job.id, job_type: job.type, attempts },
        `Remembra: background job ${job.type} failed after ${attempts} attempt(s)`,
      );
    }
  }

  private notifyDrain(): void {
    if (this.queue.length !== 0 || this.running.size !== 0) return;
    for (const resolve of this.drainWaiters) resolve();
    this.drainWaiters.clear();
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RemembraError("INVALID_INPUT", `${name} must be a positive integer`);
  }
  return value;
}

function nonNegativeNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RemembraError("INVALID_INPUT", `${name} must be a non-negative number`);
  }
  return value;
}

function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  if (ms === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => done();
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) done();
  });
}
