/**
 * Durable job ledger (V5.6.0, roadmap §27).
 *
 * The existing `JobQueue` is in-memory and promise-based: `enqueue` hands back a
 * promise that resolves when the job settles. That shape cannot cross a process
 * boundary, because nothing in this process can resolve a promise created in
 * another. A ledger that N workers share has to be *polled* rather than awaited,
 * so this is a separate concern from `JobQueue`, which stays exactly as it is
 * and remains what a single process uses.
 *
 * ## Why a claim is one statement
 *
 * Two workers polling the same ledger must not both believe they own a job. The
 * claim is therefore a single `UPDATE ... RETURNING`, not a read followed by a
 * write — the same check-then-act shape that produced audit finding S1, where two
 * writers were each told they had succeeded.
 *
 * ## Leases, not locks
 *
 * A claimed job carries a lease. A worker that dies holding one does not strand
 * it: the lease expires, the job returns to `retrying`, and someone else claims
 * it. Nothing waits for a holder that will never come back.
 *
 * ## Identity
 *
 * `tenantId` is an opaque digest, hashed if a caller passes a raw value, for the
 * same reason rate and lease identities are: a job row outlives the request that
 * created it. `type` is a closed label, so the ledger cannot grow a series of
 * types from host-supplied strings.
 */
import { createHash, randomUUID } from "node:crypto";
import { RemembraError } from "./errors.js";
import { defaultLockOwner } from "./lock.js";

/** The §27 state model. */
export const JOB_STATES = ["queued", "running", "completed", "failed", "retrying", "cancelled"] as const;
export type JobState = (typeof JOB_STATES)[number];

/** A job as it exists in the ledger. */
export interface JobRecord {
  readonly jobId: string;
  /** Opaque tenant digest. Absent for a tenantless local job. */
  readonly tenantId?: string;
  readonly type: string;
  /** JSON-encoded payload, bounded. */
  readonly payload: string;
  readonly state: JobState;
  readonly createdAt: number;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly leaseOwner?: string;
  readonly leaseExpiresAt?: number;
  /** Classified error label, never a message. */
  readonly lastError?: string;
  /** When a `retrying` job becomes claimable again. */
  readonly runAfter?: number;
}

export interface EnqueueInput {
  type: string;
  payload: unknown;
  tenantId?: string;
  maxAttempts?: number;
  /** Delay before the job becomes claimable. */
  runAfterMs?: number;
  jobId?: string;
}

export interface ClaimOptions {
  /** Identity of the claimer. Default: the process owner id. */
  owner?: string;
  /** How long the claim is valid. Default 60 000ms. */
  leaseMs?: number;
  /** Restrict to these job types. */
  types?: readonly string[];
  /** Restrict to one tenant digest. */
  tenantId?: string;
  now?: number;
}

export interface JobStore {
  /** Add a job. Returns its id. */
  enqueue(input: EnqueueInput): Promise<string>;
  /**
   * Atomically take ownership of one claimable job. Returns `undefined` when
   * there is nothing to do — which is the normal case, not an error.
   */
  claim(options?: ClaimOptions): Promise<JobRecord | undefined>;
  /** Mark claimed work finished. False if the lease is no longer ours. */
  complete(jobId: string, owner: string, now?: number): Promise<boolean>;
  /**
   * Record a failure. Moves to `retrying` while attempts remain, else `failed`.
   * False if the lease is no longer ours.
   */
  fail(jobId: string, owner: string, errorLabel: string, retryAfterMs?: number, now?: number): Promise<boolean>;
  /** Extend a claim. False once the lease is lost — never silently re-acquired. */
  renew(jobId: string, owner: string, leaseMs?: number, now?: number): Promise<boolean>;
  /** Return jobs whose lease expired to `retrying`. Returns how many. */
  reclaimExpired(now?: number): Promise<number>;
  get(jobId: string): Promise<JobRecord | undefined>;
  /** Remove terminal jobs older than `olderThanMs`. Returns how many. */
  prune(olderThanMs: number, now?: number): Promise<number>;
  stats(): Promise<{ queued: number; running: number; retrying: number; failed: number; completed: number; cancelled: number }>;
  close?(): void;
}

export const MAX_JOB_PAYLOAD_BYTES = 64 * 1024;
export const MAX_JOB_TYPE_LENGTH = 64;
export const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_LEASE_MS = 60_000;

/** Error labels are classified and bounded; a message must never be stored. */
const MAX_ERROR_LABEL_LENGTH = 64;

