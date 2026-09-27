/**
 * V5.1.0 structured logging (roadmap §22): request and operation metadata on
 * every line, no raw queries, no secrets, and no unbounded tenant values.
 *
 * The interesting cases are the negatives — a query that must not appear, a
 * tenant that must not appear raw, a debug flag that must not unlock a data
 * dump — because the positives are just "the field is there".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyLogFieldPolicy,
  currentLogContext,
  isRestrictedLogField,
  logEvent,
  opaqueLogId,
  requestLogContext,
  withLogContext,
} from "../log.js";
import { MemoryService } from "../service.js";
import { MemoryStore } from "../store.js";
import { createHttpServer } from "../http.js";
import { createTenantContext } from "../tenant.js";
import type { TenantContext } from "../tenant.js";

async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => lines.push(String(args[0]));
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return lines.join("\n");
}

function withEnv(values: Record<string, string>): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

test("LOG-001: a log line carries the roadmap §22 standard fields", async () => {
  const restore = withEnv({ REMEMBRA_LOG: "json" });
  try {
    const output = await captureStderr(async () => {
      await withLogContext({ requestId: "req-1234", operation: "http.request" }, async () => {
        logEvent("info", "test.event", { durationMs: 42 });
      });
    });
    const event = JSON.parse(output) as Record<string, unknown>;
    assert.equal(event.ts !== undefined, true, "ts");
    assert.equal(event.level, "info", "level");
    assert.equal(event.event, "test.event", "event");
    assert.equal(event.requestId, "req-1234", "requestId");
    assert.equal(event.operation, "http.request", "operation");
    assert.equal(event.durationMs, 42, "durationMs");
  } finally {
    restore();
  }
});

test("LOG-002: the request context reaches code that knows nothing about it", async () => {
  const restore = withEnv({ REMEMBRA_LOG: "json" });
  try {
    // A deep callee with no request parameter, several awaits later.
    const deep = async (): Promise<void> => {
      await new Promise((r) => setTimeout(r, 1));
      logEvent("warn", "deep.event", {});
    };
    const output = await captureStderr(async () => {
      await withLogContext({ requestId: "req-deep", operation: "storage.write" }, deep);
    });
    const event = JSON.parse(output) as Record<string, unknown>;
    assert.equal(event.requestId, "req-deep", "context survives awaits");
    assert.equal(event.operation, "storage.write");
  } finally {
    restore();
  }
});

test("LOG-003: contexts nest and merge, and the inner one wins", async () => {
  const restore = withEnv({ REMEMBRA_LOG: "json" });
  try {
    const output = await captureStderr(async () => {
      await withLogContext({ requestId: "req-outer", operation: "http.request" }, async () => {
        await withLogContext({ operation: "job.run" }, async () => {
          logEvent("info", "nested.event", {});
        });
      });
    });
    const event = JSON.parse(output) as Record<string, unknown>;
    assert.equal(event.requestId, "req-outer", "the outer request id is inherited");
    assert.equal(event.operation, "job.run", "the inner operation wins");
  } finally {
    restore();
  }
});

test("LOG-004: an explicit field overrides the context for the same key", async () => {
  const restore = withEnv({ REMEMBRA_LOG: "json" });
  try {
    const output = await captureStderr(async () => {
      await withLogContext({ requestId: "req-ctx", operation: "http.request" }, async () => {
        logEvent("info", "override.event", { requestId: "req-explicit" });
      });
    });
    const event = JSON.parse(output) as Record<string, unknown>;
    assert.equal(event.requestId, "req-explicit", "a caller that knows better can override");
  } finally {
    restore();
  }
});

test("LOG-005: a raw query never reaches a log line by default", async () => {
  const restore = withEnv({ REMEMBRA_LOG: "json" });
  try {
    const output = await captureStderr(async () => {
      logEvent("debug", "search.event", { query: "my bank password is hunter2" });
    });
    assert.equal(output.includes("hunter2"), false, "the query text is not logged");
    assert.equal(output.includes("password"), false);
    const event = JSON.parse(output) as Record<string, unknown>;
    assert.equal(event.query, undefined, "the field is dropped, not emptied");
  } finally {
    restore();
  }
});

test("LOG-006: REMEMBRA_DEBUG is the documented opt-in, and nothing else is", async () => {
  const restore = withEnv({ REMEMBRA_LOG: "json" });
  try {
    // A different debug flag must not unlock a data dump.
    const withOtherFlag = withEnv({ REMEMBRA_DEBUG_RETRIEVAL: "1" });
    try {
      const output = await captureStderr(async () => {
        logEvent("debug", "search.event", { query: "sensitive search text" });
      });
      assert.equal(output.includes("sensitive search text"), false, "an unrelated flag is not consent");
    } finally {
      withOtherFlag();
    }

    const withDebug = withEnv({ REMEMBRA_DEBUG: "1" });
    try {
      const output = await captureStderr(async () => {
        logEvent("debug", "search.event", { query: "sensitive search text" });
      });
      assert.match(output, /sensitive search text/, "the documented opt-in still works");
    } finally {
      withDebug();
    }
  } finally {
    restore();
  }
});

test("LOG-007: a storage path is not logged by default", async () => {
  const restore = withEnv({ REMEMBRA_LOG: "json" });
  try {
    const output = await captureStderr(async () => {
      logEvent("info", "storage.event", { root: "/home/someone/.remembra", path: "/etc/passwd" });
    });
    assert.equal(output.includes("/home/someone"), false);
    assert.equal(output.includes("/etc/passwd"), false);
  } finally {
    restore();
  }
});

test("LOG-008: a tenant identifier is hashed, never logged raw", async () => {
  const restore = withEnv({ REMEMBRA_LOG: "json" });
  try {
    const output = await captureStderr(async () => {
      logEvent("info", "tenant.event", { tenantId: "acme-corporation-ltd", userId: "alice@example.com" });
    });
    assert.equal(output.includes("acme-corporation-ltd"), false, "no raw tenant id");
    assert.equal(output.includes("alice@example.com"), false, "no raw user id");
    const event = JSON.parse(output) as Record<string, unknown>;
    assert.equal(typeof event.tenantId, "string", "but a correlation value remains");
    assert.match(String(event.tenantId), /^[0-9a-f]{12}$/, "a short stable digest");
    assert.equal(typeof event.userId, "string", "identity is preserved for correlation");
    assert.notEqual(event.tenantId, event.userId, "and distinct identities stay distinct");
  } finally {
    restore();
  }
});

test("LOG-009: the same tenant hashes consistently, different tenants do not collide", () => {
  assert.equal(opaqueLogId("acme"), opaqueLogId("acme"), "stable across lines");
  assert.notEqual(opaqueLogId("acme"), opaqueLogId("acme-corp"), "distinct tenants stay distinct");
  assert.equal(opaqueLogId(""), undefined, "an absent value adds no field");
  assert.equal(opaqueLogId(undefined), undefined);
});

test("LOG-010: a request context never carries a raw identity", () => {
  const context = requestLogContext({
    requestId: "req-1",
    tenantOrganizationId: "acme-corporation-ltd",
    agentId: "agent-secret-name",
  });
  assert.equal(context.requestId, "req-1");
  assert.equal(context.tenantId !== "acme-corporation-ltd", true, "the organization is hashed");
  assert.equal(context.agentId !== "agent-secret-name", true, "the agent is hashed");
  assert.match(String(context.tenantId), /^[0-9a-f]{12}$/);
});

test("LOG-011: the field policy is a pure function of its input", () => {
  const input = { query: "x", tenantId: "acme", route: "memories", count: 3 };
  const output = applyLogFieldPolicy(input);
  assert.equal(output.query, undefined, "content is dropped");
  assert.match(String(output.tenantId), /^[0-9a-f]{12}$/, "identity is hashed");
  assert.equal(output.route, "memories", "ordinary fields pass through");
  assert.equal(output.count, 3);
  assert.equal(input.query, "x", "the input is not mutated");
  assert.equal(isRestrictedLogField("Query"), true, "matching ignores case and separators");
  assert.equal(isRestrictedLogField("Tenant_Id"), true);
  assert.equal(isRestrictedLogField("route"), false);
});

test("LOG-007b: a bare filename survives, because it is the whole diagnostic", async () => {
  const restore = withEnv({ REMEMBRA_LOG: "json" });
  try {
    // Regression: the field policy originally dropped `file` outright, which
    // silently removed the documented field of `memory_parse_skipped` and left
    // operators with an event that said a file was bad but not which one.
    const output = await captureStderr(async () => {
      logEvent("warn", "memory_parse_skipped", { file: "bad.md", reason: "missing frontmatter" });
    });
    const event = JSON.parse(output) as Record<string, unknown>;
    assert.equal(event.file, "bad.md", "a bare basename is not a disclosure");
    assert.equal(event.reason, "missing frontmatter");
  } finally {
    restore();
  }
});

test("LOG-007c: a path in a filename field is still refused", async () => {
  const restore = withEnv({ REMEMBRA_LOG: "json" });
  try {
    for (const bad of [
      "/home/someone/.remembra/secret.md",
      "../../etc/passwd",
      "sub/dir/name.md",
      "C:\\Users\\someone\\note.md",
      `${"a".repeat(200)}.md`,
    ]) {
      const output = await captureStderr(async () => {
        logEvent("warn", "path_in_filename", { file: bad });
      });
      const event = JSON.parse(output) as Record<string, unknown>;
      assert.equal(event.file, undefined, `${bad} must not reach a log line`);
    }
  } finally {
    restore();
  }
});

test("LOG-011b: the field policy is enforced at every depth, not just the top level", async () => {
  const restore = withEnv({ REMEMBRA_LOG: "json" });
  try {
    // Regression: the policy originally inspected only top-level keys, so
    // `{ details: { path: "..." } }` bypassed it completely.
    const output = await captureStderr(async () => {
      logEvent("warn", "nested.event", {
        nested: { path: "/home/someone/x", query: "my password is hunter2", tenantId: "acme-corp" },
        deep: { a: { b: { c: { path: "/home/someone/y" } } } },
        items: [{ path: "/home/someone/z" }, { file: "ok.md" }],
      });
    });
    const event = JSON.parse(output) as Record<string, unknown>;
    assert.equal(output.includes("/home/someone"), false, "no path survives at any depth");
    assert.equal(output.includes("hunter2"), false, "nor a query");
    const nested = event.nested as Record<string, unknown>;
    assert.equal(nested.path, undefined);
    assert.equal(nested.query, undefined);
    assert.match(String(nested.tenantId), /^[0-9a-f]{12}$/, "but a nested identity is still hashed, not dropped");
    const deep = ((event.deep as Record<string, unknown>).a as Record<string, unknown>).b as Record<string, unknown>;
    assert.deepEqual(deep.c, {}, "three levels down, the path is still gone");
    const items = event.items as Record<string, unknown>[];
    assert.deepEqual(items[0], {}, "and inside an array too");
    assert.equal(items[1]?.file, "ok.md", "while a bare filename still passes");
  } finally {
    restore();
  }
});

test("LOG-011c: the debug opt-in still works at depth", async () => {
  const restore = withEnv({ REMEMBRA_LOG: "json", REMEMBRA_DEBUG: "1" });
  try {
    const output = await captureStderr(async () => {
      logEvent("debug", "nested.debug", { nested: { path: "/home/someone/x" } });
    });
    const event = JSON.parse(output) as Record<string, unknown>;
    assert.equal(
      ((event.nested as Record<string, unknown>).path as string).includes("/home/someone"),
      true,
      "the documented opt-in still reaches nested content",
    );
  } finally {
    restore();
  }
});

test("LOG-012: secrets are still redacted by the existing mechanism", async () => {
  const restore = withEnv({ REMEMBRA_LOG: "json" });
  try {
    const output = await captureStderr(async () => {
      logEvent("error", "secret.event", {
        authorization: "Bearer top-secret-token",
        apiKey: "sk-live-1234567890",
        nested: { password: "hunter2", safe: "visible" },
      });
    });
    const event = JSON.parse(output) as Record<string, unknown>;
    assert.equal(event.authorization, "[REDACTED]");
    assert.equal(event.apiKey, "[REDACTED]");
    assert.deepEqual(event.nested, { password: "[REDACTED]", safe: "visible" });
  } finally {
    restore();
  }
});

test("LOG-013: an HTTP request's completion line correlates to its request id", async () => {
  const restore = withEnv({ REMEMBRA_LOG: "json" });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-log-ctx-"));
  const svc = new MemoryService(new MemoryStore(root), { embeddingProvider: "none" });
  const server = createHttpServer(svc, { port: 0, host: "127.0.0.1" });
  try {
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const address = server.address() as { port: number };
    const requestId = "req-fixed-0001";
    const logs = await captureStderr(async () => {
      const res = await fetch(`http://127.0.0.1:${address.port}/memories`, {
        headers: { "x-remembra-request-id": requestId },
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("x-remembra-request-id"), requestId, "the id is echoed");
      // Let the finish handler run.
      await new Promise((r) => setTimeout(r, 20));
    });
    const events = logs
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const completion = events.find((event) => event.event === "http.request");
    assert.ok(completion, "a completion line was emitted");
    assert.equal(completion.requestId, requestId, "it carries the request id");
    assert.equal(completion.operation, "http.request");
    assert.equal(completion.route, "memories", "with the bounded route label, not the raw path");
    assert.equal(completion.status, 200);
    assert.equal(typeof completion.durationMs, "number", "and a duration");
  } finally {
    restore();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await svc.shutdownBackgroundJobs();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("LOG-014: a request's own logs never contain the tenant that made it", async () => {
  const restore = withEnv({ REMEMBRA_LOG: "json" });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-log-tenant-"));
  const svc = new MemoryService(new MemoryStore(root), { embeddingProvider: "none" });
  const tenantOrg = "acme-corporation-ltd";
  const server = createHttpServer(svc, {
    port: 0,
    host: "127.0.0.1",
    apiKey: "log-secret",
    resolveTenantContext: (): TenantContext =>
      createTenantContext({
        organizationId: tenantOrg,
        membershipVersion: "membership-1",
        scopes: ["global"],
        capabilities: ["tenant:read", "tenant:write"],
      }),
  });
  try {
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const address = server.address() as { port: number };
    const logs = await captureStderr(async () => {
      const res = await fetch(`http://127.0.0.1:${address.port}/memories`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "log-secret" },
        body: JSON.stringify({ type: "fact", content: "a private fact" }),
      });
      assert.equal(res.status, 201);
      await new Promise((r) => setTimeout(r, 20));
    });
    assert.equal(logs.includes(tenantOrg), false, "the raw organization never appears in a log line");
    assert.equal(logs.includes("a private fact"), false, "nor does stored content");
  } finally {
    restore();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await svc.shutdownBackgroundJobs();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("LOG-015: context is absent outside a request rather than leaking between them", () => {
  assert.equal(currentLogContext(), undefined, "no context at the top level");
  withLogContext({ requestId: "req-scoped" }, () => {
    assert.equal(currentLogContext()?.requestId, "req-scoped");
  });
  assert.equal(currentLogContext(), undefined, "and it does not survive the callback");
});

test("LOG-016: concurrent requests do not see each other's context", async () => {
  const restore = withEnv({ REMEMBRA_LOG: "json" });
  try {
    const output = await captureStderr(async () => {
      await Promise.all(
        ["req-a", "req-b", "req-c"].map((id, index) =>
          withLogContext({ requestId: id, operation: `op-${index}` }, async () => {
            await new Promise((r) => setTimeout(r, 3 - index));
            logEvent("info", "concurrent.event", {});
          }),
        ),
      );
    });
    const events = output
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(events.length, 3);
    const pairs = events.map((e) => `${e.requestId}:${e.operation}`).sort();
    assert.deepEqual(pairs, ["req-a:op-0", "req-b:op-1", "req-c:op-2"], "each request kept its own context");
  } finally {
    restore();
  }
});
