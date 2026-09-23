import type { MemoryBackend } from "./backend.js";
import { search } from "./retrieval.js";
import { StoreInput, MemoryType, Memory, SnapshotInput, SNAPSHOT_FORMAT, SCHEMA_VERSION } from "./types.js";
import { RemembraError, inputError, errorLabel } from "./errors.js";
import { resolveEmbeddingProvider, embedText, EmbeddingProvider, cosine } from "./embeddings.js";
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
  ExtractedMemory,
} from "./llm.js";

export interface DigestResult {
  extracted: number;
  stored: Memory[];
  skippedDuplicates: number;
  merged: number;
  ids: string[];
}

export interface MaintainResult {
  archived: string[];
  deleted: string[];
  embedded: number;
  revived?: number;
}

interface ServiceDeps {
  embeddingProvider?: EmbeddingProvider;
  llmProvider?: LlmProvider;
  /** Injection points for tests. */
  embedFn?: (text: string, opts?: { signal?: AbortSignal }) => Promise<number[]>;
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
}

/**
 * Transport-agnostic handlers. Both the MCP tools and the HTTP API
 * call into this module, so behavior is guaranteed to match.
 */
export class MemoryService {
  private readonly embedFn?: (text: string, opts?: { signal?: AbortSignal }) => Promise<number[]>;
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
  private lastDecayRun = 0;
  private decayRunning = false;

  constructor(readonly db: MemoryBackend, deps: ServiceDeps = {}) {
    const emb = deps.embeddingProvider ?? resolveEmbeddingProvider();
    const llm = deps.llmProvider ?? resolveLlmProvider();

    this.embedFn =
      deps.embedFn ??
      (emb === "none"
        ? undefined
        : async (text: string, o?: { signal?: AbortSignal }) => embedText(text, emb, { signal: o?.signal }));

    this.extractFn =
      deps.extractFn ?? (async (t: string, o?: { signal?: AbortSignal }) => extractMemories(t, llm, { signal: o?.signal }));
    this.mergeFn =
      deps.mergeFn ?? ((n, e, o?: { signal?: AbortSignal }) => resolveMerge(n, e, llm, { signal: o?.signal }));

    this.decayIntervalMs = deps.decayIntervalMs ?? 3_600_000; // 1h
    this.archiveAfterDays = deps.archiveAfterDays ?? Number(process.env.REMEMBRA_ARCHIVE_AFTER_DAYS ?? 90);
    this.archiveTtlDays = deps.archiveTtlDays ?? Number(process.env.REMEMBRA_ARCHIVE_TTL_DAYS ?? 365);
    this.redactOn = deps.redact ?? redactionEnabled();
  }

  get embeddingsEnabled(): boolean {
    return this.embedFn !== undefined;
  }

  private async maybeEmbed(text: string, signal?: AbortSignal): Promise<number[] | undefined> {
    if (!this.embedFn) return undefined;
    try {
      return await this.embedFn(text, { signal });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logEvent("warn", "embedding_failed", { error: msg.slice(0, 200) }, `Remembra: embedding failed (${msg.slice(0, 200)}); continuing without`);
      return undefined;
    }
  }

  async store(
    input: unknown,
    opts?: { provenance?: Memory["provenance"] },
  ) {
    let parsed: StoreInput;
    try {
      parsed = StoreInput.parse(input);
    } catch (err) {
      throw inputError(err, "INVALID_INPUT");
    }
    // PII redaction (audit Phase 8, opt-in REMEMBRA_REDACT): before embed,
    // before disk, before export — raw patterns never leave this process.
    if (this.redactOn) parsed = this.applyRedaction(parsed);
    const embedding = await this.maybeEmbed(parsed.content);
    const memory = await this.db.store(parsed, embedding, {
      provenance: opts?.provenance ?? "explicit",
    });
    metrics.inc("remembra_stores_total");
    return {
      id: memory.id,
      message: `Stored ${memory.type} memory ${memory.id} (scope: ${memory.scope})`,
      memory,
    };
  }

