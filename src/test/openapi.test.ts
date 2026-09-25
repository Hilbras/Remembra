import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { API_PREFIX } from "../api-contract.js";

const docs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "docs");
const specPath = path.join(docs, "openapi.yaml");

/** Minimal reader for the subset of YAML this spec uses. */
function parseSpec(source: string): { paths: Set<string>; operations: Set<string>; openapi: string } {
  const paths = new Set<string>();
  const operations = new Set<string>();
  let currentPath: string | null = null;
  let openapi = "";
  for (const raw of source.split("\n")) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const topLevelPath = raw.match(/^ {2}(\/[^:]+):$/);
    if (topLevelPath) {
      currentPath = topLevelPath[1];
      paths.add(currentPath);
      continue;
    }
    if (raw.startsWith("openapi:")) {
      openapi = raw.slice("openapi:".length).trim();
      continue;
    }
    const operation = raw.match(/^ {4}(get|post|put|patch|delete):$/);
    if (operation && currentPath) operations.add(`${operation[1].toUpperCase()} ${currentPath}`);
  }
  return { paths, operations, openapi };
}

/** Every `/api/v1` route the HTTP layer actually serves. */
function servedRoutes(): string[] {
  const source = readHttpSource();
  const routes = new Set<string>();
  const staticMatch = /req\.method === "([A-Z]+)" && path === "([^"]+)"/g;
  for (const match of source.matchAll(staticMatch)) routes.add(`${match[1]} ${match[2]}`);
  // Routes matched by pattern, normalized to their documented form.
  const idItem = source.match(/const (?:single|singleWrite|del) = path\.match\(\/\^\\\/memories\\\/\(\[\^\/\]\+\)\$\/\)/);
  if (idItem) {
    routes.add("GET /memories/{id}");
    routes.add("PUT /memories/{id}");
    routes.add("DELETE /memories/{id}");
  }
  if (/sub = path\.match\(\/\^\\\/memories\\\/\(\[\^\/\]\+\)\\\/\(relate\|history\|archive\|revive\)\$\/\)/.test(source)) {
    routes.add("GET /memories/{id}/history");
    routes.add("POST /memories/{id}/relate");
    routes.add("POST /memories/{id}/archive");
    routes.add("POST /memories/{id}/revive");
  }
  if (/entityList = entityService \? path\.match/.test(source)) {
    routes.add("GET /tenant/entities/{kind}");
    routes.add("POST /tenant/entities/{kind}");
  }
  if (/entityItem = entityService \? path\.match/.test(source)) {
    routes.add("GET /tenant/entities/{kind}/{id}");
    routes.add("PUT /tenant/entities/{kind}/{id}");
    routes.add("DELETE /tenant/entities/{kind}/{id}");
  }
  if (/membershipList = entityService/.test(source)) routes.add("GET /tenant/memberships/{organizationId}");
  if (/const membership = entityService/.test(source)) {
    routes.add("GET /tenant/memberships/{organizationId}/{userId}");
    routes.add("POST /tenant/memberships/{organizationId}/{userId}");
  }
  if (/tenantOrganization/.test(source)) routes.add("POST /tenant/organization");
  if (/membershipWrite|membershipGrant/.test(source)) routes.add("PUT /tenant/memberships/{organizationId}/{userId}");
  if (/agentSummary = path\.match/.test(source)) routes.add("GET /agents/{agentId}");
  return [...routes];
}

/** Resolve a source file whether the test runs from `src` or from `dist`. */
function repoFile(...segments: string[]): string {
  let current = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth++) {
    const candidate = path.join(current, ...segments);
    if (existsSync(candidate)) return candidate;
    current = path.dirname(current);
  }
  throw new Error(`could not locate ${segments.join("/")}`);
}

function readHttpSource(): string {
  return readFileSync(repoFile("src", "http.ts"), "utf8");
}

test("OPENAPI-001: the published specification is a valid 3.1 document", async () => {
  const spec = await fs.readFile(specPath, "utf8");
  const parsed = parseSpec(spec);
  assert.match(parsed.openapi, /^3\.1\./);
  assert.ok(parsed.paths.size >= 12, "the spec documents the versioned surface");
  assert.equal(spec.includes(API_PREFIX), true);
  // Every documented path is versioned; no legacy route leaks into the spec.
  for (const documented of parsed.paths) {
    assert.equal(documented.startsWith(API_PREFIX), true, `${documented} must be under ${API_PREFIX}`);
  }
});

test("OPENAPI-002: every served /api/v1 route is documented", async () => {
  const spec = await fs.readFile(specPath, "utf8");
  const parsed = parseSpec(spec);
  const documented = new Set<string>();
  for (const operation of parsed.operations) {
    const [method, route] = operation.split(" ");
    documented.add(`${method} ${route.replace(API_PREFIX, "")}`);
  }
  const missing = servedRoutes().filter((route) => !documented.has(route));
  assert.deepEqual(missing, [], `undocumented served routes: ${missing.join(", ")}`);
});

test("OPENAPI-003: batch limits and idempotency rules match the service contract", async () => {
  const spec = await fs.readFile(specPath, "utf8");
  const { MAX_BATCH_ITEMS, MAX_BATCH_BYTES, MAX_BATCH_SEARCH_RESULTS } = await import("../types.js");
  assert.equal(spec.includes(`maxItems: ${MAX_BATCH_ITEMS}`), true);
  assert.equal(spec.includes(`${MAX_BATCH_BYTES / (1024 * 1024)} MiB`), true);
  assert.equal(spec.includes(`${MAX_BATCH_SEARCH_RESULTS.toLocaleString("en-US")}`) || spec.includes("1,000"), true);
  // A read-only operation must document that it rejects an idempotency key.
  assert.match(spec, /`search` and `export` are\s+read-only and reject an idempotency key/);
  // The public batch contract has no embedding operation.
  assert.equal(spec.includes("enum: [store]\n"), true);
  assert.equal(/operation:\n\s+type: string\n\s+enum: \[embedding\]/.test(spec), false);
});

test("OPENAPI-004: error envelopes and authentication are described", async () => {
  const spec = await fs.readFile(specPath, "utf8");
  assert.match(spec, /name: x-api-key/);
  assert.match(spec, /Rate limiting is charged after authentication/);
  assert.match(spec, /legacy responses may omit it/);
  // The docs checker links the specification from the public API page.
  const publicApi = await fs.readFile(path.join(docs, "public-api.md"), "utf8");
  assert.equal(publicApi.includes("openapi.yaml"), true);
});
