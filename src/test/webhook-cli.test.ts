import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileWebhookDeliveryStore, verifyWebhookSignature } from "../webhooks.js";

const SECRET = "4d".repeat(32);

interface Delivery {
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function runCli(args: string[], env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve("dist/index.js"), ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** Loopback receiver standing in for a subscriber endpoint. */
async function startReceiver(): Promise<{ server: Server; deliveries: Delivery[]; url: string; close: () => Promise<void> }> {
  const deliveries: Delivery[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      deliveries.push({ headers: request.headers, body: Buffer.concat(chunks).toString("utf8") });
      response.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("receiver did not bind");
  return {
    server,
    deliveries,
    url: `http://127.0.0.1:${address.port}/hook`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function baseEnv(root: string, url: string): Record<string, string> {
  return {
    REMEMBRA_HOME: root,
    REMEMBRA_TENANT_MODE: "legacy",
    REMEMBRA_EMBEDDINGS: "none",
    REMEMBRA_LLM: "ollama",
    REMEMBRA_WEBHOOKS: JSON.stringify([
      { id: "sub-1", url, secret: SECRET, events: ["snapshot.created", "snapshot.restored", "memory.created"] },
    ]),
  };
}

test("WEBHOOK-CLI-001: a one-shot CLI command delivers its queued event with a valid signature", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-webhook-cli-"));
  const receiver = await startReceiver();
  try {
    const seed = await runCli(["maintain"], {
      REMEMBRA_HOME: root,
      REMEMBRA_TENANT_MODE: "legacy",
      REMEMBRA_EMBEDDINGS: "none",
      REMEMBRA_LLM: "ollama",
    });
    assert.equal(seed.code, 0, seed.stderr);

    const exported = path.join(root, "export.json");
    const result = await runCli(["export", exported], baseEnv(root, receiver.url));
    assert.equal(result.code, 0, result.stderr);
    assert.equal((await fs.stat(exported)).isFile(), true);

    // The export queued snapshot.created and delivered it before exiting.
    assert.equal(receiver.deliveries.length, 1, "a one-shot command drains what it queued");
    const delivery = receiver.deliveries[0];
    const event = JSON.parse(delivery.body) as { type: string; data: Record<string, unknown> };
    assert.equal(event.type, "snapshot.created");
    assert.equal(Object.keys(event.data).sort().join(","), "count,exportedAt,organizationId");

    const signature = delivery.headers["x-remembra-signature"];
    assert.equal(typeof signature, "string");
    const verified = verifyWebhookSignature(Buffer.from(SECRET, "hex"), String(signature), delivery.body, {
      toleranceMs: 5 * 60_000,
    });
    assert.deepEqual(verified, { ok: true });
    assert.equal(delivery.headers["x-remembra-event"], "snapshot.created");
    assert.equal(typeof delivery.headers["x-remembra-delivery"], "string");

    // A tampered body must not verify, so the signature is load-bearing.
    assert.equal(verifyWebhookSignature(Buffer.from(SECRET, "hex"), String(signature), `${delivery.body} `, {}).ok, false);
  } finally {
    await receiver.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("WEBHOOK-CLI-005: --version and --help answer without configuration or side effects", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-version-flag-"));
  const root = path.join(parent, "never-created");
  try {
    for (const flag of ["--version", "-v"]) {
      const result = await runCli([flag], {
        REMEMBRA_HOME: root,
        REMEMBRA_TENANT_MODE: "strict",
        REMEMBRA_EMBEDDINGS: "none",
        REMEMBRA_LLM: "ollama",
      });
      assert.equal(result.code, 0, `${flag} must succeed: ${result.stderr}`);
      assert.equal(result.stdout.trim(), "5.4.0");
      assert.equal(await fs.stat(root).then(() => true, () => false), false, `${flag} must not create a data directory`);
    }

    const help = await runCli(["--help"], {
      REMEMBRA_HOME: root,
      REMEMBRA_TENANT_MODE: "legacy",
      REMEMBRA_EMBEDDINGS: "none",
      REMEMBRA_LLM: "ollama",
    });
    assert.equal(help.code, 0, help.stderr);
    assert.match(help.stdout, /remembra --version/);
    assert.match(help.stdout, /recover verify/);
    // A strict-mode misconfiguration must not break an informational flag.
    const strictHelp = await runCli(["--help"], {
      REMEMBRA_HOME: root,
      REMEMBRA_TENANT_MODE: "strict",
      REMEMBRA_EMBEDDINGS: "none",
      REMEMBRA_LLM: "ollama",
    });
    assert.equal(strictHelp.code, 0, strictHelp.stderr);
    assert.equal(await fs.stat(root).then(() => true, () => false), false);
  } finally {
    await fs.rm(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("WEBHOOK-CLI-004: an import dry run writes nothing and drains nothing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-webhook-cli-dry-"));
  const receiver = await startReceiver();
  try {
    const snapshot = path.join(root, "seed.json");
    await fs.writeFile(
      snapshot,
      JSON.stringify({
        format: "remembra-export",
        version: 3,
        exportedAt: new Date().toISOString(),
        memories: [{
          id: "32345678-1234-4234-8234-123456789abc",
          type: "fact",
          content: "dry run must not deliver",
          scope: "global",
          tags: [],
          importance: 3,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }],
      }),
      "utf8",
    );
    const env = baseEnv(root, receiver.url);
    const dryRun = await runCli(["import", snapshot, "--dry-run"], env);
    assert.equal(dryRun.code, 0, dryRun.stderr);
    assert.match(dryRun.stdout, /Import dry-run: 1 would import/);
    assert.equal(receiver.deliveries.length, 0, "a dry run queues and delivers nothing");

    const applied = await runCli(["import", snapshot], env);
    assert.equal(applied.code, 0, applied.stderr);
    assert.equal(receiver.deliveries.length, 1, "the real import delivers its event");
    assert.equal((JSON.parse(receiver.deliveries[0].body) as { type: string }).type, "snapshot.restored");
  } finally {
    await receiver.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("WEBHOOK-CLI-002: an invalid webhook configuration fails startup closed", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-webhook-cli-bad-"));
  try {
    for (const value of [
      "not json",
      JSON.stringify([{ id: "x", url: "http://hooks.example.test/x", secret: SECRET, events: ["memory.created"] }]),
      JSON.stringify([{ id: "x", url: "https://h.test/x", secret: "short", events: ["memory.created"] }]),
    ]) {
      const result = await runCli(["maintain"], {
        REMEMBRA_HOME: root,
        REMEMBRA_TENANT_MODE: "legacy",
        REMEMBRA_EMBEDDINGS: "none",
        REMEMBRA_LLM: "ollama",
        REMEMBRA_WEBHOOKS: value,
      });
      assert.notEqual(result.code, 0, `expected failure for: ${value}`);
      assert.match(result.stderr, /REMEMBRA_WEBHOOKS/, `the failing variable must be named: ${result.stderr}`);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("WEBHOOK-CLI-003: delivery state is durable when a subscriber is unreachable", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-webhook-cli-offline-"));
  // Port 1 on loopback refuses connections, so the delivery is retried and left queued.
  const offline = "http://127.0.0.1:1/hook";
  try {
    const first = await runCli(["export", path.join(root, "a.json")], baseEnv(root, offline));
    assert.equal(first.code, 0, "an undeliverable webhook must not fail the command");

    // A fresh process can still see the queued event, so nothing was lost.
    const store = new FileWebhookDeliveryStore(path.join(root, ".webhooks"));
    try {
      const counts = store.counts();
      assert.equal(counts.pending, 1, "the event stays queued for the next process");
      assert.equal(counts.dead, 0);
    } finally {
      store.close();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
