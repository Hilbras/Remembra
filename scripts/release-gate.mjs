#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import process from "node:process";

const expectedVersionIndex = process.argv.indexOf("--expect-version");
const expectedVersion = expectedVersionIndex >= 0 ? process.argv[expectedVersionIndex + 1] : undefined;
if (expectedVersionIndex >= 0 && !expectedVersion) {
  console.error("--expect-version requires a value");
  process.exit(2);
}

const packageJson = JSON.parse(
  await (await import("node:fs/promises")).readFile(new URL("../package.json", import.meta.url), "utf8"),
);
if (expectedVersion && packageJson.version !== expectedVersion) {
  console.error(`package version ${packageJson.version} does not match expected ${expectedVersion}`);
  process.exit(2);
}

const commands = [
  ["build", "npm", ["run", "build"]],
  ["tests", "npm", ["test"]],
  ["security matrix", "npm", ["run", "security:check"]],
  ["recovery matrix", "npm", ["run", "recovery:check"]],
  ["python sdk", "npm", ["run", "python:test"]],
  ["docs", "npm", ["run", "docs:check"]],
  ["audit", "npm", ["audit", "--audit-level=high"]],
  ["package", "npm", ["pack", "--dry-run"]],
  ["tenant benchmark", "npm", ["run", "bench:tenant"]],
  ["scale benchmark", "npm", ["run", "bench:scale"]],
];

for (const [name, command, args] of commands) {
  console.log(`\n=== release gate: ${name} ===`);
  const result = spawnSync(command, args, { stdio: "inherit", env: process.env });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`\nRelease gates passed for ${packageJson.name}@${packageJson.version}.`);
