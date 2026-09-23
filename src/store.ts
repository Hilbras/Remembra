import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { Memory, StoreInput } from "./types.js";

/**
 * File-based memory store.
 *
 * Layout (default root: ~/.remembra):
 *   global/<id>.md            — memories valid everywhere
 *   scopes/<scope>/<id>.md    — memories scoped to a project/workspace
 *
 * Each file is markdown with YAML-ish frontmatter for human readability
 * and simple greppability.
 */
export class MemoryStore {
  constructor(private readonly root: string) {}

  static defaultRoot(): string {
    return process.env.REMEMBRA_HOME ?? path.join(os.homedir(), ".remembra");
  }

  private fileFor(m: Memory): string {
    if (m.scope === "global") {
      return path.join(this.root, "global", `${m.id}.md`);
    }
    const safeScope = m.scope.replace(/[^a-zA-Z0-9._/-]/g, "_");
    return path.join(this.root, "scopes", safeScope, `${m.id}.md`);
  }

  async store(input: StoreInput, embedding?: number[]): Promise<Memory> {
    const now = new Date().toISOString();
    const memory: Memory = {
      id: randomUUID().slice(0, 8),
      type: input.type,
      content: input.content,
      scope: input.scope,
      tags: input.tags,
      importance: input.importance,
      createdAt: now,
      updatedAt: now,
      source: input.source,
      embedding,
    };
    const file = this.fileFor(memory);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, render(memory), "utf8");
    return memory;
  }

  async forget(id: string): Promise<boolean> {
    const file = await this.findFile(id);
    if (!file) return false;
    await fs.unlink(file);
    return true;
  }

  /** Load every memory across all scopes (global + scoped). */
  async all(): Promise<Memory[]> {
    const files: string[] = [];
    for (const dir of [path.join(this.root, "global"), path.join(this.root, "scopes")]) {
      files.push(...(await walk(dir)));
    }
    const memories = await Promise.all(files.map((f) => parse(f)));
    return memories.filter((m): m is Memory => m !== null);
  }

  async get(id: string): Promise<Memory | null> {
    const file = await this.findFile(id);
    if (!file) return null;
    return parse(file);
  }

  private async findFile(id: string): Promise<string | null> {
    const files = await walk(path.join(this.root, "global"), path.join(this.root, "scopes"));
    return files.find((f) => path.basename(f, ".md") === id) ?? null;
  }
}

async function walk(...dirs: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const dir of dirs) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...(await walk(full)));
      else if (e.name.endsWith(".md")) out.push(full);
    }
  }
  return out;
}

function render(m: Memory): string {
  const lines = [
    "---",
    `id: ${m.id}`,
    `type: ${m.type}`,
    `scope: ${m.scope}`,
    `tags: [${m.tags.join(", ")}]`,
    `importance: ${m.importance}`,
    `created: ${m.createdAt}`,
    `updated: ${m.updatedAt}`,
    m.source ? `source: ${m.source}` : undefined,
    m.embedding && m.embedding.length > 0 ? `embedding: [${m.embedding.join(",")}]` : undefined,
    "---",
    "",
    m.content,
    "",
  ];
  return lines.filter((l) => l !== undefined).join("\n");
}

async function parse(file: string): Promise<Memory | null> {
  try {
    const raw = await fs.readFile(file, "utf8");
    const match = raw.match(/^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/);
    if (!match) return null;
    const meta: Record<string, string> = {};
    for (const line of match[1].split("\n")) {
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
    const tagsRaw = (meta.tags ?? "[]").replace(/^\[|\]$/g, "");
    let embedding: number[] | undefined;
    if (meta.embedding) {
      const nums = meta.embedding.replace(/^\[|\]$/g, "").split(",").map(Number);
      if (nums.length > 0 && nums.every((n) => Number.isFinite(n))) embedding = nums;
    }
    return {
      id: meta.id ?? path.basename(file, ".md"),
      type: (meta.type ?? "fact") as Memory["type"],
      content: match[2].trim(),
      scope: meta.scope ?? "global",
      tags: tagsRaw ? tagsRaw.split(",").map((t) => t.trim()) : [],
      importance: Number(meta.importance ?? 3),
      createdAt: meta.created ?? new Date(0).toISOString(),
      updatedAt: meta.updated ?? meta.created ?? new Date(0).toISOString(),
      source: meta.source,
      embedding,
    };
  } catch {
    return null;
  }
}
