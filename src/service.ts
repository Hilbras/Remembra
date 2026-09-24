import type { MemoryBackend } from "./backend.js";
import { extractQuery, searchQ, expandRelationCandidates } from "./retrieval.js";
import { StoreInput, MemoryType, Memory, SnapshotInput, SNAPSHOT_FORMAT, SCHEMA_VERSION, TENANT_SCHEMA_VERSION, Provenance, defaultTrust, CompressInput, BatchRequest, MAX_BATCH_BYTES, BatchOutcome, BatchSummary, BatchFailure } from "./types.js";
import { RemembraError, inputError, errorLabel } from "./errors.js";
import {
  ContextInput,
  defaultTokenCounter,
  selectContextMemories,
  type ContextResult,
  type TokenCounter,
} from "./context.js";
import { resolveEmbeddingProvider, embedText, embedTexts, clearEmbedCachePartition, EmbeddingProvider, EmbeddingAdapter, cosine, type EmbedCallOptions } from "./embeddings.js";
import { logEvent } from "./log.js";
import { metrics } from "./metrics.js";
import { VERSION } from "./version.js";
import { performance } from "node:perf_hooks";
import { redact, redactTags, redactionEnabled, RedactionKind } from "./redact.js";
import { unifiedDiff } from "./diff.js";
import { RelateInput, HistoryInput, UpdateInput } from "./types.js";
import {
  resolveLlmProvider,
  extractMemories,
  resolveMerge,
  LlmProvider,
  LlmAdapter,
  ExtractedMemory,
} from "./llm.js";
import { createInjectionDetector, InjectionResult } from "./injection-detector.js";
import { SensitiveDataDetector } from "./sensitive-data.js";
import { loadMemoryPolicy, type MemoryPolicy } from "./policy.js";
import { consolidate, ConsolidationFindings } from "./consolidation.js";
import { computeHealth, getLifecycleState, agingScorePenalty } from "./lifecycle.js";
import { AgentContext, canReadMemory, canUseScope, defaultAccess, defaultOwner } from "./agent.js";
import {
  assertTenantContext,
  memoryBelongsToTenant,
  tenantFilterFromContext,
  type TenantContext,
  type TenantFilter,
  type TenantMode,
} from "./tenant.js";
import {
  assertAuthorized,
  evaluateAuthorization,
  type AuthorizationOperation,
} from "./authorization.js";
import { createSignedSnapshot, isSignedSnapshot, verifySignedSnapshot, type SignedSnapshot } from "./snapshot-integrity.js";
import { JobQueue } from "./job-queue.js";
import { transitionRecoveryState, type RecoveryState } from "./recovery-state.js";
import type { TenantDirectory } from "./tenant-directory.js";
import { applyTenantMigration, preflightTenantMigration, type TenantMigrationPlan } from "./tenant-migration-runner.js";
import type { JobHandle } from "./job-queue.js";

export interface DigestResult {
  extracted: number;
  stored: Memory[];
  skippedDuplicates: number;
  merged: number;
  ids: string[];
}

export interface SnapshotPreview {
  total: number;
  imported: number;
  skipped: number;
}

export interface SnapshotMigrationResult {
  total: number;
  planned: number;
  imported: number;
  skipped: number;
  dryRun: boolean;
}

interface PreparedSnapshotImport {
  prepared: Memory[];
  skipped: number;
  tenant: TenantFilter | undefined;
}

export interface MaintainResult {
  archived: string[];
  deleted: string[];
  embedded: number;
  revived?: number;
  /** V4.5: consolidation findings from the last maintenance pass. */
  consolidation?: {
    exactDuplicates: Array<{ id: string; duplicateOf?: string }>;
    nearDuplicates: Array<{ a: string; b: string; reason: string }>;
    contradictions: Array<{ a: string; b: string; reason: string }>;
    fragments: Array<{ ids: string[]; type: string; scope: string }>;
  };
}

export interface ServiceDeps {
  embeddingProvider?: EmbeddingProvider;
  /** Optional vendor-neutral embedding adapter; takes precedence over the legacy name. */
  embeddingAdapter?: EmbeddingAdapter;
  llmProvider?: LlmProvider;
  /** Optional vendor-neutral LLM adapter; takes precedence over the legacy name. */
  llmAdapter?: LlmAdapter;
  /** Token counter used by the V5 context API. */
  tokenCounter?: TokenCounter;
  /** Validated V5 policy; loaded once from trusted configuration when omitted. */
  policy?: MemoryPolicy;
  /** Injection points for tests. */
  embedFn?: (text: string, opts?: EmbedCallOptions) => Promise<number[]>;
  extractFn?: (transcript: string, opts?: { signal?: AbortSignal }) => Promise<ExtractedMemory[]>;
  mergeFn?: (
    newContent: string,
    existing: { type: string; content: string },
    opts?: { signal?: AbortSignal },
  ) => Promise<
    { action: "store" } | { action: "skip" } | { action: "merge"; content: string }
  >;
  /** How often the opportunistic decay pass may run on search (ms). Default 1h. */
  decayIntervalMs?: number;
  /** Active memory unused for this many days gets archived. Default 90. */
  archiveAfterDays?: number;
  /** Archived memory older than this gets auto-deleted. Default 365. */
  archiveTtlDays?: number;
  /** Force the PII redaction filter on/off (default: REMEMBRA_REDACT env). */
  redact?: boolean;
  /** V4.7: enable fail-closed agent visibility policy. Disabled by default. */
  agentMode?: boolean;
  /** V5 tenant enforcement mode. Strict requires an opaque context per call. */
  tenantMode?: TenantMode;
  /** Optional host membership recheck for queued/background work. */
  verifyTenantContext?: (context: TenantContext) => boolean | Promise<boolean>;
  /** Host-side organization/user/project/agent membership authority. */
  tenantDirectory?: TenantDirectory;
  /** HMAC key used to sign/verify V5 snapshot envelopes. */
  snapshotKey?: Buffer | Uint8Array;
  /** Strict tenant mode defaults to requiring signed snapshots. */
  requireSignedSnapshots?: boolean;
  /** Selected durable backend for operational health reporting. */
  backend?: "sqlite" | "file";
  /** Whether the selected backend was explicitly allowed as a fallback. */
  backendFallback?: boolean;
}

export interface AgentReadOptions {
  /** Identity established by the host application, never an unauthenticated request field. */
  agent?: AgentContext;
  /** V5 host-minted tenant context; never constructed from a public request. */
  tenant?: TenantContext;
}

export interface SearchExecutionOptions {
  /** Internal read-only mode used by context assembly. */
  touch?: boolean;
  runDecay?: boolean;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new RemembraError("INVALID_INPUT", `${name} must be a number`);
  }
  return value;
}

