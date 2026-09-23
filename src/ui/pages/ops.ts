// Ops dashboard — health, metric sparklines, maintain, export/import.
import { api } from "../api.js";
import { h, icon, mount, toast } from "../dom.js";

// ---------- Prometheus text parsing (client-side) ----------

function counterSum(text: string, name: string, labelMatch?: string): number {
  let total = 0;
  const re = new RegExp(`^${name}(?:\\{([^}]*)\\})? ([\\d.e+-]+)$`, "gm");
  for (const m of text.matchAll(re)) {
    if (labelMatch && !(m[1] ?? "").includes(labelMatch)) continue;
    total += Number(m[2]);
  }
  return total;
}

/** p95 as a bucket boundary in seconds (null when no samples). */
function p95Seconds(text: string): number | null {
  const buckets = new Map<number, number>();
  let count = 0;
  const re = /^remembra_http_request_duration_seconds_bucket\{([^}]*)\} ([\d.e+-]+)$/gm;
  for (const m of text.matchAll(re)) {
    const le = /le="([^"]+)"/.exec(m[1] ?? "")?.[1];
    if (!le) continue;
    if (le === "+Inf") {
      count += Number(m[2]);
      continue;
    }
    const v = Number(le);
    buckets.set(v, (buckets.get(v) ?? 0) + Number(m[2]));
  }
  if (count === 0) return null;
  const target = count * 0.95;
  let cum = 0;
  for (const le of [...buckets.keys()].sort((a, b) => a - b)) {
    cum += buckets.get(le) ?? 0;
    if (cum >= target) return le;
  }
  return null;
}

