#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = [path.join(root, "README.md")];
const docs = await fs.readdir(path.join(root, "docs"));
for (const name of docs) if (name.endsWith(".md")) files.push(path.join(root, "docs", name));

const missing = [];
for (const file of files) {
  const text = await fs.readFile(file, "utf8");
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const raw = match[1].trim().replace(/^<|>$/g, "");
    if (!raw || raw.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(raw)) continue;
    const target = raw.split("#", 1)[0].split("?", 1)[0];
    if (!target) continue;
    const resolved = path.resolve(path.dirname(file), target);
    try {
      await fs.access(resolved);
    } catch {
      missing.push(`${path.relative(root, file)} -> ${raw}`);
    }
  }
}

if (missing.length > 0) {
  console.error(`Missing documentation links:\n${missing.map((item) => `- ${item}`).join("\n")}`);
  process.exit(1);
}
console.log(`Documentation links ok (${files.length} files)`);