  async search(q: { query?: string; scope?: string; type?: MemoryType; limit?: number }) {
    const t0 = performance.now();
    let queryVec: number[] | null = null;
    if (q.query && this.embedFn) queryVec = (await this.maybeEmbed(q.query)) ?? null;

    const results = search(await this.db.all(), q, queryVec);
    const durationMs = performance.now() - t0;

    // Observability (audit Phase 7): counters + hygiene-first query logging —
    // raw query text only under REMEMBRA_DEBUG (same rule as the root path).
    metrics.inc("remembra_searches_total");
    metrics.observe("remembra_search_duration_seconds", durationMs / 1000);
    logEvent("info", "search", {
      scope: q.scope,
      terms: (q.query ?? "").split(/\s+/).filter((t) => t.length > 1).length,
      results: results.length,
      limit: q.limit,
      duration_ms: Math.round(durationMs * 10) / 10,
      ...(process.env.REMEMBRA_DEBUG && q.query ? { query: q.query } : {}),
    });

    // Refresh decay clocks for memories that surfaced (fire-and-forget).
    for (const m of results)
      this.db.touch(m.id).catch((err) => {
        logEvent(
          "warn",
          "touch_failed",
          { id: m.id, error: String(err).slice(0, 150) },
          `Remembra: touch failed (${m.id}): ${String(err).slice(0, 150)}`,
        );
      });
    // Opportunistic decay pass, debounced (decision v3-Q1: piggyback on search).
    this.maybeRunDecay();

    const text =
      results.length === 0
        ? "No matching memories."
        : results
            .map(
              (m) =>
                `[${m.id}] ${m.type.toUpperCase()} (scope: ${m.scope}, importance: ${m.importance}, ${m.updatedAt.slice(0, 10)})\n${m.content}`,
            )
            .join("\n\n");
    return { text, results };
  }

