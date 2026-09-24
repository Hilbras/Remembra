import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  defaultMemoryPolicy,
  loadMemoryPolicy,
} from "../policy.js";
import { MemoryService } from "../service.js";
import { MemoryStore } from "../store.js";
import { RemembraError } from "../errors.js";

test("policy defaults are explicit and preserve V4 behavior", () => {
  assert.deepEqual(loadMemoryPolicy({ env: {} }), defaultMemoryPolicy());
});

test("policy files and environment overrides are validated and layered", () => {
  const loaded = loadMemoryPolicy({
    env: {
      REMEMBRA_POLICY_FILE: "/trusted/policy.yml",
      REMEMBRA_ROLES_REQUIRE_TRUST: "false",
      REMEMBRA_RETRIEVAL_DIVERSITY: "0",
    } as NodeJS.ProcessEnv,
    readFile: () => `
memory:
  extraction:
    enabled: false
  sensitiveData:
    action: quarantine
  lifecycle:
    default: pinned
  retrieval:
    reranking: false
    diversity: true
  provenance:
    required: true
`,
  });
  assert.equal(loaded.extraction.enabled, false);
  assert.equal(loaded.sensitiveData.action, "quarantine");
  assert.equal(loaded.lifecycle.default, "pinned");
  assert.equal(loaded.roles.requireTrust, false);
  assert.equal(loaded.retrieval.reranking, false);
  assert.equal(loaded.retrieval.diversity, false);
});

test("invalid policy configuration fails closed", () => {
  assert.throws(
    () => loadMemoryPolicy({ env: { REMEMBRA_EXTRACTION_ENABLED: "maybe" } as NodeJS.ProcessEnv }),
    (error: unknown) => {
      assert.ok(error instanceof RemembraError);
      assert.equal(error.code, "INVALID_INPUT");
      return true;
    },
  );
  assert.throws(
    () => loadMemoryPolicy({
      env: { REMEMBRA_POLICY_FILE: "/missing.yml" } as NodeJS.ProcessEnv,
      readFile: () => {
        throw new Error("not readable");
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof RemembraError);
      assert.equal(error.code, "INVALID_INPUT");
      return true;
    },
  );
});

test("service policy controls extraction and lifecycle defaults", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-policy-"));
  const policy = defaultMemoryPolicy();
  policy.extraction.enabled = false;
  policy.roles.requireTrust = false;
  policy.lifecycle.default = "pinned";
  const service = new MemoryService(new MemoryStore(dir), { policy });

  const stored = await service.store({ type: "fact", content: "Policy default retention" });
  assert.equal(stored.memory.retention, "pinned");
  const role = await service.store({ type: "role", content: "Unverified role", trust: "unverified" });
  const policyResults = await service.search({ limit: 2 });
  assert.equal(policyResults.results[0].id, role.id);
  await assert.rejects(
    () => service.digest({ transcript: "policy disabled" }),
    (error: unknown) => {
      assert.ok(error instanceof RemembraError);
      assert.equal(error.code, "INVALID_INPUT");
      return true;
    },
  );
});
