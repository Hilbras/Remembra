// Session digest — paste a transcript, extract worth-keeping memories.
import { api, ApiError, DigestResult } from "../api.js";
import { h, mount, toast } from "../dom.js";

export async function renderDigest(view: HTMLElement): Promise<void> {
  const transcript = h("textarea", {
    rows: 12,
    placeholder: "Paste a session transcript…\n\nThe extractor keeps facts, decisions, roles and history worth remembering across sessions.",
  }) as HTMLTextAreaElement;
  const scopeInput = h("input", { placeholder: "global or a project path" }) as HTMLInputElement;
  const sourceInput = h("input", { placeholder: "e.g. opencode session 2026-09-23" }) as HTMLInputElement;
  const resultBox = h("div");
  const errorBox = h("div");

  let running = false;
  const run = async (): Promise<void> => {
    const text = transcript.value.trim();
    if (!text) {
      toast("Paste a transcript first", "err");
      transcript.focus();
      return;
    }
    if (running) return;
    running = true;
    btn.disabled = true;
    btn.textContent = "Extracting…";
    try {
      const r = await api.digest({
        transcript: text,
        scope: scopeInput.value.trim() || undefined,
        source: sourceInput.value.trim() || undefined,
      });
      renderResult(r);
      toast(`Stored ${r.stored.length} memories`, "ok");
    } catch (err) {
      renderError(err);
    } finally {
      running = false;
      btn.disabled = false;
      btn.textContent = "Extract memories";
    }
  };
  const btn = h(
    "button",
    { class: "btn btn-primary", onclick: () => void run() },
    "Extract memories",
  );

  function renderResult(r: DigestResult): void {
    mount(
      resultBox,
      h(
        "div",
        { class: "card" },
        h("div", { class: "card-title", text: "Result" }),
        h(
          "div",
          { class: "kv-inline" },
          h("span", {}, "Extracted: ", h("b", { text: String(r.extracted) })),
          h("span", {}, "Stored: ", h("b", { text: String(r.stored.length) })),
          h("span", {}, "Duplicates skipped: ", h("b", { text: String(r.skippedDuplicates) })),
          h("span", {}, "Merged: ", h("b", { text: String(r.merged) })),
        ),
        r.stored.length > 0
          ? h(
              "div",
              { class: "table" },
              ...r.stored.map((m) =>
                h(
                  "div",
                  { class: "rel-item" },
                  h("span", { class: "badge t-" + m.type, text: m.type }),
                  h("a", { class: "label", href: `#/memories/${m.id}`, text: m.content.split("\n")[0] }),
                ),
              ),
            )
          : h("p", { class: "muted small", text: "Nothing new to store." }),
      ),
    );
  }

  function renderError(err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    const llmHint =
      err instanceof ApiError && /llm|provider|api key|anthropic|openai|ollama/i.test(msg);
    mount(
      errorBox,
      h(
        "div",
        { class: "card error-card" },
        h("div", { class: "card-title", text: "Digest failed" }),
        h("p", { class: "content-block", text: msg }),
        llmHint
          ? h("p", {
              class: "muted small",
              text: "Configure an LLM provider: REMEMBRA_LLM=openai|anthropic|ollama plus its API key — see docs/providers.md.",
            })
          : null,
      ),
    );
    mount(resultBox);
  }

  mount(
    view,
    h(
      "div",
      { class: "page-head" },
      h("h1", { text: "Session digest" }),
      h("span", { class: "spacer" }),
    ),
    h("p", {
      class: "muted",
      text: "Turn a raw transcript into durable memories — exact duplicates are skipped, evolved ones contradiction-merged.",
    }),
    h(
      "div",
      { class: "card" },
      h("div", { class: "field" }, h("label", { text: "Transcript" }), transcript),
      h(
        "div",
        { class: "field-row" },
        h("div", { class: "field" }, h("label", { text: "Scope" }), scopeInput),
        h("div", { class: "field" }, h("label", { text: "Source" }), sourceInput),
      ),
      h("div", { class: "btn-row" }, btn),
    ),
    errorBox,
    resultBox,
  );
  transcript.focus();
}
