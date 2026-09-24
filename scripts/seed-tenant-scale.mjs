#!/usr/bin/env node
/** Isolated V5 tenant corpus seeder used by bench-tenant.mjs. */
import path from "node:path";
import Database from "better-sqlite3";

const root = process.argv[2];
const size = Number(process.argv[3]);
if (!root || !Number.isInteger(size) || size <= 0) {
  console.error("usage: seed-tenant-scale.mjs <root> <size>");
  process.exit(2);
}

const db = new Database(path.join(root, "data.sqlite"));
db.exec(`
  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    content TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'global',
    tenant_id TEXT,
    project_id TEXT,
    user_id TEXT,
    agent_id TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    importance INTEGER NOT NULL DEFAULT 3,
    confidence REAL NOT NULL DEFAULT 1,
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
const insert = db.prepare(`
  INSERT INTO memories (
    id, type, content, scope, tenant_id, tags, importance, confidence, trust,
    provenance, owner, access, retention, relations, version, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
for (let i = 0; i < size; i++) {
  insert.run(
    `tenant-bench-${String(i).padStart(8, "0")}`,
    "fact",
    `Tenant record ${i} searchable token-${i % 97} hit${i}`,
    "global",
    i % 2 === 0 ? "org-a" : "org-b",
    JSON.stringify([`tag-${i % 11}`]),
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