function batchFailure(index: number, id: string | undefined, error: unknown): BatchOutcome {
  return {
    index,
    ...(id ? { id } : {}),
    ok: false,
    error: {
      code: errorLabel(error),
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

function batchSummary(results: readonly BatchOutcome[]): BatchSummary {
  const succeeded = results.filter((result) => result.ok).length;
  return { requested: results.length, succeeded, failed: results.length - succeeded };
}

function recordBatchMetrics(operation: string, results: readonly BatchOutcome[]): void {
  for (const result of results) {
    metrics.inc("remembra_batch_items_total", { operation, result: result.ok ? "success" : "failure" });
  }
}

/**
 * Transport-agnostic handlers. Both the MCP tools and the HTTP API
 * call into this module, so behavior is guaranteed to match.
 */
export class MemoryService {
  private readonly embedFn?: (text: string, opts?: EmbedCallOptions) => Promise<number[]>;
  private readonly extractFn: (transcript: string, opts?: { signal?: AbortSignal }) => Promise<ExtractedMemory[]>;
  private readonly mergeFn: (
    newContent: string,
    existing: { type: string; content: string },
    opts?: { signal?: AbortSignal },
  ) => Promise<{ action: "store" } | { action: "skip" } | { action: "merge"; content: string }>;
  private readonly decayIntervalMs: number;
  private readonly archiveAfterDays: number;
  private readonly archiveTtlDays: number;
  private readonly redactOn: boolean;
  private readonly agentMode: boolean;
  private readonly tenantMode: TenantMode;
  private readonly verifyTenantContext?: ServiceDeps["verifyTenantContext"];
  private readonly snapshotKey?: Buffer;
  private readonly requireSignedSnapshots: boolean;
  private readonly jobs: JobQueue;
  /** V4.4: prompt injection detector (pattern-based). */
  private readonly injectionDetector = createInjectionDetector();
  /** V4.4/V5: sensitive data policy detector. */
  private readonly sensitiveDetector: SensitiveDataDetector;
  /** Resolved extraction LLM — recorded as provenance.provider on digests (§4.3). */
  private readonly llmName: string;
  private readonly policy: MemoryPolicy;
  private readonly tokenCounter: TokenCounter;
  #backend: MemoryBackend;
  private recoveryState: RecoveryState = "Recovering";
  private readonly backendName?: "sqlite" | "file";
  private readonly backendFallback: boolean;
  private lastDecayRun = 0;
  private decayRunning = false;
  private decayPromise: Promise<unknown> | null = null;

  constructor(db: MemoryBackend, deps: ServiceDeps = {}) {
    this.#backend = db;
    this.backendName = deps.backend;
    this.backendFallback = deps.backendFallback ?? false;
    const emb = deps.embeddingProvider ?? resolveEmbeddingProvider();
    const llm = deps.llmProvider ?? resolveLlmProvider();
    const embeddingAdapter = deps.embeddingAdapter;
    const llmAdapter = deps.llmAdapter;
    this.policy = deps.policy ?? loadMemoryPolicy();
    this.sensitiveDetector = new SensitiveDataDetector(this.policy.sensitiveData.action);
    this.llmName = llmAdapter?.id ?? llm;
    this.tokenCounter = deps.tokenCounter ?? defaultTokenCounter;

    this.embedFn =
      deps.embedFn ??
      (emb === "none" && !embeddingAdapter
        ? undefined
        : async (text: string, o?: { signal?: AbortSignal }) =>
            embeddingAdapter
              ? embeddingAdapter.embed(text, { signal: o?.signal })
              : embedText(text, emb, { signal: o?.signal }));

    this.extractFn =
      deps.extractFn ??
      (async (t: string, o?: { signal?: AbortSignal }) =>
        extractMemories(t, llm, { signal: o?.signal, adapter: llmAdapter }));
    this.mergeFn =
      deps.mergeFn ??
      ((n, e, o?: { signal?: AbortSignal }) =>
        resolveMerge(n, e, llm, { signal: o?.signal, adapter: llmAdapter }));

    this.decayIntervalMs = deps.decayIntervalMs ?? 3_600_000; // 1h
    this.archiveAfterDays = deps.archiveAfterDays ?? Number(process.env.REMEMBRA_ARCHIVE_AFTER_DAYS ?? 90);
    this.archiveTtlDays = deps.archiveTtlDays ?? Number(process.env.REMEMBRA_ARCHIVE_TTL_DAYS ?? 365);
    this.redactOn = deps.redact ?? redactionEnabled();
    this.agentMode = deps.agentMode ?? process.env.REMEMBRA_AGENT_MODE === "1";
    this.tenantMode = deps.tenantMode ?? "legacy";
    this.verifyTenantContext = deps.verifyTenantContext ??
      (deps.tenantDirectory ? (context) => deps.tenantDirectory!.verifyContext(context) : undefined);
    this.snapshotKey = deps.snapshotKey ? Buffer.from(deps.snapshotKey) : undefined;
    this.requireSignedSnapshots = this.tenantMode === "strict" || deps.requireSignedSnapshots === true;
    if (this.tenantMode === "strict" && this.#backend.tenantCapable !== true) {
      throw new RemembraError("SERVICE_UNAVAILABLE", "strict tenant mode requires a tenant-capable backend");
    }
    this.jobs = new JobQueue({
      concurrency: envNumber("REMEMBRA_JOB_CONCURRENCY", 2),
      maxQueue: envNumber("REMEMBRA_JOB_QUEUE", 100),
      maxAttempts: envNumber("REMEMBRA_JOB_MAX_ATTEMPTS", 3),
      retryDelayMs: envNumber("REMEMBRA_JOB_RETRY_DELAY_MS", 0),
    });
    this.jobs.register("maintenance", async (options: AgentReadOptions) => {
      await this.freshTenantFilter(options, "write");
      return this.maintain(options);
    });
    this.jobs.register(
      "embed-memory",
      async (payload: { id: string; options?: AgentReadOptions }, context) =>
        this.embedMemoryJob(payload.id, payload.options ?? {}, context.signal),
    );
    this.jobs.register(
      "consolidate-memory",
      async (payload: { options?: AgentReadOptions }, context) => {
        if (context.signal.aborted) throw new Error("consolidation cancelled");
        const options = payload.options ?? {};
        await this.freshTenantFilter(options, "write");
        return this.maintain(options);
      },
    );
    this.jobs.register(
      "validate-memory",
      async (payload: { options?: AgentReadOptions }, context) => {
        if (context.signal.aborted) throw new Error("validation cancelled");
        const options = payload.options ?? {};
        const tenant = await this.freshTenantFilter(options, "read");
        const memories = (await this.#backend.all(true, tenant)).filter((memory) => this.canRead(memory, options));
        return { checked: memories.length };
      },
    );
    this.jobs.register(
      "archive-memory",
      async (payload: { id: string; options?: AgentReadOptions }, context) => {
        if (context.signal.aborted) throw new Error("archive cancelled");
        return this.archiveMemoryJob(payload.id, payload.options ?? {});
      },
    );
  }

  get isTenantStrict(): boolean {
    return this.tenantMode === "strict";
  }

  /** V4 compatibility accessor; strict V5 mode never exposes the raw backend. */
  get db(): MemoryBackend {
    if (this.tenantMode === "strict") {
      throw new RemembraError("TENANT_REQUIRED", "raw backend access is disabled in strict tenant mode");
    }
    return this.#backend;
  }

  get embeddingsEnabled(): boolean {
    return this.embedFn !== undefined;
  }

  /** Queue a maintenance pass without blocking the caller. */
  enqueueMaintenance(options: AgentReadOptions = {}): JobHandle<MaintainResult> {
    this.tenantFilter(options, "write");
    return this.jobs.enqueue<AgentReadOptions, MaintainResult>("maintenance", options);
  }

  enqueueEmbedding(id: string, options: AgentReadOptions = {}): JobHandle<{ id: string; embedded: boolean }> {
    this.tenantFilter(options, "write");
    return this.jobs.enqueue<{ id: string; options: AgentReadOptions }, { id: string; embedded: boolean }>(
      "embed-memory",
      { id, options },
    );
  }

  enqueueConsolidation(options: AgentReadOptions = {}): JobHandle<MaintainResult> {
    this.tenantFilter(options, "write");
    return this.jobs.enqueue<{ options: AgentReadOptions }, MaintainResult>("consolidate-memory", { options });
  }

  enqueueValidation(options: AgentReadOptions = {}): JobHandle<{ checked: number }> {
    this.tenantFilter(options, "read");
    return this.jobs.enqueue<{ options: AgentReadOptions }, { checked: number }>("validate-memory", { options });
  }

  enqueueArchive(id: string, options: AgentReadOptions = {}): JobHandle<{ id: string; archived: boolean }> {
    this.tenantFilter(options, "write");
    return this.jobs.enqueue<{ id: string; options: AgentReadOptions }, { id: string; archived: boolean }>(
      "archive-memory",
      { id, options },
    );
  }

  jobStats(): { queued: number; running: number; capacity: number; concurrency: number } {
    return this.jobs.stats();
  }

  async shutdownBackgroundJobs(): Promise<void> {
    await Promise.all([this.jobs.shutdown(), this.decayPromise ?? Promise.resolve()]);
  }

  /** Transport hook for administrative/non-data routes such as metrics. */
  assertTenantCapability(options: AgentReadOptions, capability: "read" | "write" | "admin"): void {
    this.tenantFilter(options, capability);
  }

  private tenantFilter(
    options: AgentReadOptions,
    capability: "read" | "write" | "admin" = "read",
    operation?: AuthorizationOperation,
  ): TenantFilter | undefined {
    if (this.tenantMode === "strict") assertTenantContext(options.tenant);
    if (!options.tenant) return undefined;
    assertTenantContext(options.tenant);
    const defaultOperation: AuthorizationOperation = capability === "admin"
      ? "tenant.manage"
      : capability === "write"
        ? "memory.write"
        : "memory.search";
    assertAuthorized(options.tenant, operation ?? defaultOperation);
    return tenantFilterFromContext(options.tenant);
  }

  private async freshTenantFilter(
    options: AgentReadOptions,
    capability: "read" | "write" = "read",
    operation?: AuthorizationOperation,
  ) {
    const filter = this.tenantFilter(options, capability, operation);
    if (filter && this.verifyTenantContext) {
      const valid = await this.verifyTenantContext(options.tenant!);
      if (!valid) throw new RemembraError("TENANT_REQUIRED", "tenant membership is no longer valid");
    }
    return filter;
  }

  private async embedMemoryJob(
    id: string,
    options: AgentReadOptions,
    signal: AbortSignal,
  ): Promise<{ id: string; embedded: boolean }> {
    if (signal.aborted) throw new Error("embedding cancelled");
    const tenant = await this.freshTenantFilter(options, "write");
    const memory = await this.#backend.get(id, tenant);
    this.assertCanRead(memory, id, options);
    if (!this.embedFn || memory.embedding?.length) return { id, embedded: false };
    const embedding = await this.maybeEmbed(memory.content, signal, tenant?.organizationId);
    if (signal.aborted) throw new Error("embedding cancelled");
    if (!embedding) return { id, embedded: false };
    await this.#backend.update({ ...memory, embedding }, undefined, tenant);
    return { id, embedded: true };
  }

  private async archiveMemoryJob(
    id: string,
    options: AgentReadOptions,
  ): Promise<{ id: string; archived: boolean }> {
    const tenant = await this.freshTenantFilter(options, "write");
    const memory = await this.#backend.get(id, tenant);
    this.assertCanRead(memory, id, options);
    const archived = await this.#backend.archive(id, tenant);
    return { id, archived: Boolean(archived) };
  }

  /** Returns false rather than disclosing the existence of a private memory. */
  private canRead(memory: Memory, options: AgentReadOptions = {}): boolean {
    const tenant = this.tenantFilter(options, "read");
    if (tenant && !evaluateAuthorization(options.tenant, "memory.read", memory).allowed) return false;
    return canReadMemory(memory, options.agent, this.agentMode);
  }

  private sanitizeMemory(memory: Memory, options: AgentReadOptions, visibleIds: ReadonlySet<string>): Memory {
    const relations = memory.relations?.filter((relation) => visibleIds.has(relation.id));
    const compressedFrom = memory.meta?.compressedFrom?.filter((id) => visibleIds.has(id));
    return {
      ...memory,
      ...(relations?.length ? { relations } : { relations: undefined }),
      ...(memory.supersededBy && visibleIds.has(memory.supersededBy) ? {} : { supersededBy: undefined }),
      ...(memory.meta
        ? {
            meta: {
              ...memory.meta,
              ...(compressedFrom?.length ? { compressedFrom } : { compressedFrom: undefined }),
            },
          }
        : {}),
    };
  }

  private async assertTenantReferences(
    candidate: {
      relations?: Memory["relations"];
      supersededBy?: string;
      meta?: Memory["meta"];
    },
    options: AgentReadOptions,
    tenant: TenantFilter | undefined,
    allowedIds?: ReadonlySet<string>,
  ): Promise<void> {
    if (!tenant) return;
    const ids = new Set<string>();
    for (const relation of candidate.relations ?? []) ids.add(relation.id);
    if (candidate.supersededBy) ids.add(candidate.supersededBy);
    for (const id of candidate.meta?.compressedFrom ?? []) ids.add(id);
    for (const id of ids) {
      if (allowedIds?.has(id)) continue;
      const target = await this.#backend.get(id, tenant);
      if (!target || !this.canRead(target, options)) {
        throw new RemembraError("NOT_FOUND", "reference target not found in the authorized tenant");
      }
    }
  }

  private assertCanRead(memory: Memory | null, id: string, options: AgentReadOptions = {}): asserts memory is Memory {
    if (!memory || !this.canRead(memory, options)) {
      throw new RemembraError("NOT_FOUND", `No memory with id ${id}`);
    }
  }

  private canonicalizeAgentInput(input: StoreInput, options: AgentReadOptions): StoreInput {
    const { sourceType: rawSourceType, ...provenanceFields } = input.provenance ?? {};
    const provenance: Provenance = {
      sourceType: rawSourceType ?? "manual",
      ...provenanceFields,
    };
    const access = input.access ?? defaultAccess();
    if (!this.agentMode) {
      return {
        ...input,
        retention: input.retention ?? this.policy.lifecycle.default,
        access,
        owner: input.owner ?? defaultOwner(provenance),
      };
    }

    const context = options.agent;
    const attributedKeys = [
      "agentId",
      "agentType",
      "agentVersion",
      "conversationId",
      "taskId",
      "runId",
    ] as const;
    const hasAttribution = provenance.sourceType === "agent" || attributedKeys.some((key) => provenance[key] !== undefined);
    if (!context && hasAttribution) {
      throw new RemembraError("INVALID_INPUT", "agent attribution requires a verified agent context");
    }
    if (!context) {
      return {
        ...input,
        retention: input.retention ?? this.policy.lifecycle.default,
        provenance,
        access,
        owner: input.owner ?? defaultOwner(provenance),
      };
    }

    for (const key of attributedKeys) {
      const supplied = provenance[key];
      const verified = context[key];
      if (supplied !== undefined && supplied !== verified) {
        throw new RemembraError("INVALID_INPUT", "agent attribution conflicts with the verified agent context");
      }
    }
    const sourceType = provenance.sourceType === "conversation" || provenance.sourceType === "system" || provenance.sourceType === "import"
      ? provenance.sourceType
      : "agent";
    const canonical: Provenance = {
      ...provenance,
      sourceType,
      agentId: context.agentId,
      ...(context.agentType ? { agentType: context.agentType } : {}),
      ...(context.agentVersion ? { agentVersion: context.agentVersion } : {}),
      ...(context.conversationId ? { conversationId: context.conversationId } : {}),
      ...(context.taskId ? { taskId: context.taskId } : {}),
      ...(context.runId ? { runId: context.runId } : {}),
    };
    return {
      ...input,
      retention: input.retention ?? this.policy.lifecycle.default,
      provenance: canonical,
      access,
      owner: input.owner ?? (sourceType === "agent" ? "agent" : defaultOwner(canonical)),
    };
  }

  private assertAgentWrite(input: StoreInput, options: AgentReadOptions): void {
    if (!this.agentMode) return;
    if (input.scope !== "global" && !canUseScope(input.scope, options.agent)) {
      throw new RemembraError("INVALID_INPUT", "memory scope is not available to the verified agent context");
    }
    const requiresAgentIdentity =
      input.access === "private" ||
      input.owner === "agent" ||
      input.provenance?.sourceType === "agent";
    if (!requiresAgentIdentity) return;

    const verifiedId = options.agent?.agentId;
    const attributedId = input.provenance?.agentId;
    if (
      !verifiedId ||
      ((input.access === "private" || input.owner === "agent" || input.provenance?.sourceType === "agent") &&
        (attributedId !== verifiedId || !canUseScope(input.scope, options.agent)))
    ) {
      throw new RemembraError(
        "INVALID_INPUT",
        "private or agent-owned memory requires a matching verified agent context",
      );
    }
  }

  private async maybeEmbed(text: string, signal?: AbortSignal, cachePartition?: string): Promise<number[] | undefined> {
    if (!this.embedFn) return undefined;
    try {
      return await this.embedFn(text, { signal, ...(cachePartition ? { cachePartition } : {}) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logEvent("warn", "embedding_failed", { error: msg.slice(0, 200) }, `Remembra: embedding failed (${msg.slice(0, 200)}); continuing without`);
      return undefined;
    }
  }

  async store(
    input: unknown,
    options: AgentReadOptions = {},
    /** Internal batch path: a precomputed vector avoids a second provider call. */
    embeddingOverride?: number[] | null,
  ) {
    let parsed: StoreInput;
    try {
      parsed = StoreInput.parse(input);
    } catch (err) {
      throw inputError(err, "INVALID_INPUT");
    }
    parsed = this.canonicalizeAgentInput(parsed, options);
    this.assertAgentWrite(parsed, options);
    const tenant = await this.freshTenantFilter(options, "write");
    if (tenant) {
      assertAuthorized(options.tenant, "memory.write", {
        tenantId: tenant.organizationId,
        ...(tenant.projectId ? { projectId: tenant.projectId } : {}),
        ...(tenant.userId ? { userId: tenant.userId } : {}),
        ...(tenant.agentId ? { agentId: tenant.agentId } : {}),
      });
    }
    await this.assertTenantReferences(parsed, options, tenant);
    // PII redaction (audit Phase 8, opt-in REMEMBRA_REDACT): before embed,
    // before disk, before export — raw patterns never leave this process.
    if (this.redactOn) parsed = this.applyRedaction(parsed);

    // V4.4/V5.0.2: apply the configured sensitive-data policy before any
    // provider call, write, or derived representation is produced.
    parsed = this.applySensitivePolicy(parsed);

    // V4.4: prompt injection detection (informational flag).
    const injection = this.injectionDetector.scan(parsed.content);
    if (injection.flagged) {
      logEvent("warn", "injection.detected", { matches: injection.matches.length }, "Remembra: prompt injection pattern detected in stored memory");
      parsed.meta = { ...parsed.meta, injected: true };
      metrics.inc("remembra_injection_flagged_total");
    }

    const embedding =
      embeddingOverride === undefined
        ? await this.maybeEmbed(parsed.content, undefined, tenant?.organizationId)
        : embeddingOverride ?? undefined;
    // Provenance/trust travel in the input now (plan §4.3): callers that say
    // nothing store as { sourceType: manual } → trusted; digests pass
    // conversation provenance below and land unverified (§4.9).
    const memory = await this.#backend.store(parsed, embedding, tenant);
    if (tenant && !memoryBelongsToTenant(memory, tenant)) {
      throw new RemembraError("TENANT_REQUIRED", "tenant backend did not preserve the trusted organization");
    }
    metrics.inc("remembra_stores_total");
    return {
      id: memory.id,
      message: `Stored ${memory.type} memory ${memory.id} (scope: ${memory.scope})`,
      memory,
    };
  }

  async search(
    q: { query?: string; scope?: string; type?: MemoryType; limit?: number; explain?: boolean; includeExpired?: boolean; includeFuture?: boolean; includeQuarantined?: boolean; includeArchived?: boolean; candidates?: string[] } & AgentReadOptions,
    execution: SearchExecutionOptions = {},
  ) {
    const t0 = performance.now();
    const tenant = await this.freshTenantFilter(q, "read");
    let queryVec: number[] | null = null;
    if (q.query && this.embedFn) queryVec = (await this.maybeEmbed(q.query, undefined, tenant?.organizationId)) ?? null;

    // V4.8: let capable backends generate a bounded keyword candidate set.
    // Agent mode deliberately stays on the full path until a backend can
    // apply the complete trusted visibility policy before its LIMIT.
    const now = Date.now();
    const parsedQuery = extractQuery(q.query);
    const eligible = (m: Memory): boolean => {
      if (!this.canRead(m, q)) return false;
      if (!q.includeExpired && m.validUntil && Date.parse(m.validUntil) < now) return false;
      if (!q.includeFuture && m.validFrom && Date.parse(m.validFrom) > now) return false;
      if (!q.includeQuarantined && m.meta?.quarantined) return false;
      return true;
    };

    let pool: Memory[] | undefined;
    let totalDocs: number | undefined;
    if (
      !queryVec &&
      !this.agentMode &&
      !q.type &&
      !q.candidates?.length &&
      this.#backend.searchCandidates
    ) {
      try {
        const resultLimit = q.limit ?? 10;
        const maxCandidates = Math.max(16, Math.min(128, resultLimit * 2));
        const page = await this.#backend.searchCandidates({
          terms: parsedQuery.terms,
          vector: queryVec,
          scope: q.scope,
          type: q.type,
          includeArchived: q.includeArchived,
          includeExpired: q.includeExpired,
          includeFuture: q.includeFuture,
          includeQuarantined: q.includeQuarantined,
          now,
          resultLimit,
          maxCandidates,
          eligible,
          ...(tenant ? { tenant } : {}),
          temporalBoost:
            parsedQuery.temporal.latestCount !== undefined ||
            parsedQuery.temporal.recentCount !== undefined,
        });
        const uniqueCandidates = new Set(page.memories.map((memory) => memory.id));
        const validTotal =
          page.totalDocs === undefined ||
          (Number.isFinite(page.totalDocs) && page.totalDocs >= 0);
        if (
          page.coverage === "complete" &&
          page.memories.length <= maxCandidates &&
          uniqueCandidates.size === page.memories.length &&
          validTotal &&
          page.memories.every(eligible)
        ) {
          pool = page.memories;
          totalDocs = page.totalDocs;
        }
      } catch (err) {
        logEvent(
          "warn",
          "candidate_generation_failed",
          { error: String(err).slice(0, 200) },
          "Remembra: bounded candidate generation unavailable; using full scan",
        );
      }
    }

    // V4.5: temporal and lifecycle filtering before search.
    pool ??= (await this.#backend.all(q.includeArchived, tenant)).filter(eligible);

    let { results: ranked, explanations } = searchQ(
      pool,
      totalDocs === undefined ? q : { ...q, totalDocs },
      queryVec,
      {
        requireRoleTrust: this.policy.roles.requireTrust,
        diversity: this.policy.retrieval.diversity,
        reranking: this.policy.retrieval.reranking,
        relationExpansion: this.policy.retrieval.relationExpansion,
      },
    );
    if (this.policy.retrieval.relationExpansion && !q.candidates?.length) {
      const expanded = expandRelationCandidates(pool, ranked, { maxDepth: 1, maxEdges: 32 });
      if (expanded.length > ranked.length) {
        const reranked = searchQ(
          expanded,
          {
            ...(totalDocs === undefined ? q : { ...q, totalDocs }),
            candidates: expanded.map((memory) => memory.id),
          },
          queryVec,
          {
            requireRoleTrust: this.policy.roles.requireTrust,
            diversity: this.policy.retrieval.diversity,
            reranking: this.policy.retrieval.reranking,
            relationExpansion: false,
          },
        );
        ranked = reranked.results;
        explanations = reranked.explanations;
      }
    }
    const visibleIds = new Set(pool.map((memory) => memory.id));
    const publicRanked = ranked.map((memory) => this.sanitizeMemory(memory, q, visibleIds));
    const durationMs = performance.now() - t0;

    // Observability (audit Phase 7): counters + hygiene-first query logging —
    // raw query text only under REMEMBRA_DEBUG (same rule as the root path).
    metrics.inc("remembra_searches_total");
    metrics.observe("remembra_search_duration_seconds", durationMs / 1000);
    logEvent("info", "search", {
      scope: q.scope,
      terms: (q.query ?? "").split(/\s+/).filter((t) => t.length > 1).length,
      results: ranked.length,
      limit: q.limit,
      duration_ms: Math.round(durationMs * 10) / 10,
      ...(process.env.REMEMBRA_DEBUG && q.query ? { query: q.query } : {}),
    });

    // Refresh decay clocks for memories that surfaced (fire-and-forget).
    if (execution.touch !== false) {
      for (const m of ranked)
        this.#backend.touch(m.id, tenant).catch((err) => {
          logEvent(
            "warn",
            "touch_failed",
            { id: m.id, error: String(err).slice(0, 150) },
            `Remembra: touch failed (${m.id}): ${String(err).slice(0, 150)}`,
          );
        });
    }
    // Opportunistic decay pass, debounced (decision v3-Q1: piggyback on search).
    if (execution.runDecay !== false) this.maybeRunDecay(q);

    const text =
      ranked.length === 0
        ? "No matching memories."
        : publicRanked
            .map(
              (m) =>
                `[${m.id}] ${m.type.toUpperCase()} (scope: ${m.scope}, importance: ${m.importance}, ${m.updatedAt.slice(0, 10)})\n${m.content}`,
            )
            .join("\n\n");
    return { text, results: publicRanked, ...(explanations ? { explanations } : {}) };
  }

  /** Build a deterministic, token-bounded context from the ranked search path. */
  async context(input: unknown, options: AgentReadOptions = {}): Promise<ContextResult> {
    let parsed: ContextInput;
    try {
      parsed = ContextInput.parse(input);
    } catch (err) {
      throw inputError(err, "INVALID_INPUT");
    }

    const result = await this.search(
      {
        query: parsed.query,
        scope: parsed.scope,
        limit: parsed.limit,
        explain: parsed.explain,
        includeExpired: parsed.includeExpired,
        includeFuture: parsed.includeFuture,
        includeQuarantined: parsed.includeQuarantined,
        includeArchived: parsed.includeArchived,
        ...options,
      },
      { touch: false, runDecay: false },
    );
    const selected = selectContextMemories(result.results, parsed.maxTokens, this.tokenCounter);
    const publicMemories = selected.memories.map(({ embedding: _embedding, ...memory }) => memory);
    return {
      memories: publicMemories,
      context: selected.context,
      tokenCount: selected.tokenCount,
      retrievalMetadata: {
        query: parsed.query ?? "",
        ...(parsed.scope ? { scope: parsed.scope } : {}),
        maxTokens: parsed.maxTokens,
        tokenCounter: this.tokenCounter.id,
        candidateCount: result.results.length,
        selectedCount: selected.memories.length,
        omittedCount: selected.omittedCount,
        ...(parsed.explain && result.explanations ? { explanations: result.explanations } : {}),
      },
    };
  }

  /**
   * Execute a bounded, operation-dispatched batch. The complete request is
   * parsed before the first write. Mutations then run sequentially and report
   * operational failures per item; they are not a cross-item transaction.
   */
  async batch(input: unknown, options: AgentReadOptions = {}) {
    let request: ReturnType<typeof BatchRequest.parse>;
    try {
      let compact: string | undefined;
      try {
        compact = JSON.stringify(input);
      } catch {
        throw new RemembraError("INVALID_INPUT", "batch request must be JSON-serializable");
      }
      if (typeof compact !== "string" || Buffer.byteLength(compact, "utf8") > MAX_BATCH_BYTES) {
        throw new RemembraError("INVALID_INPUT", `batch request exceeds ${MAX_BATCH_BYTES} bytes`);
      }
      request = BatchRequest.parse(input);
    } catch (err) {
      throw inputError(err, "INVALID_INPUT");
    }

    if (request.operation === "store") {
      // Precompute vectors only when it cannot bypass redaction or a reject
      // policy. The public store path remains the fallback and is still used
      // for every item's canonicalization/security checks.
      const precomputed = new Map<number, number[] | null>();
      const embedFn = this.embedFn;
      if (embedFn && !this.redactOn && this.tenantMode === "legacy" && !options.tenant) {
        const hasRejectedContent = request.items.some((item) => {
          const scan = this.sensitiveDetector.scan(item.content);
          return scan.detected && scan.action === "reject";
        });
        if (!hasRejectedContent) {
          try {
            const vectors = await embedTexts(
              request.items.map((item) => item.content),
              "none",
              {
                embedder: async (text, _provider, callOptions) =>
                  embedFn(text, callOptions),
              },
            );
            vectors.forEach((vector, index) => precomputed.set(index, vector));
          } catch (err) {
            logEvent(
              "warn",
              "batch_embedding_precompute_failed",
              { error: String(err).slice(0, 200) },
              "Remembra: batch embedding precompute unavailable; using per-item fallback",
            );
          }
        }
      }

      const results: BatchOutcome[] = [];
      for (const [index, item] of request.items.entries()) {
        try {
          const result = precomputed.has(index)
            ? await this.store(item, options, precomputed.get(index))
            : await this.store(item, options);
          results.push({ index, id: result.id, ok: true, result: { id: result.id, message: result.message } });
        } catch (err) {
          results.push(batchFailure(index, undefined, err));
        }
      }
      recordBatchMetrics("store", results);
      return { operation: "store" as const, summary: batchSummary(results), results };
    }

    if (request.operation === "update") {
      const results: BatchOutcome[] = [];
      for (const [index, item] of request.items.entries()) {
        const { id, ...patch } = item;
        try {
          const result = await this.update(id, patch, options);
          results.push({
            index,
            id,
            ok: true,
            result: { version: result.memory.version, text: result.text },
          });
        } catch (err) {
          results.push(batchFailure(index, id, err));
        }
      }
      recordBatchMetrics("update", results);
      return { operation: "update" as const, summary: batchSummary(results), results };
    }

    if (request.operation === "delete") {
      const results: BatchOutcome[] = [];
      for (const [index, id] of request.ids.entries()) {
        try {
          const result = await this.forget(id, options);
          if (!result.ok) throw new RemembraError("NOT_FOUND", result.text);
          results.push({ index, id, ok: true, result: { text: result.text } });
        } catch (err) {
          results.push(batchFailure(index, id, err));
        }
      }
      recordBatchMetrics("delete", results);
      return { operation: "delete" as const, summary: batchSummary(results), results };
    }

    const selected: Memory[] = [];
    const results: BatchOutcome<{ id: string }>[] = [];
    const tenant = await this.freshTenantFilter(options, "read", "snapshot.create");
    for (const [index, id] of request.ids.entries()) {
      const memory = await this.#backend.get(id, tenant);
      if (!memory || !this.canRead(memory, options)) {
        results.push(batchFailure(index, id, new RemembraError("NOT_FOUND", `No memory with id ${id}`)) as BatchFailure);
        continue;
      }
      selected.push(memory);
      results.push({ index, id, ok: true, result: { id } });
    }
    const selectedIds = new Set(selected.map((memory) => memory.id));
    const memories = selected.map((memory) => this.sanitizeMemory(memory, options, selectedIds));
    const snapshot = {
      format: SNAPSHOT_FORMAT,
      version: tenant ? TENANT_SCHEMA_VERSION : SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      memories,
    } as const;
    const compact = JSON.stringify(snapshot);
    if (Buffer.byteLength(compact, "utf8") > MAX_BATCH_BYTES) {
      throw new RemembraError("INVALID_INPUT", `batch export exceeds ${MAX_BATCH_BYTES} bytes`);
    }
    let output: typeof snapshot | SignedSnapshot = snapshot;
    if (this.requireSignedSnapshots || this.snapshotKey) {
      if (!this.snapshotKey) throw new RemembraError("SNAPSHOT_INVALID", "signed batch export requires a configured HMAC key");
      output = createSignedSnapshot(snapshot, this.snapshotKey);
    }
    recordBatchMetrics("export", results);
    return {
      ...output,
      operation: "export" as const,
      summary: batchSummary(results),
      results,
    };
  }

  async list(q: {
    scope?: string;
    type?: MemoryType;
    includeArchived?: boolean;
    offset?: number;
    limit?: number;
    /** V4.5: include quarantined memories. */
    includeQuarantined?: boolean;
    /** V4.5: include expired memories (validUntil < now). */
    includeExpired?: boolean;
    /** V4.5: include future-dated memories (validFrom > now). */
    includeFuture?: boolean;
  } & AgentReadOptions) {
    const tenant = await this.freshTenantFilter(q, "read");
    let memories = await this.#backend.all(q.includeArchived ?? false, tenant);
    const now = Date.now();
    // V4.5 temporal and lifecycle filtering + V4.7 agent visibility policy.
    memories = memories.filter((m) => {
      if (!this.canRead(m, q)) return false;
      if (!q.includeExpired && m.validUntil && Date.parse(m.validUntil) < now) return false;
      if (!q.includeFuture && m.validFrom && Date.parse(m.validFrom) > now) return false;
      if (!q.includeQuarantined && m.meta?.quarantined) return false;
      return true;
    });
    if (q.scope) memories = memories.filter((m) => m.scope === q.scope || m.scope === "global");
    if (q.type) memories = memories.filter((m) => m.type === q.type);
    const visibleIds = new Set(memories.map((memory) => memory.id));
    memories = memories.map((memory) => this.sanitizeMemory(memory, q, visibleIds));
    memories.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const total = memories.length;

    // Pagination is opt-in: without offset/limit the full list is returned
    // (unchanged behavior — existing clients depend on it).
    const paginated = q.offset !== undefined || q.limit !== undefined;
    const start = q.offset ?? 0;
    const page = paginated ? memories.slice(start, q.limit !== undefined ? start + q.limit : undefined) : memories;

    const header =
      paginated && total > 0
        ? `Showing ${Math.min(start + 1, total)}–${Math.min(start + page.length, total)} of ${total}\n\n`
        : "";
    const body =
      total === 0
        ? "No memories stored yet."
        : page.length === 0
          ? "No memories at this offset."
          : page
              .map(
                (m) =>
                  `[${m.id}]${m.archivedAt ? " [archived]" : ""} ${m.type} (${m.scope}): ${m.content.split("\n")[0]}`,
              )
              .join("\n");
    return {
      text: header + body,
      memories: page,
      total,
      ...(q.offset !== undefined ? { offset: q.offset } : {}),
      ...(q.limit !== undefined ? { limit: q.limit } : {}),
    };
  }

  async forget(id: string, options: AgentReadOptions = {}) {
    const tenant = await this.freshTenantFilter(options, "write");
    const existing = await this.#backend.get(id, tenant);
    if (this.agentMode || tenant) this.assertCanRead(existing, id, options);
    if (!existing) return { ok: false, text: `No memory with id ${id}.` };
    const ok = await this.#backend.forget(id, tenant);
    if (ok && tenant) clearEmbedCachePartition(tenant.organizationId);
    return { ok, text: ok ? `Deleted memory ${id}.` : `No memory with id ${id}.` };
  }

  /**
   * Patch an existing memory (v4: memory_update / PUT /memories/:id).
   * Changing `scope` moves the file between trees (single lock; crash
   * between write and unlink is reconciled by the recovery pass).
   * A content change recomputes (or clears) the embedding vector.
   */
  async update(id: string, input: unknown, options: AgentReadOptions = {}): Promise<{ memory: Memory; text: string }> {
    let patch: UpdateInput;
    try {
      patch = UpdateInput.parse(input);
    } catch (err) {
      throw inputError(err, "INVALID_INPUT");
    }
    // Concurrency + history guards (plan §3.5/§4.6) — never spread onto Memory.
    const { expectedVersion, reason, ...fields } = patch;
    const tenant = await this.freshTenantFilter(options, "write");
    const existing = await this.#backend.get(id, tenant);
    this.assertCanRead(existing, id, options);
    const next: Memory = { ...existing, ...fields };
    if (this.agentMode && !canUseScope(next.scope, options.agent)) {
      throw new RemembraError("INVALID_INPUT", "memory scope is not available to the verified agent context");
    }
    if (fields.content !== undefined && fields.content !== existing.content) {
      const cleaned = this.redactPair(fields.content, next.tags);
      const policyApplied = this.applySensitivePolicy({
        content: cleaned?.content ?? fields.content,
        tags: cleaned?.tags ?? next.tags,
        trust: next.trust,
        meta: next.meta,
      });
      next.content = policyApplied.content;
      if (policyApplied.trust) next.trust = policyApplied.trust;
      if (policyApplied.meta) next.meta = policyApplied.meta;
      const injection = this.injectionDetector.scan(next.content);
      if (injection.flagged) {
        logEvent("warn", "injection.detected", { matches: injection.matches.length }, "Remembra: prompt injection pattern detected in updated memory");
        next.meta = { ...next.meta, injected: true };
        metrics.inc("remembra_injection_flagged_total");
      }
      next.embedding = await this.maybeEmbed(next.content, undefined, tenant?.organizationId); // fail-open → keyword fallback
    }
    // A trust change is a (re)validation event (plan §4.2 lastValidated).
    if (fields.trust !== undefined && fields.trust !== existing.trust) {
      next.lastValidated = new Date().toISOString();
    }
    const memory = await this.#backend.update(next, { expectedVersion, reason }, tenant);
    return { memory, text: `Updated ${id}.` };
  }

  /** Manually archive a memory (v4: memory_archive / POST /memories/:id/archive). */
  async archive(id: string, options: AgentReadOptions = {}): Promise<{ memory: Memory; text: string }> {
    const tenant = await this.freshTenantFilter(options, "write");
    const existing = await this.#backend.get(id, tenant);
    this.assertCanRead(existing, id, options);
    const memory = await this.#backend.archive(id, tenant);
    if (!memory) throw new RemembraError("NOT_FOUND", `No memory with id ${id}`);
    return { memory, text: `Archived ${id}.` };
  }

  /** Bring an archived memory back to active (v4: memory_revive / POST). */
  async revive(id: string, options: AgentReadOptions = {}): Promise<{ memory: Memory; text: string }> {
    const tenant = await this.freshTenantFilter(options, "write");
    const existing = await this.#backend.get(id, tenant);
    this.assertCanRead(existing, id, options);
    const memory = await this.#backend.revive(id, tenant);
    if (!memory) throw new RemembraError("NOT_FOUND", `No memory with id ${id}`);
    return { memory, text: `Revived ${id}.` };
  }

  /** Fetch one memory with its links resolved (audit Phase 8: graph view). */
  async get(id: string, options: AgentReadOptions = {}) {
    const tenant = await this.freshTenantFilter(options, "read");
    const memory = await this.#backend.get(id, tenant);
    this.assertCanRead(memory, id, options);
    const all = await this.#backend.all(true, tenant);
    const visibleIds = new Set(all.filter((candidate) => this.canRead(candidate, options)).map((candidate) => candidate.id));
    const safeMemory = this.sanitizeMemory(memory, options, visibleIds);
    const brief = (m: Memory) => ({
      id: m.id,
      type: m.type,
      scope: m.scope,
      content: m.content.split("\n")[0],
    });
    // Typed outgoing edges (plan §4.7) + derived backlinks, kind included.
    const related: Array<{
      id: string;
      kind: string;
      type?: string;
      scope?: string;
      content?: string;
      missing?: true;
    }> = (safeMemory.relations ?? []).flatMap((r): Array<{
      id: string;
      kind: string;
      type?: string;
      scope?: string;
      content?: string;
      missing?: true;
    }> => {
      const target = all.find((m) => m.id === r.id);
      if (!target) return [{ id: r.id, kind: r.kind, missing: true as const }];
      if (!this.canRead(target, options)) return [];
      return [{ kind: r.kind, ...brief(target) }];
    });
    const backlinks = all
      .filter((m) => m.id !== id && this.canRead(m, options) && m.relations?.some((r) => r.id === id))
      .map((m) => ({
        kind: m.relations!.find((r) => r.id === id)!.kind,
        ...brief(m),
      }));

    const meta =
      `${safeMemory.type} (scope: ${safeMemory.scope}, importance: ${safeMemory.importance}, ` +
      `confidence: ${safeMemory.confidence}, trust: ${safeMemory.trust})`;
    const relLabel = (r: { id: string; kind?: string }) =>
      r.kind && r.kind !== "related" ? `${r.id} (${r.kind})` : r.id;
    const text =
      `[${safeMemory.id}] ${meta}\n${safeMemory.content}` +
      (related.length ? `\n\nRelated: ${related.map(relLabel).join(", ")}` : "") +
      (backlinks.length ? `\nReferenced by: ${backlinks.map(relLabel).join(", ")}` : "");
    return { memory: safeMemory, related, backlinks, text };
  }

  /**
   * Manage directed links between memories (audit Phase 8: relationship
   * graph). Targets are validated on add; backlinks are derived at read
   * time, so one write keeps the edge consistent.
   */
  async relate(input: unknown, options: AgentReadOptions = {}): Promise<{ id: string; related: string[]; added: string[]; removed: string[]; text: string }> {
    let parsed;
    try {
      parsed = RelateInput.parse(input);
    } catch (err) {
      throw inputError(err, "INVALID_INPUT");
    }
    const tenant = await this.freshTenantFilter(options, "write");
    const memory = await this.#backend.get(parsed.id, tenant);
    this.assertCanRead(memory, parsed.id, options);
    if (parsed.related.includes(parsed.id)) {
      throw new RemembraError("INVALID_INPUT", "a memory cannot be related to itself");
    }
    const missing: string[] = [];
    for (const rid of parsed.related) {
      const target = await this.#backend.get(rid, tenant);
      if (!target || !this.canRead(target, options)) missing.push(rid);
    }
    if (missing.length > 0) {
      throw new RemembraError("NOT_FOUND", `related target(s) not found: ${missing.join(", ")}`);
    }
    const current = memory.relations ?? [];
    const currentIds = current.map((r) => r.id);
    const added: string[] = [];
    const removed: string[] = [];
    let relations = current.map((r) => ({ ...r }));
    if (parsed.action === "add") {
      for (const rid of parsed.related) {
        const edge = relations.find((r) => r.id === rid);
        if (!edge) {
          relations.push({ id: rid, kind: parsed.kind });
          added.push(rid);
        } else if (edge.kind !== parsed.kind) {
          edge.kind = parsed.kind; // retype an existing edge
          added.push(rid);
        }
        // same id + same kind → idempotent no-op
      }
    } else {
      relations = relations.filter((r) => {
        if (parsed.related.includes(r.id)) {
          removed.push(r.id);
          return false;
        }
        return true;
      });
    }
    if (added.length > 0 || removed.length > 0) {
      await this.#backend.update(
        {
          ...memory,
          relations: relations.length > 0 ? relations : undefined,
        },
        undefined,
        tenant,
      );
      metrics.inc("remembra_relate_total", { action: parsed.action });
    }
    const next = relations.map((r) => r.id);
    const verb = parsed.action === "add" ? "Linked" : "Unlinked";
    const changed = parsed.action === "add" ? added : removed;
    const text =
      changed.length > 0
        ? `${verb} ${parsed.id} ${parsed.action === "add" ? "→" : "⇁"} ${changed.join(", ")}${
            parsed.action === "add" ? ` [${parsed.kind}]` : ""
          }`
        : `No change: ${parsed.id} links unchanged (${currentIds.length} total)`;
    return { id: parsed.id, related: next, added, removed, text };
  }

  /**
   * Version history with line diffs (audit Phase 8: diff/history view).
   * Newest first; each past version carries a unified diff against its
   * predecessor (the current version diffs against the newest snapshot).
   */
  async history(input: unknown, options: AgentReadOptions = {}): Promise<{
    id: string;
    versions: {
      current?: true;
      file?: string;
      at?: string;
      snapshotAt?: string;
      reason?: string;
      supersededAt?: string;
      content: string;
      diff: string;
    }[];
    text: string;
  }> {
    let parsed;
    try {
      parsed = HistoryInput.parse(input);
    } catch (err) {
      throw inputError(err, "INVALID_INPUT");
    }
    const tenant = await this.freshTenantFilter(options, "read");
    const memory = await this.#backend.get(parsed.id, tenant);
    this.assertCanRead(memory, parsed.id, options);
    const entries = (await this.#backend.history?.(parsed.id, tenant)) ?? [];
    const safeMemory = this.sanitizeMemory(memory, options, new Set([memory.id]));
    const kept = entries.slice(0, parsed.limit ?? entries.length);

    type VersionBase = {
      current?: true;
      file?: string;
      at?: string;
      snapshotAt?: string;
      reason?: string;
      supersededAt?: string;
    };
    const chain: { base: VersionBase; content: string }[] = [
      { base: { current: true, at: safeMemory.updatedAt }, content: safeMemory.content },
      ...kept.map((e) => ({
        base: {
          file: e.file,
          at: e.at,
          snapshotAt: e.snapshotAt,
          reason: e.reason,
          supersededAt: e.supersededAt,
        },
        content: e.content,
      })),
    ];
    const versions = chain.map((v, i) => {
      const older = chain[i + 1];
      const diff = older
        ? unifiedDiff(older.content, v.content, older.base.at ?? "older", v.base.at ?? "current")
        : "";
      return { ...v.base, content: v.content, diff };
    });

    const lines = [`History for ${parsed.id} — ${versions.length} version(s), newest first:`];
    for (const v of versions) {
      const label = v.current
        ? "current"
        : `superseded ${v.snapshotAt?.slice(0, 19) ?? "?"} (was current: ${
            v.at?.slice(0, 19) ?? "?"
          }${v.reason ? `; reason: ${v.reason}` : ""})`;
      lines.push("", `# ${label} — ${v.content.split("\n")[0]}`);
      if (v.diff) lines.push(v.diff.trimEnd());
    }
    return { id: parsed.id, versions, text: lines.join("\n") };
  }

  /**
   * Redact a content+tags pair, emitting metrics + a log event when anything
   * was found. Returns null when disabled or clean (callers keep originals).
   */
  private redactPair(
    content: string,
    tags: string[],
  ): { content: string; tags: string[] } | null {
    if (!this.redactOn) return null;
    const c = redact(content);
    const t = redactTags(tags);
    const counts: Partial<Record<RedactionKind, number>> = {};
    for (const [k, v] of Object.entries(c.counts)) counts[k as RedactionKind] = v as number;
    for (const [k, v] of Object.entries(t.counts)) {
      counts[k as RedactionKind] = (counts[k as RedactionKind] ?? 0) + (v as number);
    }
    if (Object.keys(counts).length === 0) return null;
    for (const [kind, n] of Object.entries(counts)) {
      if (n) metrics.inc("remembra_redactions_total", { kind }, n);
    }
    logEvent("info", "redacted", { ...counts }, `Remembra: redacted PII at ingest (${JSON.stringify(counts)})`);
    return { content: c.text, tags: t.tags };
  }

  /** PII redaction of a store input (audit Phase 8). */
  private applyRedaction(parsed: StoreInput): StoreInput {
    const clean = this.redactPair(parsed.content, parsed.tags);
    if (!clean) return parsed;
    return { ...parsed, content: clean.content, tags: clean.tags };
  }

  /** Apply the configured sensitive-data policy to a content-bearing record. */
  private applySensitivePolicy<
    T extends {
      content: string;
      tags: string[];
      trust?: StoreInput["trust"];
      meta?: StoreInput["meta"];
    },
  >(input: T): T {
    const sensitive = this.sensitiveDetector.scan(input.content);
    if (!sensitive.detected) return input;
    if (sensitive.action === "reject") {
      logEvent("warn", "sensitive_data.rejected", { categories: sensitive.categories }, "Remembra: sensitive data rejected by policy");
      metrics.inc("remembra_errors_total", { code: "SENSITIVE_DATA", transport: "service" });
      throw new RemembraError("SENSITIVE_DATA", `Sensitive data detected (${sensitive.categories.join(", ")})`);
    }
    if (sensitive.action === "quarantine") {
      logEvent("warn", "sensitive_data.quarantined", { categories: sensitive.categories }, "Remembra: sensitive data quarantined by policy");
      metrics.inc("remembra_memory_quarantined_total", { categories: sensitive.categories.join(",") });
      return {
        ...input,
        content: sensitive.text,
        trust: "unverified",
        meta: { ...input.meta, quarantined: true },
      } as T;
    }
    if (sensitive.action === "redact") return { ...input, content: sensitive.text } as T;
    return input;
  }

  /** Readiness probe (audit Phase 7): can the backend actually be read? */
  async health(): Promise<{
    status: "ok" | "unready";
    state: RecoveryState;
    version: string;
    uptime_s: number;
    storage: string;
    backend?: "sqlite" | "file";
    fallback?: boolean;
    cache?: { size: number; capacity: number };
  }> {
    let storage = "ok";
    try {
      await this.#backend.all();
      this.recoveryState = transitionRecoveryState(this.recoveryState, "ready");
      if (this.backendFallback) this.recoveryState = transitionRecoveryState(this.recoveryState, "degraded");
    } catch (err) {
      storage = errorLabel(err);
      this.recoveryState = transitionRecoveryState(this.recoveryState, "failed");
    }
    const cache = this.storageStats();
    return {
      status: storage === "ok" ? "ok" : "unready",
      state: this.recoveryState,
      version: VERSION,
      uptime_s: Math.round(process.uptime()),
      storage,
      ...(this.backendName ? { backend: this.backendName } : {}),
      ...(this.backendName ? { fallback: this.backendFallback } : {}),
      ...(cache ? { cache } : {}),
    };
  }

  /** Parse-cache stats when the backend exposes them (file backend does). */
  storageStats(options: AgentReadOptions = {}): { size: number; capacity: number } | null {
    if (this.tenantMode === "strict" || options.tenant) return null;
    return this.#backend.cacheStats?.() ?? null;
  }

  /** V4.4: query recent audit events. */
  async getAudit(
    opts?: { limit?: number; since?: string },
    options: AgentReadOptions = {},
  ): Promise<{ events: Record<string, unknown>[] }> {
    const tenant = await this.freshTenantFilter(options, "read");
    const events = this.#backend.getAudit ? await this.#backend.getAudit(opts, tenant) : [];
    if (!this.agentMode && !tenant) return { events };
    const visibleIds = new Set(
      (await this.#backend.all(true, tenant)).filter((m) => this.canRead(m, options)).map((m) => m.id),
    );
    return {
      events: events.filter((event) => {
        const id = event.memoryId ?? event.memory_id;
        return typeof id === "string" && visibleIds.has(id);
      }),
    };
  }

  /**
   * Session digest (v2) with contradiction-merge (v3):
   * extract worth-keeping memories, skip exact duplicates, and let the LLM
   * merge items that evolved from a stored memory (superseded text preserved).
   *
   * Serialized through a lock: simultaneous digests could otherwise both
   * read the same active set and double-store duplicates.
   */
  async digest(opts: {
    transcript: string;
    scope?: string;
    source?: string;
    /** Cancellation (plan §3.7): HTTP disconnects abort the in-flight provider calls. */
    signal?: AbortSignal;
  } & AgentReadOptions): Promise<DigestResult> {
    if (!this.policy.extraction.enabled) {
      throw new RemembraError("INVALID_INPUT", "memory extraction is disabled by policy");
    }
    const t0 = performance.now();
    const run = this.digestLock.then(() => this.doDigest(opts));
    this.digestLock = run.then(
      () => undefined,
      () => undefined,
    );
    const observe = () => {
      metrics.observe("remembra_digest_duration_seconds", (performance.now() - t0) / 1000);
    };
    return run.then(
      (res) => {
        metrics.inc("remembra_digests_total");
        metrics.inc("remembra_digest_items_total", { result: "stored" }, res.stored.length);
        metrics.inc("remembra_digest_items_total", { result: "skipped" }, res.skippedDuplicates);
        metrics.inc("remembra_digest_items_total", { result: "merged" }, res.merged);
        observe();
        return res;
      },
      (err) => {
        observe();
        throw err;
      },
    );
  }

  private digestLock: Promise<unknown> = Promise.resolve();

  private async doDigest(opts: {
    transcript: string;
    scope?: string;
    source?: string;
    signal?: AbortSignal;
  } & AgentReadOptions): Promise<DigestResult> {
    const tenant = await this.freshTenantFilter(opts, "write");
    let extracted: ExtractedMemory[];
    try {
      extracted = await this.extractFn(opts.transcript, { signal: opts.signal });
    } catch (err) {
      if (err instanceof RemembraError) throw err; // already classified (PROVIDER_TIMEOUT / LLM_ERROR)
      const msg = err instanceof Error ? err.message : String(err);
      throw new RemembraError("LLM_ERROR", `memory extraction failed: ${msg}`, { cause: err });
    }
    const active = (await this.#backend.all(false, tenant)).filter((m) => this.canRead(m, opts));
    const archived = (await this.#backend.all(true, tenant)).filter((m) => m.archivedAt && this.canRead(m, opts));
    const seen = new Set(active.map((m) => dedupKey(m.type, m.content, m.scope)));

    const stored: Memory[] = [];
    let skippedDuplicates = 0;
    let merged = 0;

    for (const extractedItem of extracted) {
      // Cancellation (§3.7): stop promptly once the caller is gone — already
      // stored items stay (dedup makes a retried digest idempotent).
      if (opts.signal?.aborted) throw new RemembraError("LLM_ERROR", "digest cancelled");
      // PII redaction at the digest boundary: extraction LLM sees the raw
      // transcript (it must, to understand it) — storage never does.
      const clean = this.redactPair(extractedItem.content, extractedItem.tags);
      const item: ExtractedMemory = clean
        ? { ...extractedItem, content: clean.content, tags: clean.tags }
        : extractedItem;
      const scope = item.scope ?? opts.scope ?? "global";
      const key = dedupKey(item.type, item.content, scope);

      // Exact duplicate → skip (or revive if it had decayed).
      if (seen.has(key)) {
        skippedDuplicates++;
        continue;
      }
      const archivedDup = archived.find((m) => dedupKey(m.type, m.content, scope) === key);
      if (archivedDup) {
        const revived = await this.#backend.revive(archivedDup.id, tenant);
        if (revived) {
          seen.add(key);
          merged++; // counted as a revival/refresh
          continue;
        }
      }

      // Fuzzy fast path (Phase 4 / audit: dedup tolerance): textually
      // near-identical same-type/same-scope memory → skip without an LLM
      // call. Semantic near-duplicates (paraphrases) stay below this
      // threshold and still go through the LLM merge below.
      const fuzzyActive = active.find(
        (m) => m.type === item.type && m.scope === scope && nearDuplicate(item.content, m.content),
      );
      if (fuzzyActive) {
        skippedDuplicates++;
        continue;
      }
      const fuzzyArchived = archived.find(
        (m) => m.type === item.type && m.scope === scope && nearDuplicate(item.content, m.content),
      );
      if (fuzzyArchived) {
        const revived = await this.#backend.revive(fuzzyArchived.id, tenant);
        if (revived) {
          seen.add(key);
          merged++;
          continue;
        }
      }

      // Evolved fact → LLM decides: store fresh, skip, or merge.
      const itemVec = (await this.maybeEmbed(item.content, opts.signal, tenant?.organizationId)) ?? null;
      const candidate = this.findCandidate(item, scope, [...active, ...archived], itemVec);
      if (candidate) {
        // Fail-open: a merge LLM failure must never lose the new fact —
        // store it fresh instead (consistent with extraction fail-open).
        let decision: { action: "store" } | { action: "skip" } | { action: "merge"; content: string };
        try {
          decision = await this.mergeFn(
            item.content,
            {
              type: candidate.type,
              content: candidate.content,
            },
            { signal: opts.signal },
          );
        } catch (err) {
          logEvent(
            "warn",
            "merge_llm_failed",
            { error: String(err).slice(0, 150) },
            `Remembra: merge LLM failed (${String(err).slice(0, 150)}); storing fresh`,
          );
          decision = { action: "store" };
        }
        if (decision.action === "skip") {
          skippedDuplicates++;
          continue;
        }
        if (decision.action === "merge") {
          const cleanMerged = this.redactPair(decision.content, []) ?? {
            content: decision.content,
            tags: [] as string[],
          };
          // Plan §4.6: superseded text is NEVER inlined into current content —
          // the pre-image snapshot in history() carries it, with this reason.
          const content = cleanMerged.content;
          const embedding = await this.maybeEmbed(cleanMerged.content, opts.signal, tenant?.organizationId);
          await this.#backend.update(
            { ...candidate, content, embedding, source: opts.source ?? candidate.source },
            { reason: "digest merge (superseded by a newer extraction)" },
            tenant,
          );
          merged++;
          // Re-index dedup set against the new content.
          seen.delete(dedupKey(candidate.type, candidate.content, candidate.scope));
          seen.add(dedupKey(candidate.type, cleanMerged.content, candidate.scope));
          continue;
        }
        // action: "store" → fall through and store fresh
      }

      seen.add(key);
      const { memory } = await this.store({
        type: item.type,
        content: item.content,
        scope,
        tags: item.tags,
        importance: item.importance,
        source: opts.source,
        confidence: item.confidence,
        // Plan §4.3/§4.9: extraction provenance = conversation → stored
        // trust: unverified (never LLM-classified higher — Rule 2). When an
        // authenticated agent requested the digest, retain its attribution.
        provenance: {
          sourceType: "conversation",
          provider: this.llmName,
          ...(opts.agent?.agentId ? { agentId: opts.agent.agentId } : {}),
          ...(opts.agent?.agentType ? { agentType: opts.agent.agentType } : {}),
          ...(opts.agent?.agentVersion ? { agentVersion: opts.agent.agentVersion } : {}),
          ...(opts.agent?.conversationId ? { conversationId: opts.agent.conversationId } : {}),
          ...(opts.agent?.taskId ? { taskId: opts.agent.taskId } : {}),
          ...(opts.agent?.runId ? { runId: opts.agent.runId } : {}),
        },
      }, opts);
      stored.push(memory);
      active.push(memory); // so later items in this batch dedup against it
    }

    return {
      extracted: extracted.length,
      stored,
      skippedDuplicates,
      merged,
      ids: stored.map((m) => m.id),
    };
  }

  /**
   * Explicit maintenance (decision v3-Q1): decay sweep + vector backfill +
   * consolidation analysis (V4.5).
   * Exposed as the `memory_maintain` tool, POST /maintain, and the CLI.
   */
  async maintain(options: AgentReadOptions = {}): Promise<MaintainResult> {
    const tenant = await this.freshTenantFilter(options, "write");
    const result = await this.decayPass(options);
    // Vector backfill: embed active memories stored while embeddings were off.
    if (this.embedFn) {
      const active = (await this.#backend.all(false, tenant)).filter((m) => this.canRead(m, options));
      for (const m of active) {
        if (m.embedding && m.embedding.length > 0) continue;
        const vec = await this.maybeEmbed(m.content, undefined, tenant?.organizationId);
        if (vec) {
          await this.#backend.update({ ...m, embedding: vec }, undefined, tenant);
          result.embedded++;
        }
      }
    }

    // V4.5: consolidation analysis on active memories.
    const active = (await this.#backend.all(false, tenant)).filter((m) => this.canRead(m, options));
    const findings = consolidate(active);
    if (findings.exactDuplicates.length > 0 || findings.nearDuplicates.length > 0 || findings.contradictions.length > 0 || findings.fragments.length > 0) {
      logEvent("info", "consolidation", {
        exact: findings.exactDuplicates.length,
        nearDup: findings.nearDuplicates.length,
        contra: findings.contradictions.length,
        frag: findings.fragments.length,
      }, "Remembra: consolidation pass complete");
      // Flag contradictions in-place.
      for (const c of findings.contradictions) {
        const a = active.find((m) => m.id === c.a);
        const b = active.find((m) => m.id === c.b);
        if (a && !a.meta?.contradicted) {
          await this.#backend.update({ ...a, meta: { ...a.meta, contradicted: true } }, undefined, tenant);
          metrics.inc("remembra_memory_contradicted_total");
        }
        if (b && !b.meta?.contradicted) {
          await this.#backend.update({ ...b, meta: { ...b.meta, contradicted: true } }, undefined, tenant);
          metrics.inc("remembra_memory_contradicted_total");
        }
      }
      result.consolidation = {
        exactDuplicates: findings.exactDuplicates,
        nearDuplicates: findings.nearDuplicates,
        contradictions: findings.contradictions,
        fragments: findings.fragments,
      };
    }

    return result;
  }

  /**
   * V4.5: memory compression — combine fragmented memories into a compact
   * representation via LLM. Requires scope + type filter + optionally ids.
   */
  async compress(input: unknown, options: AgentReadOptions = {}): Promise<{ compressed: Memory[]; sources: string[] }> {
    let parsed: CompressInput;
    try {
      parsed = CompressInput.parse(input);
    } catch (err) {
      throw inputError(err, "INVALID_INPUT");
    }

    // Gather candidate memories.
    const tenant = await this.freshTenantFilter(options, "write");
    let pool = parsed.ids
      ? await Promise.all(parsed.ids.map((id) => this.#backend.get(id, tenant))).then((r) => r.filter(Boolean) as Memory[])
      : await this.#backend.all(false, tenant);
    pool = pool.filter((m) => this.canRead(m, options));
    if (parsed.scope) pool = pool.filter((m) => m.scope === parsed.scope || m.scope === "global");
    if (parsed.type) pool = pool.filter((m) => m.type === parsed.type);
    if (pool.length < 3) return { compressed: [], sources: [] };

    // Sort by createdAt ascending (oldest first).
    pool.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const content = pool.map((m) => `[${m.id}] ${m.content}`).join("\n\n");

    // LLM compression prompt.
    const prompt = `Consolidate the following related memories into one concise, accurate statement. Preserve all key facts and cite the source IDs. Return ONLY the consolidated text, nothing else.\n\n${content}`;

    let compressedContent: string;
    try {
      const extracted = await this.extractFn(prompt, { signal: undefined });
      compressedContent = extracted[0]?.content ?? content;
    } catch {
      // LLM unavailable — fall back to concatenation with provenance tag.
      compressedContent = `[compressed from ${pool.map((m) => m.id).join(",")}] ${pool.map((m) => m.content).join(". ")}`;
    }

    const hasPrivateSource = pool.some((m) => m.access === "private");
    const compressedMem = await this.store({
      type: parsed.type ?? pool[0].type,
      content: compressedContent,
      scope: parsed.scope ?? pool[0].scope,
      tags: pool.flatMap((m) => m.tags),
      importance: Math.max(...pool.map((m) => m.importance ?? 3)),
      confidence: Math.min(...pool.map((m) => m.confidence ?? 0.8)),
      ...(hasPrivateSource ? { owner: "agent" as const, access: "private" as const } : {}),
      provenance: hasPrivateSource
        ? {
            sourceType: "agent",
            agentId: options.agent?.agentId,
            agentType: options.agent?.agentType,
            agentVersion: options.agent?.agentVersion,
            provider: this.llmName,
          }
        : { sourceType: "system", provider: this.llmName },
      meta: { compressedFrom: pool.map((m) => m.id), compressionAt: new Date().toISOString() },
    }, options);

    metrics.inc("remembra_memory_compressed_total", { count: String(pool.length) });
    return { compressed: [compressedMem.memory], sources: pool.map((m) => m.id) };
  }

  /** V4.7: non-content attribution and count summary for one agent. */
  async getAgentSummary(
    agentId: string,
    options: AgentReadOptions = {},
  ): Promise<{
    agentId: string;
    agentType?: string;
    agentVersion?: string;
    memories: { total: number; private: number; shared: number; global: number };
  }> {
    if (options.agent?.agentId !== agentId) {
      throw new RemembraError("NOT_FOUND", `No agent with id ${agentId}`);
    }
    const tenant = await this.freshTenantFilter(options, "read");
    const memories = (await this.#backend.all(true, tenant))
      .filter((m) => this.canRead(m, options))
      .filter((m) => m.provenance.agentId === agentId);
    const latest = memories[0];
    return {
      agentId,
      ...(latest?.provenance.agentType ? { agentType: latest.provenance.agentType } : {}),
      ...(latest?.provenance.agentVersion ? { agentVersion: latest.provenance.agentVersion } : {}),
      memories: {
        total: memories.length,
        private: memories.filter((m) => m.access === "private").length,
        shared: memories.filter((m) => m.access === "shared").length,
        global: memories.filter((m) => (m.access ?? "global") === "global").length,
      },
    };
  }

  /** V4.6: memory health dashboard (GET /quality). */
  async quality(options: AgentReadOptions = {}): Promise<{
    memories: { active: number; archived: number; deleted_total: number; growth_rate_per_day: number };
    duplicate_rate: number;
    conflict_rate: number;
    stale_rate: number;
    health_distribution: { active: number; aging: number; quarantined: number };
    retrieval: { avg_latency_ms: number; p99_latency_ms: number; cache_hit_rate: number };
    providers: { embeddings: { failures: number; latency_ms_avg: number }; llm: { failures: number; latency_ms_avg: number; tokens_total: number } };
  }> {
    const now = Date.now();
    const tenant = await this.freshTenantFilter(options, "read");
    const all = (await this.#backend.all(true, tenant)).filter((m) => this.canRead(m, options));
    const active = all.filter((m) => !m.archivedAt && !m.meta?.quarantined);
    const archived = all.filter((m) => m.archivedAt);
    const quarantined = all.filter((m) => m.meta?.quarantined);
    const aged = all.filter((m) => {
      const state = getLifecycleState(m, {}, { healthAgingThreshold: 0.35, healthArchiveThreshold: 0.15 });
      return state === "aging";
    });
    const total = all.length;
    // Count exact duplicates (O(n²) but fine for dashboard).
    const seen = new Set<string>();
    let dupCount = 0;
    for (const m of all) {
      const fp = `${m.type}|${m.scope}|${m.content.trim().toLowerCase()}`;
      if (seen.has(fp)) dupCount++;
      else seen.add(fp);
    }
    const contraCount = all.filter((m) => m.meta?.contradicted).length;

    // Growth rate.
    const sortedByCreated = [...all].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const oldest = sortedByCreated[0];
    const daysSinceStart = oldest ? (now - Date.parse(oldest.createdAt)) / 86_400_000 : 1;
    const growthRate = total / Math.max(daysSinceStart, 1);

    // Deleted total from audit log.
    let deletedTotal = 0;
    try {
      const audits = await this.#backend.getAudit?.({ limit: 10000 }, tenant).catch(() => []) ?? [];
      const visibleIds = new Set(all.map((m) => m.id));
      deletedTotal = audits.filter((e) => {
        const event = e as Record<string, unknown>;
        const id = event.memoryId ?? event.memory_id;
        return event.action === "delete" && (!this.agentMode || (typeof id === "string" && visibleIds.has(id)));
      }).length;
    } catch { deletedTotal = 0; }

    return {
      memories: {
        active: active.length,
        archived: archived.length,
        deleted_total: deletedTotal,
        growth_rate_per_day: Math.round(growthRate * 10) / 10,
      },
      duplicate_rate: total > 0 ? Math.round((dupCount / total) * 100) / 100 : 0,
      conflict_rate: total > 0 ? Math.round((contraCount / total) * 100) / 100 : 0,
      stale_rate: total > 0 ? Math.round((aged.length / total) * 100) / 100 : 0,
      health_distribution: {
        active: active.length,
        aging: aged.length,
        quarantined: quarantined.length,
      },
      retrieval: {
        avg_latency_ms: 0,
        p99_latency_ms: 0,
        cache_hit_rate: 0,
      },
      providers: {
        embeddings: { failures: 0, latency_ms_avg: 0 },
        llm: { failures: 0, latency_ms_avg: 0, tokens_total: 0 },
      },
    };
  }

  /**
   * Full snapshot for backup (audit #8): every memory incl. archived.
   * Written by `remembra export <file>` as JSON.
   */
  async exportSnapshot(options: AgentReadOptions = {}) {
    const tenant = await this.freshTenantFilter(options, "read", "snapshot.create");
    const visible = (await this.#backend.all(true, tenant)).filter((m) => this.canRead(m, options));
    const visibleIds = new Set(visible.map((m) => m.id));
    const memories = visible.map((m) => this.sanitizeMemory(m, options, visibleIds));
    const snapshot = {
      format: SNAPSHOT_FORMAT,
      version: tenant ? TENANT_SCHEMA_VERSION : SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      memories,
    };
    if (this.requireSignedSnapshots) {
      if (!this.snapshotKey) throw new RemembraError("SNAPSHOT_INVALID", "signed snapshot export requires a configured HMAC key");
      return createSignedSnapshot(snapshot, this.snapshotKey);
    }
    if (this.snapshotKey) return createSignedSnapshot(snapshot, this.snapshotKey);
    return snapshot;
  }

  /** Shared snapshot preflight: validate and normalize every record before writes. */
  private async prepareSnapshotImport(
    data: unknown,
    options: AgentReadOptions = {},
  ): Promise<PreparedSnapshotImport> {
    const tenant = await this.freshTenantFilter(options, "write", "snapshot.restore");
    let snap: ReturnType<typeof SnapshotInput.parse>;
    try {
      if (this.requireSignedSnapshots || this.snapshotKey || isSignedSnapshot(data)) {
        if (!this.snapshotKey) throw new RemembraError("SNAPSHOT_INVALID", "signed snapshot import requires a configured HMAC key");
        snap = verifySignedSnapshot(data, this.snapshotKey);
      } else {
        snap = SnapshotInput.parse(data); // throws before any write
      }
    } catch (err) {
      if (err instanceof RemembraError) throw err;
      throw inputError(err, "SNAPSHOT_INVALID");
    }
    const allExisting = await this.#backend.all(true, tenant);
    const hiddenExistingIds = new Set(
      allExisting.filter((m) => !this.canRead(m, options)).map((m) => m.id),
    );
    const existing = allExisting.filter((m) => this.canRead(m, options));
    const ids = new Set(existing.map((m) => m.id));
    const keys = new Set(existing.map((m) => dedupKey(m.type, m.content, m.scope)));
    const prepared: Memory[] = [];
    let skipped = 0;
    for (const raw of snap.memories) {
      if (!tenant && raw.tenantId) {
        throw new RemembraError("SNAPSHOT_INVALID", "tenant-bearing snapshot requires a tenant-scoped destination");
      }
      if (tenant) {
        if (!raw.tenantId) {
          throw new RemembraError("SNAPSHOT_INVALID", "tenant-scoped restore requires tenant metadata");
        }
        if (!memoryBelongsToTenant(raw, tenant)) {
          throw new RemembraError("SNAPSHOT_INVALID", "snapshot dimensions do not match the trusted tenant context");
        }
      }
      const key = dedupKey(raw.type, raw.content, raw.scope);
      if (ids.has(raw.id) || keys.has(key)) {
        skipped++;
        continue;
      }
      // Normalize pre-4.1 snapshot shapes (plan §4.3/§4.7): legacy string
      // provenance, untyped `related`, missing trust/version.
      const { related: legacyRelated, provenance: prov, ...rest } = raw;
      const provenance: Provenance =
        typeof prov === "string"
          ? { sourceType: prov === "auto" ? "conversation" : "manual" }
          : (prov ?? { sourceType: "manual" });
      let m: Memory = {
        ...rest,
        ...(tenant
          ? {
              tenantId: tenant.organizationId,
              ...(tenant.projectId ? { projectId: tenant.projectId } : {}),
              ...(tenant.userId ? { userId: tenant.userId } : {}),
              ...(tenant.agentId ? { agentId: tenant.agentId } : {}),
            }
          : {}),
        provenance,
        confidence: rest.confidence ?? (provenance.sourceType === "conversation" ? 0.7 : 1),
        trust: rest.trust ?? defaultTrust(provenance),
        version: rest.version ?? 1,
        relations:
          rest.relations ??
          legacyRelated?.map((rid) => ({ id: rid, kind: "related" as const })),
      };
      const policy = this.agentMode
        ? this.canonicalizeAgentInput(m, options)
        : { ...m, access: m.access ?? "global" as const, owner: m.owner ?? defaultOwner(m.provenance) };
      m = {
        ...m,
        provenance: (policy.provenance ?? m.provenance) as Provenance,
        owner: policy.owner,
        access: policy.access,
      };
      const cleaned = this.applyRedaction({ ...m, content: m.content, tags: m.tags } as StoreInput);
      const policyApplied = this.applySensitivePolicy(cleaned);
      m = {
        ...m,
        content: policyApplied.content,
        tags: policyApplied.tags,
        ...(policyApplied.trust ? { trust: policyApplied.trust } : {}),
        ...(policyApplied.meta ? { meta: policyApplied.meta } : {}),
      };
      this.assertAgentWrite(m, options);
      prepared.push(m);
      ids.add(m.id);
      keys.add(key);
    }

    const importReferenceIds = new Set([...existing.map((m) => m.id), ...prepared.map((m) => m.id)]);
    for (const m of prepared) {
      await this.assertTenantReferences(m, options, tenant, importReferenceIds);
    }

    for (const m of prepared) {
      const relations = m.relations?.filter((r) => !hiddenExistingIds.has(r.id));
      if (relations?.length !== m.relations?.length) m.relations = relations?.length ? relations : undefined;
    }

    return { prepared, skipped, tenant };
  }

  /** Validate a snapshot and report restore counts without writing anything. */
  async previewSnapshot(data: unknown, options: AgentReadOptions = {}): Promise<SnapshotPreview> {
    const prepared = await this.prepareSnapshotImport(data, options);
    return {
      total: prepared.prepared.length + prepared.skipped,
      imported: prepared.prepared.length,
      skipped: prepared.skipped,
    };
  }

  /** Restore a fully preflighted snapshot; existing/duplicate IDs are skipped. */
  async importSnapshot(data: unknown, options: AgentReadOptions = {}): Promise<{ imported: number; skipped: number }> {
    const prepared = await this.prepareSnapshotImport(data, options);
    let imported = 0;
    let skipped = prepared.skipped;
    for (const memory of prepared.prepared) {
      if (await this.#backend.importMemory(memory, prepared.tenant)) imported++;
      else skipped++;
    }
    return { imported, skipped };
  }

  /**
   * Apply a signed, explicit V5 migration plan to tenantless snapshot data.
   * Ordinary restore never reaches this path; callers must provide the plan,
   * key, and trusted destination context explicitly.
   */
  async migrateSnapshot(
    data: unknown,
    plan: TenantMigrationPlan,
    key: Buffer | Uint8Array,
    options: AgentReadOptions & { dryRun?: boolean } = {},
  ): Promise<SnapshotMigrationResult> {
    const tenant = await this.freshTenantFilter(options, "write", "snapshot.restore");
    if (!tenant) throw new RemembraError("TENANT_REQUIRED", "snapshot migration requires a trusted tenant context");
    const snapshot = verifySignedSnapshot(data, key);
    const sourceById = new Map(snapshot.memories.map((memory) => [memory.id, memory]));
    if (sourceById.size !== snapshot.memories.length) {
      throw new RemembraError("SNAPSHOT_INVALID", "snapshot migration contains duplicate source ids");
    }
    if (sourceById.size !== plan.records.length) {
      throw new RemembraError("SNAPSHOT_INVALID", "snapshot migration source set does not match the signed plan");
    }
    for (const record of plan.records) {
      const source = sourceById.get(record.source.id);
      if (!source || source.content !== record.source.content || source.type !== record.source.type || source.scope !== record.source.scope) {
        throw new RemembraError("SNAPSHOT_INVALID", `snapshot migration source mismatch for ${record.source.id}`);
      }
      if (record.destination.tenantId !== tenant.organizationId) {
        throw new RemembraError("SNAPSHOT_INVALID", "snapshot migration target does not match the trusted tenant context");
      }
    }
    preflightTenantMigration(plan, this.#backend, key, tenant);
    const total = plan.records.length;
    if (options.dryRun) return { total, planned: total, imported: 0, skipped: 0, dryRun: true };
    const result = await applyTenantMigration(plan, this.#backend, key, { destinationFilter: tenant });
    return {
      total,
      planned: total,
      imported: result.imported,
      skipped: result.skipped,
      dryRun: false,
    };
  }

  /** Decay lifecycle: unused actives → archived → auto-deleted past TTL. */
  private async decayPass(options: AgentReadOptions = {}): Promise<MaintainResult> {
    const tenant = await this.freshTenantFilter(options, "write");
    const now = Date.now();
    const archiveCutoff = now - this.archiveAfterDays * 86_400_000;
    const ttlCutoff = now - this.archiveTtlDays * 86_400_000;
    const result: MaintainResult = { archived: [], deleted: [], embedded: 0 };

    const active = (await this.#backend.all(false, tenant)).filter((m) => this.canRead(m, options));
    for (const m of active) {
      // Standing instructions never decay (role + instruction, plan §4.9).
      if (m.type === "role" || m.type === "instruction") continue;
      // Protected memories (plan §4.8): pinned / neverExpire are fully exempt.
      // persistent still archives but is never auto-deleted below. `ephemeral`
      // accelerates nothing yet — its clock lands with §8/4.5.0.
      if (m.retention === "pinned" || m.retention === "neverExpire") continue;
      const lastActive = Date.parse(m.lastSeen ?? m.updatedAt);
      if (Number.isFinite(lastActive) && lastActive < archiveCutoff) {
        await this.#backend.archive(m.id, tenant);
        result.archived.push(m.id);
      }
    }

    const archived = (await this.#backend.all(true, tenant)).filter((m) => m.archivedAt && this.canRead(m, options));
    for (const m of archived) {
      // §4.8: critical memories must not disappear — persistent is
      // archived-but-kept; pinned / neverExpire are never touched.
      if (
        m.retention === "persistent" ||
        m.retention === "pinned" ||
        m.retention === "neverExpire"
      ) {
        continue;
      }
      const archivedAt = Date.parse(m.archivedAt!);
      if (Number.isFinite(archivedAt) && archivedAt < ttlCutoff) {
        await this.#backend.forget(m.id, tenant);
        result.deleted.push(m.id);
      }
    }
    return result;
  }

  private maybeRunDecay(options: AgentReadOptions = {}): void {
    if (this.decayRunning) return;
    if (Date.now() - this.lastDecayRun < this.decayIntervalMs) return;
    this.lastDecayRun = Date.now();
    this.decayRunning = true;
    const task = this.decayPass(options)
      .catch((err) =>
        logEvent(
          "warn",
          "decay_failed",
          { error: String(err).slice(0, 200) },
          `Remembra: decay pass failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      )
      .finally(() => {
        this.decayRunning = false;
        if (this.decayPromise === task) this.decayPromise = null;
      });
    this.decayPromise = task;
  }

  /** Pick the most similar stored memory of the same type+scope for merge comparison. */
  private findCandidate(
    item: ExtractedMemory,
    scope: string,
    pool: Memory[],
    itemVec: number[] | null,
  ): Memory | null {
    let best: Memory | null = null;
    let bestScore = 0;
    for (const m of pool) {
      if (m.type !== item.type || m.scope !== scope) continue;
      const score = candidateSimilarity(item.content, m, itemVec);
      if (score > bestScore) {
        bestScore = score;
        best = m;
      }
    }
    // Threshold: must be clearly about the same thing before spending an LLM call.
    return bestScore >= 0.4 ? best : null;
  }
}

/** Normalized identity for exact-match dedup. */
function dedupKey(type: string, content: string, scope: string): string {
  return `${type}|${scope}|${content.toLowerCase().replace(/\s+/g, " ").trim()}`;
}

/** Punctuation/case-folded text for fuzzy comparison. */
function normalizeForFuzzy(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Textual near-identity (Phase 4 fast path): normalized equality or a
 * Sørensen–Dice coefficient over character bigrams ≥ 0.9. Catches typos,
 * punctuation and minor edits without spending an LLM call. Genuinely
 * different wordings score well below 0.9 and keep going to the LLM merge.
 */
function nearDuplicate(a: string, b: string): boolean {
  const na = normalizeForFuzzy(a);
  const nb = normalizeForFuzzy(b);
  if (na === nb) return true; // equal apart from punctuation/case (dedupKey only folds case+whitespace)
  // A changed quantity (100→500 rpm, v2→v3, dates) is a *different fact*,
  // textually near-identical or not — defer to the LLM merge.
  const numsA = (na.match(/\d+/g) ?? []).join(",");
  const numsB = (nb.match(/\d+/g) ?? []).join(",");
  if (numsA !== numsB) return false;
  if (na.length < 8 || nb.length < 8) return false; // too short to judge by bigrams
  return diceBigrams(na, nb) >= 0.9;
}

function diceBigrams(a: string, b: string): number {
  const grams = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const ga = grams(a);
  const gb = grams(b);
  let overlap = 0;
  for (const [g, c] of ga) overlap += Math.min(c, gb.get(g) ?? 0);
  const totalA = [...ga.values()].reduce((x, y) => x + y, 0);
  const totalB = [...gb.values()].reduce((x, y) => x + y, 0);
  if (totalA === 0 || totalB === 0) return 0;
  return (2 * overlap) / (totalA + totalB);
}

/** Similarity: embeddings (cosine) when both sides have vectors, else keyword overlap. */
function candidateSimilarity(newContent: string, m: Memory, itemVec: number[] | null): number {
  if (itemVec && m.embedding && m.embedding.length === itemVec.length) {
    // Cosine is typically 0..1 for normalized-ish text vectors; scale to our 0..1 threshold.
    return Math.max(0, cosine(itemVec, m.embedding));
  }
  const terms = new Set(
    newContent
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 3),
  );
  if (terms.size === 0) return 0;
  const hay = m.content.toLowerCase();
  let hits = 0;
  for (const t of terms) if (hay.includes(t)) hits++;
  return hits / terms.size;
}