function fmtMs(sec: number | null): string {
  if (sec === null) return "—";
  const ms = sec * 1000;
  return ms < 1 ? `${(ms * 1000).toFixed(0)}µs` : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function fmtUptime(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

// ---------- sparkline ----------

function drawSpark(canvas: HTMLCanvasElement, values: number[], colorVar: string): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const hgt = canvas.clientHeight;
  if (w === 0 || hgt === 0) return;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(hgt * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, hgt);
  if (values.length < 2) return;

  const color =
    getComputedStyle(document.documentElement).getPropertyValue(colorVar).trim() || "#d4af37";
  let max = Math.max(...values);
  let min = Math.min(...values);
  if (max === min) {
    max += 1;
    min -= 1;
  }
  const pad = 3;
  const px = (i: number): number => (i / (values.length - 1)) * (w - 2) + 1;
  const py = (v: number): number => hgt - pad - ((v - min) / (max - min)) * (hgt - pad * 2);

  ctx.beginPath();
  values.forEach((v, i) => (i === 0 ? ctx.moveTo(px(i), py(v)) : ctx.lineTo(px(i), py(v))));
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = "round";
  ctx.stroke();

  ctx.lineTo(px(values.length - 1), hgt);
  ctx.lineTo(px(0), hgt);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.12;
  ctx.fill();
  ctx.globalAlpha = 1;
}

// ---------- page ----------

interface Stat {
  key: string;
  label: string;
  gold?: boolean;
  sparkVar?: string;
}

const STATS: Stat[] = [
  { key: "requests", label: "Requests", sparkVar: "--gold" },
  { key: "errors", label: "Errors", sparkVar: "--danger" },
  { key: "p95", label: "p95 latency", gold: true, sparkVar: "--gold" },
  { key: "searches", label: "Searches" },
  { key: "stores", label: "Stores" },
  { key: "cache", label: "Cache hit" },
];

export async function renderOps(view: HTMLElement): Promise<void | (() => void)> {
  const history: Record<string, number[]> = { requests: [], errors: [], p95: [] };
  const valueEls = new Map<string, HTMLElement>();
  const canvases = new Map<string, HTMLCanvasElement>();

  const statCards = STATS.map((s) => {
    const value = h("span", { class: `value${s.gold ? " gold" : ""}`, text: "—" });
    valueEls.set(s.key, value);
    const canvas = h("canvas") as HTMLCanvasElement;
    if (s.sparkVar) canvases.set(s.key, canvas);
    return h(
      "div",
      { class: "stat" },
      h("div", { class: "label", text: s.label }),
      value,
      s.sparkVar ? canvas : null,
    );
  });

  const healthBody = h("div", { class: "kv-inline" });
  const maintainBody = h("div");

  const fileInput = h("input", {
    id: "import-file",
    class: "hidden-input",
    type: "file",
    accept: ".json,application/json",
  }) as HTMLInputElement;
  fileInput.addEventListener("change", () => {
    void (async () => {
      const f = fileInput.files?.[0];
      if (!f) return;
      try {
        const data = JSON.parse(await f.text());
        const r = await api.importSnapshot(data);
        toast(`Imported ${r.imported}, skipped ${r.skipped}`, "ok");
        void refreshAll();
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), "err");
      } finally {
        fileInput.value = "";
      }
    })();
  });

  const maintainBtn = h(
    "button",
    {
      class: "btn btn-primary",
      onclick: async () => {
        maintainBtn.disabled = true;
        try {
          const r = await api.maintain();
          toast(
            `Archived ${r.archived.length} · deleted ${r.deleted.length} · embedded ${r.embedded}`,
            "ok",
          );
          mount(
            maintainBody,
            h(
              "div",
              { class: "kv-inline" },
              h("span", {}, "Archived: ", h("b", { text: String(r.archived.length) })),
              h("span", {}, "Deleted: ", h("b", { text: String(r.deleted.length) })),
              h("span", {}, "Embedded: ", h("b", { text: String(r.embedded) })),
            ),
            r.archived.length + r.deleted.length > 0
              ? h(
                  "div",
                  { class: "chip-row" },
                  ...[...r.archived, ...r.deleted].slice(0, 20).map((id) =>
                    h("a", { class: "chip", href: `#/memories/${id}`, text: id }),
                  ),
                )
              : null,
          );
          void refreshHealth();
        } catch (err) {
          toast(err instanceof Error ? err.message : String(err), "err");
        } finally {
          maintainBtn.disabled = false;
        }
      },
    },
    icon("i-play"),
    "Run maintain",
  );

  const exportBtn = h(
    "button",
    {
      class: "btn",
      onclick: async () => {
        try {
          const snap = await api.snapshot();
          const blob = new Blob([JSON.stringify(snap, null, 2)], { type: "application/json" });
          const url = URL.createObjectURL(blob);
          const a = h("a", {
            href: url,
            download: `remembra-${new Date().toISOString().slice(0, 10)}.json`,
          });
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 5000);
          toast(`Exported ${snap.memories.length} memories`, "ok");
        } catch (err) {
          toast(err instanceof Error ? err.message : String(err), "err");
        }
      },
    },
    icon("i-download"),
    "Export",
  );

  mount(
    view,
    h(
      "div",
      { class: "page-head" },
      h("h1", { text: "Ops" }),
      h("span", { class: "spacer" }),
      h("span", { class: "muted small", text: "auto-refresh every 5s" }),
    ),
    h("div", { class: "stat-grid" }, ...statCards),
    h(
      "div",
      { class: "card" },
      h("div", { class: "card-title", text: "Health" }),
      healthBody,
    ),
    h(
      "div",
      { class: "card" },
      h("div", { class: "card-title", text: "Maintenance" }),
      h("div", { class: "btn-row" }, maintainBtn, exportBtn, h("label", { class: "btn", for: "import-file" }, icon("i-upload"), "Import"), fileInput),
      h("p", {
        class: "muted small",
        text: "Maintain runs the decay sweep (archive at 90d, delete at 365d) and backfills embeddings.",
      }),
      maintainBody,
    ),
  );

  async function refreshHealth(): Promise<void> {
    try {
      const hh = await api.health();
      mount(
        healthBody,
        h("span", {}, "Status: ", h("b", { text: hh.status })),
        h("span", {}, "Version: ", h("b", { text: hh.version })),
        h("span", {}, "Uptime: ", h("b", { text: fmtUptime(hh.uptime_s) })),
        h("span", {}, "Storage: ", h("b", { text: hh.storage })),
        h(
          "span",
          {},
          "Cache: ",
          h("b", { text: hh.cache ? `${hh.cache.size}/${hh.cache.capacity}` : "—" }),
        ),
      );
    } catch (err) {
      mount(healthBody, h("span", {}, "Status: ", h("b", { text: "unreachable" })),
        h("span", { class: "dim small", text: err instanceof Error ? err.message : String(err) }));
    }
  }

  async function refreshMetrics(): Promise<void> {
    try {
      const text = await api.metricsText();
      const requests = counterSum(text, "remembra_http_requests_total");
      const errors = counterSum(text, "remembra_errors_total");
      const p95 = p95Seconds(text);
      const hit = counterSum(text, "remembra_cache_events_total", 'result="hit"');
      const miss = counterSum(text, "remembra_cache_events_total", 'result="miss"');
      const searches = counterSum(text, "remembra_searches_total");
      const stores = counterSum(text, "remembra_stores_total");

      valueEls.get("requests")!.textContent = requests.toLocaleString();
      valueEls.get("errors")!.textContent = errors.toLocaleString();
      valueEls.get("p95")!.textContent = p95 === null ? "—" : fmtMs(p95);
      valueEls.get("searches")!.textContent = searches.toLocaleString();
      valueEls.get("stores")!.textContent = stores.toLocaleString();
      valueEls.get("cache")!.textContent =
        hit + miss === 0 ? "—" : `${Math.round((hit / (hit + miss)) * 100)}%`;

      const push = (arr: number[], v: number): void => {
        arr.push(v);
        if (arr.length > 60) arr.shift();
      };
      push(history.requests, requests);
      push(history.errors, errors);
      push(history.p95, p95 ?? 0);
      const c1 = canvases.get("requests");
      const c2 = canvases.get("errors");
      const c3 = canvases.get("p95");
      if (c1) drawSpark(c1, history.requests, "--gold");
      if (c2) drawSpark(c2, history.errors, "--danger");
      if (c3) drawSpark(c3, history.p95, "--gold");
    } catch {
      // metrics endpoint unreachable (unkeyed server, old build) — keep last values
    }
  }

  async function refreshAll(): Promise<void> {
    await Promise.all([refreshHealth(), refreshMetrics()]);
  }

  await refreshAll();
  const timer = window.setInterval(() => void refreshAll(), 5000);
  return () => window.clearInterval(timer);
}
