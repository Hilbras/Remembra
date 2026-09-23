// Roles auditor — instructions-first view of every role memory.
import { api } from "../api.js";
import { h, icon, mount } from "../dom.js";
import { emptyState, mrow } from "./list.js";

export async function renderRoles(view: HTMLElement): Promise<void> {
  const r = await api.list({ type: "role", includeArchived: true, limit: 500 });

  mount(
    view,
    h(
      "div",
      { class: "page-head" },
      h("h1", { text: "Roles" }),
      h("span", { class: "spacer" }),
      h("a", { class: "btn btn-sm", href: "#/new?type=role" }, icon("i-plus"), "New role"),
    ),
    h(
      "div",
      { class: "notice" },
      icon("i-shield"),
      h(
        "div",
        {},
        h("strong", { text: "Roles steer every response. " }),
        h("span", {
          text:
            "They surface first in retrieval (instructions-first), never decay, and stay scoped — " +
            "review them like system prompts: short, active, and true.",
        }),
      ),
    ),
    r.memories.length === 0
      ? emptyState(
          "No roles yet",
          "Store one like: “You are Remembra…”, tone rules, review checklists.",
          "i-shield",
        )
      : h("div", { class: "table" }, ...r.memories.map(mrow)),
  );
}
