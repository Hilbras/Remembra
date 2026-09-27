/**
 * Zero-dependency metrics registry (audit Phase 7) — Prometheus text
 * exposition format 0.0.4, rendered by the authenticated `GET /metrics`
 * route. Alert rules over these series live in docs/observability.md.
 */
import { VERSION } from "./version.js";

type Labels = Record<string, string | number>;
type LabelMap = Map<string, Map<string, number>>; // name → labelKey → value

const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

interface HistData {
  counts: number[]; // cumulative per bucket (le)
  sum: number;
  count: number;
}

interface Meta {
  type: "counter" | "histogram" | "gauge";
  help: string;
  buckets?: number[];
}

function labelKey(labels?: Labels): string {
  if (!labels) return "";
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return "";
  return `{${keys.map((k) => `${k}="${String(labels[k]).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}`;
}

export class MetricsRegistry {
  private meta = new Map<string, Meta>();
  private counters: LabelMap = new Map();
  private hists = new Map<string, Map<string, HistData>>();
  private gauges = new Map<string, { help: string; collect: () => { labels?: Labels; value: number }[] }>();

  counter(name: string, help: string): void {
    if (!this.meta.has(name)) this.meta.set(name, { type: "counter", help });
  }
  histogram(name: string, help: string, buckets: number[] = DEFAULT_BUCKETS): void {
    if (!this.meta.has(name)) this.meta.set(name, { type: "histogram", help, buckets: [...buckets] });
  }

  gauge(name: string, help: string, collect: () => { labels?: Labels; value: number }[]): void {
    this.meta.set(name, { type: "gauge", help });
    this.gauges.set(name, { help, collect });
  }

  inc(name: string, labels?: Labels, by = 1): void {
    this.counter(name, name.replace(/_/g, " "));
    const series = this.counters.get(name) ?? new Map<string, number>();
    const k = labelKey(labels);
    series.set(k, (series.get(k) ?? 0) + by);
    this.counters.set(name, series);
  }

  observe(name: string, value: number, labels?: Labels): void {
    const m = this.meta.get(name);
    if (!m) this.histogram(name, name.replace(/_/g, " "));
    const buckets = this.meta.get(name)!.buckets ?? DEFAULT_BUCKETS;
    const series = this.hists.get(name) ?? new Map<string, HistData>();
    const k = labelKey(labels);
    let d = series.get(k);
    if (!d) {
      d = { counts: new Array(buckets.length).fill(0), sum: 0, count: 0 };
      series.set(k, d);
    }
    for (let i = 0; i < buckets.length; i++) if (value <= buckets[i]) d.counts[i]++;
    d.sum += value;
    d.count++;
    this.hists.set(name, series);
  }

  /** Current counter value (tests + ad-hoc inspection). */
  get(name: string, labels?: Labels): number | undefined {
    return this.counters.get(name)?.get(labelKey(labels));
  }

  /**
   * Estimated quantile of a recorded histogram, interpolated inside the bucket
   * the quantile falls in. Returns 0 for a series with no observations, so a
   * dashboard shows "no data" rather than a fabricated latency.
   *
   * The estimate is bucket-resolution, which is the same approximation
   * `histogram_quantile` makes server-side; the buckets are fixed at
   * construction so the resolution is known rather than accidental.
   */
  quantile(name: string, q: number, labels?: Labels): number {
    if (!Number.isFinite(q) || q < 0 || q > 1) return 0;
    const d = this.hists.get(name)?.get(labelKey(labels));
    if (!d || d.count === 0) return 0;
    const buckets = this.meta.get(name)?.buckets ?? DEFAULT_BUCKETS;
    const rank = q * d.count;
    for (let i = 0; i < buckets.length; i++) {
      const cumulative = d.counts[i]!;
      if (cumulative < rank) continue;
      const lower = i === 0 ? 0 : buckets[i - 1]!;
      const upper = buckets[i]!;
      const below = i === 0 ? 0 : d.counts[i - 1]!;
      const inBucket = cumulative - below;
      if (inBucket <= 0) return upper;
      return lower + ((rank - below) / inBucket) * (upper - lower);
    }
    // Above the last finite bucket: everything is at or beyond its upper edge.
    return buckets[buckets.length - 1] ?? 0;
  }

  /**
   * p50/p95/p99 of a histogram in one call, for the exposition and for
   * dashboards that need the triple together.
   */
  summary(name: string, labels?: Labels): { p50: number; p95: number; p99: number; count: number; sum: number } {
    const d = this.hists.get(name)?.get(labelKey(labels));
    return {
      p50: this.quantile(name, 0.5, labels),
      p95: this.quantile(name, 0.95, labels),
      p99: this.quantile(name, 0.99, labels),
      count: d?.count ?? 0,
      sum: d?.sum ?? 0,
    };
  }

  /** Names of every registered series, for a self-describing exposition. */
  names(): string[] {
    return [...this.meta.keys()].sort();
  }

  /** Observed label-key count per series — the cardinality guard for tests. */
  seriesCount(name: string): number {
    return Math.max(this.counters.get(name)?.size ?? 0, this.hists.get(name)?.size ?? 0);
  }

  reset(): void {
    this.counters.clear();
    this.hists.clear();
    // meta/gauges are structural — keep them registered.
  }

