import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { SqliteBackend } from "../sqlite-backend.js";
import { StoreInput } from "../types.js";
import { buildV6Predicate } from "../v6-retrieval-policy.js";
import { createRequestContext } from "../v6-request-context.js";

/**
 * W-02 — wire V6's retrieval predicate to the columns that actually exist.
 *
 * Two problems, and the second is the reason this task exists:
 *
 *  1. `sensitivity` and `legal_hold` do not exist on `memories` at all. Adding them is
 *     additive and safe: existing rows get a default, and the default must be the
 *     *permissive* one so no existing memory silently becomes invisible.
 *  2. `expires_at` does not exist, and **must not be added**. `valid_until` is already
 *     the expiry column, already indexed, and just hardened against malformed values.
 *     Adding `expires_at` would create a second source of truth for retention — which
 *     is exactly the "cannot be confused" criterion failing at the schema level.
 *
 * So the predicate is rewritten against `valid_until`, and the migration deliberately
 * does NOT add an expiry column. These tests pin both: the columns that must exist, and
 * the one that must not.
 */

/**
 * The raw handle, for the tests that deliberately reach past the public API — a
 * migration and a legal hold are both states a caller cannot express through `store()`.
 */
interface RawDb {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...args: unknown[]): unknown;
    get(...args: unknown[]): Record<string, unknown>;
    all(...args: unknown[]): Array<Record<string, unknown>>;
  };
}
const raw = (store: SqliteBackend): RawDb =>
  (store as unknown as Record<string, RawDb>)["db"];

/**
 * Every query fixture stores into an explicit tenant, because a V6 predicate is always
 * tenant-scoped: `m.tenant_id = ?`. Rows written without one have `tenant_id IS NULL`
 * and are correctly excluded -- which is the pre-existing V5 rule, not a bug here.
 */
async function tempSqlite(): Promise<{ store: SqliteBackend; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-w02-"));
  const store = new SqliteBackend({ root: dir });
  return { store, dir };
}

const cleanup = async (dir: string): Promise<void> => {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
};

const columns = (store: SqliteBackend): string[] =>
  raw(store).prepare("PRAGMA table_info(memories)").all().map((c) => String(c.name));

const context = (clearance = "secret") =>
  createRequestContext({
    principal: {
      organizationId: "org-a",
      projectId: "p1",
      membershipVersion: "m-1",
      scopes: ["project/p1"],
      capabilities: ["tenant:read"],
      clearance,
    },
    operation: "read",
    authMethod: "api_key",
    authExpiresAt: 10_000_000,
    resolvedAt: 0,
    now: 0,
  });

// --- the columns that must exist --------------------------------------------

test("V6-W02-001: sensitivity and legal_hold exist on memories", async () => {
  const { store, dir } = await tempSqlite();
  try {
    const names = columns(store);
    assert.ok(names.includes("sensitivity"), "sensitivity must be a real column");
    assert.ok(names.includes("legal_hold"), "legal_hold must be a real column");
  } finally {
    store.close();
    await cleanup(dir);
  }
});

test("V6-W02-002: there is still no expires_at column", async () => {
  // The whole point of W-02. `valid_until` is the expiry column; a second one would be
  // two sources of truth for retention, which is the confusion T11 exists to prevent.
  // Asserted against the LIVE schema, so a later "just add expires_at" is a test
  // failure rather than something nobody notices until two columns disagree.
  const { store, dir } = await tempSqlite();
  try {
    assert.equal(columns(store).includes("expires_at"), false);
    assert.ok(columns(store).includes("valid_until"), "valid_until remains the expiry column");
  } finally {
    store.close();
    await cleanup(dir);
  }
});

// --- the migration is additive and permissive ---------------------------------