  async list(q: {
    scope?: string;
    type?: MemoryType;
    includeArchived?: boolean;
    offset?: number;
    limit?: number;
  }) {
    let memories = await this.db.all(q.includeArchived ?? false);
    if (q.scope) memories = memories.filter((m) => m.scope === q.scope || m.scope === "global");
    if (q.type) memories = memories.filter((m) => m.type === q.type);
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

  async forget(id: string) {
    const ok = await this.db.forget(id);
    return { ok, text: ok ? `Deleted memory ${id}.` : `No memory with id ${id}.` };
  }

  /**
   * Patch an existing memory (v4: memory_update / PUT /memories/:id).
   * Changing `scope` moves the file between trees (single lock; crash
   * between write and unlink is reconciled by the recovery pass).
   * A content change recomputes (or clears) the embedding vector.
   */
  async update(id: string, input: unknown): Promise<{ memory: Memory; text: string }> {
    let patch: Partial<StoreInput>;
    try {
      patch = UpdateInput.parse(input);
    } catch (err) {
      throw inputError(err, "INVALID_INPUT");
    }
    const existing = await this.db.get(id);
    if (!existing) throw new RemembraError("NOT_FOUND", `No memory with id ${id}`);
    const next: Memory = { ...existing, ...patch };
    if (patch.content !== undefined && patch.content !== existing.content) {
      next.embedding = await this.maybeEmbed(patch.content); // fail-open → keyword fallback
    }
    const memory = await this.db.update(next);
    return { memory, text: `Updated ${id}.` };
  }

  /** Manually archive a memory (v4: memory_archive / POST /memories/:id/archive). */
  async archive(id: string): Promise<{ memory: Memory; text: string }> {
    const memory = await this.db.archive(id);
    if (!memory) throw new RemembraError("NOT_FOUND", `No memory with id ${id}`);
    return { memory, text: `Archived ${id}.` };
  }

  /** Bring an archived memory back to active (v4: memory_revive / POST). */
  async revive(id: string): Promise<{ memory: Memory; text: string }> {
    const memory = await this.db.revive(id);
    if (!memory) throw new RemembraError("NOT_FOUND", `No memory with id ${id}`);
    return { memory, text: `Revived ${id}.` };
  }

  /** Fetch one memory with its links resolved (audit Phase 8: graph view). */
  async get(id: string) {
    const memory = await this.db.get(id);
    if (!memory) throw new RemembraError("NOT_FOUND", `No memory with id ${id}`);
    const all = await this.db.all(true);
    const brief = (m: Memory) => ({
      id: m.id,
      type: m.type,
      scope: m.scope,
      content: m.content.split("\n")[0],
    });
    const related = (memory.related ?? []).map((rid) => {
      const target = all.find((m) => m.id === rid);
      return target ? brief(target) : { id: rid, missing: true as const };
    });
    const backlinks = all.filter((m) => m.id !== id && (m.related ?? []).includes(id)).map(brief);

    const meta =
      `${memory.type} (scope: ${memory.scope}, importance: ${memory.importance}` +
      `${memory.confidence !== undefined ? `, confidence: ${memory.confidence}` : ""})`;
    const text =
      `[${memory.id}] ${meta}\n${memory.content}` +
      (related.length ? `\n\nRelated: ${related.map((r) => r.id).join(", ")}` : "") +
      (backlinks.length ? `\nReferenced by: ${backlinks.map((b) => b.id).join(", ")}` : "");
    return { memory, related, backlinks, text };
  }

  /**
   * Manage directed links between memories (audit Phase 8: relationship
   * graph). Targets are validated on add; backlinks are derived at read
   * time, so one write keeps the edge consistent.
   */
  async relate(input: unknown): Promise<{ id: string; related: string[]; added: string[]; removed: string[]; text: string }> {
    let parsed;
    try {
      parsed = RelateInput.parse(input);
    } catch (err) {
      throw inputError(err, "INVALID_INPUT");
    }
    const memory = await this.db.get(parsed.id);
    if (!memory) throw new RemembraError("NOT_FOUND", `No memory with id ${parsed.id}`);
    if (parsed.related.includes(parsed.id)) {
      throw new RemembraError("INVALID_INPUT", "a memory cannot be related to itself");
    }
    if (parsed.action === "add") {
      const missing: string[] = [];
      for (const rid of parsed.related) {
        if (!(await this.db.get(rid))) missing.push(rid);
      }
      if (missing.length > 0) {
        throw new RemembraError("NOT_FOUND", `related target(s) not found: ${missing.join(", ")}`);
      }
    }
    const current = memory.related ?? [];
    const added =
      parsed.action === "add" ? parsed.related.filter((r) => !current.includes(r)) : [];
    const removed = parsed.action === "remove" ? current.filter((r) => parsed.related.includes(r)) : [];
    let next =
      parsed.action === "add" ? [...current, ...added] : current.filter((r) => !parsed.related.includes(r));
    if (added.length === 0 && removed.length === 0) {
      next = current; // no-op: don't churn updatedAt for an idempotent call
    } else {
      await this.db.update({ ...memory, related: next });
      metrics.inc("remembra_relate_total", { action: parsed.action });
    }
    const verb = parsed.action === "add" ? "Linked" : "Unlinked";
    const changed = parsed.action === "add" ? added : removed;
    const text =
      changed.length > 0
        ? `${verb} ${parsed.id} ${parsed.action === "add" ? "→" : "⇁"} ${changed.join(", ")}`
        : `No change: ${parsed.id} links unchanged (${next.length} total)`;
    return { id: parsed.id, related: next, added, removed, text };
  }

  /**
   * Version history with line diffs (audit Phase 8: diff/history view).
   * Newest first; each past version carries a unified diff against its
   * predecessor (the current version diffs against the newest snapshot).
   */
  async history(input: unknown): Promise<{
    id: string;
    versions: {
      current?: true;
      file?: string;
      at?: string;
      snapshotAt?: string;
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
    const memory = await this.db.get(parsed.id);
    if (!memory) throw new RemembraError("NOT_FOUND", `No memory with id ${parsed.id}`);
    const entries = (await this.db.history?.(parsed.id)) ?? [];
    const kept = entries.slice(0, parsed.limit ?? entries.length);

    type VersionBase = { current?: true; file?: string; at?: string; snapshotAt?: string };
    const chain: { base: VersionBase; content: string }[] = [
      { base: { current: true, at: memory.updatedAt }, content: memory.content },
      ...kept.map((e) => ({
        base: { file: e.file, at: e.at, snapshotAt: e.snapshotAt },
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
        : `superseded ${v.snapshotAt?.slice(0, 19) ?? "?"} (was current: ${v.at?.slice(0, 19) ?? "?"})`;
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

  /** Readiness probe (audit Phase 7): can the backend actually be read? */
  async health(): Promise<{
    status: "ok" | "unready";
    version: string;
    uptime_s: number;
    storage: string;
    cache?: { size: number; capacity: number };
  }> {
    let storage = "ok";
    try {
      await this.db.all();
    } catch (err) {
      storage = errorLabel(err);
    }
    const cache = this.storageStats();
    return {
      status: storage === "ok" ? "ok" : "unready",
      version: VERSION,
      uptime_s: Math.round(process.uptime()),
      storage,
      ...(cache ? { cache } : {}),
    };
  }

  /** Parse-cache stats when the backend exposes them (file backend does). */
  storageStats(): { size: number; capacity: number } | null {
    return this.db.cacheStats?.() ?? null;
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
  }): Promise<DigestResult> {
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
  }): Promise<DigestResult> {
    let extracted: ExtractedMemory[];
    try {
      extracted = await this.extractFn(opts.transcript, { signal: opts.signal });
    } catch (err) {
      if (err instanceof RemembraError) throw err; // already classified (PROVIDER_TIMEOUT / LLM_ERROR)
      const msg = err instanceof Error ? err.message : String(err);
      throw new RemembraError("LLM_ERROR", `memory extraction failed: ${msg}`, { cause: err });
    }
    const active = await this.db.all();
    const archived = await this.db.all(true).then((all) => all.filter((m) => m.archivedAt));
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
        const revived = await this.db.revive(archivedDup.id);
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
        const revived = await this.db.revive(fuzzyArchived.id);
        if (revived) {
          seen.add(key);
          merged++;
          continue;
        }
      }

      // Evolved fact → LLM decides: store fresh, skip, or merge.
      const itemVec = (await this.maybeEmbed(item.content, opts.signal)) ?? null;
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
          const now = new Date().toISOString().slice(0, 10);
          const old = candidate.content.split("\n")[0];
          const cleanMerged = this.redactPair(decision.content, []) ?? {
            content: decision.content,
            tags: [] as string[],
          };
          const content = `${cleanMerged.content}\n\n> superseded (${now}): ${old}`;
          const embedding = await this.maybeEmbed(cleanMerged.content, opts.signal);
          await this.db.update({ ...candidate, content, embedding, source: opts.source ?? candidate.source });
          merged++;
          // Re-index dedup set against the new content.
          seen.delete(dedupKey(candidate.type, candidate.content, candidate.scope));
          seen.add(dedupKey(candidate.type, cleanMerged.content, candidate.scope));
          continue;
        }
        // action: "store" → fall through and store fresh
      }

      seen.add(key);
      const { memory } = await this.store(
        {
          type: item.type,
          content: item.content,
          scope,
          tags: item.tags,
          importance: item.importance,
          source: opts.source,
          confidence: item.confidence,
        },
        { provenance: "auto" },
      );
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
   * Explicit maintenance (decision v3-Q1): decay sweep + vector backfill.
   * Exposed as the `memory_maintain` tool, POST /maintain, and the CLI.
   */  async maintain(): Promise<MaintainResult> {
    const result = await this.decayPass();
    // Vector backfill: embed active memories stored while embeddings were off.
    if (this.embedFn) {
      const active = await this.db.all();
      for (const m of active) {
        if (m.embedding && m.embedding.length > 0) continue;
        const vec = await this.maybeEmbed(m.content);
        if (vec) {
          await this.db.update({ ...m, embedding: vec });
          result.embedded++;
        }
      }
    }
    return result;
  }

  /**
   * Full snapshot for backup (audit #8): every memory incl. archived.
   * Written by `remembra export <file>` as JSON.
   */
  async exportSnapshot() {
    const memories = await this.db.all(true);
    return {
      format: SNAPSHOT_FORMAT,
      version: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      memories,
    };
  }

  /**
   * Restore from a snapshot (audit #8). All-or-nothing validation: the whole
   * file is Zod-parsed before anything is written, so a corrupt/tampered
   * snapshot can never half-import. Existing ids and exact duplicates are
   * skipped, making re-import idempotent.
   */
  async importSnapshot(data: unknown): Promise<{ imported: number; skipped: number }> {
    let snap: ReturnType<typeof SnapshotInput.parse>;
    try {
      snap = SnapshotInput.parse(data); // throws before any write
    } catch (err) {
      throw inputError(err, "SNAPSHOT_INVALID");
    }
    const existing = await this.db.all(true);
    const ids = new Set(existing.map((m) => m.id));
    const keys = new Set(existing.map((m) => dedupKey(m.type, m.content, m.scope)));
    let imported = 0;
    let skipped = 0;
    for (const m of snap.memories) {
      const key = dedupKey(m.type, m.content, m.scope);
      if (ids.has(m.id) || keys.has(key)) {
        skipped++;
        continue;
      }
      if (await this.db.importMemory(m)) {
        imported++;
        ids.add(m.id);
        keys.add(key);
      } else {
        skipped++;
      }
    }
    return { imported, skipped };
  }

  /** Decay lifecycle: unused actives → archived → auto-deleted past TTL. */
  private async decayPass(): Promise<MaintainResult> {
    const now = Date.now();
    const archiveCutoff = now - this.archiveAfterDays * 86_400_000;
    const ttlCutoff = now - this.archiveTtlDays * 86_400_000;
    const result: MaintainResult = { archived: [], deleted: [], embedded: 0 };

    const active = await this.db.all();
    for (const m of active) {
      if (m.type === "role") continue; // standing instructions never decay
      const lastActive = Date.parse(m.lastSeen ?? m.updatedAt);
      if (Number.isFinite(lastActive) && lastActive < archiveCutoff) {
        await this.db.archive(m.id);
        result.archived.push(m.id);
      }
    }

    const archived = (await this.db.all(true)).filter((m) => m.archivedAt);
    for (const m of archived) {
      const archivedAt = Date.parse(m.archivedAt!);
      if (Number.isFinite(archivedAt) && archivedAt < ttlCutoff) {
        await this.db.forget(m.id);
        result.deleted.push(m.id);
      }
    }
    return result;
  }

  private maybeRunDecay(): void {
    if (this.decayRunning) return;
    if (Date.now() - this.lastDecayRun < this.decayIntervalMs) return;
    this.lastDecayRun = Date.now();
    this.decayRunning = true;
    this.decayPass()
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
      });
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