  render(): string {
    const out: string[] = [];
    for (const [name, m] of this.meta) {
      out.push(`# HELP ${name} ${m.help}`, `# TYPE ${name} ${m.type}`);
      if (m.type === "counter") {
        for (const [k, v] of this.counters.get(name) ?? []) out.push(`${name}${k} ${v}`);
      } else if (m.type === "histogram") {
        const buckets = m.buckets ?? DEFAULT_BUCKETS;
        for (const [k, d] of this.hists.get(name) ?? []) {
          for (let i = 0; i < buckets.length; i++) {
            out.push(`${name}_bucket${withLe(k, buckets[i])} ${d.counts[i]}`);
          }
          out.push(`${name}_bucket${withLe(k, "+Inf")} ${d.count}`);
          out.push(`${name}_sum${k} ${d.sum}`);
          out.push(`${name}_count${k} ${d.count}`);
        }
      } else {
        for (const { labels, value } of this.gauges.get(name)?.collect() ?? []) {
          out.push(`${name}${labelKey(labels)} ${value}`);
        }
      }
    }
    return out.join("\n") + "\n";
  }
}

/** Histogram bucket labels must merge with the series' own labels. */
function withLe(key: string, le: number | string): string {
  const leLabel = `le="${le}"`;
  if (key === "") return `{${leLabel}}`;
  return `{${leLabel},${key.slice(1)}`; // key is `{a="b"}` → le first, comma, rest
}

/** Process-wide registry — instrumented by store/service/http/errors. */
export const metrics = new MetricsRegistry();

// --- pre-declared series (stable names for dashboards and alert rules) ---
metrics.counter("remembra_http_requests_total", "HTTP requests by route, method and status");
metrics.histogram("remembra_http_request_duration_seconds", "HTTP request duration by route");
metrics.counter("remembra_errors_total", "Classified errors by code and transport (http|mcp)");
metrics.counter("remembra_searches_total", "memory_search invocations");
metrics.histogram("remembra_search_duration_seconds", "memory_search latency (seconds)");
metrics.counter("remembra_jobs_total", "Background jobs by type and outcome");
metrics.counter("remembra_job_failures_total", "Background jobs that exhausted retries");
metrics.counter("remembra_embedding_batch_items_total", "Embedding batch items by result");
metrics.counter("remembra_embedding_batch_failures_total", "Embedding batch items that failed");
metrics.counter("remembra_batch_items_total", "Batch items by operation and result");
metrics.counter("remembra_webhook_events_total", "Webhook events by result (published|rejected|error)");
metrics.counter("remembra_webhook_deliveries_total", "Webhook delivery attempts by result (queued|delivered|failed|dropped_capacity|dropped_payload)");
metrics.counter("remembra_stores_total", "memory_store invocations");
metrics.counter("remembra_digests_total", "session digest runs");
metrics.counter("remembra_digest_items_total", "Digest items by outcome (stored|skipped|merged)");
metrics.histogram("remembra_digest_duration_seconds", "Session digest run latency (seconds)");
metrics.counter("remembra_cache_events_total", "Parse-cache probes by result (hit|miss)");
metrics.counter("remembra_redactions_total", "PII placeholders written at ingest by kind (3.8.0)");
metrics.counter("remembra_relate_total", "memory_relate link writes by action (3.8.0)");
metrics.counter("remembra_history_snapshots_total", "History pre-images written (3.8.0)");
metrics.counter("remembra_encryption_migrations_total", "Encryption migration files converted by mode (3.8.0)");
metrics.gauge("remembra_info", "Build info", () => [{ labels: { version: VERSION }, value: 1 }]);

// --- V4.6.0: Observability & Evaluation ---
metrics.counter("remembra_provider_failures_total", "Provider failures by provider and error code");
metrics.histogram("remembra_embedding_latency_seconds", "Embedding call latency (seconds)");
metrics.histogram("remembra_llm_latency_seconds", "LLM call latency by operation (seconds)");
metrics.histogram("remembra_storage_latency_seconds", "Store/update/forget latency (seconds)");
// ---------------------------------------------------------------------------
// Series that V4.6.0 declared but that nothing ever recorded were removed in
// V5.1.0 rather than left in place. A declared series with no data point is
// worse than an absent one: a dashboard built on it renders empty and the
// absence looks like data loss rather than "not implemented".
//
//   remembra_memory_count_{active,archived,deleted}  — need a full backend scan
//   remembra_duplicate_rate / conflict_rate /
//   stale_memory_rate                                 — need a full scan plus a
//                                                      quality computation
//   remembra_estimated_cost_usd                        — depends on token usage
//   remembra_token_usage_total                         — the adapter contract
//                                                      returns a string and
//                                                      reports no usage, so any
//                                                      number would be invented
//
// If these are wanted, they should be computed on a bounded schedule and
// registered with a real `collect`, not declared and left empty. See
// docs/v5.1.0-audit.md finding M4.
// --- V5.1.0: the series roadmap §21 names, added where they were missing ---
metrics.counter("remembra_rate_limit_hits_total", "Rate-limit rejections by dimension and transport");
metrics.counter("remembra_memory_reads_total", "memory_read invocations by operation");
metrics.counter("remembra_provider_requests_total", "Provider calls by provider and direction (embed|llm)");
metrics.counter("remembra_provider_errors_total", "Provider errors by provider and error code");
metrics.counter("remembra_snapshot_operations_total", "Snapshot operations by operation and result");
metrics.counter("remembra_recovery_operations_total", "Recovery operations by operation and result");
metrics.counter("remembra_shutdown_total", "Process shutdowns by result (clean|forced)");
metrics.counter("remembra_shutdown_phases_total", "Graceful shutdown phases by phase and status");