test("V6-W02-003: an existing database gains the columns without data loss", async () => {
  // Simulates a pre-migration database: create one WITHOUT the new columns, write a
  // row, then open it with the current backend.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-w02-old-"));
  try {
    const first = new SqliteBackend({ root: dir });
    await first.store(StoreInput.parse({ type: "fact", content: "legacy content" }));
    raw(first).exec("PRAGMA foreign_keys = OFF");
    // Rebuild the table without the new columns, preserving the row AND the primary
    // key. `CREATE TABLE ... AS SELECT` copies no key or constraint, which leaves
    // memory_audit/memory_versions referencing a parent SQLite no longer recognises --
    // so the key is re-declared explicitly.
    raw(first).exec(`
      CREATE TABLE memories_old (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'global',
        tenant_id TEXT, project_id TEXT, user_id TEXT, agent_id TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        importance INTEGER NOT NULL DEFAULT 3,
        confidence REAL NOT NULL DEFAULT 1.0,
        trust TEXT NOT NULL DEFAULT 'trusted',
        provenance TEXT NOT NULL,
        owner TEXT NOT NULL DEFAULT 'global',
        access TEXT NOT NULL DEFAULT 'global',
        valid_from TEXT, valid_until TEXT, observed_at TEXT, superseded_by TEXT,
        meta TEXT, retention TEXT, relations TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        last_seen TEXT, archived_at TEXT, embedding BLOB
      );
      INSERT INTO memories_old
        SELECT id, type, content, scope, tenant_id, project_id, user_id, agent_id, tags,
               importance, confidence, trust, provenance, owner, access, valid_from,
               valid_until, observed_at, superseded_by, meta, retention, relations,
               version, created_at, updated_at, last_seen, archived_at, embedding
        FROM memories;
    `);
    raw(first).exec("DROP TABLE memories");
    raw(first).exec("ALTER TABLE memories_old RENAME TO memories");
    raw(first).exec("PRAGMA foreign_keys = ON");
    first.close();

    // Reopen: the migration must add the columns and keep the row.
    const second = new SqliteBackend({ root: dir });
    const names = columns(second);
    assert.ok(names.includes("sensitivity"), "migration adds sensitivity");
    assert.ok(names.includes("legal_hold"), "migration adds legal_hold");
    const all = await second.all();
    assert.equal(all.length, 1, "the existing row survives");
    assert.equal(all[0].content, "legacy content", "with its content intact");
    second.close();
  } finally {
    await cleanup(dir);
  }
});

test("V6-W02-004: a migrated row defaults to the permissive value", async () => {
  // The default matters more than it looks. A row migrated with sensitivity
  // defaulting to anything but the most permissive band would silently vanish from
  // retrieval for a principal whose clearance does not reach it.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-w02-def-"));
  try {
    const store = new SqliteBackend({ root: dir });
    await store.store(StoreInput.parse({ type: "fact", content: "default row" }));
    const db = raw(store);
    const row = db.prepare("SELECT sensitivity, legal_hold FROM memories LIMIT 1").get();
    assert.equal(row.legal_hold, 0, "not held by default");
    assert.equal(
      String(row.sensitivity),
      "public",
      "the most permissive band, so an existing row is never silently hidden",
    );
    store.close();
  } finally {
    await cleanup(dir);
  }
});

test("V6-W02-005: sensitivity is constrained to its vocabulary", async () => {
  const { store, dir } = await tempSqlite();
  try {
    assert.throws(
      () => store.store(StoreInput.parse({ type: "fact", content: "a", sensitivity: "top-secret" }) as never),
      /sensitivity|invalid|enum/i,
      "an undeclared sensitivity is refused rather than stored",
    );
  } finally {
    store.close();
    await cleanup(dir);
  }
});

// --- the predicate now names real columns ------------------------------------

test("V6-W02-006: the predicate's SQL runs against the real table", async () => {
  // The property that makes W-02 more than a schema change: the predicate T07 emits
  // must be executable SQL against `memories`. Before this, every column it named was
  // fictional, so the clause had never once been run.
  const { store, dir } = await tempSqlite();
  try {
    const db = raw(store);
    const predicate = buildV6Predicate(context(), { now: 1_000 });
    // If a column is missing, prepare() throws -- that is the assertion.
    const rows = db
      .prepare(`SELECT id FROM memories m WHERE ${predicate.sql}`)
      .all(...predicate.params);
    assert.ok(Array.isArray(rows), "the predicate is executable SQL");
  } finally {
    store.close();
    await cleanup(dir);
  }
});

test("V6-W02-007: the predicate no longer references expires_at", () => {
  const predicate = buildV6Predicate(context(), { now: 1_000 });
  assert.equal(predicate.sql.includes("expires_at"), false,
    "expiry is valid_until; a second column would be a second source of truth");
  assert.ok(predicate.sql.includes("valid_until"), "and the real column is used");
});

test("V6-W02-008: the sensitivity clause uses the column, not a rank", () => {
  // T07's original predicate compared `sensitivity_rank <= ?`. Storing the band name
  // (readable, checkable by the schema) beats storing a derived integer that can drift
  // from the vocabulary. The ordered comparison happens in SQL over the band name.
  const predicate = buildV6Predicate(context(), { now: 1_000 });
  assert.equal(predicate.sql.includes("sensitivity_rank"), false, "no derived rank column");
  assert.ok(predicate.sql.includes("sensitivity"), "the declared band is compared");
});

