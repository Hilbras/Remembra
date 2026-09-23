import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { Memory, StoreInput, SCHEMA_VERSION } from "./types.js";

/**
 * File-based memory store (source of truth — no database).
 *
 * Layout (default root: ~/.remembra):
 *   global/<id>.md            — active memories, valid everywhere
 *   scopes/<scope>/<id>.md    — active memories scoped to a project/workspace
 *   archived/global/<id>.md   — archived memories (out of search, listed with flag)
 *   archived/scopes/<scope>/  — archived scoped memories
 *
 * Each file is markdown with frontmatter for human readability and greppability.
 * Maintenance runs opportunistically on search + via `memory_maintain`.
 */
export class MemoryStore {
  constructor(private readonly root: string) {}

  static defaultRoot(): string {
    return process.env.REMEMBRA_HOME ?? path.join(os.homedir(), ".remembra");
  }

  private fileFor(m: Memory): string {
    const safeScope = m.scope === "global" ? "global" : m.scope.replace(/[^a-zA-Z0-9._/-]/g, "_");
    const base = m.scope === "global" ? path.join(this.root, "global") : path.join(this.root, "scopes", safeScope);
    const archivedBase =
      m.scope === "global"
        ? path.join(this.root, "archived", "global")
        : path.join(this.root, "archived", "scopes", safeScope);
    const dir = m.archivedAt ? archivedBase : base;
    const file = path.resolve(path.join(dir, `${m.id}.md`));
    // Defense in depth (P0): never touch anything outside the storage root.
    const root = path.resolve(this.root);
    if (!file.startsWith(root + path.sep)) {
      throw new Error(`Invalid scope "${m.scope}": resolves outside the storage root`);
    }
    return file;
  }

