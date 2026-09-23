// Memories list — search, filters, pagination, rows.
import { api, MemoryRec } from "../api.js";
import { clear, fmtAgo, h, icon, mount, typeBadge } from "../dom.js";

/** Shared memory row (also used by the roles page). */
export function mrow(m: MemoryRec): HTMLElement {
  return h(
    "button",
    {
      class: "mrow",
      onclick: () => {
        location.hash = `#/memories/${m.id}`;
      },
    },
    typeBadge(m.type),
    h("span", { class: "content", text: m.content.split("\n")[0] }),
    h(
      "span",
      { class: "meta" },
      m.archivedAt ? h("span", { class: "chip archived", text: "archived" }) : null,
      m.scope !== "global" ? h("span", { class: "chip", text: m.scope }) : null,
      (m.tags ?? []).slice(0, 2).map((t) => h("span", { class: "chip", text: `#${t}` })),
      h("span", { class: "imp", text: "★".repeat(m.importance) }),
      h("span", { text: fmtAgo(m.updatedAt) }),
    ),
  );
}

export function emptyState(title: string, body: string, iconName = "i-search"): HTMLElement {
  return h(
    "div",
    { class: "empty" },
    icon(iconName),
    h("h3", { text: title }),
    h("p", { class: "muted", text: body }),
  );
}

export async function renderList(view: HTMLElement): Promise<void> {
  const state = {
    q: "",
    type: "",
    scope: "",
    includeArchived: false,
    offset: 0,
    limit: 20,
    total: 0,
    searchMode: false,
  };
  let debounce: number | undefined;

  const rows = h("div", { class: "table" });
  const counter = h("span", { class: "muted small" });
  const prev = h(
    "button",
    {
      class: "btn btn-sm",
      onclick: () => {
        state.offset = Math.max(0, state.offset - state.limit);
        void load();
      },
    },
    "← Prev",
  );
  const next = h(
    "button",
    {
      class: "btn btn-sm",
      onclick: () => {
        state.offset += state.limit;
        void load();
      },
    },
    "Next →",
  );
  const pager = h("div", { class: "pager" }, prev, counter, next);

  const searchInput = h("input", {
    type: "search",
    placeholder: "Search memories…",
    oninput: () => {
      window.clearTimeout(debounce);
      debounce = window.setTimeout(() => {
        state.q = searchInput.value.trim();
        state.offset = 0;
        void load();
      }, 250);
    },
  });
  const typeSel = h(
    "select",
    {
      onchange: () => {
        state.type = typeSel.value;
        state.offset = 0;
        void load();
      },
    },
    h("option", { value: "", text: "all types" }),
    h("option", { value: "fact", text: "facts" }),
    h("option", { value: "decision", text: "decisions" }),
    h("option", { value: "role", text: "roles" }),
    h("option", { value: "history", text: "history" }),
  );
  const scopeInput = h("input", {
    placeholder: "scope",
    size: 10,
    onchange: () => {
      state.scope = scopeInput.value.trim();
      state.offset = 0;
      void load();
    },
  });
  const archChk = h("input", { type: "checkbox" }) as HTMLInputElement;
  archChk.addEventListener("change", () => {
    state.includeArchived = archChk.checked;
    state.offset = 0;
    void load();
  });

  mount(
    view,
    h(
      "div",
      { class: "page-head" },
      h("h1", { text: "Memories" }),
      h("span", { class: "spacer" }),
      h("a", { class: "btn btn-sm", href: "#/new" }, icon("i-plus"), "New"),
    ),
    h(
      "div",
      { class: "toolbar" },
      h("div", { class: "search" }, icon("i-search"), searchInput),
      typeSel,
      scopeInput,
      h("label", { class: "chk" }, archChk, "archived"),
    ),
    rows,
    pager,
  );

  async function load(): Promise<void> {
    try {
      let items: MemoryRec[];
      if (state.q) {
        const r = await api.search({
          query: state.q,
          type: state.type || undefined,
          scope: state.scope || undefined,
          limit: 100,
        });
        items = r.results;
        state.total = items.length;
        state.searchMode = true;
      } else {
        const r = await api.list({
          type: state.type || undefined,
          scope: state.scope || undefined,
          includeArchived: state.includeArchived,
          offset: state.offset,
          limit: state.limit,
        });
        items = r.memories;
        state.total = r.total;
        state.searchMode = false;
      }
      state.offset = Math.min(state.offset, Math.max(0, state.total - 1));
      renderRows(items);
    } catch (err) {
      throw err; // app router renders the error card
    }
  }

  function renderRows(items: MemoryRec[]): void {
    clear(rows);
    if (items.length === 0) {
      rows.appendChild(
        state.q || state.type || state.scope
          ? emptyState("No matches", "Try a different query or clear the filters.")
          : emptyState("No memories yet", "Store one with New — or run a session digest.", "i-spark"),
      );
    } else {
      for (const m of items) rows.appendChild(mrow(m));
    }

    if (state.searchMode) {
      counter.textContent = `${state.total} hit${state.total === 1 ? "" : "s"}`;
      prev.style.display = "none";
      next.style.display = "none";
      pager.style.display = state.total > 0 ? "flex" : "none";
    } else {
      const from = state.total === 0 ? 0 : state.offset + 1;
      const to = Math.min(state.offset + items.length, state.total);
      counter.textContent = `${from}–${to} of ${state.total}`;
      prev.style.display = "";
      next.style.display = "";
      pager.style.display = state.total > state.limit || state.offset > 0 ? "flex" : "none";
      prev.disabled = state.offset === 0;
      next.disabled = state.offset + items.length >= state.total;
    }
  }

  await load();
}
