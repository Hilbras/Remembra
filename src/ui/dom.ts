// Tiny DOM helpers — no framework, no innerHTML for user data (XSS: memory
// content is untrusted-ish → always textContent).

export type Kid = Node | string | number | null | undefined | false | Kid[];

const SVG_NS = "http://www.w3.org/2000/svg";

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | boolean | ((ev: Event) => void) | undefined> = {},
  ...kids: Kid[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  applyAttrs(el, attrs);
  append(el, kids);
  return el;
}

export function icon(name: string, cls = "ico"): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", cls);
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `#${name}`);
  svg.appendChild(use);
  return svg;
}

function applyAttrs(
  el: HTMLElement,
  attrs: Record<string, string | number | boolean | ((ev: Event) => void) | undefined>,
): void {
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") {
      el.addEventListener(k.slice(2), v as (ev: Event) => void);
    } else if (k === "class") {
      el.className = String(v);
    } else if (k === "text") {
      el.textContent = String(v);
    } else if (v === true) {
      el.setAttribute(k, "");
    } else {
      el.setAttribute(k, String(v));
    }
  }
}

function append(parent: Node, kids: Kid[]): void {
  for (const kid of kids) {
    if (kid === null || kid === undefined || kid === false) continue;
    if (Array.isArray(kid)) append(parent, kid);
    else if (kid instanceof Node) parent.appendChild(kid);
    else parent.appendChild(document.createTextNode(String(kid)));
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** Render kids into a container (clearing it first). */
export function mount(container: Element, ...kids: Kid[]): void {
  clear(container);
  append(container, kids);
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function fmtAgo(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const d = Date.now() - t;
  if (d < MIN) return "just now";
  if (d < HOUR) return `${Math.floor(d / MIN)}m ago`;
  if (d < DAY) return `${Math.floor(d / HOUR)}h ago`;
  if (d < 30 * DAY) return `${Math.floor(d / DAY)}d ago`;
  return new Date(t).toLocaleDateString();
}

export function fmtDate(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  return new Date(t).toLocaleString();
}

export function toast(msg: string, kind: "ok" | "err" | "" = ""): void {
  const root = document.getElementById("toasts");
  if (!root) return;
  const el = h("div", { class: `toast ${kind}` }, msg);
  root.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 250);
  }, 3600);
}

/** Promise-based confirm dialog. Resolves true on confirm. */
export function confirmModal(title: string, message: string, confirmLabel = "Confirm"): Promise<boolean> {
  return new Promise((resolve) => {
    const root = document.getElementById("modal-root");
    if (!root) return resolve(false);
    const done = (ok: boolean) => {
      overlay.remove();
      resolve(ok);
    };
    const overlay = h(
      "div",
      {
        class: "modal-overlay",
        onclick: (ev: Event) => {
          if (ev.target === overlay) done(false);
        },
      },
      h(
        "div",
        { class: "modal", role: "dialog", "aria-modal": "true" },
        h("h3", { text: title }),
        h("p", { text: message }),
        h(
          "div",
          { class: "btn-row" },
          h("button", { class: "btn btn-ghost", onclick: () => done(false) }, "Cancel"),
          h("button", { class: "btn btn-danger", onclick: () => done(true) }, confirmLabel),
        ),
      ),
    );
    root.appendChild(overlay);
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        document.removeEventListener("keydown", onKey);
        done(false);
      }
    };
    document.addEventListener("keydown", onKey);
  });
}

export const TYPE_COLORS: Record<string, string> = {
  fact: "var(--info)",
  decision: "var(--violet)",
  role: "var(--gold)",
  history: "var(--text-3)",
};

export function typeBadge(type: string): HTMLElement {
  return h("span", { class: `badge t-${type}`, text: type });
}

export function stars(n: number): string {
  const clamped = Math.max(0, Math.min(5, Math.round(n)));
  return "★".repeat(clamped) + "☆".repeat(5 - clamped);
}
