// Create / edit form.
import { api, MemoryRec } from "../api.js";
import { h, mount, toast, MEMORY_TYPES } from "../dom.js";

export async function renderEdit(view: HTMLElement, id: string | null): Promise<void> {
  let existing: MemoryRec | undefined;
  if (id) existing = (await api.get(id)).memory;

  const query = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const typeSel = h(
    "select",
    {},
    ...MEMORY_TYPES.map((t) => h("option", { value: t, text: t })),
  ) as HTMLSelectElement;
  typeSel.value = existing?.type ?? query.get("type") ?? "fact";

  const content = h("textarea", {
    rows: 6,
    placeholder: "What should the assistant remember?",
  }) as HTMLTextAreaElement;
  content.value = existing?.content ?? "";

  const scopeInput = h("input", { placeholder: "global or a project path" }) as HTMLInputElement;
  scopeInput.value = existing?.scope ?? "global";

  const tagsInput = h("input", { placeholder: "comma, separated, tags" }) as HTMLInputElement;
  tagsInput.value = (existing?.tags ?? []).join(", ");

  const impSel = h(
    "select",
    {},
    ...[1, 2, 3, 4, 5].map((n) => h("option", { value: n, text: `${n} ${"★".repeat(n)}` })),
  ) as HTMLSelectElement;
  impSel.value = String(existing?.importance ?? 3);

  const confInput = h("input", {
    type: "number",
    min: 0,
    max: 1,
    step: 0.05,
    placeholder: "1.0",
  }) as HTMLInputElement;
  if (existing?.confidence !== undefined) confInput.value = String(existing.confidence);

  const sourceInput = h("input", { placeholder: "e.g. opencode, claude-code…" }) as HTMLInputElement;
  sourceInput.value = existing?.source ?? "";

  // Retention mode (plan §4.8). Trust (§4.5) is an edit-time classification —
  // the approve flow lives on the detail page.
  const retSel = h(
    "select",
    {},
    h("option", { value: "decaying", text: "decaying (default)" }),
    h("option", { value: "pinned", text: "pinned — never decays, ranked first" }),
    h("option", { value: "persistent", text: "persistent — kept forever" }),
    h("option", { value: "ephemeral", text: "ephemeral — fast decay" }),
    h("option", { value: "neverExpire", text: "never expire — no archive, no delete" }),
  ) as HTMLSelectElement;
  retSel.value = existing?.retention ?? "decaying";

  const trustSel = h(
    "select",
    {},
    h("option", { value: "unverified", text: "unverified — never surfaces first" }),
    h("option", { value: "trusted", text: "trusted" }),
    h("option", { value: "verified", text: "verified" }),
    h("option", { value: "system", text: "system" }),
  ) as HTMLSelectElement;
  trustSel.value = existing?.trust ?? "trusted";

  let saving = false;
  const save = async (): Promise<void> => {
    const text = content.value.trim();
    if (!text) {
      toast("Content is required", "err");
      content.focus();
      return;
    }
    if (saving) return;
    saving = true;
    saveBtn.disabled = true;
    const tags = tagsInput.value
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const confRaw = confInput.value.trim();
    const conf = confRaw === "" ? undefined : Number(confRaw);
    const payload = {
      type: typeSel.value,
      content: text,
      scope: scopeInput.value.trim() || "global",
      tags,
      importance: Number(impSel.value),
      ...(sourceInput.value.trim() ? { source: sourceInput.value.trim() } : {}),
      ...(conf !== undefined && Number.isFinite(conf) && conf >= 0 && conf <= 1
        ? { confidence: conf }
        : {}),
      ...(retSel.value ? { retention: retSel.value } : {}),
      ...(existing && trustSel.value !== existing.trust ? { trust: trustSel.value } : {}),
    };
    try {
      const r = existing ? await api.update(existing.id, payload) : await api.store(payload);
      toast(existing ? "Memory updated" : "Memory stored", "ok");
      location.hash = `#/memories/${r.memory.id}`;
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "err");
      saving = false;
      saveBtn.disabled = false;
    }
  };
  const saveBtn = h(
    "button",
    { class: "btn btn-primary", onclick: () => void save() },
    existing ? "Save changes" : "Store memory",
  );

  const form = h(
    "form",
    {
      class: "form",
      onsubmit: (ev: Event) => {
        ev.preventDefault();
        void save();
      },
    },
    h("div", { class: "field" }, h("label", { text: "Type" }), typeSel),
    h(
      "div",
      { class: "field" },
      h("label", { text: "Content" }),
      content,
      h("span", { class: "hint", text: "First line is the summary shown in lists." }),
    ),
    h(
      "div",
      { class: "field-row" },
      h(
        "div",
        { class: "field" },
        h("label", { text: "Scope" }),
        scopeInput,
        h("span", { class: "hint", text: "Changing it moves the file between trees." }),
      ),
      h("div", { class: "field" }, h("label", { text: "Tags" }), tagsInput),
    ),
    h(
      "div",
      { class: "field-row" },
      h("div", { class: "field" }, h("label", { text: "Importance" }), impSel),
      h(
        "div",
        { class: "field" },
        h("label", { text: "Confidence" }),
        confInput,
        h("span", { class: "hint", text: "Optional; leave as-is to keep." }),
      ),
      h("div", { class: "field" }, h("label", { text: "Source" }), sourceInput),
    ),
    h(
      "div",
      { class: "field-row" },
      h(
        "div",
        { class: "field" },
        h("label", { text: "Retention" }),
        retSel,
        h("span", { class: "hint", text: "Decay protection — pinned memories never fade." }),
      ),
      existing
        ? h(
            "div",
            { class: "field" },
            h("label", { text: "Trust" }),
            trustSel,
            h("span", { class: "hint", text: "Unverified roles/instructions never surface first." }),
          )
        : null,
    ),
    h(
      "div",
      { class: "btn-row" },
      saveBtn,
      h(
        "a",
        { class: "btn btn-ghost", href: existing ? `#/memories/${existing.id}` : "#/memories" },
        "Cancel",
      ),
    ),
  );

  mount(
    view,
    h(
      "div",
      { class: "page-head" },
      h("h1", { text: existing ? "Edit memory" : "New memory" }),
      h("span", { class: "spacer" }),
      existing ? h("span", { class: "mono dim small", text: existing.id }) : null,
    ),
    form,
  );
  content.focus();
}