export function normalizeJobType(type: string): string {
  const trimmed = String(type ?? "").trim();
  if (!trimmed || trimmed.length > MAX_JOB_TYPE_LENGTH) {
    throw new RemembraError("INVALID_INPUT", `job type must be 1-${MAX_JOB_TYPE_LENGTH} characters`);
  }
  // The type becomes a metric label and a ledger column value, so it is bounded
  // to a safe shape rather than an arbitrary host string.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(trimmed)) {
    throw new RemembraError("INVALID_INPUT", "job type must be alphanumeric with . _ : - only");
  }
  return trimmed;
}

/** Tenant ids are opaque digests; a raw value is hashed rather than stored. */
export function normalizeTenantId(tenantId: string | undefined): string | undefined {
  if (tenantId === undefined || tenantId === "") return undefined;
  if (typeof tenantId !== "string" || tenantId.length > 256) {
    throw new RemembraError("INVALID_INPUT", "tenant id is invalid");
  }
  return /^[0-9a-f]{8,128}$/.test(tenantId) ? tenantId : createHash("sha256").update(tenantId).digest("hex").slice(0, 16);
}

export function encodeJobPayload(payload: unknown): string {
  let encoded: string;
  try {
    encoded = JSON.stringify(payload ?? null);
  } catch {
    throw new RemembraError("INVALID_INPUT", "job payload is not JSON-serializable");
  }
  const bytes = Buffer.byteLength(encoded, "utf8");
  if (bytes > MAX_JOB_PAYLOAD_BYTES) {
    throw new RemembraError("INVALID_INPUT", `job payload is ${bytes} bytes, over the ${MAX_JOB_PAYLOAD_BYTES} limit`);
  }
  return encoded;
}

function normalizeErrorLabel(label: string): string {
  const text = String(label ?? "unknown").slice(0, MAX_ERROR_LABEL_LENGTH);
  // A classified code, not a message: keep it to a safe token shape.
  return /^[A-Za-z0-9_.-]+$/.test(text) ? text : "unknown";
}

function encodePayload(payload: unknown): string {
  return encodeJobPayload(payload);
}

// ---------------------------------------------------------------------------
// In-memory store — the default, and what a single process needs.
// ---------------------------------------------------------------------------

export class InMemoryJobStore implements JobStore {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  async enqueue(input: EnqueueInput): Promise<string> {
    const now = this.now();
    const runAfter = input.runAfterMs && input.runAfterMs > 0 ? now + input.runAfterMs : undefined;
    const job: JobRecord = {
      jobId: input.jobId ?? randomUUID(),
      ...(normalizeTenantId(input.tenantId) ? { tenantId: normalizeTenantId(input.tenantId) } : {}),
      type: normalizeJobType(input.type),
      payload: encodePayload(input.payload),
      state: "queued",
      createdAt: now,
      attempt: 0,
      maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      ...(runAfter !== undefined ? { runAfter } : {}),
    };
    this.jobs.set(job.jobId, job);
    return job.jobId;
  }

  async claim(options: ClaimOptions = {}): Promise<JobRecord | undefined> {
    const now = options.now ?? this.now();
    const owner = options.owner ?? defaultLockOwner();
    const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    // Deterministic order: oldest first, then by id. The tie-break is what makes
    // two claimers polling the same ledger pick the *same* next job and race for
    // it, rather than disagreeing and both winning. Order within a single
    // millisecond is arbitrary — job ids are random — but it is the same
    // arbitrary order for every claimer, which is the property that matters.
    const candidate = [...this.jobs.values()]
      .filter((job) => claimable(job, now, options))
      .sort((a, b) => a.createdAt - b.createdAt || a.jobId.localeCompare(b.jobId))[0];
    if (!candidate) return undefined;
    const claimed: JobRecord = {
      ...candidate,
      state: "running",
      attempt: candidate.attempt + 1,
      startedAt: candidate.startedAt ?? now,
      leaseOwner: owner,
      leaseExpiresAt: now + leaseMs,
    };
    this.jobs.set(claimed.jobId, claimed);
    return claimed;
  }

