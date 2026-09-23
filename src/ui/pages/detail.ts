// Memory detail — content, metadata, links, history diffs, lifecycle actions.
import { api, Brief, MemoryRec } from "../api.js";
import { clear, confirmModal, fmtAgo, fmtDate, h, icon, mount, toast, typeBadge } from "../dom.js";

function briefLabel(b: Brief): string {
  if (b.missing) return `${b.id} (missing)`;
  const line = (b.content ?? "").split("\n")[0];
  return line ? `${b.id} · ${line}` : b.id;
}

/** Typed relation kinds (plan §4.7) — mirrors RelationKind in types.ts. */
const RELATION_KINDS = ["related", "supports", "contradicts", "supersedes", "refines", "duplicates"] as const;

/** Provenance object → "manual" / "conversation · openai" label. */
function provLabel(m: MemoryRec): string {
  const p = m.provenance;
  if (!p) return "—";
  return p.provider ? `${p.sourceType} · ${p.provider}` : p.sourceType;
}

function diffBlock(diff: string): HTMLElement {
  const lines = diff.trimEnd().split("\n");
  return h(
    "div",
    { class: "diff" },
    ...lines.map((line) => {
      const cls =
        line.startsWith("@@") || line.startsWith("---") || line.startsWith("+++")
          ? "ctx"
          : line.startsWith("+")
            ? "add"
            : line.startsWith("-")
              ? "del"
              : "ctx";
      return h("div", { class: cls, text: line });
    }),
  );
}

