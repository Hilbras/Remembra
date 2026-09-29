/**
 * V5.6.0 process roles (roadmap §28, plan T07).
 *
 * The rules live in `src/process-roles.ts` so they can be tested directly, and
 * the two integration tests spawn the real CLI so the wiring is not taken on
 * trust. The property that matters most is the one a user depends on without
 * knowing it: **the no-subcommand path is unchanged**, because everything in this
 * milestone has to leave a single-process installation working untouched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { assertDuties, dutiesFor, resolveRole, roleForCommand, type ProcessRole } from "../process-roles.js";
import { isRemembraError } from "../errors.js";

const run = promisify(execFile);
const CLI = fileURLToPath(new URL("../../dist/index.js", import.meta.url));

/** Run the real CLI and capture the outcome, never letting it hang the suite. */
async function cli(args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env },
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { code: 0, out: stdout, err: stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof e.code === "number" ? e.code : 1, out: e.stdout ?? "", err: e.stderr ?? "" };
  }
}

// --- The duty model --------------------------------------------------------

test("ROLE-001: the default does everything, which is what this milestone must preserve", () => {
  assert.deepEqual(dutiesFor("all"), { http: true, worker: true, scheduler: true });
  // No subcommand at all resolves to `all`, not to a role that needs configuring.
  assert.equal(resolveRole([]).role, "all");
  assert.equal(resolveRole(["--http"]).role, "all");
  assert.equal(resolveRole(["store", "x"]).role, "all", "a data verb is not a role");
});

test("ROLE-002: each subcommand maps to exactly the duties it names", () => {
  assert.equal(roleForCommand("serve"), "server");
  assert.equal(roleForCommand("worker"), "worker");
  assert.equal(roleForCommand("scheduler"), "scheduler");
  assert.equal(roleForCommand("store"), undefined, "a data verb selects no role");
  assert.equal(roleForCommand(undefined), undefined);

  assert.deepEqual(dutiesFor("server"), { http: true, worker: false, scheduler: false });
  assert.deepEqual(dutiesFor("worker"), { http: false, worker: true, scheduler: false });
  assert.deepEqual(dutiesFor("scheduler"), { http: false, worker: false, scheduler: true });
  for (const role of ["all", "server", "worker", "scheduler"] as ProcessRole[]) {
    const duties = dutiesFor(role);
    assert.equal(
      Number(duties.http) + Number(duties.worker) + Number(duties.scheduler) > 0,
      true,
      `${role} must do something`,
    );
  }
});

test("ROLE-003: a role without an HTTP surface refuses HTTP flags rather than ignoring them", () => {
  // A `worker --port 8080` would otherwise bind a port and serve traffic from a
  // process whose entire premise is that it has no HTTP surface.
  for (const role of ["worker", "scheduler"] as const) {
    assert.throws(
      () => assertDuties(role, [role, "--http"]),
      (error: unknown) => isRemembraError(error) && /no HTTP surface/.test((error as Error).message),
      `${role} --http is refused`,
    );
    assert.throws(
      () => assertDuties(role, [role, "--port", "8080"]),
      (error: unknown) => isRemembraError(error) && /remembra serve/.test((error as Error).message),
      `${role} --port names the alternative, so the fix is obvious`,
    );
    // Neither flag is fine.
    assert.doesNotThrow(() => assertDuties(role, [role]));
  }
  // A server keeps both flags, and `all` is never restricted.
  assert.doesNotThrow(() => assertDuties("server", ["serve", "--port", "8080"]));
  assert.doesNotThrow(() => assertDuties("all", ["--http", "--port", "8080"]));
});

test("ROLE-004: a role process refuses a data verb instead of silently ignoring it", () => {
  for (const role of ["worker", "scheduler"] as const) {
    assert.throws(
      () => assertDuties(role, [role, "export"]),
      (error: unknown) => isRemembraError(error) && /does not serve the "export" command/.test((error as Error).message),
    );
  }
  assert.doesNotThrow(() => assertDuties("all", ["export", "out.json"]));
  assert.doesNotThrow(() => assertDuties("server", ["serve"]));
});

test("ROLE-005: resolveRole keeps the remaining arguments in place", () => {
  // Consuming a subcommand must not shift the arguments of the verbs that follow,
  // which is the whole reason the rest is returned rather than just the role.
  const { role, argv } = resolveRole(["serve", "--port", "9000"]);
  assert.equal(role, "server");
  assert.deepEqual(argv, ["serve", "--port", "9000"]);
  const passthrough = resolveRole(["import", "in.json"]);
  assert.equal(passthrough.role, "all");
  assert.deepEqual(passthrough.argv, ["import", "in.json"], "a data verb is not consumed");
});

// --- The real CLI ----------------------------------------------------------

test("ROLE-006: the CLI refuses a worker asked to serve, before touching anything", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-role-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

  const result = await cli(["worker", "--http"], { REMEMBRA_HOME: root });
  assert.notEqual(result.code, 0, "refused, not started");
  assert.match(result.err + result.out, /no HTTP surface/);
  // Refused before any storage work: nothing was created.
  const entries = await fs.readdir(root);
  assert.equal(entries.filter((entry) => entry.endsWith(".sqlite")).length, 0, "no ledger was opened");
});

test("ROLE-007: the default path still runs a data verb with no extra configuration", async (t) => {
  // The regression this milestone could most easily cause: requiring a role, a
  // port, or a token where none was needed before.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-role-ok-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

  const result = await cli(["maintain"], { REMEMBRA_HOME: root });
  assert.equal(result.code, 0, `the default path must keep working: ${result.err}`);
  // The real one-shot shape: a JSON summary, and no complaint about a missing role,
  // port, or token.
  const parsed = JSON.parse(result.out) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed).sort(), ["archived", "deleted", "embedded"]);
});

test("ROLE-008: --help documents the roles", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-role-help-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const result = await cli(["--help"], { REMEMBRA_HOME: root });
  assert.equal(result.code, 0);
  for (const command of ["serve", "worker", "scheduler"]) {
    assert.match(result.out, new RegExp(`remembra ${command}`), `${command} is documented`);
  }
});