test("V6-W02-009: a held row is excluded by the predicate, and a normal one is not", async () => {
  const { store, dir } = await tempSqlite();
  try {
    const db = raw(store);
    const plain = await store.store(StoreInput.parse({ type: "fact", content: "plain" }), undefined, { organizationId: "org-a", projectId: "p1" });
    const held = await store.store(StoreInput.parse({ type: "fact", content: "held" }), undefined, { organizationId: "org-a", projectId: "p1" });
    db.prepare("UPDATE memories SET legal_hold = 1 WHERE id = ?").run(held.id);

    const predicate = buildV6Predicate(context(), { now: 1_000 });
    const rows = db.prepare(`SELECT id FROM memories m WHERE ${predicate.sql}`).all(...predicate.params);
    const ids = rows.map((r) => r.id);
    assert.ok(ids.includes(plain.id), "a normal row is a candidate");
    assert.equal(ids.includes(held.id), false, "a held row is not a retrieval candidate");
  } finally {
    store.close();
    await cleanup(dir);
  }
});

test("V6-W02-010: sensitivity actually excludes at query time", async () => {
  const { store, dir } = await tempSqlite();
  try {
    const db = raw(store);
    const secret = await store.store(StoreInput.parse({ type: "fact", content: "secret" }), undefined, { organizationId: "org-a", projectId: "p1" });
    const open = await store.store(StoreInput.parse({ type: "fact", content: "open" }), undefined, { organizationId: "org-a", projectId: "p1" });
    db.prepare("UPDATE memories SET sensitivity = ? WHERE id = ?").run("secret", secret.id);
    db.prepare("UPDATE memories SET sensitivity = ? WHERE id = ?").run("public", open.id);

    // A public-clearance principal must not see the secret row.
    const low = buildV6Predicate(context("public"), { now: 1_000 });
    const lowRows = db.prepare(`SELECT id FROM memories m WHERE ${low.sql}`).all(...low.params).map((r) => r.id);
    assert.equal(lowRows.includes(secret.id), false, "a secret row is invisible at public clearance");
    assert.ok(lowRows.includes(open.id), "while a public row is visible");

    // And a secret-clearance principal sees both.
    const high = buildV6Predicate(context("secret"), { now: 1_000 });
    const highRows = db.prepare(`SELECT id FROM memories m WHERE ${high.sql}`).all(...high.params).map((r) => r.id);
    assert.ok(highRows.includes(secret.id), "secret clearance sees the secret row");
  } finally {
    store.close();
    await cleanup(dir);
  }
});

