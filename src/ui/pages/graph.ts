// Force-directed graph of related() edges — hand-rolled, canvas, no deps.
import { api, MemoryRec } from "../api.js";
import { h, mount } from "../dom.js";
import { emptyState } from "./list.js";

interface GNode {
  id: string;
  type: string;
  label: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
}

export async function renderGraph(view: HTMLElement): Promise<void | (() => void)> {
  const r = await api.list({ includeArchived: false, limit: 500 });

  if (r.memories.length === 0) {
    mount(
      view,
      h(
        "div",
        { class: "page-head" },
        h("h1", { text: "Graph" }),
      ),
      emptyState("No memories to graph", "Store memories and link them — edges come from related().", "i-graph"),
    );
    return;
  }

  const nodes: GNode[] = r.memories.map((m) => ({
    id: m.id,
    type: m.type,
    label: m.content.split("\n")[0].slice(0, 26),
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    r: 6 + Math.min(m.importance, 5),
  }));
  const index = new Map(nodes.map((n) => [n.id, n]));
  const edges: Array<[GNode, GNode]> = [];
  const seen = new Set<string>();
  for (const m of r.memories as MemoryRec[]) {
    for (const rid of m.related ?? []) {
      const a = index.get(m.id);
      const b = index.get(rid);
      if (!a || !b) continue;
      const key = `${m.id}>${rid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push([a, b]);
    }
  }

  const canvas = h("canvas") as HTMLCanvasElement;
  const ctx = canvas.getContext("2d");
  const count = h("span", { class: "muted small" });
  const legend = h(
    "div",
    { class: "graph-legend" },
    ...["fact", "decision", "role", "history"].map((label) =>
      h("span", {}, h("i", { class: `dot-${label}` }), label),
    ),
  );
  const wrap = h("div", { class: "graph-wrap" }, canvas, legend);
  count.textContent = `${nodes.length} memories · ${edges.length} links${r.total > nodes.length ? ` (first ${nodes.length} of ${r.total})` : ""}`;

  mount(
    view,
    h(
      "div",
      { class: "page-head" },
      h("h1", { text: "Graph" }),
      h("span", { class: "spacer" }),
      count,
      h("span", { class: "muted small", text: "drag · click to open" }),
    ),
    wrap,
  );

  if (!ctx) return;

  // Seed near center with a deterministic-ish spread.
  const seed = (n: GNode, i: number): void => {
    const angle = (i / nodes.length) * Math.PI * 2;
    const radius = 120 + (i % 7) * 26;
    n.x = Math.cos(angle) * radius;
    n.y = Math.sin(angle) * radius;
  };
  nodes.forEach(seed);

  const cssVar = (name: string): string =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  let alpha = 1;
  let hover: GNode | null = null;
  let drag: GNode | null = null;
  let dragMoved = false;
  let raf = 0;
  let cancelled = false;
  let w = 0;
  let hgt = 0;

  const fit = (): void => {
    const rect = canvas.getBoundingClientRect();
    w = rect.width;
    hgt = rect.height;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(hgt * dpr);
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  const step = (): void => {
    // Repulsion (O(n²) — capped at 500 nodes, fine for canvas budgets).
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) {
          dx = (Math.random() - 0.5) * 2;
          dy = (Math.random() - 0.5) * 2;
          d2 = 4;
        }
        const f = Math.min(4, 4200 / d2) * alpha;
        const d = Math.sqrt(d2);
        const ux = (dx / d) * f;
        const uy = (dy / d) * f;
        a.vx -= ux;
        a.vy -= uy;
        b.vx += ux;
        b.vy += uy;
      }
    }
    // Springs.
    const REST = 110;
    for (const [a, b] of edges) {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.max(1, Math.hypot(dx, dy));
      const f = (d - REST) * 0.015 * alpha;
      const ux = (dx / d) * f;
      const uy = (dy / d) * f;
      a.vx += ux;
      a.vy += uy;
      b.vx -= ux;
      b.vy -= uy;
    }
    // Center gravity + integrate.
    for (const n of nodes) {
      n.vx += -n.x * 0.012 * alpha;
      n.vy += -n.y * 0.016 * alpha;
      if (n === drag) {
        n.vx = 0;
        n.vy = 0;
        continue;
      }
      n.vx *= 0.86;
      n.vy *= 0.86;
      n.x += n.vx;
      n.y += n.vy;
    }
    alpha = Math.max(0.02, alpha * 0.992);
  };

  const draw = (): void => {
    if (!ctx) return;
    if (canvas.clientWidth !== w || canvas.clientHeight !== hgt) fit();
    ctx.clearRect(0, 0, w, hgt);
    const cx = w / 2;
    const cy = hgt / 2;

    // Palette once per frame (theme-aware; switch flips vars).
    const palette = {
      fact: cssVar("--info") || "#5b9dd9",
      decision: cssVar("--violet") || "#a371f7",
      role: cssVar("--gold") || "#d4af37",
      history: cssVar("--text-3") || "#78756c",
      edge: cssVar("--border-2") || "#333",
      goldHi: cssVar("--gold-hi") || "#f7d976",
      text2: cssVar("--text-2") || "#999",
    };

    // Edges.
    ctx.strokeStyle = palette.edge;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.7;
    for (const [a, b] of edges) {
      ctx.beginPath();
      ctx.moveTo(cx + a.x, cy + a.y);
      ctx.lineTo(cx + b.x, cy + b.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Nodes.
    const showAllLabels = nodes.length <= 60;
    for (const n of nodes) {
      const x = cx + n.x;
      const y = cy + n.y;
      const color = palette[n.type as keyof typeof palette] ?? palette.text2;
      const active = n === hover || n === drag;
      ctx.beginPath();
      ctx.arc(x, y, n.r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.globalAlpha = active ? 1 : 0.92;
      ctx.fill();
      if (active || n.type === "role") {
        ctx.strokeStyle = palette.goldHi;
        ctx.lineWidth = active ? 2.5 : 1.5;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      if (showAllLabels || active) {
        ctx.font = "11px -apple-system, system-ui, sans-serif";
        ctx.fillStyle = palette.text2;
        ctx.textAlign = "center";
        ctx.fillText(n.label, x, y + n.r + 13);
      }
    }
  };

  const frame = (): void => {
    if (cancelled) return;
    step();
    draw();
    raf = requestAnimationFrame(frame);
  };

  const nodeAt = (px: number, py: number): GNode | null => {
    const cx = w / 2;
    const cy = hgt / 2;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if (Math.hypot(cx + n.x - px, cy + n.y - py) <= n.r + 4) return n;
    }
    return null;
  };
  const local = (ev: MouseEvent): { x: number; y: number } => {
    const rect = canvas.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  };

  canvas.addEventListener("mousemove", (ev) => {
    const p = local(ev);
    if (drag) {
      const cx = w / 2;
      const cy = hgt / 2;
      drag.x = p.x - cx;
      drag.y = p.y - cy;
      dragMoved = true;
      alpha = Math.max(alpha, 0.35);
    } else {
      hover = nodeAt(p.x, p.y);
      canvas.style.cursor = hover ? "pointer" : "grab";
    }
  });
  canvas.addEventListener("mousedown", (ev) => {
    const p = local(ev);
    const n = nodeAt(p.x, p.y);
    if (n) {
      drag = n;
      dragMoved = false;
      canvas.classList.add("dragging");
    }
  });
  const endDrag = (): void => {
    if (drag && !dragMoved) location.hash = `#/memories/${drag.id}`;
    drag = null;
    canvas.classList.remove("dragging");
    alpha = Math.max(alpha, 0.4);
  };
  canvas.addEventListener("mouseup", endDrag);
  canvas.addEventListener("mouseleave", () => {
    hover = null;
    if (drag) {
      drag = null;
      canvas.classList.remove("dragging");
    }
  });

  fit();
  raf = requestAnimationFrame(frame);
  return () => {
    cancelled = true;
    cancelAnimationFrame(raf);
  };
}
