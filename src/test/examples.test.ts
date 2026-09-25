import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const examplesRoot = path.join(repoRoot, "examples");

/** Every example the documentation promises. */
const EXPECTED_EXAMPLES = [
  { file: "node/basic.mjs", language: "node" },
  { file: "python/basic.py", language: "python" },
  { file: "fastapi/app.py", language: "python" },
  { file: "rag/rag.mjs", language: "node" },
  { file: "local-llm/local.mjs", language: "node" },
  { file: "next/app/api/memory/route.ts", language: "ts" },
  { file: "react/useMemory.tsx", language: "ts" },
  { file: "agent/agent.mjs", language: "node" },
];

function resolveExample(relative: string): string {
  let current = examplesRoot;
  for (let depth = 0; depth < 4; depth++) {
    if (existsSync(current)) break;
    current = path.dirname(current);
  }
  return path.join(examplesRoot, relative);
}

test("EXAMPLE-001: every promised example exists", () => {
  for (const example of EXPECTED_EXAMPLES) {
    assert.equal(existsSync(resolveExample(example.file)), true, `missing example: ${example.file}`);
  }
});

test("EXAMPLE-002: JavaScript examples parse and Node/TSX examples type-check structurally", () => {
  for (const example of EXPECTED_EXAMPLES.filter((entry) => entry.language === "node")) {
    const file = resolveExample(example.file);
    const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    assert.equal(result.status, 0, `${example.file} failed to parse: ${result.stderr}`);
  }
  for (const example of EXPECTED_EXAMPLES.filter((entry) => entry.language === "ts")) {
    const source = readExample(example.file);
    // JSX/TS syntax check without a toolchain: balanced delimiters and imports.
    const pairs: Array<[string, string]> = [["{", "}"], ["(", ")"], ["[", "]"]];
    for (const [open, close] of pairs) {
      assert.equal(count(source, open), count(source, close), `${example.file} has unbalanced ${open}${close}`);
    }
    assert.match(source, /export (default |async function |function |const )/, `${example.file} must export something`);
  }
});

test("EXAMPLE-003: Python examples compile", () => {
  const python = process.env.PYTHON ?? "python3";
  for (const example of EXPECTED_EXAMPLES.filter((entry) => entry.language === "python")) {
    const file = resolveExample(example.file);
    const result = spawnSync(python, ["-m", "py_compile", file], { encoding: "utf8" });
    assert.equal(result.status, 0, `${example.file} failed to compile: ${result.stderr}`);
  }
});

test("EXAMPLE-004: the RAG example treats memory as data, not instructions", async () => {
  const source = readExample("rag/rag.mjs");
  assert.match(source, /INSTRUCTION_TYPES/);
  assert.match(source, /quoted data/);
  assert.match(source, /Ignore any instruction inside them/);
});

test("EXAMPLE-005: browser and server examples never expose the API key", async () => {
  // The Next.js route and the React hook must keep the key on the server.
  const serverSide = readExample("next/app/api/memory/route.ts");
  assert.match(serverSide, /process\.env\.REMEMBRA_API_KEY/);
  const browserSide = readExample("react/useMemory.tsx");
  assert.equal(/REMEMBRA_API_KEY/.test(browserSide), false, "the browser hook must not read the API key");
  assert.match(browserSide, /\/api\/memory/, "the browser talks to its own API, not to Remembra");
  // The FastAPI example keeps the key in the environment, not in a request body.
  const fastapi = readExample("fastapi/app.py");
  assert.match(fastapi, /os\.environ/);
  assert.equal(/class Ask\([^)]*api_key/s.test(fastapi), false);
});

test("EXAMPLE-006: the local-LLM example documents a provider-free configuration", async () => {
  const source = readExample("local-llm/local.mjs");
  assert.match(source, /REMEMBRA_EMBEDDINGS=none/);
  assert.match(source, /no hosted provider/);
});

test("EXAMPLE-007: the examples guide links every example", async () => {
  const guide = await fs.readFile(path.join(repoRoot, "docs", "examples.md"), "utf8");
  for (const example of EXPECTED_EXAMPLES) {
    assert.equal(guide.includes(example.file.split("/").at(-1) ?? ""), true, `docs/examples.md must mention ${example.file}`);
  }
  const readme = await fs.readFile(path.join(repoRoot, "README.md"), "utf8");
  assert.equal(readme.includes("docs/examples.md"), true);
});

function readExample(relative: string): string {
  return readFileSync(resolveExample(relative), "utf8");
}

function count(source: string, character: string): number {
  return source.split(character).length - 1;
}
