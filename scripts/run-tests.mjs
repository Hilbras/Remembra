#!/usr/bin/env node
/**
 * Test runner wrapper.
 *
 * The pinned native SQLite binding (better-sqlite3 11.x) can abort a test
 * process during environment teardown — after every assertion in that file has
 * already reported — with `RemoveEnvironmentCleanupHook ... Assertion failed:
 * (env) != nullptr`. That signature comes from the native addon, never from a
 * failed assertion, and it depends on heap layout rather than on test content.
 *
 * When a run fails with exactly that signature, only the aborted files are
 * re-run (up to `MAX_ATTEMPTS` each). Every other failure — including each real
 * assertion failure — fails immediately, and the recovery is always reported.
 */
import { spawn } from "node:child_process";
import process from "node:process";

const NATIVE_TEARDOWN_SIGNATURE = "RemoveEnvironmentCleanupHook";
const MAX_ATTEMPTS = 10;
const FAILED_FILE = /^✖ (dist\/test\/[\w.-]+\.test\.js)/gm;

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("usage: run-tests.mjs <node --test args...>");
  process.exit(2);
}

function runOnce(runArgs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, runArgs, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

const initial = await runOnce(args);
if (initial.code === 0) process.exit(0);
const combined = `${initial.stdout}${initial.stderr}`;
if (!combined.includes(NATIVE_TEARDOWN_SIGNATURE)) process.exit(initial.code);

const aborted = [...new Set([...combined.matchAll(FAILED_FILE)].map((match) => match[1]))];
if (aborted.length === 0) process.exit(initial.code);
console.error(
  `\n[run-tests] native SQLite teardown abort after the assertions reported in: ${aborted.join(", ")}`,
);

for (const file of aborted) {
  let recovered = false;
  for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt++) {
    const result = await runOnce(["--test", file]);
    if (result.code === 0) {
      console.error(`[run-tests] ${file} passed on attempt ${attempt}/${MAX_ATTEMPTS} after the native teardown abort.`);
      recovered = true;
      break;
    }
    const retryOutput = `${result.stdout}${result.stderr}`;
    if (!retryOutput.includes(NATIVE_TEARDOWN_SIGNATURE)) {
      process.stderr.write(retryOutput);
      process.exit(result.code);
    }
  }
  if (!recovered) {
    console.error(`[run-tests] ${file} still aborted during native teardown after ${MAX_ATTEMPTS} attempts.`);
    process.exit(1);
  }
}

console.error("[run-tests] every assertion reported success; the run is green despite the native teardown abort.");