test("V6-W02-011: an expired row is excluded by the predicate via valid_until", async () => {
  const { store, dir } = await tempSqlite();
  try {
    const db = raw(store);
    const dead = await store.store(StoreInput.parse({
      type: "fact",
      content: "dead",
      validUntil: new Date(500).toISOString(),
    }), undefined, { organizationId: "org-a", projectId: "p1" });
    const live = await store.store(StoreInput.parse({ type: "fact", content: "live" }), undefined, { organizationId: "org-a", projectId: "p1" });
    const predicate = buildV6Predicate(context(), { now: 1_000 });
    const ids = db.prepare(`SELECT id FROM memories m WHERE ${predicate.sql}`).all(...predicate.params).map((r) => r.id);
    assert.equal(ids.includes(dead.id), false, "an expired row is not a candidate");
    assert.ok(ids.includes(live.id), "a row with no expiry is");
  } finally {
    store.close();
    await cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// Added after mutation testing. Three of fourteen SURVIVED, and all three are the
// same contract: a column DEFAULT. That is the most dangerous thing in this task,
// because a stricter default hides every existing row on upgrade and nothing about
// the failure looks wrong -- the corpus is simply gone.
// ---------------------------------------------------------------------------

test("V6-W02-012: the sensitivity column default is the most permissive band", async () => {
  // S1 survived: EX-004 checked a row written through `store()`, which goes through
  // the INSERT's explicit values -- so the COLUMN default was never exercised. A row
  // that arrives without naming the column is the only thing a default governs.
  const { store, dir } = await tempSqlite();
  try {
    const db = raw(store);
    // Bypass the INSERT entirely: this is what an upgrade or an external writer does.
    db.exec(
      "INSERT INTO memories (id, type, content, scope, tags, importance, confidence, trust, provenance, version, created_at, updated_at)" +
      " VALUES ('m-default', 'fact', 'default row', 'global', '[]', 3, 1.0, 'trusted', '{}', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
    );
    const row = db.prepare("SELECT sensitivity, legal_hold FROM memories WHERE id = ?").get("m-default");
    assert.equal(String(row.sensitivity), "public",
      "the column default must be the most permissive band, or an upgrade silently hides the corpus");
    assert.equal(Number(row.legal_hold), 0, "and a hold is not applied by default");
  } finally {
    store.close();
    await cleanup(dir);
  }
});

test("V6-W02-013: the migrated schema's DEFAULT clause is permissive too", async () => {
  // S3 survived for the same reason. The ALTER TABLE default is what every existing
  // row receives on upgrade, so it is the one that decides whether a tenant wakes up
  // to an empty corpus. Read it from the schema rather than trusting the INSERT path.
  const { store, dir } = await tempSqlite();
  try {
    const defs = raw(store).prepare("PRAGMA table_info(memories)").all();
    const byName = new Map(defs.map((d) => [String(d.name), d]));
    const sensitivity = byName.get("sensitivity");
    const legalHold = byName.get("legal_hold");
    assert.ok(sensitivity, "the column exists");
    assert.ok(legalHold, "the column exists");
    assert.equal(String(sensitivity.dflt_value), "'public'",
      "the schema default must be the most permissive band");
    assert.equal(String(legalHold.dflt_value), "0", "and a hold must not be applied by default");
  } finally {
    store.close();
    await cleanup(dir);
  }
});

test("V6-W02-014: a migrated row reads back permissively through the public API", async () => {
  // S4 survived: the read-path fallback (`asStr(row.sensitivity)` -> "public") was
  // never reached, because every fixture row had the column populated by the INSERT.
  // Force the NULL case the fallback exists for: a row from before the migration.
  // The column is NOT NULL, so the read fallback is reachable only on a database that
  // predates the column -- and there the ALTER TABLE supplies the value. A hand-set
  // NULL is impossible, which is exactly why the fallback has to be exercised through
  // a real pre-migration table.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-w02-null-"));
  try {
    const first = new SqliteBackend({ root: dir });
    await first.store(StoreInput.parse({ type: "fact", content: "old row" }));
    raw(first).exec("PRAGMA foreign_keys = OFF");
    raw(first).exec(`
      CREATE TABLE pre_w02 (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, content TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'global',
        tenant_id TEXT, project_id TEXT, user_id TEXT, agent_id TEXT,
        tags TEXT NOT NULL DEFAULT '[]', importance INTEGER NOT NULL DEFAULT 3,
        confidence REAL NOT NULL DEFAULT 1.0, trust TEXT NOT NULL DEFAULT 'trusted',
        provenance TEXT NOT NULL, owner TEXT NOT NULL DEFAULT 'global',
        access TEXT NOT NULL DEFAULT 'global',
        valid_from TEXT, valid_until TEXT, observed_at TEXT, superseded_by TEXT,
        meta TEXT, retention TEXT, relations TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        last_seen TEXT, archived_at TEXT, embedding BLOB
      );
      INSERT INTO pre_w02
        SELECT id, type, content, scope, tenant_id, project_id, user_id, agent_id, tags,
               importance, confidence, trust, provenance, owner, access, valid_from,
               valid_until, observed_at, superseded_by, meta, retention, relations,
               version, created_at, updated_at, last_seen, archived_at, embedding
        FROM memories;
      DROP TABLE memories;
      ALTER TABLE pre_w02 RENAME TO memories;
    `);
    raw(first).exec("PRAGMA foreign_keys = ON");
    first.close();

    const second = new SqliteBackend({ root: dir });
    const all = await second.all();
    assert.equal(all.length, 1);
    assert.equal(all[0].sensitivity, "public",
      "a row migrated from a pre-W-02 table reads back as the most permissive band");
    assert.equal(all[0].legalHold, false, "and as not-held");
    second.close();
  } finally {
    await cleanup(dir);
  }
});

test("V6-W02-015: an out-of-vocabulary sensitivity reads back as the most permissive band", async () => {
  // S4's read-path fallback. My first attempt here used a NULL, which cannot happen --
  // the column is NOT NULL with a default, so the migration always populates it -- and
  // the mutation "survived" for that reason rather than because the guard was untested.
  //
  // The reachable case is a value OUTSIDE the vocabulary: the schema CHECK can be
  // bypassed by an older writer, an external tool, or `PRAGMA ignore_check_constraints`.
  // A band the reader does not recognise must resolve permissively, or an unrecognised
  // value silently hides a row from everyone.
  const { store, dir } = await tempSqlite();
  try {
    const row = await store.store(
      StoreInput.parse({ type: "fact", content: "ordinary" }),
      undefined,
      { organizationId: "org-a", projectId: "p1" },
    );
    const db = raw(store);
    db.exec("PRAGMA ignore_check_constraints = ON");
    db.prepare("UPDATE memories SET sensitivity = ? WHERE id = ?").run("bogus-band", row.id);

    const read = await store.get(row.id, { organizationId: "org-a", projectId: "p1" });
    assert.equal(read?.sensitivity, "public",
      "an unrecognised band resolves permissively, never to the strictest");
    assert.equal(read?.legalHold, false);
  } finally {
    store.close();
    await cleanup(dir);
  }
});
