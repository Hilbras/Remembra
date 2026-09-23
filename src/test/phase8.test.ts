import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { MemoryStore } from "../store.js";
import { MemoryService } from "../service.js";
import { createHttpServer } from "../http.js";
import { redact, redactionEnabled } from "../redact.js";
import { unifiedDiff } from "../diff.js";
import { isEncrypted } from "../crypto.js";
import { metrics } from "../metrics.js";
import { RemembraError } from "../errors.js";
import type { ExtractedMemory } from "../llm.js";
import type { Memory } from "../types.js";
import type http from "node:http";

async function tempStore(): Promise<{ store: MemoryStore; root: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-p8-"));
  return { store: new MemoryStore(root), root };
}

const storeInput = (content: string, extra: Record<string, unknown> = {}) =>
  ({ type: "fact", content, scope: "global", tags: [], importance: 3, ...extra }) as never;

function withEnv(vars: Record<string, string | undefined>): () => void {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

async function startServer(svc: MemoryService): Promise<{ server: http.Server; base: string }> {
  const server = createHttpServer(svc, { port: 0, host: "127.0.0.1" });
  await new Promise<void>((r) => server.once("listening", () => r()));
  return { server, base: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

// --- PII redaction (opt-in REMEMBRA_REDACT) ---

test("redact: emails, SSN, Luhn-valid cards, phones, secrets → typed placeholders", () => {
  const r = redact(
    "Mail jane.doe+x@corp.example.com or call +1 (415) 555-0142. " +
      "Card 4111 1111 1111 1111 expires 12/28, SSN 123-45-6789, key sk-abcd1234efgh5678ijkl.",
  );
  assert.ok(r.text.includes("<EMAIL>"));
  assert.ok(r.text.includes("<PHONE>"));
  assert.ok(r.text.includes("<CARD>"));
  assert.ok(r.text.includes("<SSN>"));
  assert.ok(r.text.includes("<SECRET>"));
  assert.ok(!r.text.includes("jane.doe"));
  assert.ok(!r.text.includes("4111"));
  assert.equal(r.counts.email, 1);
  assert.equal(r.counts.card, 1);
  assert.equal(r.counts.ssn, 1);
  assert.ok(r.changed);
});

test("redact: false positives guarded — Luhn rejects fake cards, dates/versions untouched", () => {
  const r = redact("Released 2026-09-23 as version 3.8.0 of the app; id 1234-56-7890123 is not a card.");
  assert.equal(r.changed, false, `unexpected redaction: ${r.text}`);
  // Dashed group that fails Luhn: not a card either.
  const r2 = redact("ref 1111-1111-1111-1118");
  assert.ok(!r2.text.includes("<CARD>"), "Luhn failure must not redact");
  // Luhn-valid long number IS redacted.
  const r3 = redact("ref 4111111111111111");
  assert.equal(r3.counts.card, 1);
});

test("redact: high-entropy 40+ blobs become <SECRET> but ordinary words don't", () => {
  const r = redact("hash a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2 and word supercalifragilisticexpialidocious");
  assert.ok(r.text.includes("a1b2c3d4") === false, "blob redacted");
  assert.ok(r.text.includes("supercalifragilisticexpialidocious"), "megaword without digits survives");
});

test("redaction is OFF by default and ON via the service flag", async () => {
  const { store } = await tempStore();
  const plain = new MemoryService(store, { embeddingProvider: "none" });
  const r1 = await plain.store(storeInput("contact: jane@example.com"));
  assert.ok(r1.memory.content.includes("jane@example.com"), "default: no redaction");
  assert.equal(redactionEnabled(), false, "env unset in test runner");

  const clean = new MemoryService(store, { embeddingProvider: "none", redact: true });
  metrics.reset();
  const r2 = await clean.store(storeInput("contact: jane@example.com", { tags: ["jane@example.com"] }));
  assert.ok(r2.memory.content.includes("<EMAIL>"), `got: ${r2.memory.content}`);
  assert.ok(r2.memory.tags[0] === "<EMAIL>", "tags redacted too");
  assert.ok((metrics.get("remembra_redactions_total", { kind: "email" }) ?? 0) >= 2);
});

test("digest: extracted items are redacted; confidence passes through", async () => {
  const { store } = await tempStore();
  const items: ExtractedMemory[] = [
    { type: "fact", content: "escalation contact is jane@example.com", tags: [], importance: 3, confidence: 0.4 },
    { type: "fact", content: "standup moved to 09:30 CET", tags: [], importance: 3 },
  ];
  const svc = new MemoryService(store, {
    embeddingProvider: "none",
    redact: true,
    extractFn: async () => items,
    mergeFn: async () => ({ action: "store" }),
  });
  const result = await svc.digest({ transcript: "ignored — extractFn injected" });
  assert.equal(result.stored.length, 2);
  const withEmail = result.stored.find((m) => m.content.includes("escalation"));
  const plain = result.stored.find((m) => m.content.includes("standup"));
  assert.ok(withEmail && withEmail.content.includes("<EMAIL>"), `got: ${withEmail?.content}`);
  assert.equal(withEmail?.confidence, 0.4, "LLM-provided confidence kept");
  assert.equal(plain?.confidence, 0.7, "auto default confidence");
});

// --- confidence scores ---

test("confidence: explicit stores default to 1.0 and round-trip through frontmatter", async () => {
  const { store, root } = await tempStore();
  const svc = new MemoryService(store, { embeddingProvider: "none" });
  const { memory } = await svc.store(storeInput("the answer is forty-two"));
  assert.equal(memory.confidence, 1.0);

  const fresh = new MemoryStore(root); // reparse from disk, no cache
  const loaded = await fresh.get(memory.id);
  assert.equal(loaded?.confidence, 1.0);

  const explicit = await svc.store(storeInput("probably true", { confidence: 0.55 }));
  assert.equal(explicit.memory.confidence, 0.55, "caller-provided confidence wins");
});

// --- relationship graph ---

test("relate: add/remove links, backlinks derived, validation on self and missing", async () => {
  const { store } = await tempStore();
  const svc = new MemoryService(store, { embeddingProvider: "none" });
  const a = (await svc.store(storeInput("Use PostgreSQL for all new services"))).memory;
  const b = (await svc.store(storeInput("Migrations run through the schema-registry bot"))).memory;

  const linked = await svc.relate({ id: a.id, related: [b.id] });
  assert.deepEqual(linked.related, [b.id]);
  assert.deepEqual(linked.added, [b.id]);

  const viewA = await svc.get(a.id);
  assert.equal(viewA.related.length, 1);
  assert.equal(viewA.related[0].id, b.id);
  const viewB = await svc.get(b.id);
  assert.deepEqual(
    viewB.backlinks.map((x) => x.id),
    [a.id],
    "backlinks derived without a second write",
  );

  const again = await svc.relate({ id: a.id, related: [b.id] });
  assert.deepEqual(again.added, [], "idempotent add is a no-op");

  await assert.rejects(() => svc.relate({ id: a.id, related: [a.id] }), (e: RemembraError) => e.code === "INVALID_INPUT");
  await assert.rejects(
    () => svc.relate({ id: a.id, related: ["ffffffffffff"] }),
    (e: RemembraError) => e.code === "NOT_FOUND",
  );
  await assert.rejects(
    () => svc.relate({ id: "ffffffffffff", related: [b.id] }),
    (e: RemembraError) => e.code === "NOT_FOUND",
  );

  const unlinked = await svc.relate({ id: a.id, related: [b.id], action: "remove" });
  assert.deepEqual(unlinked.related, []);
  assert.equal((await svc.get(b.id)).backlinks.length, 0);
});

test("relate: links persist across instances and do not snapshot history", async () => {
  const { store, root } = await tempStore();
  const svc = new MemoryService(store, { embeddingProvider: "none" });
  const a = (await svc.store(storeInput("fact one"))).memory;
  const b = (await svc.store(storeInput("fact two"))).memory;
  await svc.relate({ id: a.id, related: [b.id] });

  const fresh = new MemoryService(new MemoryStore(root), { embeddingProvider: "none" });
  assert.deepEqual((await fresh.get(a.id)).memory.related, [b.id]);
  assert.equal((await fresh.history({ id: a.id })).versions.length, 1, "linking changes no content");
});

// --- diff ---

test("diff: unified format with context, empty for identical inputs", () => {
  const d = unifiedDiff("alpha\nbeta\ngamma", "alpha\nBETA\ngamma");
  assert.ok(d.includes("--- previous"));
  assert.ok(d.includes("+++ current"));
  assert.ok(d.includes("@@"));
  assert.ok(d.includes("-beta"));
  assert.ok(d.includes("+BETA"));
  assert.equal(unifiedDiff("same", "same"), "");
});

// --- history (merge snapshots + view) ---

test("history: content-changing digest merge snapshots the pre-image with a line diff", async () => {
  const { store, root } = await tempStore();
  const oldContent =
    "deployment window is tuesday 02:00 UTC for the payments service cluster";
  const newContent =
    "deployment window is tuesday 02:00 UTC for the payments service cluster with rolling restarts enabled by default";
  await store.store(storeInput(oldContent));

  const svc = new MemoryService(store, {
    embeddingProvider: "none",
    redact: true,
    extractFn: async () => [{ type: "fact", content: newContent, tags: [], importance: 3 }],
    mergeFn: async (incoming) => ({
      action: "merge",
      content: `${incoming} — approved by the platform team; ping ceo@example.com`,
    }),
  });
  const result = await svc.digest({ transcript: "ignored" });
  assert.equal(result.merged, 1, "candidate must reach the merge path");

  const mem = (await store.all())[0];
  assert.ok(mem.content.includes("platform team"), "merged text stored");
  assert.ok(mem.content.includes("<EMAIL>"), `merge output redacted: ${mem.content}`);
  assert.ok(mem.content.includes("> superseded ("), "supersession note kept");

  // Pre-image exists on disk, but only the real memory counts in all().
  const hist = await new MemoryService(new MemoryStore(root), { embeddingProvider: "none" }).history({
    id: mem.id,
  });
  assert.equal(hist.versions.length, 2, "current + one snapshot");
  assert.equal(hist.versions[0].current, true);
  assert.equal(hist.versions[1].content, oldContent, "snapshot is the pre-image");
  assert.ok(hist.versions[0].diff.includes("-deployment window is tuesday"), "old line removed");
  assert.ok(hist.versions[0].diff.includes("+deployment window is tuesday"), "new line added");
  assert.ok(hist.text.includes(`History for ${mem.id}`));
  assert.equal((await store.all()).length, 1, ".history never leaks into all()");
});

test("history: embedding-only updates create no snapshots; REMEMBRA_HISTORY_LIMIT prunes", async () => {
  const { store } = await tempStore();
  const m = await store.store(storeInput("version zero"));
  // Content unchanged → no snapshot.
  await store.update({ ...m, embedding: [0.1, 0.2, 0.3] });
  assert.equal((await store.history(m.id)).length, 0, "backfill must not pollute history");

  const restore = withEnv({ REMEMBRA_HISTORY_LIMIT: "2" });
  try {
    let current: Memory = m;
    for (let i = 1; i <= 5; i++) {
      current = await store.update({ ...current, content: `version ${i}`, embedding: undefined });
    }
    const entries = await store.history(m.id);
    assert.equal(entries.length, 2, `pruned to 2, got ${entries.length}`);
    // Snapshots hold PRE-images: the newest pre-image is the state before v5.
    assert.equal(entries[0].content, "version 4", "newest snapshot kept");
    assert.equal(entries[1].content, "version 3");
    assert.equal((await store.get(m.id))?.content, "version 5", "current content unaffected");
  } finally {
    restore();
  }
});

// --- encrypted storage mode ---

test("encryption: ciphertext at rest, transparent round trip, plain files pass through", async () => {
  const { store, root } = await tempStore();
  const key = randomBytes(32).toString("hex");
  const restore = withEnv({ REMEMBRA_ENCRYPT_KEY: key });
  try {
    const svc = new MemoryService(store, { embeddingProvider: "none" });
    const { memory } = await svc.store(storeInput("the secret plaintext marker"));

    const raw = await fs.readFile(path.join(root, "global", `${memory.id}.md`));
    assert.ok(isEncrypted(raw), "file starts with magic header");
    assert.ok(!raw.includes(Buffer.from("secret plaintext marker")), "plaintext absent from disk");

    const fresh = new MemoryService(new MemoryStore(root), { embeddingProvider: "none" });
    const got = await fresh.get(memory.id);
    assert.equal(got.memory.content, "the secret plaintext marker", "decrypted on read");
    assert.equal((await fresh.search({ query: "plaintext" })).results.length, 1, "search works");
  } finally {
    restore();
  }
});

test("encryption: missing key fails loudly — reads reject, health goes 503", async () => {
  const { store, root } = await tempStore();
  const restoreKey = withEnv({ REMEMBRA_ENCRYPT_KEY: randomBytes(32).toString("hex") });
  const { memory } = await new MemoryService(store, { embeddingProvider: "none" }).store(
    storeInput("locked away fact"),
  );
  restoreKey();

  const fresh = new MemoryStore(root);
  await assert.rejects(() => fresh.get(memory.id), (e: RemembraError) => e.code === "ENCRYPTED_NO_KEY");
  await assert.rejects(() => fresh.all(), (e: RemembraError) => e.code === "ENCRYPTED_NO_KEY");

  const health = await new MemoryService(fresh, { embeddingProvider: "none" }).health();
  assert.equal(health.status, "unready");
  assert.equal(health.storage, "ENCRYPTED_NO_KEY", "readiness reports the real cause");
});

test("encryption: wrong key is indistinguishable from corruption (GCM auth fails)", async () => {
  const { store, root } = await tempStore();
  const restoreA = withEnv({ REMEMBRA_ENCRYPT_KEY: randomBytes(32).toString("hex") });
  const { memory } = await new MemoryService(store, { embeddingProvider: "none" }).store(
    storeInput("only keyA reads this"),
  );
  restoreA();

  const restoreB = withEnv({ REMEMBRA_ENCRYPT_KEY: randomBytes(32).toString("hex") });
  try {
    await assert.rejects(
      () => new MemoryStore(root).get(memory.id),
      (e: RemembraError) => e.code === "ENCRYPTED_NO_KEY",
    );
  } finally {
    restoreB();
  }
});

test("encryption: migrate encrypt/decrypt is idempotent and covers history too", async () => {
  const { store, root } = await tempStore();
  const key = randomBytes(32).toString("hex");
  const m1 = await store.store(storeInput("first plain memory"));
  const m2 = await store.store(storeInput("second plain memory"));

  // No key yet → migration refuses with a usage error.
  await assert.rejects(
    () => store.migrateEncryption("encrypt"),
    (e: RemembraError) => e.code === "INVALID_INPUT",
  );

  // Give m1 a history snapshot while STILL plain — migrate must convert the
  // whole tree (2 memories + 1 pre-image) from a fully-plain state.
  await store.update({ ...m1, content: "first memory, edited" });

  const restore = withEnv({ REMEMBRA_ENCRYPT_KEY: key });
  try {
    const enc = await store.migrateEncryption("encrypt");
    assert.equal(enc.converted, 3, "two memories + one snapshot");
    assert.equal(enc.skipped, 0);
    const again = await store.migrateEncryption("encrypt");
    assert.equal(again.converted, 0, "idempotent");
    assert.equal(again.skipped, 3);

    for (const f of [`${m1.id}.md`, `${m2.id}.md`]) {
      const raw = await fs.readFile(path.join(root, "global", f));
      assert.ok(isEncrypted(raw), `${f} encrypted`);
    }
    const histRaw = await fs.readFile(
      path.join(root, ".history", m1.id, (await fs.readdir(path.join(root, ".history", m1.id)))[0]),
    );
    assert.ok(isEncrypted(histRaw), "history snapshot encrypted too");

    // Reads still work (mixed-format decrypt path) — and decrypt restores plain.
    const dec = await store.migrateEncryption("decrypt");
    assert.equal(dec.converted, 3);
    const raw = await fs.readFile(path.join(root, "global", `${m1.id}.md`));
    assert.ok(!isEncrypted(raw));
    assert.ok(raw.includes(Buffer.from("first memory, edited")));
  } finally {
    restore();
  }
});

// --- HTTP surfaces for the new tools ---

test("http: GET /memories/:id, relate, and history routes", async () => {
  const { store } = await tempStore();
  const svc = new MemoryService(store, { embeddingProvider: "none" });
  const a = (await svc.store(storeInput("http graph memory a"))).memory;
  const b = (await svc.store(storeInput("http graph memory b"))).memory;
  await svc.relate({ id: a.id, related: [b.id] });
  // One content update so /history has something to show.
  await store.update({ ...(await store.get(a.id))!, content: "http graph memory a, v2" });

  const { server, base } = await startServer(svc);
  metrics.reset();
  try {
    const got = (await (await fetch(`${base}/memories/${a.id}`)).json()) as {
      memory: { content: string };
      related: { id: string }[];
    };
    assert.ok(got.memory.content.includes("v2"));
    assert.equal(got.related[0].id, b.id);

    const miss = await fetch(`${base}/memories/ffffffffffff`);
    assert.equal(miss.status, 404);

    const rel = await fetch(`${base}/memories/${b.id}/relate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ related: [a.id] }),
    });
    assert.equal(rel.status, 200);

    const hist = (await (await fetch(`${base}/memories/${a.id}/history`)).json()) as {
      versions: { diff: string }[];
    };
    assert.ok(hist.versions.length >= 2, "history route serves versions");
    assert.ok(hist.versions[0].diff.includes("+"), "with diffs");

    const self = await fetch(`${base}/memories/${a.id}/relate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ related: [a.id] }),
    });
    assert.equal(self.status, 400, "self-link rejected via HTTP too");

    assert.ok(
      (metrics.get("remembra_http_requests_total", { route: "memory_sub", method: "POST", status: 200 }) ?? 0) >= 1,
      "sub-routes get their own metric label",
    );
  } finally {
    server.close();
  }
});
