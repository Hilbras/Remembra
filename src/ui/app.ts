// Remembra UI entry — hash router, theme, key gate, shell wiring.
import { api, ApiError } from "./api.js";
import { clear, h, mount, toast } from "./dom.js";
import { renderList } from "./pages/list.js";
import { renderDetail } from "./pages/detail.js";
import { renderEdit } from "./pages/edit.js";
import { renderRoles } from "./pages/roles.js";
import { renderDigest } from "./pages/digest.js";
import { renderOps } from "./pages/ops.js";
import { renderGraph } from "./pages/graph.js";

type RouteRun = (m: RegExpMatchArray, view: HTMLElement) => Promise<void | (() => void)>;

interface Route {
  re: RegExp;
  nav: string;
  title: string;
  run: RouteRun;
}

// Order matters: /memories/:id before the bare list.
const routes: Route[] = [
  { re: /^\/memories\/(.+)$/, nav: "memories", title: "Memory", run: (m, v) => renderDetail(v, decodeURIComponent(m[1])) },
  { re: /^\/memories$/, nav: "memories", title: "Memories", run: (_m, v) => renderList(v) },
  { re: /^\/new$/, nav: "memories", title: "New memory", run: (_m, v) => renderEdit(v, null) },
  { re: /^\/edit\/(.+)$/, nav: "memories", title: "Edit memory", run: (m, v) => renderEdit(v, decodeURIComponent(m[1])) },
  { re: /^\/roles$/, nav: "roles", title: "Roles", run: (_m, v) => renderRoles(v) },
  { re: /^\/graph$/, nav: "graph", title: "Graph", run: (_m, v) => renderGraph(v) },
  { re: /^\/digest$/, nav: "digest", title: "Digest", run: (_m, v) => renderDigest(v) },
  { re: /^\/ops$/, nav: "ops", title: "Ops", run: (_m, v) => renderOps(v) },
];

let cleanup: (() => void) | undefined;

async function navigate(retry = false): Promise<void> {
  const pathOnly = (location.hash.slice(1) || "/memories").split("?")[0];
  const route = routes.find((r) => r.re.test(pathOnly)) ?? routes[0];
  const m = pathOnly.match(route.re) as RegExpMatchArray;
  const view = document.getElementById("view");
  if (!view) return;

  cleanup?.();
  cleanup = undefined;
  for (const a of document.querySelectorAll<HTMLAnchorElement>("#nav a")) {
    a.classList.toggle("active", a.getAttribute("data-nav") === route.nav);
  }
  const title = document.getElementById("page-title");
  if (title) title.textContent = route.title;
  document.getElementById("sidebar")?.classList.remove("open");
  clear(view);

  try {
    const out = await route.run(m, view);
    cleanup = typeof out === "function" ? out : undefined;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401 && !retry) {
      const ok = await promptKey();
      if (ok) return navigate(true);
    }
    renderError(view, err);
  }
}

function renderError(view: HTMLElement, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  const status = err instanceof ApiError ? err.status : -1;
  mount(
    view,
    h(
      "div",
      { class: "card error-card" },
      h("div", { class: "card-title", text: "Something went wrong" }),
      h("p", { class: "content-block", text: msg }),
      h("p", {
        class: "muted small",
        text:
          status === 401
            ? "Set the API key with the 🔑 button in the header."
            : status === 0
              ? "Is the server reachable? Start it with: remembra --http"
              : status === 404
                ? "Not found — it may have been deleted or archived."
                : "",
      }),
    ),
  );
}

/** Modal API-key prompt. Resolves true when a key was saved. */
function promptKey(): Promise<boolean> {
  return new Promise((resolve) => {
    const root = document.getElementById("modal-root");
    if (!root) return resolve(false);
    const existing = api.getKey();
    const input = h("input", {
      type: "password",
      placeholder: "API key",
      value: existing ?? "",
      autocomplete: "off",
    });
    const done = (saved: boolean) => {
      overlay.remove();
      updateKeyBtn();
      resolve(saved);
    };
    const save = () => {
      const v = input.value.trim();
      if (v) api.setKey(v);
      else api.clearKey();
      done(Boolean(v));
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
        h("h3", { text: "API key" }),
        h("p", { text: "This server requires it for data requests. Kept in this tab only." }),
        input,
        h(
          "div",
          { class: "btn-row" },
          existing
            ? h(
                "button",
                {
                  class: "btn btn-ghost",
                  onclick: () => {
                    api.clearKey();
                    done(false);
                  },
                },
                "Clear",
              )
            : null,
          h("button", { class: "btn btn-ghost", onclick: () => done(false) }, "Cancel"),
          h("button", { class: "btn btn-primary", onclick: save }, "Save"),
        ),
      ),
    );
    root.appendChild(overlay);
    input.addEventListener("keydown", (ev: Event) => {
      const e = ev as KeyboardEvent;
      if (e.key === "Enter") save();
      if (e.key === "Escape") done(false);
    });
    input.focus();
  });
}

function updateKeyBtn(): void {
  const btn = document.getElementById("key-btn");
  if (btn) btn.title = api.getKey() ? "API key (set for this tab)" : "API key";
}

function initTheme(): void {
  try {
    const saved = localStorage.getItem("remembra.theme");
    if (saved === "light" || saved === "dark") {
      document.documentElement.setAttribute("data-theme", saved);
    }
  } catch {
    /* storage unavailable — keep dark default */
  }
}

function toggleTheme(): void {
  const next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", next);
  try {
    localStorage.setItem("remembra.theme", next);
  } catch {
    /* ignore */
  }
}

/** Sidebar footer: poll the unauthenticated /health every 15s. */
async function pollHealth(): Promise<void> {
  const foot = document.getElementById("server-state");
  if (!foot) return;
  const dot = foot.querySelector(".dot");
  const label = foot.querySelector(".muted");
  try {
    const hrec = (await api.health()) as { status?: string; version?: string };
    const ok = hrec.status === "ok";
    dot?.setAttribute("class", `dot ${ok ? "ok" : "bad"}`);
    if (label) label.textContent = ok ? `v${hrec.version ?? "?"}` : "degraded";
  } catch {
    dot?.setAttribute("class", "dot bad");
    if (label) label.textContent = "offline";
  }
}

// --- boot ---
initTheme();
updateKeyBtn();

document.getElementById("theme-btn")?.addEventListener("click", toggleTheme);
document.getElementById("nav-toggle")?.addEventListener("click", () => {
  document.getElementById("sidebar")?.classList.toggle("open");
});
document.getElementById("key-btn")?.addEventListener("click", () => {
  void promptKey().then((saved) => {
    if (saved) {
      toast("API key saved", "ok");
      void navigate(true);
    }
  });
});

window.addEventListener("hashchange", () => void navigate());
void navigate();
void pollHealth();
setInterval(() => void pollHealth(), 15_000);