export async function renderDetail(view: HTMLElement, id: string): Promise<void> {
  const data = await api.get(id);
  const m = data.memory;
  const refresh = (): Promise<void> => {
    clear(view);
    return renderDetail(view, id);
  };
  const fail = (err: unknown): void => toast(err instanceof Error ? err.message : String(err), "err");

  // --- lifecycle actions ---
  const archiveBtn = h(
    "button",
    {
      class: "btn",
      onclick: async () => {
        try {
          if (m.archivedAt) {
            await api.revive(id);
            toast("Revived", "ok");
          } else {
            await api.archive(id);
            toast("Archived", "ok");
          }
          await refresh();
        } catch (err) {
          fail(err);
        }
      },
    },
    icon("i-archive"),
    m.archivedAt ? "Revive" : "Archive",
  );

  const deleteBtn = h(
    "button",
    {
      class: "btn btn-danger",
      onclick: async () => {
        const ok = await confirmModal(
          "Delete memory",
          `Permanently delete ${id}? This cannot be undone (archive instead to keep it).`,
          "Delete",
        );
        if (!ok) return;
        try {
          await api.forget(id);
          toast("Deleted", "ok");
          location.hash = "#/memories";
        } catch (err) {
          fail(err);
        }
      },
    },
    icon("i-trash"),
    "Delete",
  );

  // --- history (lazy) ---
  const histBody = h("div");
  const histCard = h("div", { class: "card hidden" }, h("div", { class: "card-title", text: "History" }), histBody);
  let histLoaded = false;
  const histBtn = h(
    "button",
    {
      class: "btn",
      onclick: async () => {
        if (!histCard.classList.contains("hidden")) {
          histCard.classList.add("hidden");
          return;
        }
        histBtn.disabled = true;
        try {
          if (!histLoaded) {
            const r = await api.history(id);
            renderHistory(r.versions);
            histLoaded = true;
          }
          histCard.classList.remove("hidden");
          histCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
        } catch (err) {
          fail(err);
        } finally {
          histBtn.disabled = false;
        }
      },
    },
    icon("i-clock"),
    "History",
  );

  function renderHistory(versions: Awaited<ReturnType<typeof api.history>>["versions"]): void {
    if (versions.length <= 1) {
      mount(histBody, h("p", { class: "muted small", text: "No earlier versions yet — edits and merges snapshot the previous content." }));
      return;
    }
    mount(
      histBody,
      ...versions.map((v) =>
        h(
          "details",
          { class: "history-ver", ...(v.current ? { open: true } : {}) },
          h(
            "summary",
            {},
            v.current
              ? h("b", { text: "Current" })
              : h(
                  "span",
                  {
                    text: `Superseded ${fmtDate(v.snapshotAt ?? v.at ?? "")}${v.reason ? ` — ${v.reason}` : ""}`,
                  },
                ),
            h("span", { class: "dim small", text: ` — ${v.content.split("\n")[0].slice(0, 80)}` }),
          ),
          v.diff ? diffBlock(v.diff) : h("p", { class: "dim small", text: "(no line changes vs older version)" }),
        ),
      ),
    );
  }

  // --- relate editor ---
  const candidateList = await api.list({ limit: 500 });
  const linked = new Set((m.relations ?? []).map((r) => r.id));
  const options = candidateList.memories.filter((c) => c.id !== id && !linked.has(c.id));
  const targetSel = h(
    "select",
    {},
    ...options.map((c) =>
      h("option", { value: c.id, text: `${c.id} · ${c.content.split("\n")[0].slice(0, 60)}` }),
    ),
  ) as HTMLSelectElement;
  const kindSel = h(
    "select",
    { title: "Relation kind" },
    ...RELATION_KINDS.map((k) => h("option", { value: k, text: k })),
  ) as HTMLSelectElement;
  const addRelBtn = h(
    "button",
    {
      class: "btn btn-sm",
      disabled: options.length === 0,
      onclick: async () => {
        if (!targetSel.value) return;
        try {
          await api.relate(id, { related: [targetSel.value], action: "add", kind: kindSel.value });
          toast("Linked", "ok");
          await refresh();
        } catch (err) {
          fail(err);
        }
      },
    },
    icon("i-link"),
    "Link",
  );

  const unlinkBtn = (rid: string) =>
    h(
      "button",
      {
        class: "icon-btn",
        title: "Unlink",
        onclick: async (ev: Event) => {
          ev.stopPropagation();
          try {
            await api.relate(id, { related: [rid], action: "remove" });
            toast("Unlinked", "ok");
            await refresh();
          } catch (err) {
            fail(err);
          }
        },
      },
      icon("i-close"),
    );

  const linkRow = (b: Brief, unlink: boolean) =>
    h(
      "div",
      { class: "rel-item" },
      icon("i-link"),
      b.kind && b.kind !== "related" ? h("span", { class: "chip rel-kind", text: b.kind }) : null,
      b.missing
        ? h("span", { class: "label dim", text: briefLabel(b) })
        : h("a", { class: "label", href: `#/memories/${b.id}`, text: briefLabel(b) }),
      unlink ? unlinkBtn(b.id) : null,
    );

  // --- layout ---
  mount(
    view,
    h(
      "div",
      { class: "page-head" },
      h("a", { class: "icon-btn", href: "#/memories", title: "Back" }, icon("i-back")),
      typeBadge(m.type),
      h("span", { class: "mono dim small", text: m.id }),
      m.archivedAt ? h("span", { class: "chip archived", text: "archived" }) : null,
      h("span", { class: "spacer" }),
      h("a", { class: "btn btn-sm", href: `#/edit/${m.id}` }, icon("i-edit"), "Edit"),
    ),
    h(
      "div",
      { class: "detail-grid" },
      h(
        "div",
        {},
        h(
          "div",
          { class: "card" },
          h("p", { class: "content-block", text: m.content }),
          (m.tags ?? []).length > 0
            ? h("div", { class: "chip-row" }, ...(m.tags ?? []).map((t) => h("span", { class: "chip", text: `#${t}` })))
            : null,
          h("div", { class: "btn-row" }, archiveBtn, histBtn, deleteBtn),
        ),
        histCard,
      ),
      h(
        "div",
        {},
        h(
          "div",
          { class: "card" },
          h("div", { class: "card-title", text: "Metadata" }),
          h(
            "dl",
            { class: "kv" },
            h("dt", { text: "Scope" }),
            h("dd", {}, m.scope === "global" ? h("span", { class: "chip", text: "global" }) : h("span", { class: "chip", text: m.scope })),
            h("dt", { text: "Importance" }),
            h("dd", { class: "imp", text: "★".repeat(m.importance) + "☆".repeat(5 - m.importance) }),
            h("dt", { text: "Confidence" }),
            h("dd", { text: m.confidence !== undefined ? String(m.confidence) : "—" }),
            h("dt", { text: "Trust" }),
            h(
              "dd",
              { class: "trust-cell" },
              h("span", { class: `chip trust-${m.trust ?? "trusted"}`, text: m.trust ?? "trusted" }),
              m.trust === "unverified"
                ? h(
                    "button",
                    {
                      class: "btn btn-sm",
                      title: "Approve: trust → verified, so this may act as a standing instruction",
                      onclick: async () => {
                        try {
                          await api.update(id, { trust: "verified" });
                          toast("Approved — trust set to verified", "ok");
                          await refresh();
                        } catch (err) {
                          fail(err);
                        }
                      },
                    },
                    icon("i-shield"),
                    "Approve",
                  )
                : null,
            ),
            h("dt", { text: "Provenance" }),
            h("dd", { text: provLabel(m) }),
            h("dt", { text: "Retention" }),
            h("dd", { text: m.retention ?? "decaying (default)" }),
            h("dt", { text: "Version" }),
            h("dd", { text: m.version !== undefined ? String(m.version) : "—" }),
            h("dt", { text: "Source" }),
            h("dd", { text: m.source ?? "—" }),
            h("dt", { text: "Created" }),
            h("dd", { text: fmtDate(m.createdAt) }),
            h("dt", { text: "Updated" }),
            h("dd", { title: fmtDate(m.updatedAt), text: fmtAgo(m.updatedAt) }),
            m.lastValidated ? h("dt", { text: "Last validated" }) : null,
            m.lastValidated ? h("dd", { text: fmtDate(m.lastValidated) }) : null,
          ),
        ),
        h(
          "div",
          { class: "card" },
          h("div", { class: "card-title", text: "Links" }),
          data.related.length > 0
            ? h("div", { class: "rel-list" }, ...data.related.map((b) => linkRow(b, true)))
            : null,
          data.backlinks.length > 0
            ? h(
                "div",
                { class: "rel-list" },
                h("div", { class: "hint", text: "Referenced by:" }),
                ...data.backlinks.map((b) => linkRow(b, false)),
              )
            : null,
          data.related.length === 0 && data.backlinks.length === 0
            ? h("p", { class: "muted small", text: "No links yet — connect related memories to build the graph." })
            : null,
          h(
            "div",
            { class: "btn-row" },
            targetSel,
            kindSel,
            addRelBtn,
          ),
        ),
      ),
    ),
  );
}
