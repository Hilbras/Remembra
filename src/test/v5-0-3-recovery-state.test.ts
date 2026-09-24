import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileRecoveryStateStore } from "../recovery-state-store.js";
import { MemoryService } from "../service.js";
import { MemoryStore } from "../store.js";

async function temporaryRoot(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("REC-CRASH-001: recovery state is atomically persisted and survives restart", async () => {
  const root = await temporaryRoot("remembra-v503-recovery-state-");
  const statePath = path.join(root, ".recovery-state.json");
  const firstStore = new MemoryStore(root);
  const first = new MemoryService(firstStore, {
    embeddingProvider: "none",
    recoveryStateStore: new FileRecoveryStateStore(statePath),
  });
  try {
    await first.initializeRecovery();
    await first.enterReadOnly();
    assert.equal((await first.health()).state, "ReadOnly");
  } finally {
    await first.shutdownBackgroundJobs();
  }

  const secondStore = new MemoryStore(root);
  const second = new MemoryService(secondStore, {
    embeddingProvider: "none",
    recoveryStateStore: new FileRecoveryStateStore(statePath),
  });
  try {
    await second.initializeRecovery();
    assert.equal((await second.health()).state, "ReadOnly");
    await assert.rejects(
      () => second.store({ type: "fact", content: "blocked after restart" }),
      (error: unknown) => (error as { code?: string }).code === "SERVICE_UNAVAILABLE",
    );
    await second.verifyRecovery();
    assert.equal((await second.health()).state, "Healthy");
    await second.store({ type: "fact", content: "allowed after verification" });
  } finally {
    await second.shutdownBackgroundJobs();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("REC-CRASH-001: recovery state refuses symlinked storage paths", async () => {
  const root = await temporaryRoot("remembra-v503-recovery-link-");
  const outside = await temporaryRoot("remembra-v503-recovery-outside-");
  await fs.symlink(outside, path.join(root, "linked"));
  const stateStore = new FileRecoveryStateStore(path.join(root, "linked", ".recovery-state.json"));
  try {
    await assert.rejects(
      () => stateStore.write("ReadOnly", "read_only"),
      (error: unknown) => (error as { code?: string }).code === "SERVICE_UNAVAILABLE",
    );
    await assert.rejects(
      () => stateStore.read(),
      (error: unknown) => (error as { code?: string }).code === "SERVICE_UNAVAILABLE",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("REC-CRASH-001: a backend health failure is durably recorded as Failed", async () => {
  const root = await temporaryRoot("remembra-v503-recovery-health-failure-");
  const statePath = path.join(root, ".recovery-state.json");
  const firstBackend = new MemoryStore(root);
  const first = new MemoryService(firstBackend, {
    embeddingProvider: "none",
    recoveryStateStore: new FileRecoveryStateStore(statePath),
  });
  try {
    await first.initializeRecovery();
    (firstBackend as unknown as { all: () => Promise<unknown> }).all = async () => {
      throw new Error("injected backend read failure");
    };
    const health = await first.health();
    assert.equal(health.status, "unready");
    assert.equal(health.state, "Failed");
  } finally {
    await first.shutdownBackgroundJobs();
  }
  const second = new MemoryService(new MemoryStore(root), {
    embeddingProvider: "none",
    recoveryStateStore: new FileRecoveryStateStore(statePath),
  });
  try {
    await second.initializeRecovery();
    assert.equal((await second.health()).state, "Failed");
  } finally {
    await second.shutdownBackgroundJobs();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("REC-FAIL-001: a recovery-state persistence failure fails closed", async () => {
  const root = await temporaryRoot("remembra-v503-recovery-write-failure-");
  const service = new MemoryService(new MemoryStore(root), {
    embeddingProvider: "none",
    recoveryStateStore: {
      read: async () => "Healthy",
      write: async () => {
        throw new Error("injected state write failure");
      },
    },
  });
  try {
    await service.initializeRecovery();
    await assert.rejects(
      () => service.enterReadOnly(),
      (error: unknown) => (error as { code?: string }).code === "SERVICE_UNAVAILABLE",
    );
    await assert.rejects(
      () => service.store({ type: "fact", content: "must remain blocked" }),
      (error: unknown) => (error as { code?: string }).code === "SERVICE_UNAVAILABLE",
    );
  } finally {
    await service.shutdownBackgroundJobs();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("REC-CRASH-001: the operator verify command can recover a persisted Failed state", async () => {
  const root = await temporaryRoot("remembra-v503-recovery-cli-");
  const statePath = path.join(root, ".recovery-state.json");
  await fs.writeFile(statePath, JSON.stringify({
    format: "remembra-recovery-state",
    version: 1,
    state: "Failed",
    event: "failed",
    updatedAt: new Date().toISOString(),
  }), "utf8");
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve("dist/index.js"), "recover", "verify"], {
      env: {
        ...process.env,
        REMEMBRA_HOME: root,
        REMEMBRA_TENANT_MODE: "legacy",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
  try {
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /"state":"Healthy"/);
    const persisted = JSON.parse(await fs.readFile(statePath, "utf8")) as { state: string };
    assert.equal(persisted.state, "Healthy");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("REC-STATE-001: explicit verification preserves an observable fallback state", async () => {
  const root = await temporaryRoot("remembra-v503-recovery-fallback-");
  const service = new MemoryService(new MemoryStore(root), {
    embeddingProvider: "none",
    backend: "file",
    backendFallback: true,
  });
  try {
    await service.enterReadOnly();
    await service.verifyRecovery();
    assert.equal((await service.health()).state, "Degraded");
    await service.store({ type: "fact", content: "fallback remains writable after verification" });
  } finally {
    await service.shutdownBackgroundJobs();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("REC-CRASH-001: malformed durable recovery state fails closed", async () => {
  const root = await temporaryRoot("remembra-v503-recovery-corrupt-");
  const statePath = path.join(root, ".recovery-state.json");
  await fs.writeFile(statePath, "{not-json", "utf8");
  const stateStore = new FileRecoveryStateStore(statePath);
  try {
    await assert.rejects(
      () => stateStore.read(),
      (error: unknown) => (error as { code?: string }).code === "SERVICE_UNAVAILABLE",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