  async store(input: StoreInput, embedding?: number[]): Promise<Memory> {
    const now = new Date().toISOString();
    // 12 hex chars (2^48): collision-safe; existence check guards the rest (P2 audit #9).
    let id = genId();
    for (let i = 0; i < 10 && (await this.findFile(id)); i++) id = genId();
    const memory: Memory = {
      id,
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
    await writeFileAtomic(file, render(memory), fs);
    return memory;
  }

  async forget(id: string): Promise<boolean> {
    const file = await this.findFile(id);
    if (!file) return false;
    await fs.unlink(file);
    return true;
  }

  /** Load active memories (excludes archived). Pass includeArchived for everything. */
  async all(includeArchived = false): Promise<Memory[]> {
    const dirs = [path.join(this.root, "global"), path.join(this.root, "scopes")];
    if (includeArchived) {
      dirs.push(path.join(this.root, "archived", "global"), path.join(this.root, "archived", "scopes"));
    }
    const files = await walk(...dirs);
    const memories = await Promise.all(files.map((f) => parse(f)));
    return memories.filter((m): m is Memory => m !== null);
  }

  async get(id: string): Promise<Memory | null> {
    const file = await this.findFile(id);
    if (!file) return null;
    return parse(file);
  }

  /** Move a memory to the archived tree (sets archivedAt). */
  async archive(id: string): Promise<Memory | null> {
    const m = await this.get(id);
    if (!m || m.archivedAt) return null;
    const oldFile = this.fileFor(m);
    const updated: Memory = { ...m, archivedAt: new Date().toISOString() };
    const newFile = this.fileFor(updated);
    if (oldFile === newFile) return null;
    await fs.mkdir(path.dirname(newFile), { recursive: true });
    await writeFileAtomic(newFile, render(updated), fs);
    await fs.unlink(oldFile);
    return updated;
  }

  /** Bring an archived memory back into active search. */
  async revive(id: string): Promise<Memory | null> {
    const m = await this.get(id);
    if (!m || !m.archivedAt) return null;
    const oldFile = this.fileFor(m);
    const now = new Date().toISOString();
    const updated: Memory = { ...m, archivedAt: undefined, lastSeen: now, updatedAt: now };
    const newFile = this.fileFor(updated);
    await fs.mkdir(path.dirname(newFile), { recursive: true });
    await writeFileAtomic(newFile, render(updated), fs);
    await fs.unlink(oldFile);
    return updated;
  }

  /** Persist changes to an existing memory (merge/update path). */
  async update(memory: Memory): Promise<Memory> {
    const updated: Memory = { ...memory, updatedAt: new Date().toISOString() };
    const file = this.fileFor(updated);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await writeFileAtomic(file, render(updated), fs);
    return updated;
  }

  /** Record that a memory surfaced in search (decay refresh). Cheap: no-op if seen <1h ago. */
  async touch(id: string): Promise<void> {
    const m = await this.get(id);
    if (!m) return;
    const last = Date.parse(m.lastSeen ?? m.updatedAt);
    if (Number.isFinite(last) && Date.now() - last < 3_600_000) return;
    m.lastSeen = new Date().toISOString();
    await writeFileAtomic(this.fileFor(m), render(m), fs);
  }

  /** Import a snapshot memory verbatim (id preserved). Returns false if the id exists. */
  async importMemory(m: Memory): Promise<boolean> {
    if (await this.findFile(m.id)) return false;
    const file = this.fileFor(m); // containment check applies (P0)
    await fs.mkdir(path.dirname(file), { recursive: true });
    await writeFileAtomic(file, render(m), fs);
    return true;
  }

  private async findFile(id: string): Promise<string | null> {
    const files = await walk(
      path.join(this.root, "global"),
      path.join(this.root, "scopes"),
      path.join(this.root, "archived"),
    );
    return files.find((f) => path.basename(f, ".md") === id) ?? null;
  }
}

function genId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

/**
 * Atomic write (P1 audit): write to a temp file in the same directory,
 * then rename() over the target — POSIX-atomic, so a crash mid-write can
 * never leave a half-written memory file.
 */
async function writeFileAtomic(file: string, data: string, fsmod: typeof fs): Promise<void> {
  const tmp = `${file}.${genId().slice(0, 6)}.tmp`;
  try {
    await fsmod.writeFile(tmp, data, "utf8");
    await fsmod.rename(tmp, file);
  } catch (err) {
    await fsmod.unlink(tmp).catch(() => {});
    throw err;
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
    `version: ${SCHEMA_VERSION}`,
    `type: ${m.type}`,
    `scope: ${m.scope}`,
    `tags: [${m.tags.join(", ")}]`,
    `importance: ${m.importance}`,
    `created: ${m.createdAt}`,
    `updated: ${m.updatedAt}`,
    m.lastSeen ? `lastSeen: ${m.lastSeen}` : undefined,
    m.archivedAt ? `archivedAt: ${m.archivedAt}` : undefined,
    m.source ? `source: ${m.source}` : undefined,
    m.embedding && m.embedding.length > 0 ? `embedding: [${m.embedding.join(",")}]` : undefined,
    "---",
    "",
    m.content,
    "",
  ];
  return lines.filter((l) => l !== undefined).join("\n");
}

/** Files we've already warned about (avoid log spam on every search). */
const parseWarnings = new Set<string>();

async function parse(file: string): Promise<Memory | null> {
  const warnOnce = (why: string) => {
    const key = `${file}:${why}`;
    if (parseWarnings.has(key)) return;
    parseWarnings.add(key);
    console.error(`Remembra: skipping unparseable memory file ${path.basename(file)} (${why})`);
  };
  try {
    const raw = await fs.readFile(file, "utf8");
    const match = raw.match(/^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/);
    if (!match) {
      warnOnce("missing/invalid frontmatter");
      return null;
    }
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
      lastSeen: meta.lastSeen,
      archivedAt: meta.archivedAt,
      source: meta.source,
      embedding,
    };
  } catch (err) {
    warnOnce(err instanceof Error ? err.message : String(err));
    return null;
  }
}