  async complete(jobId: string, owner: string, now = this.now()): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job || job.leaseOwner !== owner) return false;
    this.jobs.set(jobId, {
      ...job,
      state: "completed",
      completedAt: now,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
    });
    return true;
  }

  async fail(jobId: string, owner: string, errorLabel: string, retryAfterMs = 0, now = this.now()): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job || job.leaseOwner !== owner) return false;
    const canRetry = job.attempt < job.maxAttempts;
    this.jobs.set(jobId, {
      ...job,
      state: canRetry ? "retrying" : "failed",
      completedAt: canRetry ? undefined : now,
      lastError: normalizeErrorLabel(errorLabel),
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      ...(canRetry && retryAfterMs > 0 ? { runAfter: now + retryAfterMs } : {}),
    });
    return true;
  }

  async renew(jobId: string, owner: string, leaseMs = DEFAULT_LEASE_MS, now = this.now()): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job || job.leaseOwner !== owner) return false;
    this.jobs.set(jobId, { ...job, leaseExpiresAt: now + leaseMs });
    return true;
  }

  async reclaimExpired(now = this.now()): Promise<number> {
    let reclaimed = 0;
    for (const [jobId, job] of this.jobs) {
      if (job.state !== "running") continue;
      if (job.leaseExpiresAt === undefined || job.leaseExpiresAt > now) continue;
      // A worker died holding this. Return it rather than stranding it.
      this.jobs.set(jobId, {
        ...job,
        state: job.attempt < job.maxAttempts ? "retrying" : "failed",
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        completedAt: job.attempt < job.maxAttempts ? undefined : now,
      });
      reclaimed++;
    }
    return reclaimed;
  }

  async get(jobId: string): Promise<JobRecord | undefined> {
    return this.jobs.get(jobId);
  }

  async prune(olderThanMs: number, now = this.now()): Promise<number> {
    let removed = 0;
    for (const [jobId, job] of this.jobs) {
      if (!TERMINAL.has(job.state)) continue;
      const settledAt = job.completedAt ?? job.createdAt;
      if (now - settledAt < olderThanMs) continue;
      this.jobs.delete(jobId);
      removed++;
    }
    return removed;
  }

  async stats() {
    const counts = { queued: 0, running: 0, retrying: 0, failed: 0, completed: 0, cancelled: 0 };
    for (const job of this.jobs.values()) counts[job.state]++;
    return counts;
  }
}

const TERMINAL: ReadonlySet<JobState> = new Set<JobState>(["completed", "failed", "cancelled"]);

function claimable(job: JobRecord, now: number, options: ClaimOptions): boolean {
  if (job.state !== "queued" && job.state !== "retrying") return false;
  if (job.runAfter !== undefined && job.runAfter > now) return false;
  if (options.types && !options.types.includes(job.type)) return false;
  if (options.tenantId !== undefined && job.tenantId !== options.tenantId) return false;
  return true;
}

// ---------------------------------------------------------------------------
// SQLite store — durable, and shared by every worker on the host.
// ---------------------------------------------------------------------------

interface SqliteDatabaseLike {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  close(): void;
}

export class SqliteJobStore implements JobStore {
  private readonly db: SqliteDatabaseLike;
  private readonly now: () => number;

