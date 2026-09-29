/**
 * Second process for the V5.6.0 §30 failure matrix.
 *
 * This is a real OS process, not a second object in one event loop. Several rows
 * of the matrix are specifically about defects that only appear under genuine
 * concurrency — audit S1's lost update being the one that motivated the whole
 * milestone — and two objects sharing an event loop cannot reproduce them,
 * because JavaScript's single thread removes the interleaving.
 *
 * Invoked as: `node dist/test/matrix-peer.js <scenario> <root> <label> [args...]`
 * Prints one JSON object on stdout. Exits non-zero on an unexpected failure.
 */
import { MemoryService } from "../service.js";
import { SqliteBackend } from "../sqlite-backend.js";
import { FileBatchIdempotencyStore } from "../batch-idempotency-store.js";
import { RemembraError } from "../errors.js";
import { createTenantContext } from "../tenant.js";

const [, , scenario, root, label, ...rest] = process.argv;

/** A real tenant context, built the way the HTTP layer builds one. */
function tenant(organizationId: string) {
  return createTenantContext({
    organizationId,
    projectId: "p1",
    membershipVersion: "membership-1",
    scopes: ["project/p1"],
    capabilities: ["tenant:read", "tenant:write", "tenant:export"],
  });
}

/**
 * A service over the shared SQLite root.
 *
 * The idempotency store is a real file, so two processes contend for one restore
 * gate rather than each holding an in-process copy of it. It is passed as a
 * service dependency rather than merged into the backend: spreading a class
 * instance copies its data properties and none of its prototype methods, which
 * produces an object that looks like a backend and throws on first use.
 */
function service(root: string): { service: MemoryService; close: () => void } {
  const backend = new SqliteBackend({ dbPath: `${root}/memories.sqlite` });
  const idempotency = new FileBatchIdempotencyStore(`${root}/.idempotency`);
  const svc = new MemoryService(backend, {
    embeddingProvider: "none",
    batchIdempotencyStore: idempotency,
  });
  return { service: svc, close: () => { idempotency.close?.(); backend.close?.(); } };
}

async function main(): Promise<Record<string, unknown>> {
  switch (scenario) {
    /**
     * Both processes read version N, then both write with `expectedVersion: N`.
     * The invariant is that exactly one wins: without the CAS in `update`, both
     * were told they had written, and one change vanished (audit S1, 5/5 repro).
     */
    case "cas-race": {
      const { service: svc, close } = service(root);
      try {
        const service = svc;
        const id = rest[0]!;
        const seen = await service.get(id);
        const observed = (seen as { memory?: { version?: number } }).memory?.version ?? 0;
        // A forced version makes the race deterministic: both processes are told
        // the same expected version, so exactly one may win. Relying on two
        // processes happening to interleave would test the scheduler, not the CAS.
        const version = rest[1] !== undefined ? Number(rest[1]) : observed;
        let outcome: "won" | "conflict" | "other";
        try {
          await service.update(id, { content: `${label} write`, expectedVersion: version, reason: "matrix" });
          outcome = "won";
        } catch (error) {
          outcome =
            isConflict(error) ? "conflict" : "other";
        }
        // Read back so the caller can check the stored value, not just our claim.
        const after = await service.get(id);
        return {
          label,
          outcome,
          version,
          observed,
          content: (after as { memory?: { content?: string } }).memory?.content,
          versionAfter: (after as { memory?: { version?: number } }).memory?.version,
        };
      } finally {
        close();
      }
    }

    /**
     * Two processes attempt the same durable restore gate. The invariant is that
     * only one is the owner: a gate with two owners is a gate nobody can close.
     */
    case "restore-gate": {
      const { service: svc, close } = service(root);
      try {
        const service = svc;
        let outcome: "acquired" | "refused" | "other";
        try {
          await service.beginBatchRestore("restore");
          outcome = "acquired";
        } catch (error) {
          outcome = isRestoreGateHeld(error) ? "refused" : "other";
        }
        return {
          label,
          outcome,
          pending: service.batchIdempotencyRestorePending,
          owner: service.batchIdempotencyRestoreReason,
        };
      } finally {
        close();
      }
    }

    /**
     * Write under one tenant, then read it back under a different one. The
     * invariant is that a shared store never widens a tenant's visibility — the
     * guarantee §30 exists to protect.
     */
    case "tenant-read": {
      const { service: svc, close } = service(root);
      try {
        const service = svc;
        const own = rest[0]!;
        const foreign = rest[1]!;
        // Write its own memory rather than reading a seeded one, so the assertion
        // is about this tenant's own data. A memory written *without* a tenant is
        // invisible to every tenant-scoped principal, which is a different and
        // already-tested property.
        const marker = `secret-for-${own}`;
        const written = await service.store({ type: "fact", content: marker }, { tenant: tenant(own) });
        const readOwn = await service.get(written.id, { tenant: tenant(own) }).then(() => "visible", () => "hidden");
        const readForeign = await service.get(written.id, { tenant: tenant(foreign) }).then(() => "VISIBLE-LEAK", () => "hidden");
        const listed = await service.list({ tenant: tenant(foreign) });
        const leakedInList = JSON.stringify(listed).includes(marker);
        return { label, written: written.id, readOwn, readForeign, leakedInList };
      } finally {
        close();
      }
    }

    /**
     * Two processes attempt the migration gate. Same exclusion as the restore
     * gate, and the reason is recorded so recovery verification can refuse to
     * publish a data rollback over a half-applied tenant migration.
     */
    case "migration-gate": {
      const { service: svc, close } = service(root);
      try {
        const service = svc;
        let outcome: "acquired" | "refused" | "other";
        try {
          await service.beginBatchRestore("migration");
          outcome = "acquired";
        } catch (error) {
          outcome = isRestoreGateHeld(error) ? "refused" : "other";
        }
        return {
          label,
          outcome,
          pending: service.batchIdempotencyRestorePending,
          reason: service.batchIdempotencyRestoreReason,
        };
      } finally {
        close();
      }
    }

    default:
      throw new Error(`unknown matrix scenario "${scenario}"`);
  }
}

function isConflict(error: unknown): boolean {
  return error instanceof RemembraError && (error.code === "CONFLICT" || /conflict/i.test(error.message));
}

function isRestoreGateHeld(error: unknown): boolean {
  return (
    error instanceof RemembraError &&
    (error.code === "SERVICE_UNAVAILABLE" || error.code === "CONFLICT" || /gate/i.test(error.message))
  );
}

main().then(
  (result) => {
    process.stdout.write(JSON.stringify(result));
    process.exit(0);
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
