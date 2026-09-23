#!/usr/bin/env node
/** Isolated corpus seeder used by bench-scale.mjs. */
import path from "node:path";
import Database from "better-sqlite3";

const root = process.argv[2];
const size = Number(process.argv[3]);
if (!root || !Number.isInteger(size) || size <= 0) {
  console.error("usage: seed-scale.mjs <root> <size>");
  process.exit(2);
}

const dbPath = path.join(root, "data.sqlite");
const db = new Database(dbPath);
// The main backend sets the schema version and adds secondary indexes when it
// opens this file. Avoid write-side pragmas in this isolated bulk seeder.
db.exec(`
  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    content TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'global',
    tags TEXT NOT NULL DEFAULT '[]',
    importance INTEGER NOT NULL DEFAULT 3,
    confidence REAL NOT NULL DEFAULT 1.0,
    trust TEXT NOT NULL DEFAULT 'trusted',
    provenance TEXT NOT NULL,
    owner TEXT NOT NULL DEFAULT 'global',
    access TEXT NOT NULL DEFAULT 'global',
    valid_from TEXT,
    valid_until TEXT,
    observed_at TEXT,
    superseded_by TEXT,
    meta TEXT,
    retention TEXT NOT NULL DEFAULT 'decaying',
    relations TEXT NOT NULL DEFAULT '[]',
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_seen TEXT,
    archived_at TEXT,
    embedding BLOB
  )
`);
const now = new Date().toISOString();
const columns = `
  id, type, content, scope, tags, importance, confidence, trust,
  provenance, owner, access, retention, relations, version, created_at, updated_at
`;
const insert = db.prepare(`
  INSERT INTO memories (${columns})
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
for (let i = 0; i < size; i++) {
  const content = `Scale record ${i} searchable token-${i % 97} category-${i % 11} hit${i}`;
  const type = i % 3 === 0 ? "fact" : i % 3 === 1 ? "event" : "observation";
  const scope = i % 4 === 0 ? `project-${i % 13}` : "global";
  const tags = JSON.stringify([`tag-${i % 11}`, `bucket-${i % 7}`]);
  insert.run(
    `bench-${String(i).padStart(8, "0")}`,
    type,
    content,
    scope,
    tags,
    (i % 5) + 1,
    1,
    "trusted",
    JSON.stringify({ sourceType: "manual" }),
    "global",
    "global",
    "decaying",
    "[]",
    1,
    now,
    now,
  );
}
db.close();