  constructor(
    db: SqliteDatabaseLike,
    options: { now?: () => number } = {},
  ) {
    this.db = db;
    this.now = options.now ?? Date.now;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        job_id TEXT PRIMARY KEY,
        tenant_id TEXT,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        attempt INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL,
        lease_owner TEXT,
        lease_expires_at INTEGER,
        last_error TEXT,
        run_after INTEGER
      );
      CREATE INDEX IF NOT EXISTS jobs_claimable ON jobs (state, run_after, created_at);
      CREATE INDEX IF NOT EXISTS jobs_lease ON jobs (state, lease_expires_at);
    `);
  }

  async enqueue(input: EnqueueInput): Promise<string> {
    const now = this.now();
    const tenantId = normalizeTenantId(input.tenantId);
    const runAfter = input.runAfterMs && input.runAfterMs > 0 ? now + input.runAfterMs : null;
    const jobId = input.jobId ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO jobs (job_id, tenant_id, type, payload, state, created_at, attempt, max_attempts, run_after)
         VALUES (?, ?, ?, ?, 'queued', ?, 0, ?, ?)`,
      )
      .run(jobId, tenantId, normalizeJobType(input.type), encodePayload(input.payload), now, input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, runAfter);
    return jobId;
  }

  async claim(options: ClaimOptions = {}): Promise<JobRecord | undefined> {
    const now = options.now ?? this.now();
    const owner = options.owner ?? defaultLockOwner();
    const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    // One statement, so two claimers cannot both take the same job. `RETURNING`
    // gives the row the database actually claimed rather than one we re-read.
    const filters: string[] = ["j.state IN ('queued','retrying')", "(j.run_after IS NULL OR j.run_after <= ?)"];
    const params: unknown[] = [now];
    if (options.types?.length) {
      filters.push(`j.type IN (${options.types.map(() => "?").join(",")})`);
      params.push(...options.types);
    }
    if (options.tenantId !== undefined) {
      filters.push("j.tenant_id = ?");
      params.push(options.tenantId);
    }
    const row = this.db
      .prepare(
        `UPDATE jobs SET state = 'running', attempt = attempt + 1,
             started_at = COALESCE(started_at, ?), lease_owner = ?, lease_expires_at = ?
         WHERE job_id = (
           SELECT j.job_id FROM jobs j
           WHERE ${filters.join(" AND ")}
           ORDER BY j.created_at ASC, j.job_id ASC
           LIMIT 1
         )
         RETURNING *`,
      )
      .get(now, owner, now + leaseMs, ...params) as Record<string, unknown> | undefined;
    return row ? toRecord(row) : undefined;
  }

  async complete(jobId: string, owner: string, now = this.now()): Promise<boolean> {
    const result = this.db
      .prepare(
        `UPDATE jobs SET state = 'completed', completed_at = ?, lease_owner = NULL, lease_expires_at = NULL
         WHERE job_id = ? AND lease_owner = ?`,
      )
      .run(now, jobId, owner);
    return result.changes === 1;
  }

  async fail(jobId: string, owner: string, errorLabel: string, retryAfterMs = 0, now = this.now()): Promise<boolean> {
    // One statement decides retrying-versus-failed from the stored attempt count,
    // so a concurrent attempt increment cannot make the two disagree.
    const result = this.db
      .prepare(
        `UPDATE jobs SET
            state = CASE WHEN attempt < max_attempts THEN 'retrying' ELSE 'failed' END,
            completed_at = CASE WHEN attempt < max_attempts THEN NULL ELSE ? END,
            last_error = ?,
            lease_owner = NULL,
            lease_expires_at = NULL,
            run_after = CASE WHEN attempt < max_attempts THEN ? ELSE NULL END
         WHERE job_id = ? AND lease_owner = ?`,
      )
      .run(now, normalizeErrorLabel(errorLabel), retryAfterMs > 0 ? now + retryAfterMs : null, jobId, owner);
    return result.changes === 1;
  }

  async renew(jobId: string, owner: string, leaseMs = DEFAULT_LEASE_MS, now = this.now()): Promise<boolean> {
    const result = this.db
      .prepare(`UPDATE jobs SET lease_expires_at = ? WHERE job_id = ? AND lease_owner = ? AND lease_expires_at > ?`)
      .run(now + leaseMs, jobId, owner, now);
    return result.changes === 1;
  }

  async reclaimExpired(now = this.now()): Promise<number> {
    // A worker died holding these. Return them rather than stranding them, and
    // decide retrying-versus-failed from the attempt count already stored.
    const result = this.db
      .prepare(
        `UPDATE jobs SET
            state = CASE WHEN attempt < max_attempts THEN 'retrying' ELSE 'failed' END,
            completed_at = CASE WHEN attempt < max_attempts THEN NULL ELSE ? END,
            lease_owner = NULL,
            lease_expires_at = NULL
         WHERE state = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
      )
      .run(now, now);
    return result.changes;
  }

  async get(jobId: string): Promise<JobRecord | undefined> {
    const row = this.db.prepare(`SELECT * FROM jobs WHERE job_id = ?`).get(jobId) as Record<string, unknown> | undefined;
    return row ? toRecord(row) : undefined;
  }

  async prune(olderThanMs: number, now = this.now()): Promise<number> {
    const result = this.db
      .prepare(
        `DELETE FROM jobs
         WHERE state IN ('completed','failed','cancelled')
           AND COALESCE(completed_at, created_at) <= ?`,
      )
      .run(now - olderThanMs);
    return result.changes;
  }

  async stats() {
    const rows = this.db.prepare(`SELECT state, COUNT(*) AS count FROM jobs GROUP BY state`).all() as {
      state: JobState;
      count: number;
    }[];
    const counts = { queued: 0, running: 0, retrying: 0, failed: 0, completed: 0, cancelled: 0 };
    for (const row of rows) counts[row.state] += row.count;
    return counts;
  }

  close(): void {
    this.db.close();
  }
}

function toRecord(row: Record<string, unknown>): JobRecord {
  return {
    jobId: String(row.job_id),
    ...(row.tenant_id === null || row.tenant_id === undefined ? {} : { tenantId: String(row.tenant_id) }),
    type: String(row.type),
    payload: String(row.payload),
    state: String(row.state) as JobState,
    createdAt: Number(row.created_at),
    ...(row.started_at === null || row.started_at === undefined ? {} : { startedAt: Number(row.started_at) }),
    ...(row.completed_at === null || row.completed_at === undefined ? {} : { completedAt: Number(row.completed_at) }),
    attempt: Number(row.attempt),
    maxAttempts: Number(row.max_attempts),
    ...(row.lease_owner === null || row.lease_owner === undefined ? {} : { leaseOwner: String(row.lease_owner) }),
    ...(row.lease_expires_at === null || row.lease_expires_at === undefined
      ? {}
      : { leaseExpiresAt: Number(row.lease_expires_at) }),
    ...(row.last_error === null || row.last_error === undefined ? {} : { lastError: String(row.last_error) }),
    ...(row.run_after === null || row.run_after === undefined ? {} : { runAfter: Number(row.run_after) }),
  };
}
