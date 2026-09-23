// Roles auditor — instructions-first view of roles AND instructions (plan §4.9:
// both are standing guidance, both carry the trust gate).
import { api } from "../api.js";
import { h, icon, mount } from "../dom.js";
import { emptyState, mrow } from "./list.js";

export async function renderRoles(view: HTMLElement): Promise<void> {
  const [roles, instructions] = await Promise.all([
    api.list({ type: "role", includeArchived: true, limit: 500 }),
    api.list({ type: "instruction", includeArchived: true, limit: 500 }),
  ]);
  const memories = [...roles.memories, ...instructions.memories];

  mount(
    view,
    h(
      "div",
      { class: "page-head" },
      h("h1", { text: "Roles & instructions" }),
      h("span", { class: "spacer" }),
      h("a", { class: "btn btn-sm", href: "#/new?type=role" }, icon("i-plus"), "New role"),
      h("a", { class: "btn btn-sm", href: "#/new?type=instruction" }, icon("i-plus"), "New instruction"),
    ),
    h(
      "div",
      { class: "notice" },
      icon("i-shield"),
      h(
        "div",
        {},
        h("strong", { text: "Roles and instructions steer every response. " }),
        h("span", {
          text:
            "They surface first in retrieval (instructions-first), never decay, and stay scoped — " +
            "review them like system prompts: short, active, and true. Digest-extracted ones stay " +
            "unverified until approved, and never surface first before that.",
        }),
      ),
    ),
    memories.length === 0
      ? emptyState(
          "No roles or instructions yet",
          "Store one like: “You are Remembra…”, tone rules, review checklists.",
          "i-shield",
        )
      : h("div", { class: "table" }, ...memories.map(mrow)),
  );
}
